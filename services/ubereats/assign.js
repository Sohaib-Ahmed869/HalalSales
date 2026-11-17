// services/ubereats/assign.js
//
// Assign Uber Eats stores to an agent, the same way from every screen (the Uber
// Eats Scraper page and the Sales Map). Like the old Postal Scraping assign:
// each store gets the agent and a Lead on the Leads page (source
// "restaurant_scraping", assigned to the agent, linked to the store by
// relatedUberEatsUuid, with its email, phone, SIRET and address), and the agent
// gets one notification. Skipped, with the reason: a store already assigned, or
// one that already is a customer or a lead (no duplicate lead).
//
// One lead per owner (./owners.js): the lead lists every free brand of the same
// owner (same SIREN, or same phone / email), and those stores are assigned with
// it, so the agent calls the owner once. A store whose owner already has a lead
// is added to that lead and takes its agent, whoever it was assigned to here.
const Lead = require("../../models/Lead");
const User = require("../../models/User");
const Notification = require("../../models/Notification");
const { existingUeMatches, invalidate } = require("../../utils/prospectContext");
const { ownerIndex, groupOfStore, brandOf } = require("./owners");
const { findOwnerLead, addBrands } = require("./ownerLeads");

const agentName = (u) => `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email || "Agent";
const STORE_PROJECTION = { raw: 0, menu: 0, hours: 0, breadcrumbs: 0 };

/**
 * A store assigned from the portal whose lead was deleted on the Leads page is a prospect again:
 * its assignment is moved into assignmentHistory. Mutates the rows. Returns the uuids it released.
 */
async function dropStaleAssignments(c, rows) {
  const assigned = rows.filter((r) => r.assignment?.agentId);
  if (!assigned.length) return [];
  const uuids = assigned.map((r) => r.uuid);
  // A store is on a lead as the store it was made from, or as one of the owner's brands.
  const leads = await Lead.find({ $or: [{ relatedUberEatsUuid: { $in: uuids } }, { "brands.uuid": { $in: uuids } }] })
    .select("relatedUberEatsUuid brands.uuid")
    .lean();
  const alive = new Set(leads.flatMap((l) => [l.relatedUberEatsUuid, ...(l.brands || []).map((b) => b.uuid)]));
  const released = [];
  for (const r of assigned) {
    if (alive.has(r.uuid)) continue;
    await c.restaurants.updateOne(
      { uuid: r.uuid, "assignment.agentId": { $exists: true } },
      { $unset: { assignment: "" }, $push: { assignmentHistory: { ...r.assignment, unassignedAt: new Date(), reason: "lead deleted on the Leads page" } } }
    );
    delete r.assignment;
    released.push(r.uuid);
  }
  return released;
}

/**
 * @param {Object} c - ueCollections()
 * @param {Object} args
 * @param {string[]} args.uuids
 * @param {Object} args.agent - User (lean) the stores go to
 * @param {Object} args.by - the user assigning (req.user)
 * @param {string} [args.priority] - low | medium | high
 * @param {string} [args.source] - where it was done, written in the lead's notes ("the Uber Eats Scraper", "the Sales Map")
 * @param {boolean} [args.notify] - send the agent one notification (default true)
 * @returns {Promise<{ assigned: Array<{uuid, title, leadId, brands}>, grouped: Array<{uuid, title, leadId, reason}>, skipped: Array<{uuid, title, reason}> }>}
 *   assigned = a new lead per owner; grouped = a store put on its owner's lead (new or existing), not a lead of its own.
 */
async function assignStores(c, { uuids, agent, by, priority = "medium", source = "the Uber Eats Scraper", notify = true }) {
  const prio = ["low", "medium", "high"].includes(priority) ? priority : "medium";
  const byId = by?._id || by?.id;
  const byName = by ? agentName(by) : "";
  const now = new Date();

  const stores = await c.restaurants.find({ uuid: { $in: uuids } }, { projection: STORE_PROJECTION }).toArray();
  // A store whose lead was deleted on the Leads page can be assigned again.
  if ((await dropStaleAssignments(c, stores)).length) invalidate();
  const [existing, owners] = await Promise.all([existingUeMatches(), ownerIndex(c)]);
  const byUuid = new Map(stores.map((s) => [s.uuid, s]));
  const assigned = [];
  const grouped = [];
  const skipped = [];
  // The owner's other brands put on a lead made during this call (they may be in `uuids` too).
  const doneHere = new Set();
  for (const uuid of uuids) {
    const s = byUuid.get(uuid);
    if (!s) {
      skipped.push({ uuid, title: "", reason: "not found" });
      continue;
    }
    // Already listed in `grouped` when its owner's lead was made a moment ago.
    if (doneHere.has(uuid)) continue;
    if (s.assignment?.agentId) {
      skipped.push({ uuid, title: s.title, reason: `already assigned to ${s.assignment.agentName || "an agent"}` });
      continue;
    }
    const group = groupOfStore(owners, uuid);

    // The owner already has a lead: this brand joins it, with that lead's agent.
    const ownerLead = await findOwnerLead(group);
    if (ownerLead) {
      const r = await joinOwnerLead(c, { s, lead: ownerLead, group, agent, byId, byName, prio, now });
      if (r.skipped) skipped.push({ uuid, title: s.title, reason: r.skipped });
      else grouped.push({ uuid, title: s.title, leadId: String(ownerLead._id), reason: r.reason });
      continue;
    }

    const ex = existing.get(uuid);
    if (ex) {
      const owner = ex.ownerName ? `, assigned to ${ex.ownerName}` : "";
      skipped.push({
        uuid,
        title: s.title,
        reason: ex.type === "customer" ? `already a customer: ${ex.name} (same ${ex.via}${owner})` : `already a lead: ${ex.name}${ex.via === "assigned" ? "" : ` (same ${ex.via})`}${owner}`,
      });
      continue;
    }
    // One brand of this owner already buys from us: the owner is a customer, not a prospect.
    const customerBrand = group.uuids.map((u) => existing.get(u)).find((m) => m?.type === "customer");
    if (customerBrand) {
      skipped.push({ uuid, title: s.title, reason: `same owner as customer ${customerBrand.name}${customerBrand.ownerName ? `, assigned to ${customerBrand.ownerName}` : ""}` });
      continue;
    }

    // Claim the store first, so two people assigning at once never make two leads.
    const assignment = { agentId: agent._id, agentName: agentName(agent), assignedBy: byId, assignedByName: byName, assignedAt: now, priority: prio };
    const claim = await c.restaurants.updateOne({ uuid, "assignment.agentId": { $exists: false } }, { $set: { assignment } });
    if (!claim.modifiedCount) {
      skipped.push({ uuid, title: s.title, reason: "already assigned" });
      continue;
    }
    // The owner's other free brands come with it (not assigned, not a customer or a lead of their own).
    const siblings = [];
    const others = group.uuids.filter((u) => u !== uuid && !existing.get(u));
    if (others.length) {
      const docs = await c.restaurants.find({ uuid: { $in: others }, "assignment.agentId": { $exists: false } }, { projection: STORE_PROJECTION }).sort({ title: 1 }).toArray();
      for (const o of docs) {
        const got = await c.restaurants.updateOne({ uuid: o.uuid, "assignment.agentId": { $exists: false } }, { $set: { assignment: { ...assignment, grouped: true } } });
        if (got.modifiedCount) siblings.push(o);
      }
    }
    const claimed = [uuid, ...siblings.map((o) => o.uuid)];
    try {
      const lead = await Lead.create(newLead({ s, siblings, group, agent, source, now, byName, prio }));
      await c.restaurants.updateMany({ uuid: { $in: claimed } }, { $set: { "assignment.leadId": lead._id } });
      assigned.push({ uuid, title: s.title, leadId: String(lead._id), brands: claimed.length });
      siblings.forEach((o) => {
        grouped.push({ uuid: o.uuid, title: o.title, leadId: String(lead._id), reason: `same owner as ${s.title}: on the same lead` });
        doneHere.add(o.uuid);
      });
    } catch (error) {
      await c.restaurants.updateMany({ uuid: { $in: claimed } }, { $unset: { assignment: "" } });
      skipped.push({ uuid, title: s.title, reason: `could not create the lead: ${error.message}` });
    }
  }
  if (notify && assigned.length > 0 && byId) await notifyAgent(agent, byId, assigned.length);
  return { assigned, grouped, skipped };
}

/** The Lead for a store and the owner's other brands that come with it. */
function newLead({ s, siblings, group, agent, source, now, byName, prio }) {
  const loc = s.location || {};
  const address = loc.address || [loc.streetAddress, s.postalCode, loc.city].filter(Boolean).join(", ");
  const phone = s.phoneNumber || s.legal?.phone || "";
  const sameOwner = group.key.startsWith("siren:") ? `SIREN ${group.key.slice(6)}` : `same ${group.via === "addr" ? "address" : group.via}`;
  return {
    fullName: s.title,
    company: s.title,
    email: s.email || "",
    phoneNumber: phone,
    status: "new",
    tags: ["warm"],
    assignedTo: agent._id,
    sourceType: "restaurant_scraping",
    relatedUberEatsUuid: s.uuid,
    ownerKey: group.key.startsWith("uuid:") ? undefined : group.key,
    brands: [s, ...siblings].map((x) => brandOf(x, now)),
    restaurantData: {
      name: s.title,
      postalCode: s.postalCode || "",
      menuItemsCount: s.menuItemCount || 0,
      contactInfo: { email: s.email || "", phone, address },
      url: s.url,
      registrationNumber: s.registrationNumber || undefined,
      registry: s.legal?.registry || undefined,
    },
    notes: [
      `Assigned from ${source} on ${now.toISOString().slice(0, 10)}${byName ? ` by ${byName}` : ""}. Priority: ${prio}.`,
      `Located in ${s.postalCode || "?"}${loc.city ? ` (${loc.city})` : ""}.`,
      (s.categories || []).length ? `Cuisine: ${s.categories.slice(0, 4).join(", ")}.` : "",
      s.rating?.value ? `Uber Eats rating ${s.rating.value}${s.rating.count ? ` (${s.rating.count})` : ""}.` : "",
      s.registrationNumber ? `Registration: ${s.registrationNumber}.` : "",
      siblings.length ? `Same owner (${sameOwner}) also runs on Uber Eats: ${siblings.map((o) => o.title).join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

/**
 * Puts a store on the lead its owner already has. The store takes that lead's agent (the
 * agent picked for this assign only when the lead has nobody). A converted or dead lead is
 * left alone: the owner is already a customer, or said no.
 */
async function joinOwnerLead(c, { s, lead, group, agent, byId, byName, prio, now }) {
  const name = lead.company || lead.fullName;
  if (lead.status === "converted" || lead.status === "dead") return { skipped: `same owner as lead ${name} (${lead.status})` };
  let owner = agent;
  if (lead.assignedTo && String(lead.assignedTo) !== String(agent._id)) {
    owner = (await User.findById(lead.assignedTo).select("firstName lastName email").lean()) || { _id: lead.assignedTo };
  }
  const assignment = { agentId: owner._id, agentName: agentName(owner), assignedBy: byId, assignedByName: byName, assignedAt: now, priority: prio, leadId: lead._id, grouped: true };
  const claim = await c.restaurants.updateOne({ uuid: s.uuid, "assignment.agentId": { $exists: false } }, { $set: { assignment } });
  if (!claim.modifiedCount) return { skipped: "already assigned" };
  await addBrands(c, lead, [s], { ownerKey: group.key, at: now });
  if (!lead.assignedTo) await Lead.updateOne({ _id: lead._id }, { $set: { assignedTo: agent._id } });
  const other = String(owner._id) !== String(agent._id) ? `, which stays with ${agentName(owner)}` : "";
  return { reason: `same owner as lead ${name}: added to that lead${other}` };
}

/** One notification to the agent, same wording as the old Postal Scraping assign (kind "auto" = auto-assign). */
async function notifyAgent(agent, byId, count, kind = "manual") {
  const auto = kind === "auto";
  try {
    await Notification.create({
      recipient: agent._id,
      sender: byId,
      type: "restaurant_assigned",
      title: auto ? "New Restaurants Auto-Assigned" : "New Restaurants Assigned",
      message: `${count} restaurant${count > 1 ? "s have" : " has"} been ${auto ? "auto-assigned" : "assigned"} to you. Please go to the Leads Management screen to view and manage these leads.`,
    });
  } catch (error) {
    console.warn("[assign] notification failed:", error.message);
  }
}

module.exports = { assignStores, dropStaleAssignments, notifyAgent, agentName };
