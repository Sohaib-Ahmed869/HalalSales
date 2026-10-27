// services/ubereats/ingest.js
// Saves scraped stores and records what changed (created / updated / missing).
// Ported from ubereats-scraper-2-hfs/src/scraper/ingest.ts.
const crypto = require("crypto");
const { ueCollections, ADDRESS_KEY_VERSION } = require("../../utils/ubereatsDb");
const { parseFeedStore } = require("./parse");

/** Fields compared between scrapes. Volatile data (ETA, open/closed, distance) is left out. */
const TRACKED = [
  (r) => ["title", r.title],
  (r) => ["categories", r.categories],
  (r) => ["priceBucket", r.priceBucket],
  (r) => ["storeType", r.storeType],
  (r) => ["location.address", r.location?.address],
  (r) => ["location.postalCode", r.location?.postalCode],
  (r) => ["location.latitude", r.location?.latitude],
  (r) => ["location.longitude", r.location?.longitude],
  (r) => ["phoneNumber", r.phoneNumber],
  (r) => ["email", r.email],
  (r) => ["registrationNumber", r.registrationNumber],
  (r) => ["rating.value", r.rating?.value],
  (r) => ["rating.count", r.rating?.count],
  (r) => ["hours", r.hours],
  (r) => ["chain.name", r.chain?.name],
  (r) => ["tags", r.tags],
  (r) => ["supportedDiningModes", r.supportedDiningModes],
  (r) => ["menuItemCount", r.menuItemCount],
];

// Legal-block fields: a store scraped before they existed (no `legal` yet) gets them silently, so the
// first scrape after the update doesn't record thousands of "email: none -> x" changes.
const LEGAL_FIELDS = ["email", "registrationNumber"];

const menuSignature = (menu = []) => menu.flatMap((s) => s.items.map((i) => [s.title, i.uuid, i.title, i.price, i.description ?? ""]));

function contentHash(r) {
  // undefined -> null so the hash matches the TypeScript scraper's JSON.stringify of the same data.
  const payload = JSON.stringify([TRACKED.map((f) => f(r)), menuSignature(r.menu)]);
  return crypto.createHash("sha1").update(payload).digest("hex");
}

function diffFields(before, after) {
  const out = [];
  for (const f of TRACKED) {
    const [field, a] = f(before);
    const [, b] = f(after);
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) out.push({ field, before: a ?? null, after: b ?? null });
  }
  return out;
}

function diffMenu(before = [], after = []) {
  const index = (menu) => new Map(menu.flatMap((s) => s.items.map((i) => [i.uuid, { ...i, section: s.title }])));
  const a = index(before);
  const b = index(after);
  const diff = { added: [], removed: [], priceChanged: [], renamed: [] };
  for (const [uuid, it] of b) {
    const old = a.get(uuid);
    if (!old) diff.added.push({ uuid, title: it.title, price: it.price, section: it.section });
    else {
      if (old.price !== it.price) diff.priceChanged.push({ uuid, title: it.title, before: old.price, after: it.price });
      if (old.title !== it.title) diff.renamed.push({ uuid, before: old.title, after: it.title });
    }
  }
  for (const [uuid, it] of a) if (!b.has(uuid)) diff.removed.push({ uuid, title: it.title, price: it.price, section: it.section });
  const empty = !diff.added.length && !diff.removed.length && !diff.priceChanged.length && !diff.renamed.length;
  return empty ? undefined : diff;
}

/** Drop undefined values (the TypeScript scraper's driver had ignoreUndefined). */
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * Upsert a fully scraped store and record what changed.
 * ctx: { jobId, postalCode (the searched code; added to deliversIn), feedCategories, storeRaw }
 */
async function ingestStore(parsed, ctx) {
  const { restaurants, changes } = await ueCollections();
  const now = new Date();
  const existing = await restaurants.findOne({ uuid: parsed.uuid });
  const hash = contentHash(parsed);

  let type;
  let fields = [];
  let menu;
  if (!existing) type = "created";
  else if (!existing.detailsScrapedAt) {
    // Previously only known from a feed card: the first full scrape counts as an update.
    type = "updated";
    fields = diffFields(existing, parsed).filter((f) => existing.legal || !LEGAL_FIELDS.includes(f.field));
  } else if (existing.contentHash === hash) type = "unchanged";
  else {
    type = "updated";
    fields = diffFields(existing, parsed).filter((f) => existing.legal || !LEGAL_FIELDS.includes(f.field));
    // Menus are only compared when both sides are complete; partial grocery catalogs churn.
    if (!parsed.menuPartial && !existing.menuPartial) menu = diffMenu(existing.menu, parsed.menu);
    if (!fields.length && !menu) type = "unchanged";
  }

  const { uuid, ...set } = parsed;
  await restaurants.updateOne(
    { uuid },
    {
      $set: clean({
        ...set,
        contentHash: hash,
        addressKeyVersion: ADDRESS_KEY_VERSION,
        detailsScrapedAt: now,
        lastSeenAt: now,
        lastJobId: ctx.jobId,
        [`seenIn.${ctx.postalCode}`]: now,
        ...(ctx.storeRaw !== undefined ? { raw: ctx.storeRaw } : {}),
      }),
      $setOnInsert: { firstSeenAt: now },
      $addToSet: { deliversIn: ctx.postalCode, feedCategories: { $each: ctx.feedCategories || [] } },
      $pull: { missingFrom: ctx.postalCode },
    },
    { upsert: true }
  );

  if (type !== "unchanged") {
    await changes.insertOne(
      clean({
        restaurantUuid: uuid,
        restaurantTitle: parsed.title,
        jobId: ctx.jobId,
        postalCode: ctx.postalCode,
        type,
        fields: type === "created" ? [] : fields,
        menu: type === "created" ? undefined : menu,
        at: now,
      })
    );
  }
  return type;
}

/** Record a store seen in a feed without fetching its details. */
async function ingestFeedOnly(store, ctx) {
  const { restaurants, changes } = await ueCollections();
  const now = new Date();
  const base = parseFeedStore(store);
  const res = await restaurants.updateOne(
    { uuid: store.uuid },
    {
      $set: clean({ live: clean(base.live), lastSeenAt: now, lastJobId: ctx.jobId, [`seenIn.${ctx.postalCode}`]: now }),
      $setOnInsert: clean({
        title: base.title,
        url: base.url,
        imageUrls: base.imageUrls,
        rating: base.rating,
        categories: [],
        isRestaurant: true,
        menu: [],
        menuItemCount: 0,
        firstSeenAt: now,
      }),
      $addToSet: { deliversIn: ctx.postalCode, feedCategories: { $each: ctx.feedCategories || [] } },
      $pull: { missingFrom: ctx.postalCode },
    },
    { upsert: true }
  );
  if (res.upsertedCount) {
    await changes.insertOne(clean({ restaurantUuid: store.uuid, restaurantTitle: store.title, jobId: ctx.jobId, postalCode: ctx.postalCode, type: "created", fields: [], at: now }));
    return "created";
  }
  return "unchanged";
}

/**
 * Record a store found on a city / neighbourhood page (mode "city"), without its details yet. The card
 * has the address and postcode, so the store is placed on the map and in its postcode at once; the
 * detail scrape fills in the rest. `place` is the page it was found on.
 */
async function ingestGeoCard(card, ctx) {
  const { restaurants, changes } = await ueCollections();
  const now = new Date();
  const res = await restaurants.updateOne(
    { uuid: card.uuid },
    {
      $set: clean({ lastSeenAt: now, lastJobId: ctx.jobId, [`seenOnPlace.${String(ctx.place).replace(/[.$]/g, "_")}`]: now }),
      $setOnInsert: clean({
        title: card.title,
        slug: card.slug,
        url: card.url,
        imageUrls: card.imageUrl ? [card.imageUrl] : [],
        categories: card.categories || [],
        postalCode: card.postalCode || undefined,
        location: card.address ? clean({ address: card.address, postalCode: card.postalCode || undefined }) : undefined,
        isRestaurant: true,
        menu: [],
        menuItemCount: 0,
        firstSeenAt: now,
      }),
      $addToSet: { feedCategories: { $each: card.categories || [] } },
    },
    { upsert: true }
  );
  if (res.upsertedCount) {
    await changes.insertOne(clean({ restaurantUuid: card.uuid, restaurantTitle: card.title, jobId: ctx.jobId, postalCode: card.postalCode, type: "created", fields: [], at: now }));
    return "created";
  }
  return "unchanged";
}

/**
 * After a complete vertical pass of a searched postal code, flag stores that used to be listed
 * there and no longer are (closed, delisted, or out of delivery range).
 */
async function markMissing(postalCode, seen, jobId) {
  const { restaurants, changes } = await ueCollections();
  const stale = await restaurants
    .find({ deliversIn: postalCode, uuid: { $nin: [...seen] }, missingFrom: { $ne: postalCode } }, { projection: { uuid: 1, title: 1 } })
    .toArray();
  if (!stale.length) return 0;
  const now = new Date();
  await restaurants.updateMany({ uuid: { $in: stale.map((s) => s.uuid) } }, { $addToSet: { missingFrom: postalCode } });
  await changes.insertMany(
    stale.map((s) => clean({ restaurantUuid: s.uuid, restaurantTitle: s.title, jobId, postalCode, type: "missing", fields: [], at: now }))
  );
  return stale.length;
}

module.exports = { ingestStore, ingestFeedOnly, ingestGeoCard, markMissing, contentHash };
