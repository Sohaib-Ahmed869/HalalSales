// models/NewSupplier.js
// Suppliers uploaded manually via Excel — separate from SAP vendors and PDA_Supplier (scraped).
// These are used when creating an RFQ with the "New Suppliers" mode.

const mongoose = require("mongoose");
const { Schema } = mongoose;

const NewSupplierSchema = new Schema(
    {
        supplierName: {
            type: String,
            required: true,
            trim: true,
            index: true,
        },
        companyName: {
            type: String,
            trim: true,
        },
        email: {
            type: String,
            trim: true,
            lowercase: true,
            index: true,
        },
        phone: {
            type: String,
            trim: true,
        },
        country: {
            type: String,
            trim: true,
            index: true,
        },
        city: {
            type: String,
            trim: true,
        },
        address: {
            type: String,
            trim: true,
        },
        website: {
            type: String,
            trim: true,
        },
        // Products / categories this supplier can provide — used for matching during RFQ creation
        productCategories: {
            type: [String],
            default: [],
            index: true,
        },
        // Free text notes
        notes: {
            type: String,
            trim: true,
        },
        // Source tracking
        uploadBatchId: {
            type: String,
            index: true,
        },
        uploadedBy: {
            type: Schema.Types.ObjectId,
            ref: "User",
        },
        // Stats — updated when RFQs are sent / responses received
        stats: {
            totalRFQsSent: { type: Number, default: 0 },
            totalResponses: { type: Number, default: 0 },
            totalQuotations: { type: Number, default: 0 },
            totalWins: { type: Number, default: 0 },
            lastRFQSentAt: { type: Date },
            lastResponseAt: { type: Date },
            avgResponseTimeHours: { type: Number, default: 0 },
        },
        isActive: {
            type: Boolean,
            default: true,
            index: true,
        },
    },
    { timestamps: true }
);

// Compound index for matching by category + active state
NewSupplierSchema.index({ productCategories: 1, isActive: 1 });
NewSupplierSchema.index({ email: 1, isActive: 1 });

// Text index for searching
NewSupplierSchema.index({
    supplierName: "text",
    companyName: "text",
    productCategories: "text",
    country: "text",
});

module.exports = mongoose.model("NewSupplier", NewSupplierSchema);
