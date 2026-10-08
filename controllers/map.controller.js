// controllers/map.controller.js
const Invoice = require("../models/Invoice");
const SalesOrder = require("../models/SalesOrder");
const Customer = require("../models/Customer");
const Quotation = require("../models/Quotation");
const { ScrapedRestaurant, ScrapedRestaurantGeo } = require("../models/ScrapedRestaurant");
const SalesLead = require("../models/SalesLead");
const SalesLeadGeo = require("../models/SalesLeadGeo");
const { geocodeCustomer, geocodeAddress, deliveryPoint, deliveryAddressOf } = require("../utils/geocodingService");
const { haversineKm } = require("../utils/routeOptimizer");

function tenantFromReq(req) {
  return req.query.tenant || "halal-food-sales";
}

// customer.coordinates is a pre-existing field (populated for 7,289 real
// customers by an external sync, not declared in models/Customer.js — only
// visible via .lean()/.toObject(), never via direct property access on a
// hydrated Mongoose document). customer.geo is this feature's own field,
// used for customers geocoded going forward via the Google API key in
// customer.controller.js. Check coordinates first since that's where the
// real, already-populated data is.
// Prefers the pin for the delivery address (deliveryPoint); until that is
// geocoded, falls back to whatever pin exists so the reference map keeps
// showing the customer.
function customerGeo(customer) {
  const point = deliveryPoint(customer);
  if (point.coords) return point.coords;
  if (customer?.coordinates?.lat != null && customer?.coordinates?.lng != null) return customer.coordinates;
  if (customer?.geo?.lat != null && customer?.geo?.lng != null) return customer.geo;
  return null;
}

async function fetchDocsInRange(type, startDate, endDate) {
  const range = { $gte: new Date(startDate), $lte: new Date(endDate) };
  const docs = { invoices: [], orders: [] };

  if (type === "all" || type === "invoice") {
    docs.invoices = await Invoice.find({ DocDate: range });
  }
  if (type === "all" || type === "order") {
    docs.orders = await SalesOrder.find({ DocDate: range });
  }
  return docs;
}

// GET /api/map/documents — one marker per physical customer location
// (aggregate=true, the default) rather than one per document, so a customer
// with 50 invoices in the range still produces a single map pin with a count.
exports.getDocuments = async (req, res) => {
  try {
    const { startDate, endDate, type = "all", aggregate = "true" } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ message: "startDate and endDate are required" });
    }

    const { invoices, orders } = await fetchDocsInRange(type, startDate, endDate);

    const cardCodes = [...new Set([...invoices.map((i) => i.CardCode), ...orders.map((o) => o.CardCode)])];
    const customers = await Customer.find({ CardCode: { $in: cardCodes } }).lean();
    const customersByCode = new Map(customers.map((c) => [c.CardCode, c]));

    if (aggregate === "false") {
      const locations = [];
      invoices.forEach((doc) => {
        const c = customersByCode.get(doc.CardCode);
        const geo = customerGeo(c);
        if (geo) {
          locations.push({
            type: "invoice",
            docEntry: doc.DocEntry,
            docNum: doc.DocNum,
            cardCode: doc.CardCode,
            cardName: doc.CardName,
            amount: doc.DocTotal,
            coordinates: { lat: geo.lat, lng: geo.lng },
          });
        }
      });
      orders.forEach((doc) => {
        const c = customersByCode.get(doc.CardCode);
        const geo = customerGeo(c);
        if (geo) {
          locations.push({
            type: "order",
            docEntry: doc.DocEntry,
            docNum: doc.DocNum,
            cardCode: doc.CardCode,
            cardName: doc.CardName,
            amount: doc.DocTotal,
            coordinates: { lat: geo.lat, lng: geo.lng },
          });
        }
      });
      return res.json({ markers: locations });
    }

    // Aggregate: one entry per geocoded customer location.
    const byCustomer = new Map();
    const ensureLocation = (cardCode) => {
      if (!byCustomer.has(cardCode)) {
        const c = customersByCode.get(cardCode);
        const geo = customerGeo(c);
        byCustomer.set(cardCode, {
          id: cardCode,
          cardCode,
          cardName: c?.CardName,
          coordinates: geo ? { lat: geo.lat, lng: geo.lng } : null,
          isPotential: !c,
          invoiceCount: 0,
          orderCount: 0,
          quotationCount: 0,
          invoiceTotal: 0,
        });
      }
      return byCustomer.get(cardCode);
    };

    invoices.forEach((doc) => {
      const loc = ensureLocation(doc.CardCode);
      loc.invoiceCount++;
      loc.invoiceTotal += doc.DocTotal || 0;
    });
    orders.forEach((doc) => {
      const loc = ensureLocation(doc.CardCode);
      loc.orderCount++;
    });

    const locations = [...byCustomer.values()].filter((l) => l.coordinates);

    res.json({ locations });
  } catch (error) {
    console.error("Get map documents error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.getCustomerDocuments = async (req, res) => {
  try {
    const { cardCode } = req.params;
    const { type = "all", startDate, endDate } = req.query;

    const range =
      startDate && endDate ? { $gte: new Date(startDate), $lte: new Date(endDate) } : undefined;

    const invoiceQuery = { CardCode: cardCode };
    if (range) invoiceQuery.DocDate = range;
    const orderQuery = { CardCode: cardCode };
    if (range) orderQuery.DocDate = range;

    const [invoices, orders] = await Promise.all([
      type === "all" || type === "invoice" ? Invoice.find(invoiceQuery) : [],
      type === "all" || type === "order" ? SalesOrder.find(orderQuery) : [],
    ]);

    res.json({ invoices, orders });
  } catch (error) {
    console.error("Get customer map documents error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.searchCustomers = async (req, res) => {
  try {
    const { search } = req.query;
    if (!search || search.trim().length === 0) {
      return res.json({ customers: [] });
    }

    const regex = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    // .lean(): the synced `coordinates` / `deliveryAddress` fields aren't in the schema.
    const customers = await Customer.find({
      $or: [{ CardName: regex }, { CardCode: regex }],
    })
      .limit(20)
      .lean();

    const rows = customers.map((c) => {
      const address = deliveryAddressOf(c);
      return {
        _id: c._id,
        CardCode: c.CardCode,
        CardName: c.CardName,
        address,
        hasLocation: Boolean(customerGeo(c)),
        // An address is enough: its pin is worked out when the customer is picked.
        hasAddress: Boolean(address && (String(address.street || "").trim() || String(address.zipCode || "").trim())),
      };
    });
    const rank = (r) => (r.hasLocation ? 0 : r.hasAddress ? 1 : 2);
    res.json({ customers: rows.sort((a, b) => rank(a) - rank(b)) });
  } catch (error) {
    console.error("Search customers error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.getGeocodingStats = async (req, res) => {
  try {
    const [total, ok, pending, failed, manual] = await Promise.all([
      Customer.countDocuments({}),
      // "ok" = has a usable geocode either way: the pre-existing
      // customer.coordinates field (the real data for most customers) or
      // this feature's own customer.geo field.
      Customer.countDocuments({
        $or: [{ "coordinates.lat": { $exists: true, $ne: null } }, { "geo.geocodeStatus": "ok" }],
      }),
      Customer.countDocuments({
        "coordinates.lat": { $exists: false },
        $or: [{ "geo.geocodeStatus": { $exists: false } }, { "geo.geocodeStatus": "pending" }],
      }),
      Customer.countDocuments({ "coordinates.lat": { $exists: false }, "geo.geocodeStatus": "failed" }),
      Customer.countDocuments({ "geo.geocodeStatus": "manual" }),
    ]);

    res.json({ stats: { total, ok, pending, failed, manual } });
  } catch (error) {
    console.error("Get geocoding stats error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Batch-geocodes customers that have an address but no successful geocode yet.
// Admin-triggered, rate-limited sequentially (not parallel) to stay well
// under Google's per-second quota.
exports.batchGeocode = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 100;

    const candidates = await Customer.find({
      $and: [
        { $or: [{ "address.street": { $ne: null } }, { "address.zipCode": { $ne: null } }] },
        // Skip customers that already have a usable geocode from either
        // source — no point spending a Google API call re-geocoding
        // someone the pre-existing coordinates field already covers.
        { "coordinates.lat": { $exists: false } },
        { $or: [{ "geo.geocodeStatus": { $exists: false } }, { "geo.geocodeStatus": { $in: ["pending", "failed"] } }] },
      ],
    }).limit(limit);

    let succeeded = 0;
    let failed = 0;
    for (const customer of candidates) {
      const result = await geocodeCustomer(customer);
      if (result.geo?.geocodeStatus === "ok") succeeded++;
      else failed++;
    }

    res.json({
      message: `Geocoded ${candidates.length} customer(s)`,
      attempted: candidates.length,
      succeeded,
      failed,
    });
  } catch (error) {
    console.error("Batch geocode error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.setCustomerCoordinates = async (req, res) => {
  try {
    const { cardCode } = req.params;
    const { lat, lng } = req.body;

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ message: "lat and lng must be numbers" });
    }

    const customer = await Customer.findOneAndUpdate(
      { CardCode: cardCode },
      {
        geo: {
          lat,
          lng,
          geocodedAt: new Date(),
          geocodeStatus: "manual",
        },
      },
      { new: true }
    );

    if (!customer) return res.status(404).json({ message: "Customer not found" });

    res.json({ message: "Coordinates set", customer });
  } catch (error) {
    console.error("Set customer coordinates error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// ---------- Sales map: who is around a customer ----------

const NEARBY_MAX_CUSTOMERS = 400;
const NEARBY_MAX_POTENTIALS = 1500;
// Scraped restaurants read per request (the customer's own postal code first).
const NEARBY_MAX_SCRAPED = 20000;
// New scraped addresses located per request (each is one geocoding lookup);
// the rest are reported as `potentialsPending` and done on the next requests.
const GEOCODE_PER_REQUEST = () => Number(process.env.SALES_MAP_GEOCODE_PER_REQUEST) || 25;

const normName = (v) =>
  String(v || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const usable = (v) => (v && v !== "N/A" ? String(v).trim() : "");

// Pins for scraped restaurants: stored ones, plus up to `budget` new lookups.
async function locateRestaurants(restaurants, budget) {
  const known = await ScrapedRestaurantGeo.find({ restaurantId: { $in: restaurants.map((r) => r._id) } }).lean();
  const geoById = new Map(known.map((g) => [String(g.restaurantId), g]));
  const todo = restaurants.filter((r) => !geoById.has(String(r._id))).slice(0, budget);

  for (let i = 0; i < todo.length; i += 5) {
    await Promise.all(
      todo.slice(i, i + 5).map(async (r) => {
        const street = usable(r.contact_info?.address) || usable(r.name);
        let hit = null;
        try {
          hit = await geocodeAddress({ street, zipCode: r.postal_code, country: "France" }, `scraped:${r._id}`);
        } catch (error) {
          hit = null;
        }
        const doc = hit
          ? { restaurantId: r._id, lat: hit.lat, lng: hit.lng, status: "ok", source: hit.source, confidence: hit.confidence, geocodedAt: new Date() }
          : { restaurantId: r._id, status: "failed", geocodedAt: new Date() };
        await ScrapedRestaurantGeo.updateOne({ restaurantId: r._id }, { $set: doc }, { upsert: true });
        geoById.set(String(r._id), doc);
      })
    );
  }
  return geoById;
}

// GET /api/map/nearby?cardCode=C123&radiusKm=5[&potential=false]
// The customer, the existing customers around them and the potential
// customers (scraped restaurants) around them, each with its distance.
exports.getNearby = async (req, res) => {
  try {
    const { cardCode } = req.query;
    const radiusKm = Math.min(Math.max(Number(req.query.radiusKm) || 5, 0.5), 50);
    if (!cardCode) return res.status(400).json({ message: "cardCode is required" });

    let centerCustomer = await Customer.findOne({ CardCode: cardCode }).lean();
    if (!centerCustomer) return res.status(404).json({ message: "Customer not found" });
    let centerGeo = customerGeo(centerCustomer);
    if (!centerGeo) {
      // Not on the map yet: locate the address now, like Logistics does when
      // one of the customer's orders is planned.
      const address = deliveryAddressOf(centerCustomer);
      if (!address || !(String(address.street || "").trim() || String(address.zipCode || "").trim())) {
        return res.status(400).json({ message: `${centerCustomer.CardName} has no address on file, so it can't be placed on the map. Add the address on the Customers page.` });
      }
      const doc = await Customer.findOne({ CardCode: cardCode });
      await geocodeCustomer(doc);
      centerCustomer = await Customer.findOne({ CardCode: cardCode }).lean();
      centerGeo = customerGeo(centerCustomer);
      if (!centerGeo) {
        return res.status(400).json({ message: `The address of ${centerCustomer.CardName} could not be found on the map. Check it on the Customers page.` });
      }
    }
    const center = { lat: centerGeo.lat, lng: centerGeo.lng };

    const dLat = radiusKm / 111.32;
    const dLng = radiusKm / (111.32 * Math.cos((center.lat * Math.PI) / 180));
    const box = (field) => ({
      [`${field}.lat`]: { $gte: center.lat - dLat, $lte: center.lat + dLat },
      [`${field}.lng`]: { $gte: center.lng - dLng, $lte: center.lng + dLng },
    });
    const around = await Customer.find({ $or: [box("coordinates"), box("geo")] })
      .select("CardCode CardName address deliveryAddress coordinates geo phoneNumber status assignedTo")
      .limit(5000)
      .lean();

    const zips = new Set();
    const addZip = (c) => {
      const zip = String(deliveryAddressOf(c)?.zipCode || "").trim();
      if (zip) zips.add(zip);
    };
    addZip(centerCustomer);

    const customers = [];
    around.forEach((c) => {
      const geo = customerGeo(c);
      if (!geo) return;
      const distanceKm = haversineKm(center, geo);
      if (distanceKm > radiusKm) return;
      addZip(c);
      if (c.CardCode === cardCode) return;
      customers.push({
        cardCode: c.CardCode,
        cardName: c.CardName,
        address: deliveryAddressOf(c),
        phone: c.phoneNumber,
        status: c.status,
        coordinates: { lat: geo.lat, lng: geo.lng },
        distanceKm: Math.round(distanceKm * 100) / 100,
      });
    });
    // Customers in these postal codes that have an address but no pin yet:
    // locate a few per request (each is one geocoding lookup), the rest next time.
    let customersPending = 0;
    if (zips.size > 0) {
      const numeric = (f) => ({ [`${f}.lat`]: { $type: "number" } });
      const unpinned = {
        $nor: [numeric("coordinates"), numeric("geo")],
        "geo.geocodeStatus": { $ne: "failed" },
        $or: [{ "address.zipCode": { $in: [...zips] } }, { "deliveryAddress.zipCode": { $in: [...zips] } }],
      };
      const budget = GEOCODE_PER_REQUEST();
      const [todo, waiting] = await Promise.all([Customer.find(unpinned).limit(budget), Customer.countDocuments(unpinned)]);
      customersPending = Math.max(0, waiting - todo.length);
      for (let i = 0; i < todo.length; i += 5) {
        await Promise.all(
          todo.slice(i, i + 5).map(async (doc) => {
            try {
              await geocodeCustomer(doc);
            } catch (error) {
              return;
            }
            const c = doc.toObject();
            const geo = customerGeo(c);
            if (!geo || c.CardCode === cardCode) return;
            const distanceKm = haversineKm(center, geo);
            if (distanceKm > radiusKm) return;
            around.push(c);
            customers.push({
              cardCode: c.CardCode,
              cardName: c.CardName,
              address: deliveryAddressOf(c),
              phone: c.phoneNumber,
              status: c.status,
              coordinates: { lat: geo.lat, lng: geo.lng },
              distanceKm: Math.round(distanceKm * 100) / 100,
            });
          })
        );
      }
    }
    customers.sort((a, b) => a.distanceKm - b.distanceKm);

    // Potential customers: the scraped restaurants of the postal codes found
    // above. The picked customer's own postal code is read and located first,
    // so its restaurants are complete before the wider area's. Every scraped
    // restaurant is accounted for per postal code (shown, outside the circle,
    // already a customer, not found, still to place, failed scrape) so the list
    // can be compared with the Postal Scraping page.
    let potentials = [];
    let potentialsPending = 0;
    let potentialsUnlocated = 0;
    const centerZip = String(deliveryAddressOf(centerCustomer)?.zipCode || "").trim();
    const perZip = new Map();
    let potentialLeadsTotal = 0;
    let leadsPending = 0;
    let leadsUnlocated = 0;
    let leadsOutside = 0;

    // Leads typed by hand or imported on the Leads page: no scraped restaurant
    // behind them, so they are placed from their own address (once, the pin kept
    // in SalesLeadGeo). They are few and come before every other lookup.
    let lookupsLeft = GEOCODE_PER_REQUEST();
    const manualLeads = [];
    let leadsNoPostalCode = 0;
    if (req.query.potential !== "false" && zips.size > 0) {
      const open = { relatedRestaurant: null, status: { $ne: "converted" } };
      const docs = await SalesLead.find({ ...open, "address.zipCode": { $in: [...zips] } })
        .select("fullName company status tags sourceType address phoneNumber email")
        .limit(2000)
        .lean();
      const keyOf = (l) => normName([l.address?.street, l.address?.zipCode, l.address?.city].join(" "));
      const known = await SalesLeadGeo.find({ leadId: { $in: docs.map((l) => l._id) } }).lean();
      const geoByLead = new Map(known.map((g) => [String(g.leadId), g]));
      // A pin made from an address that has since been changed does not count.
      const pinOf = (l) => {
        const g = geoByLead.get(String(l._id));
        return g && g.addressKey === keyOf(l) ? g : null;
      };
      const todo = docs.filter((l) => !pinOf(l)).slice(0, lookupsLeft);
      for (let i = 0; i < todo.length; i += 5) {
        await Promise.all(
          todo.slice(i, i + 5).map(async (l) => {
            const zipCode = String(l.address.zipCode).trim();
            // Without a street, the company or the name is searched in that postal code.
            const street = usable(l.address.street) || usable(l.company) || usable(l.fullName);
            // The Leads form fills in "England" by default; a five-digit postal code is French.
            const country = /^\d{5}$/.test(zipCode) ? "France" : l.address.country;
            let hit = null;
            try {
              hit = await geocodeAddress({ street, zipCode, city: l.address.city, country }, `lead:${l._id}`);
            } catch (error) {
              hit = null;
            }
            const doc = hit
              ? { leadId: l._id, addressKey: keyOf(l), lat: hit.lat, lng: hit.lng, status: "ok", source: hit.source, confidence: hit.confidence, geocodedAt: new Date() }
              : { leadId: l._id, addressKey: keyOf(l), status: "failed", geocodedAt: new Date() };
            await SalesLeadGeo.updateOne({ leadId: l._id }, { $set: doc }, { upsert: true });
            geoByLead.set(String(l._id), doc);
          })
        );
      }
      lookupsLeft -= todo.length;
      docs.forEach((l) => {
        const geo = pinOf(l);
        if (!geo) return leadsPending++;
        if (geo.status !== "ok") return leadsUnlocated++;
        const distanceKm = haversineKm(center, geo);
        if (distanceKm > radiusKm) return leadsOutside++;
        manualLeads.push({
          id: String(l._id),
          name: l.fullName,
          company: usable(l.company),
          status: l.status || "new",
          tags: l.tags || [],
          sourceType: l.sourceType || "manual",
          address: usable(l.address.street),
          city: usable(l.address.city),
          postalCode: String(l.address.zipCode).trim(),
          phone: usable(l.phoneNumber),
          email: usable(l.email),
          coordinates: { lat: geo.lat, lng: geo.lng },
          approximate: geo.confidence === "low" || !usable(l.address.street),
          distanceKm: Math.round(distanceKm * 100) / 100,
        });
      });
      manualLeads.sort((a, b) => a.distanceKm - b.distanceKm);
      // Open leads that can never be matched to an area: no postal code at all.
      leadsNoPostalCode = await SalesLead.countDocuments({ ...open, status: { $nin: ["converted", "dead"] }, "address.zipCode": { $in: [null, ""] } });
    }

    if (req.query.potential !== "false" && zips.size > 0) {
      const fields = "name url postal_code menu_items_count contact_info scraped_at status";
      const own = centerZip ? await ScrapedRestaurant.find({ postal_code: centerZip }).select(fields).limit(NEARBY_MAX_SCRAPED).lean() : [];
      const otherZips = [...zips].filter((z) => z !== centerZip);
      const others =
        otherZips.length > 0 && own.length < NEARBY_MAX_SCRAPED
          ? await ScrapedRestaurant.find({ postal_code: { $in: otherZips } }).select(fields).limit(NEARBY_MAX_SCRAPED - own.length).lean()
          : [];
      const scraped = [...own, ...others];
      // Scraped restaurants that the Leads page turned into a lead (a lead that
      // became a customer is left out: that customer is on the map already).
      const leadDocs =
        scraped.length > 0
          ? await SalesLead.find({ relatedRestaurant: { $in: scraped.map((r) => r._id) }, status: { $ne: "converted" } })
              .select("fullName company status tags relatedRestaurant")
              .lean()
          : [];
      const leadByRestaurant = new Map(leadDocs.map((l) => [String(l.relatedRestaurant), l]));
      // Located in this order: the leads of the area (few, and what the user
      // looks for), then the customer's own postal code, then everything else.
      const rank = (r) => (leadByRestaurant.has(String(r._id)) ? 0 : String(r.postal_code) === centerZip ? 1 : 2);
      const restaurants = scraped.filter((r) => r.status !== "failed").sort((a, b) => rank(a) - rank(b));
      const geoById = await locateRestaurants(restaurants, lookupsLeft);
      // A scraped place with the same name as a customer here is that customer.
      const customerNames = new Set([centerCustomer, ...around].map((c) => normName(c.CardName)).filter(Boolean));
      const count = (r, field) => {
        const zip = String(r.postal_code || "");
        if (!perZip.has(zip)) perZip.set(zip, { postalCode: zip, scraped: 0, shown: 0, outside: 0, customers: 0, unlocated: 0, pending: 0, failed: 0 });
        const row = perZip.get(zip);
        row.scraped++;
        row[field]++;
      };
      scraped.forEach((r) => {
        if (r.status === "failed") return count(r, "failed");
        const geo = geoById.get(String(r._id));
        const lead = leadByRestaurant.get(String(r._id));
        if (!geo) {
          potentialsPending++;
          if (lead) leadsPending++;
          return count(r, "pending");
        }
        if (geo.status !== "ok") {
          potentialsUnlocated++;
          if (lead) leadsUnlocated++;
          return count(r, "unlocated");
        }
        if (customerNames.has(normName(r.name))) return count(r, "customers");
        const distanceKm = haversineKm(center, geo);
        if (distanceKm > radiusKm) {
          if (lead) leadsOutside++;
          return count(r, "outside");
        }
        count(r, "shown");
        if (lead) potentialLeadsTotal++;
        potentials.push({
          lead: lead ? { id: String(lead._id), name: lead.fullName, status: lead.status || "new", tags: lead.tags || [] } : null,
          id: String(r._id),
          name: r.name,
          address: usable(r.contact_info?.address),
          postalCode: r.postal_code,
          phone: usable(r.contact_info?.phone),
          email: usable(r.contact_info?.email),
          url: r.url,
          menuItems: r.menu_items_count || 0,
          scrapedAt: r.scraped_at,
          coordinates: { lat: geo.lat, lng: geo.lng },
          approximate: geo.confidence === "low",
          distanceKm: Math.round(distanceKm * 100) / 100,
        });
      });
      potentials.sort((a, b) => a.distanceKm - b.distanceKm);
    }
    const potentialsByPostalCode = [...perZip.values()].sort(
      (a, b) => (b.postalCode === centerZip) - (a.postalCode === centerZip) || b.scraped - a.scraped || a.postalCode.localeCompare(b.postalCode)
    );

    res.json({
      center: {
        cardCode: centerCustomer.CardCode,
        cardName: centerCustomer.CardName,
        address: deliveryAddressOf(centerCustomer),
        phone: centerCustomer.phoneNumber,
        coordinates: center,
      },
      radiusKm,
      customers: customers.slice(0, NEARBY_MAX_CUSTOMERS),
      customersTotal: customers.length,
      leadsTotal: customers.filter((c) => c.status === "lead" || c.status === "prospect").length,
      customersPending,
      potentials: potentials.slice(0, NEARBY_MAX_POTENTIALS),
      potentialsTotal: potentials.length,
      potentialsPending,
      potentialsUnlocated,
      potentialLeadsTotal,
      leadsPending,
      leadsUnlocated,
      leadsOutside,
      manualLeads,
      manualLeadsTotal: manualLeads.length,
      leadsNoPostalCode,
      potentialsByPostalCode,
      centerPostalCode: centerZip,
      postalCodes: [...zips].sort(),
    });
  } catch (error) {
    console.error("Nearby customers error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// ---------- Sales map: every customer, with their activity in a period ----------

// Documents of one kind per customer in the period: { CardCode -> { count, total } }.
async function activityByCustomer(Model, range) {
  const rows = await Model.aggregate([
    { $match: { DocDate: range } },
    { $group: { _id: "$CardCode", count: { $sum: 1 }, total: { $sum: { $ifNull: ["$DocTotal", 0] } } } },
  ]);
  return new Map(rows.filter((r) => r._id).map((r) => [r._id, r]));
}

// GET /api/map/overview?startDate=&endDate=[&inactive=false]
// One entry per customer that has a pin: how many invoices, sales orders and
// quotations they had in the period (and the totals). Customers with nothing
// in the period are included too (inactive=false leaves them out), so the map
// can show who is not buying.
exports.getOverview = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ message: "startDate and endDate are required" });
    const from = new Date(startDate);
    from.setHours(0, 0, 0, 0);
    const to = new Date(endDate);
    to.setHours(23, 59, 59, 999);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      return res.status(400).json({ message: "Invalid date range" });
    }
    const range = { $gte: from, $lte: to };

    const [invoices, orders, quotations] = await Promise.all([
      activityByCustomer(Invoice, range),
      activityByCustomer(SalesOrder, range),
      activityByCustomer(Quotation, range).catch(() => new Map()),
    ]);
    const active = new Set([...invoices.keys(), ...orders.keys(), ...quotations.keys()]);

    const numeric = (f) => ({ [`${f}.lat`]: { $type: "number" } });
    const pinned = { $or: [numeric("coordinates"), numeric("geo")] };
    const query = req.query.inactive === "false" ? { CardCode: { $in: [...active] } } : pinned;
    const customers = await Customer.find(query)
      .select("CardCode CardName address deliveryAddress coordinates geo phoneNumber")
      .lean();

    const round = (n) => Math.round(n * 100) / 100;
    const locations = [];
    let activeDrawn = 0;
    customers.forEach((c) => {
      const geo = customerGeo(c);
      if (!geo) return;
      if (active.has(c.CardCode)) activeDrawn++;
      const inv = invoices.get(c.CardCode);
      const ord = orders.get(c.CardCode);
      const quo = quotations.get(c.CardCode);
      const address = deliveryAddressOf(c) || {};
      locations.push({
        cardCode: c.CardCode,
        cardName: c.CardName,
        zipCode: address.zipCode || "",
        city: address.city || "",
        street: address.street || "",
        phone: c.phoneNumber || "",
        lat: geo.lat,
        lng: geo.lng,
        invoiceCount: inv ? inv.count : 0,
        invoiceTotal: inv ? round(inv.total) : 0,
        orderCount: ord ? ord.count : 0,
        orderTotal: ord ? round(ord.total) : 0,
        quotationCount: quo ? quo.count : 0,
        quotationTotal: quo ? round(quo.total) : 0,
      });
    });

    const sum = (m) => [...m.values()].reduce((n, r) => n + r.count, 0);
    res.json({
      startDate,
      endDate,
      locations,
      totals: {
        customers: locations.length,
        invoices: sum(invoices),
        orders: sum(orders),
        quotations: sum(quotations),
        activeCustomers: active.size,
        // customers with documents in the period that can't be drawn (no pin yet)
        activeWithoutPin: Math.max(0, active.size - activeDrawn),
      },
    });
  } catch (error) {
    console.error("Map overview error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};
