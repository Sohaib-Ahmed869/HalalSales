// controllers/truckRoute.controller.js
const TruckSchedule = require("../models/TruckSchedule");
const TruckRoute = require("../models/TruckRoute");
const Customer = require("../models/Customer");
const DeliveryNote = require("../models/DeliveryNote");
const LogisticsOrder = require("../models/LogisticsOrder");
const SalesOrder = require("../models/SalesOrder");
const TruckDevice = require("../models/TruckDevice");
const RouteAdherence = require("../models/RouteAdherence");
const Item = require("../models/item");
const {
  sequenceRoute,
  parseTimeToMinutes,
  stopWindow,
  evaluateFixedRoute,
  DEFAULT_DEPARTURE_MIN,
  planRegionAssignment,
  isBetterPlan,
} = require("../utils/routeOptimizer");
const { getWarehouse, regionForAddress } = require("../utils/regions");
const { geocodeCustomer, deliveryPoint } = require("../utils/geocodingService");
const { getMatrix, getRouteGeometry, saveRouteGeometry } = require("../utils/roadDistanceService");
const { getTrafficLegs } = require("../utils/trafficEtaService");

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

// Trucks of a schedule are MyGeotab vehicles picked in the portal. Their
// truck number and name always come from the vehicle (TruckDevice), and the
// capacity / departure time entered here are remembered on the vehicle so the
// next schedule offers them again. Returns an error message, or null.
async function resolveScheduleTrucks(trucks, { tenant, dayOfWeek, scheduleId }) {
  const picked = trucks.filter((t) => t.geotabId);
  if (picked.length > 0) {
    const devices = await TruckDevice.find({ tenant, isActive: true, geotabId: { $in: picked.map((t) => t.geotabId) } });
    const byGeotabId = new Map(devices.map((d) => [d.geotabId, d]));
    for (const truck of picked) {
      const device = byGeotabId.get(truck.geotabId);
      if (!device) return "One of the selected vehicles is no longer available in MyGeotab.";
      truck.truckNumber = device.truckNumber;
      truck.truckName = device.label || device.licensePlate || `Truck ${device.truckNumber}`;
      truck.truckType = "custom";
      device.maxWeightKg = truck.maxWeightKg;
      device.departureTime = truck.departureTime;
      await device.save();
    }
  }
  if (trucks.some((t) => !(Number(t.maxWeightKg) > 0))) return "Enter the capacity (kg) of every truck.";
  const numbers = trucks.map((t) => t.truckNumber);
  if (new Set(numbers).size !== numbers.length) return "The same truck is in this schedule twice.";
  // A truck does one route a day: it can't be in two schedules of the same weekday.
  const query = { tenant, dayOfWeek, isActive: true, "trucks.truckNumber": { $in: numbers } };
  if (scheduleId) query._id = { $ne: scheduleId };
  const clash = await TruckSchedule.findOne(query).lean();
  if (clash) {
    const truck = clash.trucks.find((t) => numbers.includes(t.truckNumber));
    return `${truck.truckName || `Truck ${truck.truckNumber}`} is already in the ${dayOfWeek} schedule for ${clash.region}.`;
  }
  return null;
}

// Create or update. Matches the fact that TruckSchedules.jsx sends the same
// payload for both create and edit; if the body carries an existing `_id`,
// this upserts instead of creating a duplicate.
exports.createSchedule = async (req, res) => {
  try {
    const { _id, dayOfWeek, region, departments, cities, trucks, isActive } = req.body;

    if (!dayOfWeek || !trucks || trucks.length === 0) {
      return res.status(400).json({ message: "dayOfWeek and at least one truck are required" });
    }

    const problem = await resolveScheduleTrucks(trucks, { tenant: tenantFromReq(req), dayOfWeek, scheduleId: _id });
    if (problem) return res.status(400).json({ message: problem });

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
    if (Array.isArray(req.body.trucks)) {
      const current = await TruckSchedule.findById(req.params.id).lean();
      if (!current) return res.status(404).json({ message: "Schedule not found" });
      const problem = await resolveScheduleTrucks(req.body.trucks, {
        tenant: current.tenant,
        dayOfWeek: req.body.dayOfWeek || current.dayOfWeek,
        scheduleId: req.params.id,
      });
      if (problem) return res.status(400).json({ message: problem });
    }
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

// Creates the day's truck routes from the active weekly templates of that
// weekday (trucks that already have a route for the date are left alone).
async function initializeTrucksFor(date, tenant) {
  const weekday = dayOfWeekFor(date);
  const schedules = await TruckSchedule.find({ dayOfWeek: weekday, isActive: true, tenant });

  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);

  let created = 0;
  let skipped = 0;
  for (const schedule of schedules) {
    for (const truck of schedule.trucks) {
      const exists = await TruckRoute.findOne({ date: dayStart, truckNumber: truck.truckNumber, region: schedule.region, tenant });
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
        departureTime: truck.departureTime || "08:00",
        serviceMin: truck.serviceMin,
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
  return { created, skipped, weekday, templates: schedules.length };
}

exports.initializeDate = async (req, res) => {
  try {
    const { date } = req.body;
    if (!date) return res.status(400).json({ message: "date is required" });
    const { created, skipped, weekday } = await initializeTrucksFor(date, tenantFromReq(req));
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

    const tenant = tenantFromReq(req);
    // A day with orders sent to Logistics always has its trucks: any truck of
    // that weekday's templates still missing (template added or changed after
    // the orders were sent) is created here. There is no separate button.
    if (!USE_DELIVERY_NOTES() && (await LogisticsOrder.exists({ tenant, deliveryDate: { $gte: dayStart, $lte: dayEnd } }))) {
      await initializeTrucksFor(date, tenant);
    }

    const routes = await TruckRoute.find({
      date: { $gte: dayStart, $lte: dayEnd },
      tenant,
    }).sort({ region: 1, truckNumber: 1 });

    res.json({ routes });
  } catch (error) {
    console.error("Get routes by date error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// DELETE /truck-routes/date/:date - removes the trucks of a day that has no
// orders sent to Logistics (days set up before orders came from the Bulk
// Order Conversion page). Refused for a day that is in use.
exports.clearDate = async (req, res) => {
  try {
    const tenant = tenantFromReq(req);
    const { dayStart, dayEnd } = dayBounds(req.params.date);
    if (Number.isNaN(dayStart.getTime())) return res.status(400).json({ message: "Invalid date" });
    const day = { $gte: dayStart, $lte: dayEnd };
    if (await LogisticsOrder.exists({ tenant, deliveryDate: day })) {
      return res.status(400).json({ message: "Orders are planned for this date, so its trucks can't be removed." });
    }
    const routes = await TruckRoute.find({ tenant, date: day }).select("_id").lean();
    const ids = routes.map((r) => r._id);
    await RouteAdherence.deleteMany({ routeId: { $in: ids } });
    const result = await TruckRoute.deleteMany({ _id: { $in: ids } });
    res.json({ message: `Removed ${result.deletedCount} truck(s) from ${req.params.date}`, removed: result.deletedCount });
  } catch (error) {
    console.error("Clear date error:", error);
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

// Changes when this route's truck leaves the depot on this date and
// recomputes every stop's ETA from it (locked stops keep their order).
exports.setDepartureTime = async (req, res) => {
  try {
    const { departureTime } = req.body;
    if (parseTimeToMinutes(departureTime) == null || parseTimeToMinutes(departureTime) >= 24 * 60) {
      return res.status(400).json({ message: 'departureTime must be "HH:MM" (24h)' });
    }
    const route = await TruckRoute.findById(req.params.routeId);
    if (!route) return res.status(404).json({ message: "Route not found" });
    route.departureTime = departureTime;
    await resequenceRoute(route);
    await route.save();
    res.json({ message: "Departure time updated", route });
  } catch (error) {
    console.error("Set departure time error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Minutes allowed at each stop of this route (15 / 20 / 30 in the UI); every
// later ETA and the return time move with it.
exports.setServiceTime = async (req, res) => {
  try {
    const serviceMin = Number(req.body.serviceMin);
    if (!Number.isFinite(serviceMin) || serviceMin < 0 || serviceMin > 180) {
      return res.status(400).json({ message: "serviceMin must be a number of minutes between 0 and 180" });
    }
    const route = await TruckRoute.findById(req.params.routeId);
    if (!route) return res.status(404).json({ message: "Route not found" });
    route.serviceMin = serviceMin;
    await resequenceRoute(route);
    await route.save();
    res.json({ message: "Stop time allowance updated", route });
  } catch (error) {
    console.error("Set service time error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Road-following polyline for one route (depot -> stops in sequence -> depot),
// from OSRM. Returns { positions: [[lat,lng],...] | null } — null means the
// routing engine was unavailable and the map should draw straight lines.
exports.getRouteGeometry = async (req, res) => {
  try {
    const route = await TruckRoute.findById(req.params.routeId).lean();
    if (!route) return res.status(404).json({ message: "Route not found" });
    const depot = getDepot(route.tenant);
    const stops = (route.orders || [])
      .filter((o) => o.coordinates && Number.isFinite(o.coordinates.lat) && Number.isFinite(o.coordinates.lng))
      .sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0))
      .map((o) => ({ lat: o.coordinates.lat, lng: o.coordinates.lng }));
    if (stops.length === 0) return res.json({ positions: [] });
    const positions = await getRouteGeometry([depot, ...stops, depot]);
    res.json({ positions });
  } catch (error) {
    console.error("Route geometry error:", error);
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
  // A pin for the address trucks actually deliver to (deliveryAddress when
  // set): billing-address coordinates don't count for a different address.
  const { address, coords } = deliveryPoint(customer);
  if (coords) return;
  const hasAddress = address?.street || address?.zipCode;
  if (!hasAddress) return;

  try {
    const doc = await Customer.findOne({ CardCode: customer.CardCode });
    if (!doc) return;
    await geocodeCustomer(doc);
    if (doc.geo?.geocodeStatus === "ok") {
      customer.geo = { lat: doc.geo.lat, lng: doc.geo.lng, geocodeStatus: "ok", addressKey: doc.geo.addressKey };
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
    totalWeight = Math.round(totalWeight * 100) / 100; // avoid 57.099999999999994 style floats
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
  // deliveryAddress (where trucks should actually go) takes precedence over
  // the billing address, and the pin must belong to that same address
  // (utils/geocodingService.js deliveryPoint): billing-address coordinates are
  // never used for a customer delivered elsewhere.
  const point = customer ? deliveryPoint(customer) : { address: undefined, coords: null };
  const geoSource = point.coords;
  const address = point.address;

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
    preferredDeliveryFrom: customer ? customer.preferredDeliveryFrom : undefined,
    preferredDeliveryTo: customer ? customer.preferredDeliveryTo : undefined,
    docType: deliveryNote.deliveryDate ? "order" : "deliveryNote",
    deliveryDate: deliveryNote.deliveryDate,
    geocodeStatus: geoSource ? "ok" : customer?.geo?.geocodeStatus || "pending",
    fulfillmentMethod: customer ? customer.fulfillmentMethod : "delivery",
    // Derived from the customer's postal code via utils/regions.js — the
    // same department->region table the frontend uses, so a truck's region
    // and an order's region mean the same thing on both sides. null when
    // the address/postal code can't be classified (surfaced, never guessed).
    region: customer ? regionForAddress(address, tenant) : null,
  };
}

// ---------- Orders sent to Logistics (explicit selection) ----------
//
// The plan for a date is made of the sales orders an operator moved here from
// the Bulk Order Conversion page for that date (models/LogisticsOrder.js),
// not of every document dated that day: many orders are open and only the
// chosen ones go out. LOGISTICS_ORDER_SOURCE=delivery-notes restores the old
// "every SAP delivery note dated that day" behaviour.

const USE_DELIVERY_NOTES = () => process.env.LOGISTICS_ORDER_SOURCE === "delivery-notes";

function dayBounds(date) {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setHours(23, 59, 59, 999);
  return { dayStart, dayEnd };
}

// The documents that may be planned between dayStart and dayEnd.
async function loadPool(dayStart, dayEnd, tenant) {
  if (USE_DELIVERY_NOTES()) {
    return DeliveryNote.find({ Cancelled: { $ne: "Y" }, DocDate: { $gte: dayStart, $lte: dayEnd } });
  }
  return LogisticsOrder.find({ tenant, deliveryDate: { $gte: dayStart, $lte: dayEnd } }).lean();
}

async function findPoolDoc(docEntry, tenant) {
  if (USE_DELIVERY_NOTES()) return DeliveryNote.findOne({ DocEntry: docEntry, Cancelled: { $ne: "Y" } });
  return LogisticsOrder.findOne({ tenant, DocEntry: docEntry }).lean();
}

const isoDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// POST /truck-routes/selection  { deliveryDate: "YYYY-MM-DD", orders: [{ DocEntry, ... }] }
// Sends sales orders to Logistics for a delivery date. Sending an order again
// moves it to the new date, unless it is already on a truck.
exports.moveToLogistics = async (req, res) => {
  try {
    const { deliveryDate, orders } = req.body;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate || "")) {
      return res.status(400).json({ message: "deliveryDate (YYYY-MM-DD) is required" });
    }
    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ message: "Select at least one order" });
    }
    const tenant = tenantFromReq(req);
    const { dayStart } = dayBounds(deliveryDate);

    const docEntries = [...new Set(orders.map((o) => Number(o.DocEntry)).filter(Number.isFinite))];
    const [fresh, existing, onTrucks] = await Promise.all([
      SalesOrder.find({ DocEntry: { $in: docEntries } })
        .select("DocEntry DocNum DocDate DocDueDate CardCode CardName DocTotal DocumentLines.ItemCode DocumentLines.ItemDescription DocumentLines.Quantity")
        .lean(),
      LogisticsOrder.find({ tenant, DocEntry: { $in: docEntries } }).lean(),
      TruckRoute.find({ tenant, "orders.order.DocEntry": { $in: docEntries } }).lean(),
    ]);
    const freshByEntry = new Map(fresh.map((o) => [o.DocEntry, o]));
    const existingByEntry = new Map(existing.map((o) => [o.DocEntry, o]));
    const truckByEntry = new Map();
    onTrucks.forEach((r) =>
      r.orders.forEach((o) => truckByEntry.set(o.order.DocEntry, { truckName: r.truckName || `Truck ${r.truckNumber}`, date: isoDay(r.date) }))
    );

    let moved = 0;
    let rescheduled = 0;
    const alreadyOnTruck = [];
    const skipped = [];
    for (const sent of orders) {
      const docEntry = Number(sent.DocEntry);
      // The copy in this database is the freshest; what the page sent is the fallback.
      const src = freshByEntry.get(docEntry) || sent;
      if (!Number.isFinite(docEntry) || !src.CardCode) {
        skipped.push({ docEntry: sent.DocEntry, reason: "missing order number or customer" });
        continue;
      }
      const onTruck = truckByEntry.get(docEntry);
      if (onTruck) {
        alreadyOnTruck.push({ docEntry, docNum: src.DocNum, cardName: src.CardName, ...onTruck });
        continue;
      }
      const before = existingByEntry.get(docEntry);
      await LogisticsOrder.updateOne(
        { tenant, DocEntry: docEntry },
        {
          $set: {
            DocNum: src.DocNum,
            DocDate: src.DocDate,
            DocDueDate: src.DocDueDate,
            CardCode: src.CardCode,
            CardName: src.CardName,
            DocTotal: src.DocTotal,
            DocumentLines: (src.DocumentLines || []).map((l) => ({
              ItemCode: l.ItemCode,
              ItemDescription: l.ItemDescription,
              Quantity: l.Quantity,
            })),
            deliveryDate: dayStart,
            movedBy: req.user?._id,
            movedAt: new Date(),
          },
        },
        { upsert: true }
      );
      if (before && before.deliveryDate.getTime() !== dayStart.getTime()) rescheduled++;
      else if (!before) moved++;
    }

    // Sending orders for a day is what opens that day in Logistics: its trucks
    // are created from the weekly templates right away.
    const trucks = moved + rescheduled > 0 || existing.length > 0 ? await initializeTrucksFor(deliveryDate, tenant) : null;
    const trucksForDate = await TruckRoute.countDocuments({ tenant, date: dayStart });

    res.json({
      message: `${moved + rescheduled} order(s) sent to Logistics for ${deliveryDate}`,
      trucksCreated: trucks ? trucks.created : 0,
      trucksForDate,
      weekday: dayOfWeekFor(deliveryDate),
      deliveryDate,
      moved,
      rescheduled,
      unchanged: orders.length - moved - rescheduled - alreadyOnTruck.length - skipped.length,
      alreadyOnTruck,
      skipped,
    });
  } catch (error) {
    console.error("Move to logistics error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// DELETE /truck-routes/selection/:docEntry - takes an order back out of Logistics.
exports.removeFromLogistics = async (req, res) => {
  try {
    const tenant = tenantFromReq(req);
    const docEntry = Number(req.params.docEntry);
    const onTruck = await TruckRoute.findOne({ tenant, "orders.order.DocEntry": docEntry }).lean();
    if (onTruck) {
      return res.status(400).json({
        message: `This order is on ${onTruck.truckName || `Truck ${onTruck.truckNumber}`} (${isoDay(onTruck.date)}). Remove it from the truck first.`,
      });
    }
    const result = await LogisticsOrder.deleteOne({ tenant, DocEntry: docEntry });
    if (result.deletedCount === 0) return res.status(404).json({ message: "Order is not in Logistics" });
    res.json({ message: "Order removed from Logistics" });
  } catch (error) {
    console.error("Remove from logistics error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// GET /truck-routes/selection/dates - how many orders are waiting per planned
// delivery date (from yesterday on), so the page can offer those dates.
exports.getSelectionDates = async (req, res) => {
  try {
    const tenant = tenantFromReq(req);
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - 1);
    const [selected, routes] = await Promise.all([
      LogisticsOrder.find({ tenant, deliveryDate: { $gte: from } }).select("DocEntry deliveryDate").lean(),
      TruckRoute.find({ tenant, date: { $gte: from } }).select("orders.order.DocEntry").lean(),
    ]);
    const assigned = new Set(routes.flatMap((r) => r.orders.map((o) => o.order.DocEntry)));
    const byDate = new Map();
    selected.forEach((o) => {
      const key = isoDay(o.deliveryDate);
      const entry = byDate.get(key) || { date: key, total: 0, unassigned: 0 };
      entry.total++;
      if (!assigned.has(o.DocEntry)) entry.unassigned++;
      byDate.set(key, entry);
    });
    res.json({ dates: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)) });
  } catch (error) {
    console.error("Selection dates error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Every order planned for the date that isn't on a TruckRoute yet. Excludes
// pickup customers (never routed at all).
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

    const deliveryNotes = await loadPool(dayStart, dayEnd, tenant);

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

    const deliveryNote = await findPoolDoc(orderDocEntry, route.tenant);
    if (!deliveryNote) return res.status(404).json({ message: "This order hasn't been sent to Logistics" });

    const customer = await Customer.findOne({ CardCode: deliveryNote.CardCode }).lean();
    const customersByCode = new Map(customer ? [[customer.CardCode, customer]] : []);
    const built = await buildDeliverableOrder(deliveryNote, customersByCode, route.tenant);

    if (!built.coordinates) {
      return res.status(400).json({
        message: `${built.CardName || "This customer"} can't be placed on a truck: the address hasn't been geocoded yet, so there's no location to route to.`,
      });
    }

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
        docType: built.docType,
      },
      sequenceNumber: sequenceNumber || route.orders.length + 1,
      orderWeightKg: built.totalWeight,
      coordinates: built.coordinates,
      storeHours: storeHoursOf(built),
      // A caller that explicitly asked for a specific position meant it —
      // lock that placement so the auto-resequence below doesn't move it.
      // The normal path (no sequenceNumber given) leaves it unlocked so it
      // gets slotted into the actually-cheapest position by the optimizer.
      locked: Boolean(sequenceNumber),
    });

    recalcTotals(route);
    await resequenceRoute(route);
    await route.save();

    // The order is on the truck either way, but tell the dispatcher when this
    // truck can't actually reach the shop inside its opening hours.
    const placed = route.orders.find((o) => o.order.DocEntry === built.DocEntry);
    const warning =
      placed && placed.status === "infeasible"
        ? `Added, but this truck can't reach ${built.CardName || "the stop"} before it closes at ${built.closingTime || "closing time"} (ETA ${String(Math.floor(placed.etaMin / 60)).padStart(2, "0")}:${String(placed.etaMin % 60).padStart(2, "0")}). Consider a different truck or an earlier departure.`
        : undefined;

    res.json({ message: "Order assigned", warning, route });
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
    await resequenceRoute(route);
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

    // Recompute real distance/ETA/wait/infeasible-flags for the exact order
    // just chosen — a manual drag-reorder previously left these at whatever
    // the last auto-sequence produced, stale and wrong the moment the order
    // actually changed. evaluateFixedRoute respects the given order exactly
    // (unlike resequenceRoute, which would ignore these stops entirely once
    // every one of them is locked).
    const depot = getDepot(route.tenant);
    const fixedStops = stopsOf(route);
    const matrix = await roadMatrixFor(depot, fixedStops);
    const { sequence, totalDistanceKm, totalDurationMin, totalWaitMin } = evaluateFixedRoute(
      fixedStops,
      depot,
      departureMinOf(route),
      undefined,
      matrix
    );
    route.distanceSource = matrix ? "road" : "estimate";
    route.roadProvider = matrix ? matrix.provider : undefined;
    const byId = new Map(sequence.map((s) => [s.id, s]));
    route.orders.forEach((o) => {
      const evaluated = byId.get(String(o._id));
      if (evaluated) {
        applyEvaluated(o, evaluated);
      }
    });
    route.totalDistanceKm = totalDistanceKm;
    route.totalDurationMin = totalDurationMin;
    route.totalWaitMin = totalWaitMin;
    await applyTrafficEtas(route);

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
    if (status === "delivered") {
      stop.deliveredAt = new Date();
      stop.deliveredBy = "manual";
    }
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

// A stop flagged "infeasible" (can't arrive before the shop closes) used to
// keep that flag forever, even after a re-sequence or a later departure made
// it feasible. Set it when infeasible, clear it when it no longer is, and
// never touch delivered/failed stops' real status.
function statusAfterSequencing(order, infeasible) {
  if (infeasible) return order.status === "delivered" || order.status === "failed" ? order.status : "infeasible";
  return order.status === "infeasible" ? "pending" : order.status;
}

// Minutes-from-midnight the route's truck leaves the depot; 08:00 if unset/invalid.
function departureMinOf(route) {
  const parsed = parseTimeToMinutes(route.departureTime);
  return parsed == null ? DEFAULT_DEPARTURE_MIN : parsed;
}

// What a route snapshots about when a stop can be served.
function storeHoursOf(built) {
  return {
    openingTime: built.openingTime,
    closingTime: built.closingTime,
    preferredFrom: built.preferredDeliveryFrom,
    preferredTo: built.preferredDeliveryTo,
  };
}

// serviceMin: the route's own minutes-per-stop allowance (unset = default).
function toOptimizerStop(orderEntry, serviceMin) {
  const { windowOpen, windowClose } = stopWindow(orderEntry.storeHours);
  const stop = {
    id: String(orderEntry._id),
    coordinates: orderEntry.coordinates,
    windowOpen,
    windowClose,
    weightKg: orderEntry.orderWeightKg || 0,
  };
  if (Number.isFinite(serviceMin)) stop.serviceMin = serviceMin;
  return stop;
}

const stopsOf = (route, orders = route.orders) => orders.map((o) => toOptimizerStop(o, route.serviceMin));

// Copies one evaluated stop (ETA, wait, leg) onto its route entry. `infeasible`
// from the optimizer means "after the planned window closes"; for a customer
// with a preferred window that is only a missed preference unless the shop
// itself is closed by then.
function applyEvaluated(o, evaluated) {
  o.etaMin = evaluated.etaMin;
  o.waitMin = evaluated.waitMin;
  o.driveMin = evaluated.driveMin;
  o.legKm = evaluated.legKm;
  const w = stopWindow(o.storeHours);
  if (w.hasPreferred) {
    const shopClosed = w.shopClose != null && evaluated.etaMin > w.shopClose;
    o.preferredMissed = Boolean(evaluated.infeasible) && !shopClosed;
    o.status = statusAfterSequencing(o, shopClosed);
  } else {
    o.preferredMissed = undefined;
    o.status = statusAfterSequencing(o, evaluated.infeasible);
  }
}

// Real road distance/duration matrix for the depot plus the given stops
// (OSRM, cached). Resolves to null if the routing engine is unavailable, in
// which case the optimizer falls back to its haversine estimate.
async function roadMatrixFor(depot, stops) {
  const points = [depot, ...stops.map((s) => s.coordinates)];
  return getMatrix(points);
}

// Re-sequences a route's already-assigned, non-locked orders in place
// (cheapest insertion + 2-opt) — mutates `route.orders`/`totalDistanceKm`/
// `totalDurationMin` but does not save; callers save once, after whatever
// else they changed. `locked` stops (manually reordered by a dispatcher)
// keep their position and are excluded from re-sequencing.
async function resequenceRoute(route) {
  await sequenceRouteOrders(route);
  await applyTrafficEtas(route);
  clearLiveEtas(route);
}

// A re-planned route's old live ETAs no longer match its order; the next GPS
// fix recomputes them (utils/liveEta.js).
function clearLiveEtas(route) {
  route.liveEtaAt = undefined;
  route.liveEtaProvider = undefined;
  route.liveEtaFrom = undefined;
  route.orders.forEach((o) => {
    o.liveEtaMin = undefined;
    o.liveWaitMin = undefined;
    o.liveLate = undefined;
    o.liveTrafficMin = undefined;
    o.liveTrafficAt = undefined;
  });
}

// Once a route's order is final, replaces its leg times/distances with
// TomTom's traffic-aware ones (one request per route) and re-runs the same
// timeline (waits, service time, late flags) in that exact order. The order
// itself never changes here. Without TOMTOM_API_KEY, or if TomTom fails, the
// route keeps the ETAs it already has.
async function applyTrafficEtas(route) {
  route.trafficAt = undefined;
  route.trafficDepartAt = undefined;
  route.trafficDelayMin = undefined;
  route.trafficProvider = undefined;
  route.orders.forEach((o) => (o.plannedTrafficMin = undefined));
  const depot = getDepot(route.tenant);
  const stops = stopsOf(route);
  const geocoded = stops.filter(
    (s) => s.coordinates && Number.isFinite(s.coordinates.lat) && Number.isFinite(s.coordinates.lng)
  );
  if (geocoded.length === 0) return;

  const waypoints = [depot, ...geocoded.map((s) => s.coordinates), depot];
  const legs = await getTrafficLegs(waypoints, route.date, departureMinOf(route), depot.timeZone);
  if (!legs) return;
  // Same waypoint order the geometry endpoint uses (route.orders is in
  // sequence order here), so the map draws TomTom's line with no extra call.
  await saveRouteGeometry(waypoints, legs.positions, legs.provider);

  const fixed = evaluateFixedRoute(stops, depot, departureMinOf(route), undefined, legs);
  const byId = new Map(fixed.sequence.map((s) => [s.id, s]));
  // Leg i of the traffic answer ends at the i-th geocoded stop.
  const legDelayById = new Map(geocoded.map((s, i) => [s.id, legs.legDelayMin ? legs.legDelayMin[i] : null]));
  route.orders.forEach((o) => {
    const evaluated = byId.get(String(o._id));
    if (evaluated) {
      applyEvaluated(o, evaluated);
    }
    const delay = legDelayById.get(String(o._id));
    if (Number.isFinite(delay)) o.plannedTrafficMin = Math.round(delay);
  });
  route.totalDistanceKm = fixed.totalDistanceKm;
  route.totalDurationMin = fixed.totalDurationMin;
  route.totalWaitMin = fixed.totalWaitMin;
  route.trafficAt = new Date();
  route.trafficDepartAt = legs.departAt;
  route.trafficDelayMin = legs.delayMin;
  route.trafficProvider = legs.provider;
}

async function sequenceRouteOrders(route) {
  const depot = getDepot(route.tenant);
  const locked = route.orders.filter((o) => o.locked);
  const toSequence = stopsOf(route, route.orders.filter((o) => !o.locked));
  const matrix = await roadMatrixFor(depot, stopsOf(route));

  // Uses whatever strategy was last chosen for this route (persisted on the
  // document, default "shortest") — a manual assign/remove's automatic
  // re-sequence should never silently revert a dispatcher's "least_wait"
  // choice back to distance-only.
  const { sequence, totalDistanceKm, totalDurationMin, totalWaitMin } = sequenceRoute(
    toSequence,
    depot,
    departureMinOf(route),
    undefined,
    route.strategy || "shortest",
    matrix
  );
  route.distanceSource = matrix ? "road" : "estimate";
  route.roadProvider = matrix ? matrix.provider : undefined;

  // Nothing locked: the optimizer's own result already covers the whole route.
  if (locked.length === 0) {
    const bySeqId = new Map(sequence.map((s) => [s.id, s]));
    route.orders = route.orders.map((o) => {
      const optimized = bySeqId.get(String(o._id));
      if (optimized) {
        o.sequenceNumber = optimized.seq;
        applyEvaluated(o, optimized);
      }
      return o;
    });
    route.orders.sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0));
    route.totalDistanceKm = totalDistanceKm;
    route.totalDurationMin = totalDurationMin;
    route.totalWaitMin = totalWaitMin;
    return;
  }

  // Some (or all) stops are locked. Locked stops keep their slot; the
  // optimizer's order fills the remaining slots (stops it couldn't place,
  // e.g. no coordinates, go last in their previous relative order). Then the
  // WHOLE route is evaluated in that exact order, so totals, ETAs and
  // sequence numbers always describe every stop — sequencing only the
  // unlocked ones used to leave totals at 0 (all locked) or partial, and
  // sequence numbers colliding (some locked).
  const total = route.orders.length;
  const slots = new Array(total).fill(null);
  [...locked]
    .sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0))
    .forEach((o) => {
      let pos = Math.min(Math.max((o.sequenceNumber || 1) - 1, 0), total - 1);
      while (slots[pos] !== null && pos < total - 1) pos++;
      while (slots[pos] !== null && pos > 0) pos--;
      slots[pos] = o;
    });
  const bySeqId = new Map(sequence.map((s) => [s.id, s]));
  const unlocked = route.orders.filter((o) => !o.locked);
  const placed = sequence.map((s) => unlocked.find((o) => String(o._id) === s.id)).filter(Boolean);
  const unplaced = unlocked
    .filter((o) => !bySeqId.has(String(o._id)))
    .sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0));
  const fillQueue = [...placed, ...unplaced];
  const ordered = slots.map((o) => o || fillQueue.shift());

  const fixed = evaluateFixedRoute(stopsOf(route, ordered), depot, departureMinOf(route), undefined, matrix);
  const evalById = new Map(fixed.sequence.map((s) => [s.id, s]));
  ordered.forEach((o, i) => {
    o.sequenceNumber = i + 1;
    const evaluated = evalById.get(String(o._id));
    if (evaluated) {
      applyEvaluated(o, evaluated);
    }
  });
  route.orders = ordered;
  route.totalDistanceKm = fixed.totalDistanceKm;
  route.totalDurationMin = fixed.totalDurationMin;
  route.totalWaitMin = fixed.totalWaitMin;
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

    if (req.body.strategy && ["shortest", "least_wait"].includes(req.body.strategy)) {
      route.strategy = req.body.strategy;
    }

    await resequenceRoute(route);
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

    if (req.body.strategy && ["shortest", "least_wait"].includes(req.body.strategy)) {
      route.strategy = req.body.strategy;
    }

    const dayStart = new Date(route.date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(23, 59, 59, 999);

    const deliveryNotes = await loadPool(dayStart, dayEnd, route.tenant);

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
        storeHours: storeHoursOf(built),
      });

      remainingCapacity -= built.totalWeight;
      assigned.add(deliveryNote.DocEntry);
      ordersAdded++;
    }

    recalcTotals(route);

    // Sequence what we just built (respects route.strategy and locked stops
    // — see resequenceRoute above).
    await resequenceRoute(route);

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
// Total time the cross-truck improvement step may use across all regions of one Auto-Fill request.
const AUTOFILL_IMPROVE_TOTAL_MS = Number(process.env.AUTOFILL_IMPROVE_TOTAL_MS) > 0 ? Number(process.env.AUTOFILL_IMPROVE_TOTAL_MS) : 20000;

exports.autoFillAllTrucks = async (req, res) => {
  try {
    const { date } = req.params;
    const tenant = tenantFromReq(req);
    const strategy = ["shortest", "least_wait"].includes(req.body.strategy) ? req.body.strategy : "shortest";

    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(23, 59, 59, 999);

    const routes = await TruckRoute.find({ date: { $gte: dayStart, $lte: dayEnd }, tenant });
    if (routes.length === 0) {
      return res.status(400).json({
        message: `There are no trucks for this date: no active weekly template for ${dayOfWeekFor(date)}. Add one in the Weekly Templates tab.`,
      });
    }
    // Persist the chosen strategy on every route for this date right away —
    // not just the ones that end up in touchedRoutes below. A region with no
    // unassigned orders this run never enters that set, so without this a
    // route in it would keep showing "least_wait" chosen but silently still
    // be set to "shortest" in the database until something else saves it.
    await Promise.all(
      routes
        .filter((r) => r.strategy !== strategy)
        .map((r) => {
          r.strategy = strategy;
          return r.save();
        })
    );

    const deliveryNotes = await loadPool(dayStart, dayEnd, tenant);
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
      if (!customer) {
        // An explicitly selected order is never dropped without a word.
        unassignable.push({
          docEntry: deliveryNote.DocEntry,
          cardName: deliveryNote.CardName,
          reason: `customer ${deliveryNote.CardCode} not found in the customer list`,
        });
        continue;
      }
      if (customer.fulfillmentMethod === "pickup") {
        unassignable.push({ docEntry: deliveryNote.DocEntry, cardName: deliveryNote.CardName, reason: "pickup customer (collects the order)" });
        continue;
      }

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

    const autoFillStartedAt = Date.now();
    const planningReport = [];
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

      // The region's trucks as the optimizer sees them BEFORE any new order:
      // existing stops only, plus how much room each truck has left.
      const baseTrucks = regionRoutes.map((route) => ({
        id: route._id.toString(),
        departureMin: departureMinOf(route),
        capacityKg: route.maxWeightKg,
        remainingKg: route.maxWeightKg - route.totalWeightKg,
        stops: route.orders.map((o) => ({
          ...toOptimizerStop(o, route.serviceMin),
          locked: o.locked,
          _raw: o,
        })),
      }));
      // The new orders, as optimizer stops. `_built` carries the full order
      // through so the winning plan can create the TruckRoute entries.
      const regionServiceMin = regionRoutes.find((r) => Number.isFinite(r.serviceMin))?.serviceMin;
      const poolStops = pool.map((o) => ({
        ...toOptimizerStop(
          { _id: `new:${o.DocEntry}`, coordinates: o.coordinates, storeHours: storeHoursOf(o), orderWeightKg: o.totalWeight },
          regionServiceMin
        ),
        _built: o,
      }));

      const matrix = await roadMatrixFor(depot, [...baseTrucks.flatMap((t) => t.stops), ...poolStops]);

      // Two ways of grouping the new orders into trucks: by angle around the
      // depot (fills trucks tightly, but can split neighbours) and by
      // proximity (keeps neighbours together, can leave a truck less full and
      // ignores shop hours). Neither is always better, so plan both without
      // touching anything and apply whichever is better for the chosen
      // strategy. Ties keep the angle grouping (the previous behaviour). One
      // shared time budget covers the whole request, split between the two.
      const budgetMs = Math.max(500, AUTOFILL_IMPROVE_TOTAL_MS - (Date.now() - autoFillStartedAt));
      // "Least wait" gets a third candidate that plans around shop opening
      // hours ("timeline") and, in the improvement step, swaps stops between
      // full trucks. "Shortest" keeps exactly the two plans it always had.
      const methods = strategy === "least_wait" ? ["sweep", "proximity", "timeline"] : ["sweep", "proximity"];
      const candidates = [];
      for (const method of methods) {
        candidates.push(
          await planRegionAssignment({ poolStops, trucks: baseTrucks, depot, strategy, matrix, method, maxMs: budgetMs / methods.length })
        );
      }
      let chosen = candidates[0];
      for (const candidate of candidates.slice(1)) {
        if (isBetterPlan(candidate.summary, chosen.summary, strategy)) chosen = candidate;
      }
      candidates.forEach((c) => {
        if (c.improved.timedOut) {
          console.warn(`[autoFill] "${c.method}" plan hit its time budget in region "${region}" - valid, just not fully polished`);
        }
      });
      planningReport.push({
        region,
        strategy,
        chosen: chosen.method,
        candidates: candidates.map((c) => ({
          method: c.method,
          km: Math.round(c.summary.km * 10) / 10,
          elapsedMin: Math.round(c.summary.elapsedMin),
          idleMin: Math.round(c.summary.idleMin),
          lateStops: c.summary.late,
          trucksUsed: c.summary.trucks,
          unassignedKg: Math.round(c.summary.unassignedKg * 10) / 10,
        })),
      });

      chosen.unassigned.forEach(({ stops: cluster, weightKg }) =>
        cluster.forEach((s) =>
          unassignable.push({
            docEntry: s._built.DocEntry,
            cardName: s._built.CardName,
            reason: `region "${region}" under-resourced for this date (a ${weightKg}kg group exceeds every available truck's remaining capacity)`,
          })
        )
      );

      chosen.improved.forEach((truckResult) => {
        const route = regionRoutes.find((r) => r._id.toString() === truckResult.id);
        if (!route) return;
        if (route.orders.length === 0 && truckResult.sequence.length === 0) return; // genuinely untouched, nothing to save

        // Drained to zero stops is a legitimate outcome (this truck wasn't
        // needed once its stops moved to trucks already covering the same
        // area), not skipped - otherwise the route would silently keep its
        // stale pre-improvement stops.
        route.orders = truckResult.sequence.map((s) => {
          let raw = s._raw;
          if (!raw) {
            // A new order from this run: create its TruckRoute entry now.
            const built = s._built;
            raw = {
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
                docType: built.docType,
              },
              orderWeightKg: built.totalWeight,
              coordinates: built.coordinates,
              storeHours: storeHoursOf(built),
            };
            totalAdded++;
          }
          // crossRouteImprove orders every stop freely, locked ones included
          // (it only needs costs). A dispatcher's manual slot must survive, so
          // a locked stop keeps its own sequenceNumber; resequenceRoute below
          // recomputes ETAs and totals around it.
          if (!raw.locked) raw.sequenceNumber = s.seq;
          applyEvaluated(raw, s);
          return raw;
        });
        recalcTotals(route);
        route.totalDistanceKm = truckResult.totalDistanceKm;
        route.totalDurationMin = truckResult.totalDurationMin;
        touchedRoutes.add(route);
      });
    }

    // Final sequence pass (cheapest insertion + 2-opt, respecting
    // route.strategy) for every route that received new stops.
    // crossRouteImprove above already sequenced routes it moved stops
    // between, but resequenceRoute is cheap and idempotent on an
    // already-optimal order, so running it uniformly here is simpler and
    // safer than tracking which routes still need it.
    //
    // Routes that already had orders but received nothing new this run (all
    // of the date's orders were assigned earlier) never enter touchedRoutes,
    // so they used to keep whatever distance/duration/ETAs they were saved
    // with — e.g. the old straight-line estimate — and re-running Auto-Fill
    // looked like it did nothing. Re-sequence them too (locked stops keep
    // their slot) so every route reflects the current strategy and road data.
    //
    // Each route is independent and may wait ~2 s on TomTom, so run a few at
    // a time instead of one after another.
    touchedRoutes.forEach((route) => recalcTotals(route));
    const toFinish = [
      ...touchedRoutes,
      ...routes.filter((route) => !touchedRoutes.has(route) && route.orders.length > 0),
    ];
    const FINISH_CONCURRENCY = 4;
    for (let i = 0; i < toFinish.length; i += FINISH_CONCURRENCY) {
      await Promise.all(
        toFinish.slice(i, i + FINISH_CONCURRENCY).map(async (route) => {
          await resequenceRoute(route);
          await route.save();
        })
      );
    }

    res.json({
      message: `Auto-filled ${totalAdded} order(s) across ${touchedRoutes.size} truck(s)`,
      totalAdded,
      unassignable,
      planning: planningReport,
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
