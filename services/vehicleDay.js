// services/vehicleDay.js
//
// One vehicle, one day, read from MyGeotab: where it drove (GPS trail), every
// stop with arrival / departure time, how long, the engine idling, the street
// address (Geotab's GetAddresses) and a Google Maps link, the drives between
// them, speeding / idling events and fill-ups. Each stop is matched with what
// the portal planned for that truck that day (customer stops of its runs, the
// depot), so nobody has to log into MyGeotab to see what a truck did.
// Read-only: nothing is written to MyGeotab or to the database.
const geotab = require("../utils/geotabClient");
const TruckDevice = require("../models/TruckDevice");
const TruckRoute = require("../models/TruckRoute");
const { getWarehouse } = require("../utils/regions");
const { wallClockToMs } = require("../utils/trafficEtaService");
const { haversineKm } = require("../utils/routeOptimizer");

const DAY_MS = 24 * 60 * 60 * 1000;
// A stop within this distance of a planned customer / the depot is that place.
const STOP_MATCH_M = 150;
const DEPOT_MATCH_M = 300;
// The map trail is thinned to at most this many points.
const MAX_TRAIL_POINTS = 2500;
// Stops get a street address from Geotab, at most this many per day.
const MAX_ADDRESSES = 80;
const CACHE_MS = 3 * 60 * 1000;

const cache = new Map(); // "geotabId|date" -> { at, data }

const validFix = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);
const metres = (a, b) => haversineKm(a, b) * 1000;
const round1 = (n) => Math.round(n * 10) / 10;
const mapsUrl = (lat, lng) => `https://www.google.com/maps?q=${lat},${lng}`;

/** "HH:MM" of an instant on the depot's clock (the portal's planning clock). */
function clockOf(at, timeZone) {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));
}

// Same server-local day convention as the truck routes (truckRoute.controller dayBounds).
function routeDayBounds(date) {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setHours(23, 59, 59, 999);
  return { dayStart, dayEnd };
}

/** Keeps every n-th point (always the first and last) so the trail stays light. */
function thin(points, max) {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out = [];
  for (let i = 0; i < max - 1; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

async function addressesFor(points) {
  if (points.length === 0) return [];
  try {
    const result = await geotab.call("GetAddresses", { coordinates: points.map((p) => ({ x: p.lng, y: p.lat })), movingAddresses: false });
    return (result || []).map((a) => (a && a.formattedAddress ? String(a.formattedAddress).replace(/, France$/, "") : null));
  } catch (error) {
    console.warn("[vehicleDay] GetAddresses unavailable:", error.message);
    return points.map(() => null);
  }
}

/**
 * @param {Object} args
 * @param {string} args.geotabId - MyGeotab device id
 * @param {string} args.date - "YYYY-MM-DD" on the depot's calendar
 * @param {string} [args.tenant]
 * @param {boolean} [args.fresh] - skip the short cache
 */
async function vehicleDay({ geotabId, date, tenant = "halal-food-sales", fresh = false }) {
  const key = `${tenant}|${geotabId}|${date}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const depot = getWarehouse(tenant);
  const tz = depot.timeZone;
  // The depot's day: 00:00 to 24:00 on its own clock, whatever the server's clock is.
  const fromMs = wallClockToMs(`${date}T00:00:00`, tz);
  const from = new Date(fromMs);
  const to = new Date(fromMs + DAY_MS);
  const now = new Date();
  const until = to > now ? now : to;

  const [devices, device] = await Promise.all([geotab.getDevices(), TruckDevice.findOne({ geotabId, tenant }).lean()]);
  const vehicle = (devices || []).find((d) => d.id === geotabId);
  if (!vehicle) {
    const err = new Error("This vehicle is not in MyGeotab (or no longer active).");
    err.status = 404;
    throw err;
  }
  const base = {
    date,
    timeZone: tz,
    vehicle: {
      geotabId,
      name: vehicle.name,
      registration: vehicle.licensePlate || "",
      truckNumber: device?.truckNumber ?? null,
    },
    from,
    to: until,
    generatedAt: now,
  };
  if (from >= now) return { ...base, future: true, summary: null, stops: [], drives: [], trail: [], events: [], fillUps: [], planned: [] };

  const search = (typeName) => geotab.get(typeName, { deviceSearch: { id: geotabId }, fromDate: from.toISOString(), toDate: until.toISOString() });
  const [tripsRaw, logs, events, fills, rules] = await Promise.all([
    geotab.getTrips(geotabId, from, until),
    geotab.getLogRecords(geotabId, from, until),
    search("ExceptionEvent").catch(() => []),
    search("FillUp").catch(() => []),
    geotab.getRules().catch(() => []),
  ]);

  // Trips that belong to this day (Geotab may also return the one running over midnight).
  const trips = (tripsRaw || [])
    .filter((t) => new Date(t.stop) > from && new Date(t.start) < until)
    .sort((a, b) => new Date(a.start) - new Date(b.start));

  const trail = thin(
    (logs || [])
      .filter((r) => validFix(r.latitude, r.longitude))
      .sort((a, b) => new Date(a.dateTime) - new Date(b.dateTime))
      .map((r) => [Math.round(r.latitude * 1e5) / 1e5, Math.round(r.longitude * 1e5) / 1e5]),
    MAX_TRAIL_POINTS
  );

  // What the portal planned for this truck that day: every run's customer stops.
  let routes = [];
  if (device?.truckNumber != null) {
    const { dayStart, dayEnd } = routeDayBounds(date);
    routes = await TruckRoute.find({ tenant, truckNumber: device.truckNumber, date: { $gte: dayStart, $lte: dayEnd } })
      .sort({ trip: 1 })
      .lean();
  }
  const plannedStops = routes.flatMap((r) =>
    (r.orders || [])
      .filter((o) => o.coordinates && validFix(o.coordinates.lat, o.coordinates.lng))
      .sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0))
      .map((o) => ({
        run: r.trip || 1,
        seq: o.sequenceNumber,
        docEntry: o.order?.DocEntry,
        name: o.order?.CardName || "Customer",
        lat: o.coordinates.lat,
        lng: o.coordinates.lng,
        plannedAt: Number.isFinite(o.etaMin) ? `${String(Math.floor(o.etaMin / 60) % 24).padStart(2, "0")}:${String(o.etaMin % 60).padStart(2, "0")}` : null,
        visitedAt: null,
      }))
  );

  const fillUps = (fills || [])
    .map((f) => {
      const litres = Number.isFinite(f.volume) && f.volume > 0 ? f.volume : Number.isFinite(f.derivedVolume) ? f.derivedVolume : null;
      const loc = f.location && validFix(f.location.y, f.location.x) ? { lat: f.location.y, lng: f.location.x } : null;
      return {
        at: f.dateTime,
        clock: clockOf(f.dateTime, tz),
        litres: litres != null ? round1(litres) : null,
        cost: Number.isFinite(f.cost) ? Math.round(f.cost * 100) / 100 : null,
        currency: f.currencyCode || null,
        location: loc,
        mapsUrl: loc ? mapsUrl(loc.lat, loc.lng) : null,
      };
    })
    .sort((a, b) => new Date(a.at) - new Date(b.at));

  // Stops: each trip ends with a stop that lasts until the next trip starts.
  const stops = [];
  trips.forEach((t, i) => {
    const lat = t.stopPoint?.y;
    const lng = t.stopPoint?.x;
    if (!validFix(lat, lng)) return;
    const arrived = new Date(t.stop);
    const next = t.nextTripStart ? new Date(t.nextTripStart) : null;
    // The last stop of the day may still be going on (or run past midnight).
    const ongoing = !next || next > until;
    const left = ongoing ? null : next;
    const end = left || until;
    const durationMin = Math.max(0, (end - arrived) / 60000);
    const idleMin = Math.min(durationMin, geotab.timeSpanMinutes(t.idlingDuration));
    stops.push({
      index: stops.length + 1,
      arrivedAt: arrived,
      arrived: clockOf(arrived, tz),
      leftAt: left,
      left: left ? clockOf(left, tz) : null,
      ongoing,
      lastOfDay: i === trips.length - 1,
      durationMin: Math.round(durationMin),
      engineIdleMin: Math.round(idleMin),
      lat,
      lng,
      mapsUrl: mapsUrl(lat, lng),
      address: null,
      kind: "other",
      label: null,
    });
  });

  // What each stop was: the depot, a planned customer, a fill-up, or something else.
  stops.forEach((s) => {
    if (metres(s, depot) <= DEPOT_MATCH_M) {
      s.kind = "depot";
      s.label = "Depot";
      return;
    }
    let best = null;
    plannedStops.forEach((p) => {
      const d = metres(s, p);
      if (d <= STOP_MATCH_M && (!best || d < best.d)) best = { p, d };
    });
    if (best) {
      s.kind = "planned";
      s.label = best.p.name;
      s.plannedRun = best.p.run;
      s.plannedSeq = best.p.seq;
      s.plannedAt = best.p.plannedAt;
      if (!best.p.visitedAt) best.p.visitedAt = s.arrived;
      return;
    }
    const fill = fillUps.find((f) => {
      const at = new Date(f.at);
      return at >= new Date(s.arrivedAt.getTime() - 10 * 60000) && at <= new Date((s.leftAt || until).getTime() + 10 * 60000);
    });
    if (fill) {
      s.kind = "fuel";
      s.label = "Fuel fill-up";
    }
  });

  const addresses = await addressesFor(stops.slice(0, MAX_ADDRESSES));
  addresses.forEach((a, i) => (stops[i].address = a));

  const drives = trips.map((t) => ({
    start: clockOf(t.start, tz),
    end: clockOf(t.stop, tz),
    km: Number.isFinite(t.distance) ? round1(t.distance) : null,
    durationMin: Math.round(geotab.timeSpanMinutes(t.drivingDuration)),
    maxSpeedKmh: Number.isFinite(t.maximumSpeed) ? Math.round(t.maximumSpeed) : null,
  }));

  const ruleName = new Map((rules || []).map((r) => [r.id, r.name || r.id]));
  const kindOf = (id, name) => (/idl/i.test(name) || id === "RuleIdlingId" ? "idling" : /speed/i.test(name) || /Speeding/.test(id) ? "speeding" : "other");
  const eventRows = (events || [])
    .map((e) => {
      const id = e.rule?.id;
      const name = ruleName.get(id) || id || "Rule";
      const start = new Date(e.activeFrom);
      const end = new Date(e.activeTo);
      return {
        type: kindOf(id, name),
        rule: name,
        at: e.activeFrom,
        clock: clockOf(start, tz),
        durationMin: end > start ? round1((end - start) / 60000) : 0,
        distanceKm: Number.isFinite(e.distance) ? round1(e.distance) : null,
      };
    })
    .sort((a, b) => new Date(a.at) - new Date(b.at));

  const customerStops = stops.filter((s) => s.kind !== "depot");
  const summary = {
    km: round1(drives.reduce((n, d) => n + (d.km || 0), 0)),
    drivingMin: drives.reduce((n, d) => n + d.durationMin, 0),
    stops: customerStops.length,
    stoppedMin: customerStops.reduce((n, s) => n + s.durationMin, 0),
    engineIdleMin: stops.reduce((n, s) => n + s.engineIdleMin, 0),
    firstDeparture: trips.length > 0 ? clockOf(trips[0].start, tz) : null,
    lastArrival: trips.length > 0 ? clockOf(trips[trips.length - 1].stop, tz) : null,
    maxSpeedKmh: drives.reduce((m, d) => Math.max(m, d.maxSpeedKmh || 0), 0) || null,
    speeding: eventRows.filter((e) => e.type === "speeding").length,
    idling: eventRows.filter((e) => e.type === "idling").length,
    plannedStops: plannedStops.length,
    plannedVisited: plannedStops.filter((p) => p.visitedAt).length,
  };

  const data = {
    ...base,
    depot: { lat: depot.lat, lng: depot.lng },
    summary,
    stops,
    drives,
    trail,
    events: eventRows,
    fillUps,
    planned: routes.map((r) => ({
      run: r.trip || 1,
      routeId: String(r._id),
      departureTime: r.departureTime || "08:00",
      stops: plannedStops.filter((p) => p.run === (r.trip || 1)),
    })),
  };
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 50) cache.delete(cache.keys().next().value);
  return data;
}

module.exports = { vehicleDay, clockOf };
