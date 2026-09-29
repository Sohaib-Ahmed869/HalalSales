const mongoose = require("mongoose");

// Road polyline for one ordered list of waypoints (depot -> stops -> depot),
// so the Logistics map draws a route's line without calling a routing
// service again on every page load. `key` is the waypoint list as
// "lng,lat;lng,lat;..." (5 decimals), the same key roadDistanceService uses.
// Filled by TomTom (saved while computing traffic ETAs, no extra request)
// or by OSRM/ORS the first time a line is requested.
const RouteGeometryCacheSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    positions: { type: [[Number]], default: [] }, // [[lat, lng], ...]
    provider: { type: String },
    fetchedAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// Roads change slowly, but keep the collection small.
RouteGeometryCacheSchema.index({ fetchedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

module.exports = mongoose.model("RouteGeometryCache", RouteGeometryCacheSchema);
