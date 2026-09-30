const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// A phone running the Traccar Client app, assigned to one truck.
// `deviceId` is what the driver types into Traccar Client's "Device
// identifier" field. It is generated here (random, unguessable) and doubles as
// the credential: the ingest endpoint has no login because the app can't send
// a Bearer token, so knowing the id is what authorises a position.
// Trucks are matched by `truckNumber` (same number as TruckSchedule/TruckRoute),
// so the phone follows the truck across days without re-registering.
const TruckDeviceSchema = new Schema({
  deviceId: { type: String, required: true, unique: true, index: true },
  tenant: {
    type: String,
    enum: ["halal-food-sales", "pqf", "data-tech", "ms-foods"],
    default: "halal-food-sales",
  },
  truckNumber: { type: Number, required: true },
  label: { type: String, trim: true }, // e.g. driver name / phone
  isActive: { type: Boolean, default: true },
  // Latest fix, kept on the device so "where is everyone" is one query.
  lastPosition: {
    lat: Number,
    lng: Number,
    speedKmh: Number,
    heading: Number,
    accuracyM: Number,
    battery: Number,
    recordedAt: Date, // device clock
  },
  lastSeenAt: { type: Date }, // server clock
  createdAt: { type: Date, default: Date.now },
});

TruckDeviceSchema.index({ tenant: 1, truckNumber: 1 });

module.exports = mongoose.model("TruckDevice", TruckDeviceSchema);
