const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Breadcrumb history of GPS fixes (for the day's trail, and later
// planned-vs-actual). Expires automatically after 30 days.
const TruckPositionSchema = new Schema({
  deviceId: { type: String, required: true },
  tenant: { type: String, default: "halal-food-sales" },
  truckNumber: { type: Number, required: true },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  speedKmh: Number,
  heading: Number,
  accuracyM: Number,
  battery: Number,
  recordedAt: { type: Date, required: true },
  receivedAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 },
});

TruckPositionSchema.index({ tenant: 1, truckNumber: 1, recordedAt: 1 });

module.exports = mongoose.model("TruckPosition", TruckPositionSchema);
