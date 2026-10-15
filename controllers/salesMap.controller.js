// controllers/salesMap.controller.js
//
// The Sales Map as one view. One request answers, for a scope (every customer,
// around a customer, or an area = city / postal code) and a period: the
// customers with what they bought in the period, the leads and the scraped
// prospects. Which document types count as "active" and who is shown are
// switched on the page, so the answer always carries all of it.
//
// Prospects come from two sources while both exist:
//   - the Uber Eats scraper (ubereats_restaurants): every store already has a
//     map point and is placed by where it is LOCATED (postalCode), so no
//     address lookups; this source is to replace the old one over time;
//   - the old Postal Scraping data (restaurants, via ScrapedRestaurant), placed
//     with address lookups as before (pins in ScrapedRestaurantGeo).
// An old record of a store the new scraper also has is shown once, from the new
// source (unless a lead is linked to the old record). A prospect that already is
// a customer or a lead is not shown (utils/prospectMatch.js: name, phone, email
// and address; a shared address alone is never enough).
const Invoice = require("../models/Invoice");
const SalesOrder = require("../models/SalesOrder");
const Customer = require("../models/Customer");
const Quotation = require("../models/Quotation");
const { ScrapedRestaurant, ScrapedRestaurantGeo } = require("../models/ScrapedRestaurant");
const SalesLead = require("../models/SalesLead");
const SalesLeadGeo = require("../models/SalesLeadGeo");
const { geocodeCustomer, geocodeAddress, deliveryAddressOf } = require("../utils/geocodingService");
const { haversineKm } = require("../utils/routeOptimizer");
const { customerGeo, locateRestaurants, normName, usable, GEOCODE_PER_REQUEST } = require("./map.controller").helpers;
const { ueCollections } = require("../utils/ubereatsDb");
const { uuidToStoreId } = require("../services/ubereats/parse");
const pm = require("../utils/prospectMatch");
const { matchContext, linkedLeads, invalidate, ownerNames, withOwnerNames, ownerOfCandidate } = require("../utils/prospectContext");
const mongoose = require("mongoose");
const User = require("../models/User");
const { assignStores, notifyAgent, agentName } = require("../services/ubereats/assign");
const restaurantScraperController = require("./restaurantScraper.controller");

const CUSTOMER_FIELDS = "CardCode CardName address deliveryAddress coordinates geo phoneNumber status assignedTo";

// ?agent=<userId> shows only what that agent owns (customers, leads, scraped restaurants that became
// their leads); ?agent=none only what nobody owns. -> null | { none: true } | { id }
function agentFilterOf(query) {
  const v = String(query.agent || "").trim();
  if (!v) return null;
  if (v === "none") return { none: true };
  return mongoose.isValidObjectId(v) ? { id: v } : null;
}
const ownedBy = (af, ownerId) => (af.none ? !ownerId : String(ownerId || "") === af.id);
const ownerQuery = (af) => (af.none ? { assignedTo: { $in: [null] } } : { assignedTo: new mongoose.Types.ObjectId(af.id) });
// Scraped restaurants read per request in a scoped view (own postal codes first).
const MAX_SCRAPED = 20000;
// Without a period, "active" means: bought in the last three months.
const DEFAULT_MONTHS = 3;

const round2 = (n) => Math.round(n * 100) / 100;
const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const zipOf = (c) => String(deliveryAddressOf(c)?.zipCode || "").trim();
const hasAddress = (c) => {
  const a = deliveryAddressOf(c);
  return Boolean(a && (String(a.street || "").trim() || String(a.zipCode || "").trim()));
};
const numeric = (f) => ({ [`${f}.lat`]: { $type: "number" } });
const PINNED = { $or: [numeric("coordinates"), numeric("geo")] };
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function periodOf(query) {
  let { startDate, endDate } = query;
  const defaultRange = !startDate || !endDate;
  if (defaultRange) {
    const to = new Date();
    const from = new Date(to);
    from.setMonth(from.getMonth() - DEFAULT_MONTHS);
    startDate = isoDay(from);
    endDate = isoDay(to);
  }
  const from = new Date(startDate);
  from.setHours(0, 0, 0, 0);
  const to = new Date(endDate);
  to.setHours(23, 59, 59, 999);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return null;
  return { startDate, endDate, defaultRange, range: { $gte: from, $lte: to } };
}

// Documents of one kind per customer in the period: { CardCode -> { count, total } }.
// `codes` narrows it to the customers of the scope (null = everyone).
async function activityByCustomer(Model, range, codes) {
  const match = { DocDate: range };
  if (codes) match.CardCode = { $in: codes };
  const rows = await Model.aggregate([
    { $match: match },
    { $group: { _id: "$CardCode", count: { $sum: 1 }, total: { $sum: { $ifNull: ["$DocTotal", 0] } } } },
  ]);
  return new Map(rows.filter((r) => r._id).map((r) => [r._id, r]));
}

// The last invoice or sales order of each customer, whenever it was: tells a
// customer who stopped last month from one who stopped ten years ago. For
// everyone it is one pass over both collections, so that answer is kept a while.
const LAST_PURCHASE_TTL_MS = 15 * 60 * 1000;
let lastPurchaseCache = null;
async function lastPurchases(codes) {
  if (!codes && lastPurchaseCache && Date.now() - lastPurchaseCache.at < LAST_PURCHASE_TTL_MS) return lastPurchaseCache.map;
  const map = new Map();
  for (const Model of [Invoice, SalesOrder]) {
    const rows = await Model.aggregate([
      ...(codes ? [{ $match: { CardCode: { $in: codes } } }] : []),
      { $group: { _id: "$CardCode", last: { $max: "$DocDate" } } },
    ]);
    rows.forEach((r) => {
      if (!r._id || !r.last) return;
      const known = map.get(r._id);
      if (!known || r.last > known) map.set(r._id, r.last);
    });
  }
  if (!codes) lastPurchaseCache = { at: Date.now(), map };
  return map;
}

const median = (values) => {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// "75", "75014" -> postal codes starting with it; anything else -> a city name.
function areaMatcher(text) {
  const value = String(text || "").trim();
  if (!value) return null;
  if (/^\d{2,5}$/.test(value)) {
    return {
      type: "zip",
      value,
      label: value.length === 5 ? `Postal code ${value}` : `Postal codes starting with ${value}`,
      query: { $or: [{ "address.zipCode": new RegExp(`^\\s*${value}`) }, { "deliveryAddress.zipCode": new RegExp(`^\\s*${value}`) }] },
      test: (address) => String(address?.zipCode || "").trim().startsWith(value),
      zipTest: (zip) => String(zip || "").trim().startsWith(value),
    };
  }
  const regex = new RegExp(`^\\s*${escapeRegex(value)}`, "i");
  return {
    type: "city",
    value,
    label: value,
    query: { $or: [{ "address.city": regex }, { "deliveryAddress.city": regex }] },
    test: (address) => regex.test(String(address?.city || "")),
    zipTest: null,
  };
}

// Customers with an address but no pin: a few are located per request.
async function locateCustomers(lean, budget) {
  const todo = lean.slice(0, budget);
  const located = [];
  if (todo.length === 0) return located;
  const docs = await Customer.find({ CardCode: { $in: todo.map((c) => c.CardCode) } });
  for (let i = 0; i < docs.length; i += 5) {
    await Promise.all(
      docs.slice(i, i + 5).map(async (doc) => {
        try {
          await geocodeCustomer(doc);
        } catch (error) {
          return;
        }
        located.push(doc.toObject());
      })
    );
  }
  return located;
}

// ---------- who is in the scope ----------

// -> { status, message } on a refusal, else
//    { customers: [lean customer + _geo (+ _distanceKm)], center, radiusKm, label, zips, ownZips,
//      inScope(geo, postalCode), unpinnedCodes, customersPending, customersNoAddress, customersInScope }
async function resolveScope(req, lookups) {
  const scope = ["customer", "area"].includes(req.query.scope) ? req.query.scope : "all";

  if (scope === "all") {
    const [all, total] = await Promise.all([Customer.find(PINNED).select(CUSTOMER_FIELDS).lean(), Customer.estimatedDocumentCount()]);
    const customers = [];
    all.forEach((c) => {
      const geo = customerGeo(c);
      if (geo) customers.push({ ...c, _geo: geo });
    });
    return {
      scope,
      customers,
      center: null,
      radiusKm: null,
      label: "All customers",
      zips: null,
      ownZips: new Set(),
      inScope: () => true,
      unpinnedCodes: [],
      customersPending: 0,
      customersNoAddress: 0,
      customersInScope: total,
      customersWithoutPin: Math.max(0, total - customers.length),
    };
  }

  const zips = new Set();
  const ownZips = new Set();
  const byCode = new Map();
  let center = null;
  let centerCustomer = null;
  let label = "";
  let matcher = null;
  let unpinned = [];
  let customersNoAddress = 0;
  // An area can be shown on its own (0 km) or with a ring around its centre.
  const minRadius = scope === "area" ? 0 : 0.5;
  const radiusKm = Math.min(Math.max(Number(req.query.radiusKm) || (scope === "area" ? 0 : 5), minRadius), 50);

  if (scope === "customer") {
    const { cardCode } = req.query;
    if (!cardCode) return { status: 400, message: "cardCode is required" };
    centerCustomer = await Customer.findOne({ CardCode: cardCode }).lean();
    if (!centerCustomer) return { status: 404, message: "Customer not found" };
    let geo = customerGeo(centerCustomer);
    if (!geo) {
      if (!hasAddress(centerCustomer)) {
        return { status: 400, message: `${centerCustomer.CardName} has no address on file, so it can't be placed on the map. Add the address on the Customers page.` };
      }
      await geocodeCustomer(await Customer.findOne({ CardCode: cardCode }));
      centerCustomer = await Customer.findOne({ CardCode: cardCode }).lean();
      geo = customerGeo(centerCustomer);
      if (!geo) return { status: 400, message: `The address of ${centerCustomer.CardName} could not be found on the map. Check it on the Customers page.` };
    }
    center = { lat: geo.lat, lng: geo.lng };
    label = centerCustomer.CardName;
    if (zipOf(centerCustomer)) ownZips.add(zipOf(centerCustomer));
    byCode.set(centerCustomer.CardCode, { ...centerCustomer, _geo: geo, _distanceKm: 0, _isCenter: true });
  } else {
    matcher = areaMatcher(req.query.area);
    if (!matcher) return { status: 400, message: "Type a city or a postal code" };
    label = matcher.label;
    const found = await Customer.find(matcher.query).select(CUSTOMER_FIELDS).lean();
    found.forEach((c) => {
      if (!matcher.test(deliveryAddressOf(c))) return;
      const geo = customerGeo(c);
      if (zipOf(c)) ownZips.add(zipOf(c));
      if (geo) byCode.set(c.CardCode, { ...c, _geo: geo });
      else if (hasAddress(c) && c.geo?.geocodeStatus !== "failed") unpinned.push(c);
      else customersNoAddress++;
    });
    if (matcher.zipTest) {
      // Postal codes that only have scraped restaurants, no customer yet.
      const scrapedZips = await ScrapedRestaurant.distinct("postal_code", { postal_code: new RegExp(`^${matcher.value}`) });
      scrapedZips.forEach((z) => ownZips.add(String(z).trim()));
    }
    const pins = [...byCode.values()].map((c) => c._geo);
    if (pins.length > 0) {
      center = { lat: median(pins.map((p) => p.lat)), lng: median(pins.map((p) => p.lng)) };
    } else {
      // No customer with a pin there: the place itself is looked up (one lookup).
      const hit = await geocodeAddress(
        matcher.type === "zip" ? { street: "", zipCode: matcher.value, country: "France" } : { street: "", city: matcher.value, country: "France" },
        `area:${matcher.value}`
      ).catch(() => null);
      if (hit) center = { lat: hit.lat, lng: hit.lng };
    }
    if (!center && unpinned.length === 0 && ownZips.size === 0) {
      return { status: 404, message: `Nothing found for "${matcher.value}": no customer and no scraped restaurant has that city or postal code.` };
    }
  }

  // Everyone with a pin inside the circle.
  if (center && radiusKm > 0) {
    const dLat = radiusKm / 111.32;
    const dLng = radiusKm / (111.32 * Math.cos((center.lat * Math.PI) / 180));
    const box = (field) => ({
      [`${field}.lat`]: { $gte: center.lat - dLat, $lte: center.lat + dLat },
      [`${field}.lng`]: { $gte: center.lng - dLng, $lte: center.lng + dLng },
    });
    const around = await Customer.find({ $or: [box("coordinates"), box("geo")] }).select(CUSTOMER_FIELDS).limit(20000).lean();
    around.forEach((c) => {
      if (byCode.has(c.CardCode)) return;
      const geo = customerGeo(c);
      if (!geo || haversineKm(center, geo) > radiusKm) return;
      byCode.set(c.CardCode, { ...c, _geo: geo });
    });
  }
  byCode.forEach((c) => zipOf(c) && zips.add(zipOf(c)));
  ownZips.forEach((z) => zips.add(z));

  // Around a customer: the customers of these postal codes that have no pin yet.
  if (scope === "customer" && zips.size > 0) {
    unpinned = await Customer.find({
      $nor: [numeric("coordinates"), numeric("geo")],
      "geo.geocodeStatus": { $ne: "failed" },
      $or: [{ "address.zipCode": { $in: [...zips] } }, { "deliveryAddress.zipCode": { $in: [...zips] } }],
    })
      .select(CUSTOMER_FIELDS)
      .limit(2000)
      .lean();
  }

  const inArea = (postalCode) => (matcher ? (matcher.zipTest ? matcher.zipTest(postalCode) : ownZips.has(String(postalCode || "").trim())) : false);
  const inScope = (geo, postalCode) => inArea(postalCode) || Boolean(center && radiusKm > 0 && haversineKm(center, geo) <= radiusKm);

  let customersPending = 0;
  if (unpinned.length > 0) {
    const located = await locateCustomers(unpinned, lookups.left);
    lookups.left -= Math.min(unpinned.length, lookups.left);
    const done = new Set();
    located.forEach((c) => {
      done.add(c.CardCode);
      const geo = customerGeo(c);
      if (!geo) {
        if (scope === "area") customersNoAddress++; // address not recognised
        return;
      }
      // In an area the customer belongs to it by address; around a customer by distance.
      if (scope === "customer" && haversineKm(center, geo) > radiusKm) return;
      byCode.set(c.CardCode, { ...c, _geo: geo });
    });
    customersPending = unpinned.filter((c) => !done.has(c.CardCode)).length;
    unpinned = unpinned.filter((c) => !done.has(c.CardCode));
  }

  const customers = [...byCode.values()];
  if (center) customers.forEach((c) => (c._distanceKm = round2(haversineKm(center, c._geo))));
  // An area's customers still waiting for a pin are part of it (their documents
  // count); around a customer only a pin can tell whether someone is inside.
  const unpinnedCodes = scope === "area" ? unpinned.map((c) => c.CardCode) : [];
  return {
    scope,
    customers,
    center,
    centerCustomer,
    radiusKm,
    label,
    matcher,
    zips,
    ownZips,
    inScope,
    unpinnedCodes,
    customersPending,
    customersNoAddress,
    customersInScope: customers.length + (scope === "area" ? unpinned.length + customersNoAddress : 0),
    customersWithoutPin: scope === "area" ? unpinned.length + customersNoAddress : 0,
  };
}

// ---------- leads typed by hand or imported ----------

const leadKey = (l) => normName([l.address?.street, l.address?.zipCode, l.address?.city].join(" "));
const leadRow = (l, geo, center) => ({
  id: String(l._id),
  name: l.fullName,
  company: usable(l.company),
  status: l.status || "new",
  tags: l.tags || [],
  sourceType: l.sourceType || "manual",
  ownerId: l.assignedTo ? String(l.assignedTo) : null,
  address: usable(l.address?.street),
  city: usable(l.address?.city),
  postalCode: String(l.address?.zipCode || "").trim(),
  phone: usable(l.phoneNumber),
  email: usable(l.email),
  lat: geo.lat,
  lng: geo.lng,
  approximate: geo.confidence === "low" || !usable(l.address?.street),
  distanceKm: center ? round2(haversineKm(center, geo)) : undefined,
});

async function manualLeadsFor(sc, lookups, af = null) {
  const out = { manualLeads: [], leadsPending: 0, leadsUnlocated: 0, leadsOutside: 0, leadsNoPostalCode: 0 };
  // Leads made from a scraped store are drawn on that store's position (prospect rows), not here.
  const open = { relatedRestaurant: null, relatedUberEatsUuid: null, status: { $ne: "converted" }, ...(af ? ownerQuery(af) : {}) };
  const fields = "fullName company status tags sourceType address phoneNumber email assignedTo";
  let docs;
  let geoByLead;
  if (sc.scope === "all") {
    // Every lead that already has a pin; no new lookups in the whole-map view.
    const pins = await SalesLeadGeo.find({ status: "ok" }).lean();
    geoByLead = new Map(pins.map((g) => [String(g.leadId), g]));
    docs = pins.length > 0 ? await SalesLead.find({ ...open, _id: { $in: pins.map((g) => g.leadId) } }).select(fields).lean() : [];
  } else {
    if (sc.zips.size === 0) return out;
    docs = await SalesLead.find({ ...open, "address.zipCode": { $in: [...sc.zips] } }).select(fields).limit(2000).lean();
    const known = await SalesLeadGeo.find({ leadId: { $in: docs.map((l) => l._id) } }).lean();
    geoByLead = new Map(known.map((g) => [String(g.leadId), g]));
  }
  // A pin made from an address that has since been changed does not count.
  const pinOf = (l) => {
    const g = geoByLead.get(String(l._id));
    return g && g.addressKey === leadKey(l) ? g : null;
  };
  if (sc.scope !== "all") {
    const todo = docs.filter((l) => !pinOf(l)).slice(0, lookups.left);
    for (let i = 0; i < todo.length; i += 5) {
      await Promise.all(
        todo.slice(i, i + 5).map(async (l) => {
          const zipCode = String(l.address.zipCode).trim();
          // Without a street, the company or the name is searched in that postal code.
          const street = usable(l.address.street) || usable(l.company) || usable(l.fullName);
          // The Leads form fills in "England" by default; a five-digit postal code is French.
          const country = /^\d{5}$/.test(zipCode) ? "France" : l.address.country;
          const hit = await geocodeAddress({ street, zipCode, city: l.address.city, country }, `lead:${l._id}`).catch(() => null);
          const doc = hit
            ? { leadId: l._id, addressKey: leadKey(l), lat: hit.lat, lng: hit.lng, status: "ok", source: hit.source, confidence: hit.confidence, geocodedAt: new Date() }
            : { leadId: l._id, addressKey: leadKey(l), status: "failed", geocodedAt: new Date() };
          await SalesLeadGeo.updateOne({ leadId: l._id }, { $set: doc }, { upsert: true });
          geoByLead.set(String(l._id), doc);
        })
      );
    }
    lookups.left -= todo.length;
  }
  docs.forEach((l) => {
    const geo = pinOf(l);
    if (!geo) return out.leadsPending++;
    if (geo.status !== "ok") return out.leadsUnlocated++;
    if (!sc.inScope(geo, l.address?.zipCode)) return out.leadsOutside++;
    out.manualLeads.push(leadRow(l, geo, sc.center));
  });
  if (sc.center) out.manualLeads.sort((a, b) => a.distanceKm - b.distanceKm);
  // Open leads that can never be matched to an area: no postal code at all.
  out.leadsNoPostalCode = await SalesLead.countDocuments({ relatedRestaurant: null, relatedUberEatsUuid: null, status: { $nin: ["converted", "dead"] }, "address.zipCode": { $in: [null, ""] }, ...(af ? ownerQuery(af) : {}) });
  return out;
}

// Matching context (customers / leads indexed, shared contacts): utils/prospectContext.js.

// ---------- scraped prospects (old Postal Scraping source) ----------

const leadOf = (lead) =>
  lead ? { id: String(lead._id), name: lead.fullName, status: lead.status || "new", tags: lead.tags || [], ownerId: lead.assignedTo ? String(lead.assignedTo) : null } : null;

// Is this old record hidden: also in the Uber Eats source, or already a customer / lead?
// -> "newSource" | "customers" | "leads" | null
function oldHiddenAs(r, lead, customerNames, ctx) {
  // The new source shows this store (its true location); the old record stays
  // only while a lead is linked to it.
  if (!lead && ctx?.shared.ueStoreIds.has(pm.storeIdFromUrl(r.url))) return "newSource";
  if (customerNames.has(normName(r.name))) return "customers";
  if (!ctx) return null;
  const same = pm.matchProspect(pm.oldProspectKeys(r), ctx.index, ctx.shared.old).same;
  if (!same) return null;
  if (same.type === "lead") return lead && same.id === String(lead._id) ? null : "leads";
  return "customers";
}

async function prospectsFor(sc, lookups, customerNames, ctx) {
  const out = { prospects: [], prospectsByPostalCode: [], prospectsPending: 0, prospectsUnlocated: 0, scrapedLeadsTotal: 0, leadsPending: 0, leadsUnlocated: 0, leadsOutside: 0 };

  if (sc.scope === "all") {
    // The whole map: every scraped restaurant that already has a pin. Placing
    // the others (one address lookup each) is done from a scoped view.
    const [scraped, pins, failedPins] = await Promise.all([
      ScrapedRestaurant.estimatedDocumentCount(),
      ScrapedRestaurantGeo.find({ status: "ok" }).select("restaurantId lat lng confidence").lean(),
      ScrapedRestaurantGeo.countDocuments({ status: "failed" }),
    ]);
    const ids = pins.map((g) => g.restaurantId);
    const [docs, leadDocs] = await Promise.all([
      ids.length > 0 ? ScrapedRestaurant.find({ _id: { $in: ids } }).select("name postal_code status url contact_info").lean() : [],
      SalesLead.find({ relatedRestaurant: { $ne: null }, status: { $ne: "converted" } }).select("fullName status tags relatedRestaurant assignedTo").lean(),
    ]);
    const byId = new Map(docs.map((r) => [String(r._id), r]));
    const leadByRestaurant = new Map(leadDocs.map((l) => [String(l.relatedRestaurant), l]));
    const hidden = { customers: 0, leads: 0, newSource: 0 };
    pins.forEach((g) => {
      const r = byId.get(String(g.restaurantId));
      if (!r || r.status === "failed") return;
      const lead = leadByRestaurant.get(String(r._id));
      const as = oldHiddenAs(r, lead, customerNames, ctx);
      if (as) return hidden[as]++;
      if (lead) out.scrapedLeadsTotal++;
      // Kept small: there can be 20,000 of them (details come from /map/prospect/:id).
      const row = { id: String(r._id), source: "scraped", name: r.name, postalCode: r.postal_code, lat: g.lat, lng: g.lng };
      if (g.confidence === "low") row.approximate = true;
      if (lead) row.lead = leadOf(lead);
      out.prospects.push(row);
    });
    out.prospectsUnlocated = failedPins;
    out.prospectsPending = Math.max(0, scraped - pins.length - failedPins);
    out.prospectsCompact = true;
    out.prospectStats = { scraped, shown: out.prospects.length, outside: 0, customers: hidden.customers, leads: hidden.leads, newSource: hidden.newSource, unlocated: failedPins, pending: out.prospectsPending, failed: 0 };
    return out;
  }

  if (sc.zips.size === 0) return out;
  const fields = "name url postal_code menu_items_count contact_info scraped_at status";
  const own = [...sc.ownZips];
  const first = own.length > 0 ? await ScrapedRestaurant.find({ postal_code: { $in: own } }).select(fields).limit(MAX_SCRAPED).lean() : [];
  const otherZips = [...sc.zips].filter((z) => !sc.ownZips.has(z));
  const others =
    otherZips.length > 0 && first.length < MAX_SCRAPED
      ? await ScrapedRestaurant.find({ postal_code: { $in: otherZips } }).select(fields).limit(MAX_SCRAPED - first.length).lean()
      : [];
  const scraped = [...first, ...others];
  // Scraped restaurants that the Leads page turned into a lead (a lead that
  // became a customer is left out: that customer is on the map already).
  const leadDocs =
    scraped.length > 0
      ? await SalesLead.find({ relatedRestaurant: { $in: scraped.map((r) => r._id) }, status: { $ne: "converted" } }).select("fullName status tags relatedRestaurant assignedTo").lean()
      : [];
  const leadByRestaurant = new Map(leadDocs.map((l) => [String(l.relatedRestaurant), l]));
  // Located in this order: the leads, the scope's own postal codes, the rest.
  const rank = (r) => (leadByRestaurant.has(String(r._id)) ? 0 : sc.ownZips.has(String(r.postal_code)) ? 1 : 2);
  const restaurants = scraped.filter((r) => r.status !== "failed").sort((a, b) => rank(a) - rank(b));
  const geoById = await locateRestaurants(restaurants, lookups.left);

  const perZip = new Map();
  const count = (r, field) => {
    const zip = String(r.postal_code || "");
    if (!perZip.has(zip)) perZip.set(zip, { postalCode: zip, own: sc.ownZips.has(zip), scraped: 0, shown: 0, outside: 0, customers: 0, leads: 0, newSource: 0, unlocated: 0, pending: 0, failed: 0 });
    const row = perZip.get(zip);
    row.scraped++;
    row[field]++;
  };
  scraped.forEach((r) => {
    if (r.status === "failed") return count(r, "failed");
    const geo = geoById.get(String(r._id));
    const lead = leadByRestaurant.get(String(r._id));
    // In the new source (shown from there), or already a customer / lead.
    const as = oldHiddenAs(r, lead, customerNames, ctx);
    if (as === "newSource" || as === "leads") return count(r, as);
    if (!geo) {
      out.prospectsPending++;
      if (lead) out.leadsPending++;
      return count(r, "pending");
    }
    if (geo.status !== "ok") {
      out.prospectsUnlocated++;
      if (lead) out.leadsUnlocated++;
      return count(r, "unlocated");
    }
    if (as === "customers") return count(r, "customers");
    if (!sc.inScope(geo, r.postal_code)) {
      if (lead) out.leadsOutside++;
      return count(r, "outside");
    }
    count(r, "shown");
    if (lead) out.scrapedLeadsTotal++;
    out.prospects.push({
      id: String(r._id),
      source: "scraped",
      name: r.name,
      postalCode: r.postal_code,
      lat: geo.lat,
      lng: geo.lng,
      approximate: geo.confidence === "low",
      lead: leadOf(lead),
      address: usable(r.contact_info?.address),
      phone: usable(r.contact_info?.phone),
      email: usable(r.contact_info?.email),
      url: r.url,
      menuItems: r.menu_items_count || 0,
      distanceKm: sc.center ? round2(haversineKm(sc.center, geo)) : undefined,
    });
  });
  if (sc.center) out.prospects.sort((a, b) => a.distanceKm - b.distanceKm);
  out.prospectsByPostalCode = [...perZip.values()].sort((a, b) => b.own - a.own || b.scraped - a.scraped || a.postalCode.localeCompare(b.postalCode));
  const sum = (field) => out.prospectsByPostalCode.reduce((n, z) => n + z[field], 0);
  out.prospectStats = {
    scraped: sum("scraped"),
    shown: sum("shown"),
    outside: sum("outside"),
    customers: sum("customers"),
    leads: sum("leads"),
    newSource: sum("newSource"),
    unlocated: sum("unlocated"),
    pending: sum("pending"),
    failed: sum("failed"),
  };
  // Still to place in the scope's own postal codes: the page keeps loading for these.
  out.ownPending = out.prospectsByPostalCode.filter((z) => z.own).reduce((n, z) => n + z.pending, 0);
  return out;
}

// ---------- Uber Eats scraper prospects (new source) ----------

const UE_LIST_FIELDS = {
  _id: 0,
  uuid: 1,
  title: 1,
  postalCode: 1,
  geo: 1,
  "location.streetAddress": 1,
  "location.address": 1,
  "location.city": 1,
  addressKey: 1,
  phoneNumber: 1,
  email: 1,
  registrationNumber: 1,
  "legal.phone": 1,
  "legal.name": 1,
  categories: 1,
  "rating.value": 1,
  "rating.count": 1,
  menuItemCount: 1,
  isRestaurant: 1,
  url: 1,
};

const ueRow = (s, sc, compact) => {
  const [lng, lat] = s.geo.coordinates;
  const row = { id: `ue:${s.uuid}`, source: "ubereats", name: s.title, postalCode: s.postalCode || "", lat, lng };
  if (compact) return row;
  return {
    ...row,
    address: s.location?.streetAddress || s.location?.address || "",
    city: s.location?.city || "",
    phone: s.phoneNumber || "",
    email: s.email || "",
    registrationNumber: s.registrationNumber || "",
    cuisine: (s.categories || []).slice(0, 3),
    rating: s.rating?.value ?? null,
    menuItems: s.menuItemCount || 0,
    url: s.url,
    distanceKm: sc.center ? round2(haversineKm(sc.center, { lat, lng })) : undefined,
  };
};

/**
 * Stores of the Uber Eats scraper in the scope, by where they are LOCATED
 * (postalCode), or inside the circle. Stores without a map point (feed-card
 * only) can't be drawn and are left out.
 */
async function ueProspectsFor(sc, ctx, oldLeadStoreIds) {
  const out = { prospects: [], stats: { scraped: 0, shown: 0, outside: 0, customers: 0, leads: 0, newSource: 0, unlocated: 0, pending: 0, failed: 0 }, byZip: new Map() };
  if (!ctx?.shared.ueAvailable) return out;
  const c = await ueCollections();
  let query = { geo: { $exists: true } };
  if (sc.scope !== "all") {
    const or = [];
    if (sc.zips.size > 0) or.push({ postalCode: { $in: [...sc.zips] } });
    if (sc.matcher?.zipTest) or.push({ postalCode: new RegExp(`^${sc.matcher.value}`) });
    if (sc.matcher?.type === "city") or.push({ "location.city": new RegExp(`^\\s*${escapeRegex(sc.matcher.value)}`, "i") });
    if (sc.center && sc.radiusKm > 0) or.push({ geo: { $geoWithin: { $centerSphere: [[sc.center.lng, sc.center.lat], sc.radiusKm / 6378.1] } } });
    if (or.length === 0) return out;
    query = { geo: { $exists: true }, $or: or };
  }
  const stores = await c.restaurants.find(query, { projection: UE_LIST_FIELDS }).limit(MAX_SCRAPED).toArray();
  const compact = sc.scope === "all";
  // Stores assigned to an agent from the scraper page: shown as their lead (purple).
  const assignedLeads = await linkedLeads(stores.map((s) => s.uuid));
  stores.forEach((s) => {
    const zip = s.postalCode || "";
    const z = out.byZip.get(zip) || { postalCode: zip, own: sc.ownZips.has(zip), scraped: 0, shown: 0, outside: 0, customers: 0, leads: 0, newSource: 0, unlocated: 0, pending: 0, failed: 0 };
    out.byZip.set(zip, z);
    const count = (field) => {
      z.scraped++;
      z[field]++;
      out.stats.scraped++;
      out.stats[field]++;
    };
    // An old record with a linked lead already shows this store (as that lead).
    if (oldLeadStoreIds.has(uuidToStoreId(s.uuid))) return count("leads");
    const [lng, lat] = s.geo.coordinates;
    if (!sc.inScope({ lat, lng }, zip) && !(sc.matcher?.type === "city" && sc.radiusKm === 0)) return count("outside");
    const own = assignedLeads.get(s.uuid);
    const { same, related } = own ? { same: null, related: [] } : pm.matchProspect(pm.ueProspectKeys(s), ctx.index, ctx.shared.ue);
    if (same) return count(same.type === "lead" ? "leads" : "customers");
    count("shown");
    const row = ueRow(s, sc, compact);
    if (own && own.status !== "converted") row.lead = { id: own.id, name: own.name, status: own.status, tags: [], ownerId: own.agentId };
    if (!compact && related.length > 0) row.related = related;
    out.prospects.push(row);
  });
  return out;
}

// GET /api/map/sales?scope=all|customer|area[&cardCode=][&area=][&radiusKm=][&startDate=&endDate=][&locate=false]
exports.getSalesMap = async (req, res) => {
  try {
    const period = periodOf(req.query);
    if (!period) return res.status(400).json({ message: "Invalid date range" });
    // Address lookups this request may spend (each may be a billed geocoding call).
    const lookups = { left: req.query.locate === "false" ? 0 : GEOCODE_PER_REQUEST() };

    const sc = await resolveScope(req, lookups);
    if (sc.status) return res.status(sc.status).json({ message: sc.message });

    // One agent's accounts only (or only what nobody owns).
    const af = agentFilterOf(req.query);
    let agentName = null;
    if (af) {
      sc.customers = sc.customers.filter((c) => ownedBy(af, c.assignedTo));
      sc.unpinnedCodes = [];
      const unpinned = { ...ownerQuery(af), $nor: [numeric("coordinates"), numeric("geo")] };
      sc.customersWithoutPin = sc.scope === "all" ? await Customer.countDocuments(unpinned) : 0;
      sc.customersInScope = sc.customers.length + sc.customersWithoutPin;
      if (af.id) agentName = (await ownerNames([af.id])).get(af.id) || null;
    }

    const codes = sc.scope === "all" && !af ? null : [...sc.customers.map((c) => c.CardCode), ...sc.unpinnedCodes];
    const [invoices, orders, quotations, last] = await Promise.all([
      activityByCustomer(Invoice, period.range, codes),
      activityByCustomer(SalesOrder, period.range, codes),
      activityByCustomer(Quotation, period.range, codes).catch(() => new Map()),
      lastPurchases(codes),
    ]);

    const customers = sc.customers.map((c) => {
      const address = deliveryAddressOf(c) || {};
      const inv = invoices.get(c.CardCode);
      const ord = orders.get(c.CardCode);
      const quo = quotations.get(c.CardCode);
      return {
        cardCode: c.CardCode,
        cardName: c.CardName,
        status: c.status || "",
        isCenter: c._isCenter || undefined,
        lat: c._geo.lat,
        lng: c._geo.lng,
        street: address.street || "",
        zipCode: address.zipCode || "",
        city: address.city || "",
        phone: c.phoneNumber || "",
        distanceKm: c._distanceKm,
        invoiceCount: inv ? inv.count : 0,
        invoiceTotal: inv ? round2(inv.total) : 0,
        orderCount: ord ? ord.count : 0,
        orderTotal: ord ? round2(ord.total) : 0,
        quotationCount: quo ? quo.count : 0,
        quotationTotal: quo ? round2(quo.total) : 0,
        lastPurchase: last.get(c.CardCode) || null,
      };
    });
    if (sc.center) customers.sort((a, b) => a.distanceKm - b.distanceKm);

    const wantOthers = req.query.potential !== "false";
    const customerNames = new Set(sc.customers.map((c) => normName(c.CardName)).filter(Boolean));
    const leads = wantOthers ? await manualLeadsFor(sc, lookups, af) : { manualLeads: [], leadsPending: 0, leadsUnlocated: 0, leadsOutside: 0, leadsNoPostalCode: 0 };
    const ctx = wantOthers ? await matchContext() : null;
    const pros = wantOthers ? await prospectsFor(sc, lookups, customerNames, ctx) : { prospects: [], prospectsByPostalCode: [], prospectsPending: 0, prospectsUnlocated: 0, scrapedLeadsTotal: 0, leadsPending: 0, leadsUnlocated: 0, leadsOutside: 0 };
    // The new source, next to the old one.
    const oldLeadStoreIds = wantOthers ? await linkedLeadStoreIds() : new Set();
    const ue = wantOthers ? await ueProspectsFor(sc, ctx, oldLeadStoreIds).catch((error) => {
      console.error("[salesMap] Uber Eats prospects failed:", error.message);
      return { prospects: [], stats: null, byZip: new Map() };
    }) : { prospects: [], stats: null, byZip: new Map() };
    const prospectSources = {
      ubereats: ue.stats,
      scraped: pros.prospectStats || null,
    };
    if (ue.prospects.length > 0) {
      pros.prospects = [...ue.prospects, ...pros.prospects];
      if (sc.center) pros.prospects.sort((a, b) => a.distanceKm - b.distanceKm);
    }
    if (ue.stats) {
      const base = pros.prospectStats || { scraped: 0, shown: 0, outside: 0, customers: 0, leads: 0, newSource: 0, unlocated: 0, pending: 0, failed: 0 };
      pros.prospectStats = Object.fromEntries(Object.keys(ue.stats).map((k) => [k, (base[k] || 0) + ue.stats[k]]));
      if (sc.scope !== "all") {
        const rows = new Map((pros.prospectsByPostalCode || []).map((z) => [z.postalCode, { ...z }]));
        ue.byZip.forEach((z, zip) => {
          const row = rows.get(zip);
          if (!row) return rows.set(zip, z);
          Object.keys(ue.stats).forEach((k) => (row[k] = (row[k] || 0) + z[k]));
        });
        pros.prospectsByPostalCode = [...rows.values()].sort((a, b) => b.own - a.own || b.scraped - a.scraped || a.postalCode.localeCompare(b.postalCode));
      }
    }

    if (af) {
      // A scraped restaurant belongs to an agent once it is their lead; "none" keeps the unowned ones.
      pros.prospects = pros.prospects.filter((p) => (af.none ? !(p.lead && p.lead.ownerId) : p.lead?.ownerId === af.id));
      if (af.id) {
        pros.prospectStats = null;
        prospectSources.ubereats = null;
        prospectSources.scraped = null;
        pros.prospectsByPostalCode = [];
      }
    }

    // "assigned to …" for every lead in the answer (one lookup).
    const owned = [...pros.prospects.map((p) => p.lead).filter(Boolean), ...leads.manualLeads];
    const names = await ownerNames(owned.map((x) => x.ownerId));
    owned.forEach((x) => {
      if (x.ownerId) x.ownerName = names.get(x.ownerId) || null;
    });

    const sum = (m, field) => [...m.values()].reduce((n, r) => n + r[field], 0);
    const onMap = new Set(customers.map((c) => c.cardCode));
    const withDocs = new Set([...invoices.keys(), ...orders.keys(), ...quotations.keys()]);
    res.json({
      scope: sc.scope,
      label: sc.label,
      startDate: period.startDate,
      endDate: period.endDate,
      defaultRange: period.defaultRange,
      center: sc.center
        ? { ...sc.center, cardCode: sc.centerCustomer?.CardCode, cardName: sc.centerCustomer?.CardName }
        : null,
      radiusKm: sc.radiusKm,
      area: sc.matcher ? { type: sc.matcher.type, value: sc.matcher.value, postalCodes: [...sc.ownZips].sort() } : null,
      customers,
      totals: {
        // Every customer of the scope, drawn or not.
        customersInScope: sc.customersInScope,
        customersOnMap: customers.length,
        customersWithoutPin: sc.customersWithoutPin,
        customersPending: sc.customersPending,
        customersNoAddress: sc.customersNoAddress,
        // Documents of the scope's customers in the period.
        invoices: sum(invoices, "count"),
        invoiceTotal: round2(sum(invoices, "total")),
        orders: sum(orders, "count"),
        orderTotal: round2(sum(orders, "total")),
        quotations: sum(quotations, "count"),
        quotationTotal: round2(sum(quotations, "total")),
        // Customers with documents in the period that can't be drawn (no pin yet).
        activeWithoutPin: [...withDocs].filter((code) => !onMap.has(code)).length,
      },
      manualLeads: leads.manualLeads,
      leadsNoPostalCode: leads.leadsNoPostalCode,
      leadsPending: leads.leadsPending + pros.leadsPending,
      leadsUnlocated: leads.leadsUnlocated + pros.leadsUnlocated,
      leadsOutside: leads.leadsOutside + pros.leadsOutside,
      prospects: pros.prospects,
      prospectsCompact: Boolean(pros.prospectsCompact),
      scrapedLeadsTotal: pros.scrapedLeadsTotal,
      prospectsPending: pros.prospectsPending,
      prospectsUnlocated: pros.prospectsUnlocated,
      prospectStats: pros.prospectStats || null,
      // The same figures per source while both exist.
      prospectSources,
      agent: af ? { id: af.id || "none", name: af.none ? "Not assigned to anyone" : agentName } : null,
      prospectsByPostalCode: pros.prospectsByPostalCode,
      ownPending: pros.ownPending || 0,
    });
  } catch (error) {
    console.error("Sales map error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Store ids (Uber Eats URL id) of old records that a lead is linked to.
async function linkedLeadStoreIds() {
  const leads = await SalesLead.find({ relatedRestaurant: { $ne: null }, status: { $ne: "converted" } }).select("relatedRestaurant").lean();
  if (leads.length === 0) return new Set();
  const olds = await ScrapedRestaurant.find({ _id: { $in: leads.map((l) => l.relatedRestaurant) } }).select("url").lean();
  return new Set(olds.map((r) => pm.storeIdFromUrl(r.url)).filter(Boolean));
}

// ---------- one prospect, everything about it (shared detail panel) ----------

const euroCents = (text) => {
  // "11,12 €" -> 1112
  const m = String(text || "").replace(/\s/g, "").match(/(\d+)(?:[.,](\d{1,2}))?/);
  return m ? Number(m[1]) * 100 + Number((m[2] || "0").padEnd(2, "0")) : null;
};

/** Customers / leads this prospect is, or shares a phone / address with. */
async function matchesOf(keys, shared) {
  const ctx = await matchContext();
  if (!ctx) return { same: null, related: [] };
  const m = pm.matchProspect(keys, ctx.index, shared === "ue" ? ctx.shared.ue : ctx.shared.old);
  // Who the customer / lead is assigned to.
  const withOwner = async (x) => (x ? { ...x, ownerId: x.ownerId || (await ownerOfCandidate(x.type, x.id)) } : x);
  const [same, ...related] = await withOwnerNames(await Promise.all([withOwner(m.same), ...m.related.map(withOwner)]));
  return { same, related };
}

async function ueDetail(uuid) {
  const c = await ueCollections();
  const s = await c.restaurants.findOne({ uuid }, { projection: { raw: 0 } });
  if (!s) return null;
  const [sameAddress, matches] = await Promise.all([
    s.addressKey
      ? c.restaurants
          .find({ addressKey: s.addressKey, uuid: { $ne: uuid } }, { projection: { _id: 0, uuid: 1, title: 1, categories: { $slice: 2 } } })
          .sort({ title: 1 })
          .limit(30)
          .toArray()
      : [],
    matchesOf(pm.ueProspectKeys(s), "ue"),
  ]);
  const loc = s.location || {};
  return {
    id: `ue:${s.uuid}`,
    source: "ubereats",
    name: s.title,
    url: s.url,
    imageUrl: s.imageUrls?.[0] || null,
    address: {
      street: loc.streetAddress || "",
      postalCode: s.postalCode || loc.postalCode || "",
      city: loc.city || "",
      full: loc.address || [loc.streetAddress, s.postalCode, loc.city].filter(Boolean).join(", "),
    },
    lat: s.geo?.coordinates?.[1] ?? null,
    lng: s.geo?.coordinates?.[0] ?? null,
    phone: s.phoneNumber || "",
    email: s.email || "",
    emailChecked: Boolean(s.legal),
    registrationNumber: s.registrationNumber || "",
    siren: s.siren || "",
    registry: s.legal?.registry || "",
    legalName: s.legal?.name || "",
    legalAddress: s.legal?.address || "",
    legalPhone: s.legal?.phone && pm.normPhone(s.legal.phone) !== pm.normPhone(s.phoneNumber) ? s.legal.phone : "",
    cuisine: s.categories || [],
    rating: s.rating?.value != null ? { value: s.rating.value, count: s.rating.count ?? null } : null,
    priceBucket: s.priceBucket || "",
    hours: s.hours || [],
    menu: (s.menu || []).map((sec) => ({
      title: sec.title,
      items: (sec.items || []).map((it) => ({ title: it.title, description: it.description || "", price: it.price ?? null, priceText: it.priceText || "", imageUrl: it.imageUrl || null })),
    })),
    menuItems: s.menuItemCount || 0,
    menuPartial: Boolean(s.menuPartial),
    scrapedAt: s.detailsScrapedAt || s.lastSeenAt || null,
    sameAddress: sameAddress.map((b) => ({ id: `ue:${b.uuid}`, name: b.title, cuisine: b.categories || [] })),
    isCustomerOrLead: matches.same,
    related: matches.related,
    // Assigned to an agent from the Uber Eats Scraper page (the lead is on the Leads page).
    assignedTo: s.assignment?.agentId ? { name: s.assignment.agentName, at: s.assignment.assignedAt, leadId: s.assignment.leadId ? String(s.assignment.leadId) : null } : null,
  };
}

async function oldDetail(id) {
  const r = await ScrapedRestaurant.findById(id).lean();
  if (!r) return null;
  const [geo, matches] = await Promise.all([ScrapedRestaurantGeo.findOne({ restaurantId: r._id, status: "ok" }).lean(), matchesOf(pm.oldProspectKeys(r), "old")]);
  return {
    id: String(r._id),
    source: "scraped",
    name: r.name,
    url: r.url,
    imageUrl: null,
    address: { street: "", postalCode: r.postal_code || "", city: "", full: usable(r.contact_info?.address) },
    // postal_code of the old data is the searched postal code, not always where the restaurant is.
    postalCodeIsSearched: true,
    lat: geo?.lat ?? null,
    lng: geo?.lng ?? null,
    phone: usable(r.contact_info?.phone),
    email: usable(r.contact_info?.email),
    emailChecked: false,
    registrationNumber: "",
    cuisine: [],
    rating: null,
    hours: [],
    menu: (r.menu_items || []).length
      ? [
          {
            title: "Menu",
            items: r.menu_items.map((it) => ({
              title: it.title,
              description: usable(it.description),
              price: euroCents(it.price),
              priceText: usable(it.price),
              imageUrl: null,
            })),
          },
        ]
      : [],
    menuItems: r.menu_items_count || (r.menu_items || []).length,
    scrapedAt: r.scraped_at || r.last_updated || null,
    sameAddress: [],
    isCustomerOrLead: matches.same,
    related: matches.related,
  };
}

/** The richest record for an id: "ue:<uuid>" (new source) or an old restaurants _id. */
async function prospectDetail(id) {
  if (String(id).startsWith("ue:")) return ueDetail(String(id).slice(3));
  const old = await oldDetail(id);
  if (!old) return null;
  // The same store in the new source: shown from there (richer), the old id kept.
  const storeId = pm.storeIdFromUrl(old.url);
  if (storeId) {
    try {
      const c = await ueCollections();
      const uuidHex = Buffer.from(storeId, "base64url").toString("hex");
      const uuid = uuidHex.length === 32 ? `${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-${uuidHex.slice(12, 16)}-${uuidHex.slice(16, 20)}-${uuidHex.slice(20)}` : null;
      if (uuid && (await c.restaurants.countDocuments({ uuid }, { limit: 1 }))) {
        const fresh = await ueDetail(uuid);
        if (fresh) return { ...fresh, oldId: old.id, oldMenuItems: old.menuItems, phone: fresh.phone || old.phone, email: fresh.email || old.email };
      }
    } catch (error) {
      console.warn("[salesMap] Uber Eats record of an old prospect unavailable:", error.message);
    }
  }
  return old;
}

// GET /api/map/prospect/:id - everything about one prospect, for the detail
// panel shared by the Sales Map and the Leads page: name, address, phone,
// email, registration number, cuisine, rating, menu. id = "ue:<uuid>" for the
// Uber Eats scraper, or an old restaurants _id.
// GET /api/map/agents -> the people the Sales Map "Agent" filter offers: active sales agents and
// managers, plus anyone else who still owns customers or open leads (deactivated agents included).
exports.getAgents = async (req, res) => {
  try {
    const [customerOwners, leadOwners] = await Promise.all([
      Customer.distinct("assignedTo", { assignedTo: { $ne: null } }),
      SalesLead.distinct("assignedTo", { assignedTo: { $ne: null }, status: { $ne: "converted" } }),
    ]);
    const owners = [...customerOwners, ...leadOwners].filter((id) => mongoose.isValidObjectId(id));
    const users = await User.find({
      $or: [{ role: { $in: ["sales_agent", "sales_manager"] }, deactivated: { $ne: true } }, { _id: { $in: owners } }],
    })
      .select("firstName lastName email role deactivated")
      .lean();
    const nameOf = (u) => [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.email || "Unnamed";
    // Two accounts can carry the same name ("Ali kamal" / "Ali KAMAL"): those also show their email.
    const seen = new Map();
    users.forEach((u) => seen.set(nameOf(u).toLowerCase(), (seen.get(nameOf(u).toLowerCase()) || 0) + 1));
    const list = users
      .map((u) => {
        const name = nameOf(u);
        const twin = seen.get(name.toLowerCase()) > 1 && u.email;
        return { id: String(u._id), name: twin ? `${name} (${u.email})` : name, role: u.role, deactivated: Boolean(u.deactivated) };
      })
      .sort((a, b) => Number(a.deactivated) - Number(b.deactivated) || a.name.localeCompare(b.name));
    res.json(list);
  } catch (error) {
    console.error("Sales map agents error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.getProspect = async (req, res) => {
  try {
    const detail = await prospectDetail(req.params.id);
    if (!detail) return res.status(404).json({ message: "Not found" });
    res.json(detail);
  } catch (error) {
    res.status(error.name === "CastError" || error.name === "BSONError" ? 404 : 500).json({ message: error.name === "CastError" || error.name === "BSONError" ? "Not found" : "Server error" });
  }
};

// GET /api/map/prospect-for-lead/:leadId - the same panel for a lead: the
// restaurant it was made from (old data, or the same store in the Uber Eats
// scraper), or the Uber Eats store that matches the lead's phone / email /
// name and address. Always returns the lead itself; prospect = null when no
// restaurant is known for it.
exports.getProspectForLead = async (req, res) => {
  try {
    const lead = await SalesLead.findById(req.params.leadId).select("fullName company status phoneNumber email address relatedRestaurant relatedUberEatsUuid restaurantData assignedTo").lean();
    if (!lead) return res.status(404).json({ message: "Lead not found" });
    const leadInfo = {
      id: String(lead._id),
      name: lead.company || lead.fullName,
      contactName: lead.company && lead.fullName && lead.company !== lead.fullName ? lead.fullName : "",
      status: lead.status || "new",
      phone: usable(lead.phoneNumber),
      email: usable(lead.email),
      ownerName: lead.assignedTo ? (await ownerNames([String(lead.assignedTo)])).get(String(lead.assignedTo)) || null : null,
    };
    let prospect = null;
    let matchedBy = null;
    if (lead.relatedUberEatsUuid) {
      prospect = await ueDetail(lead.relatedUberEatsUuid);
      matchedBy = prospect ? "linked" : null;
    }
    if (!prospect && lead.relatedRestaurant) {
      prospect = await prospectDetail(String(lead.relatedRestaurant));
      matchedBy = prospect ? "linked" : null;
    }
    if (!prospect) {
      // A lead typed by hand: the Uber Eats store with its phone / email, or its name at its address.
      try {
        const keys = pm.candidateFromLead(lead);
        const c = await ueCollections();
        const or = [];
        if (keys.zip) or.push({ postalCode: keys.zip });
        const stores = or.length ? await c.restaurants.find({ $or: or }, { projection: UE_LIST_FIELDS }).limit(5000).toArray() : [];
        const ctx = await matchContext();
        const one = pm.indexCandidates([keys]);
        const hit = stores.find((s) => pm.matchProspect(pm.ueProspectKeys(s), one, ctx ? ctx.shared.ue : undefined).same);
        if (hit) {
          prospect = await ueDetail(hit.uuid);
          matchedBy = "match";
        }
      } catch (error) {
        console.warn("[salesMap] lead -> Uber Eats match unavailable:", error.message);
      }
    }
    res.json({ lead: leadInfo, prospect, matchedBy });
  } catch (error) {
    res.status(error.name === "CastError" || error.name === "BSONError" ? 404 : 500).json({ message: error.name === "CastError" ? "Lead not found" : "Server error" });
  }
};

// GET /api/map/search-areas?search=par -> the cities / postal codes customers
// are in, for the area picker: [{ type, value, label, customers }]
exports.searchAreas = async (req, res) => {
  try {
    const text = String(req.query.search || "").trim();
    if (text.length < 2) return res.json({ areas: [] });
    const isZip = /^\d{2,5}$/.test(text);
    const field = isZip ? "zipCode" : "city";
    const regex = isZip ? new RegExp(`^\\s*${text}`) : new RegExp(`^\\s*${escapeRegex(text)}`, "i");
    const found = await Customer.find({ $or: [{ [`address.${field}`]: regex }, { [`deliveryAddress.${field}`]: regex }] })
      .select("address deliveryAddress")
      .limit(20000)
      .lean();
    const counts = new Map();
    found.forEach((c) => {
      const raw = String(deliveryAddressOf(c)?.[field] || "").trim();
      if (!regex.test(raw)) return;
      const key = isZip ? raw : raw.toUpperCase();
      const row = counts.get(key) || { value: raw, customers: 0 };
      row.customers++;
      counts.set(key, row);
    });
    const areas = [...counts.values()]
      .sort((a, b) => b.customers - a.customers)
      .slice(0, 6)
      .map((a) => ({ type: isZip ? "zip" : "city", value: a.value, label: isZip ? `Postal code ${a.value}` : a.value, customers: a.customers }));
    // "75" on its own is a useful area too: every postal code starting with it.
    if (isZip && text.length < 5 && found.length > 0) {
      areas.unshift({ type: "zip", value: text, label: `All postal codes starting with ${text}`, customers: [...counts.values()].reduce((n, a) => n + a.customers, 0) });
    }
    res.json({ areas });
  } catch (error) {
    console.error("Search areas error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// POST /api/map/prospects/assign { ids[], agentId, priority }  (admin / sales_manager)
// Assign prospects picked on the Sales Map (ticked in the list, or every one shown
// for the area / radius / filter) to an agent, the same way as the other screens:
// Uber Eats stores ("ue:<uuid>") through services/ubereats/assign.js (as on the Uber
// Eats Scraper page), old Postal Scraping records through the old page's assign
// (RestaurantAssignment + Lead, unchanged). Each prospect becomes a lead on the
// Leads page; anything already assigned, a customer or a lead is skipped with the reason.
exports.assignProspects = async (req, res) => {
  try {
    const { ids, agentId, priority = "medium" } = req.body || {};
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, 1000);
    if (!list.length) return res.status(400).json({ message: "Select at least one prospect" });
    const agent = mongoose.isValidObjectId(agentId) ? await User.findById(agentId).select("firstName lastName email role deactivated").lean() : null;
    if (!agent || !["sales_agent", "sales_manager"].includes(agent.role) || agent.deactivated) {
      return res.status(400).json({ message: "Choose an active sales agent or sales manager" });
    }
    const assigned = [];
    const skipped = [];

    const ueIds = list.filter((id) => id.startsWith("ue:")).map((id) => id.slice(3));
    if (ueIds.length) {
      const c = await ueCollections();
      const r = await assignStores(c, { uuids: ueIds, agent, by: req.user, priority, source: "the Sales Map", notify: false });
      r.assigned.forEach((x) => assigned.push({ id: `ue:${x.uuid}`, name: x.title, leadId: x.leadId }));
      r.skipped.forEach((x) => skipped.push({ id: `ue:${x.uuid}`, name: x.title, reason: x.reason }));
      if (r.assigned.length && (req.user?._id || req.user?.id)) await notifyAgent(agent, req.user._id || req.user.id, r.assigned.length);
    }

    const oldIds = list.filter((id) => !id.startsWith("ue:"));
    const validOld = oldIds.filter((id) => mongoose.isValidObjectId(id));
    oldIds.filter((id) => !mongoose.isValidObjectId(id)).forEach((id) => skipped.push({ id, name: "", reason: "not found" }));
    if (validOld.length) {
      const names = new Map((await ScrapedRestaurant.find({ _id: { $in: validOld } }).select("name").lean()).map((r) => [String(r._id), r.name]));
      const captured = { statusCode: 200, body: null };
      const fake = { status: (code) => ((captured.statusCode = code), fake), json: (body) => ((captured.body = body), fake) };
      await restaurantScraperController.assignRestaurants({ body: { restaurantIds: validOld, agentId: String(agent._id), priority }, user: req.user }, fake);
      const data = captured.body?.data || {};
      (data.assignments || []).forEach((a) => assigned.push({ id: String(a.restaurant), name: names.get(String(a.restaurant)) || "" }));
      (data.errors || []).forEach((e) => skipped.push({ id: String(e.restaurantId), name: names.get(String(e.restaurantId)) || "", reason: e.error === "Already assigned" ? "already assigned" : e.error }));
      if (captured.statusCode >= 400) validOld.forEach((id) => skipped.push({ id, name: names.get(id) || "", reason: captured.body?.message || "could not assign" }));
    }

    invalidate();
    res.json({ assigned: assigned.length, items: assigned, skipped, agent: { id: String(agent._id), name: agentName(agent) } });
  } catch (error) {
    console.error("Assign prospects error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};
