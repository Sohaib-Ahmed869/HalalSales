const mongoose = require("mongoose");

/**
 * Singleton settings document that controls the automated daily invoice
 * email job. There should only ever be one document (key: "default").
 */
const invoiceEmailSettingsSchema = new mongoose.Schema(
  {
    // Fixed key to guarantee a single settings document
    key: {
      type: String,
      default: "default",
      unique: true,
    },

    // Master on/off switch for the whole job
    enabled: {
      type: Boolean,
      default: false,
    },

    // Time of day (24h "HH:mm") the emails go out, interpreted in `timezone`
    sendTime: {
      type: String,
      default: "07:00",
      validate: {
        validator: (v) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(v),
        message: (props) => `${props.value} is not a valid HH:mm time`,
      },
    },

    // IANA timezone the sendTime is interpreted in (French clock by default)
    timezone: {
      type: String,
      default: "Europe/Paris",
    },

    // Exclude POS / cash-register sales (only email account/delivery customers)
    excludePOS: {
      type: Boolean,
      default: true,
    },

    // Email a run summary (sent / failed / skipped) to these addresses
    adminSummaryEnabled: {
      type: Boolean,
      default: true,
    },
    adminSummaryRecipients: {
      type: [String],
      default: [],
    },

    // Result of the most recent run (for display in the admin UI)
    lastRun: {
      at: { type: Date, default: null },
      trigger: { type: String, enum: ["cron", "manual", null], default: null },
      status: {
        type: String,
        enum: ["success", "partial", "failed", "no_invoices", null],
        default: null,
      },
      dateRange: {
        from: { type: Date, default: null },
        to: { type: Date, default: null },
      },
      totalInvoices: { type: Number, default: 0 },
      customersEmailed: { type: Number, default: 0 },
      customersFailed: { type: Number, default: 0 },
      customersSkipped: { type: Number, default: 0 },
      skipped: {
        // { cardCode, customerName, invoiceCount, reason }
        type: Array,
        default: [],
      },
      failed: {
        // { cardCode, customerName, error }
        type: Array,
        default: [],
      },
      error: { type: String, default: null },
    },
  },
  { timestamps: true }
);

/**
 * Fetch the single settings document, creating it with defaults if missing.
 */
invoiceEmailSettingsSchema.statics.getSettings = async function () {
  let settings = await this.findOne({ key: "default" });
  if (!settings) {
    settings = await this.create({ key: "default" });
  }
  return settings;
};

module.exports = mongoose.model(
  "InvoiceEmailSettings",
  invoiceEmailSettingsSchema
);
