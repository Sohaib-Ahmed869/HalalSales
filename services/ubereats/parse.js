// services/ubereats/parse.js
// Uber Eats getStoreV1 / feed card -> restaurant document fields.
// Ported from ubereats-scraper-2-hfs/src/scraper/parse.ts.

const BASE = "https://www.ubereats.com";

const hhmm = (minutes) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const text = (v) => (typeof v === "string" ? v : v?.text) || undefined;

const unique = (xs) => [...new Set(xs)];
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

/** French postal code as 5 digits ("75001.0", " 75001 " -> "75001"); undefined when there is none. */
function normalizePostalCode(v) {
  if (v == null) return undefined;
  return String(v).replace(/\s+/g, "").match(/\d{5}/)?.[0];
}

/** A usable coordinate pair (Uber Eats sometimes sends 0,0 for an unknown spot). */
const hasCoords = (lat, lng) =>
  typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);

/** Uber Eats store URLs use the store UUID as url-safe base64. */
function uuidToStoreId(uuid) {
  return Buffer.from(uuid.replace(/-/g, ""), "hex").toString("base64url");
}

// ---------- legal info (disclaimerBadge) ----------
// French store pages carry the merchant's legally required details in disclaimerBadge.text, e.g.
//   <span>Business name\n10 rue Gomboust\n75001, PARIS\nCe commerçant certifie que ses produits sont
//   conformes aux lois en vigueur.\nowner@example.com\n+33144825138\nChambre de Commerce et d'Industrie
//   (CCI)\n98390368300024</span>
// Lines before the "certifie" line are the legal name and address; after it come the email (often
// missing), the phone, the registry and the registration number (SIRET = 14 digits, SIREN = 9).

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const CERTIFY_RE = /certifie|certify|certifies/i;
const REGISTRY_RE = /chambre|commerce|registre|r\.?c\.?s\b|\bcci\b|\bcma\b|r[ée]pertoire|m[ée]tiers|greffe|siret|siren|chamber|registry|register/i;
const HTML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function legalLines(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
      e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : HTML_ENTITIES[e.toLowerCase()] ?? m
    )
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

const digitsOf = (s) => s.replace(/\D/g, "");
/** A phone: starts with + or is a 10-digit French number starting with 0. */
const looksLikePhone = (s) => /^\+?[\d\s().-]{8,}$/.test(s) && (s.startsWith("+") || /^0\d{9}$/.test(digitsOf(s)));
/** A registration number: 9 (SIREN) or 14 (SIRET) digits, possibly spaced, or another id with 6+ digits. */
const looksLikeRegistration = (s) => !looksLikePhone(s) && !EMAIL_RE.test(s) && /^[A-Z]{0,6}[\s:.\-\d]*\d[\s.\-\dA-Z]*$/i.test(s) && digitsOf(s).length >= 6;

/**
 * disclaimerBadge.text -> { email, phone, name, address, postalCode, registry, registrationNumber, siren, text }.
 * Fields that are not there are left out; {} when the store has no legal block.
 */
function parseLegal(html) {
  if (!html) return {};
  const lines = legalLines(html);
  if (!lines.length) return {};
  const ci = lines.findIndex((l) => CERTIFY_RE.test(l));
  const head = ci > 0 ? lines.slice(0, ci) : [];
  const tail = ci >= 0 ? lines.slice(ci + 1) : lines;
  const out = { text: lines.join("\n") };
  if (head.length) {
    out.name = head[0];
    if (head.length > 1) out.address = head.slice(1).join(", ");
    out.postalCode = normalizePostalCode(out.address);
  }
  for (let i = 0; i < tail.length; i++) {
    const l = tail[i];
    const email = l.match(EMAIL_RE)?.[0];
    if (email) {
      out.email ??= email.toLowerCase();
      continue;
    }
    if (REGISTRY_RE.test(l) && !looksLikeRegistration(l)) {
      // "RCS Paris 123 456 789" carries the number on the same line.
      const inline = l.match(/(\d[\d\s.]{7,}\d)/)?.[1];
      if (inline && digitsOf(inline).length >= 9) {
        out.registry ??= l.replace(inline, "").replace(/[\s:,-]+$/, "").trim();
        out.registrationNumber ??= digitsOf(inline);
      } else out.registry ??= l;
      continue;
    }
    if (looksLikePhone(l)) {
      out.phone ??= l;
      continue;
    }
    if (looksLikeRegistration(l)) {
      const d = digitsOf(l);
      out.registrationNumber ??= d.length === 9 || d.length === 14 ? d : l;
    }
  }
  const reg = out.registrationNumber;
  if (reg && /^\d+$/.test(reg) && (reg.length === 9 || reg.length === 14)) out.siren = reg.slice(0, 9);
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined && v !== ""));
}

// ---------- same-address key (virtual brands) ----------
// One kitchen often runs several Uber Eats brands from one address. They stay separate stores (one per
// uuid); addressKey only lets the page show them together. Spelling differences seen in real data
// ("42b" / "42bis", "av" / "avenue", "rue de roule" / "rue du roule") are smoothed out.

const ADDRESS_WORDS = {
  bd: "boulevard", bld: "boulevard", blvd: "boulevard", boul: "boulevard", av: "avenue", ave: "avenue",
  pl: "place", fg: "faubourg", fbg: "faubourg", st: "saint", ste: "sainte", r: "rue", rte: "route",
  imp: "impasse", sq: "square", qu: "quai", all: "allee", ch: "chemin", crs: "cours", pas: "passage",
  bis: "b", ter: "t", quater: "q",
};
const ADDRESS_DROP = new Set(["de", "du", "des", "la", "le", "les", "l", "d", "et", "rdc", "france"]);

/** "<postal code>|<normalised street>" for a store location; undefined without both. */
function addressKey(loc) {
  const pc = normalizePostalCode(loc?.postalCode);
  if (!pc) return undefined;
  let street = String(loc.streetAddress || String(loc.address || "").split(",")[0] || "");
  // streetAddress often ends with "75001 Paris": keep only the street.
  const at = street.indexOf(pc);
  if (at > 0) street = street.slice(0, at);
  const words = street
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/(\d)(bis|ter|quater)\b/g, "$1 $2")
    .trim()
    .split(" ")
    .map((w) => ADDRESS_WORDS[w] ?? w)
    .filter((w) => w && !ADDRESS_DROP.has(w));
  const key = words.join(" ").replace(/\b(\d+) ([btq])\b/g, "$1$2");
  return key ? `${pc}|${key}` : undefined;
}

/** Every field of a restaurant that comes from getStoreV1 (no bookkeeping fields). */
function parseStore(d) {
  const loc = d.location || {};
  const merchantType = d.storeMerchantTypeInfo?.uberMerchantType?.type;
  const { sections, partial } = parseMenu(d);
  // Always an object (possibly {}) once details are scraped: tells ingest the legal block was looked at.
  const legal = parseLegal(d.disclaimerBadge?.text);

  return {
    uuid: d.uuid,
    slug: d.slug,
    title: String(d.title ?? "").trim(),
    url: `${BASE}/fr/store/${d.slug}/${uuidToStoreId(d.uuid)}`,
    imageUrls: (d.heroImageUrls || []).map((i) => i.url).filter(Boolean),
    categories: unique(d.cuisineList?.length ? d.cuisineList : (d.categories || []).filter((c) => !/^€+$/.test(c))),
    priceBucket: d.priceBucket || undefined,
    storeType: merchantType ?? loc.locationType,
    isRestaurant: merchantType ? merchantType === "MERCHANT_TYPE_RESTAURANT" : loc.locationType !== "GROCERY_STORE",
    location: {
      address: loc.address,
      streetAddress: loc.streetAddress,
      city: loc.city,
      postalCode: loc.postalCode,
      region: loc.region,
      country: loc.country,
      neighborhood: d.breadcrumbs?.value?.find((b) => b.href?.includes("/neighborhood/"))?.title,
      latitude: loc.latitude,
      longitude: loc.longitude,
      locationType: loc.locationType,
    },
    // Where the store is located (the Restaurants tab files it under this code).
    postalCode: normalizePostalCode(loc.postalCode),
    ...(hasCoords(loc.latitude, loc.longitude)
      ? { geo: { type: "Point", coordinates: [loc.longitude, loc.latitude] }, geoSource: "ubereats" }
      : {}),
    addressKey: addressKey(loc),
    phoneNumber: d.phoneNumber || undefined,
    // From the legal block: the business email (the one to use for prospecting) and its registration.
    email: legal.email,
    registrationNumber: legal.registrationNumber,
    siren: legal.siren,
    legal: Object.fromEntries(Object.entries(legal).filter(([k]) => !["email", "registrationNumber", "siren"].includes(k))),
    rating: d.rating ? { value: d.rating.ratingValue, count: d.rating.reviewCount } : undefined,
    hours: (d.hours || []).map((h) => ({
      dayRange: h.dayRange,
      sections: (h.sectionHours || []).map((s) => ({
        start: hhmm(s.startTime),
        end: hhmm(s.endTime),
        title: s.sectionTitle || undefined,
      })),
    })),
    chain: d.parentChain?.uuid ? { uuid: d.parentChain.uuid, name: d.parentChain.name } : undefined,
    tags: (d.tags || []).map((t) => text(t) ?? String(t)).filter(Boolean),
    supportedDiningModes: (d.supportedDiningModes || []).filter((m) => m.isAvailable).map((m) => m.mode),
    breadcrumbs: (d.breadcrumbs?.value || []).map((b) => ({ title: b.title, href: b.href })),
    menu: sections,
    menuItemCount: sections.reduce((n, s) => n + s.items.length, 0),
    menuPartial: partial || undefined,
    live: {
      isOpen: d.isOpen,
      isOrderable: d.isOrderable,
      etaText: text(d.etaRange),
      distanceText: text(d.distanceBadge),
      deliveryFeeText: text(d.fareBadge),
      promotion: text(d.promotion?.promotionText) ?? d.promotion?.title,
    },
  };
}

/**
 * catalogSectionsMap: { [menuUuid]: CatalogSection[] }; each section's items are in
 * payload.standardItemsPayload. Featured / carousel sections repeat items from the real menu, so
 * the real (vertical) sections are taken first and duplicates dropped.
 */
function parseMenu(d) {
  const menuTitles = new Map((d.sections || []).map((s) => [s.uuid, s.title]));
  const raw = [];
  for (const [menuUuid, secs] of Object.entries(d.catalogSectionsMap || {})) {
    for (const sec of secs || []) {
      if (!sec?.payload?.standardItemsPayload) continue;
      raw.push({ menuUuid, sec, primary: sec.type !== "HORIZONTAL_GRID" });
    }
  }
  raw.sort((a, b) => Number(b.primary) - Number(a.primary));

  const seen = new Set();
  const sections = [];
  for (const { menuUuid, sec } of raw) {
    const p = sec.payload.standardItemsPayload;
    const items = [];
    for (const it of p.catalogItems || []) {
      if (!it?.uuid || seen.has(it.uuid)) continue;
      seen.add(it.uuid);
      items.push({
        uuid: it.uuid,
        title: String(it.title ?? "").trim(),
        description: it.itemDescription || undefined,
        price: typeof it.price === "number" ? it.price : undefined,
        priceText: it.priceTagline?.text,
        imageUrl: it.imageUrl || undefined,
        isSoldOut: it.isSoldOut,
        isAvailable: it.isAvailable,
        hasCustomizations: it.hasCustomizations,
        tags: collectTagTexts(it.imageOverlayElements),
      });
    }
    if (!items.length) continue;
    sections.push({
      // sectionUUID is the parent menu for regular sections; catalogSectionUUID is the section itself.
      uuid: sec.catalogSectionUUID ?? p.sectionUUID,
      title: text(p.title) ?? "",
      menuUuid,
      menuTitle: menuTitles.get(menuUuid),
      items,
    });
  }
  // Grocery-style stores return only the first catalog page.
  const partial = d.catalogSectionPagingInfo?.offset != null;
  return { sections, partial };
}

function collectTagTexts(elements) {
  const out = [];
  for (const el of elements || []) for (const t of el?.element?.payload?.tagsPayload?.tags || []) if (t.text) out.push(t.text);
  return out.length ? out : undefined;
}

/** The few fields a feed card gives (used when details are skipped or fail). */
function parseFeedStore(s) {
  return {
    uuid: s.uuid,
    title: s.title,
    url: s.actionUrl ? `${BASE}/fr${s.actionUrl.split("?")[0]}` : `${BASE}/fr/store/-/${uuidToStoreId(s.uuid)}`,
    imageUrls: s.imageUrl ? [s.imageUrl] : [],
    rating: s.rating != null ? { value: round(s.rating, 2), count: s.ratingCount } : undefined,
    live: { etaText: s.etaText, isOrderable: s.isOrderable },
  };
}

module.exports = { parseStore, parseFeedStore, parseLegal, addressKey, normalizePostalCode, hasCoords, uuidToStoreId };
