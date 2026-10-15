// utils/prospectMatch.js
//
// Is a scraped restaurant (a prospect) already an SAP customer or a lead?
// Then the Sales Map does not show it as a prospect.
//
// Name alone is weak (two "Pizza Roma" in different towns), so phone, email
// and address are used as extra signals:
//   - the same phone or email as a customer / lead = the same business, but only
//     when that phone / email is not shared: several Uber Eats brands of one
//     kitchen share a phone, and some scraped phones are junk copied onto
//     hundreds of records;
//   - the same name (or one name inside the other) AND the same address,
//     postal code or phone = the same restaurant;
//   - a shared address alone never makes two records the same restaurant
//     (virtual brands: one kitchen, several brands). It is reported as
//     "related" so the panel can say "same address as customer X".
// The old Postal Scraping source keeps its rule (same name as a customer in
// view) plus the unshared phone / email signal: its postal code is the searched
// code, not where the restaurant is, so name + postal code means nothing there.
const Customer = require("../models/Customer");
const SalesLead = require("../models/SalesLead");
const { addressKey } = require("../services/ubereats/parse");

const INDEX_TTL_MS = 10 * 60 * 1000;
// A phone / email on more than this many customers + leads is not one business.
const SHARED_CANDIDATE_LIMIT = 2;

const normName = (v) =>
  String(v || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Names that say what is sold, not who sells it: never matched on their own.
const GENERIC = new Set(
  "restaurant resto pizza pizzeria kebab tacos burger burgers snack boulangerie patisserie sushi halal grill chicken food cafe bar bistro brasserie traiteur epicerie market supermarche boucherie le la les de du des the and et chez maison paris fast".split(
    " "
  )
);
const isGeneric = (name) => name.split(" ").every((w) => GENERIC.has(w) || /^\d+$/.test(w));

/** Name variants of a prospect: full title, the part before " - " / " | ", the legal name. */
// Tags and words added by imports, not part of the business name: "#SCRPD-NADIA", a leading "Restaurant".
const cleanName = (n) =>
  String(n || "")
    .replace(/#\S+/g, " ")
    .replace(/^\s*(restaurant|resto)\s+/i, "");
const SPLIT_TITLE = /\s[-|–]\s|\s\|\s/;

function nameVariants(...names) {
  const out = new Set();
  const add = (v) => v.length >= 3 && out.add(v);
  names.filter(Boolean).forEach((raw) => {
    const n = cleanName(raw);
    add(normName(n));
    add(normName(String(n).split(SPLIT_TITLE)[0]));
    // The HubSpot import dropped accented letters ("Hélia" became "Hlia"): also compare without them.
    if (/[^\x00-\x7F]/.test(n)) {
      const dropped = n.replace(/[^\x00-\x7F]/g, "");
      add(normName(dropped));
      add(normName(dropped.split(SPLIT_TITLE)[0]));
    }
  });
  return [...out];
}

/** One name equals the other, or the shorter (6+ letters, not generic) is a whole-word part of the longer. */
function namesMatch(aList, bList) {
  for (const a of aList) {
    for (const b of bList) {
      if (!a || !b) continue;
      if (a === b && !isGeneric(a)) return true;
      const [short, long] = a.length <= b.length ? [a, b] : [b, a];
      if (short.length >= 6 && !isGeneric(short) && ` ${long} `.includes(` ${short} `)) return true;
    }
  }
  return false;
}

/**
 * French phone -> its 9 significant digits ("01 44 82 51 38", "+33144825138",
 * "144825138" -> "144825138"); null for anything that is not a plausible number
 * (too short, one repeated digit, 123456789, ...).
 */
function normPhone(v) {
  let d = String(v || "").replace(/\D/g, "");
  if (d.startsWith("0033")) d = d.slice(4);
  else if (d.startsWith("33") && d.length === 11) d = d.slice(2);
  d = d.replace(/^0+/, "");
  if (d.length !== 9 || !/^[1-9]/.test(d)) return null;
  if (/^(\d)\1+$/.test(d.slice(1)) || /^(\d)\1{5,}/.test(d) || "123456789".includes(d) || "987654321".includes(d)) return null;
  return d;
}

const normEmail = (v) => {
  const e = String(v || "").trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e) && e !== "n/a" ? e : null;
};

const zip5 = (v) => String(v || "").match(/\d{5}/)?.[0] || null;

/**
 * Text saved as UTF-8 but read as Latin-1 somewhere (the HubSpot import): "OpÃ©ra" -> "Opéra",
 * "LâHaÃ¿" -> "L'Haÿ". Only touched when it shows that pattern; anything else is returned as is.
 */
function repairText(v) {
  const s = String(v ?? "");
  if (!/[ÃÂâ]/.test(s)) return s;
  return s
    .replace(/[ÃÂ][-¿]/g, (pair) => {
      const fixed = Buffer.from(pair, "latin1").toString("utf8");
      return fixed.includes("�") ? pair : fixed;
    })
    .replace(/â[-¿]{0,2}/g, "'");
}

function candidateFromCustomer(c) {
  const addr = c.deliveryAddress && (c.deliveryAddress.street || c.deliveryAddress.zipCode) ? c.deliveryAddress : c.address || {};
  const zip = zip5(addr.zipCode);
  const name = repairText(c.CardName);
  return {
    type: "customer",
    id: c.CardCode,
    name,
    // SAP customers have a C… code; NC-… records are HubSpot contacts imported into the customers list
    // (status "prospect" or "lead"), not SAP customers.
    source: /^NC/i.test(String(c.CardCode || "")) ? "hubspot" : "sap",
    status: c.status || "",
    // The agent the customer is assigned to (Customer.assignedTo), shown as "assigned to …".
    ownerId: c.assignedTo ? String(c.assignedTo) : null,
    names: nameVariants(name),
    phones: [c.phoneNumber, ...(c.additionalPhoneNumbers || [])].map(normPhone).filter(Boolean),
    emails: [c.Email, ...(c.additionalEmails || [])].map(normEmail).filter(Boolean),
    zip,
    addressKey: zip ? addressKey({ postalCode: zip, streetAddress: addr.street }) : null,
  };
}

function candidateFromLead(l) {
  const zip = zip5(l.address?.zipCode);
  return {
    type: "lead",
    id: String(l._id),
    name: l.company || l.fullName,
    status: l.status || "new",
    ownerId: l.assignedTo ? String(l.assignedTo) : null,
    names: nameVariants(l.company, l.fullName),
    phones: [normPhone(l.phoneNumber)].filter(Boolean),
    emails: [normEmail(l.email)].filter(Boolean),
    zip,
    addressKey: zip && l.address?.street ? addressKey({ postalCode: zip, streetAddress: l.address.street }) : null,
    relatedRestaurant: l.relatedRestaurant ? String(l.relatedRestaurant) : null,
  };
}

const push = (map, key, value) => {
  if (!key) return;
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

let cached = null;

/**
 * Every customer and lead, indexed by phone, email, address and postal code.
 * Kept 10 minutes. `ueStores` (optional) = Uber Eats stores, to tell a phone
 * shared by several brands of one kitchen.
 */
async function buildIndex({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cached.at < INDEX_TTL_MS) return cached.index;
  const [customers, leads] = await Promise.all([
    Customer.find({}).select("CardCode CardName status assignedTo phoneNumber additionalPhoneNumbers Email additionalEmails address deliveryAddress").lean(),
    SalesLead.find({}).select("fullName company status assignedTo phoneNumber email address relatedRestaurant").lean(),
  ]);
  const index = indexCandidates([...customers.map(candidateFromCustomer), ...leads.map(candidateFromLead)]);
  cached = { at: Date.now(), index };
  return index;
}

function indexCandidates(candidates) {
  const byPhone = new Map();
  const byEmail = new Map();
  const byAddress = new Map();
  const byZip = new Map();
  candidates.forEach((c) => {
    new Set(c.phones).forEach((p) => push(byPhone, p, c));
    new Set(c.emails).forEach((e) => push(byEmail, e, c));
    push(byAddress, c.addressKey, c);
    push(byZip, c.zip, c);
  });
  return { candidates, byPhone, byEmail, byAddress, byZip };
}

/** How many Uber Eats stores use each phone / email (brands of one kitchen share them). */
function storeContactCounts(stores) {
  const phones = new Map();
  const emails = new Map();
  stores.forEach((s) => {
    new Set([normPhone(s.phoneNumber), normPhone(s.legal?.phone)].filter(Boolean)).forEach((p) => phones.set(p, (phones.get(p) || 0) + 1));
    const e = normEmail(s.email);
    if (e) emails.set(e, (emails.get(e) || 0) + 1);
  });
  return { phones, emails };
}

/**
 * Matches one prospect against the index.
 * @param {Object} p - { names[], phones[], emails[], zip, addressKey, source: "ubereats"|"scraped" }
 * @param {Object} index - from buildIndex()
 * @param {Object} [shared] - storeContactCounts() of the prospect's own source
 * @returns {{ same: Object|null, related: Array }} same = { type, id, name, via } when it is that customer / lead
 */
function matchProspect(p, index, shared = { phones: new Map(), emails: new Map() }) {
  const related = [];
  const sameVia = (c, via) => ({ type: c.type, id: c.id, name: c.name, status: c.status, source: c.source, ownerId: c.ownerId || null, via });
  const unique = (list, sharedCount) => list && list.length <= SHARED_CANDIDATE_LIMIT && !(sharedCount > 1);
  // Same phone / email but another name AND another known postal code: most likely the same owner's
  // other business (owners give their own mobile for each), not this restaurant. Shown, not hidden.
  const elsewhere = (c) => p.zip && c.zip && p.zip !== c.zip && !namesMatch(p.names, c.names);
  // A phone / email alone is not enough: the name, the postal code or the street must agree too.
  // Otherwise (e.g. the record has another name and no address) it is only a possible match, shown.
  const confirmed = (c) => namesMatch(p.names, c.names) || (p.zip && c.zip && p.zip === c.zip) || (p.addressKey && c.addressKey && p.addressKey === c.addressKey);

  // Unshared phone / email.
  for (const ph of p.phones || []) {
    const list = index.byPhone.get(ph);
    if (!list) continue;
    if (unique(list, shared.phones.get(ph))) {
      if (confirmed(list[0])) return { same: sameVia(list[0], namesMatch(p.names, list[0].names) ? "name and phone" : "phone and address"), related };
      related.push({ type: list[0].type, id: list[0].id, name: list[0].name, via: elsewhere(list[0]) ? "phone, other address" : "phone only, not confirmed" });
      continue;
    }
    const named = list.find((c) => namesMatch(p.names, c.names));
    if (named) return { same: sameVia(named, "name and phone"), related };
    list.slice(0, 3).forEach((c) => related.push({ type: c.type, id: c.id, name: c.name, via: "phone" }));
  }
  for (const em of p.emails || []) {
    const list = index.byEmail.get(em);
    if (!list) continue;
    if (unique(list, shared.emails.get(em))) {
      if (confirmed(list[0])) return { same: sameVia(list[0], namesMatch(p.names, list[0].names) ? "name and email" : "email and address"), related };
      related.push({ type: list[0].type, id: list[0].id, name: list[0].name, via: elsewhere(list[0]) ? "email, other address" : "email only, not confirmed" });
      continue;
    }
    const named = list.find((c) => namesMatch(p.names, c.names));
    if (named) return { same: sameVia(named, "name and email"), related };
  }

  if (p.source === "ubereats") {
    // Same name and same address.
    const atAddress = p.addressKey ? index.byAddress.get(p.addressKey) || [] : [];
    const named = atAddress.find((c) => namesMatch(p.names, c.names));
    if (named) return { same: sameVia(named, "name and address"), related };
    // Same name in the same postal code (the customer's street may be written differently).
    const inZip = p.zip ? index.byZip.get(p.zip) || [] : [];
    const namedZip = inZip.find((c) => namesMatch(p.names, c.names));
    if (namedZip) return { same: sameVia(namedZip, "name and postal code"), related };
    // Same address, other name: a different brand / business at that address.
    atAddress.slice(0, 3).forEach((c) => related.push({ type: c.type, id: c.id, name: c.name, via: "address" }));
  }
  // Keep each customer / lead once.
  const seen = new Set();
  return { same: null, related: related.filter((r) => !seen.has(`${r.type}:${r.id}`) && seen.add(`${r.type}:${r.id}`)) };
}

/** Matching input for an Uber Eats store (ubereats_restaurants record). */
const ueProspectKeys = (s) => ({
  source: "ubereats",
  names: nameVariants(s.title, s.legal?.name),
  phones: [normPhone(s.phoneNumber), normPhone(s.legal?.phone)].filter(Boolean),
  emails: [normEmail(s.email)].filter(Boolean),
  zip: s.postalCode || null,
  addressKey: s.addressKey || null,
});

/** Matching input for an old Postal Scraping record (restaurants collection). */
const oldProspectKeys = (r) => ({
  source: "scraped",
  names: nameVariants(r.name),
  phones: [normPhone(r.contact_info?.phone)].filter(Boolean),
  emails: [normEmail(r.contact_info?.email)].filter(Boolean),
  zip: null,
  addressKey: null,
});

/** The Uber Eats store id in a store URL (".../store/<slug>/<id>"), as the new scraper builds it. */
const storeIdFromUrl = (url) => String(url || "").match(/\/store\/[^/]+\/([A-Za-z0-9_-]{20,24})/)?.[1] || null;

module.exports = {
  buildIndex,
  indexCandidates,
  storeContactCounts,
  matchProspect,
  ueProspectKeys,
  oldProspectKeys,
  storeIdFromUrl,
  normPhone,
  normEmail,
  normName,
  nameVariants,
  namesMatch,
  candidateFromCustomer,
  repairText,
  candidateFromLead,
  _reset: () => (cached = null),
};
