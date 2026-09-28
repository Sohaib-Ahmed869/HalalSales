// controllers/map.controller.js
const Invoice = require("../models/Invoice");
const SalesOrder = require("../models/SalesOrder");
const Customer = require("../models/Customer");
const { geocodeCustomer } = require("../utils/geocodingService");

function tenantFromReq(req) {
  return req.query.tenant || "halal-food-sales";
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
    const customers = await Customer.find({ CardCode: { $in: cardCodes } });
    const customersByCode = new Map(customers.map((c) => [c.CardCode, c]));

    if (aggregate === "false") {
      const locations = [];
      invoices.forEach((doc) => {
        const c = customersByCode.get(doc.CardCode);
        if (c?.geo?.lat && c?.geo?.lng) {
          locations.push({
            type: "invoice",
            docEntry: doc.DocEntry,
            docNum: doc.DocNum,
            cardCode: doc.CardCode,
            cardName: doc.CardName,
            amount: doc.DocTotal,
            coordinates: { lat: c.geo.lat, lng: c.geo.lng },
          });
        }
      });
      orders.forEach((doc) => {
        const c = customersByCode.get(doc.CardCode);
        if (c?.geo?.lat && c?.geo?.lng) {
          locations.push({
            type: "order",
            docEntry: doc.DocEntry,
            docNum: doc.DocNum,
            cardCode: doc.CardCode,
            cardName: doc.CardName,
            amount: doc.DocTotal,
            coordinates: { lat: c.geo.lat, lng: c.geo.lng },
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
        byCustomer.set(cardCode, {
          id: cardCode,
          cardCode,
          cardName: c?.CardName,
          coordinates: c?.geo?.lat && c?.geo?.lng ? { lat: c.geo.lat, lng: c.geo.lng } : null,
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

    const regex = new RegExp(search.trim(), "i");
    const customers = await Customer.find({
      $or: [{ CardName: regex }, { CardCode: regex }],
    }).limit(20);

    res.json({ customers });
  } catch (error) {
    console.error("Search customers error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.getGeocodingStats = async (req, res) => {
  try {
    const [total, ok, pending, failed, manual] = await Promise.all([
      Customer.countDocuments({}),
      Customer.countDocuments({ "geo.geocodeStatus": "ok" }),
      Customer.countDocuments({
        $or: [{ "geo.geocodeStatus": { $exists: false } }, { "geo.geocodeStatus": "pending" }],
      }),
      Customer.countDocuments({ "geo.geocodeStatus": "failed" }),
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
