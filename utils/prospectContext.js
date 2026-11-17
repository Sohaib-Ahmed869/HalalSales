// utils/prospectContext.js
//
// What the Sales Map and the Uber Eats Scraper page need to tell whether a
// scraped store already is a customer or a lead (rules in prospectMatch.js):
//   - matchContext(): every customer and lead indexed, plus the phones / emails
//     each scraped source shares between several records (kept 10 minutes);
//   - existingUeMatches(): for every Uber Eats store, the customer or lead it
//     already is. Stores assigned to an agent from the scraper page are linked
//     to their lead directly (Lead.relatedUberEatsUuid), always up to date;
//     the rest is matched by phone, email, name and address, recomputed every
//     10 minutes. Brands sharing a kitchen are judged one by one: a customer at
//     the same address hides only the brand that is that customer. Once an
//     owner has a lead, though, all of that owner's brands (same SIREN, or same
//     phone / email; services/ubereats/owners.js) are that lead.
const SalesLead = require("../models/SalesLead");
const User = require("../models/User");
const { ScrapedRestaurant } = require("../models/ScrapedRestaurant");
const { ueCollections } = require("./ubereatsDb");
const { uuidToStoreId } = require("../services/ubereats/parse");
const { ownerIndex, invalidateOwners } = require("../services/ubereats/owners");
const pm = require("./prospectMatch");

const TTL_MS = 10 * 60 * 1000;
let contextCache = null;
let matchesCache = null;

// Phones / emails each source shares between several records (one kitchen's
// brands, or junk copied onto hundreds of old records): never proof on their own.
async function sourceContacts() {
  const out = { ue: { phones: new Map(), emails: new Map() }, old: { phones: new Map(), emails: new Map() }, ueStoreIds: new Set(), ueAvailable: false };
  try {
    const c = await ueCollections();
    const stores = await c.restaurants.find({}, { projection: { _id: 0, uuid: 1, phoneNumber: 1, "legal.phone": 1, email: 1 } }).toArray();
    out.ue = pm.storeContactCounts(stores);
    stores.forEach((s) => s.uuid && out.ueStoreIds.add(uuidToStoreId(s.uuid)));
    out.ueAvailable = true;
  } catch (error) {
    console.warn("[prospects] Uber Eats stores unavailable:", error.message);
  }
  const counts = async (field, norm, into) => {
    const rows = await ScrapedRestaurant.aggregate([{ $group: { _id: `$${field}`, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]);
    rows.forEach((r) => {
      const k = norm(r._id);
      if (k) into.set(k, (into.get(k) || 0) + r.n);
    });
  };
  await Promise.all([counts("contact_info.phone", pm.normPhone, out.old.phones), counts("contact_info.email", pm.normEmail, out.old.emails)]);
  return out;
}

/** { index, shared } for matching prospects, kept 10 minutes; null when it can't be built. */
async function matchContext() {
  if (contextCache && Date.now() - contextCache.at < TTL_MS) return contextCache.ctx;
  try {
    const [index, shared] = await Promise.all([pm.buildIndex({ fresh: true }), sourceContacts()]);
    const ctx = { index, shared };
    contextCache = { at: Date.now(), ctx };
    return ctx;
  } catch (error) {
    console.error("[prospects] matching unavailable:", error.message);
    return null;
  }
}

const MATCH_FIELDS = { _id: 0, uuid: 1, title: 1, postalCode: 1, addressKey: 1, phoneNumber: 1, email: 1, "legal.phone": 1, "legal.name": 1 };

/**
 * Leads made from Uber Eats stores (assigned from the scraper page): uuid -> { type, id, name, via, agentId }.
 * A lead covers its own store and every brand of the same owner listed on it (Lead.brands).
 */
async function linkedLeads(uuids = null) {
  const query = uuids
    ? { $or: [{ relatedUberEatsUuid: { $in: uuids } }, { "brands.uuid": { $in: uuids } }] }
    : { $or: [{ relatedUberEatsUuid: { $exists: true, $ne: null } }, { "brands.0": { $exists: true } }] };
  const leads = await SalesLead.find(query).select("fullName company status assignedTo relatedUberEatsUuid brands.uuid").lean();
  const wanted = uuids ? new Set(uuids) : null;
  const out = new Map();
  leads.forEach((l) => {
    const link = { type: "lead", id: String(l._id), name: l.company || l.fullName, status: l.status || "new", via: "assigned", agentId: l.assignedTo ? String(l.assignedTo) : null, ownerId: l.assignedTo ? String(l.assignedTo) : null };
    [l.relatedUberEatsUuid, ...(l.brands || []).map((b) => b.uuid)].filter(Boolean).forEach((u) => (!wanted || wanted.has(u)) && out.set(u, link));
  });
  return out;
}

/**
 * The other brands of an owner who already has a lead: the same lead, via "same owner". So the
 * scraper page and the Sales Map never offer them as new prospects (their owner is being called).
 */
async function ownerSiblings(linked) {
  if (!linked.size) return new Map();
  let index;
  try {
    index = await ownerIndex(await ueCollections());
  } catch (error) {
    console.warn("[prospects] owner groups unavailable:", error.message);
    return new Map();
  }
  const out = new Map();
  linked.forEach((link, uuid) => {
    const group = index.groupOf.get(uuid);
    if (!group || group.uuids.length < 2) return;
    group.uuids.forEach((u) => !linked.has(u) && !out.has(u) && out.set(u, { ...link, via: "same owner" }));
  });
  return out;
}

/**
 * uuid -> { type: "customer" | "lead", id, name, via } for every Uber Eats store
 * that already is a customer or a lead. Empty map when matching is unavailable.
 */
async function existingUeMatches() {
  let matched = matchesCache && Date.now() - matchesCache.at < TTL_MS ? matchesCache.map : null;
  if (!matched) {
    matched = new Map();
    const ctx = await matchContext();
    if (ctx?.shared.ueAvailable) {
      const c = await ueCollections();
      const stores = await c.restaurants.find({}, { projection: MATCH_FIELDS }).toArray();
      stores.forEach((s) => {
        const { same } = pm.matchProspect(pm.ueProspectKeys(s), ctx.index, ctx.shared.ue);
        if (same) matched.set(s.uuid, same);
      });
    }
    matchesCache = { at: Date.now(), map: matched };
  }
  // The direct links always win and are always fresh.
  const linked = await linkedLeads();
  const out = new Map(matched);
  // A matched lead deleted since the last matching no longer hides its store; the others get their
  // current owner (a lead can be reassigned at any time).
  const leadIds = [...new Set([...out.values()].filter((m) => m.type === "lead").map((m) => m.id))];
  if (leadIds.length) {
    const alive = new Map((await SalesLead.find({ _id: { $in: leadIds } }).select("assignedTo").lean()).map((l) => [String(l._id), l.assignedTo ? String(l.assignedTo) : null]));
    out.forEach((m, uuid) => {
      if (m.type !== "lead") return;
      if (!alive.has(m.id)) out.delete(uuid);
      else out.set(uuid, { ...m, ownerId: alive.get(m.id) });
    });
  }
  // A brand whose owner already has a lead is that lead; a direct link still wins.
  (await ownerSiblings(linked)).forEach((v, uuid) => out.set(uuid, v));
  linked.forEach((v, uuid) => out.set(uuid, v));
  return withOwnerNames(out);
}

// ---------- who a customer / lead is assigned to ----------

const nameCache = new Map(); // userId -> { at, name }

/** userId -> "First Last" for the given ids (kept 10 minutes). */
async function ownerNames(ids) {
  const want = [...new Set(ids.filter(Boolean).map(String))];
  const missing = want.filter((id) => !(nameCache.get(id) && Date.now() - nameCache.get(id).at < TTL_MS));
  if (missing.length) {
    const users = await User.find({ _id: { $in: missing } }).select("firstName lastName email").lean();
    const found = new Map(users.map((u) => [String(u._id), `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email || "an agent"]));
    missing.forEach((id) => nameCache.set(id, { at: Date.now(), name: found.get(id) || null }));
  }
  return new Map(want.map((id) => [id, nameCache.get(id)?.name || null]));
}

/** Copies of the matches with ownerName ("assigned to …"); a Map in -> a Map out, an array in -> an array out. */
async function withOwnerNames(matches) {
  const list = matches instanceof Map ? [...matches.values()] : matches;
  const names = await ownerNames(list.map((m) => m && m.ownerId));
  const add = (m) => (m ? { ...m, ownerName: m.ownerId ? names.get(String(m.ownerId)) || null : null } : m);
  if (matches instanceof Map) return new Map([...matches].map(([k, m]) => [k, add(m)]));
  return list.map(add);
}

/** The owner of a customer / lead found by matching (related entries carry no owner of their own). */
async function ownerOfCandidate(type, id) {
  const ctx = await matchContext();
  if (!ctx) return null;
  if (!ctx.byKey) ctx.byKey = new Map(ctx.index.candidates.map((c) => [`${c.type}:${c.id}`, c]));
  return ctx.byKey.get(`${type}:${id}`)?.ownerId || null;
}

/** After customers / leads change (an assign): match again on the next request. */
function invalidate() {
  contextCache = null;
  matchesCache = null;
  invalidateOwners();
  pm._reset();
}

module.exports = { matchContext, existingUeMatches, linkedLeads, invalidate, ownerNames, withOwnerNames, ownerOfCandidate, MATCH_FIELDS };
