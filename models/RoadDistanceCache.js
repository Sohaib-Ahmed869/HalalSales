const mongoose = require("mongoose");

// One document per ordered pair of coordinates (keys are "lat,lng" rounded to
// 5 decimals, see routeOptimizer.pointKey). Depot -> customer and customer ->
// customer legs repeat every delivery day, so after the first run most
// matrix requests are served entirely from here without calling OSRM.
const RoadDistanceCacheSchema = new mongoose.Schema(
  {
    from: { type: String, required: true },
    to: { type: String, required: true },
    distanceKm: { type: Number, required: true },
    durationMin: { type: Number, required: true },
    // "road" = returned by OSRM; "estimate" = OSRM had no route for the pair
    // so haversine x factor was stored instead (re-checked after the TTL).
    source: { type: String, enum: ["road", "estimate"], default: "road" },
    fetchedAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

RoadDistanceCacheSchema.index({ from: 1, to: 1 }, { unique: true });
// Road networks change slowly; refresh cached legs after 90 days.
RoadDistanceCacheSchema.index({ fetchedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

module.exports = mongoose.model("RoadDistanceCache", RoadDistanceCacheSchema);
