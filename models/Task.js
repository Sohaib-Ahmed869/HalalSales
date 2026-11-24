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
  // When the "follow-up due" notification went out (services/leadFollowUp.js).
  // Cleared whenever the due date moves, so a rescheduled follow-up reminds again.
  reminderSentAt: {
    type: Date,
    default: null,
  },
});

// Indexes for the task list endpoints, which filter on owner/status and always
// sort by createdAt. Without these the paginated queries and their matching
// countDocuments do full collection scans.
TaskSchema.index({ assignedTo: 1, createdAt: 1 });
TaskSchema.index({ createdBy: 1, createdAt: 1 });
TaskSchema.index({ status: 1, createdAt: 1 });
TaskSchema.index({ dueDate: 1 });
TaskSchema.index({ leadId: 1 });
TaskSchema.index({ relatedQuotation: 1 });

TaskSchema.index({ status: 1, dueDate: 1, reminderSentAt: 1 });

// Update the updatedAt timestamp on save
TaskSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  if (!this.isNew && this.isModified("dueDate")) this.reminderSentAt = null;
  next();
});

// Tasks are also edited with findByIdAndUpdate: a new due date there must
// re-arm the reminder too.
TaskSchema.pre("findOneAndUpdate", function (next) {
  const u = this.getUpdate() || {};
  const set = u.$set || u;
  if (set.dueDate !== undefined && set.reminderSentAt === undefined) {
    if (u.$set) u.$set.reminderSentAt = null;
    else u.reminderSentAt = null;
    this.setUpdate(u);
  }
  next();
});

module.exports = mongoose.model("Task", TaskSchema);
