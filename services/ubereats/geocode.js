// services/ubereats/geocode.js
// Fallback map point for stores Uber Eats returns without coordinates.
// Uber Eats' getStoreV1 normally carries the store's latitude/longitude (geo, geoSource "ubereats").
// When it doesn't, the street address is looked up in the French address base (BAN, via the IGN
// Géoplateforme; free, no key, 50 req/s per IP). Only house-number / street level hits are kept,
// so a store is never pinned to a town centre.
const { normalizePostalCode } = require("./parse");

const BAN_URL = process.env.GEOCODE_BAN_URL || "https://data.geopf.fr/geocodage/search";
const MIN_SCORE = Number(process.env.GEOCODE_BAN_MIN_SCORE ?? 0.6);
const TIMEOUT_MS = 8000;

async function geocodeBan(query, postalCode) {
  if (process.env.UBEREATS_GEOCODE_ENABLED === "false" || String(query).trim().length < 3) return undefined;
  const params = new URLSearchParams({ q: String(query).slice(0, 200), limit: "1", index: "address" });
  if (postalCode) params.set("postcode", postalCode);
  const res = await fetch(`${BAN_URL}?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`BAN geocoder HTTP ${res.status}`);
  const feature = (await res.json())?.features?.[0];
  const p = feature?.properties || {};
  if (!feature || (p.score || 0) < MIN_SCORE || !["housenumber", "street"].includes(p.type)) return undefined;
  const [longitude, latitude] = feature.geometry.coordinates;
  return { latitude, longitude, postalCode: normalizePostalCode(p.postcode) };
}

/** Adds `geo` (and a missing postal code) from the address when Uber Eats sent no coordinates. Never throws. */
async function fillMissingGeo(parsed, log) {
  if (parsed.geo) return;
  const loc = parsed.location || {};
  const street = loc.streetAddress || loc.address;
  if (!street) return;
  try {
    const hit = await geocodeBan([street, loc.city].filter(Boolean).join(" "), parsed.postalCode);
    if (!hit) return;
    parsed.geo = { type: "Point", coordinates: [hit.longitude, hit.latitude] };
    parsed.geoSource = "ban";
    if (!parsed.postalCode) parsed.postalCode = hit.postalCode;
  } catch (e) {
    log(`${parsed.title}: address lookup failed (${e.message})`);
  }
}

module.exports = { geocodeBan, fillMissingGeo };
