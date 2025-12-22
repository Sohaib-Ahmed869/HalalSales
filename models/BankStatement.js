const mongoose = require("mongoose");

const bankStatementSchema = new mongoose.Schema(
    {
        // Operation date
        operationDate: {
            type: Date,
            required: true,
            index: true,
        },

        // Operation reference
        operationReference: {
            type: String,
            default: null,
        },

        // Operation type (e.g., "VIREMENT SEPA RECU", "VIREMENT INST. RECU")
        operationType: {
            type: String,
            required: true,
            index: true,
        },

        // Amount (stored as number, parsed from French format)
        amount: {
            type: Number,
            required: true,
            index: true,
        },
        bankSource: {
            type: String,
            enum: ["BRED", "SG"],
            default: "BRED",
            required: true,
            index: true,
        },

        // Comment
        comment: {
            type: String,
            default: null,
        },

        // Details (stored as array for flexibility)
        details: {
            detail1: { type: String, default: null },
            detail2: { type: String, default: null },
            detail3: { type: String, default: null },
            detail4: { type: String, default: null },
            detail5: { type: String, default: null },
            detail6: { type: String, default: null },
        },

        // Metadata
        importedAt: {
            type: Date,
            default: Date.now,
        },

        // Optional: Link to customer or invoice if matched
        matchedCustomer: {
            type: String, // CardCode
            default: null,
            index: true,
        },

        matchedInvoice: {
            type: Number, // DocNum
            default: null,
            index: true,
        },

        // Status for reconciliation
        reconciliationStatus: {
            type: String,
            enum: ["Unmatched", "Matched", "Partially Matched", "Manual Review"],
            default: "Unmatched",
            index: true,
        },

        // Notes for manual reconciliation
        reconciliationNotes: {
            type: String,
            default: null,
        },
    },
    {
        timestamps: true,
    }
);

// Index for faster queries
bankStatementSchema.index({ operationDate: 1, amount: 1 });
bankStatementSchema.index({ matchedCustomer: 1, reconciliationStatus: 1 });

const BankStatement = mongoose.model("BankStatement", bankStatementSchema);

module.exports = BankStatement;