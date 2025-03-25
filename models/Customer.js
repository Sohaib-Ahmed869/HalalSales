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
});

// Update timestamps on save
CustomerSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

const Customer = mongoose.model("Customer", CustomerSchema);
module.exports = Customer;
