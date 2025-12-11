// models/TruckRoute.js
const mongoose = require("mongoose");

const truckRouteSchema = new mongoose.Schema({
    deliveryDate: {
        type: Date,
        required: true,
    },
    scheduleId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "TruckSchedule",
        required: true,
    },
    dayOfWeek: {
        type: String,
        required: true,
    },
    region: String,
    departments: [String],
    cities: [String],
    truckNumber: {
        type: Number,
        required: true,
        min: 1,
    },
    truckName: {
        type: String,
        required: true,
    },
    orders: [{
        order: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "SalesOrder",
            required: true,
        },
        sequenceNumber: {
            type: Number,
            required: true,
        },
        assignedAt: {
            type: Date,
            default: Date.now,
        },
    }],
    totalOrders: {
        type: Number,
        default: 0,
    },
    status: {
        type: String,
        enum: ["planning", "in_progress", "completed"],
        default: "planning",
    },
    completedAt: Date,
    createdAt: {
        type: Date,
        default: Date.now,
    },
    updatedAt: {
        type: Date,
        default: Date.now,
    },
});

truckRouteSchema.index({ deliveryDate: 1, truckNumber: 1 });
truckRouteSchema.index({ deliveryDate: 1, scheduleId: 1 });
truckRouteSchema.index({ "orders.order": 1 });

module.exports = mongoose.model("TruckRoute", truckRouteSchema);