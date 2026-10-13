// controllers/salesMap.controller.js
//
// The Sales Map as one view. One request answers, for a scope (every customer,
// around a customer, or an area = city / postal code) and a period: the
// customers with what they bought in the period, the leads and the scraped
// prospects. Which document types count as "active" and who is shown are
// switched on the page, so the answer always carries all of it.
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

const CUSTOMER_FIELDS = "CardCode CardName address deliveryAddress coordinates geo phoneNumber status";
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

async function manualLeadsFor(sc, lookups) {
  const out = { manualLeads: [], leadsPending: 0, leadsUnlocated: 0, leadsOutside: 0, leadsNoPostalCode: 0 };
  const open = { relatedRestaurant: null, status: { $ne: "converted" } };
  const fields = "fullName company status tags sourceType address phoneNumber email";
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
  out.leadsNoPostalCode = await SalesLead.countDocuments({ relatedRestaurant: null, status: { $nin: ["converted", "dead"] }, "address.zipCode": { $in: [null, ""] } });
  return out;
}

// ---------- scraped prospects ----------

const leadOf = (lead) => (lead ? { id: String(lead._id), name: lead.fullName, status: lead.status || "new", tags: lead.tags || [] } : null);

async function prospectsFor(sc, lookups, customerNames) {
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
      ids.length > 0 ? ScrapedRestaurant.find({ _id: { $in: ids } }).select("name postal_code status").lean() : [],
      SalesLead.find({ relatedRestaurant: { $ne: null }, status: { $ne: "converted" } }).select("fullName status tags relatedRestaurant").lean(),
    ]);
    const byId = new Map(docs.map((r) => [String(r._id), r]));
    const leadByRestaurant = new Map(leadDocs.map((l) => [String(l.relatedRestaurant), l]));
    let sameName = 0;
    pins.forEach((g) => {
      const r = byId.get(String(g.restaurantId));
      if (!r || r.status === "failed") return;
      if (customerNames.has(normName(r.name))) return sameName++;
      const lead = leadByRestaurant.get(String(r._id));
      if (lead) out.scrapedLeadsTotal++;
      // Kept small: there can be 20,000 of them (details come from /map/prospect/:id).
      const row = { id: String(r._id), name: r.name, postalCode: r.postal_code, lat: g.lat, lng: g.lng };
      if (g.confidence === "low") row.approximate = true;
      if (lead) row.lead = leadOf(lead);
      out.prospects.push(row);
    });
    out.prospectsUnlocated = failedPins;
    out.prospectsPending = Math.max(0, scraped - pins.length - failedPins);
    out.prospectsCompact = true;
    out.prospectStats = { scraped, shown: out.prospects.length, outside: 0, customers: sameName, unlocated: failedPins, pending: out.prospectsPending, failed: 0 };
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
      ? await SalesLead.find({ relatedRestaurant: { $in: scraped.map((r) => r._id) }, status: { $ne: "converted" } }).select("fullName status tags relatedRestaurant").lean()
      : [];
  const leadByRestaurant = new Map(leadDocs.map((l) => [String(l.relatedRestaurant), l]));
  // Located in this order: the leads, the scope's own postal codes, the rest.
  const rank = (r) => (leadByRestaurant.has(String(r._id)) ? 0 : sc.ownZips.has(String(r.postal_code)) ? 1 : 2);
  const restaurants = scraped.filter((r) => r.status !== "failed").sort((a, b) => rank(a) - rank(b));
  const geoById = await locateRestaurants(restaurants, lookups.left);

  const perZip = new Map();
  const count = (r, field) => {
    const zip = String(r.postal_code || "");
    if (!perZip.has(zip)) perZip.set(zip, { postalCode: zip, own: sc.ownZips.has(zip), scraped: 0, shown: 0, outside: 0, customers: 0, unlocated: 0, pending: 0, failed: 0 });
    const row = perZip.get(zip);
    row.scraped++;
    row[field]++;
  };
  scraped.forEach((r) => {
    if (r.status === "failed") return count(r, "failed");
    const geo = geoById.get(String(r._id));
    const lead = leadByRestaurant.get(String(r._id));
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
    // A scraped place with the same name as a customer here is that customer.
    if (customerNames.has(normName(r.name))) return count(r, "customers");
    if (!sc.inScope(geo, r.postal_code)) {
      if (lead) out.leadsOutside++;
      return count(r, "outside");
    }
    count(r, "shown");
    if (lead) out.scrapedLeadsTotal++;
    out.prospects.push({
      id: String(r._id),
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
  out.prospectStats = { scraped: sum("scraped"), shown: sum("shown"), outside: sum("outside"), customers: sum("customers"), unlocated: sum("unlocated"), pending: sum("pending"), failed: sum("failed") };
  // Still to place in the scope's own postal codes: the page keeps loading for these.
  out.ownPending = out.prospectsByPostalCode.filter((z) => z.own).reduce((n, z) => n + z.pending, 0);
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

    const codes = sc.scope === "all" ? null : [...sc.customers.map((c) => c.CardCode), ...sc.unpinnedCodes];
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
    const leads = wantOthers ? await manualLeadsFor(sc, lookups) : { manualLeads: [], leadsPending: 0, leadsUnlocated: 0, leadsOutside: 0, leadsNoPostalCode: 0 };
    const pros = wantOthers ? await prospectsFor(sc, lookups, customerNames) : { prospects: [], prospectsByPostalCode: [], prospectsPending: 0, prospectsUnlocated: 0, scrapedLeadsTotal: 0, leadsPending: 0, leadsUnlocated: 0, leadsOutside: 0 };

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
      prospectsByPostalCode: pros.prospectsByPostalCode,
      ownPending: pros.ownPending || 0,
    });
  } catch (error) {
    console.error("Sales map error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// GET /api/map/prospect/:id - the details of one scraped restaurant (the
// whole-map view only carries name and position).
exports.getProspect = async (req, res) => {
  try {
    const r = await ScrapedRestaurant.findById(req.params.id).select("name url postal_code menu_items_count contact_info scraped_at").lean();
    if (!r) return res.status(404).json({ message: "Not found" });
    res.json({
      id: String(r._id),
      name: r.name,
      postalCode: r.postal_code,
      address: usable(r.contact_info?.address),
      phone: usable(r.contact_info?.phone),
      email: usable(r.contact_info?.email),
      url: r.url,
      menuItems: r.menu_items_count || 0,
      scrapedAt: r.scraped_at,
    });
  } catch (error) {
    res.status(error.name === "CastError" ? 404 : 500).json({ message: error.name === "CastError" ? "Not found" : "Server error" });
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
