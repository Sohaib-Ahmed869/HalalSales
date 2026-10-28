// scripts/ubereatsCityScrape.js
// Every Île-de-France store on Uber Eats (open or closed), from its city / neighbourhood pages, then the
// details of those in our departments. Shows on the Uber Eats Scraper page like any other job.
//   node scripts/ubereatsCityScrape.js [--prefixes=75,92,93,94] [--places=city/vincennes-idf,...]
//     [--concurrency=N] [--skip-fresh=HOURS] [--no-details] [--headed]
//   --sitemap: instead, the stores of Uber Eats' store sitemaps we don't have yet (names a town of the
//     region; add --all-france for every French store, ~240,000 — days of requests)
//   --menus [--from-hour=11.75] [--until-hour=14.5]: re-fetch stores whose menu came back empty (Uber Eats
//     only sends a menu while the store is serving); waits for the window, stops at its end
// Run it from a machine Uber Eats does not block (the live server's IP gets a reCAPTCHA, 27 Oct 2026).
require("dotenv").config();
const dns = require("dns");
if (dns.getServers().every((s) => s === "127.0.0.1" || s === "::1")) dns.setServers(["8.8.8.8", "1.1.1.1"]);
const mongoose = require("mongoose");
const path = require("path");
const { ueCollections } = require("../utils/ubereatsDb");
const { DEFAULT_JOB_OPTIONS } = require("../services/ubereats/queue");
const { runJob } = require("../services/ubereats/runner");
const { PROFILE_ROOT } = require("../services/ubereats/client");

async function main() {
  const flags = new Map(
    process.argv
      .slice(2)
      .filter((a) => a.startsWith("--"))
      .map((a) => {
        const [k, v] = a.slice(2).split("=");
        return [k, v ?? "true"];
      })
  );
  const list = (k) => (flags.get(k) || "").split(",").map((s) => s.trim()).filter(Boolean);
  const options = {
    ...DEFAULT_JOB_OPTIONS,
    mode: flags.has("sitemap") ? "sitemap" : flags.has("menus") ? "menus" : flags.has("details") ? "details" : "city",
    ...(flags.has("from-hour") && { fromHour: Number(flags.get("from-hour")) }),
    ...(flags.has("until-hour") && { untilHour: Number(flags.get("until-hour")) }),
    ...(flags.has("all-france") && { allFrance: true }),
    concurrency: Number(flags.get("concurrency")) || DEFAULT_JOB_OPTIONS.concurrency,
    skipFreshHours: flags.has("skip-fresh") ? Number(flags.get("skip-fresh")) : 168,
    fetchDetails: !flags.has("no-details"),
    ...(list("prefixes").length && { postalPrefixes: list("prefixes") }),
    ...(list("places").length && { places: list("places") }),
  };

  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/salesHalal");
  const { jobs } = await ueCollections();
  const now = new Date();
  // Inserted already claimed, so the backend's worker never picks it up.
  const { insertedId: jobId } = await jobs.insertOne({
    postalCodes: [],
    options,
    status: "running",
    trigger: "cli",
    workerId: "cli",
    createdAt: now,
    startedAt: now,
    heartbeatAt: now,
    progress: { postalCodesDone: 0, postalCodesTotal: 0, storesDiscovered: 0, storesScraped: 0, storesFailed: 0, created: 0, updated: 0, unchanged: 0, missing: 0 },
    logs: [],
  });
  console.log(`Job ${jobId}: Uber Eats ${options.mode === "sitemap" ? "store sitemaps" : options.mode === "menus" ? "missing menus" : options.mode === "details" ? "missing details" : `city pages (${options.places ? options.places.join(", ") : "all of Île-de-France"})`}`);
  await runJob(jobId, { headless: !flags.has("headed"), profileDir: path.join(PROFILE_ROOT, `browser-profile-${options.mode}`) });
  const done = await jobs.findOne({ _id: jobId });
  console.log(`Status: ${done?.status}`, done?.progress);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
