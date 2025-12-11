// models/TruckSchedule.js
const mongoose = require("mongoose");

const truckScheduleSchema = new mongoose.Schema({
    dayOfWeek: {
        type: String,
        required: true,
        enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
    },
    region: {
        type: String,
        required: false, // Can be null for generic schedules
    },
    departments: [{
        type: String, // Department codes like "75", "92", etc.
    }],
    cities: [{
        type: String, // City names
    }],
    numberOfTrucks: {
        type: Number,
        required: true,
        min: 1,
    },
    isActive: {
        type: Boolean,
        default: true,
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

truckScheduleSchema.index({ dayOfWeek: 1, region: 1 });

module.exports = mongoose.model("TruckSchedule", truckScheduleSchema);