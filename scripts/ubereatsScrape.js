// scripts/ubereatsScrape.js
// Run one Uber Eats scrape from the terminal (no worker needed); it still shows on the Uber Eats Scraper page.
//   node scripts/ubereatsScrape.js 75011 75001 [--mode=vertical|horizontal|both] [--max-stores=N]
//     [--max-categories=N] [--category-pages=N] [--concurrency=N] [--no-details] [--restaurants-only]
//     [--skip-fresh=HOURS] [--raw] [--headed]
require("dotenv").config();
// Same database as the backend (MONGO_URI), unless UBEREATS_MONGODB_URI points at a separate one.
const dns = require("dns");
if (dns.getServers().every((s) => s === "127.0.0.1" || s === "::1")) dns.setServers(["8.8.8.8", "1.1.1.1"]);
const mongoose = require("mongoose");
const connectMain = () =>
  process.env.UBEREATS_MONGODB_URI ? Promise.resolve() : mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/salesHalal");
const path = require("path");
const { ueCollections } = require("../utils/ubereatsDb");
const { enqueueJob, parsePostalCodes } = require("../services/ubereats/queue");
const { runJob } = require("../services/ubereats/runner");
const { PROFILE_ROOT } = require("../services/ubereats/client");

async function main() {
  const args = process.argv.slice(2);
  const flags = new Map(
    args
      .filter((a) => a.startsWith("--"))
      .map((a) => {
        const [k, v] = a.slice(2).split("=");
        return [k, v ?? "true"];
      })
  );
  const { valid, invalid } = parsePostalCodes(args.filter((a) => !a.startsWith("--")));
  if (invalid.length) console.warn(`Ignoring invalid postal codes: ${invalid.join(", ")}`);
  if (!valid.length) {
    console.error("Usage: node scripts/ubereatsScrape.js <postal code> [more codes] [--mode=both] [--max-stores=N] ...");
    process.exit(1);
  }
  const num = (k) => (flags.has(k) ? Number(flags.get(k)) : undefined);
  const options = {
    ...(flags.has("mode") && { mode: flags.get("mode") }),
    ...(num("max-stores") != null && { maxStoresPerPostalCode: num("max-stores") }),
    ...(num("max-categories") != null && { maxCategories: num("max-categories") }),
    ...(num("category-pages") != null && { maxCategoryPages: num("category-pages") }),
    ...(num("concurrency") != null && { concurrency: num("concurrency") }),
    ...(num("skip-fresh") != null && { skipFreshHours: num("skip-fresh") }),
    ...(flags.has("no-details") && { fetchDetails: false }),
    ...(flags.has("restaurants-only") && { restaurantsOnly: true }),
    ...(flags.has("raw") && { storeRaw: true }),
  };

  await connectMain();
  const jobId = await enqueueJob(valid, options, "cli");
  // Claim it at once so a running worker doesn't also pick it up.
  const { jobs } = await ueCollections();
  await jobs.updateOne(
    { _id: jobId, status: "queued" },
    { $set: { status: "running", workerId: "cli", startedAt: new Date(), heartbeatAt: new Date() } }
  );
  console.log(`Job ${jobId}: ${valid.join(", ")}`);
  // Own Chrome profile, so this can run while the worker is busy.
  await runJob(jobId, { headless: !flags.has("headed"), profileDir: path.join(PROFILE_ROOT, "browser-profile-cli") });
  const done = await jobs.findOne({ _id: jobId });
  console.log(`Status: ${done?.status}`, done?.progress);
  process.exit(done?.status === "completed" ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
