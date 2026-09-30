// scripts/checkMapServices.js
//
// Health check for the Logistics map services, using the same .env the
// backend uses. Run from HalalSales/:
//
//   node scripts/checkMapServices.js        live checks against every provider
//   node scripts/checkMapServices.js --db   also report what the database shows
//                                           (routes by provider, cache, geocodes)
//
// Each live check sends one tiny request (2 points). It uses 1 of ORS's 50
// matrix requests/day and 1 TomTom routing request; everything else is free.
// API keys are never printed.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const PARIS_DEPOT = { lat: 48.8566, lng: 2.3522 };
const PARIS_STOP = { lat: 48.8556, lng: 2.36 }; // 12 rue de Rivoli
const TIMEOUT = 15000;

const results = [];
function report(name, status, detail) {
  results.push({ name, status, detail });
  const tag = { OK: "OK  ", FAIL: "FAIL", SKIP: "SKIP", WARN: "WARN" }[status];
  console.log(`[${tag}] ${name.padEnd(26)} ${detail}`);
}

async function check(name, fn) {
  const t = Date.now();
  try {
    const out = await fn();
    if (!out) return;
    report(name, out.status || "OK", `${out.detail} (${Date.now() - t} ms)`);
  } catch (error) {
    const status = error.response?.status;
    const body = error.response?.data;
    const msg = typeof body === "object" ? JSON.stringify(body).slice(0, 160) : String(body || "").slice(0, 160);
    report(name, "FAIL", `${status ? `HTTP ${status} ` : ""}${error.code || ""} ${msg || error.message}`.trim());
  }
}

function frontendMapKey() {
  for (const file of [".env.production", ".env.local", ".env"]) {
    const p = path.join(__dirname, "..", "..", "SalesFrontend", file);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, "utf8").match(/^VITE_TOMTOM_MAP_KEY=(.+)$/m);
    if (m) return { key: m[1].trim().replace(/^"|"$/g, ""), file };
  }
  return null;
}

async function checkOrs() {
  const url = (process.env.ORS_URL || "https://api.openrouteservice.org").replace(/\/+$/, "");
  const profile = process.env.ORS_PROFILE || "driving-hgv";
  if (process.env.ORS_ENABLED === "false") return report("ORS matrix", "SKIP", "ORS_ENABLED=false");
  if (!process.env.ORS_API_KEY) {
    return report("ORS matrix", "SKIP", "no ORS_API_KEY -> backend does not use ORS (planning uses OSRM)");
  }
  await check("ORS matrix (planning)", async () => {
    const res = await axios.post(
      `${url}/v2/matrix/${profile}`,
      { locations: [[PARIS_DEPOT.lng, PARIS_DEPOT.lat], [PARIS_STOP.lng, PARIS_STOP.lat]], metrics: ["distance", "duration"], units: "km" },
      { headers: { Authorization: process.env.ORS_API_KEY }, timeout: TIMEOUT }
    );
    const km = res.data?.distances?.[0]?.[1];
    const min = res.data?.durations?.[0]?.[1] / 60;
    const left = res.headers["x-ratelimit-remaining"];
    const limit = res.headers["x-ratelimit-limit"];
    const quota = left != null ? `, quota left today ${left}/${limit}` : "";
    if (!Number.isFinite(km)) return { status: "FAIL", detail: "no distance in response" };
    return {
      status: left != null && Number(left) < 10 ? "WARN" : "OK",
      detail: `${profile}: ${km.toFixed(2)} km, ${min.toFixed(1)} min${quota}`,
    };
  });
}

async function checkOsrm() {
  if (process.env.OSRM_ENABLED === "false") return report("OSRM matrix (backup)", "SKIP", "OSRM_ENABLED=false");
  const url = (process.env.OSRM_URL || "https://router.project-osrm.org").replace(/\/+$/, "");
  const profile = process.env.OSRM_PROFILE || "driving";
  await check("OSRM matrix (backup)", async () => {
    const coords = [PARIS_DEPOT, PARIS_STOP].map((p) => `${p.lng},${p.lat}`).join(";");
    const res = await axios.get(`${url}/table/v1/${profile}/${coords}`, {
      params: { annotations: "distance,duration" },
      timeout: TIMEOUT,
    });
    const m = res.data?.distances?.[0]?.[1];
    if (res.data?.code !== "Ok" || !Number.isFinite(m)) return { status: "FAIL", detail: `code ${res.data?.code}` };
    const demo = url.includes("router.project-osrm.org") ? " [public demo server: testing only]" : "";
    return { status: demo ? "WARN" : "OK", detail: `${(m / 1000).toFixed(2)} km${demo}` };
  });
}

async function checkTomTomRouting() {
  if (process.env.TOMTOM_ENABLED === "false") return report("TomTom traffic ETAs", "SKIP", "TOMTOM_ENABLED=false");
  if (!process.env.TOMTOM_API_KEY) return report("TomTom traffic ETAs", "SKIP", "no TOMTOM_API_KEY -> no traffic ETAs");
  const url = (process.env.TOMTOM_URL || "https://api.tomtom.com").replace(/\/+$/, "");
  await check("TomTom traffic ETAs", async () => {
    const pts = [PARIS_DEPOT, PARIS_STOP].map((p) => `${p.lat},${p.lng}`).join(":");
    const res = await axios.get(`${url}/routing/1/calculateRoute/${pts}/json`, {
      params: {
        key: process.env.TOMTOM_API_KEY,
        travelMode: process.env.TOMTOM_TRAVEL_MODE || "truck",
        traffic: true,
        departAt: "now",
        computeTravelTimeFor: "all",
      },
      timeout: TIMEOUT,
    });
    const s = res.data?.routes?.[0]?.summary;
    if (!s) return { status: "FAIL", detail: "no route in response" };
    const delay = s.noTrafficTravelTimeInSeconds != null
      ? `, traffic +${Math.max(0, Math.round((s.travelTimeInSeconds - s.noTrafficTravelTimeInSeconds) / 60))} min`
      : "";
    return { detail: `${(s.lengthInMeters / 1000).toFixed(2)} km, ${(s.travelTimeInSeconds / 60).toFixed(1)} min now${delay}` };
  });
}

async function checkTomTomTiles() {
  const fe = frontendMapKey();
  if (!fe) return report("TomTom map tiles", "WARN", "no VITE_TOMTOM_MAP_KEY in SalesFrontend env -> map uses OSM tiles");
  await check("TomTom map tiles", async () => {
    const res = await axios.get("https://api.tomtom.com/map/1/tile/basic/main/10/511/340.png", {
      params: { key: fe.key, tileSize: 512 },
      responseType: "arraybuffer",
      timeout: TIMEOUT,
    });
    const type = res.headers["content-type"];
    if (!String(type).startsWith("image/")) return { status: "FAIL", detail: `got ${type}` };
    return { detail: `key from SalesFrontend/${fe.file}, ${res.data.byteLength} byte tile` };
  });
}

async function checkGeocoding() {
  await check("Photon (geocoding)", async () => {
    const res = await axios.get("https://photon.komoot.io/api/", {
      params: { q: "12 rue de Rivoli, 75004, Paris, France", limit: 1 },
      timeout: TIMEOUT,
    });
    const f = res.data?.features?.[0];
    if (!f) return { status: "FAIL", detail: "no result" };
    return { detail: `${f.properties.type} in ${f.properties.postcode} ${f.properties.city}` };
  });

  await check("BAN (France fallback)", async () => {
    const res = await axios.get(process.env.GEOCODE_BAN_URL || "https://data.geopf.fr/geocodage/search", {
      params: { q: "12 rue de Rivoli Paris", postcode: "75004", limit: 1, index: "address" },
      timeout: TIMEOUT,
    });
    const p = res.data?.features?.[0]?.properties;
    if (!p) return { status: "FAIL", detail: "no result" };
    return { detail: `${p.label}, score ${Number(p.score).toFixed(2)}` };
  });

  await check("postcodes.io (UK fallback)", async () => {
    const base = (process.env.GEOCODE_POSTCODES_URL || "https://api.postcodes.io").replace(/\/+$/, "");
    const res = await axios.get(`${base}/postcodes/SW1A2AA`, { timeout: TIMEOUT });
    const r = res.data?.result;
    if (!r) return { status: "FAIL", detail: "no result" };
    return { detail: `SW1A 2AA -> ${r.latitude}, ${r.longitude}` };
  });

  if (!process.env.GOOGLE_MAPS_API_KEY) {
    report("Google geocoding", "SKIP", "no GOOGLE_MAPS_API_KEY");
  } else {
    await check("Google geocoding", async () => {
      const res = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
        params: { address: "12 rue de Rivoli, 75004 Paris", key: process.env.GOOGLE_MAPS_API_KEY },
        timeout: TIMEOUT,
      });
      const st = res.data?.status;
      if (st === "OK") return { detail: "working (billing enabled)" };
      return { status: "SKIP", detail: `${st}: not usable, the other geocoders are used instead` };
    });
  }

  // The real pipeline end to end (Photon -> BAN / postcodes.io -> Google).
  const { geocodeAddress } = require("../utils/geocodingService");
  for (const [name, address] of [
    ["Geocoder pipeline FR", { street: "12 rue de Rivoli", zipCode: "75004", city: "Paris", country: "France" }],
    ["Geocoder pipeline UK", { street: "10 Downing Street", zipCode: "SW1A 2AA", city: "London", country: "UK" }],
  ]) {
    await check(name, async () => {
      const r = await geocodeAddress(address, name);
      if (!r) return { status: "FAIL", detail: "no coordinates" };
      return { status: r.confidence === "high" ? "OK" : "WARN", detail: `${r.lat.toFixed(5)}, ${r.lng.toFixed(5)} via ${r.source} (${r.confidence})` };
    });
  }
}

async function checkDatabase() {
  const mongoose = require("mongoose");
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/salesHalal";
  try {
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  } catch (error) {
    return report("Database", "FAIL", `cannot connect: ${error.message}`);
  }
  try {
    const TruckRoute = require("../models/TruckRoute");
    const RoadDistanceCache = require("../models/RoadDistanceCache");
    const Customer = require("../models/Customer");
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    const routes = await TruckRoute.aggregate([
      { $match: { date: { $gte: since } } },
      {
        $group: {
          _id: { provider: "$roadProvider", source: "$distanceSource" },
          routes: { $sum: 1 },
          withTraffic: { $sum: { $cond: [{ $ifNull: ["$trafficAt", false] }, 1, 0] } },
        },
      },
    ]);
    console.log("\nTruck routes, last 14 days (roadProvider / distanceSource):");
    if (routes.length === 0) console.log("  none");
    for (const r of routes) {
      console.log(`  ${String(r._id.provider || "-").padEnd(6)} ${String(r._id.source || "-").padEnd(9)} ${r.routes} routes, ${r.withTraffic} with TomTom traffic`);
    }
    console.log("  (ors = truck roads, osrm = backup car roads, estimate = straight line x 1.3: providers were down)");

    const [orsLegs, osrmLegs] = await Promise.all([
      RoadDistanceCache.countDocuments({ from: /^ors:/ }),
      RoadDistanceCache.countDocuments({ from: { $not: /^ors:/ } }),
    ]);
    console.log(`\nRoad distance cache: ${orsLegs} ORS legs, ${osrmLegs} OSRM legs`);

    const geo = await Customer.aggregate([
      { $match: { "geo.geocodeStatus": { $exists: true } } },
      { $group: { _id: { status: "$geo.geocodeStatus", source: "$geo.source", confidence: "$geo.confidence" }, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]);
    console.log("\nCustomer geocodes (status / source / confidence):");
    for (const g of geo) {
      console.log(`  ${String(g._id.status).padEnd(8)} ${String(g._id.source || "-").padEnd(13)} ${String(g._id.confidence || "-").padEnd(5)} ${g.n}`);
    }
    console.log("  (source '-' = geocoded before sources were recorded; 'low' = check the address)");
  } finally {
    await mongoose.disconnect();
  }
}

(async () => {
  console.log("Logistics map services check\n");
  await checkOrs();
  await checkOsrm();
  await checkTomTomRouting();
  await checkTomTomTiles();
  await checkGeocoding();
  if (process.argv.includes("--db")) await checkDatabase();

  const failed = results.filter((r) => r.status === "FAIL").length;
  const warned = results.filter((r) => r.status === "WARN").length;
  console.log(`\n${failed ? `${failed} FAILED` : "No failures"}${warned ? `, ${warned} warning(s)` : ""}.`);
  process.exit(failed ? 1 : 0);
})();
