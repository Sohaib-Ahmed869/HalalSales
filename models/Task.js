// models/Task.js
const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const TaskSchema = new Schema({
  title: {
    type: String,
    required: true,
    trim: true,
  },
  description: {
    type: String,
    trim: true,
  },
  leadId: {
    type: Schema.Types.ObjectId,
    ref: "Lead",
  },
  status: {
    type: String,
    enum: ["pending", "pending_approval", "completed", "rejected"],
    default: "pending",
  },
  priority: {
    type: String,
    enum: ["low", "medium", "high"],
    default: "medium",
  },
  type: {
    type: String,
    enum: ["follow-up", "call", "email", "meeting", "other", "approval", "customer_approval", "restaurant_follow_up"], // ADD restaurant_follow_up
    default: "follow-up",
  },

  // Add new field:
  relatedRestaurant: {
    type: Schema.Types.ObjectId,
    ref: "RestaurantAssignment",
  },
  dueDate: {
    type: Date,
    required: true,
  },
  completedDate: {
    type: Date,
  },
  assignedTo: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  comments: {
    type: String,
    trim: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  attachment: {
    fileName: String,
    fileSize: Number,
    fileType: String,
    s3Key: String,
    s3Url: String,
    uploadedAt: Date,
  },
  relatedQuotation: {
    type: Number, // This should match the DocEntry type in your Quotation model
    ref: "Quotation",
  },
  relatedAbandonedCart: {
    type: Schema.Types.ObjectId,
    ref: "Cart",
  },
  relatedCustomer: {
    type: Schema.Types.ObjectId,
    ref: "Customer",
  },
});

// Update the updatedAt timestamp on save
TaskSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("Task", TaskSchema);
