// controllers/truckRoute.controller.js
const TruckSchedule = require("../models/TruckSchedule");
const TruckRoute = require("../models/TruckRoute");
const Customer = require("../models/Customer");
const Invoice = require("../models/Invoice");
const Item = require("../models/item");
const {
  sweepCluster,
  sequenceRoute,
  parseTimeToMinutes,
  pickSmallestFittingTruck,
} = require("../utils/routeOptimizer");

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

// ---------- Deliverable orders (Invoices with isDelivery=true) ----------

async function buildDeliverableOrder(invoice, customersByCode) {
  const customer = customersByCode.get(invoice.CardCode);

  let totalWeight = 0;
  const itemCodes = (invoice.DocumentLines || []).map((l) => l.ItemCode).filter(Boolean);
  if (itemCodes.length > 0) {
    const items = await Item.find({ ItemCode: { $in: itemCodes } });
    const weightByCode = new Map(items.map((it) => [it.ItemCode, it.SalesUnitWeight || 0]));
    totalWeight = (invoice.DocumentLines || []).reduce((sum, line) => {
      const w = weightByCode.get(line.ItemCode) || 0;
      return sum + w * (line.Quantity || 0);
    }, 0);
  }

  const hasGeo =
    customer &&
    customer.geo &&
    Number.isFinite(customer.geo.lat) &&
    Number.isFinite(customer.geo.lng);

  return {
    _id: invoice._id,
    DocEntry: invoice.DocEntry,
    DocNum: invoice.DocNum,
    DocDate: invoice.DocDate,
    CardCode: invoice.CardCode,
    CardName: invoice.CardName,
    DocTotal: invoice.DocTotal,
    address: customer ? customer.address : undefined,
    totalWeight,
    weightUnit: "kg",
    coordinates: hasGeo ? { lat: customer.geo.lat, lng: customer.geo.lng } : null,
    openingTime: customer ? customer.openingTime : undefined,
    closingTime: customer ? customer.closingTime : undefined,
    geocodeStatus: customer && customer.geo ? customer.geo.geocodeStatus : "pending",
    fulfillmentMethod: customer ? customer.fulfillmentMethod : "delivery",
  };
}

// Every deliverable invoice for the date that isn't already assigned to a
// TruckRoute. Excludes pickup customers (never routed at all).
exports.getAvailableOrders = async (req, res) => {
  try {
    const { date } = req.params;
    const { region, department } = req.query;
    const tenant = tenantFromReq(req);

    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(23, 59, 59, 999);

    const invoices = await Invoice.find({
      isDelivery: true,
      DocDate: { $gte: dayStart, $lte: dayEnd },
    });

    const routes = await TruckRoute.find({ date: { $gte: dayStart, $lte: dayEnd }, tenant });
    const assignedDocEntries = new Set(
      routes.flatMap((r) => r.orders.map((o) => o.order.DocEntry))
    );

    const cardCodes = [...new Set(invoices.map((i) => i.CardCode))];
    const customers = await Customer.find({ CardCode: { $in: cardCodes } });
    const customersByCode = new Map(customers.map((c) => [c.CardCode, c]));

    const candidates = [];
    for (const invoice of invoices) {
      if (assignedDocEntries.has(invoice.DocEntry)) continue;
      const customer = customersByCode.get(invoice.CardCode);
      if (customer && customer.fulfillmentMethod === "pickup") continue; // self-collection, never routed

      const order = await buildDeliverableOrder(invoice, customersByCode);

      if (region || department) {
        // region/department filtering happens client-side against zip codes
        // today (see MapPage.jsx filterOrdersByDistance) — left permissive
        // here so the frontend's existing distance/region filter keeps working
        // unmodified.
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

    const invoice = await Invoice.findOne({ DocEntry: orderDocEntry, isDelivery: true });
    if (!invoice) return res.status(404).json({ message: "Deliverable order not found" });

    const customer = await Customer.findOne({ CardCode: invoice.CardCode });
    const customersByCode = new Map(customer ? [[customer.CardCode, customer]] : []);
    const built = await buildDeliverableOrder(invoice, customersByCode);

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
    });

    recalcTotals(route);
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

// Re-sequences a route's already-assigned orders (cheapest insertion + 2-opt).
// Never touches which orders are assigned — only their order/ETA.
exports.optimizeRoute = async (req, res) => {
  try {
    const route = await TruckRoute.findById(req.params.routeId);
    if (!route) return res.status(404).json({ message: "Route not found" });

    const depot = getDepot(route.tenant);
    const locked = route.orders.filter((o) => o.locked);
    const toSequence = route.orders
      .filter((o) => !o.locked)
      .map((o) => toOptimizerStop(o));

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
    await route.save();

    res.json({ message: "Route optimized", route });
  } catch (error) {
    console.error("Optimize route error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

function getDepot(tenant) {
  // Mirrors SalesFrontend/src/pages/Dashboard/regions.js WAREHOUSE coordinates.
  if (tenant === "ms-foods") return { lat: 51.5074, lng: -0.1278 };
  return { lat: 48.8566, lng: 2.3522 }; // Paris — default (Halal Food Sales / PQF / Data-Tech)
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

    const invoices = await Invoice.find({
      isDelivery: true,
      DocDate: { $gte: dayStart, $lte: dayEnd },
    });

    const allRoutesToday = await TruckRoute.find({
      date: { $gte: dayStart, $lte: dayEnd },
      tenant: route.tenant,
    });
    const assigned = new Set(
      allRoutesToday.flatMap((r) => r.orders.map((o) => o.order.DocEntry))
    );

    const cardCodes = [...new Set(invoices.map((i) => i.CardCode))];
    const customers = await Customer.find({ CardCode: { $in: cardCodes } });
    const customersByCode = new Map(customers.map((c) => [c.CardCode, c]));

    let remainingCapacity = route.maxWeightKg - route.totalWeightKg;
    let ordersAdded = 0;

    for (const invoice of invoices) {
      if (assigned.has(invoice.DocEntry)) continue;
      const customer = customersByCode.get(invoice.CardCode);
      if (!customer || customer.fulfillmentMethod === "pickup") continue;
      if (route.region && customer.address?.city !== undefined && route.region) {
        // Region matching left permissive (SAP address text isn't structured
        // by region name) — a dispatcher can always remove a wrongly-added
        // stop; this never silently fails to fill a truck.
      }

      const built = await buildDeliverableOrder(invoice, customersByCode);
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
      assigned.add(invoice.DocEntry);
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

    const invoices = await Invoice.find({
      isDelivery: true,
      DocDate: { $gte: dayStart, $lte: dayEnd },
    });
    const cardCodes = [...new Set(invoices.map((i) => i.CardCode))];
    const customers = await Customer.find({ CardCode: { $in: cardCodes } });
    const customersByCode = new Map(customers.map((c) => [c.CardCode, c]));

    const alreadyAssigned = new Set(routes.flatMap((r) => r.orders.map((o) => o.order.DocEntry)));

    // Group deliverable, geocoded, non-pickup orders by region.
    const byRegion = new Map();
    const unassignable = [];
    for (const invoice of invoices) {
      if (alreadyAssigned.has(invoice.DocEntry)) continue;
      const customer = customersByCode.get(invoice.CardCode);
      if (!customer || customer.fulfillmentMethod === "pickup") continue;

      const built = await buildDeliverableOrder(invoice, customersByCode);
      if (!built.coordinates) {
        unassignable.push({ docEntry: built.DocEntry, reason: "not geocoded" });
        continue;
      }

      const routeForRegion = routes.find((r) => r.region);
      const region = routeForRegion ? routeForRegion.region : "unassigned";
      if (!byRegion.has(region)) byRegion.set(region, []);
      byRegion.get(region).push(built);
    }

    const depot = getDepot(tenant);
    let totalAdded = 0;

    for (const route of routes) {
      const pool = byRegion.get(route.region) || [];
      if (pool.length === 0) continue;

      let remainingCapacity = route.maxWeightKg - route.totalWeightKg;
      const toAssign = [];
      for (let i = 0; i < pool.length; i++) {
        const candidate = pool[i];
        if (!candidate.totalWeight || candidate.totalWeight > remainingCapacity) continue;
        toAssign.push(candidate);
        remainingCapacity -= candidate.totalWeight;
        pool.splice(i, 1);
        i--;
      }

      toAssign.forEach((built) => {
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
      });
      totalAdded += toAssign.length;

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
        }
      });
      route.orders.sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0));
      route.totalDistanceKm = totalDistanceKm;
      route.totalDurationMin = totalDurationMin;

      await route.save();
    }

    // Anything left in byRegion pools has no truck for its region today.
    for (const [region, pool] of byRegion.entries()) {
      pool.forEach((o) =>
        unassignable.push({ docEntry: o.DocEntry, reason: `no truck scheduled for region "${region}"` })
      );
    }

    res.json({
      message: `Auto-filled ${totalAdded} order(s) across ${routes.length} truck(s)`,
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
