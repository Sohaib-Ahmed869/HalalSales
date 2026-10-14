// services/ubereats/runner.js
// Runs one scrape job end to end. Progress, logs and cancellation go through the job document.
// Ported from ubereats-scraper-2-hfs/src/scraper/runner.ts.
const { ueCollections } = require("../../utils/ubereatsDb");
const { DEFAULT_JOB_OPTIONS } = require("./queue");
const { UberEatsClient, RateLimitError } = require("./client");

/** When Uber Eats keeps refusing ("too many requests"), the job is retried this much later. */
const RATE_LIMIT_RETRY_MS = Number(process.env.UBEREATS_RATE_LIMIT_RETRY_MIN || 45) * 60000;
const { parseStore } = require("./parse");
const { fillMissingGeo } = require("./geocode");
const { ingestFeedOnly, ingestStore, markMissing } = require("./ingest");

class CancelledError extends Error {}
class PausedError extends Error {}

/**
 * @param {ObjectId} jobId
 * @param {{ headless?: boolean, echo?: boolean, profileDir?: string }} opts
 *   profileDir: Chrome profile folder; concurrent runs must not share one.
 */
async function runJob(jobId, { headless = true, echo = true, profileDir } = {}) {
  const { jobs, postalCodes, restaurants } = await ueCollections();
  const job = await jobs.findOne({ _id: jobId });
  if (!job) throw new Error(`Job ${jobId} not found`);
  // Older jobs may predate newer options.
  const opts = { ...DEFAULT_JOB_OPTIONS, ...job.options };
  const progress = { ...job.progress, postalCodesTotal: job.postalCodes.length };
  // Continuing a paused / interrupted / failed job: postal codes already finished are skipped, and in the
  // current one the stores this job already scraped (seen in that code's feed since the job's first
  // start) are not fetched again. Counters carry on from the earlier run(s); failures are retried.
  const resumeSince = job.resumedAt && job.startedAt ? new Date(job.startedAt) : null;
  let discoveredBase = job.resumeState?.discoveredInDoneCodes ?? 0;
  if (resumeSince) progress.storesFailed = 0;

  let pendingLogs = [];
  let lastFlush = 0;
  const flush = async (force = false) => {
    if (!force && Date.now() - lastFlush < 2000) return;
    lastFlush = Date.now();
    const logs = pendingLogs;
    pendingLogs = [];
    const res = await jobs.findOneAndUpdate(
      { _id: jobId },
      {
        $set: { progress, heartbeatAt: new Date(), "resumeState.discoveredInDoneCodes": discoveredBase },
        ...(logs.length ? { $push: { logs: { $each: logs, $slice: -500 } } } : {}),
      },
      { projection: { cancelRequested: 1, pauseRequested: 1 } }
    );
    if (res?.cancelRequested) throw new CancelledError("Cancelled by user");
    if (res?.pauseRequested) throw new PausedError("Paused by user");
  };
  const log = (msg, level = "info") => {
    pendingLogs.push({ at: new Date(), level, msg });
    if (echo) console.log(`[ubereats job ${jobId}] ${level === "info" ? "" : level.toUpperCase() + " "}${msg}`);
  };

  const client = new UberEatsClient({
    headless,
    profileDir,
    log: (m) => log(m, "warn"),
    // Shown on the job page: "Uber Eats asked to slow down, waiting until HH:MM".
    onRateLimit: (until) => {
      if (until) progress.waitingUntil = until;
      else delete progress.waitingUntil;
    },
  });
  // Heartbeat + log lines every 30 s even while a request waits minutes (Uber Eats rate limit), so the
  // job is never taken for dead (the 10-minute stale check would re-queue it while it still runs).
  const beat = setInterval(() => {
    const logs = pendingLogs;
    pendingLogs = [];
    jobs
      .updateOne({ _id: jobId }, { $set: { progress, heartbeatAt: new Date() }, ...(logs.length ? { $push: { logs: { $each: logs, $slice: -500 } } } : {}) })
      .catch(() => {});
  }, 30000);
  try {
    if (resumeSince) log(`Continuing: ${progress.postalCodesDone} of ${job.postalCodes.length} postal codes already done`);
    await client.start();
    for (const code of job.postalCodes.slice(progress.postalCodesDone || 0)) {
      progress.currentPostalCode = code;
      progress.currentCategory = undefined;
      await flush(true);
      await scrapePostalCode(code);
      progress.postalCodesDone++;
    }
    delete progress.currentPostalCode;
    delete progress.currentCategory;
    log(
      `Done: ${progress.storesScraped} scraped, ${progress.created} new, ${progress.updated} updated, ` +
        `${progress.unchanged} unchanged, ${progress.missing} missing, ${progress.storesFailed} failed`
    );
    await flush(true);
    await jobs.updateOne({ _id: jobId }, { $set: { status: "completed", finishedAt: new Date() } });
  } catch (e) {
    const cancelled = e instanceof CancelledError;
    const paused = e instanceof PausedError;
    const limited = e instanceof RateLimitError;
    const retryAt = new Date(Date.now() + RATE_LIMIT_RETRY_MS);
    delete progress.waitingUntil;
    log(
      limited
        ? `Uber Eats is still refusing requests; the job tries again at ${retryAt.toISOString().slice(11, 16)} UTC by itself`
        : paused
          ? "Job paused (Continue picks it up where it stopped)"
          : cancelled
            ? "Job cancelled"
            : `Job failed: ${e?.stack || e}`,
      paused || cancelled || limited ? "warn" : "error"
    );
    // The pause/cancel request itself made flush throw: write the last state without checking again.
    const logs = pendingLogs;
    pendingLogs = [];
    await jobs
      .updateOne(
        { _id: jobId },
        {
          $set: { progress, heartbeatAt: new Date(), "resumeState.discoveredInDoneCodes": discoveredBase },
          ...(logs.length ? { $push: { logs: { $each: logs, $slice: -500 } } } : {}),
        }
      )
      .catch(() => {});
    await jobs.updateOne(
      { _id: jobId },
      limited
        ? // Back in the queue, not before retryAt; this run does not count as one of the 5 interruptions.
          { $set: { status: "queued", notBefore: retryAt }, $inc: { attempts: -1 }, $unset: { workerId: "" } }
        : paused
        ? { $set: { status: "paused", pausedAt: new Date() }, $unset: { pauseRequested: "", workerId: "" } }
        : {
            $set: { status: cancelled ? "cancelled" : "failed", finishedAt: new Date(), ...(cancelled ? {} : { error: String(e?.message || e) }) },
            $unset: { pauseRequested: "" },
          }
    );
  } finally {
    clearInterval(beat);
    await client.close();
  }

  async function scrapePostalCode(code) {
    const pc = await postalCodes.findOne({ code });
    let location = pc?.location;
    if (!location) {
      log(`[${code}] Resolving delivery location`);
      location = await client.resolveLocation(code);
      await postalCodes.updateOne(
        { code },
        { $set: { location }, $setOnInsert: { active: true, scheduleHours: 0, createdAt: new Date() } },
        { upsert: true }
      );
    }
    log(`[${code}] Location: ${location.label} (${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)})`);
    await client.setLocation(location);

    const found = new Map(); // uuid -> { store, categories:Set }
    const add = (s, category) => {
      let d = found.get(s.uuid);
      if (!d) found.set(s.uuid, (d = { store: s, categories: new Set() }));
      if (category) d.categories.add(category);
    };
    const cap = opts.maxStoresPerPostalCode;
    const capped = () => cap > 0 && found.size >= cap;

    // Continuing: reuse the store list this job already read for this postal code (no second pass over
    // every feed, which is slow and makes Uber Eats rate-limit).
    const saved = resumeSince && job.resumeState?.current?.code === code ? job.resumeState.current : null;
    let fullPass = false;
    if (saved) {
      for (const s of saved.stores || []) {
        const { categories = [], ...store } = s;
        if (!categories.length) add(store);
        for (const c of categories) add(store, c);
      }
      fullPass = !!saved.fullPass;
      progress.storesDiscovered = discoveredBase + found.size;
      log(`[${code}] Continuing with the ${found.size} stores already found by this job (feeds not read again)`);
    }

    // Horizontal: every category feed.
    if (!saved && (opts.mode === "horizontal" || opts.mode === "both")) {
      let cats = await client.categories();
      if (opts.maxCategories > 0) cats = cats.slice(0, opts.maxCategories);
      log(`[${code}] ${cats.length} categories: ${cats.map((c) => c.title).join(", ")}`);
      for (const cat of cats) {
        if (capped()) break;
        progress.currentCategory = cat.title;
        const before = found.size;
        let n = 0;
        for await (const s of client.feedAll({ query: cat.term, maxPages: opts.maxCategoryPages || undefined })) {
          add(s, cat.title);
          n++;
          if (capped()) break;
        }
        progress.storesDiscovered = discoveredBase + found.size;
        log(`[${code}] Category "${cat.title}": ${n} stores (${found.size - before} new)`);
        await flush();
      }
      progress.currentCategory = undefined;
    }

    // Vertical: the full delivery feed.
    if (!saved && (opts.mode === "vertical" || opts.mode === "both") && !capped()) {
      progress.currentCategory = "(full feed)";
      const before = found.size;
      let n = 0;
      for await (const s of client.feedAll()) {
        add(s);
        n++;
        if (n % 80 === 0) await flush();
        if (capped()) break;
      }
      fullPass = !capped();
      progress.storesDiscovered = discoveredBase + found.size;
      progress.currentCategory = undefined;
      log(`[${code}] Full feed: ${n} stores (${found.size - before} not in any category)`);
    }
    if (!saved) {
      // Saved so a paused / interrupted job can skip reading the feeds again (cleared when the code is done).
      const stores = [...found.values()].map((x) => ({ ...x.store, categories: [...x.categories] }));
      await jobs.updateOne({ _id: jobId }, { $set: { "resumeState.current": { code, fullPass, stores } } });
    }
    await flush(true);

    // Details.
    const ctx = (t) => ({ jobId, postalCode: code, feedCategories: [...t.categories] });
    let targets = [...found.values()];
    if (opts.fetchDetails && opts.skipFreshHours > 0) {
      const since = new Date(Date.now() - opts.skipFreshHours * 3600000);
      const fresh = new Set(
        (
          await restaurants
            .find({ uuid: { $in: targets.map((t) => t.store.uuid) }, detailsScrapedAt: { $gte: since } }, { projection: { uuid: 1 } })
            .toArray()
        ).map((r) => r.uuid)
      );
      const skipped = targets.filter((t) => fresh.has(t.store.uuid));
      targets = targets.filter((t) => !fresh.has(t.store.uuid));
      for (const t of skipped) await ingestFeedOnly(t.store, ctx(t));
      if (skipped.length) log(`[${code}] Skipping ${skipped.length} stores scraped in the last ${opts.skipFreshHours}h`);
    }

    let extraEarlier = 0;
    if (resumeSince) {
      // Stores this job already handled in this postal code before it was paused / interrupted.
      const doneHere = new Set(
        (
          await restaurants
            .find(
              {
                uuid: { $in: targets.map((t) => t.store.uuid) },
                [`seenIn.${code}`]: { $gte: resumeSince },
                ...(opts.fetchDetails ? { detailsScrapedAt: { $gte: resumeSince } } : {}),
              },
              { projection: { uuid: 1 } }
            )
            .toArray()
        ).map((r) => r.uuid)
      );
      if (doneHere.size) {
        targets = targets.filter((t) => !doneHere.has(t.store.uuid));
        log(`[${code}] Continuing: ${doneHere.size} stores already scraped by this job, ${targets.length} left`);
      }
      // Uber Eats' list changes during the day: stores this job scraped earlier may not be in the list it
      // just read. They stay counted as "discovered", so discovered >= scraped (the bar never passes 100%).
      const doneAll = await restaurants.countDocuments({
        [`seenIn.${code}`]: { $gte: resumeSince },
        ...(opts.fetchDetails ? { detailsScrapedAt: { $gte: resumeSince } } : {}),
      });
      extraEarlier = Math.max(0, doneAll - doneHere.size);
      progress.storesDiscovered = discoveredBase + found.size + extraEarlier;
      if (extraEarlier) log(`[${code}] ${extraEarlier} stores scraped earlier by this job are no longer in Uber Eats' list (kept)`);
    }

    log(`[${code}] Scraping ${targets.length} stores${opts.fetchDetails ? " (details + menus)" : " (feed only)"}`);
    const scrapeOne = async (t) => {
      let result;
      try {
        if (!opts.fetchDetails) result = await ingestFeedOnly(t.store, ctx(t));
        else {
          const raw = await client.store(t.store.uuid);
          const parsed = parseStore(raw);
          if (opts.restaurantsOnly && !parsed.isRestaurant) return;
          await fillMissingGeo(parsed, (m) => log(`[${code}] ${m}`, "warn"));
          result = await ingestStore(parsed, { ...ctx(t), storeRaw: opts.storeRaw ? raw : undefined });
        }
        progress.storesScraped++;
        progress[result]++;
      } catch (e) {
        if (e instanceof RateLimitError) {
          stopAll = true; // the whole job waits and retries later, the store is not "failed"
          throw e;
        }
        progress.storesFailed++;
        log(`[${code}] ${t.store.title} (${t.store.uuid}): ${e.message}`, "error");
      }
    };
    let i = 0;
    let stopAll = false;
    const worker = async () => {
      while (i < targets.length && !stopAll) {
        const t = targets[i++];
        await scrapeOne(t);
        await flush();
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
    await flush(true);

    if (fullPass) {
      const missing = await markMissing(code, new Set(found.keys()), jobId);
      progress.missing += missing;
      if (missing) log(`[${code}] ${missing} previously listed stores no longer appear`);
    }
    await postalCodes.updateOne({ code }, { $set: { lastJobId: jobId, lastScrapedAt: new Date(), lastStoreCount: found.size } });
    discoveredBase += found.size + extraEarlier;
    await jobs.updateOne({ _id: jobId }, { $unset: { "resumeState.current": "" }, $set: { "resumeState.discoveredInDoneCodes": discoveredBase } });
  }
}

module.exports = { runJob, CancelledError, PausedError };
