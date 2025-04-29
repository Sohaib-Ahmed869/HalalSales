const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const TaskSchema = new Schema({
  // Task information
  title: {
    type: String,
    required: true,
  },
  description: {
    type: String,
  },

  // Task categorization
  type: {
    type: String,
    enum: ["call", "email", "meeting", "follow-up", "other"],
    default: "follow-up",
  },
  priority: {
    type: String,
    enum: ["low", "medium", "high"],
    default: "medium",
  },

  // Task status
  status: {
    type: String,
    enum: ["pending", "completed", "canceled"],
    default: "pending",
  },

  // Scheduling
  dueDate: {
    type: Date,
    required: true,
  },
  completedDate: {
    type: Date,
  },

  // Associated entities
  assignedTo: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  leadId: {
    type: Schema.Types.ObjectId,
    ref: "Lead",
    required: true,
  },

  // Create/update tracking
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

// Update timestamps before saving
TaskSchema.pre("save", function (next) {
  this.updatedAt = Date.now();

  // If the task is being marked as completed, set the completedDate
  if (
    this.isModified("status") &&
    this.status === "completed" &&
    !this.completedDate
  ) {
    this.completedDate = Date.now();
  }

  next();
});

// Create indexes for faster querying
TaskSchema.index({ assignedTo: 1, status: 1, dueDate: 1 });
TaskSchema.index({ leadId: 1 });

const Task = mongoose.model("Task", TaskSchema);
module.exports = Task;
