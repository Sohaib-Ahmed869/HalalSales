const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// The planned-vs-actual report of one truck route (utils/routeAdherence.js),
// stored so the day's deviations can be listed and downloaded without
// recomputing. One per TruckRoute, replaced on every recalculation.
const RouteAdherenceSchema = new Schema({
  routeId: { type: Schema.Types.ObjectId, ref: "TruckRoute", required: true, unique: true },
  tenant: { type: String, default: "halal-food-sales" },
  date: { type: Date, required: true, index: true },
  truckNumber: { type: Number },
  truckName: { type: String },
  region: { type: String },
  vehicle: { type: String }, // MyGeotab vehicle name / registration
  hasTracker: { type: Boolean, default: false },
  status: { type: String }, // no_data | not_started | in_progress | completed
  planned: { type: Schema.Types.Mixed },
  actual: { type: Schema.Types.Mixed },
  stops: { type: [Schema.Types.Mixed], default: [] },
  deviations: { type: [Schema.Types.Mixed], default: [] },
  summary: { type: Schema.Types.Mixed },
  computedAt: { type: Date, default: Date.now },
});

RouteAdherenceSchema.index({ tenant: 1, date: 1 });

module.exports = mongoose.model("RouteAdherence", RouteAdherenceSchema);
