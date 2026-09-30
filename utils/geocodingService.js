// utils/geocodingService.js
//
// Turns a Customer's address into lat/lng for the Sales Map Report / Truck
// Schedules routing feature.
//
// Order of providers:
//   1. Google Geocoding API (utils/googleMapsClient.js) when
//      GOOGLE_MAPS_API_KEY is set. Used directly unless Google itself says the
//      match is only approximate / partial.
//   2. Backup: Photon (https://photon.komoot.io, free) — the provider that
//      populated customer.coordinates for the existing customers. Its answer
//      is used directly only when it is "high confidence": a house/street-level
//      match, in the customer's country, with the customer's postal code.
//   3. Missing or low-confidence Photon answer -> a free national service:
//        France: BAN / Géoplateforme (French government address database,
//                https://data.geopf.fr/geocodage), filtered to the customer's
//                postal code, accepted at score >= GEOCODE_BAN_MIN_SCORE.
//        UK:     postcodes.io (Ordnance Survey / ONS postcode centroids —
//                postcode level, ~15 addresses per postcode).
//   4. Nothing better found -> the best low-confidence answer we did get
//      (Google approximate > BAN town-level > outward-code centroid > Photon),
//      so a customer who used to be placed is never left unplaced.
// geo.source / geo.confidence record which provider won and how sure it was.
//
// Never throws in a way that breaks the caller's request/response flow —
// callers invoke this fire-and-forget (see customer.controller.js) so a bad
// address or an unreachable API never blocks customer create/update.

const axios = require("axios");
const google = require("./googleMapsClient");

const PHOTON_URL = "https://photon.komoot.io/api/";
const BAN_URL = process.env.GEOCODE_BAN_URL || "https://data.geopf.fr/geocodage/search";
const POSTCODES_URL = (process.env.GEOCODE_POSTCODES_URL || "https://api.postcodes.io").replace(/\/+$/, "");
const BAN_MIN_SCORE = Number(process.env.GEOCODE_BAN_MIN_SCORE) || 0.6;
const TIMEOUT_MS = 8000;

const UK_POSTCODE_RE = /^([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})$/;
const UK_OUTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?$/;

function buildAddressString(address) {
  if (!address) return null;
  const parts = [address.street, address.zipCode, address.city, address.country].filter(
    (part) => part && String(part).trim().length > 0
  );
  if (parts.length === 0) return null;
  return parts.join(", ");
}

function normalizeUkPostcode(value) {
  return String(value || "").toUpperCase().replace(/\s+/g, "");
}

// "FR" / "GB" / null, from the country field first, then the postcode shape.
function detectCountry(address) {
  const country = String(address?.country || "").trim().toLowerCase();
  if (["fr", "fra", "france"].includes(country)) return "FR";
  if (["gb", "gbr", "uk", "united kingdom", "great britain", "england", "scotland", "wales", "northern ireland"].includes(country)) {
    return "GB";
  }
  if (country) return null; // some other country: no national fallback

  const zip = String(address?.zipCode || "").trim().toUpperCase();
  if (/^\d{5}$/.test(zip)) return "FR";
  if (UK_POSTCODE_RE.test(zip) || UK_OUTCODE_RE.test(zip)) return "GB";
  return null;
}

function postcodeMatches(customerZip, foundZip, country) {
  if (!customerZip || !foundZip) return false;
  if (country === "GB") {
    const a = normalizeUkPostcode(customerZip);
    const b = normalizeUkPostcode(foundZip);
    // Same full postcode, or at least the same outward code ("SW1A").
    return a === b || a.replace(/\d[A-Z]{2}$/, "") === b.replace(/\d[A-Z]{2}$/, "");
  }
  return String(customerZip).trim() === String(foundZip).trim();
}

async function geocodeWithPhoton(addressString) {
  const response = await axios.get(PHOTON_URL, {
    params: { q: addressString, limit: 1, lang: "en" },
    timeout: TIMEOUT_MS,
  });
  const feature = response.data?.features?.[0];
  if (!feature) return null;
  const [lng, lat] = feature.geometry.coordinates;
  const p = feature.properties || {};
  return { lat, lng, type: p.type, postcode: p.postcode, countrycode: p.countrycode };
}

// High confidence = street-or-better match, right country, right postcode.
function photonIsConfident(result, address, country) {
  if (!result) return false;
  if (!["house", "street"].includes(result.type)) return false;
  if (country && result.countrycode && result.countrycode.toUpperCase() !== country) return false;
  if (address.zipCode) return postcodeMatches(address.zipCode, result.postcode, country || "FR");
  return true;
}

async function banSearch(q, zip, extra = {}) {
  if (!q || q.length < 3) return null;
  const params = { q: q.slice(0, 200), limit: 1, index: "address", ...extra };
  if (/^\d{5}$/.test(zip)) params.postcode = zip;
  const response = await axios.get(BAN_URL, { params, timeout: TIMEOUT_MS });
  return response.data?.features?.[0] || null;
}

// BAN / Géoplateforme. Returns { lat, lng, confident } or null. If the
// street isn't found (typo, "ZI", "Lot 4"...), falls back to the town
// centre inside the customer's postal code (low confidence).
async function geocodeWithBan(address) {
  const street = String(address.street || "").trim();
  const city = String(address.city || "").trim();
  const zip = String(address.zipCode || "").trim();

  let feature = street ? await banSearch(`${street} ${city}`.trim(), zip) : null;
  const p = feature?.properties || {};
  if (feature && (p.score || 0) >= BAN_MIN_SCORE && ["housenumber", "street"].includes(p.type)) {
    const [lng, lat] = feature.geometry.coordinates;
    return { lat, lng, confident: true };
  }

  const town = await banSearch(city || zip, zip, { type: "municipality" });
  if (town) feature = town;
  if (!feature) return null;
  const [lng, lat] = feature.geometry.coordinates;
  return { lat, lng, confident: false };
}

// postcodes.io: full postcode -> confident; outward code only -> low.
async function geocodeWithPostcodesIo(address) {
  const zip = normalizeUkPostcode(address.zipCode);
  if (!zip) return null;
  const get = (path) =>
    axios.get(`${POSTCODES_URL}${path}`, { timeout: TIMEOUT_MS, validateStatus: (s) => s === 200 || s === 404 });

  if (UK_POSTCODE_RE.test(zip)) {
    const response = await get(`/postcodes/${encodeURIComponent(zip)}`);
    const r = response.data?.result;
    if (response.status === 200 && r?.latitude != null && r?.longitude != null) {
      return { lat: r.latitude, lng: r.longitude, confident: true };
    }
  }

  const outcode = zip.match(UK_POSTCODE_RE)?.[1] || (UK_OUTCODE_RE.test(zip) ? zip : null);
  if (!outcode) return null;
  const response = await get(`/outcodes/${encodeURIComponent(outcode)}`);
  const r = response.data?.result;
  if (response.status === 200 && r?.latitude != null && r?.longitude != null) {
    return { lat: r.latitude, lng: r.longitude, confident: false };
  }
  return null;
}

async function geocodeWithGoogle(addressString, country) {
  if (!google.config().geocodingEnabled) return null;
  const r = await google.geocode(addressString, { region: country === "GB" ? "uk" : country === "FR" ? "fr" : undefined });
  if (!r) return null;
  return { lat: r.lat, lng: r.lng, confident: r.locationType !== "APPROXIMATE" && !r.partialMatch };
}

async function tryProvider(name, cardCode, fn) {
  try {
    return await fn();
  } catch (error) {
    console.error(`${name} geocoding failed for ${cardCode}:`, error.message);
    return null;
  }
}

// Returns { lat, lng, source, confidence } or null. Exported for tests.
async function geocodeAddress(address, cardCode = "") {
  const addressString = buildAddressString(address);
  if (!addressString) return null;
  const country = detectCountry(address);

  const googleHit = await tryProvider("Google", cardCode, () => geocodeWithGoogle(addressString, country));
  if (googleHit?.confident) return { lat: googleHit.lat, lng: googleHit.lng, source: "google", confidence: "high" };

  const photon = await tryProvider("Photon", cardCode, () => geocodeWithPhoton(addressString));
  if (photonIsConfident(photon, address, country)) {
    return { lat: photon.lat, lng: photon.lng, source: "photon", confidence: "high" };
  }

  let national = null;
  if (country === "FR") {
    const ban = await tryProvider("BAN", cardCode, () => geocodeWithBan(address));
    if (ban) national = { ...ban, source: "ban" };
  } else if (country === "GB") {
    const pc = await tryProvider("postcodes.io", cardCode, () => geocodeWithPostcodesIo(address));
    if (pc) national = { ...pc, source: "postcodes.io" };
  }
  if (national?.confident) {
    return { lat: national.lat, lng: national.lng, source: national.source, confidence: "high" };
  }

  // Low-confidence fallbacks: Google's approximate match, then the national
  // answer (at least inside the customer's postal code / town), both of
  // which beat an unverified Photon hit.
  if (googleHit) return { lat: googleHit.lat, lng: googleHit.lng, source: "google", confidence: "low" };
  if (national) return { lat: national.lat, lng: national.lng, source: national.source, confidence: "low" };
  if (photon) return { lat: photon.lat, lng: photon.lng, source: "photon", confidence: "low" };
  return null;
}

// --- Which address a customer is delivered to, and which pin belongs to it ---
//
// Customers can have a separate `deliveryAddress` (synced, not declared in
// the Mongoose schema, like `coordinates`: read it via .lean()/.toObject()).
// Trucks go there, so the pin must be geocoded from it, not from the billing
// `address`. The pre-existing `coordinates` (external sync) were geocoded from
// the billing address (their displayName shows which), so they are only used
// when they match the delivery address.

const plain = (customer) => (customer && typeof customer.toObject === "function" ? customer.toObject() : customer || {});

const hasAddress = (a) => Boolean(a && (String(a.street || "").trim() || String(a.zipCode || "").trim()));

// Normalised "street|zip|city" for comparing addresses (case, accents,
// punctuation and spacing ignored).
function addressKey(address) {
  if (!hasAddress(address)) return "";
  const norm = (v) =>
    String(v || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return [address.street, address.zipCode, address.city].map(norm).join("|");
}

// The address trucks deliver to: deliveryAddress when it has one, else address.
function deliveryAddressOf(customer) {
  const c = plain(customer);
  return hasAddress(c.deliveryAddress) ? c.deliveryAddress : c.address;
}

/**
 * The customer's delivery address and a pin that really belongs to it.
 * @returns {{ address: object|undefined, coords: {lat:number,lng:number}|null }}
 *   coords null = the delivery address still needs geocoding
 */
function deliveryPoint(customer) {
  const c = plain(customer);
  const address = deliveryAddressOf(c);
  const key = addressKey(address);
  const isBilling = !hasAddress(c.deliveryAddress) || key === addressKey(c.address);
  const ok = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);

  // this feature's own geocode: valid if made from this address (older ones
  // have no addressKey and were made from the billing address)
  // a pin a dispatcher placed by hand always wins
  if (ok(c.geo) && c.geo.geocodeStatus === "manual") return { address, coords: { lat: c.geo.lat, lng: c.geo.lng } };
  if (ok(c.geo) && (c.geo.addressKey ? c.geo.addressKey === key : isBilling)) {
    return { address, coords: { lat: c.geo.lat, lng: c.geo.lng } };
  }
  // external-sync coordinates: made from the billing address
  if (ok(c.coordinates) && isBilling) {
    return { address, coords: { lat: c.coordinates.lat, lng: c.coordinates.lng } };
  }
  return { address, coords: null };
}

// Geocodes a single Customer document's delivery address (see
// deliveryAddressOf) in place and saves it. Sets geo.geocodeStatus to "ok" or
// "failed" (never leaves it stuck on "pending" after a real attempt, so the
// "needs geocoding" admin queue reflects reality). geo.addressKey records
// which address the pin is for.
async function geocodeCustomer(customer) {
  const address = deliveryAddressOf(customer);
  const addressString = buildAddressString(address);

  if (!addressString) {
    customer.geo = { geocodeStatus: "failed" };
    await customer.save();
    return customer;
  }

  const coords = await geocodeAddress(address, customer.CardCode);

  if (!coords) {
    customer.geo = { geocodedAt: new Date(), geocodeStatus: "failed" };
    await customer.save();
    return customer;
  }

  customer.geo = {
    lat: coords.lat,
    lng: coords.lng,
    geocodedAt: new Date(),
    geocodeStatus: "ok",
    source: coords.source,
    confidence: coords.confidence,
    addressKey: addressKey(address),
  };
  await customer.save();
  return customer;
}

module.exports = {
  geocodeCustomer,
  geocodeAddress,
  buildAddressString,
  detectCountry,
  addressKey,
  deliveryAddressOf,
  deliveryPoint,
};
