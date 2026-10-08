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
      // "order" = sales order moved from Bulk Order Conversion (the normal
      // source); "deliveryNote" only with LOGISTICS_ORDER_SOURCE=delivery-notes.
      docType: { type: String },
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
      // The customer's preferred delivery window, when they gave one.
      preferredFrom: { type: String },
      preferredTo: { type: String },
    },
    // Planned arrival is outside the preferred window (but the shop is open).
    preferredMissed: { type: Boolean },
    etaMin: { type: Number },
    // Minutes the truck waits outside the shop for it to open; already
    // included in etaMin of this stop and every later one.
    waitMin: { type: Number, default: 0 },
    // Leg from the previous stop (or the depot) as used for etaMin, so an ETA
    // can be audited: etaMin = previous stop's etaMin + its service time + driveMin + waitMin.
    driveMin: { type: Number },
    legKm: { type: Number },
    plannedArrival: { type: Date },
    // Set from the truck's GPS (utils/stopVisits.js): arrivedAt = first fix
    // within the stop radius (cleared on a drive-by), departedAt = first fix
    // outside it again. GPS never marks a stop delivered; deliveredAt /
    // deliveredBy are only written by the manual status endpoint.
    arrivedAt: { type: Date },
    departedAt: { type: Date },
    deliveredAt: { type: Date },
    deliveredBy: { type: String, enum: ["gps", "manual"] },
    // Live estimate from the truck's GPS (utils/liveEta.js); the planned
    // etaMin/waitMin above are never changed by it. Same clock as etaMin.
    // Traffic delay (minutes above free flow) on the leg to this stop: what
    // the plan assumed, and the most the live traffic showed while the truck
    // was driving that leg (utils/liveEta.js). Lets the planned-vs-actual
    // report say how much of a late arrival was traffic.
    plannedTrafficMin: { type: Number },
    liveTrafficMin: { type: Number },
    liveTrafficAt: { type: Date },
    liveEtaMin: { type: Number },
    liveWaitMin: { type: Number },
    liveLate: { type: Boolean },
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
  // "HH:MM" the truck leaves the depot on this date (copied from the weekly
  // template at Initialize Date, editable per date). ETAs are measured from it.
  departureTime: { type: String, default: "08:00" },
  // Minutes allowed at each stop (unloading, paperwork). Unset = the
  // STOP_SERVICE_MIN default (15).
  serviceMin: { type: Number },
  region: { type: String, trim: true },
  departments: [{ type: String, trim: true }],
  cities: [{ type: String, trim: true }],
  scheduleId: { type: Schema.Types.ObjectId, ref: "TruckSchedule" },
  // The weekly template's values last copied onto this route. A later edit of
  // the template is recognised by comparing with these, so a value changed on
  // the truck card for this date only is not overwritten by an unchanged template.
  templateValues: {
    maxWeightKg: { type: Number },
    departureTime: { type: String },
    serviceMin: { type: Number },
  },
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
  // Where totalDistanceKm/totalDurationMin/ETAs came from on the last
  // sequencing: "road" = real OSRM road distances, "estimate" = haversine x
  // 1.3 fallback (routing engine unreachable or disabled).
  distanceSource: {
    type: String,
    enum: ["road", "estimate"],
    default: "estimate",
  },
  // Which routing engine produced the road matrix ("ors" = OpenRouteService
  // truck profile, "osrm"); unset when distanceSource is "estimate".
  roadProvider: { type: String },
  // Set when TomTom traffic replaced the leg times/distances after sequencing
  // (see utils/trafficEtaService.js): when it was fetched, the TomTom
  // departAt used ("now" = live traffic) and the total delay vs free flow.
  trafficAt: { type: Date },
  trafficDepartAt: { type: String },
  trafficDelayMin: { type: Number },
  // The leg back to the depot (the stops carry their own leg's figures): its
  // drive time and its traffic delay, so the map can grade that stretch too.
  returnDriveMin: { type: Number },
  returnTrafficMin: { type: Number },
  trafficProvider: { type: String }, // "google" | "tomtom"
  // When the stops' live ETAs were last recomputed from GPS, how ("google" =
  // live traffic, "estimate") and from where (utils/liveEta.js).
  liveEtaAt: { type: Date },
  liveEtaProvider: { type: String },
  liveEtaFrom: { lat: Number, lng: Number },
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
