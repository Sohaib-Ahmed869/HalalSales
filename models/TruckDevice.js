const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// A MyGeotab vehicle (GO device) assigned to one truck number.
// Trucks are matched by `truckNumber` (same number as TruckSchedule/TruckRoute),
// so the vehicle follows the truck across days. services/geotabSync.js keeps
// `lastPosition` current from Geotab's DeviceStatusInfo feed.
const TruckDeviceSchema = new Schema({
  deviceId: { type: String, required: true, unique: true, index: true },
  tenant: {
    type: String,
    enum: ["halal-food-sales", "pqf", "data-tech", "ms-foods"],
    default: "halal-food-sales",
  },
  truckNumber: { type: Number, required: true },
  label: { type: String, trim: true }, // vehicle name in MyGeotab
  // deviceId is "geotab:<Geotab device id>" for vehicles read from MyGeotab.
  provider: { type: String, default: "geotab" },
  geotabId: { type: String },
  licensePlate: { type: String, trim: true },
  vin: { type: String, trim: true },
  serialNumber: { type: String, trim: true },
  // Set in the portal (Weekly Templates): payload in kg (and m³) and usual departure
  // time, offered again whenever this vehicle is picked for a schedule.
  maxWeightKg: { type: Number },
  maxVolumeM3: { type: Number },
  departureTime: { type: String },
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
    driving: Boolean,
    communicating: Boolean,
  },
  lastSeenAt: { type: Date }, // server clock
  createdAt: { type: Date, default: Date.now },
});

TruckDeviceSchema.index({ tenant: 1, truckNumber: 1 });

module.exports = mongoose.model("TruckDevice", TruckDeviceSchema);
