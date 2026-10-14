// services/ubereats/worker.js
// Uber Eats scrape worker. Started inside the backend by server.js (or on its own with
// `node scripts/ubereatsWorker.js`): polls the job queue, runs queued jobs in Chrome, queues the
// scheduled scrapes, fails jobs whose worker died, and writes a heartbeat to `workers` so the
// Uber Eats Scraper page can show whether a worker is online.
//
// Env: UBEREATS_WORKER_ENABLED (default on; "false" = this process never scrapes),
//      UBEREATS_WORKER_CONCURRENCY (jobs at once, default 1), UBEREATS_HEADED=true (show Chrome).
const os = require("os");
const path = require("path");
const { ueCollections } = require("../../utils/ubereatsDb");
const { claimJob, enqueueScheduled, reapStaleJobs, requeueInterrupted } = require("./queue");
const { runJob } = require("./runner");
const { PROFILE_ROOT } = require("./client");

const POLL_MS = 3000;
const HEARTBEAT_MS = 15000;
const SCHEDULE_MS = 60000;

const workerId = `${os.hostname()}:${process.pid}`;
const startedAt = new Date();
let concurrency = 1;
let headless = true;
let running = 0;
let stopping = false;
let started = false;
let freeSlots = [];
let lastBeat = 0;
let lastSchedule = 0;
let lastErrorLog = 0;
let timer = null;

const log = (...a) => console.log("[ubereats worker]", ...a);

async function heartbeat(force = false) {
  if (!force && Date.now() - lastBeat < HEARTBEAT_MS) return;
  lastBeat = Date.now();
  const { workers } = await ueCollections();
  await workers.updateOne(
    { _id: workerId },
    { $set: { host: os.hostname(), pid: process.pid, concurrency, running, startedAt, lastSeenAt: new Date(), runsIn: "HalalSales" } },
    { upsert: true }
  );
}

/** True when a process with this id is running on this machine. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists, owned by someone else
  }
}

/**
 * Jobs a process of this machine left "running" and that process is gone (backend restarted or
 * redeployed mid-job, worker crashed): back in the queue at once (they continue where they stopped)
 * instead of waiting 10 minutes for the stale-heartbeat check.
 */
async function failOrphanedJobs() {
  const { jobs } = await ueCollections();
  const host = os.hostname();
  const running = await jobs.find({ status: "running" }, { projection: { workerId: 1 } }).toArray();
  const dead = running.filter((j) => {
    const [jobHost, pidText] = String(j.workerId || "").split(":");
    const pid = Number(pidText);
    return jobHost === host && Number.isInteger(pid) && pid > 0 && pid !== process.pid && !pidAlive(pid);
  });
  if (!dead.length) return;
  const r = await requeueInterrupted({ _id: { $in: dead.map((j) => j._id) } }, "The backend was restarted while this job was running");
  log(`${dead.length} job(s) left running by a stopped process: ${r.requeued} will continue, ${r.failed} failed`);
}

/**
 * "Online" records of worker processes that were stopped without saying goodbye: those of this
 * machine whose process is gone, and any older than a day.
 */
async function removeOldHeartbeats() {
  const { workers } = await ueCollections();
  const host = os.hostname();
  const mine = await workers.find({ host, _id: { $ne: workerId } }, { projection: { pid: 1 } }).toArray();
  const gone = mine.filter((w) => w.pid && !pidAlive(w.pid)).map((w) => w._id);
  await workers.deleteMany({ $or: [{ _id: { $in: gone } }, { lastSeenAt: { $lt: new Date(Date.now() - 24 * 3600000) } }] });
}

function startNextJobs() {
  return (async () => {
    while (!stopping && freeSlots.length) {
      const job = await claimJob(workerId);
      if (!job) break;
      const slot = freeSlots.shift();
      running++;
      heartbeat(true).catch(() => {});
      log(`Starting job ${job._id} for ${job.postalCodes.join(", ")} (${job.options.mode})`);
      // Each concurrent job gets its own Chrome profile (Chrome locks a profile to one process).
      const profileDir = path.join(PROFILE_ROOT, slot === 0 ? "browser-profile" : `browser-profile-${slot}`);
      runJob(job._id, { headless, profileDir })
        .catch((e) => console.error(`[ubereats worker] Job ${job._id} crashed`, e))
        .finally(() => {
          running--;
          freeSlots.push(slot);
          heartbeat(true).catch(() => {});
        });
    }
  })();
}

async function tick() {
  try {
    await heartbeat();
    if (Date.now() - lastSchedule > SCHEDULE_MS) {
      lastSchedule = Date.now();
      await reapStaleJobs();
      const queued = await enqueueScheduled();
      if (queued.length) log(`Scheduled scrape queued for ${queued.join(", ")}`);
    }
    await startNextJobs();
  } catch (e) {
    // Database not reachable etc.: say so at most every 5 minutes, keep trying.
    if (Date.now() - lastErrorLog > 5 * 60000) {
      lastErrorLog = Date.now();
      console.warn(`[ubereats worker] ${e.message} (retrying quietly)`);
    }
  }
  if (!stopping) timer = setTimeout(tick, POLL_MS);
}

/** Start polling. Safe to call twice. */
function start({ concurrency: c, headless: h } = {}) {
  if (started) return;
  if (process.env.UBEREATS_WORKER_ENABLED === "false") {
    log("disabled (UBEREATS_WORKER_ENABLED=false): jobs queued from the Uber Eats Scraper page wait for another worker");
    return;
  }
  started = true;
  concurrency = Math.max(1, Number(c ?? process.env.UBEREATS_WORKER_CONCURRENCY ?? 1) || 1);
  headless = h ?? process.env.UBEREATS_HEADED !== "true";
  freeSlots = Array.from({ length: concurrency }, (_, i) => i);
  log(`${workerId} up, concurrency=${concurrency}${headless ? "" : ", visible Chrome"}`);
  failOrphanedJobs()
    .then(() => removeOldHeartbeats())
    .catch(() => {})
    .finally(() => tick());
}

/** Stop taking jobs; resolves once the running ones finish (or after `timeoutMs`). */
async function stop(timeoutMs = 0) {
  stopping = true;
  if (timer) clearTimeout(timer);
  const until = timeoutMs ? Date.now() + timeoutMs : Infinity;
  while (running > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
  const { workers } = await ueCollections();
  await workers.deleteOne({ _id: workerId }).catch(() => {});
}

const status = () => ({ workerId, started, running, concurrency });

module.exports = { start, stop, status, workerId, failOrphanedJobs };
