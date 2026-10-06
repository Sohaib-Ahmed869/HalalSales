// utils/liveEta.js
//
// Live ETAs from the truck's GPS (MyGeotab). The planned ETAs
// (etaMin/waitMin, computed when the route is optimized) are never changed;
// this adds a second, live estimate per remaining stop:
//
//   stop.liveEtaMin   minutes from midnight on the depot's clock (same clock
//                     as etaMin) when service at the stop should now begin
//   stop.liveWaitMin  wait for opening still expected there
//   stop.liveLate     true if it now can't be reached before closing
//   route.liveEtaAt / liveEtaProvider ("google" = live traffic, "estimate")
//
// How: start = the truck's latest fix at "now" (or, if the truck is at a stop
// it hasn't left yet, that stop once its service time is over), then the
// remaining stops (not visited yet, see utils/stopVisits.js) in their planned order go
// through the same timeline as planning (evaluateFixedRoute: drive time,
// waits for opening, service time, late flags), with Google live-traffic
// drive times (trafficEtaService) or the straight-line estimate if Google is
// unavailable.
//
// Recomputed at most every LIVE_ETA_INTERVAL_MIN per truck (default 10),
// and right away when GPS sees the truck reach or leave a stop. Only for today's
// route and fresh fixes. Each recompute is one Google request per 25 stops.
//
// Env: LIVE_ETA_ENABLED ("false" = off), LIVE_ETA_INTERVAL_MIN (10).

const TruckRoute = require("../models/TruckRoute");
const { evaluateFixedRoute, stopWindow, serviceOf } = require("./routeOptimizer");
const { getTrafficLegs } = require("./trafficEtaService");
const { getWarehouse } = require("./regions");

const cfg = () => ({
  enabled: process.env.LIVE_ETA_ENABLED !== "false",
  intervalMs: (Number(process.env.LIVE_ETA_INTERVAL_MIN) || 10) * 60 * 1000,
});

const FRESH_FIX_MS = 10 * 60 * 1000;
const lastRun = new Map(); // "tenant|truck" -> ms
const running = new Set();
const rerun = new Map(); // key -> latest { device, fix, onUpdated } forced while running

// Minutes since midnight of `date` on `timeZone`'s wall clock.
function clockMinutes(date, timeZone) {
  const parts = {};
  new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" })
    .formatToParts(date)
    .forEach((p) => (parts[p.type] = Number(p.value)));
  return parts.hour * 60 + parts.minute + date.getSeconds() / 60;
}

function dayRange(at) {
  const start = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  return { $gte: start, $lt: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

const toStop = (o, serviceMin) => {
  const { windowOpen, windowClose } = stopWindow(o.storeHours);
  const stop = { id: String(o._id), coordinates: o.coordinates, windowOpen, windowClose };
  if (Number.isFinite(serviceMin)) stop.serviceMin = serviceMin;
  return stop;
};

/**
 * Recomputes the live ETAs of the truck's remaining stops and saves them.
 * @returns {Promise<null|{ routeId: string, provider: string, stops: number }>}
 */
async function updateLiveEtas(device, position, now = new Date()) {
  const depot = getWarehouse(device.tenant);
  const route = await TruckRoute.findOne({
    tenant: device.tenant,
    truckNumber: device.truckNumber,
    date: dayRange(now),
  });
  if (!route) return null;

  const ordered = route.orders
    .filter((o) => o.coordinates && Number.isFinite(o.coordinates.lat) && Number.isFinite(o.coordinates.lng))
    .sort((a, b) => (a.sequenceNumber || 0) - (b.sequenceNumber || 0));
  const done = (o) => Boolean(o.departedAt) || o.status === "delivered" || o.status === "failed";
  const open = ordered.filter((o) => !done(o));

  // Truck parked at a stop: it leaves there once that stop's service time is over.
  const nowMin = clockMinutes(now, depot.timeZone);
  let start = { lat: position.lat, lng: position.lng };
  let startMin = nowMin;
  let remaining = open;
  const here = open.find((o) => o.arrivedAt);
  if (here) {
    const arrivedMin = nowMin - (now - here.arrivedAt) / 60000;
    start = here.coordinates;
    startMin = Math.max(nowMin, arrivedMin + serviceOf(toStop(here, route.serviceMin)));
    here.liveEtaMin = Math.round(arrivedMin);
    here.liveWaitMin = 0;
    here.liveLate = false;
    remaining = open.filter((o) => o !== here);
  }

  // Stops the truck has already been to don't get a live ETA any more.
  ordered.forEach((o) => {
    if (done(o)) {
      o.liveEtaMin = undefined;
      o.liveWaitMin = undefined;
      o.liveLate = undefined;
    }
  });

  let provider = "estimate";
  if (remaining.length > 0) {
    const stops = remaining.map((o) => toStop(o, route.serviceMin));
    // Truck -> remaining stops (no return leg: only the stop ETAs matter here).
    const legs = await getTrafficLegs([start, ...stops.map((s) => s.coordinates)], now, startMin, depot.timeZone);
    if (legs) provider = legs.provider;
    const fixed = evaluateFixedRoute(stops, start, startMin, undefined, legs || null);
    const byId = new Map(fixed.sequence.map((s) => [s.id, s]));
    remaining.forEach((o) => {
      const e = byId.get(String(o._id));
      if (!e) return;
      o.liveEtaMin = e.etaMin;
      o.liveWaitMin = e.waitMin;
      o.liveLate = e.infeasible;
    });
  }

  route.liveEtaAt = now;
  route.liveEtaProvider = provider;
  route.liveEtaFrom = { lat: position.lat, lng: position.lng };
  await route.save();
  return { routeId: String(route._id), provider, stops: remaining.length };
}

/**
 * Called for every GPS fix; recomputes when due. Never throws.
 * @param {boolean} force - the truck just reached or left a stop
 * @param {function} onUpdated - called with the result when ETAs changed
 */
async function maybeUpdateLiveEtas(device, fix, { force = false, onUpdated } = {}) {
  const c = cfg();
  if (!c.enabled) return;
  if (Date.now() - fix.recordedAt.getTime() > FRESH_FIX_MS) return; // old/buffered fix
  const key = `${device.tenant}|${device.truckNumber}`;
  if (running.has(key)) {
    // An arrival during a recompute must not be lost: run once more after.
    if (force) rerun.set(key, { device, fix, onUpdated });
    return;
  }
  if (!force && Date.now() - (lastRun.get(key) || 0) < c.intervalMs) return;
  running.add(key);
  lastRun.set(key, Date.now());
  try {
    const result = await updateLiveEtas(device, fix);
    if (result && onUpdated) onUpdated(result);
  } catch (error) {
    console.error("live ETA error:", error.message);
  } finally {
    running.delete(key);
    const next = rerun.get(key);
    if (next) {
      rerun.delete(key);
      maybeUpdateLiveEtas(next.device, next.fix, { force: true, onUpdated: next.onUpdated });
    }
  }
}

module.exports = { maybeUpdateLiveEtas, updateLiveEtas, clockMinutes };
