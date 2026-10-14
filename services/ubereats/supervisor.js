// services/ubereats/supervisor.js
// Runs the Uber Eats scrape worker for this backend, automatically (started by server.js).
//
// - The worker runs in a separate Node process (scripts/ubereatsWorker.js, forked): Chrome and the
//   scraping never share memory with the API, and a crash there never takes the website down. The
//   supervisor restarts it after a crash (30 s, doubling up to 10 min while it keeps crashing).
// - Exactly one worker in total: a lease in `ubereats_locks` (renewed every 30 s, expires after 90 s)
//   decides which backend process runs it, so several copies of the backend (PM2 cluster, a second
//   server) never run two Chromes on the same profile. If the holder stops, another takes over.
// - The live server always wins over a developer PC: a backend that is not on Windows takes the lease
//   from one on Windows. So a PC running `node server.js` against the live database scrapes only while
//   no server worker is running (local testing before deployment), with no setting needed.
// - UBEREATS_WORKER_ENABLED=false: this backend never runs the worker (e.g. a developer PC that is
//   connected to the live database). Jobs then wait for the live server's worker.
const os = require("os");
const path = require("path");
const { fork } = require("child_process");
const { ueCollections } = require("../../utils/ubereatsDb");
const { requeueInterrupted } = require("./queue");

const LEASE_ID = "worker";
const LEASE_MS = 90000;
const RENEW_MS = 30000;
const CHILD_MAX_OLD_SPACE_MB = Number(process.env.UBEREATS_WORKER_MAX_MEMORY_MB || 768);

const me = `${os.hostname()}:${process.pid}`;
let child = null;
let leader = false;
let started = false;
let stopping = false;
let restartDelay = 30000;
let restartAt = 0;
let lastErrorLog = 0;
let timer = null;
let unsupportedNode = null;

const log = (...a) => console.log("[ubereats supervisor]", ...a);

/** True when a process with this id is running on this machine. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists, owned by someone else
  }
}

/** Take or renew the lease; false when another live process holds it. */
async function holdLease() {
  const { locks } = await ueCollections();
  const now = new Date();
  const takeable = [{ owner: me }, { until: { $lt: now } }];
  // Held by a process of this machine that no longer exists (backend stopped with Ctrl+C, restarted,
  // crashed): take it at once instead of waiting up to 90 s for it to expire.
  const current = await locks.findOne({ _id: LEASE_ID });
  if (current && current.owner !== me && current.host === os.hostname() && current.pid && !pidAlive(current.pid)) {
    takeable.push({ owner: current.owner });
  }
  if (process.platform !== "win32") takeable.push({ platform: "win32" }); // a server takes over from a PC
  try {
    await locks.findOneAndUpdate(
      { _id: LEASE_ID, $or: takeable },
      {
        $set: {
          owner: me,
          host: os.hostname(),
          pid: process.pid,
          platform: process.platform,
          until: new Date(now.getTime() + LEASE_MS),
          renewedAt: now,
        },
      },
      { upsert: true }
    );
    return true;
  } catch (e) {
    if (e?.code === 11000) return false; // held by another process (upsert hit the existing lease)
    throw e;
  }
}

async function releaseLease() {
  const { locks } = await ueCollections();
  await locks.deleteOne({ _id: LEASE_ID, owner: me }).catch(() => {});
}

function startChild() {
  const script = path.join(__dirname, "..", "..", "scripts", "ubereatsWorker.js");
  child = fork(script, [], {
    env: { ...process.env, UBEREATS_WORKER_CHILD: "1" },
    execArgv: [`--max-old-space-size=${CHILD_MAX_OLD_SPACE_MB}`],
  });
  const pid = child.pid;
  const startedAt = Date.now();
  log(`worker process started (pid ${pid})`);
  child.on("exit", (code, signal) => {
    child = null;
    if (stopping) return;
    // Quick crashes back off; a worker that ran a while restarts after 30 s.
    restartDelay = Date.now() - startedAt < 5 * 60000 ? Math.min(restartDelay * 2, 10 * 60000) : 30000;
    restartAt = Date.now() + restartDelay;
    log(`worker process ${pid} stopped (${signal || `code ${code}`}); restarting in ${Math.round(restartDelay / 1000)} s`);
    failJobsOf(pid).catch(() => {});
  });
}

/** The jobs a stopped worker process was running go back in the queue and continue where they stopped. */
async function failJobsOf(pid) {
  const { workers } = await ueCollections();
  await workers.deleteOne({ _id: `${os.hostname()}:${pid}` }).catch(() => {}); // its "online" record
  const r = await requeueInterrupted({ workerId: `${os.hostname()}:${pid}` }, "The scraper process stopped while this job was running");
  if (r.requeued) log(`${r.requeued} job(s) of the stopped worker will continue`);
  if (r.failed) log(`${r.failed} job(s) of the stopped worker failed (interrupted too often)`);
}

function stopChild() {
  if (!child) return;
  log("stopping the worker process: another backend (the live server) runs the scraper now");
  child.kill();
  child = null;
}

async function tick() {
  try {
    leader = await holdLease();
    if (leader && !child && Date.now() >= restartAt) startChild();
    if (!leader) stopChild();
  } catch (e) {
    if (Date.now() - lastErrorLog > 5 * 60000) {
      lastErrorLog = Date.now();
      console.warn(`[ubereats supervisor] ${e.message} (retrying quietly)`);
    }
  }
  if (!stopping) timer = setTimeout(tick, RENEW_MS);
}

function start() {
  if (started) return;
  started = true;
  if (process.env.UBEREATS_WORKER_ENABLED === "false") {
    log("worker off in this backend (UBEREATS_WORKER_ENABLED=false); jobs are run by the live server's worker");
    return;
  }
  // Playwright (the browser driver) needs Node 20+. On an older Node the worker would crash in a loop:
  // say so once and don't start it (the website itself is not affected; jobs wait in the queue).
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 20) {
    console.warn(`[ubereats supervisor] worker NOT started: it needs Node 20 or newer, this server runs Node ${process.versions.node}. Uber Eats jobs will wait in the queue until Node is upgraded.`);
    unsupportedNode = process.versions.node;
    return;
  }
  tick();
  // The worker process must not outlive the backend (server.js's SIGINT / SIGTERM handlers call
  // process.exit, which runs this). The lease is not released here: it expires within 90 s, then the
  // restarted backend takes it over.
  process.once("exit", () => {
    stopping = true;
    if (child) child.kill();
  });
}

/** For tests / scripts that stop the supervisor without exiting the process. */
async function stop() {
  stopping = true;
  if (timer) clearTimeout(timer);
  if (child) child.kill();
  await releaseLease();
}

const status = () => ({
  enabled: process.env.UBEREATS_WORKER_ENABLED !== "false" && !unsupportedNode,
  ...(unsupportedNode ? { reason: `Node ${unsupportedNode} is too old for the scraper (needs 20+)` } : {}),
  leader,
  workerPid: child?.pid || null,
});

module.exports = { start, stop, status };
