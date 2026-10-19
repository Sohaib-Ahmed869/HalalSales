// models/Notification.js
const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const NotificationSchema = new Schema({
  recipient: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  sender: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  type: {
    type: String,
    enum: [
      "task_assigned",
      "task_updated",
      "task_completed",
      "task_approved",
      "task_rejected",
      "restaurant_assigned",
      "restaurant_updated",
      "rfq_needs_attention",    // AI bot flagged an RFQ for admin approval
      "rfq_stalled",            // Negotiation stalled — human intervention needed
      "rfq_accepted",           // Admin accepted a vendor quotation
      "lead_assigned",          // A lead (e.g. an AI WhatsApp hand-off) needs this agent
    ],
    required: true,
  },

  // Add new field:
  relatedRestaurant: {
    type: Schema.Types.ObjectId,
    ref: "RestaurantAssignment",
  },
  // Link to the RFQ this notification is about
  relatedRFQ: {
    type: Schema.Types.ObjectId,
    ref: "RFQ",
  },
  title: {
    type: String,
    required: true,
  },
  message: {
    type: String,
    required: true,
  },
  relatedTask: {
    type: Schema.Types.ObjectId,
    ref: "Task",
  },
  relatedLead: {
    type: Schema.Types.ObjectId,
    ref: "Lead",
  },
  isRead: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Index for efficient queries
NotificationSchema.index({ recipient: 1, createdAt: -1 });
NotificationSchema.index({ recipient: 1, isRead: 1 });

module.exports = mongoose.model("Notification", NotificationSchema);
