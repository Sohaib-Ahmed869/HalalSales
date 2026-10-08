// utils/trafficEtaService.js
//
// Traffic-aware drive times for an already-sequenced route (depot -> stops ->
// depot). Provider: Google Routes API computeRoutes (TRAFFIC_AWARE, one
// request per 25 stops) when GOOGLE_MAPS_API_KEY is set, otherwise TomTom's
// Calculate Route API (one request per route) when TOMTOM_API_KEY is set.
// The stop ORDER still comes from the optimizer (the planning matrix); this
// only replaces each leg's km/minutes so ETAs reflect traffic.
//
// Google env: GOOGLE_TRAFFIC_ENABLED ("false" = skip Google here),
// GOOGLE_TRAFFIC_DAILY_LIMIT (requests per server day, default 600).
// The rest of this header describes TomTom; Google behaves the same way
// (typical traffic for a later departure, live for "now", legs timed as one
// continuous drive) but has no truck mode.
//
// Traffic model: for a route planned for later (e.g. tomorrow) TomTom uses
// typical traffic for that departure time; for a departure that is now or
// already past today it uses live traffic ("now"). TomTom times the legs as
// one continuous drive, so later legs' traffic is looked up slightly early
// (it doesn't know about waits and service time at the stops).
//
// Returns null (caller keeps the optimizer's own ETAs) when disabled, over the
// daily cap, the route is in the past, or TomTom fails.
//
// Env:
//   TOMTOM_API_KEY          enables it (free key from developer.tomtom.com)
//   TOMTOM_ENABLED          set to "false" to switch it off even with a key
//   TOMTOM_URL              default https://api.tomtom.com
//   TOMTOM_TIMEOUT_MS       default 15000
//   TOMTOM_TRAVEL_MODE      default "truck" ("car" also works)
//   TOMTOM_VEHICLE_WEIGHT_KG, TOMTOM_VEHICLE_HEIGHT_M, TOMTOM_VEHICLE_LENGTH_M,
//   TOMTOM_VEHICLE_WIDTH_M  optional truck size, so restricted roads are avoided
//   TOMTOM_DAILY_LIMIT      max requests per server day, default 600
//                           (free tier is 20,000 routing requests a month)
//   TOMTOM_CACHE_MIN        reuse an identical request for this long, default 10

const axios = require("axios");
const { pointKey } = require("./routeOptimizer");
const google = require("./googleMapsClient");

const MAX_WAYPOINTS = 150;
const GOOGLE_MAX_POINTS = 27; // origin + 25 intermediates + destination

const googleEnabled = () => google.config().routesEnabled && process.env.GOOGLE_TRAFFIC_ENABLED !== "false";

const config = () => ({
  key: process.env.TOMTOM_API_KEY || "",
  enabled: Boolean(process.env.TOMTOM_API_KEY) && process.env.TOMTOM_ENABLED !== "false",
  url: (process.env.TOMTOM_URL || "https://api.tomtom.com").replace(/\/+$/, ""),
  timeout: Number(process.env.TOMTOM_TIMEOUT_MS) || 15000,
  travelMode: process.env.TOMTOM_TRAVEL_MODE || "truck",
  dailyLimit: Number(process.env.TOMTOM_DAILY_LIMIT) || 600,
  cacheMs: (Number(process.env.TOMTOM_CACHE_MIN) || 10) * 60 * 1000,
  vehicle: {
    vehicleWeight: Number(process.env.TOMTOM_VEHICLE_WEIGHT_KG) || undefined,
    vehicleHeight: Number(process.env.TOMTOM_VEHICLE_HEIGHT_M) || undefined,
    vehicleLength: Number(process.env.TOMTOM_VEHICLE_LENGTH_M) || undefined,
    vehicleWidth: Number(process.env.TOMTOM_VEHICLE_WIDTH_M) || undefined,
  },
});

const usage = { day: "", count: 0 };
const cache = new Map(); // requestKey -> { at, value }
const CACHE_MAX = 200;

const pad = (n) => String(n).padStart(2, "0");
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// "YYYY-MM-DDTHH:MM:00" with no offset (TomTom then uses the depot's own time
// zone, matching the naive "HH:MM" departure times), "now", or null when the
// route's day is already over.
function departAtFor(routeDate, departureMin, now = new Date()) {
  const date = routeDate ? new Date(routeDate) : now;
  if (Number.isNaN(date.getTime())) return "now";
  const day = localDay(date);
  const today = localDay(now);
  if (day < today) return null;
  const h = Math.floor(departureMin / 60);
  const m = Math.round(departureMin % 60);
  const planned = new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m);
  if (planned.getTime() <= now.getTime() + 60 * 1000) return "now";
  return `${day}T${pad(h)}:${pad(m)}:00`;
}

/**
 * @param {Array<{lat:number,lng:number}>} points - depot, stops in visit order, depot
 * @param {Date|string} routeDate
 * @param {number} departureMin - minutes from midnight the truck leaves
 * @returns {Promise<null|{ index: Map<string,number>, distKm: number[][], durMin: number[][], delayMin: number, departAt: string, positions: Array<[number,number]> }>}
 *   a sparse matrix holding only consecutive legs, in the shape routeOptimizer's makeLegs expects
 */
async function getTrafficLegs(points, routeDate, departureMin, timeZone) {
  const cfg = config();
  const provider = googleEnabled() ? "google" : cfg.enabled ? "tomtom" : null;
  if (!provider) return null;
  if (points.length < 2 || points.length > MAX_WAYPOINTS) return null;
  if (!points.every((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng))) return null;

  const departAt = departAtFor(routeDate, departureMin);
  if (!departAt) return null;

  const path = points.map((p) => `${Number(p.lat).toFixed(5)},${Number(p.lng).toFixed(5)}`).join(":");
  const requestKey = `${provider}|${path}|${departAt}`;
  const hit = cache.get(requestKey);
  if (hit && Date.now() - hit.at < cfg.cacheMs) return hit.value;

  const requests = provider === "google" ? Math.ceil((points.length - 1) / (GOOGLE_MAX_POINTS - 1)) : 1;
  const dailyLimit = provider === "google" ? Number(process.env.GOOGLE_TRAFFIC_DAILY_LIMIT) || 600 : cfg.dailyLimit;
  const today = localDay(new Date());
  if (usage.day !== today) {
    usage.day = today;
    usage.count = 0;
  }
  if (usage.count + requests > dailyLimit) {
    console.warn(`[trafficEta] daily limit of ${dailyLimit} ${provider} requests reached, keeping non-traffic ETAs`);
    return null;
  }
  usage.count += requests;

  try {
    // Each leg: { meters, seconds, freeFlowSeconds, positions: [[lat, lng], ...] }
    const rawLegs =
      provider === "google" ? await googleLegs(points, departAt, timeZone) : await tomtomLegs(cfg, path, departAt);
    if (rawLegs.length !== points.length - 1) {
      throw new Error(`expected ${points.length - 1} legs, got ${rawLegs.length}`);
    }

    const keys = [];
    const index = new Map();
    points.forEach((p) => {
      const k = pointKey(p);
      if (!index.has(k)) {
        index.set(k, keys.length);
        keys.push(k);
      }
    });
    const n = keys.length;
    const distKm = Array.from({ length: n }, () => new Array(n).fill(NaN));
    const durMin = Array.from({ length: n }, () => new Array(n).fill(NaN));
    for (let i = 0; i < n; i++) {
      distKm[i][i] = 0;
      durMin[i][i] = 0;
    }
    let delaySec = 0;
    // Traffic delay of each leg (leg i = points[i] -> points[i + 1]) against free flow.
    const legDelayMin = rawLegs.map((leg) =>
      Number.isFinite(leg.seconds) && Number.isFinite(leg.freeFlowSeconds) ? Math.max(0, leg.seconds - leg.freeFlowSeconds) / 60 : null
    );
    // Drive time of each leg in this traffic.
    const legMin = rawLegs.map((leg) => (Number.isFinite(leg.seconds) ? leg.seconds / 60 : null));
    rawLegs.forEach((leg, i) => {
      const a = index.get(pointKey(points[i]));
      const b = index.get(pointKey(points[i + 1]));
      if (a === b || !Number.isFinite(leg.meters) || !Number.isFinite(leg.seconds)) return;
      distKm[a][b] = leg.meters / 1000;
      durMin[a][b] = leg.seconds / 60;
      if (Number.isFinite(leg.freeFlowSeconds)) delaySec += Math.max(0, leg.seconds - leg.freeFlowSeconds);
    });

    // The road line that was driven, so the map can draw it without another request.
    const positions = [];
    rawLegs.forEach((leg) =>
      leg.positions.forEach((pt) => {
        const last = positions[positions.length - 1];
        const p = [Math.round(pt[0] * 1e5) / 1e5, Math.round(pt[1] * 1e5) / 1e5];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) positions.push(p);
      })
    );

    const value = { index, distKm, durMin, delayMin: Math.round(delaySec / 60), legDelayMin, legMin, departAt, positions, provider };
    cache.set(requestKey, { at: Date.now(), value });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return value;
  } catch (error) {
    const body = error.response?.data;
    const detail =
      provider === "google"
        ? google.errorText(error)
        : `${error.message} ${body?.error?.description || body?.detailedError?.message || body?.errorText || ""}`;
    console.warn(`[trafficEta] ${provider} unavailable, keeping non-traffic ETAs:`, detail);
    return null;
  }
}

// Milliseconds between UTC and `timeZone`'s wall clock at instant `ms`.
function zoneOffsetMs(ms, timeZone) {
  const parts = {};
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(new Date(ms))
    .forEach((p) => (parts[p.type] = Number(p.value)));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - ms;
}

// "YYYY-MM-DDTHH:MM:00" on the depot's clock -> epoch ms. TomTom reads the
// naive string as the depot's local time itself; Google needs an exact
// instant. Without a time zone, falls back to the server clock.
function wallClockToMs(departAt, timeZone) {
  const [d, t] = departAt.split("T");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  if (!timeZone) return new Date(y, mo - 1, da, h, mi).getTime();
  const asUtc = Date.UTC(y, mo - 1, da, h, mi);
  const first = asUtc - zoneOffsetMs(asUtc, timeZone);
  return asUtc - zoneOffsetMs(first, timeZone); // second pass settles DST edges
}

// Google: chunks of <= 27 points; each later chunk departs when the previous
// one arrives (same "one continuous drive" approximation as TomTom).
async function googleLegs(points, departAt, timeZone) {
  const departMs = departAt === "now" ? null : wallClockToMs(departAt, timeZone);
  const legs = [];
  let elapsedSec = 0;
  for (let start = 0; start < points.length - 1; start += GOOGLE_MAX_POINTS - 1) {
    const chunk = points.slice(start, start + GOOGLE_MAX_POINTS);
    // "now": the first chunk omits departureTime (= now). Google rejects a
    // departure in the past, so never send one earlier than a minute ahead.
    let departureTime;
    if (departMs != null || start > 0) {
      const at = (departMs == null ? Date.now() : departMs) + elapsedSec * 1000;
      departureTime = new Date(Math.max(at, Date.now() + 60000)).toISOString();
    }
    const { legs: got } = await google.computeRoute(chunk, { trafficAware: true, departureTime });
    got.forEach((leg) => {
      legs.push({
        meters: leg.distanceMeters,
        seconds: leg.durationSec,
        freeFlowSeconds: leg.staticDurationSec,
        positions: leg.positions,
      });
      elapsedSec += leg.durationSec;
    });
  }
  return legs;
}

async function tomtomLegs(cfg, path, departAt) {
  const params = {
    key: cfg.key,
    traffic: true,
    travelMode: cfg.travelMode,
    routeType: "fastest",
    computeTravelTimeFor: "all", // adds noTrafficTravelTimeInSeconds, for the delay shown in the UI
    departAt,
    ...(cfg.travelMode === "truck" ? { vehicleCommercial: true } : {}),
  };
  Object.entries(cfg.vehicle).forEach(([k, v]) => {
    if (v) params[k] = v;
  });
  const { data } = await axios.get(`${cfg.url}/routing/1/calculateRoute/${path}/json`, {
    params,
    timeout: cfg.timeout,
  });
  const legs = data?.routes?.[0]?.legs;
  if (!Array.isArray(legs)) throw new Error("TomTom returned no legs");
  return legs.map((leg) => {
    const s = leg.summary || {};
    // trafficDelayInSeconds only counts live incidents (0 for a future
    // departure), so measure against free-flow time to include typical
    // rush-hour slowdown too.
    const freeFlowSeconds = Number.isFinite(s.noTrafficTravelTimeInSeconds)
      ? s.noTrafficTravelTimeInSeconds
      : s.travelTimeInSeconds - (Number(s.trafficDelayInSeconds) || 0);
    return {
      meters: s.lengthInMeters,
      seconds: s.travelTimeInSeconds,
      freeFlowSeconds,
      positions: (leg.points || []).map((pt) => [pt.latitude, pt.longitude]),
    };
  });
}

module.exports = { getTrafficLegs, departAtFor, wallClockToMs };
