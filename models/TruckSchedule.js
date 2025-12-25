const mongoose = require("mongoose");

const truckScheduleSchema = new mongoose.Schema({
    dayOfWeek: {
        type: String,
        required: true,
        enum: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
    },
    region: String,
    departments: [String],
    cities: [String],
    numberOfTrucks: {
        type: Number,
        required: true,
        min: 1,
    },
    // REPLACE maxWeightKg with trucks array
    trucks: [{
        truckNumber: {
            type: Number,
            required: true,
        },
        truckName: String,
        maxWeightKg: {
            type: Number,
            default: 1000,
            min: 100,
        },
        // Optional: Add truck type/model
        truckType: {
            type: String,
            enum: ["small", "medium", "large", "custom"],
            default: "medium",
        },
    }],
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