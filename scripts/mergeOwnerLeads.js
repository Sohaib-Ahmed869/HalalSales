// One-off: one lead per owner. Merges the leads that were made, one per Uber
// Eats brand, for brands of the same owner (same SIREN, or same phone / email,
// or the same address between stores without a SIREN: services/ubereats/owners.js).
//
// For each owner with several leads, the lead the agents worked the most is kept
// (calls / WhatsApp / emails logged, typed notes, tasks, a status beyond "new",
// an AI hand-off, an agent, a follow-up date; ties go to the oldest). The others
// are merged into it and kept, marked mergedInto (never deleted), so they vanish
// from every list (models/plugins/hideMergedLeads.js) but their history stays:
//   - the kept lead lists every brand (Lead.brands) and the merged leads (mergedLeads);
//   - call log, tasks (Task.leadId moved too), tags and notes are copied onto it;
//     missing email / phone / agent / follow-up / AI hand-off are taken from the others;
//   - its status becomes the furthest one reached (converted > qualified > dead > new);
//   - the merged leads' Uber Eats stores point at the kept lead and its agent (the
//     owner's lead keeps its assignment; the old one goes into assignmentHistory).
// Every lead made from a store also gets its own store listed as a brand, so the
// Leads page can say "N brands".
//
// Idempotent: merged leads are hidden from the next run, brands are listed once.
//
// Usage:
//   node scripts/mergeOwnerLeads.js                    dry run: data counts and the plan, nothing written
//   node scripts/mergeOwnerLeads.js --verbose          dry run, every merge listed
//   node scripts/mergeOwnerLeads.js --apply            merge
//   node scripts/mergeOwnerLeads.js --apply --attach-brands
//       also lists the owner's other free brands (not assigned, not a customer or a
//       lead of their own) on each lead and assigns them to its agent
require("dotenv").config();
const mongoose = require("mongoose");
const Lead = require("../models/Lead");
const Task = require("../models/Task");
const User = require("../models/User");
const WhatsAppMessage = require("../models/WhatsAppMessage");
const { ueCollections } = require("../utils/ubereatsDb");
const { existingUeMatches } = require("../utils/prospectContext");
const { groupOwners, storeKeys, brandOf, validSiren, OWNER_FIELDS, SHARED_CONTACT_LIMIT, ADDRESS_LIMIT } = require("../services/ubereats/owners");
const { activityScore, byActivity, leadUuids, STATUS_RANK } = require("../services/ubereats/ownerLeads");

const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");
const ATTACH = process.argv.includes("--attach-brands");
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/salesHalal";
const STORE_PROJECTION = { raw: 0, menu: 0, hours: 0, breadcrumbs: 0 };

const agentName = (u) => (u ? `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.email || "Agent" : "nobody");
const nameOf = (l) => l.company || l.fullName || String(l._id);
const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

// WhatsApp conversation ids for a phone, as lead2.controller's conversationIdsFor builds them.
function conversationIds(phones) {
  const ids = new Set();
  for (const raw of phones) {
    if (!raw) continue;
    let d = String(raw).replace(/\D/g, "");
    if (d.startsWith("00")) d = d.slice(2);
    if (d.length === 10 && d.startsWith("0")) d = `33${d.slice(1)}`;
    else if (d.length === 9) d = `33${d}`;
    if (d.length < 8) continue;
    ids.add(`+${d}`);
    ids.add(d);
  }
  return [...ids];
}

/** How the stores split by owner key: what decides if the address fallback is safe. */
function printDistribution(stores, index) {
  const keys = stores.map(storeKeys);
  const withSiren = keys.filter((k) => k.siren).length;
  const sirens = new Set(keys.map((k) => k.siren).filter(Boolean));
  const noSiren = keys.filter((k) => !k.siren);
  const sirensAt = new Map();
  const storesAt = new Map();
  stores.forEach((s, i) => {
    const a = keys[i].address;
    if (!a) return;
    storesAt.set(a, (storesAt.get(a) || 0) + 1);
    if (keys[i].siren) (sirensAt.get(a) || sirensAt.set(a, new Set()).get(a)).add(keys[i].siren);
  });
  const sharedKitchens = [...sirensAt.entries()].filter(([, set]) => set.size > 1);
  const contactSirens = (valuesOf) => {
    const by = new Map();
    keys.forEach((k) => valuesOf(k).forEach((v) => (by.get(v) || by.set(v, { n: 0, sirens: new Set() }).get(v)) && (by.get(v).n++, k.siren && by.get(v).sirens.add(k.siren))));
    const used = [...by.values()].filter((x) => x.n > 1);
    return { shared: used.length, manySirens: used.filter((x) => x.sirens.size > 1).length, tooMany: used.filter((x) => x.n > SHARED_CONTACT_LIMIT).length };
  };
  const phones = contactSirens((k) => k.phones);
  const emails = contactSirens((k) => (k.email ? [k.email] : []));
  const multi = index.groups.filter((g) => g.uuids.length > 1);
  const byVia = new Map();
  multi.forEach((g) => {
    const v = byVia.get(g.via) || { groups: 0, stores: 0 };
    v.groups++;
    v.stores += g.uuids.length;
    byVia.set(g.via, v);
  });
  const bad = stores.filter((s) => s.registrationNumber && !validSiren(String(s.registrationNumber).replace(/\D/g, "").slice(0, 9))).length;

  console.log("== Uber Eats stores ==");
  console.log(`  stores: ${stores.length}`);
  console.log(`  with a valid SIREN: ${withSiren} (${sirens.size} distinct SIRENs); registration number that is not a valid SIREN/SIRET: ${bad}`);
  console.log(`  without a SIREN: ${noSiren.length} (with a phone ${noSiren.filter((k) => k.phones.length).length}, an email ${noSiren.filter((k) => k.email).length}, a numbered address only ${noSiren.filter((k) => !k.phones.length && !k.email && k.address).length})`);
  console.log(`  phones on 2+ stores: ${phones.shared} (ignored: ${phones.manySirens} used by 2+ SIRENs, ${phones.tooMany} on more than ${SHARED_CONTACT_LIMIT} stores)`);
  console.log(`  emails on 2+ stores: ${emails.shared} (ignored: ${emails.manySirens} used by 2+ SIRENs, ${emails.tooMany} on more than ${SHARED_CONTACT_LIMIT} stores)`);
  console.log(`  addresses with 2+ stores: ${[...storesAt.values()].filter((n) => n > 1).length}; of which shared kitchens (2+ SIRENs): ${sharedKitchens.length}; more than ${ADDRESS_LIMIT} stores: ${[...storesAt.values()].filter((n) => n > ADDRESS_LIMIT).length}`);
  top(new Map(sharedKitchens.map(([a, set]) => [a, set.size])), 5).forEach(([a, n]) => console.log(`    shared kitchen: ${a} (${n} SIRENs, ${storesAt.get(a)} stores)`));
  console.log("== Owners ==");
  console.log(`  owners: ${index.groups.length}; with 2+ brands: ${multi.length} (${multi.reduce((n, g) => n + g.uuids.length, 0)} stores)`);
  byVia.forEach((v, via) => console.log(`    grouped by ${via}: ${v.groups} owners, ${v.stores} stores`));
  const titles = new Map(stores.map((s) => [s.uuid, s.title]));
  [...multi]
    .sort((a, b) => b.uuids.length - a.uuids.length)
    .slice(0, 10)
    .forEach((g) => console.log(`    biggest: ${g.key} ${g.uuids.length} brands: ${g.uuids.slice(0, 5).map((u) => titles.get(u)).join(", ")}${g.uuids.length > 5 ? ", ..." : ""}`));
}

async function main() {
  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection;
  console.log(`Connected to ${db.host}/${db.name}. Mode: ${APPLY ? "APPLY (writing)" : "DRY RUN (nothing is written)"}${ATTACH ? ", attaching free brands" : ""}\n`);

  const c = await ueCollections();
  const stores = await c.restaurants.find({}, { projection: { ...OWNER_FIELDS, title: 1 } }).toArray();
  const index = groupOwners(stores);
  printDistribution(stores, index);

  // Every lead made from an Uber Eats store (merged ones are hidden, so a second run skips them).
  const leads = await Lead.find({ $or: [{ relatedUberEatsUuid: { $exists: true, $ne: null } }, { "brands.0": { $exists: true } }] }).lean();
  const byOwner = new Map();
  let unknownStore = 0;
  for (const l of leads) {
    const uuids = leadUuids(l);
    const group = uuids.map((u) => index.groupOf.get(u)).find(Boolean);
    let key = group?.key;
    if (!key) {
      // Its store is no longer in the scraper's data: its own SIRET, else it stays on its own.
      unknownStore++;
      const siren = validSiren(String(l.restaurantData?.registrationNumber || "").replace(/\D/g, "").slice(0, 9));
      key = siren ? `siren:${siren}` : `lead:${l._id}`;
    }
    (byOwner.get(key) || byOwner.set(key, []).get(key)).push(l);
  }
  const dupes = [...byOwner.entries()].filter(([, list]) => list.length > 1);
  console.log("\n== Leads ==");
  console.log(`  leads made from Uber Eats stores: ${leads.length} (store no longer scraped: ${unknownStore})`);
  console.log(`  owners with several leads: ${dupes.length}; leads to merge into another: ${dupes.reduce((n, [, l]) => n + l.length - 1, 0)}`);

  const agents = new Map((await User.find({ role: { $in: ["sales_agent", "sales_manager", "admin"] } }).select("firstName lastName email").lean()).map((u) => [String(u._id), u]));
  const counts = { merged: 0, kept: 0, otherAgent: 0, tasksMoved: 0, storesMoved: 0, brandsListed: 0, brandsAttached: 0 };
  const now = new Date();

  for (const [i, [key, list]] of dupes.entries()) {
    // WhatsApp messages on each lead's phone count as activity too.
    const wa = new Map();
    for (const l of list) {
      const ids = conversationIds([l.phoneNumber]);
      wa.set(String(l._id), ids.length ? await WhatsAppMessage.countDocuments({ conversationId: { $in: ids } }) : 0);
    }
    const scoreOf = (l) => activityScore(l, { whatsappMessages: wa.get(String(l._id)) });
    const [keep, ...others] = [...list].sort(byActivity(scoreOf));
    counts.kept++;
    counts.merged += others.length;
    const keepAgent = keep.assignedTo || others.find((o) => o.assignedTo)?.assignedTo || null;
    others.forEach((o) => o.assignedTo && keepAgent && String(o.assignedTo) !== String(keepAgent) && counts.otherAgent++);
    if (VERBOSE || i < 20) {
      console.log(`  ${key}: keep "${nameOf(keep)}" (${keep.status}, ${agentName(agents.get(String(keep.assignedTo)))}, score ${scoreOf(keep)})`);
      others.forEach((o) => console.log(`      merge "${nameOf(o)}" (${o.status}, ${agentName(agents.get(String(o.assignedTo)))}, score ${scoreOf(o)})`));
    }
    if (APPLY) await merge(c, keep, others, { key, keepAgent, agents, now, counts });
  }
  if (dupes.length > 20 && !VERBOSE) console.log(`  ... ${dupes.length - 20} more owners (--verbose lists them all)`);

  // Every remaining lead lists its own store (and, with --attach-brands, the owner's free brands).
  const singles = [...byOwner.entries()].filter(([, list]) => list.length === 1);
  // Free brands = not a customer, and not a lead other than this one (same matching as the assign).
  const existing = ATTACH ? await existingUeMatches() : new Map();
  let needBrands = 0;
  for (const [key, [l]] of singles) {
    const missing = leadUuids(l).filter((u) => !(l.brands || []).some((b) => b.uuid === u));
    const group = index.groupOf.get(leadUuids(l)[0]);
    const ownerIsCustomer = group && group.uuids.some((u) => existing.get(u)?.type === "customer");
    const free =
      ATTACH && group && !ownerIsCustomer && !["converted", "dead"].includes(l.status)
        ? group.uuids.filter((u) => !leadUuids(l).includes(u) && (!existing.get(u) || existing.get(u).id === String(l._id)))
        : [];
    if (!missing.length && !free.length && (l.ownerKey || key.startsWith("lead:") || key.startsWith("uuid:"))) continue;
    needBrands++;
    if (APPLY) await listBrands(c, l, { key, missing, free, agents, now, counts });
  }
  console.log(`  other leads to complete (own store as a brand${ATTACH ? ", the owner's free brands" : ""}, owner key): ${needBrands}`);

  console.log("\n== Result ==");
  console.log(`  owners with duplicates: ${counts.kept}; leads ${APPLY ? "merged" : "to merge"}: ${counts.merged}; of which assigned to another agent than the kept lead: ${counts.otherAgent}`);
  if (APPLY) {
    console.log(`  tasks moved: ${counts.tasksMoved}; Uber Eats stores moved to the kept lead: ${counts.storesMoved}`);
    console.log(`  brands listed: ${counts.brandsListed}; free brands attached: ${counts.brandsAttached}`);
  } else console.log("  Dry run: nothing written. Run again with --apply to merge.");
  await mongoose.disconnect();
}

/** Merges `others` into `keep` (see the top of this file). */
async function merge(c, keep, others, { key, keepAgent, agents, now, counts }) {
  const all = [keep, ...others];
  const uuids = [...new Set(all.flatMap(leadUuids))];
  const storeDocs = await c.restaurants.find({ uuid: { $in: uuids } }, { projection: STORE_PROJECTION }).toArray();
  const storeOf = new Map(storeDocs.map((s) => [s.uuid, s]));
  const brands = [...(keep.brands || [])];
  const listed = new Set(brands.map((b) => b.uuid));
  for (const l of all) {
    for (const u of leadUuids(l)) {
      if (listed.has(u)) continue;
      listed.add(u);
      const fromLead = (l.brands || []).find((b) => b.uuid === u);
      const s = storeOf.get(u);
      // A store no longer scraped keeps what the lead knew about it.
      brands.push(fromLead || (s ? brandOf(s, l.createdAt || now) : { uuid: u, title: l.restaurantData?.name || nameOf(l), url: l.restaurantData?.url, addedAt: l.createdAt || now }));
      counts.brandsListed++;
    }
  }
  const status = all.map((l) => l.status || "new").sort((a, b) => (STATUS_RANK[b] || 0) - (STATUS_RANK[a] || 0))[0];
  const contactLog = all.flatMap((l) => l.contactLog || []).sort((a, b) => new Date(a.at) - new Date(b.at));
  const last = contactLog[contactLog.length - 1];
  const tasks = [...new Map(all.flatMap((l) => l.tasks || []).map((t) => [String(t), t])).values()];
  const pick = (field) => keep[field] || others.map((o) => o[field]).find(Boolean);
  const followUps = all.map((l) => l.nextFollowUp).filter(Boolean).sort((a, b) => new Date(a) - new Date(b));
  const notes = [
    keep.notes || "",
    ...others.map((o) => `--- Merged from lead "${nameOf(o)}" (${o._id}, same owner) on ${now.toISOString().slice(0, 10)} ---${o.notes ? `\n${o.notes}` : ""}`),
  ]
    .filter(Boolean)
    .join("\n\n");

  await Lead.updateOne(
    { _id: keep._id },
    {
      $set: {
        brands,
        ownerKey: key.startsWith("lead:") ? keep.ownerKey : key,
        status,
        tags: [...new Set(all.flatMap((l) => l.tags || []))],
        tasks,
        contactLog,
        ...(last ? { lastContactAt: last.at, lastContactOutcome: last.outcome } : {}),
        notes,
        ...(keepAgent ? { assignedTo: keepAgent } : {}),
        ...(pick("assignedAt") ? { assignedAt: pick("assignedAt") } : {}),
        ...(keep.nextFollowUp || followUps[0] ? { nextFollowUp: keep.nextFollowUp || followUps[0] } : {}),
        ...Object.fromEntries(["email", "phoneNumber", "company", "sapCardCode", "existingCustomer", "aiHandoff"].map((f) => [f, pick(f)]).filter(([, v]) => v)),
        updatedAt: now,
      },
      $push: {
        mergedLeads: {
          $each: others.map((o) => ({ leadId: o._id, name: nameOf(o), status: o.status, assignedTo: o.assignedTo, mergedAt: now, reason: `same owner (${key})` })),
        },
      },
    }
  );
  await Lead.updateMany({ _id: { $in: others.map((o) => o._id) } }, { $set: { mergedInto: keep._id, mergedAt: now } });
  const moved = await Task.updateMany({ leadId: { $in: others.map((o) => o._id) } }, { $set: { leadId: keep._id } });

  counts.tasksMoved += moved.modifiedCount || 0;

  // The merged leads' stores now belong to the owner's lead, with its agent.
  const agent = keepAgent ? agents.get(String(keepAgent)) || { _id: keepAgent } : null;
  for (const u of uuids) {
    const s = storeOf.get(u);
    if (!s || (s.assignment?.leadId && String(s.assignment.leadId) === String(keep._id) && (!agent || String(s.assignment.agentId) === String(keepAgent)))) continue;
    const update = { $set: { "assignment.leadId": keep._id } };
    if (agent) Object.assign(update.$set, { "assignment.agentId": agent._id, "assignment.agentName": agentName(agent) });
    if (!s.assignment) update.$set["assignment.assignedAt"] = now;
    if (s.assignment) update.$push = { assignmentHistory: { ...s.assignment, unassignedAt: now, reason: `merged into the owner's lead ${keep._id}` } };
    await c.restaurants.updateOne({ uuid: u }, update);
    counts.storesMoved++;
  }
}

/** Lists a lead's own store (and, with --attach-brands, the owner's free brands) as brands. */
async function listBrands(c, lead, { key, missing, free, agents, now, counts }) {
  const want = [...missing, ...free];
  const docs = await c.restaurants.find({ uuid: { $in: want } }, { projection: STORE_PROJECTION }).toArray();
  const add = [];
  for (const s of docs) {
    if (free.includes(s.uuid)) {
      // A free brand only: not assigned (customers and other leads were left out by the caller).
      if (s.assignment?.agentId) continue;
      const agent = lead.assignedTo ? agents.get(String(lead.assignedTo)) || { _id: lead.assignedTo } : null;
      if (!agent) continue;
      const claim = await c.restaurants.updateOne(
        { uuid: s.uuid, "assignment.agentId": { $exists: false } },
        { $set: { assignment: { agentId: agent._id, agentName: agentName(agent), assignedByName: "one lead per owner (merge script)", assignedAt: now, leadId: lead._id, grouped: true } } }
      );
      if (!claim.modifiedCount) continue;
      counts.brandsAttached++;
    } else counts.brandsListed++;
    add.push(brandOf(s, s.uuid === lead.relatedUberEatsUuid ? lead.createdAt || now : now));
  }
  const set = { updatedAt: now };
  if (!lead.ownerKey && !key.startsWith("lead:") && !key.startsWith("uuid:")) set.ownerKey = key;
  await Lead.updateOne({ _id: lead._id }, { $set: set, ...(add.length ? { $push: { brands: { $each: add } } } : {}) });
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
