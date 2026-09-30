// utils/googleMapsClient.js
//
// Thin client for the Google Maps Platform APIs the Logistics module uses,
// all with the one server-side key GOOGLE_MAPS_API_KEY (never sent to the
// browser):
//   - Routes API: computeRouteMatrix (planning matrix) and computeRoutes
//     (traffic ETAs + road line)          -> utils/roadDistanceService.js,
//                                            utils/trafficEtaService.js
//   - Geocoding API                       -> utils/geocodingService.js
//   - Map Tiles API (2D roadmap tiles, proxied by the backend so the key
//     stays secret)                       -> controllers/mapTiles.controller.js
//
// Google has no truck profile: everything is travelMode DRIVE (car roads).
//
// Env:
//   GOOGLE_MAPS_API_KEY        the key (Google Cloud project with billing on)
//   GOOGLE_ROUTES_ENABLED      "false" = don't use the Routes API
//   GOOGLE_GEOCODING_ENABLED   "false" = don't use the Geocoding API
//   GOOGLE_TILES_ENABLED       "false" = don't use the Map Tiles API
//   GOOGLE_TIMEOUT_MS          default 15000
//   GOOGLE_ROUTES_URL, GOOGLE_GEOCODE_URL, GOOGLE_TILES_URL
//                              base URLs (only for testing against a mock)

const axios = require("axios");

const key = () => process.env.GOOGLE_MAPS_API_KEY || "";
const on = (flag) => Boolean(key()) && process.env[flag] !== "false";

const config = () => ({
  key: key(),
  timeout: Number(process.env.GOOGLE_TIMEOUT_MS) || 15000,
  routesUrl: (process.env.GOOGLE_ROUTES_URL || "https://routes.googleapis.com").replace(/\/+$/, ""),
  geocodeUrl: process.env.GOOGLE_GEOCODE_URL || "https://maps.googleapis.com/maps/api/geocode/json",
  tilesUrl: (process.env.GOOGLE_TILES_URL || "https://tile.googleapis.com").replace(/\/+$/, ""),
  routesEnabled: on("GOOGLE_ROUTES_ENABLED"),
  geocodingEnabled: on("GOOGLE_GEOCODING_ENABLED"),
  tilesEnabled: on("GOOGLE_TILES_ENABLED"),
});

const waypoint = (p) => ({ location: { latLng: { latitude: Number(p.lat), longitude: Number(p.lng) } } });

// "123.4s" -> 123.4
const seconds = (d) => (d == null ? NaN : parseFloat(String(d)));

// Google encoded polyline -> [[lat, lng], ...] (5 decimals).
function decodePolyline(encoded) {
  const out = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (encoded && index < encoded.length) {
    for (const axis of [0, 1]) {
      let result = 0;
      let shift = 0;
      let b;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}

function errorText(error) {
  const body = error.response?.data;
  const e = Array.isArray(body) ? body[0]?.error : body?.error;
  const detail = e?.message || body?.error_message || body?.status;
  return `${error.message}${detail ? ` (${detail})` : ""}`;
}

/**
 * Routes API computeRouteMatrix, one block (origins x destinations <= 625).
 * @returns {{ distances: (number|null)[][], durations: (number|null)[][] }} metres / seconds
 */
async function computeRouteMatrix(origins, destinations, { routingPreference = "TRAFFIC_UNAWARE" } = {}) {
  const cfg = config();
  const { data } = await axios.post(
    `${cfg.routesUrl}/distanceMatrix/v2:computeRouteMatrix`,
    {
      origins: origins.map((p) => ({ waypoint: waypoint(p) })),
      destinations: destinations.map((p) => ({ waypoint: waypoint(p) })),
      travelMode: "DRIVE",
      routingPreference,
    },
    {
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": cfg.key,
        "X-Goog-FieldMask": "originIndex,destinationIndex,distanceMeters,duration,condition,status",
      },
      timeout: cfg.timeout,
    }
  );
  if (!Array.isArray(data)) throw new Error("Google returned no matrix");
  const distances = origins.map(() => destinations.map(() => null));
  const durations = origins.map(() => destinations.map(() => null));
  let filled = 0;
  for (const el of data) {
    if (el.error) throw new Error(el.error.message || "Google matrix error");
    const i = el.originIndex || 0;
    const j = el.destinationIndex || 0;
    if (el.status?.code || el.condition !== "ROUTE_EXISTS") continue; // no road route: estimate this pair
    distances[i][j] = Number(el.distanceMeters) || 0; // 0 m is omitted by Google
    durations[i][j] = seconds(el.duration) || 0;
    filled++;
  }
  if (filled === 0 && origins.length * destinations.length > 0) {
    throw new Error("Google matrix had no routable pair");
  }
  return { distances, durations };
}

/**
 * Routes API computeRoutes through points in order (max 25 intermediates).
 * @returns {{ legs: Array<{ distanceMeters:number, durationSec:number, staticDurationSec:number, positions:[number,number][] }> }}
 */
async function computeRoute(points, { trafficAware = false, departureTime } = {}) {
  const cfg = config();
  const body = {
    origin: waypoint(points[0]),
    destination: waypoint(points[points.length - 1]),
    intermediates: points.slice(1, -1).map(waypoint),
    travelMode: "DRIVE",
    routingPreference: trafficAware ? "TRAFFIC_AWARE" : "TRAFFIC_UNAWARE",
    computeAlternativeRoutes: false,
    polylineQuality: "OVERVIEW",
  };
  if (trafficAware && departureTime) body.departureTime = departureTime;
  const { data } = await axios.post(`${cfg.routesUrl}/directions/v2:computeRoutes`, body, {
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": cfg.key,
      "X-Goog-FieldMask":
        "routes.legs.distanceMeters,routes.legs.duration,routes.legs.staticDuration,routes.legs.polyline.encodedPolyline",
    },
    timeout: cfg.timeout,
  });
  const legs = data?.routes?.[0]?.legs;
  if (!Array.isArray(legs) || legs.length !== points.length - 1) {
    throw new Error(`Google: expected ${points.length - 1} legs, got ${Array.isArray(legs) ? legs.length : "none"}`);
  }
  return {
    legs: legs.map((leg) => ({
      distanceMeters: Number(leg.distanceMeters) || 0,
      durationSec: seconds(leg.duration) || 0,
      staticDurationSec: seconds(leg.staticDuration),
      positions: decodePolyline(leg.polyline?.encodedPolyline || ""),
    })),
  };
}

/**
 * Geocoding API. @returns {null|{ lat, lng, locationType, partialMatch }}
 */
async function geocode(addressString, { region } = {}) {
  const cfg = config();
  const { data } = await axios.get(cfg.geocodeUrl, {
    params: { address: addressString, key: cfg.key, ...(region ? { region } : {}) },
    timeout: cfg.timeout,
  });
  if (data?.status === "ZERO_RESULTS") return null;
  if (data?.status !== "OK") throw new Error(`${data?.status}${data?.error_message ? `: ${data.error_message}` : ""}`);
  const r = data.results?.[0];
  if (!r) return null;
  return {
    lat: r.geometry.location.lat,
    lng: r.geometry.location.lng,
    locationType: r.geometry.location_type,
    partialMatch: Boolean(r.partial_match),
  };
}

module.exports = { config, computeRouteMatrix, computeRoute, geocode, decodePolyline, errorText };
