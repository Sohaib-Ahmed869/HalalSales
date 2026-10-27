// services/ubereats/geo.js
// Store discovery from Uber Eats' public city / neighbourhood pages (mode "city").
//
// The delivery feed (vertical / horizontal modes) only lists stores that deliver to one point right
// now: closed stores, stores out of range of that point and stores past the 2nd page of a category
// never show. Uber Eats' SEO pages list the stores of a place whatever the time:
//   /fr/city/vincennes-idf, /fr/neighborhood/europe-paris-idf  (20 cards a page, ?page=2 … 25)
// Every such page is in the sitemap (sitemap-geo-*.xml.gz). Each card has the store link (its id), the
// name, the cuisine line and the full address with the postcode, so stores outside our departments
// are dropped before any detail request.
const zlib = require("zlib");
const { RateLimitError } = require("./client");

const BASE = "https://www.ubereats.com";
const MAX_PAGES = 25;

/** "jeCkLopHQaqbu10ExT864g" (store link id) -> "8de0a42e-8a47-41aa-9bbb-5d04c53f3ae2". */
function storeIdToUuid(id) {
  const hex = Buffer.from(id, "base64url").toString("hex");
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeHtml(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Store cards of one city / neighbourhood page. */
function parseGeoPage(html) {
  const out = [];
  const parts = String(html).split('data-test="store-link"').slice(1);
  for (const part of parts) {
    const href = part.match(/href="(\/fr\/store\/([^"/?]+)\/([A-Za-z0-9_-]{22}))/);
    if (!href) continue;
    const uuid = storeIdToUuid(href[3]);
    if (!uuid) continue;
    const card = part.slice(0, part.indexOf("</a>") > 0 ? part.indexOf("</a>") : 6000);
    const title = decodeHtml((card.match(/<h3[^>]*>([\s\S]*?)<\/h3>/) || [])[1]);
    const spans = [...card.matchAll(/<span[^>]*>([\s\S]*?)<\/span>/g)].map((m) => decodeHtml(m[1])).filter(Boolean);
    const address = [...spans].reverse().find((s) => /\b\d{5}$/.test(s)) || null;
    const cuisine = spans.find((s) => s !== address && s.includes("•"));
    out.push({
      uuid,
      slug: href[2],
      title: title || href[2],
      url: `${BASE}${href[1]}`,
      imageUrl: (card.match(/<img[^>]+src="([^"]+)"/) || [])[1],
      categories: cuisine ? cuisine.split("•").map((s) => s.trim()).filter(Boolean) : [],
      address,
      postalCode: address ? address.match(/(\d{5})$/)[1] : null,
    });
  }
  return out;
}

/** Fetches a URL inside the scraper's browser page (same cookies / Cloudflare clearance). */
async function fetchIn(client, url, { binary = false } = {}) {
  await client.throttle();
  for (let attempt = 0; ; attempt++) {
    try {
      return await evaluateFetch(client, url, binary);
    } catch (e) {
      // Right after a session reset the page may be blank or still loading: relative fetches fail.
      if (attempt >= 3) throw e;
      await new Promise((res) => setTimeout(res, 5000 * (attempt + 1)));
      await client.page.goto(`${BASE}/fr`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    }
  }
}

function evaluateFetch(client, url, binary) {
  return client.page.evaluate(
    async ([u, bin]) => {
      const r = await fetch(u, { credentials: "include" });
      if (!bin) return { status: r.status, text: await r.text() };
      const b = new Uint8Array(await r.arrayBuffer());
      let s = "";
      for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
      return { status: r.status, b64: btoa(s) };
    },
    [url, binary]
  );
}

async function fetchSitemap(client, file) {
  const r = await fetchIn(client, `/${file}`, { binary: true });
  if (r.status !== 200) throw new Error(`Uber Eats sitemap ${file} -> HTTP ${r.status}`);
  const buf = Buffer.from(r.b64, "base64");
  try {
    return zlib.gunzipSync(buf).toString("utf8");
  } catch {
    return buf.toString("utf8");
  }
}

/**
 * Every French city / neighbourhood page of a region, from the sitemap.
 * region "idf" = Île-de-France (Uber Eats' suffix on those slugs).
 */
async function geoPaths(client, { region = "idf" } = {}) {
  const robots = await fetchIn(client, "/robots.txt");
  const index = (robots.text.match(/Sitemap:\s*\S*\/(sitemap-index-[^\s/]+)/) || [])[1];
  if (!index) throw new Error("No sitemap index in Uber Eats' robots.txt");
  const files = [...(await fetchSitemap(client, index)).matchAll(/<loc>[^<]*\/(sitemap-geo-[0-9a-f]+-\d+\.xml(?:\.gz)?)<\/loc>/g)].map((m) => m[1]);
  const paths = new Set();
  const suffix = new RegExp(`-${region}$`);
  for (const f of files) {
    for (const m of (await fetchSitemap(client, f)).matchAll(/<loc>https:\/\/www\.ubereats\.com\/fr\/((?:city|neighborhood)\/[^<]+)<\/loc>/g)) {
      const p = decodeURIComponent(m[1]);
      if (suffix.test(p)) paths.add(p);
    }
  }
  // Neighbourhoods first: Paris has the most stores and a city page stops at 25 pages.
  return [...paths].sort((a, b) => (a.startsWith("neighborhood") === b.startsWith("neighborhood") ? a.localeCompare(b) : a.startsWith("neighborhood") ? -1 : 1));
}

/** All the cards of one place, page after page, until a page brings nothing new. */
async function* placeStores(client, place, { maxPages = MAX_PAGES } = {}) {
  const seen = new Set();
  for (let p = 1; p <= maxPages; p++) {
    let r;
    // "Too many requests" (429): wait minutes, not seconds (27 Oct: three quick retries failed the job).
    const waits = [60, 120, 240, 480, 900];
    for (let attempt = 0, limited = 0; ; attempt++) {
      r = await fetchIn(client, `/fr/${encodeURI(place)}${p > 1 ? `?page=${p}` : ""}`);
      if (r.status === 200 || r.status === 404) break;
      if (r.status === 429) {
        if (limited >= waits.length) throw new RateLimitError(`${place} page ${p}`);
        client.log(`Uber Eats says too many requests on ${place}: waiting ${waits[limited] / 60} min`);
        await new Promise((res) => setTimeout(res, waits[limited++] * 1000));
        await client.resetSession().catch(() => {});
        continue;
      }
      if (attempt >= 2) break;
      await client.resetSession().catch(() => {});
    }
    if (r.status !== 200) {
      if (r.status === 404) return;
      throw new Error(`Uber Eats ${place} page ${p} -> HTTP ${r.status}`);
    }
    const fresh = parseGeoPage(r.text).filter((s) => !seen.has(s.uuid));
    if (!fresh.length) return;
    for (const s of fresh) {
      seen.add(s.uuid);
      yield s;
    }
  }
}

const fold = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * Every French store in Uber Eats' store sitemaps (sitemap-store-*.xml.gz, ~240,000 incl. closed
 * ones): [{ uuid, slug, url }]. The sitemap has no address; `townsOf()` below narrows it.
 */
async function sitemapStores(client, { onFile } = {}) {
  const robots = await fetchIn(client, "/robots.txt");
  const index = (robots.text.match(/Sitemap:\s*\S*\/(sitemap-index-[^\s/]+)/) || [])[1];
  if (!index) throw new Error("No sitemap index in Uber Eats' robots.txt");
  const files = [...(await fetchSitemap(client, index)).matchAll(/<loc>[^<]*\/(sitemap-store-[0-9a-f]+-\d+\.xml(?:\.gz)?)<\/loc>/g)].map((m) => m[1]);
  const out = new Map();
  for (const [i, f] of files.entries()) {
    let xml;
    for (let a = 0; a < 3 && !xml; a++) {
      try {
        xml = await fetchSitemap(client, f);
      } catch (e) {
        if (a === 2) throw e;
        await client.resetSession().catch(() => {});
      }
    }
    for (const m of xml.matchAll(/<loc>(https:\/\/www\.ubereats\.com\/fr(?:-en)?\/store\/([^/<]+)\/([A-Za-z0-9_-]{22}))<\/loc>/g)) {
      const uuid = storeIdToUuid(m[3]);
      if (uuid && !out.has(uuid)) out.set(uuid, { uuid, slug: decodeURIComponent(m[2]), url: m[1] });
    }
    if (onFile) await onFile(i + 1, files.length, out.size);
  }
  return [...out.values()];
}

/** A test for store slugs that name a town of the region ("kebab-du-marche-montreuil"). */
async function townsOf(client, { region = "idf" } = {}) {
  const towns = new Set(region === "idf" ? ["paris"] : []);
  for (const p of await geoPaths(client, { region })) {
    const m = p.match(new RegExp(`^city/(.+)-${region}$`));
    if (m) towns.add(fold(m[1]));
  }
  const list = [...towns].filter((t) => t.length >= 4 && /^[a-z0-9-]+$/.test(t)).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(^|-)(${list.join("|")})(-|$)`);
  return (slug) => re.test(fold(slug));
}

module.exports = { geoPaths, placeStores, parseGeoPage, storeIdToUuid, sitemapStores, townsOf, MAX_PAGES };
