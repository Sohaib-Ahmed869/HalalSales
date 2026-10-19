// services/ubereats/assign.js
//
// Assign Uber Eats stores to an agent, the same way from every screen (the Uber
// Eats Scraper page and the Sales Map). Like the old Postal Scraping assign:
// each store gets the agent and a Lead on the Leads page (source
// "restaurant_scraping", assigned to the agent, linked to the store by
// relatedUberEatsUuid, with its email, phone, SIRET and address), and the agent
// gets one notification. Skipped, with the reason: a store already assigned, or
// one that already is a customer or a lead (no duplicate lead).
const Lead = require("../../models/Lead");
const Notification = require("../../models/Notification");
const { existingUeMatches, invalidate } = require("../../utils/prospectContext");

const agentName = (u) => `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email || "Agent";

/**
 * A store assigned from the portal whose lead was deleted on the Leads page is a prospect again:
 * its assignment is moved into assignmentHistory. Mutates the rows. Returns the uuids it released.
 */
async function dropStaleAssignments(c, rows) {
  const assigned = rows.filter((r) => r.assignment?.agentId);
  if (!assigned.length) return [];
  const leads = await Lead.find({ relatedUberEatsUuid: { $in: assigned.map((r) => r.uuid) } }).select("relatedUberEatsUuid").lean();
  const alive = new Set(leads.map((l) => l.relatedUberEatsUuid));
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
 * @returns {Promise<{ assigned: Array<{uuid, title, leadId}>, skipped: Array<{uuid, title, reason}> }>}
 */
async function assignStores(c, { uuids, agent, by, priority = "medium", source = "the Uber Eats Scraper", notify = true }) {
  const prio = ["low", "medium", "high"].includes(priority) ? priority : "medium";
  const byId = by?._id || by?.id;
  const byName = by ? agentName(by) : "";
  const now = new Date();

  const stores = await c.restaurants.find({ uuid: { $in: uuids } }, { projection: { raw: 0, menu: 0, hours: 0, breadcrumbs: 0 } }).toArray();
  // A store whose lead was deleted on the Leads page can be assigned again.
  if ((await dropStaleAssignments(c, stores)).length) invalidate();
  const existing = await existingUeMatches();
  const byUuid = new Map(stores.map((s) => [s.uuid, s]));
  const assigned = [];
  const skipped = [];
  for (const uuid of uuids) {
    const s = byUuid.get(uuid);
    if (!s) {
      skipped.push({ uuid, title: "", reason: "not found" });
      continue;
    }
    if (s.assignment?.agentId) {
      skipped.push({ uuid, title: s.title, reason: `already assigned to ${s.assignment.agentName || "an agent"}` });
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
    // Claim the store first, so two people assigning at once never make two leads.
    const assignment = { agentId: agent._id, agentName: agentName(agent), assignedBy: byId, assignedByName: byName, assignedAt: now, priority: prio };
    const claim = await c.restaurants.updateOne({ uuid, "assignment.agentId": { $exists: false } }, { $set: { assignment } });
    if (!claim.modifiedCount) {
      skipped.push({ uuid, title: s.title, reason: "already assigned" });
      continue;
    }
    try {
      const loc = s.location || {};
      const address = loc.address || [loc.streetAddress, s.postalCode, loc.city].filter(Boolean).join(", ");
      const phone = s.phoneNumber || s.legal?.phone || "";
      const lead = await Lead.create({
        fullName: s.title,
        company: s.title,
        email: s.email || "",
        phoneNumber: phone,
        status: "new",
        tags: ["warm"],
        assignedTo: agent._id,
        sourceType: "restaurant_scraping",
        relatedUberEatsUuid: uuid,
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
        ]
          .filter(Boolean)
          .join("\n"),
      });
      await c.restaurants.updateOne({ uuid }, { $set: { "assignment.leadId": lead._id } });
      assigned.push({ uuid, title: s.title, leadId: String(lead._id) });
    } catch (error) {
      await c.restaurants.updateOne({ uuid }, { $unset: { assignment: "" } });
      skipped.push({ uuid, title: s.title, reason: `could not create the lead: ${error.message}` });
    }
  }
  if (notify && assigned.length > 0 && byId) await notifyAgent(agent, byId, assigned.length);
  return { assigned, skipped };
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
