// utils/geocodingService.js
//
// Turns a Customer's address into lat/lng for the Sales Map Report / Truck
// Schedules routing feature.
//
// Order of providers (all free, no API key except Google):
//   1. Photon (https://photon.komoot.io) — the provider that populated
//      customer.coordinates for the existing customers. Its answer is used
//      directly only when it is "high confidence": a house/street-level
//      match, in the customer's country, with the customer's postal code.
//   2. Missing or low-confidence Photon answer -> a national service:
//        France: BAN / Géoplateforme (French government address database,
//                https://data.geopf.fr/geocodage), filtered to the customer's
//                postal code, accepted at score >= GEOCODE_BAN_MIN_SCORE.
//        UK:     postcodes.io (Ordnance Survey / ONS postcode centroids —
//                postcode level, ~15 addresses per postcode).
//   3. Google Geocoding, only if GOOGLE_MAPS_API_KEY is set and billing is on
//      (that project currently has billing disabled -> REQUEST_DENIED, so it
//      is silently skipped).
//   4. Nothing better found -> the best low-confidence answer we did get
//      (BAN town-level > outward-code centroid > Photon), so a customer who
//      used to be placed is never left unplaced by this change.
// geo.source / geo.confidence record which provider won and how sure it was.
//
// Never throws in a way that breaks the caller's request/response flow —
// callers invoke this fire-and-forget (see customer.controller.js) so a bad
// address or an unreachable API never blocks customer create/update.

const axios = require("axios");

const PHOTON_URL = "https://photon.komoot.io/api/";
const GOOGLE_URL = "https://maps.googleapis.com/maps/api/geocode/json";
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

async function geocodeWithGoogle(addressString) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;
  const response = await axios.get(GOOGLE_URL, {
    params: { address: addressString, key: apiKey },
    timeout: TIMEOUT_MS,
  });
  if (response.data?.status !== "OK") return null;
  const result = response.data?.results?.[0];
  if (!result) return null;
  return { lat: result.geometry.location.lat, lng: result.geometry.location.lng };
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

  const google = await tryProvider("Google", cardCode, () => geocodeWithGoogle(addressString));
  if (google) return { lat: google.lat, lng: google.lng, source: "google", confidence: "high" };

  // Low-confidence fallbacks: the national answer is at least inside the
  // customer's postal code / town, so it beats an unverified Photon hit.
  if (national) return { lat: national.lat, lng: national.lng, source: national.source, confidence: "low" };
  if (photon) return { lat: photon.lat, lng: photon.lng, source: "photon", confidence: "low" };
  return null;
}

// Geocodes a single Customer document in place and saves it. Sets
// geo.geocodeStatus to "ok" or "failed" (never leaves it stuck on "pending"
// after a real attempt, so the "needs geocoding" admin queue reflects reality).
async function geocodeCustomer(customer) {
  const addressString = buildAddressString(customer.address);

  if (!addressString) {
    customer.geo = { geocodeStatus: "failed" };
    await customer.save();
    return customer;
  }

  const coords = await geocodeAddress(customer.address, customer.CardCode);

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
  };
  await customer.save();
  return customer;
}

module.exports = { geocodeCustomer, geocodeAddress, buildAddressString, detectCountry };
