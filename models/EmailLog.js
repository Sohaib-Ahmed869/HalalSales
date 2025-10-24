// models/EmailLog.js
const mongoose = require("mongoose");

const emailLogSchema = new mongoose.Schema(
  {
    // Email Details
    to: {
      type: [String],
      required: true,
    },
    cc: {
      type: [String],
      default: [],
    },
    bcc: {
      type: [String],
      default: [],
    },
    subject: {
      type: String,
      required: true,
    },
    body: {
      type: String,
      required: true,
    },
    htmlBody: {
      type: String,
    },

    // Email Type & Context
    emailType: {
      type: String,
      enum: [
        "invoice",
        "invoice_apology",
        "credit_note",
        "payment_confirmation",
        "delivery_note",
        "general",
        "order_confirmation",
        "other"
      ],
      default: "general",
    },
    relatedInvoice: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Invoices",
    },
    relatedCustomer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
    },
    customerCardCode: {
      type: String,
    },

    // Attachments stored in S3
    attachments: [
      {
        filename: {
          type: String,
          required: true,
        },
        originalName: {
          type: String,
          required: true,
        },
        contentType: {
          type: String,
          required: true,
        },
        size: {
          type: Number,
          required: true,
        },
        s3Key: {
          type: String,
          required: true,
        },
        s3Url: {
          type: String,
          required: true,
        },
      },
    ],

    // Status & Tracking
    status: {
      type: String,
      enum: ["sent", "failed", "pending"],
      default: "sent",
    },
    sentAt: {
      type: Date,
      default: Date.now,
    },
    error: {
      type: String,
    },

    // Provider Details
    provider: {
      type: String,
      default: "nodemailer",
    },
    messageId: {
      type: String,
    },

    // User who triggered the email
    sentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    sentByName: {
      type: String,
    },

    // Metadata
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for efficient queries
emailLogSchema.index({ to: 1, sentAt: -1 });
emailLogSchema.index({ relatedInvoice: 1 });
emailLogSchema.index({ relatedCustomer: 1 });
emailLogSchema.index({ customerCardCode: 1 });
emailLogSchema.index({ emailType: 1, sentAt: -1 });
emailLogSchema.index({ status: 1 });
emailLogSchema.index({ createdAt: -1 });

const EmailLog = mongoose.model("EmailLog", emailLogSchema);

module.exports = EmailLog;