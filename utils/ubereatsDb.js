// utils/ubereatsDb.js
// Where the Uber Eats scraper keeps its data (scrape jobs, scraped restaurants, change history).
//
// Default (since 2026-10-14, user's request): the backend's own database, i.e. the same MONGO_URI
// connection every other page uses, in collections with an "ubereats_" prefix:
//   ubereats_postal_codes, ubereats_jobs, ubereats_restaurants, ubereats_changes, ubereats_workers,
//   ubereats_locks (which backend process runs the worker)
// The prefix is required: this database already has a `restaurants` collection (the old Postal
// Scraping page's data) and `ubereats_data` / `UberEatsData` (an older, unrelated Uber Eats feature).
//
// Separate database (testing, or the standalone scraper's old data): set UBEREATS_MONGODB_URI (and
// optionally UBEREATS_MONGODB_DB, default "ubereats"); collections then have no prefix, exactly as
// the standalone scraper (HalalFoods/ubereats-scraper-2-hfs) created them.
const mongoose = require("mongoose");
const { addressKey } = require("../services/ubereats/parse");

const SEPARATE_URI = process.env.UBEREATS_MONGODB_URI || "";
const SEPARATE_DB = process.env.UBEREATS_MONGODB_DB || "ubereats";
const PREFIX = SEPARATE_URI ? "" : "ubereats_";
const NAMES = {
  postalCodes: `${PREFIX}postal_codes`,
  jobs: `${PREFIX}jobs`,
  restaurants: `${PREFIX}restaurants`,
  changes: `${PREFIX}changes`,
  workers: `${PREFIX}workers`,
  locks: `${PREFIX}locks`,
};

let dbPromise = null;
let prepared = null;

function openDb() {
  if (SEPARATE_URI) {
    const conn = mongoose.createConnection(SEPARATE_URI, { dbName: SEPARATE_DB, serverSelectionTimeoutMS: 5000 });
    // A failed first connection is retried on the next call.
    return conn.asPromise().then(
      (c) => c.getClient().db(SEPARATE_DB, { ignoreUndefined: true }),
      (err) => {
        conn.close().catch(() => {});
        throw err;
      }
    );
  }
  // The main connection (opened by server.js, or by a script that calls mongoose.connect).
  return mainConnectionReady().then((c) =>
    // ignoreUndefined: an undefined field is left out instead of stored as null (as the original scraper did).
    c.getClient().db(c.db.databaseName, { ignoreUndefined: true })
  );
}

/** Resolves once mongoose's main connection is open (it may not have been started yet). */
function mainConnectionReady(timeoutMs = 30000) {
  const c = mongoose.connection;
  if (c.readyState === 1 && c.db) return Promise.resolve(c);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      c.off("connected", onUp);
      reject(new Error("The main database is not connected"));
    }, timeoutMs);
    function onUp() {
      clearTimeout(t);
      resolve(c);
    }
    c.once("connected", onUp);
  });
}

async function getUberEatsDb() {
  if (!dbPromise) {
    dbPromise = openDb().catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  const db = await dbPromise;
  if (!prepared) {
    prepared = prepare(db).catch((err) => {
      prepared = null;
      throw err;
    });
  }
  await prepared;
  return db;
}

async function ueCollections() {
  const db = await getUberEatsDb();
  return {
    postalCodes: db.collection(NAMES.postalCodes),
    jobs: db.collection(NAMES.jobs),
    restaurants: db.collection(NAMES.restaurants),
    changes: db.collection(NAMES.changes),
    workers: db.collection(NAMES.workers),
    locks: db.collection(NAMES.locks),
  };
}

/** Once per process: bring old restaurant records up to date, then make sure the indexes exist. */
async function prepare(db) {
  const col = (k) => db.collection(NAMES[k]);
  await migrateRestaurants(col("restaurants"));
  await Promise.all([
    col("postalCodes").createIndex({ code: 1 }, { unique: true }),
    col("jobs").createIndex({ status: 1, createdAt: 1 }),
    col("jobs").createIndex({ createdAt: -1 }),
    col("restaurants").createIndex({ uuid: 1 }, { unique: true }),
    col("restaurants").createIndex({ deliversIn: 1 }),
    col("restaurants").createIndex({ postalCode: 1 }),
    col("restaurants").createIndex({ addressKey: 1 }),
    col("restaurants").createIndex({ email: 1 }, { sparse: true }),
    col("restaurants").createIndex({ registrationNumber: 1 }, { sparse: true }),
    col("restaurants").createIndex({ categories: 1 }),
    col("restaurants").createIndex({ feedCategories: 1 }),
    col("restaurants").createIndex({ "location.postalCode": 1 }),
    col("restaurants").createIndex({ lastSeenAt: -1 }),
    col("restaurants").createIndex({ geo: "2dsphere" }),
    col("restaurants").createIndex({ title: "text", categories: "text", "menu.items.title": "text" }),
    col("changes").createIndex({ at: -1 }),
    col("changes").createIndex({ restaurantUuid: 1, at: -1 }),
    col("changes").createIndex({ jobId: 1, type: 1 }),
    col("changes").createIndex({ postalCode: 1, at: -1 }),
  ]);
}

/**
 * Idempotent (only matters for data written by the old standalone scraper):
 * - `postalCodes` (searched codes whose feed listed the store) became `deliversIn`;
 * - `postalCode` (where the store is located) is filled from `location.postalCode`, normalised to 5 digits;
 * - `geoSource` is set for coordinates that came from Uber Eats;
 * - `addressKey` (stores sharing one address, see parse.js) is filled for stores saved before it existed
 *   or with an older version of the key.
 */
async function migrateRestaurants(restaurants) {
  await restaurants.updateMany({ postalCodes: { $exists: true } }, [
    { $set: { deliversIn: { $setUnion: [{ $ifNull: ["$deliversIn", []] }, { $ifNull: ["$postalCodes", []] }] } } },
    { $unset: "postalCodes" },
  ]);
  await restaurants.updateMany({ postalCode: { $exists: false }, "location.postalCode": { $exists: true, $ne: null } }, [
    {
      $set: {
        postalCode: { $getField: { field: "match", input: { $regexFind: { input: { $toString: "$location.postalCode" }, regex: "[0-9]{5}" } } } },
      },
    },
  ]);
  // A failed match yields null: drop it so the store counts as "location unknown".
  await restaurants.updateMany({ postalCode: null }, { $unset: { postalCode: "" } });
  await restaurants.updateMany({ geo: { $exists: true }, geoSource: { $exists: false } }, { $set: { geoSource: "ubereats" } });
  await restaurants.dropIndex("postalCodes_1").catch(() => {});
  await backfillAddressKeys(restaurants);
}

// Bump when addressKey() in parse.js changes, so existing stores get the new key once.
const ADDRESS_KEY_VERSION = 1;

async function backfillAddressKeys(restaurants) {
  const cursor = restaurants.find(
    { "location.postalCode": { $exists: true }, addressKeyVersion: { $ne: ADDRESS_KEY_VERSION } },
    { projection: { location: 1 } }
  );
  let ops = [];
  for await (const r of cursor) {
    const key = addressKey(r.location);
    ops.push({
      updateOne: {
        filter: { _id: r._id },
        update: key ? { $set: { addressKey: key, addressKeyVersion: ADDRESS_KEY_VERSION } } : { $set: { addressKeyVersion: ADDRESS_KEY_VERSION }, $unset: { addressKey: "" } },
      },
    });
    if (ops.length >= 500) {
      await restaurants.bulkWrite(ops, { ordered: false });
      ops = [];
    }
  }
  if (ops.length) await restaurants.bulkWrite(ops, { ordered: false });
}

/** Shown on the page and in errors: "main database (ubereats_*)" or the separate database's name. */
const UBEREATS_DB_NAME = SEPARATE_URI ? SEPARATE_DB : "main database, ubereats_* collections";

module.exports = { ueCollections, UBEREATS_DB_NAME, UBEREATS_COLLECTIONS: NAMES, ADDRESS_KEY_VERSION };
