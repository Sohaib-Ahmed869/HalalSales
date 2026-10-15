const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Weekly template: which trucks normally cover which region/departments/cities
// on which day of the week. "Initialize Date" reads the active template(s) for
// a given date's weekday to create that date's TruckRoute documents.
// Trucks are embedded here (not a separate collection) to match the existing
// TruckSchedules.jsx form, which builds/edits trucks inline per schedule.
const TruckScheduleSchema = new Schema({
  dayOfWeek: {
    type: String,
    enum: [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ],
    required: true,
  },
  region: {
    type: String,
    trim: true,
  },
  departments: [{ type: String, trim: true }],
  cities: [{ type: String, trim: true }],
  trucks: [
    {
      truckNumber: { type: Number, required: true },
      // The MyGeotab vehicle this truck is (TruckDevice.geotabId); truckNumber
      // and truckName are taken from it when the schedule is saved.
      geotabId: { type: String },
      truckName: { type: String, trim: true },
      maxWeightKg: { type: Number, required: true },
      // m³ the truck takes; unset = no volume limit.
      maxVolumeM3: { type: Number },
      truckType: {
        type: String,
        enum: ["small", "medium", "large", "xlarge", "custom"],
        default: "medium",
      },
      // "HH:MM" the truck leaves the depot on days initialized from this
      // template. Drives every stop's ETA.
      departureTime: { type: String, default: "08:00" },
      // Further runs of the same vehicle that day (run 2, 3, ...): each leaves
      // the depot at its own time, later than the run before it.
      extraRuns: [{ _id: false, departureTime: { type: String } }],
      serviceMin: { type: Number }, // minutes allowed per stop; unset = default
    },
  ],
  isActive: {
    type: Boolean,
    default: true,
  },
  tenant: {
    type: String,
    enum: ["halal-food-sales", "pqf", "data-tech", "ms-foods"],
    default: "halal-food-sales",
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

TruckScheduleSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("TruckSchedule", TruckScheduleSchema);
