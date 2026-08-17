// utils/addressNormalization.js
//
// Shared normalisation helpers used to work out when two customer records are
// really the same physical shop. The data is entered by hand (and imported from
// SAP), so the same address turns up as "225 TER AVENUE JEAN JAURES",
// "225 ter av. Jean Jaurès" and "225ter Av Jean Jaures". Everything below
// exists to collapse those into one comparable key.

// Canonical form for the French street-type words. Everything on the left maps
// to the token on the right so "av"/"ave"/"avenue" all compare equal.
const STREET_TYPES = {
  av: "av", ave: "av", aven: "av", avn: "av", avenue: "av",
  bd: "bd", bld: "bd", blv: "bd", blvd: "bd", boul: "bd", boulevard: "bd",
  r: "rue", rue: "rue",
  pl: "pl", place: "pl",
  rte: "rte", route: "rte",
  imp: "imp", impasse: "imp",
  all: "all", allee: "all", allees: "all",
  ch: "ch", chem: "ch", chemin: "ch",
  sq: "sq", square: "sq",
  qu: "quai", quai: "quai",
  fg: "fbg", fbg: "fbg", faubourg: "fbg",
  crs: "crs", cours: "crs",
  pass: "pass", passage: "pass",
  res: "res", residence: "res",
  vla: "vla", villa: "vla",
  sen: "sen", sente: "sen",
  rpt: "rpt", rondpoint: "rpt",
  ham: "ham", hameau: "ham",
  ld: "ld", lieudit: "ld",
  zi: "zi", za: "za", zac: "zac", cc: "cc",
  st: "st", saint: "st",
  ste: "ste", sainte: "ste",
  gal: "gal", galerie: "gal",
  ctre: "ctre", centre: "ctre",
};

// Articles and prepositions carry no signal and are written inconsistently
// ("rue de la gare" vs "rue gare"), so they are dropped entirely.
const NOISE_WORDS = new Set([
  "de", "du", "des", "la", "le", "les", "d", "l", "a", "au", "aux", "et", "en",
  "sur", "sous", "the",
]);

// House-number suffixes that must stay attached to the number: 225 and 225 ter
// are different buildings.
const NUMBER_SUFFIXES = new Set(["bis", "ter", "quater", "quinquies"]);

/**
 * Remove diacritics so "Jaurès" and "Jaures" compare equal.
 */
const stripAccents = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

/**
 * Turn a free-text street into a canonical token string.
 * Returns "" when there is nothing usable to compare.
 */
const normalizeStreet = (street) => {
  const cleaned = stripAccents(street)
    .toLowerCase()
    .replace(/['`’]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  if (!cleaned) return "";

  const words = cleaned.split(" ").filter(Boolean);
  const tokens = [];

  words.forEach((word) => {
    // Glue a bis/ter suffix onto the house number it belongs to.
    if (NUMBER_SUFFIXES.has(word) && tokens.length && /^\d+$/.test(tokens[tokens.length - 1])) {
      tokens[tokens.length - 1] += word;
      return;
    }

    // "225ter" written without a space -> split then re-glue, so both spellings land here.
    const glued = word.match(/^(\d+)(bis|ter|quater|quinquies)$/);
    if (glued) {
      tokens.push(glued[1] + glued[2]);
      return;
    }

    if (NOISE_WORDS.has(word)) return;

    tokens.push(STREET_TYPES[word] || word);
  });

  return tokens.join(" ").trim();
};

/**
 * French postcodes are 5 digits. Anything else is treated as unusable rather
 * than guessed at.
 */
const normalizeZip = (zip) => {
  const digits = String(zip || "").replace(/\D/g, "");
  return digits.length === 5 ? digits : "";
};

const normalizeCity = (city) =>
  stripAccents(city)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Pick the address to match on. Delivery address wins: that is the physical
 * shop, which is the thing that stays put when the account gets renamed.
 * Falls back to the billing address, then to the SAP `addresses` array.
 */
const pickMatchAddress = (customer) => {
  if (!customer) return null;

  const candidates = [customer.deliveryAddress, customer.address];

  if (Array.isArray(customer.addresses) && customer.addresses.length) {
    const shipTo = customer.addresses.find((a) => a && a.addressType === "bo_ShipTo");
    const billTo = customer.addresses.find((a) => a && a.addressType === "bo_BillTo");
    candidates.push(shipTo, billTo, customer.addresses[0]);
  }

  return candidates.find((a) => a && a.street && String(a.street).trim()) || null;
};

/**
 * Build the key two customers must share to be considered at the same site.
 *
 * Both a normalised street AND a valid postcode are required, and the street
 * must contain a house number — "zone industrielle" on its own matches half of
 * France and would generate nothing but false positives.
 *
 * @returns {string|null} "<street>|<zip>" or null when the address is unusable.
 */
const buildAddressKey = (customer) => {
  const addr = pickMatchAddress(customer);
  if (!addr) return null;

  const street = normalizeStreet(addr.street);
  const zip = normalizeZip(addr.zipCode);

  if (!street || !zip) return null;
  if (!/\d/.test(street)) return null;
  if (street.length < 4) return null;

  return `${street}|${zip}`;
};

/**
 * Reduce a phone number to its 9 significant national digits.
 * Returns null for anything that is not a plausible French number.
 */
const normalizePhone = (phone) => {
  let digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return null;

  if (digits.startsWith("0033")) digits = digits.slice(4);
  else if (digits.startsWith("33") && digits.length > 9) digits = digits.slice(2);

  if (digits.startsWith("0")) digits = digits.slice(1);

  if (digits.length !== 9) return null;
  // Placeholders like 000000000 / 111111111.
  if (/^(\d)\1{8}$/.test(digits)) return null;
  if (digits === "123456789") return null;

  return digits;
};

/**
 * Every usable phone on the record, de-duplicated.
 */
const collectPhoneKeys = (customer) => {
  const raw = [customer?.phoneNumber, ...(customer?.additionalPhoneNumbers || [])];
  const keys = new Set();
  raw.forEach((p) => {
    const key = normalizePhone(p);
    if (key) keys.add(key);
  });
  return [...keys];
};

// Legal-form and generic trade words that say nothing about which shop this is.
const NAME_NOISE = new Set([
  "sarl", "sas", "sasu", "eurl", "sa", "sci", "snc", "ltd", "limited", "inc",
  "entreprise", "ets", "etablissement", "etablissements", "societe", "ste",
  "other", "particulier", "client", "monsieur", "madame", "mr", "mme", "m",
  "de", "du", "des", "la", "le", "les", "d", "l", "and", "et", "the",
]);

/**
 * Comparable form of an account name, with legal forms and noise stripped.
 */
const normalizeName = (name) =>
  stripAccents(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !NAME_NOISE.has(w))
    .join(" ")
    .trim();

/**
 * 0..1 similarity between two account names, based on shared word tokens
 * (Jaccard) with a bonus when one name is contained in the other — the usual
 * shape of a rename, e.g. "THE GRILL HOUSE" -> "THE GRILL HOUSE Malik".
 */
const nameSimilarity = (a, b) => {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const sa = new Set(na.split(" "));
  const sb = new Set(nb.split(" "));
  let shared = 0;
  sa.forEach((t) => {
    if (sb.has(t)) shared += 1;
  });

  const union = new Set([...sa, ...sb]).size;
  const jaccard = union ? shared / union : 0;

  if (na.includes(nb) || nb.includes(na)) return Math.max(jaccard, 0.8);
  return jaccard;
};

/**
 * Highest pairwise name similarity across a group, and whether the names differ
 * at all. A group where every name is identical is a plain duplicate record; a
 * group of unrelated names at one address is the "renamed shop" case the sales
 * team cares about.
 */
const summariseNames = (names) => {
  const normalised = names.map(normalizeName).filter(Boolean);
  const distinct = new Set(normalised);

  let maxSimilarity = 0;
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      maxSimilarity = Math.max(maxSimilarity, nameSimilarity(names[i], names[j]));
    }
  }

  return {
    distinctNameCount: distinct.size,
    allNamesIdentical: distinct.size <= 1,
    maxNameSimilarity: Number(maxSimilarity.toFixed(2)),
  };
};

module.exports = {
  stripAccents,
  normalizeStreet,
  normalizeZip,
  normalizeCity,
  pickMatchAddress,
  buildAddressKey,
  normalizePhone,
  collectPhoneKeys,
  normalizeName,
  nameSimilarity,
  summariseNames,
};
