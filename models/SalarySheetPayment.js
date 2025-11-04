// models/SalarySheetPayment.js
const mongoose = require("mongoose");

const salarySheetPaymentSchema = new mongoose.Schema(
    {
        // Customer information
        cardCode: {
            type: String,
            required: true,
            index: true,
        },

        cardName: {
            type: String,
            required: true,
        },

        // Payment details
        amount: {
            type: Number,
            required: true,
        },

        paymentDate: {
            type: Date,
            required: true,
            index: true,
        },

        // Reference for matching
        reference: {
            type: String,
            index: true,
        },

        // Payment method from sheet
        paymentMethod: {
            type: String,
            enum: ["checks", "cash", "creditCardSite", "creditCardPhone", "transfers", "unpaid"],
        },

        // Bank details if available
        bank: {
            type: String,
        },

        checkNumber: {
            type: String,
        },

        // SAP status
        sap: {
            type: String,
        },

        // Remarks
        remarks: {
            type: String,
        },

        // Original sheet data
        sheetDate: {
            type: Date,
        },

        sheetReference: {
            type: String,
        },

        // Reconciliation status
        reconciliationStatus: {
            type: String,
            enum: ["Unmatched", "Matched", "Partially Matched", "Manual Review"],
            default: "Unmatched",
            index: true,
        },

        // Matched invoice
        matchedInvoice: {
            type: Number,
        },

        // Matched customer
        matchedCustomer: {
            type: String,
        },

        // Notes
        reconciliationNotes: {
            type: String,
        },

        // Import metadata
        importedAt: {
            type: Date,
            default: Date.now,
        },

        importedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
        },

        // Link to flattened payment
        flattenedPaymentId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "FlattenedPayment",
        },
    },
    {
        timestamps: true,
    }
);

// Indexes
salarySheetPaymentSchema.index({ cardCode: 1, paymentDate: -1 });
salarySheetPaymentSchema.index({ reconciliationStatus: 1 });
salarySheetPaymentSchema.index({ reference: 1 });

const SalarySheetPayment = mongoose.model("SalarySheetPayment", salarySheetPaymentSchema);

module.exports = SalarySheetPayment;