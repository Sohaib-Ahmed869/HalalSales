// utils/roadDistanceService.js
//
// Real road distances/durations for the route optimizer (one call returns a
// full N x N matrix), cached per coordinate pair in Mongo. Returns null on any
// failure so callers fall back to the haversine estimate in routeOptimizer.js
// instead of breaking route planning.
//
// Providers, tried in this order:
//   1. OpenRouteService (hosted API, truck profile "driving-hgv") - only when
//      ORS_API_KEY is set. Free plan: daily request limits, no server needed.
//   2. OSRM (public demo server by default - testing only).
// If ORS fails (quota, outage, unroutable point) the whole matrix is fetched
// from OSRM instead, so one request never mixes car and truck durations.
//
// Env:
//   ORS_API_KEY           enables OpenRouteService (free key from openrouteservice.org)
//   ORS_URL               default https://api.openrouteservice.org
//   ORS_PROFILE           default "driving-hgv" (truck); "driving-car" also works
//   ORS_BLOCK_SIZE        max points per side of one matrix request, default 50
//                         (hosted limit is 3,500 origin x destination pairs)
//   ORS_DURATION_FACTOR   multiplier on ORS durations, default 1
//   ORS_ENABLED           set to "false" to skip ORS even with a key
//   OSRM_URL              base URL, default https://router.project-osrm.org
//                         (public demo server: testing only - self-host for
//                         production, see Logistics docs)
//   OSRM_PROFILE          default "driving"
//   OSRM_TIMEOUT_MS       default 15000 (also used for ORS)
//   OSRM_DURATION_FACTOR  multiplier on OSRM durations, default 1 (raise it,
//                         e.g. 1.2, to reflect slower loaded trucks)
//   OSRM_ENABLED          set to "false" to skip OSRM
//   OSRM_BLOCK_SIZE       max points per side of one /table request, default 40

const axios = require("axios");
const RoadDistanceCache = require("../models/RoadDistanceCache");
const { pointKey, haversineKm } = require("./routeOptimizer");

const ROAD_DISTANCE_FACTOR = 1.3; // same fallback factor as routeOptimizer
const FALLBACK_SPEED_KMH = 40;
const ORS_MAX_ROUTE_WAYPOINTS = 50; // hosted directions limit

const timeout = () => Number(process.env.OSRM_TIMEOUT_MS) || 15000;

function osrmConfig() {
  return {
    name: "osrm",
    url: (process.env.OSRM_URL || "https://router.project-osrm.org").replace(/\/+$/, ""),
    profile: process.env.OSRM_PROFILE || "driving",
    durationFactor: Number(process.env.OSRM_DURATION_FACTOR) || 1,
    enabled: process.env.OSRM_ENABLED !== "false",
    block: Math.max(2, Number(process.env.OSRM_BLOCK_SIZE) || 40),
    // OSRM entries were cached before providers existed; keep their plain
    // "lat,lng" keys so the existing cache stays valid.
    cachePrefix: "",
  };
}

function orsConfig() {
  const profile = process.env.ORS_PROFILE || "driving-hgv";
  return {
    name: "ors",
    url: (process.env.ORS_URL || "https://api.openrouteservice.org").replace(/\/+$/, ""),
    key: process.env.ORS_API_KEY || "",
    profile,
    durationFactor: Number(process.env.ORS_DURATION_FACTOR) || 1,
    enabled: Boolean(process.env.ORS_API_KEY) && process.env.ORS_ENABLED !== "false",
    block: Math.max(2, Math.min(59, Number(process.env.ORS_BLOCK_SIZE) || 50)),
    // Truck and car durations differ, so ORS legs are cached under their own keys.
    cachePrefix: `ors:${profile}|`,
  };
}

function providers() {
  return [orsConfig(), osrmConfig()].filter((p) => p.enabled);
}

function isValidPoint(p) {
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
}

function parseKey(key) {
  const [lat, lng] = key.split(",").map(Number);
  return { lat, lng };
}

// One matrix block: rows = sources, cols = destinations.
// Returns { distances[][] (metres), durations[][] (seconds) }.
async function fetchBlock(cfg, srcPts, dstPts) {
  if (cfg.name === "ors") {
    const locations = [...srcPts, ...dstPts].map((p) => [p.lng, p.lat]);
    const { data } = await axios.post(
      `${cfg.url}/v2/matrix/${cfg.profile}`,
      {
        locations,
        sources: srcPts.map((_, i) => i),
        destinations: dstPts.map((_, i) => srcPts.length + i),
        metrics: ["distance", "duration"],
        units: "m",
      },
      { headers: { Authorization: cfg.key, "Content-Type": "application/json" }, timeout: timeout() }
    );
    if (!data || !data.distances || !data.durations) throw new Error("ORS returned no matrix");
    return data;
  }

  const coords = [...srcPts, ...dstPts].map((p) => `${p.lng},${p.lat}`).join(";");
  const sources = srcPts.map((_, i) => i).join(";");
  const destinations = dstPts.map((_, i) => srcPts.length + i).join(";");
  const url = `${cfg.url}/table/v1/${cfg.profile}/${coords}`;
  const { data } = await axios.get(url, {
    params: { annotations: "distance,duration", sources, destinations },
    timeout: timeout(),
  });
  if (data.code !== "Ok" || !data.distances || !data.durations) {
    throw new Error(`OSRM returned ${data.code || "no data"}${data.message ? `: ${data.message}` : ""}`);
  }
  return data;
}

function errorText(error) {
  const body = error.response?.data;
  const detail = body?.error?.message || body?.error || body?.message;
  return `${error.message}${detail ? ` (${typeof detail === "string" ? detail : JSON.stringify(detail)})` : ""}`;
}

// Full matrix from one provider (cache first, then only the missing blocks).
// Throws on a provider failure so getMatrix can try the next one.
async function matrixFrom(cfg, keys, index) {
  const n = keys.length;
  const distKm = Array.from({ length: n }, () => new Array(n).fill(null));
  const durMin = Array.from({ length: n }, () => new Array(n).fill(null));
  for (let i = 0; i < n; i++) {
    distKm[i][i] = 0;
    durMin[i][i] = 0;
  }

  // 1. Fill what the cache already knows.
  const cacheKey = (k) => cfg.cachePrefix + k;
  const cacheKeys = keys.map(cacheKey);
  const cacheIndex = new Map(cacheKeys.map((k, i) => [k, i]));
  let cached = 0;
  const cachedDocs = await RoadDistanceCache.find({ from: { $in: cacheKeys }, to: { $in: cacheKeys } })
    .select("from to distanceKm durationMin -_id")
    .lean();
  for (const d of cachedDocs) {
    const i = cacheIndex.get(d.from);
    const j = cacheIndex.get(d.to);
    if (i === undefined || j === undefined || i === j) continue;
    distKm[i][j] = d.distanceKm;
    durMin[i][j] = d.durationMin;
    cached++;
  }

  // 2. Fetch only the blocks that still have gaps.
  const B = cfg.block;
  const upserts = [];
  let fetched = 0;
  for (let r = 0; r < n; r += B) {
    for (let c = 0; c < n; c += B) {
      const rows = [];
      for (let i = r; i < Math.min(r + B, n); i++) rows.push(i);
      const cols = [];
      for (let j = c; j < Math.min(c + B, n); j++) cols.push(j);
      const hasGap = rows.some((i) => cols.some((j) => distKm[i][j] === null));
      if (!hasGap) continue;

      const data = await fetchBlock(
        cfg,
        rows.map((i) => parseKey(keys[i])),
        cols.map((j) => parseKey(keys[j]))
      );
      rows.forEach((i, ri) => {
        cols.forEach((j, cj) => {
          if (i === j || distKm[i][j] !== null) return;
          const meters = data.distances[ri]?.[cj];
          const seconds = data.durations[ri]?.[cj];
          let km;
          let min;
          let source = "road";
          if (meters == null || seconds == null) {
            // No road route for this pair (e.g. point snapped to an island,
            // or a sea crossing with no ferry in the extract): keep the
            // estimate for this one pair rather than failing the request.
            km = haversineKm(parseKey(keys[i]), parseKey(keys[j])) * ROAD_DISTANCE_FACTOR;
            min = (km / FALLBACK_SPEED_KMH) * 60;
            source = "estimate";
          } else {
            km = meters / 1000;
            min = (seconds / 60) * cfg.durationFactor;
          }
          distKm[i][j] = km;
          durMin[i][j] = min;
          fetched++;
          upserts.push({
            updateOne: {
              filter: { from: cacheKey(keys[i]), to: cacheKey(keys[j]) },
              update: { $set: { distanceKm: km, durationMin: min, source, fetchedAt: new Date() } },
              upsert: true,
            },
          });
        });
      });
    }
  }

  if (upserts.length > 0) {
    // Cache write failing must never fail route planning.
    RoadDistanceCache.bulkWrite(upserts, { ordered: false }).catch((e) =>
      console.warn("[roadDistance] cache write failed:", e.message)
    );
  }

  // Anything still null (shouldn't happen) is left non-finite so the
  // optimizer falls back to the estimate for that leg.
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (distKm[i][j] === null) {
        distKm[i][j] = NaN;
        durMin[i][j] = NaN;
      }
    }
  }

  return { index, distKm, durMin, fetched, cached, provider: cfg.name };
}

/**
 * @param {Array<{lat:number,lng:number}>} points - depot + every stop
 * @returns {Promise<null|{ index: Map<string, number>, distKm: number[][], durMin: number[][], fetched: number, cached: number, provider: string }>}
 */
async function getMatrix(points) {
  const chain = providers();
  if (chain.length === 0) return null;

  // Dedupe by rounded coordinate.
  const keys = [];
  const index = new Map();
  for (const p of points) {
    if (!isValidPoint(p)) continue;
    const k = pointKey(p);
    if (!index.has(k)) {
      index.set(k, keys.length);
      keys.push(k);
    }
  }
  if (keys.length < 2) return null;

  for (const cfg of chain) {
    try {
      return await matrixFrom(cfg, keys, index);
    } catch (error) {
      console.warn(`[roadDistance] ${cfg.name} unavailable:`, errorText(error));
    }
  }
  console.warn("[roadDistance] no routing engine available, using haversine estimate");
  return null;
}

// In-memory LRU-ish cache of route polylines, keyed by the ordered waypoint
// list, so redrawing the same route (page refresh, filter change) is free.
const geometryCache = new Map();
const GEOMETRY_CACHE_MAX = 300;

async function fetchGeometry(cfg, pts) {
  if (cfg.name === "ors") {
    if (pts.length > ORS_MAX_ROUTE_WAYPOINTS) throw new Error(`more than ${ORS_MAX_ROUTE_WAYPOINTS} waypoints`);
    const { data } = await axios.post(
      `${cfg.url}/v2/directions/${cfg.profile}/geojson`,
      { coordinates: pts.map((p) => [Number(p.lng), Number(p.lat)]) },
      { headers: { Authorization: cfg.key, "Content-Type": "application/json" }, timeout: timeout() }
    );
    const coords = data?.features?.[0]?.geometry?.coordinates;
    if (!coords) throw new Error("ORS returned no route");
    return coords.map(([lng, lat]) => [lat, lng]);
  }
  const coords = pts.map((p) => `${Number(p.lng).toFixed(5)},${Number(p.lat).toFixed(5)}`).join(";");
  const { data } = await axios.get(`${cfg.url}/route/v1/${cfg.profile}/${coords}`, {
    params: { overview: "full", geometries: "geojson", steps: false },
    timeout: timeout(),
  });
  if (data.code !== "Ok" || !data.routes?.[0]?.geometry?.coordinates) {
    throw new Error(`OSRM returned ${data.code || "no route"}`);
  }
  return data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
}

/**
 * Road-following polyline through the given waypoints, in order.
 * @param {Array<{lat:number,lng:number}>} points
 * @returns {Promise<null|Array<[number,number]>>} [[lat,lng],...] or null if unavailable
 */
async function getRouteGeometry(points) {
  const chain = providers();
  if (chain.length === 0) return null;
  const pts = points.filter(isValidPoint);
  if (pts.length < 2) return null;
  const cacheKey = pts.map((p) => `${Number(p.lng).toFixed(5)},${Number(p.lat).toFixed(5)}`).join(";");
  if (geometryCache.has(cacheKey)) return geometryCache.get(cacheKey);
  for (const cfg of chain) {
    try {
      const positions = await fetchGeometry(cfg, pts);
      geometryCache.set(cacheKey, positions);
      if (geometryCache.size > GEOMETRY_CACHE_MAX) geometryCache.delete(geometryCache.keys().next().value);
      return positions;
    } catch (error) {
      console.warn(`[roadDistance] ${cfg.name} route geometry unavailable:`, errorText(error));
    }
  }
  console.warn("[roadDistance] route geometry unavailable, map falls back to straight lines");
  return null;
}

module.exports = { getMatrix, getRouteGeometry };
