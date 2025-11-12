// models/FlattenedPayment.js
const mongoose = require("mongoose");

const flattenedPaymentSchema = new mongoose.Schema(
    {
        // Unified fields
        cardCode: {
            type: String,
            required: false,  // Allow null/undefined
            default: null,
            index: true,
            sparse: true,  // Sparse index to handle null values efficiently
        },

        cardName: {
            type: String,
            index: true,
        },

        amount: {
            type: Number,
            required: true,
            index: true,
        },

        // Reference that can be matched against invoices
        reference: {
            type: String,
            index: true,
            sparse: true,
        },

        // Source of payment
        source: {
            type: String,
            enum: ["salary_sheet", "bred_bank", "paypal"],
            required: true,
            index: true,
        },

        // Payment date
        paymentDate: {
            type: Date,
            required: true,
            index: true,
        },

        // Link to original source document
        sourceDocument: {
            sourceType: {
                type: String,
                enum: ["BankStatement", "PayPalStatement", "SalarySheetPayment"],
            },
            sourceId: {
                type: mongoose.Schema.Types.ObjectId,
            },
        },

        // Reconciliation status
        reconciliationStatus: {
            type: String,
            enum: ["Unmatched", "Matched", "Partially Matched", "Manual Review"],
            default: "Unmatched",
            index: true,
        },

        // Multiple card codes if needed
        alternateCardCodes: [{
            type: String,
            index: true,
        }],

        // Matched invoices
        matchedInvoices: [{
            invoiceDocNum: Number,
            invoiceDocEntry: Number,
            amountAllocated: Number,
            matchedDate: Date,
            matchedBy: {
                type: mongoose.Schema.Types.ObjectId,
                ref: "User",
            },
        }],

        // Total allocated amount
        totalAllocated: {
            type: Number,
            default: 0,
        },

        // Remaining unallocated amount
        remainingAmount: {
            type: Number,
            default: 0,
        },

        // Payment method (if available)
        paymentMethod: {
            type: String,
        },

        // Additional details from source
        sourceDetails: {
            type: mongoose.Schema.Types.Mixed,
        },

        // Notes for reconciliation
        reconciliationNotes: {
            type: String,
        },

        // Auto-match confidence score (0-100)
        autoMatchConfidence: {
            type: Number,
            min: 0,
            max: 100,
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
    },
    {
        timestamps: true,
    }
);

// Indexes for performance
flattenedPaymentSchema.index({ cardCode: 1, paymentDate: -1 });
flattenedPaymentSchema.index({ source: 1, reconciliationStatus: 1 });
flattenedPaymentSchema.index({ reference: 1, amount: 1 });
flattenedPaymentSchema.index({ remainingAmount: 1 });

// Method to calculate remaining amount
flattenedPaymentSchema.methods.calculateRemaining = function () {
    this.totalAllocated = this.matchedInvoices.reduce((sum, inv) => sum + inv.amountAllocated, 0);
    this.remainingAmount = this.amount - this.totalAllocated;

    if (this.remainingAmount <= 0.01) {
        this.reconciliationStatus = "Matched";
    } else if (this.totalAllocated > 0) {
        this.reconciliationStatus = "Partially Matched";
    } else {
        this.reconciliationStatus = "Unmatched";
    }
};

const FlattenedPayment = mongoose.model("FlattenedPayment", flattenedPaymentSchema);

module.exports = FlattenedPayment;