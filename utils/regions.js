// utils/regions.js
//
// Backend mirror of SalesFrontend/src/pages/Dashboard/regions.js — same
// department-code -> region mapping and warehouse coordinates, so the
// truck-routing backend classifies a customer's region from their postal
// code exactly the way the frontend already does (used for the region
// filter and, more importantly, so auto-fill assigns each order to the
// truck actually covering its area instead of guessing).
//
// Departments trimmed to {name, region} (frontend's `bounds`/`center`/`cities`
// aren't needed for region lookup) — keep this in sync if regions.js changes.

// timeZone: the depot's local clock, which the naive "HH:MM" departure times
// mean (used to turn them into exact timestamps for Google traffic ETAs).
const FRANCE_WAREHOUSE = { lat: 48.922385, lng: 2.395789, timeZone: "Europe/Paris" };
const UK_WAREHOUSE = { lat: 51.5074, lng: -0.1278, timeZone: "Europe/London" };

const FRANCE_DEPARTMENTS = {
  "01": "Auvergne-Rhône-Alpes", "03": "Auvergne-Rhône-Alpes", "07": "Auvergne-Rhône-Alpes",
  "15": "Auvergne-Rhône-Alpes", "26": "Auvergne-Rhône-Alpes", "38": "Auvergne-Rhône-Alpes",
  "42": "Auvergne-Rhône-Alpes", "43": "Auvergne-Rhône-Alpes", "63": "Auvergne-Rhône-Alpes",
  "69": "Auvergne-Rhône-Alpes", "73": "Auvergne-Rhône-Alpes", "74": "Auvergne-Rhône-Alpes",
  "21": "Bourgogne-Franche-Comté", "25": "Bourgogne-Franche-Comté", "39": "Bourgogne-Franche-Comté",
  "58": "Bourgogne-Franche-Comté", "70": "Bourgogne-Franche-Comté", "71": "Bourgogne-Franche-Comté",
  "89": "Bourgogne-Franche-Comté", "90": "Bourgogne-Franche-Comté",
  "22": "Bretagne", "29": "Bretagne", "35": "Bretagne", "56": "Bretagne",
  "18": "Centre-Val de Loire", "28": "Centre-Val de Loire", "36": "Centre-Val de Loire",
  "37": "Centre-Val de Loire", "41": "Centre-Val de Loire", "45": "Centre-Val de Loire",
  "2A": "Corse", "2B": "Corse",
  "08": "Grand Est", "10": "Grand Est", "51": "Grand Est", "52": "Grand Est", "54": "Grand Est",
  "55": "Grand Est", "57": "Grand Est", "67": "Grand Est", "68": "Grand Est", "88": "Grand Est",
  "02": "Hauts-de-France", "59": "Hauts-de-France", "60": "Hauts-de-France",
  "62": "Hauts-de-France", "80": "Hauts-de-France",
  "75": "Île-de-France", "77": "Île-de-France", "78": "Île-de-France", "91": "Île-de-France",
  "92": "Île-de-France", "93": "Île-de-France", "94": "Île-de-France", "95": "Île-de-France",
  "14": "Normandie", "27": "Normandie", "50": "Normandie", "61": "Normandie", "76": "Normandie",
  "16": "Nouvelle-Aquitaine", "17": "Nouvelle-Aquitaine", "19": "Nouvelle-Aquitaine",
  "23": "Nouvelle-Aquitaine", "24": "Nouvelle-Aquitaine", "33": "Nouvelle-Aquitaine",
  "40": "Nouvelle-Aquitaine", "47": "Nouvelle-Aquitaine", "64": "Nouvelle-Aquitaine",
  "79": "Nouvelle-Aquitaine", "86": "Nouvelle-Aquitaine", "87": "Nouvelle-Aquitaine",
  "09": "Occitanie", "11": "Occitanie", "12": "Occitanie", "30": "Occitanie", "31": "Occitanie",
  "32": "Occitanie", "34": "Occitanie", "46": "Occitanie", "48": "Occitanie", "65": "Occitanie",
  "66": "Occitanie", "81": "Occitanie", "82": "Occitanie",
  "44": "Pays de la Loire", "49": "Pays de la Loire", "53": "Pays de la Loire",
  "72": "Pays de la Loire", "85": "Pays de la Loire",
  "04": "Provence-Alpes-Côte d'Azur", "05": "Provence-Alpes-Côte d'Azur",
  "06": "Provence-Alpes-Côte d'Azur", "13": "Provence-Alpes-Côte d'Azur",
  "83": "Provence-Alpes-Côte d'Azur", "84": "Provence-Alpes-Côte d'Azur",
};

const UK_DEPARTMENTS = {
  E: "Greater London", EC: "Greater London", N: "Greater London", NW: "Greater London",
  SE: "Greater London", SW: "Greater London", W: "Greater London", WC: "Greater London",
  AL: "Hertfordshire", BR: "Kent", CM: "Essex", CR: "Surrey", DA: "Kent", EN: "Hertfordshire",
  GU: "Surrey", HA: "Middlesex", HP: "Hertfordshire", IG: "Essex", KT: "Surrey", LU: "Bedfordshire",
  ME: "Kent", MK: "Buckinghamshire", RH: "Surrey", RM: "Essex", SL: "Berkshire", SM: "Surrey",
  SS: "Essex", TN: "Kent", TW: "Middlesex", UB: "Middlesex", WD: "Hertfordshire",
  B: "West Midlands", M: "Greater Manchester", L: "Merseyside", LS: "West Yorkshire",
  S: "South Yorkshire", NG: "Nottinghamshire", BS: "Bristol", NE: "Tyne and Wear",
  EH: "Scotland", G: "Scotland", CF: "Wales",
};

function getWarehouse(tenant) {
  return tenant === "ms-foods" ? UK_WAREHOUSE : FRANCE_WAREHOUSE;
}

// Extracts a French department code from a zip code the same way
// MapPage.jsx's filterOrdersByDistance already does: 3-digit prefix for
// overseas departments (97x/98x), 2-digit prefix otherwise.
function frenchDepartmentFromZip(zip) {
  if (!zip) return null;
  const clean = String(zip).trim();
  if (clean.startsWith("97") || clean.startsWith("98")) return clean.substring(0, 3);
  return clean.substring(0, 2);
}

// Extracts the alphabetic outward-code prefix from a UK postcode
// ("SW1A 1AA" -> "SW", "M1 1AE" -> "M"), matched against the longest known
// department key first so e.g. "EC" isn't shadowed by "E".
function ukDepartmentFromPostcode(postcode) {
  if (!postcode) return null;
  const clean = String(postcode).trim().toUpperCase();
  const match = clean.match(/^[A-Z]+/);
  if (!match) return null;
  const prefix = match[0];
  const keys = Object.keys(UK_DEPARTMENTS).sort((a, b) => b.length - a.length);
  return keys.find((k) => prefix.startsWith(k)) || null;
}

// Returns the region name for a Customer's address, or null if it can't be
// determined (missing/unrecognized postal code) — callers must treat null
// as "region unknown", never guess a default region for it.
function regionForAddress(address, tenant) {
  if (!address || !address.zipCode) return null;

  if (tenant === "ms-foods") {
    const dept = ukDepartmentFromPostcode(address.zipCode);
    return dept ? UK_DEPARTMENTS[dept] : null;
  }

  const dept = frenchDepartmentFromZip(address.zipCode);
  return dept ? FRANCE_DEPARTMENTS[dept] || null : null;
}

module.exports = { getWarehouse, regionForAddress, FRANCE_DEPARTMENTS, UK_DEPARTMENTS };
