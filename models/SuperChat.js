const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const SuperChatSchema = new Schema(
  {
    chatId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    customerId: {
      type: String,
      required: true,
      index: true,
    },
    customerName: {
      type: String,
      required: true,
    },
    customerPhone: {
      type: String,
      index: true,
    },
    customerEmail: {
      type: String,
      index: true,
    },
    assignedTo: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    assignedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    status: {
      type: String,
      enum: ["new", "assigned", "in_progress", "resolved", "closed"],
      default: "new",
      index: true,
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
      index: true,
    },
    messages: [
      {
        messageId: String,
        sender: {
          type: String,
          enum: ["customer", "agent"],
          required: true,
        },
        content: String,
        timestamp: {
          type: Date,
          default: Date.now,
        },
        attachments: [String],
        read: {
          type: Boolean,
          default: false,
        },
      },
    ],
    tags: [String],
    notes: String,
    category: String,
    source: {
      type: String,
      default: "super_chat",
    },
    lastActivity: {
      type: Date,
      default: Date.now,
      index: true,
    },
    resolutionTime: Number,
    satisfaction: {
      type: Number,
      min: 1,
      max: 5,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    externalData: Schema.Types.Mixed,
  },
  {
    timestamps: true,
    collection: "SuperChats",
  }
);

// Helpful indexes
SuperChatSchema.index({ createdAt: -1 });
SuperChatSchema.index({ status: 1, priority: 1 });
SuperChatSchema.index({ assignedTo: 1, status: 1 });
SuperChatSchema.index({ customerPhone: 1, customerEmail: 1 });

module.exports = mongoose.model("SuperChat", SuperChatSchema);


