// utils/roadDistanceService.js
//
// Real road distances/durations for the route optimizer (one call returns a
// full N x N matrix), cached per coordinate pair in Mongo. Returns null on any
// failure so callers fall back to the haversine estimate in routeOptimizer.js
// instead of breaking route planning.
//
// Providers, tried in this order (each only if enabled):
//   1. Google Routes API computeRouteMatrix - when GOOGLE_MAPS_API_KEY is set
//      (see utils/googleMapsClient.js). Car roads, no traffic (traffic is
//      applied afterwards per route by trafficEtaService). Billed per
//      origin x destination pair, so legs are cached (GOOGLE_CACHE_DAYS).
//   2. OpenRouteService (hosted API, truck profile "driving-hgv") - only when
//      ORS_API_KEY is set. Free plan: daily request limits, no server needed.
//   3. OSRM (public demo server by default - testing only).
// If one fails (quota, outage, unroutable point) the whole matrix is fetched
// from the next instead, so one request never mixes providers.
//
// Env:
//   GOOGLE_CACHE_DAYS     days a Google leg / line is kept, default 30
//                         (Google's terms limit caching)
//   GOOGLE_BLOCK_SIZE     max points per side of one Google request, default 25
//                         (Google's limit is 625 pairs per request)
//   ORS_API_KEY           enables OpenRouteService (free key from openrouteservice.org)
//   ORS_URL               default https://api.openrouteservice.org
//   ORS_PROFILE           default "driving-hgv" (truck); "driving-car" also works
//   ORS_BLOCK_SIZE        max points per side of one matrix request, default 50
//                         (hosted limit is 3,500 origin x destination pairs)
//   ORS_DURATION_FACTOR   multiplier on ORS durations, default 1
//   ORS_ENABLED           set to "false" to skip ORS even with a key
//   OSRM_URL              base URL; setting it enables OSRM. Without it OSRM is
//                         off unless OSRM_ENABLED=true (then it uses the public
//                         demo server https://router.project-osrm.org: testing only)
//   OSRM_PROFILE          default "driving"
//   OSRM_TIMEOUT_MS       default 15000 (also used for ORS)
//   OSRM_DURATION_FACTOR  multiplier on OSRM durations, default 1 (raise it,
//                         e.g. 1.2, to reflect slower loaded trucks)
//   OSRM_ENABLED          "true" = on (demo server if no OSRM_URL), "false" = off
//   OSRM_BLOCK_SIZE       max points per side of one /table request, default 40

const axios = require("axios");
const RoadDistanceCache = require("../models/RoadDistanceCache");
const google = require("./googleMapsClient");
const RouteGeometryCache = require("../models/RouteGeometryCache");
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
    // Off unless configured: the default URL is the public demo server
    // (testing only), so a server with no OSRM settings never uses it.
    enabled:
      process.env.OSRM_ENABLED === "true" || (Boolean(process.env.OSRM_URL) && process.env.OSRM_ENABLED !== "false"),
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

function googleConfig() {
  return {
    name: "google",
    enabled: google.config().routesEnabled,
    durationFactor: 1,
    block: Math.max(2, Math.min(25, Number(process.env.GOOGLE_BLOCK_SIZE) || 25)),
    cachePrefix: "google|",
    cacheDays: Number(process.env.GOOGLE_CACHE_DAYS) || 30,
  };
}

function providers() {
  return [googleConfig(), orsConfig(), osrmConfig()].filter((p) => p.enabled);
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
  if (cfg.name === "google") return google.computeRouteMatrix(srcPts, dstPts);
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
  if (error.response?.config?.url?.includes("googleapis") || Array.isArray(error.response?.data)) {
    return google.errorText(error);
  }
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
              update: {
                $set: {
                  distanceKm: km,
                  durationMin: min,
                  source,
                  fetchedAt: new Date(),
                  ...(cfg.cacheDays ? { expiresAt: new Date(Date.now() + cfg.cacheDays * 86400000) } : {}),
                },
              },
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

// Route polylines, keyed by the ordered waypoint list: in memory (LRU-ish)
// and in Mongo (RouteGeometryCache), so redrawing the same route (page
// refresh, filter change, server restart) needs no routing request at all.
const geometryCache = new Map();
const GEOMETRY_CACHE_MAX = 300;

const geometryKey = (pts) => pts.map((p) => `${Number(p.lng).toFixed(5)},${Number(p.lat).toFixed(5)}`).join(";");

function rememberGeometry(key, positions) {
  geometryCache.set(key, positions);
  if (geometryCache.size > GEOMETRY_CACHE_MAX) geometryCache.delete(geometryCache.keys().next().value);
}

/**
 * Stores a polyline obtained elsewhere (TomTom returns one with the traffic
 * ETAs), so the map uses it without another request. Never throws.
 */
async function saveRouteGeometry(points, positions, provider) {
  try {
    const pts = points.filter(isValidPoint);
    if (pts.length < 2 || !Array.isArray(positions) || positions.length < 2) return;
    const key = geometryKey(pts);
    rememberGeometry(key, positions);
    await RouteGeometryCache.updateOne(
      { key },
      { $set: { positions, provider, fetchedAt: new Date() } },
      { upsert: true }
    );
  } catch (error) {
    console.warn("[roadDistance] geometry cache write failed:", error.message);
  }
}

// Google line in chunks of <= 12 waypoints (10 intermediates keeps each
// request on the cheaper Essentials price), joined end to end.
const GOOGLE_LINE_CHUNK = 12;
async function fetchGoogleGeometry(pts) {
  const positions = [];
  for (let start = 0; start < pts.length - 1; start += GOOGLE_LINE_CHUNK - 1) {
    const chunk = pts.slice(start, start + GOOGLE_LINE_CHUNK);
    if (chunk.length < 2) break;
    const { legs } = await google.computeRoute(chunk);
    legs.forEach((leg) =>
      leg.positions.forEach((p) => {
        const last = positions[positions.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) positions.push(p);
      })
    );
  }
  if (positions.length < 2) throw new Error("Google returned no line");
  return positions;
}

async function fetchGeometry(cfg, pts) {
  if (cfg.name === "google") return fetchGoogleGeometry(pts);
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
  const pts = points.filter(isValidPoint);
  if (pts.length < 2) return null;
  const cacheKey = geometryKey(pts);
  if (geometryCache.has(cacheKey)) return geometryCache.get(cacheKey);
  try {
    const saved = await RouteGeometryCache.findOne({ key: cacheKey }).select("positions -_id").lean();
    if (saved?.positions?.length >= 2) {
      rememberGeometry(cacheKey, saved.positions);
      return saved.positions;
    }
  } catch (error) {
    console.warn("[roadDistance] geometry cache read failed:", error.message);
  }

  // Drawing only: Google when configured, else OSRM (fast, no daily quota;
  // measured 8 lines in 2.4 s vs 6.6-14.5 s on ORS, whose free plan allows
  // 200 lines/day), ORS as the last backup. With traffic ETAs on (Google or
  // TomTom), most lines are already saved above.
  const chain = [googleConfig(), osrmConfig(), orsConfig()].filter((p) => p.enabled);
  for (const cfg of chain) {
    try {
      const positions = await fetchGeometry(cfg, pts);
      await saveRouteGeometry(pts, positions, cfg.name);
      return positions;
    } catch (error) {
      console.warn(`[roadDistance] ${cfg.name} route geometry unavailable:`, errorText(error));
    }
  }
  console.warn("[roadDistance] route geometry unavailable, map falls back to straight lines");
  return null;
}

module.exports = { getMatrix, getRouteGeometry, saveRouteGeometry };
