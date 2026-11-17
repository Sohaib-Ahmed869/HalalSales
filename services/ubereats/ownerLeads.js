// services/ubereats/ownerLeads.js
//
// The lead side of "one lead per owner" (owner groups: ./owners.js): finding the
// lead an owner already has, telling which of several duplicates has been worked
// the most, and listing more brands on a lead. Used by the assign (./assign.js),
// the AI catalogue hand-off (lead2.controller) and scripts/mergeOwnerLeads.js.
const Lead = require("../../models/Lead");
const { brandOf } = require("./owners");

// How far a lead got: a lead moved on from "new" has been worked.
const STATUS_RANK = { converted: 3, qualified: 2, dead: 1, new: 0 };
// A note typed on the Leads page starts "<ISO date> - First Last: " (lead2.addLeadNote).
const TYPED_NOTE_RE = /(^|\n)\d{4}-\d{2}-\d{2}T[\d:.]+Z - /g;

/**
 * How much an agent has done with a lead, to keep the most worked one when an
 * owner has several: calls / WhatsApp / emails logged, notes typed, tasks,
 * a status beyond "new", an AI hand-off, an agent, a follow-up date.
 * `whatsappMessages` = messages exchanged on the lead's phone, when known.
 */
function activityScore(lead, { whatsappMessages = 0 } = {}) {
  const typedNotes = (String(lead.notes || "").match(TYPED_NOTE_RE) || []).length;
  return (
    (STATUS_RANK[lead.status] || 0) * 10 +
    (lead.contactLog || []).length * 3 +
    Math.min(whatsappMessages, 20) +
    typedNotes * 2 +
    (lead.tasks || []).length * 2 +
    (lead.aiHandoff?.handedOffAt ? 3 : 0) +
    (lead.assignedTo ? 1 : 0) +
    (lead.nextFollowUp ? 1 : 0)
  );
}

/** Most worked first; on a tie the oldest (it was there first, the agent knows it). */
function byActivity(scoreOf = activityScore) {
  return (a, b) => scoreOf(b) - scoreOf(a) || new Date(a.createdAt || 0) - new Date(b.createdAt || 0) || String(a._id).localeCompare(String(b._id));
}

/** Every Uber Eats store a lead stands for (its own store and its brands). */
const leadUuids = (lead) => [...new Set([lead.relatedUberEatsUuid, ...(lead.brands || []).map((b) => b.uuid)].filter(Boolean))];

/**
 * The lead an owner already has: one made from any of the group's stores, or listing one of them
 * as a brand, or with the same owner key. The most worked one when there are several (until
 * scripts/mergeOwnerLeads.js has merged them). null when the owner has none.
 */
async function findOwnerLead(group) {
  const or = [{ relatedUberEatsUuid: { $in: group.uuids } }, { "brands.uuid": { $in: group.uuids } }];
  if (group.key && !group.key.startsWith("uuid:")) or.push({ ownerKey: group.key });
  const leads = await Lead.find({ $or: or })
    .select("fullName company status assignedTo assignedAt brands relatedUberEatsUuid ownerKey createdAt contactLog tasks notes aiHandoff.handedOffAt nextFollowUp")
    .lean();
  return leads.sort(byActivity())[0] || null;
}

/**
 * Lists stores as brands on a lead (each once). A lead made before brands existed gets its own
 * store listed first, so "N brands" counts it. `stores` = ubereats_restaurants records.
 * Also sets the owner key when the lead has none (or only a one-store key).
 */
async function addBrands(c, lead, stores, { ownerKey, at = new Date() } = {}) {
  const listed = new Set((lead.brands || []).map((b) => b.uuid));
  const toAdd = [];
  if (!listed.size && lead.relatedUberEatsUuid && !stores.some((s) => s.uuid === lead.relatedUberEatsUuid)) {
    const own = await c.restaurants.findOne({ uuid: lead.relatedUberEatsUuid }, { projection: { raw: 0, menu: 0, hours: 0, breadcrumbs: 0 } });
    if (own) toAdd.push(brandOf(own, lead.createdAt || at));
  }
  stores.forEach((s) => !listed.has(s.uuid) && !toAdd.some((b) => b.uuid === s.uuid) && toAdd.push(brandOf(s, at)));
  const set = {};
  if (ownerKey && !ownerKey.startsWith("uuid:") && (!lead.ownerKey || lead.ownerKey.startsWith("uuid:"))) set.ownerKey = ownerKey;
  if (!toAdd.length && !Object.keys(set).length) return 0;
  await Lead.updateOne({ _id: lead._id }, { ...(toAdd.length ? { $push: { brands: { $each: toAdd } } } : {}), $set: { ...set, updatedAt: at } });
  return toAdd.length;
}

module.exports = { activityScore, byActivity, findOwnerLead, addBrands, leadUuids, STATUS_RANK };
