const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// One TruckRoute per truck per delivery date. Created by
// POST /truck-routes/initialize-date from the active TruckSchedule for that
// weekday/region (one TruckRoute per embedded truck entry), then populated
// with orders by assign/generate/auto-fill/optimize.
//
// Field names/shape here mirror exactly what SalesFrontend/src/pages/Dashboard/
// MapPage.jsx already reads and writes (truckName/truckNumber/truckType flat on
// the route, an `orders[]` array — not `stops[]` — each wrapping the source
// Invoice snapshot under `.order`), so the existing frontend needs no rewrite.
const OrderEntrySchema = new Schema(
  {
    order: {
      _id: Schema.Types.Mixed,
      DocEntry: { type: Number, required: true },
      DocNum: { type: Number },
      CardCode: { type: String },
      CardName: { type: String },
      DocTotal: { type: Number },
      address: { type: Schema.Types.Mixed },
      totalWeight: { type: Number },
      weightUnit: { type: String },
    },
    sequenceNumber: { type: Number },
    assignedAt: { type: Date, default: Date.now },
    orderWeightKg: { type: Number, default: 0 },
    coordinates: {
      lat: { type: Number },
      lng: { type: Number },
    },
    storeHours: {
      openingTime: { type: String },
      closingTime: { type: String },
    },
    etaMin: { type: Number },
    plannedArrival: { type: Date },
    status: {
      type: String,
      enum: ["pending", "delivered", "failed", "infeasible"],
      default: "pending",
    },
    // Survives re-optimization — a dispatcher's manual placement/assignment is
    // never silently reshuffled by a later "Optimize"/"Generate"/"Auto-Fill" run.
    locked: { type: Boolean, default: false },
  },
  { _id: true }
);

const TruckRouteSchema = new Schema({
  date: {
    type: Date,
    required: true,
    index: true,
  },
  truckNumber: { type: Number, required: true },
  truckName: { type: String, trim: true },
  truckType: {
    type: String,
    enum: ["small", "medium", "large", "xlarge", "custom"],
    default: "medium",
  },
  maxWeightKg: { type: Number, required: true },
  region: { type: String, trim: true },
  departments: [{ type: String, trim: true }],
  cities: [{ type: String, trim: true }],
  scheduleId: { type: Schema.Types.ObjectId, ref: "TruckSchedule" },
  tenant: {
    type: String,
    enum: ["halal-food-sales", "pqf", "data-tech", "ms-foods"],
    default: "halal-food-sales",
  },
  status: {
    type: String,
    enum: ["planning", "in_progress", "completed"],
    default: "planning",
  },
  orders: [OrderEntrySchema],
  totalWeightKg: { type: Number, default: 0 },
  totalOrders: { type: Number, default: 0 },
  capacityUsedPercent: { type: Number, default: 0 },
  totalDistanceKm: { type: Number, default: 0 },
  totalDurationMin: { type: Number, default: 0 },
  totalWaitMin: { type: Number, default: 0 },
  // Which tradeoff this route's sequencing optimizes for — "shortest"
  // (minimize total driving distance, default) or "least_wait" (minimize
  // total elapsed time including idle waiting, even at the cost of more
  // distance). Persisted so a manual assign/remove's automatic re-sequence
  // keeps using whichever one was last chosen for this route, instead of
  // silently reverting to the default.
  strategy: {
    type: String,
    enum: ["shortest", "least_wait"],
    default: "shortest",
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

TruckRouteSchema.index({ date: 1, truckNumber: 1, region: 1 });

TruckRouteSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("TruckRoute", TruckRouteSchema);
