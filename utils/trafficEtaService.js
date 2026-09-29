// utils/trafficEtaService.js
//
// Traffic-aware drive times for an already-sequenced route, from TomTom's
// Calculate Route API (one request per truck route: depot -> stops -> depot).
// The stop ORDER still comes from the optimizer (OpenRouteService/OSRM
// matrix); TomTom only replaces each leg's km/minutes so ETAs reflect traffic.
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

const MAX_WAYPOINTS = 150;

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
 * @returns {Promise<null|{ index: Map<string,number>, distKm: number[][], durMin: number[][], delayMin: number, departAt: string }>}
 *   a sparse matrix holding only consecutive legs, in the shape routeOptimizer's makeLegs expects
 */
async function getTrafficLegs(points, routeDate, departureMin) {
  const cfg = config();
  if (!cfg.enabled) return null;
  if (points.length < 2 || points.length > MAX_WAYPOINTS) return null;
  if (!points.every((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng))) return null;

  const departAt = departAtFor(routeDate, departureMin);
  if (!departAt) return null;

  const path = points.map((p) => `${Number(p.lat).toFixed(5)},${Number(p.lng).toFixed(5)}`).join(":");
  const requestKey = `${path}|${departAt}`;
  const hit = cache.get(requestKey);
  if (hit && Date.now() - hit.at < cfg.cacheMs) return hit.value;

  const today = localDay(new Date());
  if (usage.day !== today) {
    usage.day = today;
    usage.count = 0;
  }
  if (usage.count >= cfg.dailyLimit) {
    console.warn(`[trafficEta] daily limit of ${cfg.dailyLimit} TomTom requests reached, keeping non-traffic ETAs`);
    return null;
  }
  usage.count++;

  try {
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
    if (!Array.isArray(legs) || legs.length !== points.length - 1) {
      throw new Error(`expected ${points.length - 1} legs, got ${Array.isArray(legs) ? legs.length : "none"}`);
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
    legs.forEach((leg, i) => {
      const s = leg.summary || {};
      const a = index.get(pointKey(points[i]));
      const b = index.get(pointKey(points[i + 1]));
      if (a === b || !Number.isFinite(s.lengthInMeters) || !Number.isFinite(s.travelTimeInSeconds)) return;
      distKm[a][b] = s.lengthInMeters / 1000;
      durMin[a][b] = s.travelTimeInSeconds / 60;
      // trafficDelayInSeconds only counts live incidents (0 for a future
      // departure), so measure against free-flow time to include typical
      // rush-hour slowdown too.
      delaySec += Number.isFinite(s.noTrafficTravelTimeInSeconds)
        ? Math.max(0, s.travelTimeInSeconds - s.noTrafficTravelTimeInSeconds)
        : Number(s.trafficDelayInSeconds) || 0;
    });

    const value = { index, distKm, durMin, delayMin: Math.round(delaySec / 60), departAt };
    cache.set(requestKey, { at: Date.now(), value });
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return value;
  } catch (error) {
    const body = error.response?.data;
    const detail = body?.error?.description || body?.detailedError?.message || body?.errorText;
    console.warn("[trafficEta] TomTom unavailable, keeping non-traffic ETAs:", error.message, detail || "");
    return null;
  }
}

module.exports = { getTrafficLegs, departAtFor };
