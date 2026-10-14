// services/ubereats/queue.js
// The Uber Eats job queue lives in the `jobs` collection of the scraper database: a job is inserted
// "queued", a worker claims it atomically, runs it, and leaves it completed / failed / cancelled.
// Ported from ubereats-scraper-2-hfs/src/scraper/queue.ts (same document shape).
const { ueCollections } = require("../../utils/ubereatsDb");

/**
 * mode: vertical = the full delivery feed of the postal code; horizontal = every Uber Eats category
 * feed; both = horizontal first, then vertical to catch uncategorised stores.
 */
const DEFAULT_JOB_OPTIONS = {
  mode: "both",
  fetchDetails: true, // full store details + menu (getStoreV1); false = feed cards only
  skipFreshHours: 0, // skip details refetch if scraped within N hours (0 = always)
  maxStoresPerPostalCode: 0, // 0 = no cap
  maxCategories: 0,
  maxCategoryPages: 2, // ~80 stores per page; category feeds never end, later pages drift
  concurrency: 3, // parallel store detail requests in one browser session
  restaurantsOnly: false, // drop grocery / retail / alcohol stores
  storeRaw: false, // keep the raw getStoreV1 payload (large)
};
const MODES = ["vertical", "horizontal", "both"];

/** Normalise and validate French postal codes (5 digits). */
function parsePostalCodes(input) {
  const parts = (Array.isArray(input) ? input : [input])
    .filter((s) => s != null)
    .flatMap((s) => String(s).split(/[\s,;]+/))
    .map((s) => s.trim())
    .filter(Boolean);
  const valid = new Set();
  const invalid = [];
  for (const p of parts) {
    if (/^\d{5}$/.test(p)) valid.add(p);
    else invalid.push(p);
  }
  return { valid: [...valid], invalid };
}

const toInt = (v, def) => {
  const n = Number(v);
  return v !== null && v !== undefined && v !== "" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : def;
};

/** Job options from user input; anything missing or invalid takes the default. */
function jobOptionsFrom(o = {}) {
  const D = DEFAULT_JOB_OPTIONS;
  const bool = (v, def) => (typeof v === "boolean" ? v : def);
  return {
    mode: MODES.includes(o.mode) ? o.mode : D.mode,
    fetchDetails: bool(o.fetchDetails, D.fetchDetails),
    restaurantsOnly: bool(o.restaurantsOnly, D.restaurantsOnly),
    storeRaw: bool(o.storeRaw, D.storeRaw),
    skipFreshHours: toInt(o.skipFreshHours, D.skipFreshHours),
    maxStoresPerPostalCode: toInt(o.maxStoresPerPostalCode, D.maxStoresPerPostalCode),
    maxCategories: toInt(o.maxCategories, D.maxCategories),
    maxCategoryPages: toInt(o.maxCategoryPages, D.maxCategoryPages),
    concurrency: Math.min(8, Math.max(1, toInt(o.concurrency, D.concurrency))),
  };
}

function emptyProgress(total) {
  return {
    postalCodesDone: 0,
    postalCodesTotal: total,
    storesDiscovered: 0,
    storesScraped: 0,
    storesFailed: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    missing: 0,
  };
}

function newJob(postalCodes, options, trigger) {
  return {
    postalCodes,
    options,
    status: "queued",
    trigger,
    progress: emptyProgress(postalCodes.length),
    logs: [],
    createdAt: new Date(),
  };
}

/** Make sure each code is in the postal-code list, then queue a job. trigger: manual | schedule | cli */
async function enqueueJob(postalCodes, options, trigger = "manual") {
  const { jobs, postalCodes: pcs } = await ueCollections();
  const now = new Date();
  await Promise.all(
    postalCodes.map((code) =>
      pcs.updateOne({ code }, { $setOnInsert: { code, active: true, scheduleHours: 0, createdAt: now } }, { upsert: true })
    )
  );
  const { insertedId } = await jobs.insertOne(newJob(postalCodes, { ...DEFAULT_JOB_OPTIONS, ...options }, trigger));
  return insertedId;
}

/** Times a job may be interrupted (worker restarted / crashed) and continued automatically. */
const MAX_ATTEMPTS = 5;

/**
 * Atomically take the oldest queued job. `startedAt` stays the first start (a continued job skips
 * the stores it already scraped since then); `attempts` counts the runs; `resumedAt` = this run.
 */
async function claimJob(workerId) {
  const { jobs } = await ueCollections();
  return jobs.findOneAndUpdate(
    // notBefore: a job waiting out an Uber Eats rate limit is left alone until then.
    { status: "queued", $or: [{ notBefore: { $exists: false } }, { notBefore: null }, { notBefore: { $lte: new Date() } }] },
    [
      {
        $set: {
          status: "running",
          workerId,
          heartbeatAt: "$$NOW",
          startedAt: { $ifNull: ["$startedAt", "$$NOW"] },
          // A job that has run before (paused, interrupted, rate-limited, continued) resumes: skips what it did.
          resumedAt: { $cond: [{ $ifNull: ["$startedAt", false] }, "$$NOW", "$resumedAt"] },
          attempts: { $add: [{ $ifNull: ["$attempts", 0] }, 1] },
          notBefore: "$$REMOVE",
        },
      },
    ],
    { sort: { createdAt: 1 }, returnDocument: "after" }
  );
}

/**
 * Running jobs whose worker went away (backend restarted or redeployed, worker crashed or stopped
 * answering): put them back in the queue so they continue where they stopped. After MAX_ATTEMPTS runs
 * a job is failed instead (something keeps killing it).
 */
async function requeueInterrupted(filter, reason) {
  const { jobs } = await ueCollections();
  const now = new Date();
  const line = (msg, level) => ({ $push: { logs: { $each: [{ at: now, level, msg }], $slice: -500 } } });
  const giveUp = await jobs.updateMany(
    { ...filter, status: "running", attempts: { $gte: MAX_ATTEMPTS } },
    { $set: { status: "failed", error: `${reason} (${MAX_ATTEMPTS} times). Use Continue to try again.`, finishedAt: now }, ...line(`${reason}; giving up after ${MAX_ATTEMPTS} runs`, "error") }
  );
  const again = await jobs.updateMany(
    { ...filter, status: "running", $or: [{ attempts: { $lt: MAX_ATTEMPTS } }, { attempts: { $exists: false } }] },
    { $set: { status: "queued" }, $unset: { workerId: "" }, ...line(`${reason}; continuing automatically`, "warn") }
  );
  return { requeued: again.modifiedCount, failed: giveUp.modifiedCount };
}

/** Jobs whose worker stopped sending heartbeats for 10 minutes are continued by a live worker. */
async function reapStaleJobs(staleMinutes = 10) {
  const r = await requeueInterrupted({ heartbeatAt: { $lt: new Date(Date.now() - staleMinutes * 60000) } }, "The worker stopped responding");
  return r.requeued + r.failed;
}

/** Statuses during which a job still "owns" its postal codes (no second job is scheduled for them). */
const BUSY_STATUSES = ["queued", "running", "paused"];

/** Queue a job for each active postal code whose schedule is due (one job per code). */
async function enqueueScheduled() {
  const { postalCodes, jobs } = await ueCollections();
  const due = await postalCodes.find({ active: true, scheduleHours: { $gt: 0 } }).toArray();
  const busy = new Set(
    (await jobs.find({ status: { $in: BUSY_STATUSES } }, { projection: { postalCodes: 1 } }).toArray()).flatMap((j) => j.postalCodes)
  );
  const enqueued = [];
  for (const pc of due) {
    if (busy.has(pc.code)) continue;
    const next = (pc.lastScrapedAt ? new Date(pc.lastScrapedAt).getTime() : 0) + pc.scheduleHours * 3600000;
    if (next > Date.now()) continue;
    await enqueueJob([pc.code], pc.defaultOptions || {}, "schedule");
    enqueued.push(pc.code);
  }
  return enqueued;
}

module.exports = {
  DEFAULT_JOB_OPTIONS,
  MODES,
  parsePostalCodes,
  jobOptionsFrom,
  toInt,
  emptyProgress,
  newJob,
  enqueueJob,
  claimJob,
  reapStaleJobs,
  requeueInterrupted,
  MAX_ATTEMPTS,
  BUSY_STATUSES,
  enqueueScheduled,
};
