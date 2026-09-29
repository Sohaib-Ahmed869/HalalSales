// utils/roadDistanceService.js
//
// Real road distances/durations for the route optimizer, from OSRM's /table
// endpoint (one call returns a full N x N matrix), cached per coordinate pair
// in Mongo. Returns null on any failure so callers fall back to the
// haversine estimate in routeOptimizer.js instead of breaking route planning.
//
// Env:
//   OSRM_URL              base URL, default https://router.project-osrm.org
//                         (public demo server: testing only — self-host for
//                         production, see Logistics docs)
//   OSRM_PROFILE          default "driving"
//   OSRM_TIMEOUT_MS       default 15000
//   OSRM_DURATION_FACTOR  multiplier on OSRM durations, default 1 (raise it,
//                         e.g. 1.2, to reflect slower loaded trucks)
//   OSRM_ENABLED          set to "false" to force the haversine fallback
//   OSRM_BLOCK_SIZE       max points per side of one /table request, default 40

const axios = require("axios");
const RoadDistanceCache = require("../models/RoadDistanceCache");
const { pointKey, haversineKm } = require("./routeOptimizer");

const ROAD_DISTANCE_FACTOR = 1.3; // same fallback factor as routeOptimizer
const FALLBACK_SPEED_KMH = 40;

const config = () => ({
  url: (process.env.OSRM_URL || "https://router.project-osrm.org").replace(/\/+$/, ""),
  profile: process.env.OSRM_PROFILE || "driving",
  timeout: Number(process.env.OSRM_TIMEOUT_MS) || 15000,
  durationFactor: Number(process.env.OSRM_DURATION_FACTOR) || 1,
  enabled: process.env.OSRM_ENABLED !== "false",
  block: Math.max(2, Number(process.env.OSRM_BLOCK_SIZE) || 40),
});

function isValidPoint(p) {
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
}

function parseKey(key) {
  const [lat, lng] = key.split(",").map(Number);
  return { lat, lng };
}

// Calls OSRM /table for one block: rows = sources, cols = destinations.
// Returns { distances[][] (metres), durations[][] (seconds) }.
async function fetchBlock(cfg, srcPts, dstPts) {
  const coords = [...srcPts, ...dstPts].map((p) => `${p.lng},${p.lat}`).join(";");
  const sources = srcPts.map((_, i) => i).join(";");
  const destinations = dstPts.map((_, i) => srcPts.length + i).join(";");
  const url = `${cfg.url}/table/v1/${cfg.profile}/${coords}`;
  const { data } = await axios.get(url, {
    params: { annotations: "distance,duration", sources, destinations },
    timeout: cfg.timeout,
  });
  if (data.code !== "Ok" || !data.distances || !data.durations) {
    throw new Error(`OSRM returned ${data.code || "no data"}${data.message ? `: ${data.message}` : ""}`);
  }
  return data;
}

/**
 * @param {Array<{lat:number,lng:number}>} points - depot + every stop
 * @returns {Promise<null|{ index: Map<string, number>, distKm: number[][], durMin: number[][], fetched: number, cached: number }>}
 */
async function getMatrix(points) {
  const cfg = config();
  if (!cfg.enabled) return null;

  try {
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
    const n = keys.length;
    if (n < 2) return null;

    const distKm = Array.from({ length: n }, () => new Array(n).fill(null));
    const durMin = Array.from({ length: n }, () => new Array(n).fill(null));
    for (let i = 0; i < n; i++) {
      distKm[i][i] = 0;
      durMin[i][i] = 0;
    }

    // 1. Fill what the cache already knows.
    let cached = 0;
    const cachedDocs = await RoadDistanceCache.find({ from: { $in: keys }, to: { $in: keys } })
      .select("from to distanceKm durationMin -_id")
      .lean();
    for (const d of cachedDocs) {
      const i = index.get(d.from);
      const j = index.get(d.to);
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
            const meters = data.distances[ri][cj];
            const seconds = data.durations[ri][cj];
            let km;
            let min;
            let source = "road";
            if (meters == null || seconds == null) {
              // OSRM found no road route (e.g. point snapped to an island,
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
                filter: { from: keys[i], to: keys[j] },
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

    return { index, distKm, durMin, fetched, cached };
  } catch (error) {
    console.warn("[roadDistance] OSRM unavailable, using haversine estimate:", error.message);
    return null;
  }
}

// In-memory LRU-ish cache of route polylines, keyed by the ordered waypoint
// list, so redrawing the same route (page refresh, filter change) is free.
const geometryCache = new Map();
const GEOMETRY_CACHE_MAX = 300;

/**
 * Road-following polyline through the given waypoints, in order.
 * @param {Array<{lat:number,lng:number}>} points
 * @returns {Promise<null|Array<[number,number]>>} [[lat,lng],...] or null if unavailable
 */
async function getRouteGeometry(points) {
  const cfg = config();
  if (!cfg.enabled) return null;
  const pts = points.filter(isValidPoint);
  if (pts.length < 2) return null;
  const coords = pts.map((p) => `${Number(p.lng).toFixed(5)},${Number(p.lat).toFixed(5)}`).join(";");
  if (geometryCache.has(coords)) return geometryCache.get(coords);
  try {
    const { data } = await axios.get(`${cfg.url}/route/v1/${cfg.profile}/${coords}`, {
      params: { overview: "full", geometries: "geojson", steps: false },
      timeout: cfg.timeout,
    });
    if (data.code !== "Ok" || !data.routes?.[0]?.geometry?.coordinates) {
      throw new Error(`OSRM returned ${data.code || "no route"}`);
    }
    const positions = data.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    geometryCache.set(coords, positions);
    if (geometryCache.size > GEOMETRY_CACHE_MAX) geometryCache.delete(geometryCache.keys().next().value);
    return positions;
  } catch (error) {
    console.warn("[roadDistance] route geometry unavailable, map falls back to straight lines:", error.message);
    return null;
  }
}

module.exports = { getMatrix, getRouteGeometry };
