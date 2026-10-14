// services/ubereats/client.js
// Thin client over Uber Eats' internal web API (/_p/api/*), France.
//
// The API rejects bare requests (403), so a real Chrome page is driven with Playwright: loading the
// feed for a delivery location sets the cookies / anti-bot state, then every API call is a `fetch`
// run inside that page. Uses the installed Google Chrome (falls back to Playwright's Chromium) with a
// persistent profile, so the Cloudflare clearance cookie survives between runs.
// Ported from the standalone scraper (ubereats-scraper-2-hfs/src/scraper/ubereats.ts).
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const BASE = "https://www.ubereats.com";
const LOCALE = "fr";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** Default folder for browser profiles (git-ignored). */
const PROFILE_ROOT = process.env.UBEREATS_PROFILE_DIR || path.join(__dirname, "..", "..", ".data", "ubereats");

const FEED_BASE = {
  cacheKey: "",
  feedSessionCount: { announcementCount: 0, announcementLabel: "" },
  userQuery: "",
  date: "",
  startTime: 0,
  endTime: 0,
  carouselId: "",
  sortAndFilters: [],
  billboardUuid: "",
  feedProvider: "",
  promotionUuid: "",
  targetingStoreTag: "",
  venueUUID: "",
  selectedSectionUUID: "",
  favorites: "",
  vertical: "",
  searchSource: "",
  searchType: "",
  keyName: "",
  serializedRequestContext: "",
  isUserInitiatedRefresh: false,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => ms + Math.floor(Math.random() * ms * 0.5);

class ChallengeError extends Error {}

/** Uber Eats kept refusing ("too many requests") through every wait: the job should try again later. */
class RateLimitError extends Error {
  constructor(endpoint) {
    super(`Uber Eats kept answering "too many requests" (${endpoint})`);
    this.endpoint = endpoint;
    this.status = 429;
  }
}

/** Waits after Uber Eats answers "too many requests" (about 35 minutes in total). */
const RATE_LIMIT_WAITS_MS = [60000, 120000, 240000, 480000, 600000, 600000];
const MAX_DELAY_MS = 4000;
/** Fresh browser sessions tried in a row (without a successful request) before waiting instead. */
const FRESH_SESSIONS_IN_A_ROW = 3;
const isRateLimited = (status, text) => status === 429 || /too_many_requests|too many requests|rate.?limit/i.test(String(text || "").slice(0, 2000));

class ApiError extends Error {
  constructor(endpoint, status, detail) {
    super(`UberEats ${endpoint} -> HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.endpoint = endpoint;
    this.status = status;
  }
}

class UberEatsClient {
  /**
   * @param {object} opts
   * @param {boolean} [opts.headless=true]
   * @param {string} [opts.profileDir] persistent profile dir; concurrent clients need distinct ones
   * @param {boolean} [opts.headedFallback=true] when headless is blocked by Cloudflare, retry once with a visible
   *   window (only where there is a screen; a server retries headless instead)
   * @param {number} [opts.minDelayMs=400] minimum delay between API calls
   * @param {(msg: string) => void} [opts.log]
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.minDelayMs = opts.minDelayMs ?? 400;
    this.log = opts.log || (() => {});
    this.gate = Promise.resolve();
    this.context = null;
    this.page = null;
    this.location = null;
    this.resetting = null;
    this.cooldownUntil = 0;
    this.rateLimitWaits = opts.rateLimitWaitsMs || RATE_LIMIT_WAITS_MS; // tests pass short waits
    this.onRateLimit = opts.onRateLimit || (() => {}); // (Date until | null): shown on the job page
    this.sessionGen = 0; // bumped by every fresh session
    this.freshInARow = 0; // fresh sessions started since the last successful request
    this.refreshing = null;
  }

  async start() {
    await this.newContext();
  }

  async close() {
    if (this.context) await this.context.close().catch(() => {});
  }

  async newContext() {
    const headless = this.opts.headless ?? true;
    // A visible window is only possible where there is a screen (a Linux server has none).
    const canShowWindow = this.opts.headedFallback !== false && hasDisplay();
    for (let attempt = 1; ; attempt++) {
      try {
        await this.launch(headless);
        return;
      } catch (e) {
        if (!headless || !(e instanceof ChallengeError)) throw e;
        if (canShowWindow) {
          // Cloudflare rarely clears headless on a fresh profile. A short visible run stores the clearance
          // cookie in the persistent profile, which later headless runs reuse.
          this.log("Cloudflare check did not clear headless; reopening a visible Chrome window to refresh clearance");
          await this.launch(false);
          return;
        }
        if (attempt >= CHALLENGE_RETRIES) throw e;
        const wait = 30000 * attempt;
        this.log(`Cloudflare check did not clear (attempt ${attempt}/${CHALLENGE_RETRIES}); trying again in ${wait / 1000}s`);
        await sleep(wait);
      }
    }
  }

  async launch(headless) {
    if (this.context) await this.context.close().catch(() => {});
    const opts = {
      headless,
      userAgent: UA,
      locale: "fr-FR",
      timezoneId: "Europe/Paris",
      viewport: { width: 1366, height: 900 },
      args: chromeArgs(),
      ...(proxyFromEnv() ? { proxy: proxyFromEnv() } : {}),
    };
    const dir = this.opts.profileDir || path.join(PROFILE_ROOT, "browser-profile");
    this.context = await launchWithFirstWorkingBrowser(dir, opts, this.log);
    // Skip product images only. Blocking other assets trips Cloudflare's bot check.
    await this.context.route(/tb-static\.uber\.com\/prod\/image-proc/, (r) => r.abort());
    this.page = this.context.pages()[0] || (await this.context.newPage());
    await this.page.goto(`${BASE}/${LOCALE}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await this.waitForChallenge();
  }

  /** Cloudflare may serve a "Just a moment..." page that resolves itself. */
  async waitForChallenge(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const title = await this.page.title().catch(() => "");
      if (!/just a moment|un instant/i.test(title)) return;
      await sleep(1000);
    }
    throw new ChallengeError("Cloudflare challenge did not clear");
  }

  /** Space out API calls even when several store fetches run at once. */
  throttle() {
    const turn = this.gate.then(() => sleep(jitter(this.minDelayMs)));
    this.gate = turn;
    return turn;
  }

  /** French postal code -> Uber Eats delivery location. */
  async resolveLocation(postalCode) {
    const search = await this.api("mapsSearchV1", { query: `${postalCode}, France` }, { needsLocation: false });
    const candidates = search.data || [];
    if (!candidates.length) throw new Error(`No UberEats location found for ${postalCode}`);

    let fallback;
    for (const c of candidates.slice(0, 5)) {
      const res = await this.api(
        "getDeliveryLocationV1",
        { placeId: c.id, provider: c.provider, source: "manual_auto_complete" },
        { needsLocation: false }
      );
      const raw = res.data;
      if (!raw || typeof raw.latitude !== "number") continue;
      const comp = raw.addressComponents || {};
      const loc = {
        postalCode,
        label: raw.address?.eaterFormattedAddress || `${c.addressLine1}, ${c.addressLine2}`,
        city: comp.city,
        latitude: raw.latitude,
        longitude: raw.longitude,
        raw,
      };
      if (comp.countryCode && comp.countryCode !== "FR") continue;
      if (comp.postalCode === postalCode) return loc;
      if (!fallback) fallback = loc;
    }
    if (fallback) return fallback;
    throw new Error(`Could not resolve a French delivery location for ${postalCode}`);
  }

  /** Point the browser session at a delivery location by loading its feed. */
  async setLocation(location) {
    this.location = location;
    try {
      await this.loadFeedPage();
    } catch (e) {
      if (!(e instanceof ChallengeError)) throw e;
      await this.resetSession();
    }
  }

  async loadFeedPage() {
    const pl = Buffer.from(JSON.stringify(this.location.raw)).toString("base64");
    const url = `${BASE}/${LOCALE}/feed?diningMode=DELIVERY&pl=${encodeURIComponent(pl)}`;
    const feedLoaded = this.page.waitForResponse((r) => r.url().includes("/_p/api/getFeedV1"), { timeout: 45000 }).catch(() => null);
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await this.waitForChallenge();
    await feedLoaded;
  }

  /** Relaunch the browser and reload the feed after repeated blocks (one reset shared by concurrent callers). */
  async resetSession() {
    if (!this.resetting) {
      this.resetting = (async () => {
        this.log("Resetting browser session");
        await this.newContext();
        if (this.location) await this.loadFeedPage();
      })().finally(() => {
        this.resetting = null;
      });
    }
    return this.resetting;
  }

  /**
   * Uber Eats ties its "too many requests" block to the browser session (cookies), not to the internet
   * connection (seen 2026-10-14: the blocked session kept being refused for 25+ minutes while a brand-new
   * profile was answered at once). So: throw the profile away and start a fresh session. Concurrent
   * requests share one refresh.
   */
  async freshSession() {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        this.freshInARow++;
        this.log(`Uber Eats says too many requests: starting a fresh browser session (${this.freshInARow}/${FRESH_SESSIONS_IN_A_ROW})`);
        if (this.context) await this.context.close().catch(() => {});
        this.context = null;
        const dir = this.opts.profileDir || path.join(PROFILE_ROOT, "browser-profile");
        fs.rmSync(dir, { recursive: true, force: true });
        await this.newContext();
        if (this.location) await this.loadFeedPage();
        this.sessionGen++;
      })().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  async api(endpoint, body, { needsLocation = true, retries = 4 } = {}) {
    if (needsLocation && !this.location) throw new Error("setLocation() must be called first");
    let lastErr;
    let attempt = 0;
    let limited = 0;
    for (;;) {
      await this.throttle();
      // A rate-limit pause applies to every request of this session (concurrent store fetches too).
      if (this.cooldownUntil > Date.now()) await sleep(this.cooldownUntil - Date.now());
      if (this.resetting) await this.resetting.catch(() => {});
      if (this.refreshing) await this.refreshing.catch(() => {});
      const gen = this.sessionGen;
      let rateLimited = false;
      try {
        const res = await this.page.evaluate(
          async ([url, b, lat, lng]) => {
            const headers = { "content-type": "application/json", "x-csrf-token": "x" };
            if (lat != null && lng != null) {
              headers["x-uber-target-location-latitude"] = String(lat);
              headers["x-uber-target-location-longitude"] = String(lng);
            }
            const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(b), credentials: "include" });
            const text = await r.text();
            return { status: r.status, text };
          },
          [`/_p/api/${endpoint}?localeCode=${LOCALE}`, body, this.location?.latitude ?? null, this.location?.longitude ?? null]
        );
        if (isRateLimited(res.status, res.text)) {
          rateLimited = true;
          lastErr = new ApiError(endpoint, 429, "too many requests");
        } else if (res.status === 200) {
          const json = JSON.parse(res.text);
          if (json.status && json.status !== "success") {
            throw new ApiError(endpoint, 200, JSON.stringify(json.data ?? json).slice(0, 200));
          }
          if (limited) this.onRateLimit(null);
          this.freshInARow = 0;
          return json;
        } else {
          lastErr = new ApiError(endpoint, res.status, res.text.slice(0, 120));
          if (res.status === 404 || res.status === 400) throw lastErr;
        }
      } catch (e) {
        lastErr = e;
        if (e instanceof ApiError && (e.status === 400 || e.status === 404 || e.status === 200)) throw e;
      }

      if (rateLimited) {
        // The session that answered is already replaced by a concurrent request: just try again.
        if (gen !== this.sessionGen) continue;
        // First answer: a fresh browser session (the block sits on the session). Same pace afterwards.
        if (this.freshInARow < FRESH_SESSIONS_IN_A_ROW) {
          try {
            await this.freshSession();
            continue;
          } catch (e) {
            this.log(`fresh browser session failed (${firstLine(e.message)}); waiting instead`);
          }
        }
        // Fresh sessions are refused too (a block on the whole connection): wait minutes
        // (1, 2, 4, 8, 10, 10), then go on with more time between requests.
        if (limited >= this.rateLimitWaits.length) {
          this.onRateLimit(null);
          throw new RateLimitError(endpoint);
        }
        const wait = this.rateLimitWaits[limited++];
        if (Date.now() + wait > this.cooldownUntil) {
          this.cooldownUntil = Date.now() + wait;
          this.minDelayMs = Math.min(MAX_DELAY_MS, Math.max(this.minDelayMs * 2, 1500));
          this.log(`Uber Eats says too many requests: waiting ${Math.round(wait / 6000) / 10} min, then ${this.minDelayMs} ms between requests`);
          this.onRateLimit(new Date(this.cooldownUntil));
        }
        await sleep(Math.max(0, this.cooldownUntil - Date.now()));
        continue;
      }

      if (attempt >= retries) break;
      const backoff = Math.min(60000, 2000 * 2 ** attempt);
      this.log(`${endpoint} failed (${lastErr?.message}); retry ${attempt + 1}/${retries} in ${backoff}ms`);
      await sleep(jitter(backoff));
      // A 403 / navigation error usually means the session went stale.
      if (attempt >= 1) await this.resetSession().catch((e) => this.log(`session reset failed: ${e.message}`));
      attempt++;
    }
    throw lastErr;
  }

  /** Top categories Uber Eats shows for the current location (horizontal scraping). */
  async categories() {
    const res = await this.api("getSearchHomeV2", { dropPastOrders: true });
    const all = res.data?.verticalSearchHomeResults || {};
    const items = [...(all.RESTAURANTS || []), ...(all.ALL || [])];
    const seen = new Map();
    for (const it of items) {
      if (it?.type !== "topCategory" || !it.titleTerm) continue;
      if (!seen.has(it.titleTerm)) seen.set(it.titleTerm, { title: it.title, term: it.titleTerm, iconUrl: it.iconUrl });
    }
    return [...seen.values()];
  }

  /** One page of the delivery feed. `query` = category term for horizontal mode. */
  async feedPage({ query, offset } = {}) {
    const body = { ...FEED_BASE };
    if (query) Object.assign(body, { userQuery: query, searchSource: "SEARCH_SUGGESTION", searchType: "CUISINE" });
    if (offset) body.pageInfo = { offset, pageSize: 80 };
    const res = await this.api("getFeedV1", body);
    const data = res.data || {};
    return {
      stores: extractFeedStores(data.feedItems || []),
      hasMore: !!data.meta?.hasMore,
      nextOffset: data.meta?.offset,
    };
  }

  /** Every store in a feed (all pages), de-duplicated. */
  async *feedAll({ query, maxStores = 0, maxPages = 60 } = {}) {
    const seen = new Set();
    let offset;
    let emptyPages = 0;
    for (let p = 0; p < maxPages; p++) {
      const page = await this.feedPage({ query, offset });
      let fresh = 0;
      for (const s of page.stores) {
        if (seen.has(s.uuid)) continue;
        seen.add(s.uuid);
        fresh++;
        yield s;
        if (maxStores && seen.size >= maxStores) return;
      }
      emptyPages = fresh === 0 ? emptyPages + 1 : 0;
      if (!page.hasMore || page.nextOffset == null || page.nextOffset === offset || emptyPages >= 2) return;
      offset = page.nextOffset;
    }
  }

  async store(storeUuid) {
    const res = await this.api("getStoreV1", {
      storeUuid,
      diningMode: "DELIVERY",
      time: { asap: true },
      cbType: "EATER_ENDORSED",
    });
    return res.data;
  }
}

// ---------- browser selection (works on a Windows PC and on the Linux live server) ----------

const CHALLENGE_RETRIES = 3;

const hasDisplay = () => process.platform === "win32" || process.platform === "darwin" || !!process.env.DISPLAY;

/** Chrome flags. On Linux the same set the quotation PDF generator (utils/pdfGenerator.js) uses on the live server. */
function chromeArgs() {
  const args = ["--disable-blink-features=AutomationControlled"];
  if (process.platform === "linux") args.push("--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu");
  return args;
}

/** UBEREATS_PROXY_URL = http://user:pass@host:port, for when Uber Eats blocks the server's address. */
function proxyFromEnv() {
  const raw = process.env.UBEREATS_PROXY_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return {
      server: `${u.protocol}//${u.host}`,
      ...(u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Browsers to try, in order: UBEREATS_CHROME_PATH, installed Google Chrome, Puppeteer's Chrome (already
 * downloaded on the live server for the quotation PDFs), Playwright's own Chromium (downloaded once,
 * automatically, if missing).
 */
function browserCandidates() {
  const list = [];
  if (process.env.UBEREATS_CHROME_PATH) list.push({ name: "UBEREATS_CHROME_PATH", executablePath: process.env.UBEREATS_CHROME_PATH });
  list.push({ name: "Google Chrome", channel: "chrome" });
  try {
    const p = require("puppeteer").executablePath();
    if (p && fs.existsSync(p)) list.push({ name: "Puppeteer's Chrome", executablePath: p });
  } catch {
    // puppeteer not installed or no browser downloaded
  }
  list.push({ name: "Playwright Chromium", channel: "chromium", install: true });
  return list;
}

const firstLine = (msg) => String(msg).split(/\r?\n/)[0];

let workingBrowser = null; // remembered for the life of the process
let installTried = false;

async function launchWithFirstWorkingBrowser(dir, opts, log) {
  const candidates = workingBrowser ? [workingBrowser, ...browserCandidates().filter((c) => c.name !== workingBrowser.name)] : browserCandidates();
  const errors = [];
  for (const c of candidates) {
    const launchOpts = { ...opts, ...(c.channel ? { channel: c.channel } : {}), ...(c.executablePath ? { executablePath: c.executablePath } : {}) };
    try {
      const ctx = await chromium.launchPersistentContext(dir, launchOpts);
      if (workingBrowser?.name !== c.name) log(`Browser: ${c.name}`);
      workingBrowser = c;
      return ctx;
    } catch (e) {
      const first = firstLine(e.message);
      if (c.install && !installTried && /Executable doesn't exist|playwright install/i.test(e.message)) {
        installTried = true;
        log("No browser found; downloading Playwright's Chromium once (about 150 MB)");
        try {
          const cli = path.join(path.dirname(require.resolve("playwright/package.json")), "cli.js");
          execFileSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit", timeout: 10 * 60000 });
          const ctx = await chromium.launchPersistentContext(dir, launchOpts);
          log(`Browser: ${c.name} (just downloaded)`);
          workingBrowser = c;
          return ctx;
        } catch (e2) {
          errors.push(`${c.name}: download/launch failed (${firstLine(e2.message)})`);
          continue;
        }
      }
      errors.push(`${c.name}: ${first}`);
    }
  }
  throw new Error(`No usable browser for the Uber Eats scraper. ${errors.join(" | ")}`);
}

/** Every store card in the feed items, including those nested in carousels. */
function extractFeedStores(feedItems) {
  const out = new Map();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    if (typeof node.storeUuid === "string" && node.title) {
      const payload = node.tracking?.storePayload || {};
      const title = typeof node.title === "string" ? node.title : node.title?.text;
      if (title && !out.has(node.storeUuid)) {
        out.set(node.storeUuid, {
          uuid: node.storeUuid,
          title: String(title).trim(),
          actionUrl: node.actionUrl,
          imageUrl: node.image?.items?.[0]?.url,
          rating: payload.ratingInfo?.storeRatingScore ?? (node.rating?.text ? Number(node.rating.text) : undefined),
          ratingCount: payload.ratingInfo?.ratingCount,
          etaText: node.meta?.find?.((m) => m.badgeType === "ETD")?.text,
          isOrderable: payload.isOrderable,
        });
      }
      return;
    }
    for (const v of Object.values(node)) visit(v);
  };
  visit(feedItems);
  return [...out.values()];
}

module.exports = { UberEatsClient, ChallengeError, ApiError, RateLimitError, extractFeedStores, PROFILE_ROOT };
