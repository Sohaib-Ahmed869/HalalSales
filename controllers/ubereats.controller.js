// controllers/ubereats.controller.js
// Uber Eats Scraper page (frontend: src/pages/Dashboard/Admin/UberEatsScraper/).
// Reads and writes the Uber Eats scraper database (utils/ubereatsDb.js):
//   postal_codes  searched postal codes (schedule, resolved delivery location)
//   jobs          the job queue; queued jobs are run by services/ubereats/worker.js (in this backend)
//   restaurants   scraped stores (postalCode = where located, deliversIn = searched codes that listed it)
//   changes       created / updated / missing events per store
//   workers       worker heartbeats (online = beat in the last 60 s)
const mongoose = require("mongoose");
const { ueCollections, UBEREATS_DB_NAME } = require("../utils/ubereatsDb");
const { DEFAULT_JOB_OPTIONS, MODES, BUSY_STATUSES, parsePostalCodes, jobOptionsFrom, toInt, enqueueJob } = require("../services/ubereats/queue");

const { ObjectId } = mongoose.Types;

const JOB_STATUSES = ["queued", "running", "paused", "completed", "failed", "cancelled"];
const CHANGE_TYPES = ["created", "updated", "missing"];
const WORKER_ONLINE_SEC = 60;

const RESTAURANTS_PAGE = 48;
const JOBS_PAGE = 25;
const CHANGES_PAGE = 50;
const RESTAURANT_SORTS = {
  recent: { lastSeenAt: -1 },
  name: { title: 1 },
  rating: { "rating.value": -1 },
  menu: { menuItemCount: -1 },
  new: { firstSeenAt: -1 },
};
// Lists never need the menu, the raw payload or the hours.
const LIST_PROJECTION = { menu: 0, raw: 0, breadcrumbs: 0, hours: 0 };

// ---------- helpers ----------

const secondsAgo = (s) => new Date(Date.now() - s * 1000);
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000);

async function workersOnline(c) {
  return c.workers
    .find({ lastSeenAt: { $gte: secondsAgo(WORKER_ONLINE_SEC) } })
    .project({ _id: 1, host: 1, pid: 1, running: 1, concurrency: 1, lastSeenAt: 1, startedAt: 1 })
    .toArray();
}

const toObjectId = (id) => (ObjectId.isValid(String(id)) ? new ObjectId(String(id)) : null);

/** Wraps a handler: a database that can't be reached gives a 503 with a plain message. */
const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res, await ueCollections());
  } catch (err) {
    const unreachable = /ECONNREFUSED|ENOTFOUND|Server selection timed out|MongooseServerSelectionError|getaddrinfo|not connected/i.test(
      `${err?.name} ${err?.message}`
    );
    console.error(`[ubereats] ${req.method} ${req.originalUrl}:`, err?.message || err);
    res.status(unreachable ? 503 : 500).json({
      message: unreachable
        ? `The Uber Eats scraper data (${UBEREATS_DB_NAME}) can't be reached: the database is not connected.`
        : err?.message || "Uber Eats scraper request failed",
    });
  }
};

// ---------- status / dashboard ----------

exports.getStatus = handle(async (req, res, c) => {
  const [workers, activeJobs, queued] = await Promise.all([
    workersOnline(c),
    c.jobs.countDocuments({ status: { $in: ["queued", "running"] } }),
    c.jobs.countDocuments({ status: "queued" }),
  ]);
  // thisBackend: whether this backend process runs the worker (UBEREATS_WORKER_ENABLED, lease).
  res.json({ connected: true, database: UBEREATS_DB_NAME, workers, activeJobs, queued, thisBackend: require("../services/ubereats/supervisor").status() });
});

exports.getDashboard = handle(async (req, res, c) => {
  const dayAgo = hoursAgo(24);
  const [pcCount, pcActive, restCount, menuAgg, located, activeJobs, running, recentJobs, changes24h, recentChanges, topCats, workers] =
    await Promise.all([
      c.postalCodes.countDocuments(),
      c.postalCodes.countDocuments({ active: true }),
      c.restaurants.countDocuments(),
      c.restaurants.aggregate([{ $group: { _id: null, items: { $sum: "$menuItemCount" } } }]).toArray(),
      c.restaurants.countDocuments({ geo: { $exists: true } }),
      c.jobs.countDocuments({ status: { $in: ["queued", "running"] } }),
      c.jobs.findOne({ status: "running" }, { projection: { logs: 0, resumeState: 0 }, sort: { startedAt: -1 } }),
      c.jobs.find({}, { projection: { logs: 0, resumeState: 0 } }).sort({ createdAt: -1 }).limit(6).toArray(),
      c.changes.aggregate([{ $match: { at: { $gte: dayAgo } } }, { $group: { _id: "$type", n: { $sum: 1 } } }]).toArray(),
      c.changes.find().sort({ at: -1 }).limit(8).toArray(),
      c.restaurants
        .aggregate([{ $unwind: "$categories" }, { $group: { _id: "$categories", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 12 }])
        .toArray(),
      workersOnline(c),
    ]);
  res.json({
    postalCodes: { total: pcCount, active: pcActive },
    restaurants: { total: restCount, menuItems: menuAgg[0]?.items || 0, onMap: located },
    activeJobs,
    running,
    recentJobs,
    changes24h: Object.fromEntries(changes24h.map((x) => [x._id, x.n])),
    recentChanges,
    topCategories: topCats.map((x) => ({ name: x._id, count: x.n })),
    workers,
  });
});

// ---------- postal codes ----------

exports.listPostalCodes = handle(async (req, res, c) => {
  const [list, busy, deliver, located] = await Promise.all([
    c.postalCodes.find().sort({ code: 1 }).toArray(),
    c.jobs.find({ status: { $in: BUSY_STATUSES } }, { projection: { postalCodes: 1, status: 1 } }).toArray(),
    c.restaurants.aggregate([{ $unwind: "$deliversIn" }, { $group: { _id: "$deliversIn", n: { $sum: 1 } } }]).toArray(),
    c.restaurants.aggregate([{ $match: { postalCode: { $exists: true } } }, { $group: { _id: "$postalCode", n: { $sum: 1 } } }]).toArray(),
  ]);
  const busyMap = new Map(busy.flatMap((j) => j.postalCodes.map((code) => [code, { jobId: j._id, status: j.status }])));
  const deliverMap = new Map(deliver.map((x) => [x._id, x.n]));
  const locatedMap = new Map(located.map((x) => [x._id, x.n]));
  res.json(
    list.map((pc) => ({
      ...pc,
      location: pc.location ? { ...pc.location, raw: undefined } : undefined,
      deliverCount: deliverMap.get(pc.code) || 0,
      locatedCount: locatedMap.get(pc.code) || 0,
      busy: busyMap.get(pc.code) || null,
    }))
  );
});

exports.addPostalCodes = handle(async (req, res, c) => {
  const { codes, label, scheduleHours, scrapeNow, options } = req.body || {};
  const { valid, invalid } = parsePostalCodes(codes || "");
  if (!valid.length) {
    return res.status(400).json({ message: invalid.length ? `Invalid: ${invalid.join(", ")}` : "Enter at least one 5-digit postal code" });
  }
  const now = new Date();
  const result = await c.postalCodes.bulkWrite(
    valid.map((code) => ({
      updateOne: {
        filter: { code },
        update: {
          $setOnInsert: { code, active: true, scheduleHours: toInt(scheduleHours, 0), label: String(label || "").trim() || undefined, createdAt: now },
        },
        upsert: true,
      },
    })),
    { ignoreUndefined: true }
  );
  const jobId = scrapeNow ? await enqueueJob(valid, jobOptionsFrom(options)) : null;
  res.json({ added: result.upsertedCount, alreadyPresent: valid.length - result.upsertedCount, invalid, jobId });
});

exports.updatePostalCode = handle(async (req, res, c) => {
  const { code } = req.params;
  const set = {};
  const unset = {};
  if (req.body.scheduleHours !== undefined) set.scheduleHours = toInt(req.body.scheduleHours, 0);
  if (req.body.active !== undefined) set.active = req.body.active === true || req.body.active === "true";
  if (req.body.label !== undefined) {
    const label = String(req.body.label || "").trim();
    if (label) set.label = label;
    else unset.label = "";
  }
  const update = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;
  if (!Object.keys(update).length) return res.status(400).json({ message: "Nothing to update" });
  const r = await c.postalCodes.updateOne({ code }, update);
  if (!r.matchedCount) return res.status(404).json({ message: `Postal code ${code} not found` });
  res.json({ ok: true });
});

exports.resetPostalCodeLocation = handle(async (req, res, c) => {
  await c.postalCodes.updateOne({ code: req.params.code }, { $unset: { location: "" } });
  res.json({ ok: true });
});

exports.deletePostalCode = handle(async (req, res, c) => {
  // Only removes it from the list of codes to scrape; restaurants already scraped stay.
  await c.postalCodes.deleteOne({ code: req.params.code });
  res.json({ ok: true });
});

exports.scrapePostalCode = handle(async (req, res, c) => {
  const { code } = req.params;
  if (!/^\d{5}$/.test(code)) return res.status(400).json({ message: "Invalid postal code" });
  const pc = await c.postalCodes.findOne({ code });
  const options = { ...(pc?.defaultOptions || {}), ...(MODES.includes(req.body?.mode) ? { mode: req.body.mode } : {}) };
  const jobId = await enqueueJob([code], options);
  res.json({ jobId });
});

// ---------- jobs ----------

exports.listJobs = handle(async (req, res, c) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const filter = JOB_STATUSES.includes(req.query.status) ? { status: req.query.status } : {};
  const [list, total, active, codes, workers] = await Promise.all([
    c.jobs.find(filter, { projection: { logs: 0, resumeState: 0 } }).sort({ createdAt: -1 }).skip((page - 1) * JOBS_PAGE).limit(JOBS_PAGE).toArray(),
    c.jobs.countDocuments(filter),
    c.jobs.countDocuments({ status: { $in: ["queued", "running"] } }),
    c.postalCodes.find({}, { projection: { code: 1, label: 1, active: 1 } }).sort({ code: 1 }).toArray(),
    workersOnline(c),
  ]);
  res.json({ jobs: list, total, page, pageSize: JOBS_PAGE, active, postalCodes: codes, workers, defaults: DEFAULT_JOB_OPTIONS });
});

exports.createJob = handle(async (req, res, c) => {
  const { target, codes, options } = req.body || {};
  let list;
  if (target === "active") {
    list = (await c.postalCodes.find({ active: true }, { projection: { code: 1 } }).toArray()).map((p) => p.code);
  } else {
    const parsed = parsePostalCodes(codes || []);
    if (parsed.invalid.length) return res.status(400).json({ message: `Invalid postal codes: ${parsed.invalid.join(", ")}` });
    list = parsed.valid;
  }
  if (!list.length) return res.status(400).json({ message: "No postal codes selected" });
  const jobId = await enqueueJob(list, jobOptionsFrom(options));
  res.json({ jobId });
});

exports.getJob = handle(async (req, res, c) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return res.status(404).json({ message: "Job not found" });
  const [job, byType, recent, workers] = await Promise.all([
    c.jobs.findOne({ _id }, { projection: { "resumeState.current": 0 } }),
    c.changes.aggregate([{ $match: { jobId: _id } }, { $group: { _id: "$type", n: { $sum: 1 } } }]).toArray(),
    c.changes.find({ jobId: _id }).sort({ at: -1 }).limit(30).toArray(),
    workersOnline(c),
  ]);
  if (!job) return res.status(404).json({ message: "Job not found" });
  res.json({ job, counts: Object.fromEntries(byType.map((x) => [x._id, x.n])), recentChanges: recent, workers });
});

exports.cancelJob = handle(async (req, res, c) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return res.status(404).json({ message: "Job not found" });
  // Queued / paused jobs stop at once; a running one is stopped by the worker at its next checkpoint.
  await c.jobs.updateOne({ _id, status: { $in: ["queued", "paused"] } }, { $set: { status: "cancelled", finishedAt: new Date() } });
  await c.jobs.updateOne({ _id, status: "running" }, { $set: { cancelRequested: true } });
  res.json({ ok: true });
});

exports.pauseJob = handle(async (req, res, c) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return res.status(404).json({ message: "Job not found" });
  // A queued job is paused at once; a running one stops at the worker's next checkpoint (a few seconds)
  // and keeps everything scraped so far.
  await c.jobs.updateOne({ _id, status: "queued" }, { $set: { status: "paused", pausedAt: new Date() } });
  await c.jobs.updateOne({ _id, status: "running" }, { $set: { pauseRequested: true } });
  res.json({ ok: true });
});

exports.continueJob = handle(async (req, res, c) => {
  const _id = toObjectId(req.params.id);
  if (!_id) return res.status(404).json({ message: "Job not found" });
  const job = await c.jobs.findOne({ _id }, { projection: { status: 1, startedAt: 1, notBefore: 1 } });
  if (!job) return res.status(404).json({ message: "Job not found" });
  const waiting = job.status === "queued" && job.notBefore && new Date(job.notBefore) > new Date();
  if (!["paused", "failed", "cancelled"].includes(job.status) && !waiting) return res.status(400).json({ message: `A ${job.status} job can't be continued` });
  // Back in the queue; the worker skips the postal codes and stores this job already finished.
  // attempts = 1 marks it as a continuation (a never-started job just starts) and gives it 5 fresh runs.
  await c.jobs.updateOne(
    { _id, status: job.status },
    {
      $set: { status: "queued", ...(job.startedAt ? { attempts: 1 } : {}) },
      $unset: { cancelRequested: "", pauseRequested: "", error: "", finishedAt: "", workerId: "", notBefore: "" },
      $push: { logs: { $each: [{ at: new Date(), level: "info", msg: `Continue requested (was ${job.status})` }], $slice: -500 } },
    }
  );
  res.json({ ok: true });
});

exports.retryJob = handle(async (req, res, c) => {
  const _id = toObjectId(req.params.id);
  const job = _id && (await c.jobs.findOne({ _id }, { projection: { postalCodes: 1, options: 1 } }));
  if (!job) return res.status(404).json({ message: "Job not found" });
  const jobId = await enqueueJob(job.postalCodes, job.options);
  res.json({ jobId });
});

// ---------- restaurants ----------

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Same filters as the scraper's Restaurants page (src/app/restaurants/filter.ts). */
function restaurantFilter(q, { textSearch = true } = {}) {
  const f = {};
  if (q.q) {
    if (textSearch) f.$text = { $search: String(q.q) };
    else f.title = { $regex: escapeRegex(q.q), $options: "i" };
  }
  // postalCode = where the store is located; deliversIn = a searched postal code whose feed listed it.
  if (q.postalCode === "unknown") f.postalCode = { $exists: false };
  else if (q.postalCode) f.postalCode = String(q.postalCode);
  if (q.deliversIn) f.deliversIn = String(q.deliversIn);
  if (q.category) f.categories = String(q.category);
  if (q.feedCategory) f.feedCategories = String(q.feedCategory);
  if (q.type === "restaurants") f.isRestaurant = true;
  if (q.type === "other") f.isRestaurant = false;
  if (q.missing === "1" || q.missing === "true") f.missingFrom = { $exists: true, $ne: [] };
  if (q.onMap === "1" || q.onMap === "true") f.geo = { $exists: true };
  return f;
}

/** Runs a find with the text index; if the index isn't there yet (scraper never started) falls back to a name regex. */
async function findRestaurants(c, query, run) {
  try {
    return await run(restaurantFilter(query));
  } catch (err) {
    if (query.q && /text index/i.test(err?.message || "")) return run(restaurantFilter(query, { textSearch: false }));
    throw err;
  }
}

exports.listRestaurants = handle(async (req, res, c) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || RESTAURANTS_PAGE));
  const sort = RESTAURANT_SORTS[req.query.sort] || RESTAURANT_SORTS.recent;
  const [list, total] = await findRestaurants(c, req.query, (filter) =>
    Promise.all([
      c.restaurants.find(filter, { projection: LIST_PROJECTION }).sort(sort).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      c.restaurants.countDocuments(filter),
    ])
  );
  res.json({ restaurants: list, total, page, pageSize });
});

exports.getRestaurantFilters = handle(async (req, res, c) => {
  const [located, searched, categories, feedCategories] = await Promise.all([
    c.restaurants.aggregate([{ $group: { _id: { $ifNull: ["$postalCode", null] }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray(),
    c.postalCodes.find({}, { projection: { code: 1 } }).sort({ code: 1 }).toArray(),
    c.restaurants.distinct("categories"),
    c.restaurants.distinct("feedCategories"),
  ]);
  res.json({
    locatedIn: located.filter((x) => x._id).map((x) => ({ code: x._id, count: x.n })),
    locationUnknown: located.find((x) => x._id == null)?.n || 0,
    deliversIn: searched.map((x) => x.code),
    categories: categories.filter(Boolean).sort(),
    feedCategories: feedCategories.filter(Boolean).sort(),
  });
});

exports.exportRestaurants = handle(async (req, res, c) => {
  const limit = Math.min(5000, Number(req.query.limit) || 1000);
  const docs = await findRestaurants(c, req.query, (filter) =>
    c.restaurants.find(filter, { projection: { raw: 0, _id: 0 } }).sort({ lastSeenAt: -1 }).limit(limit).toArray()
  );
  res.setHeader("Content-Disposition", `attachment; filename="ubereats-restaurants-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(docs);
});

exports.getRestaurant = handle(async (req, res, c) => {
  const { uuid } = req.params;
  const [restaurant, history] = await Promise.all([
    c.restaurants.findOne({ uuid }, { projection: { raw: 0 } }),
    c.changes.find({ restaurantUuid: uuid }).sort({ at: -1 }).limit(100).toArray(),
  ]);
  if (!restaurant) return res.status(404).json({ message: "Restaurant not found" });
  res.json({ restaurant, history });
});

// ---------- changes ----------

exports.listChanges = handle(async (req, res, c) => {
  const q = req.query;
  const page = Math.max(1, Number(q.page) || 1);
  const filter = {};
  if (CHANGE_TYPES.includes(q.type)) filter.type = q.type;
  if (q.postalCode) filter.postalCode = String(q.postalCode);
  const jobId = q.jobId && toObjectId(q.jobId);
  if (jobId) filter.jobId = jobId;
  if (q.field) filter["fields.field"] = String(q.field);
  if (q.menu === "1" || q.menu === "true") filter.menu = { $exists: true };
  if (Number(q.since) > 0) filter.at = { $gte: hoursAgo(Number(q.since)) };
  const { type, ...withoutType } = filter;
  const [list, total, byType, codes] = await Promise.all([
    c.changes.find(filter).sort({ at: -1 }).skip((page - 1) * CHANGES_PAGE).limit(CHANGES_PAGE).toArray(),
    c.changes.countDocuments(filter),
    // Counts per type ignore the type filter, so the three tiles always show all three.
    c.changes.aggregate([{ $match: { ...withoutType, type: { $exists: true } } }, { $group: { _id: "$type", n: { $sum: 1 } } }]).toArray(),
    c.postalCodes.find({}, { projection: { code: 1 } }).sort({ code: 1 }).toArray(),
  ]);
  res.json({
    changes: list,
    total,
    page,
    pageSize: CHANGES_PAGE,
    counts: Object.fromEntries(byType.map((x) => [x._id, x.n])),
    postalCodes: codes.map((x) => x.code),
  });
});

// For tests.
exports._internal = { parsePostalCodes, jobOptionsFrom, restaurantFilter, DEFAULT_JOB_OPTIONS };
