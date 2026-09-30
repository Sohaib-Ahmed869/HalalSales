const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const CustomerSchema = new Schema({
  // SAP Data
  CardName: {
    type: String,
    required: true,
  },
  CardCode: {
    type: String,
    required: true,
    unique: true,
  },
  Email: {
    type: String,
  },
  // Hubspot Data
  phoneNumber: {
    type: String,
    trim: true,
  },
  hubspotId: {
    type: String,
    trim: true,
  },
  // Assigned sales agent
  assignedTo: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },
  // Additional fields
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  // Track customer status
  status: {
    type: String,
    enum: ["active", "inactive", "lead", "prospect"],
    default: "active",
  },
  notes: {
    type: String,
  },
  // Logistics / delivery fields (added for Sales Map Report + Truck Schedules)
  company: {
    type: String,
    trim: true,
  },
  address: {
    street: { type: String, trim: true },
    zipCode: { type: String, trim: true },
    city: { type: String, trim: true },
    country: { type: String, trim: true },
  },
  geo: {
    lat: { type: Number },
    lng: { type: Number },
    geocodedAt: { type: Date },
    geocodeStatus: {
      type: String,
      enum: ["pending", "ok", "failed", "manual"],
      default: "pending",
    },
    // Which provider produced lat/lng (utils/geocodingService.js) and how
    // sure it was; "low" = only town / postcode-area level or unverified.
    source: { type: String, enum: ["photon", "ban", "postcodes.io", "google"] },
    confidence: { type: String, enum: ["high", "low"] },
  },
  openingTime: {
    type: String, // "HH:MM"
  },
  closingTime: {
    type: String, // "HH:MM"
  },
  fulfillmentMethod: {
    type: String,
    enum: ["delivery", "pickup"],
    default: "delivery",
  },
  marketingStatus: {
    type: String,
    trim: true,
  },
});

// Update timestamps on save
CustomerSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

const Customer = mongoose.model("Customer", CustomerSchema);
module.exports = Customer;
