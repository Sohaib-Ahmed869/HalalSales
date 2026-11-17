// services/ubereats/owners.js
//
// Who owns an Uber Eats store, so one owner becomes one lead. Many "restaurants"
// are virtual brands cooked in one kitchen by one owner: the agent should call
// that owner once, about all of their brands.
//
// Stores are grouped by owner, strongest proof first:
//   1. the same SIREN (first 9 digits of the SIRET in the store's legal info):
//      the same legal company, whatever the address or phone;
//   2. the same phone, then the same email, but only when that phone / email is
//      never used by two different SIRENs (a call centre, an accountant's
//      address, a dark-kitchen operator's switchboard) and by at most
//      SHARED_CONTACT_LIMIT stores (junk copied onto many records);
//   3. the same street address, only between stores that have no SIREN at all,
//      at an address where no store has one, with a street number, and with at
//      most ADDRESS_LIMIT stores there. A shared dark kitchen or food court hosts
//      several companies at one address, so an address is never proof once a
//      SIREN is known there; most stores without a SIREN simply have no details
//      fetched yet, and get grouped properly once they do.
// Two different SIRENs are never put in one group, even through a chain of
// shared phones / emails.
//
// The group's key (Lead.ownerKey) is "siren:<9 digits>" when the group has one,
// else "phone:", "email:" or "addr:" of the key that formed it, else "uuid:" for
// a store on its own. A store's key can change when its details arrive, so leads
// are found by the uuids of the group's stores first and by the key second.
const { normPhone, normEmail } = require("../../utils/prospectMatch");

const TTL_MS = 10 * 60 * 1000;
// A phone / email on more stores than this is not one owner's.
const SHARED_CONTACT_LIMIT = 25;
// More stores than this at one address is a food court / mall / station, not one kitchen.
const ADDRESS_LIMIT = 8;

const OWNER_FIELDS = { _id: 0, uuid: 1, siren: 1, registrationNumber: 1, phoneNumber: 1, "legal.phone": 1, email: 1, addressKey: 1 };

/** A SIREN that passes the Luhn check (every real one does); null otherwise. */
function validSiren(v) {
  const d = String(v || "").replace(/\D/g, "");
  if (d.length !== 9 || /^(\d)\1+$/.test(d)) return null;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(d[8 - i]);
    if (i % 2 === 1) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0 ? d : null;
}

/** The SIREN of a store (its siren field, or the start of its SIRET). */
const storeSiren = (s) => validSiren(s.siren) || validSiren(String(s.registrationNumber || "").replace(/\D/g, "").slice(0, 9));

/** The owner keys of one store (the same for an Uber Eats store and a lead's brand). */
function storeKeys(s) {
  return {
    siren: storeSiren(s),
    phones: [...new Set([normPhone(s.phoneNumber), normPhone(s.legal?.phone)].filter(Boolean))],
    email: normEmail(s.email),
    // Only a numbered street ("75011|12 rue ...") is precise enough to stand for one kitchen.
    address: s.addressKey && /\|\d/.test(s.addressKey) ? s.addressKey : null,
  };
}

/**
 * Groups stores by owner.
 * @param {Array} stores - ubereats_restaurants records (OWNER_FIELDS is enough)
 * @returns {{ groupOf: Map<uuid, {key, uuids[]}>, groups: Array<{key, uuids[], via}> }}
 */
function groupOwners(stores) {
  const list = stores.filter((s) => s && s.uuid);
  const keys = list.map(storeKeys);

  // Union-find over the stores; each root remembers its SIREN so two companies never join.
  const parent = list.map((_, i) => i);
  const siren = keys.map((k) => k.siren);
  const via = keys.map((k) => (k.siren ? `siren:${k.siren}` : null));
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const union = (a, b, how) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (siren[ra] && siren[rb] && siren[ra] !== siren[rb]) return;
    parent[rb] = ra;
    siren[ra] = siren[ra] || siren[rb];
    via[ra] = siren[ra] ? `siren:${siren[ra]}` : via[ra] || via[rb] || how;
  };
  // Links every store holding the same value; `ok(value, members)` says if the value can be trusted.
  const linkBy = (valuesOf, prefix, ok) => {
    const byValue = new Map();
    list.forEach((_, i) => valuesOf(i).forEach((v) => (byValue.get(v) || byValue.set(v, []).get(v)).push(i)));
    byValue.forEach((members, v) => {
      if (members.length < 2 || !ok(members)) return;
      const sorted = [...members].sort((a, b) => a - b);
      for (let j = 1; j < sorted.length; j++) union(sorted[0], sorted[j], `${prefix}:${v}`);
    });
  };
  const sirensOf = (members) => new Set(members.map((i) => keys[i].siren).filter(Boolean));
  const contactOk = (members) => members.length <= SHARED_CONTACT_LIMIT && sirensOf(members).size <= 1;

  linkBy((i) => (keys[i].siren ? [keys[i].siren] : []), "siren", () => true);
  linkBy((i) => keys[i].phones, "phone", contactOk);
  linkBy((i) => (keys[i].email ? [keys[i].email] : []), "email", contactOk);
  // The address: stores without a SIREN, where nobody at that address has one.
  const sirensAt = new Map();
  keys.forEach((k) => k.address && k.siren && sirensAt.set(k.address, true));
  linkBy((i) => (keys[i].address && !keys[i].siren && !sirensAt.get(keys[i].address) ? [keys[i].address] : []), "addr", (m) => m.length <= ADDRESS_LIMIT);

  const byRoot = new Map();
  list.forEach((s, i) => {
    const r = find(i);
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(s.uuid);
  });
  const groupOf = new Map();
  const groups = [];
  byRoot.forEach((uuids, r) => {
    const key = via[r] || `uuid:${uuids[0]}`;
    const g = { key, uuids, via: key.split(":")[0] };
    groups.push(g);
    uuids.forEach((u) => groupOf.set(u, g));
  });
  return { groupOf, groups };
}

let cache = null;

/** groupOwners() over every Uber Eats store, kept 10 minutes. */
async function ownerIndex(c, { fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.index;
  const stores = await c.restaurants.find({}, { projection: OWNER_FIELDS }).toArray();
  const index = groupOwners(stores);
  cache = { at: Date.now(), index };
  return index;
}

/** The owner group of one store ({ key, uuids }); a group of one when the store is unknown. */
function groupOfStore(index, uuid) {
  return index.groupOf.get(uuid) || { key: `uuid:${uuid}`, uuids: [uuid], via: "uuid" };
}

/** A brand entry for Lead.brands, from an Uber Eats store record. */
function brandOf(s, at = new Date()) {
  const loc = s.location || {};
  return {
    uuid: s.uuid,
    title: s.title,
    url: s.url,
    phone: s.phoneNumber || s.legal?.phone || undefined,
    email: s.email || undefined,
    postalCode: s.postalCode || undefined,
    address: loc.address || [loc.streetAddress, s.postalCode, loc.city].filter(Boolean).join(", ") || undefined,
    registrationNumber: s.registrationNumber || undefined,
    addedAt: at,
  };
}

/** Drops the cached groups (after new stores or new details came in). */
function invalidateOwners() {
  cache = null;
}

module.exports = { groupOwners, ownerIndex, groupOfStore, brandOf, storeKeys, validSiren, invalidateOwners, OWNER_FIELDS, SHARED_CONTACT_LIMIT, ADDRESS_LIMIT };
