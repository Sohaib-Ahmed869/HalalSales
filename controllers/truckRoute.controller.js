// controllers/truckRoute.controller.js
const TruckSchedule = require("../models/TruckSchedule");
const TruckRoute = require("../models/TruckRoute");
const Customer = require("../models/Customer");
const DeliveryNote = require("../models/DeliveryNote");
const Item = require("../models/item");
const {
  sweepCluster,
  sequenceRoute,
  parseTimeToMinutes,
  pickSmallestFittingTruck,
  crossRouteImprove,
} = require("../utils/routeOptimizer");
const { getWarehouse, regionForAddress } = require("../utils/regions");
const { geocodeCustomer } = require("../utils/geocodingService");

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function dayOfWeekFor(dateStr) {
  const d = new Date(dateStr);
  return DAY_NAMES[d.getDay()];
}

function tenantFromReq(req) {
  return req.query.tenant || req.body.tenant || "halal-food-sales";
}

// ---------- Weekly templates (schedules) ----------

exports.getSchedules = async (req, res) => {
  try {
    const schedules = await TruckSchedule.find({ tenant: tenantFromReq(req) }).sort({
      dayOfWeek: 1,
      region: 1,
    });
    res.json({ schedules });
  } catch (error) {
    console.error("Get schedules error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Create or update. Matches the fact that TruckSchedules.jsx sends the same
// payload for both create and edit; if the body carries an existing `_id`,
// this upserts instead of creating a duplicate.
exports.createSchedule = async (req, res) => {
  try {
    const { _id, dayOfWeek, region, departments, cities, trucks, isActive } = req.body;

    if (!dayOfWeek || !trucks || trucks.length === 0) {
      return res.status(400).json({ message: "dayOfWeek and at least one truck are required" });
    }

    const data = {
      dayOfWeek,
      region,
      departments: departments || [],
      cities: cities || [],
      trucks,
      isActive: isActive !== undefined ? isActive : true,
      tenant: tenantFromReq(req),
    };

    let schedule;
    if (_id) {
      schedule = await TruckSchedule.findByIdAndUpdate(_id, data, {
        new: true,
        upsert: true,
        runValidators: true,
      });
    } else {
      schedule = await TruckSchedule.create(data);
    }

    res.status(201).json({ message: "Schedule saved", schedule });
  } catch (error) {
    console.error("Create schedule error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.updateSchedule = async (req, res) => {
  try {
    const schedule = await TruckSchedule.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!schedule) return res.status(404).json({ message: "Schedule not found" });
    res.json({ message: "Schedule updated", schedule });
  } catch (error) {
    console.error("Update schedule error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.deleteSchedule = async (req, res) => {
  try {
    const schedule = await TruckSchedule.findByIdAndDelete(req.params.id);
    if (!schedule) return res.status(404).json({ message: "Schedule not found" });
    res.json({ message: "Schedule deleted" });
  } catch (error) {
    console.error("Delete schedule error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// ---------- Per-date routes ----------

exports.initializeDate = async (req, res) => {
  try {
    const { date } = req.body;
    if (!date) return res.status(400).json({ message: "date is required" });

    const tenant = tenantFromReq(req);
    const weekday = dayOfWeekFor(date);
    const schedules = await TruckSchedule.find({
      dayOfWeek: weekday,
      isActive: true,
      tenant,
    });

    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);

    let created = 0;
    let skipped = 0;

    for (const schedule of schedules) {
      for (const truck of schedule.trucks) {
        const exists = await TruckRoute.findOne({
          date: dayStart,
          truckNumber: truck.truckNumber,
          region: schedule.region,
        });
        if (exists) {
          skipped++;
          continue;
        }

        await TruckRoute.create({
          date: dayStart,
          truckNumber: truck.truckNumber,
          truckName: truck.truckName || `Truck ${truck.truckNumber}`,
          truckType: truck.truckType,
          maxWeightKg: truck.maxWeightKg,
          region: schedule.region,
          departments: schedule.departments,
          cities: schedule.cities,
          scheduleId: schedule._id,
          tenant,
          status: "planning",
          orders: [],
        });
        created++;
      }
    }

    res.json({
      message: `Initialized ${created} truck route(s) for ${weekday} ${date}`,
      created,
      skipped,
      weekday,
    });
  } catch (error) {
    console.error("Initialize date error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.getRoutesByDate = async (req, res) => {
  try {
    const { date } = req.params;
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(23, 59, 59, 999);

    const routes = await TruckRoute.find({
      date: { $gte: dayStart, $lte: dayEnd },
      tenant: tenantFromReq(req),
    }).sort({ region: 1, truckNumber: 1 });

    res.json({ routes });
  } catch (error) {
    console.error("Get routes by date error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.getSingleRoute = async (req, res) => {
  try {
    const route = await TruckRoute.findById(req.params.routeId);
    if (!route) return res.status(404).json({ message: "Route not found" });
    res.json({ route });
  } catch (error) {
    console.error("Get single route error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// ---------- Deliverable orders (real SAP DeliveryNote documents) ----------
//
// Originally this queried Invoice.isDelivery === true, matching the SAP
// document flow assumption in implementation.md (Order -> Delivery ->
// Invoice). Checked against the real data: isDelivery is essentially never
// true (0 across ~40k invoices/month except a one-off blip), while a real,
// currently-synced DeliveryNote collection already exists (ported from
// models/DeliveryNote.js) with correct, current data — that's SAP's actual
// "this needs to physically leave the warehouse" document, so it's the
// correct source, not a substitute for one.

// customer is a plain .lean() object here (from customersByCode), not a
// Mongoose document — geocodeCustomer() needs a real document to .save(),
// so this re-fetches one, geocodes it, then mutates the shared lean object
// in place so every other reference to this customer within the same
// request (and the customersByCode map itself) sees the new geo immediately
// without a second geocoding call. Silently does nothing if the customer
// already has a usable geocode or has no address to geocode from.
async function ensureGeocoded(customer) {
  if (!customer) return;
  const hasGeo = customer.coordinates?.lat != null || customer.geo?.lat != null;
  if (hasGeo) return;
  const hasAddress = customer.address?.street || customer.address?.zipCode;
  if (!hasAddress) return;

  try {
    const doc = await Customer.findOne({ CardCode: customer.CardCode });
    if (!doc) return;
    await geocodeCustomer(doc);
    if (doc.geo?.geocodeStatus === "ok") {
      customer.geo = { lat: doc.geo.lat, lng: doc.geo.lng, geocodeStatus: "ok" };
    }
  } catch (error) {
    console.error(`On-the-fly geocode failed for ${customer.CardCode}:`, error.message);
  }
}

async function buildDeliverableOrder(deliveryNote, customersByCode, tenant) {
  const customer = customersByCode.get(deliveryNote.CardCode);
  await ensureGeocoded(customer);

  let totalWeight = 0;
  const itemCodes = (deliveryNote.DocumentLines || []).map((l) => l.ItemCode).filter(Boolean);
  if (itemCodes.length > 0) {
    const items = await Item.find({ ItemCode: { $in: itemCodes } });
    const weightByCode = new Map(items.map((it) => [it.ItemCode, it.SalesUnitWeight || 0]));
    totalWeight = (deliveryNote.DocumentLines || []).reduce((sum, line) => {
      const w = weightByCode.get(line.ItemCode) || 0;
      return sum + w * (line.Quantity || 0);
    }, 0);
  }

  // customer.coordinates is a pre-existing field, populated for real
  // customers by an external sync (not declared in models/Customer.js, but
  // Mongoose still surfaces it on read since it's already in the stored
  // document) — the actual usable geocode data. customer.geo is this
  // feature's own field, filled by ensureGeocoded() above (or by
  // customer.controller.js when an address is saved) via
  // utils/geocodingService.js (Photon, free — Google is a second attempt
  // only, that Cloud project's billing is disabled). coordinates is checked
  // first since it's the larger, pre-existing dataset.
  const geoSource =
    customer?.coordinates?.lat != null && customer?.coordinates?.lng != null
      ? customer.coordinates
      : customer?.geo?.lat != null && customer?.geo?.lng != null
      ? customer.geo
      : null;

  // deliveryAddress (where trucks should actually go) takes precedence over
  // the billing address when both exist on the customer record.
  const address = customer ? customer.deliveryAddress || customer.address : undefined;

  return {
    _id: deliveryNote._id,
    DocEntry: deliveryNote.DocEntry,
    DocNum: deliveryNote.DocNum,
    DocDate: deliveryNote.DocDate,
    CardCode: deliveryNote.CardCode,
    CardName: deliveryNote.CardName,
    DocTotal: deliveryNote.DocTotal,
    address,
    totalWeight,
    weightUnit: "kg",
    coordinates: geoSource ? { lat: geoSource.lat, lng: geoSource.lng } : null,
    openingTime: customer ? customer.openingTime : undefined,
    closingTime: customer ? customer.closingTime : undefined,
    geocodeStatus: geoSource ? "ok" : customer?.geo?.geocodeStatus || "pending",
    fulfillmentMethod: customer ? customer.fulfillmentMethod : "delivery",
    // Derived from the customer's postal code via utils/regions.js — the
    // same department->region table the frontend uses, so a truck's region
    // and an order's region mean the same thing on both sides. null when
    // the address/postal code can't be classified (surfaced, never guessed).
    region: customer ? regionForAddress(address, tenant) : null,
  };
}

// Every deliverable DeliveryNote for the date that isn't already assigned to
// a TruckRoute. Excludes pickup customers (never routed at all).
exports.getAvailableOrders = async (req, res) => {
  try {
    const { date } = req.params;
    const { region, department, endDate } = req.query;
    const tenant = tenantFromReq(req);

    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    // Optional browse range — lets the UI show upcoming/past deliverable
    // orders over several days (e.g. "what's coming this week") separately
    // from the single operating date Initialize/Auto-Fill act on. Defaults
    // to just `date` alone when endDate isn't given.
    const dayEnd = new Date(endDate ? new Date(endDate) : dayStart);
    dayEnd.setHours(23, 59, 59, 999);

    const deliveryNotes = await DeliveryNote.find({
      Cancelled: { $ne: "Y" },
      DocDate: { $gte: dayStart, $lte: dayEnd },
    });

    const routes = await TruckRoute.find({ date: { $gte: dayStart, $lte: dayEnd }, tenant });
    const assignedDocEntries = new Set(
      routes.flatMap((r) => r.orders.map((o) => o.order.DocEntry))
    );

    const cardCodes = [...new Set(deliveryNotes.map((i) => i.CardCode))];
    const customers = await Customer.find({ CardCode: { $in: cardCodes } }).lean();
    const customersByCode = new Map(customers.map((c) => [c.CardCode, c]));

    const candidates = [];
    for (const deliveryNote of deliveryNotes) {
      if (assignedDocEntries.has(deliveryNote.DocEntry)) continue;
      const customer = customersByCode.get(deliveryNote.CardCode);
      if (customer && customer.fulfillmentMethod === "pickup") continue; // self-collection, never routed

      const order = await buildDeliverableOrder(deliveryNote, customersByCode, tenant);

      // Real region filter, derived from the customer's own postal code
      // (utils/regions.js) rather than left as a no-op — an order whose
      // region can't be determined is excluded from a region-filtered
      // query (never silently included in the wrong region's list) but
      // still appears in the unfiltered list so it isn't lost entirely.
      if (region && order.region !== region) continue;
      if (department) {
        const zip = order.address?.zipCode;
        if (!zip || !String(zip).toUpperCase().startsWith(department.toUpperCase())) continue;
      }

      candidates.push(order);
    }

    res.json({ orders: candidates });
  } catch (error) {
    console.error("Get available orders error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// ---------- Assign / remove / reorder ----------

function recalcTotals(route) {
  route.totalOrders = route.orders.length;
  route.totalWeightKg = route.orders.reduce((sum, o) => sum + (o.orderWeightKg || 0), 0);
  route.capacityUsedPercent = route.maxWeightKg
    ? Math.round((route.totalWeightKg / route.maxWeightKg) * 10000) / 100
    : 0;
}

exports.assignOrderToTruck = async (req, res) => {
  try {
    const { routeId } = req.params;
    const { orderDocEntry, sequenceNumber } = req.body;

    const route = await TruckRoute.findById(routeId);
    if (!route) return res.status(404).json({ message: "Route not found" });

    if (route.orders.some((o) => o.order.DocEntry === orderDocEntry)) {
      return res.status(400).json({ message: "Order already assigned to this truck" });
    }

    const deliveryNote = await DeliveryNote.findOne({ DocEntry: orderDocEntry, Cancelled: { $ne: "Y" } });
    if (!deliveryNote) return res.status(404).json({ message: "Deliverable order not found" });

    const customer = await Customer.findOne({ CardCode: deliveryNote.CardCode }).lean();
    const customersByCode = new Map(customer ? [[customer.CardCode, customer]] : []);
    const built = await buildDeliverableOrder(deliveryNote, customersByCode, route.tenant);

    const projectedWeight = route.totalWeightKg + (built.totalWeight || 0);
    if (projectedWeight > route.maxWeightKg) {
      return res.status(400).json({
        message: `Adding this order would put the truck over capacity (${projectedWeight.toFixed(1)} / ${route.maxWeightKg} kg). Remove another stop first, or assign it to a truck with more room.`,
      });
    }

    route.orders.push({
      order: {
        _id: built._id,
        DocEntry: built.DocEntry,
        DocNum: built.DocNum,
        CardCode: built.CardCode,
        CardName: built.CardName,
        DocTotal: built.DocTotal,
        address: built.address,
        totalWeight: built.totalWeight,
        weightUnit: built.weightUnit,
      },
      sequenceNumber: sequenceNumber || route.orders.length + 1,
      orderWeightKg: built.totalWeight,
      coordinates: built.coordinates,
      storeHours: { openingTime: built.openingTime, closingTime: built.closingTime },
      // A caller that explicitly asked for a specific position meant it —
      // lock that placement so the auto-resequence below doesn't move it.
      // The normal path (no sequenceNumber given) leaves it unlocked so it
      // gets slotted into the actually-cheapest position by the optimizer.
      locked: Boolean(sequenceNumber),
    });

    recalcTotals(route);
    resequenceRoute(route);
    await route.save();

    res.json({ message: "Order assigned", route });
  } catch (error) {
    console.error("Assign order error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.removeOrderFromTruck = async (req, res) => {
  try {
    const { routeId, docEntry } = req.params;
    const route = await TruckRoute.findById(routeId);
    if (!route) return res.status(404).json({ message: "Route not found" });

    route.orders = route.orders.filter((o) => o.order.DocEntry !== Number(docEntry));
    recalcTotals(route);
    resequenceRoute(route);
    await route.save();

    res.json({ message: "Order removed", route });
  } catch (error) {
    console.error("Remove order error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.reorderOrders = async (req, res) => {
  try {
    const { routeId } = req.params;
    const { orderedDocEntries } = req.body;

    const route = await TruckRoute.findById(routeId);
    if (!route) return res.status(404).json({ message: "Route not found" });

    const byDocEntry = new Map(route.orders.map((o) => [o.order.DocEntry, o]));
    const reordered = orderedDocEntries
      .map((docEntry) => byDocEntry.get(docEntry))
      .filter(Boolean);

    // Preserve any order not present in the incoming list (defensive — should
    // not normally happen) so a stale client payload never drops a stop.
    route.orders.forEach((o) => {
      if (!orderedDocEntries.includes(o.order.DocEntry)) reordered.push(o);
    });

    reordered.forEach((o, i) => {
      o.sequenceNumber = i + 1;
      o.locked = true; // manual reorder survives the next auto-optimize
    });

    route.orders = reordered;
    await route.save();

    res.json({ message: "Order sequence updated", route });
  } catch (error) {
    console.error("Reorder error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.updateRouteStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const route = await TruckRoute.findByIdAndUpdate(
      req.params.routeId,
      { status },
      { new: true, runValidators: true }
    );
    if (!route) return res.status(404).json({ message: "Route not found" });
    res.json({ message: "Status updated", route });
  } catch (error) {
    console.error("Update status error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Updates a single stop's delivery status (pending/delivered/failed) — the
// backend for the Stop Detail modal's "Mark delivered" action.
exports.updateStopStatus = async (req, res) => {
  try {
    const { routeId, docEntry } = req.params;
    const { status } = req.body;

    const route = await TruckRoute.findById(routeId);
    if (!route) return res.status(404).json({ message: "Route not found" });

    const stop = route.orders.find((o) => o.order.DocEntry === Number(docEntry));
    if (!stop) return res.status(404).json({ message: "Stop not found on this route" });

    stop.status = status;
    if (status === "delivered") stop.actualArrival = new Date();
    await route.save();

    res.json({ message: "Stop status updated", route });
  } catch (error) {
    console.error("Update stop status error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.updateCapacity = async (req, res) => {
  try {
    const { maxWeightKg } = req.body;
    const route = await TruckRoute.findByIdAndUpdate(
      req.params.routeId,
      { maxWeightKg },
      { new: true, runValidators: true }
    );
    if (!route) return res.status(404).json({ message: "Route not found" });
    recalcTotals(route);
    await route.save();
    res.json({ message: "Capacity updated", route });
  } catch (error) {
    console.error("Update capacity error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// ---------- Optimize / Generate / Auto-fill ----------

function getDepot(tenant) {
  return getWarehouse(tenant);
}

function toOptimizerStop(orderEntry) {
  return {
    id: String(orderEntry._id),
    coordinates: orderEntry.coordinates,
    windowOpen: parseTimeToMinutes(orderEntry.storeHours?.openingTime),
    windowClose: parseTimeToMinutes(orderEntry.storeHours?.closingTime),
    weightKg: orderEntry.orderWeightKg || 0,
  };
}

// Re-sequences a route's already-assigned, non-locked orders in place
// (cheapest insertion + 2-opt) — mutates `route.orders`/`totalDistanceKm`/
// `totalDurationMin` but does not save; callers save once, after whatever
// else they changed. `locked` stops (manually reordered by a dispatcher)
// keep their position and are excluded from re-sequencing.
function resequenceRoute(route) {
  const depot = getDepot(route.tenant);
  const locked = route.orders.filter((o) => o.locked);
  const toSequence = route.orders.filter((o) => !o.locked).map((o) => toOptimizerStop(o));

  const { sequence, totalDistanceKm, totalDurationMin } = sequenceRoute(toSequence, depot);

  const bySeqId = new Map(sequence.map((s) => [s.id, s]));
  route.orders = [...locked, ...route.orders.filter((o) => !o.locked)].map((o) => {
    const optimized = bySeqId.get(String(o._id));
    if (optimized) {
      o.sequenceNumber = optimized.seq;
      o.etaMin = optimized.etaMin;
      o.status = optimized.infeasible ? "infeasible" : o.status;
    }
    return o;
  });
  route.orders.sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0));
  route.totalDistanceKm = totalDistanceKm;
  route.totalDurationMin = totalDurationMin;
}

// Re-sequences a route's already-assigned orders (cheapest insertion + 2-opt).
// Never touches which orders are assigned — only their order/ETA. Also
// triggered automatically by assign/remove now (see below) — this endpoint
// stays for an explicit manual re-optimize (e.g. after several manual
// reorders) and for the "Optimize" button's own loading state in the UI.
exports.optimizeRoute = async (req, res) => {
  try {
    const route = await TruckRoute.findById(req.params.routeId);
    if (!route) return res.status(404).json({ message: "Route not found" });

    resequenceRoute(route);
    await route.save();

    res.json({ message: "Route optimized", route });
  } catch (error) {
    console.error("Optimize route error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Adds available orders from the truck's own region to the truck until
// capacity is reached, then sequences the result. This is the backend for
// the existing "Generate Route" button.
exports.generateRoute = async (req, res) => {
  try {
    const route = await TruckRoute.findById(req.params.routeId);
    if (!route) return res.status(404).json({ message: "Route not found" });

    const dayStart = new Date(route.date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(23, 59, 59, 999);

    const deliveryNotes = await DeliveryNote.find({
      Cancelled: { $ne: "Y" },
      DocDate: { $gte: dayStart, $lte: dayEnd },
    });

    const allRoutesToday = await TruckRoute.find({
      date: { $gte: dayStart, $lte: dayEnd },
      tenant: route.tenant,
    });
    const assigned = new Set(
      allRoutesToday.flatMap((r) => r.orders.map((o) => o.order.DocEntry))
    );

    const cardCodes = [...new Set(deliveryNotes.map((i) => i.CardCode))];
    const customers = await Customer.find({ CardCode: { $in: cardCodes } }).lean();
    const customersByCode = new Map(customers.map((c) => [c.CardCode, c]));

    let remainingCapacity = route.maxWeightKg - route.totalWeightKg;
    let ordersAdded = 0;

    for (const deliveryNote of deliveryNotes) {
      if (assigned.has(deliveryNote.DocEntry)) continue;
      const customer = customersByCode.get(deliveryNote.CardCode);
      if (!customer || customer.fulfillmentMethod === "pickup") continue;

      const built = await buildDeliverableOrder(deliveryNote, customersByCode, route.tenant);
      // Only pull in orders whose postal code actually falls in this truck's
      // region — a customer whose region can't be determined is skipped
      // here (never guessed into the wrong truck); it still shows up in
      // "available orders" for manual assignment.
      if (route.region && built.region !== route.region) continue;
      if (!built.totalWeight || built.totalWeight > remainingCapacity) continue;
      if (!built.coordinates) continue; // ungeocoded — surfaced separately, not auto-assigned

      route.orders.push({
        order: {
          _id: built._id,
          DocEntry: built.DocEntry,
          DocNum: built.DocNum,
          CardCode: built.CardCode,
          CardName: built.CardName,
          DocTotal: built.DocTotal,
          address: built.address,
          totalWeight: built.totalWeight,
          weightUnit: built.weightUnit,
        },
        sequenceNumber: route.orders.length + 1,
        orderWeightKg: built.totalWeight,
        coordinates: built.coordinates,
        storeHours: { openingTime: built.openingTime, closingTime: built.closingTime },
      });

      remainingCapacity -= built.totalWeight;
      assigned.add(deliveryNote.DocEntry);
      ordersAdded++;
    }

    recalcTotals(route);

    // Sequence what we just built.
    const depot = getDepot(route.tenant);
    const { sequence, totalDistanceKm, totalDurationMin } = sequenceRoute(
      route.orders.map(toOptimizerStop),
      depot
    );
    const bySeqId = new Map(sequence.map((s) => [s.id, s]));
    route.orders.forEach((o) => {
      const optimized = bySeqId.get(String(o._id));
      if (optimized) {
        o.sequenceNumber = optimized.seq;
        o.etaMin = optimized.etaMin;
      }
    });
    route.orders.sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0));
    route.totalDistanceKm = totalDistanceKm;
    route.totalDurationMin = totalDurationMin;

    await route.save();

    res.json({
      message: `Added ${ordersAdded} orders`,
      ordersAdded,
      capacityUsed: route.capacityUsedPercent,
      route,
    });
  } catch (error) {
    console.error("Generate route error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Runs sweep-clustering + capacity sizing + sequencing across every truck
// scheduled for the date at once (Section 6.2-6.4 of implementation.md).
exports.autoFillAllTrucks = async (req, res) => {
  try {
    const { date } = req.params;
    const tenant = tenantFromReq(req);

    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(23, 59, 59, 999);

    const routes = await TruckRoute.find({ date: { $gte: dayStart, $lte: dayEnd }, tenant });
    if (routes.length === 0) {
      return res.status(400).json({
        message: "No trucks initialized for this date — run Initialize Date first",
      });
    }

    const deliveryNotes = await DeliveryNote.find({
      Cancelled: { $ne: "Y" },
      DocDate: { $gte: dayStart, $lte: dayEnd },
    });
    const cardCodes = [...new Set(deliveryNotes.map((i) => i.CardCode))];
    const customers = await Customer.find({ CardCode: { $in: cardCodes } }).lean();
    const customersByCode = new Map(customers.map((c) => [c.CardCode, c]));

    const alreadyAssigned = new Set(routes.flatMap((r) => r.orders.map((o) => o.order.DocEntry)));

    // Group deliverable, geocoded, non-pickup orders by their REAL region —
    // derived per-customer from their postal code (utils/regions.js), not
    // borrowed from whichever route happened to be first in the list.
    const byRegion = new Map();
    const unassignable = [];
    for (const deliveryNote of deliveryNotes) {
      if (alreadyAssigned.has(deliveryNote.DocEntry)) continue;
      const customer = customersByCode.get(deliveryNote.CardCode);
      if (!customer || customer.fulfillmentMethod === "pickup") continue;

      const built = await buildDeliverableOrder(deliveryNote, customersByCode, tenant);
      if (!built.coordinates) {
        unassignable.push({ docEntry: built.DocEntry, cardName: built.CardName, reason: "not geocoded" });
        continue;
      }
      if (!built.region) {
        unassignable.push({
          docEntry: built.DocEntry,
          cardName: built.CardName,
          reason: "postal code doesn't map to a known region",
        });
        continue;
      }

      if (!byRegion.has(built.region)) byRegion.set(built.region, []);
      byRegion.get(built.region).push(built);
    }

    const depot = getDepot(tenant);
    let totalAdded = 0;
    const touchedRoutes = new Set();

    // Section 6.2-6.4: sweep-cluster each region's pool (fewest trucks per
    // area), size each cluster onto the smallest truck that fits it (never
    // waste a large truck's capacity on a half-empty area), then sequence.
    for (const [region, pool] of byRegion.entries()) {
      const regionRoutes = routes.filter((r) => r.region === region);
      if (regionRoutes.length === 0) {
        pool.forEach((o) =>
          unassignable.push({ docEntry: o.DocEntry, cardName: o.CardName, reason: `no truck scheduled for region "${region}"` })
        );
        continue;
      }

      const availableTrucks = regionRoutes
        .map((route) => ({ route, remaining: route.maxWeightKg - route.totalWeightKg }))
        .filter((t) => t.remaining > 0);

      if (availableTrucks.length === 0) {
        pool.forEach((o) =>
          unassignable.push({ docEntry: o.DocEntry, cardName: o.CardName, reason: `all trucks in "${region}" are already at capacity` })
        );
        continue;
      }

      const largestRemaining = Math.max(...availableTrucks.map((t) => t.remaining));
      const clusters = sweepCluster(
        pool.map((o) => ({ ...o, weightKg: o.totalWeight })),
        depot,
        largestRemaining
      );
      // Bin-pack the biggest clusters first — otherwise a large cluster can
      // be left with only small trucks remaining even though a big truck
      // was available at the start.
      clusters.sort((a, b) => {
        const wa = a.reduce((s, o) => s + (o.weightKg || 0), 0);
        const wb = b.reduce((s, o) => s + (o.weightKg || 0), 0);
        return wb - wa;
      });

      for (const cluster of clusters) {
        const clusterWeight = cluster.reduce((s, o) => s + (o.weightKg || 0), 0);
        const candidates = availableTrucks
          .filter((t) => t.remaining > 0)
          .map((t) => ({ maxWeightKg: t.remaining, _ref: t }));
        const fit = pickSmallestFittingTruck(candidates, clusterWeight);

        if (!fit) {
          cluster.forEach((o) =>
            unassignable.push({
              docEntry: o.DocEntry,
              cardName: o.CardName,
              reason: `region "${region}" under-resourced for this date (a ${clusterWeight}kg group exceeds every available truck's remaining capacity)`,
            })
          );
          continue;
        }

        const target = fit._ref;
        cluster.forEach((built) => {
          target.route.orders.push({
            order: {
              _id: built._id,
              DocEntry: built.DocEntry,
              DocNum: built.DocNum,
              CardCode: built.CardCode,
              CardName: built.CardName,
              DocTotal: built.DocTotal,
              address: built.address,
              totalWeight: built.totalWeight,
              weightUnit: built.weightUnit,
            },
            sequenceNumber: target.route.orders.length + 1,
            orderWeightKg: built.totalWeight,
            coordinates: built.coordinates,
            storeHours: { openingTime: built.openingTime, closingTime: built.closingTime },
          });
        });
        target.remaining -= clusterWeight;
        totalAdded += cluster.length;
        touchedRoutes.add(target.route);
      }

      // Sweep-clustering above only decides which truck a NEW stop starts
      // on — it splits a purely angle-sorted list by capacity, so a stop can
      // land on truck A even though it's practically next door to truck B's
      // route. Run the cross-route relocation pass across every truck in
      // THIS region (not just ones that received a new stop this run, since
      // a pre-existing stop can also turn out to be cheaper elsewhere once
      // new stops shift the picture) so a stop only stays put if moving it
      // wouldn't actually shorten the combined distance.
      const genericTrucks = regionRoutes.map((route) => ({
        id: route._id.toString(),
        capacityKg: route.maxWeightKg,
        stops: route.orders.map((o) => ({
          id: String(o._id),
          coordinates: o.coordinates,
          windowOpen: parseTimeToMinutes(o.storeHours?.openingTime),
          windowClose: parseTimeToMinutes(o.storeHours?.closingTime),
          weightKg: o.orderWeightKg || 0,
          locked: o.locked,
          _raw: o,
        })),
      }));

      const improved = crossRouteImprove(genericTrucks, depot);

      improved.forEach((truckResult) => {
        const route = regionRoutes.find((r) => r._id.toString() === truckResult.id);
        if (!route) return;
        if (route.orders.length === 0 && truckResult.sequence.length === 0) return; // genuinely untouched, nothing to save

        // Drained to zero stops is a legitimate outcome (this truck wasn't
        // needed once its stops moved to trucks already covering the same
        // area), not skipped — otherwise the route would silently keep its
        // stale pre-improvement stops.
        route.orders = truckResult.sequence.map((s) => {
          const raw = s._raw;
          raw.sequenceNumber = s.seq;
          raw.etaMin = s.etaMin;
          raw.status = s.infeasible ? "infeasible" : raw.status;
          return raw;
        });
        recalcTotals(route);
        route.totalDistanceKm = truckResult.totalDistanceKm;
        route.totalDurationMin = truckResult.totalDurationMin;
        touchedRoutes.add(route);
      });
    }

    // Sequence (cheapest insertion + 2-opt) every route that received new stops.
    for (const route of touchedRoutes) {
      recalcTotals(route);

      const { sequence, totalDistanceKm, totalDurationMin } = sequenceRoute(
        route.orders.map(toOptimizerStop),
        depot
      );
      const bySeqId = new Map(sequence.map((s) => [s.id, s]));
      route.orders.forEach((o) => {
        const optimized = bySeqId.get(String(o._id));
        if (optimized) {
          o.sequenceNumber = optimized.seq;
          o.etaMin = optimized.etaMin;
          o.status = optimized.infeasible ? "infeasible" : o.status;
        }
      });
      route.orders.sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0));
      route.totalDistanceKm = totalDistanceKm;
      route.totalDurationMin = totalDurationMin;

      await route.save();
    }

    res.json({
      message: `Auto-filled ${totalAdded} order(s) across ${touchedRoutes.size} truck(s)`,
      totalAdded,
      unassignable,
      routes,
    });
  } catch (error) {
    console.error("Auto-fill all trucks error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// ---------- Stats ----------

exports.getStats = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const tenant = tenantFromReq(req);

    const query = { tenant };
    if (startDate && endDate) {
      query.date = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }

    const routes = await TruckRoute.find(query);

    const stats = {
      totalRoutes: routes.length,
      totalOrders: routes.reduce((sum, r) => sum + (r.totalOrders || 0), 0),
      totalWeightKg: routes.reduce((sum, r) => sum + (r.totalWeightKg || 0), 0),
      totalDistanceKm: routes.reduce((sum, r) => sum + (r.totalDistanceKm || 0), 0),
      avgCapacityUsedPercent:
        routes.length > 0
          ? Math.round(
              (routes.reduce((sum, r) => sum + (r.capacityUsedPercent || 0), 0) / routes.length) * 100
            ) / 100
          : 0,
      byStatus: {
        planning: routes.filter((r) => r.status === "planning").length,
        in_progress: routes.filter((r) => r.status === "in_progress").length,
        completed: routes.filter((r) => r.status === "completed").length,
      },
    };

    res.json({ stats });
  } catch (error) {
    console.error("Get stats error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};
