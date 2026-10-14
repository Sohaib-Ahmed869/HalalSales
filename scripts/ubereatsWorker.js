// scripts/ubereatsWorker.js
// The Uber Eats scrape worker process. The backend starts it by itself (services/ubereats/supervisor.js);
// it can also be run by hand, e.g. on another machine (then nothing stops two workers running at once:
// prefer the backend's own).
//   node scripts/ubereatsWorker.js      (env: UBEREATS_WORKER_CONCURRENCY, UBEREATS_HEADED=true, UBEREATS_MONGODB_URI / _DB)
require("dotenv").config();
// Same database as the backend (MONGO_URI), unless UBEREATS_MONGODB_URI points at a separate one.
const dns = require("dns");
if (dns.getServers().every((s) => s === "127.0.0.1" || s === "::1")) dns.setServers(["8.8.8.8", "1.1.1.1"]);
const mongoose = require("mongoose");
const connectMain = () =>
  process.env.UBEREATS_MONGODB_URI ? Promise.resolve() : mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/salesHalal");
process.env.UBEREATS_WORKER_ENABLED = "true";
const worker = require("../services/ubereats/worker");

connectMain().then(() => worker.start());

// Started by the backend (services/ubereats/supervisor.js): stop when the backend goes away.
if (process.send) process.on("disconnect", () => process.exit(0));

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("[ubereats worker] Stopping; waiting for the running job(s). Ctrl+C again to force.");
    await worker.stop();
    process.exit(0);
  });
}
