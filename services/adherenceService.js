// services/adherenceService.js
//
// Builds the planned-vs-actual report for every truck route of a day:
// planned schedule from the TruckRoute, actual drive from the truck's GPS
// breadcrumb (topped up from MyGeotab first), compared by
// utils/routeAdherence.js and stored in RouteAdherence.
//
// Runs on demand (Planned vs Actual tab, "Recalculate") and once every
// evening (ADHERENCE_CRON, default 21:00 on the depot's clock) for that day.
//
// Env: ADHERENCE_CRON ("off" disables the evening run), ADHERENCE_* thresholds
// (utils/routeAdherence.js).

const cron = require("node-cron");
const TruckRoute = require("../models/TruckRoute");
const TruckDevice = require("../models/TruckDevice");
const TruckPosition = require("../models/TruckPosition");
const RouteAdherence = require("../models/RouteAdherence");
const geotabSync = require("./geotabSync");
const { analyzeRoute } = require("../utils/routeAdherence");
const { parseTimeToMinutes, DEFAULT_DEPARTURE_MIN, DEFAULT_SERVICE_MIN } = require("../utils/routeOptimizer");
const { getWarehouse } = require("../utils/regions");
const { getRouteGeometry } = require("../utils/roadDistanceService");
const { wallClockToMs } = require("../utils/trafficEtaService");

const TENANTS = ["halal-food-sales", "pqf", "data-tech", "ms-foods"];

const isoDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function dayBounds(date) {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setHours(23, 59, 59, 999);
  return { dayStart, dayEnd };
}

const validPoint = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);

// One route -> the analyzer's input and its result.
async function analyzeOne(route, device, { backfill = true, now = new Date() } = {}) {
  const depot = getWarehouse(route.tenant);
  // 00:00 of the route's day on the depot's clock; every time below is minutes from it.
  const midnightMs = wallClockToMs(`${isoDay(route.date)}T00:00:00`, depot.timeZone);
  const toMin = (d) => (new Date(d).getTime() - midnightMs) / 60000;

  const parsed = parseTimeToMinutes(route.departureTime);
  const departureMin = parsed == null ? DEFAULT_DEPARTURE_MIN : parsed;
  const serviceMin = Number.isFinite(route.serviceMin) ? route.serviceMin : DEFAULT_SERVICE_MIN;
  const ordered = (route.orders || []).slice().sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0));
  const stops = ordered.map((o, i) => ({
    docEntry: o.order?.DocEntry,
    name: o.order?.CardName || "Unknown",
    seq: o.sequenceNumber || i + 1,
    lat: o.coordinates?.lat,
    lng: o.coordinates?.lng,
    etaMin: o.etaMin,
    waitMin: o.waitMin || 0,
    serviceMin,
    plannedTrafficMin: o.plannedTrafficMin,
    liveTrafficMin: o.liveTrafficMin,
  }));
  const plannedReturnMin = departureMin + (route.totalDurationMin || 0);

  // The truck's day: from 3 h before the planned departure to 6 h after the
  // planned return (a late return can run past midnight).
  const from = new Date(midnightMs + (departureMin - 180) * 60000);
  const to = new Date(Math.min(now.getTime(), midnightMs + (plannedReturnMin + 360) * 60000));

  let points = [];
  let engine = [];
  if (device) {
    try {
      engine = await geotabSync.engineStops(device, from, to);
    } catch (error) {
      console.warn(`[adherence] Geotab trips for truck ${route.truckNumber} unavailable:`, error.message);
    }
    if (backfill) {
      try {
        await geotabSync.backfillDay(device, from, to);
      } catch (error) {
        console.warn(`[adherence] Geotab log for truck ${route.truckNumber} unavailable:`, error.message);
      }
    }
    points = await TruckPosition.find({ tenant: route.tenant, truckNumber: route.truckNumber, recordedAt: { $gte: from, $lte: to } })
      .sort({ recordedAt: 1 })
      .select("lat lng speedKmh recordedAt -_id")
      .lean();
  }

  // The road the truck was meant to follow (cached with the route line the map draws).
  let plannedLine = null;
  const waypoints = stops.filter(validPoint).map((s) => ({ lat: s.lat, lng: s.lng }));
  if (points.length > 1 && waypoints.length > 0) {
    try {
      plannedLine = await getRouteGeometry([depot, ...waypoints, depot]);
    } catch (error) {
      plannedLine = null;
    }
  }

  const result = analyzeRoute({
    depot,
    departureMin,
    plannedReturnMin,
    plannedKm: route.totalDistanceKm || 0,
    stops,
    points: points.map((p) => ({ lat: p.lat, lng: p.lng, speedKmh: p.speedKmh, t: toMin(p.recordedAt) })),
    plannedLine,
    engineStops: engine.map((e) => ({ startMin: toMin(e.from), endMin: toMin(e.to), offMin: e.offMin, idleMin: e.idleMin })),
    nowMin: toMin(now),
  });
  // Lets the page turn "minutes on the depot clock" back into real times.
  result.planned.serviceMin = serviceMin;
  return result;
}

/**
 * Recomputes and stores the report of every route with stops on `date`.
 * @returns {Promise<Array>} the stored reports
 */
async function runForDate(date, tenant = "halal-food-sales", options = {}) {
  const { dayStart, dayEnd } = dayBounds(date);
  const routes = await TruckRoute.find({ tenant, date: { $gte: dayStart, $lte: dayEnd } }).sort({ truckNumber: 1 }).lean();
  const devices = await TruckDevice.find({ tenant, isActive: true, provider: "geotab" }).lean();
  const deviceByTruck = new Map(devices.map((d) => [d.truckNumber, d]));

  const reports = [];
  for (const route of routes) {
    if (!route.orders || route.orders.length === 0) continue;
    const device = deviceByTruck.get(route.truckNumber) || null;
    const result = await analyzeOne(route, device, options);
    const doc = {
      routeId: route._id,
      tenant,
      date: dayStart,
      truckNumber: route.truckNumber,
      truckName: route.truckName || `Truck ${route.truckNumber}`,
      region: route.region,
      vehicle: device ? [device.label, device.licensePlate].filter(Boolean).join(" · ") : "",
      hasTracker: Boolean(device),
      ...result,
      computedAt: new Date(),
    };
    await RouteAdherence.replaceOne({ routeId: route._id }, doc, { upsert: true });
    reports.push(doc);
  }
  // Routes that were emptied or deleted since the last run.
  await RouteAdherence.deleteMany({ tenant, date: dayStart, routeId: { $nin: reports.map((r) => r.routeId) } });
  return reports;
}

async function getForDate(date, tenant = "halal-food-sales") {
  const { dayStart } = dayBounds(date);
  return RouteAdherence.find({ tenant, date: dayStart }).sort({ truckNumber: 1 }).lean();
}

let job = null;

// Evening run for the day that just ended, per tenant with routes.
function startCron() {
  const expr = process.env.ADHERENCE_CRON || "0 21 * * *";
  if (expr === "off" || job) return;
  if (!cron.validate(expr)) {
    console.warn(`[adherence] ADHERENCE_CRON "${expr}" is not a valid cron expression; evening report is off`);
    return;
  }
  job = cron.schedule(
    expr,
    async () => {
      for (const tenant of TENANTS) {
        try {
          const reports = await runForDate(isoDay(new Date()), tenant);
          if (reports.length > 0) {
            const deviations = reports.reduce((n, r) => n + r.deviations.length, 0);
            console.log(`[adherence] ${tenant}: ${reports.length} route(s) checked, ${deviations} deviation(s)`);
          }
        } catch (error) {
          console.error(`[adherence] evening run failed for ${tenant}:`, error.message);
        }
      }
    },
    { timezone: getWarehouse("halal-food-sales").timeZone }
  );
}

module.exports = { runForDate, getForDate, analyzeOne, startCron };
