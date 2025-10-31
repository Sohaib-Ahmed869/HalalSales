const mongoose = require("mongoose");

const paypalStatementSchema = new mongoose.Schema(
    {
        // Transaction date and time
        date: {
            type: Date,
            required: true,
            index: true,
        },

        time: {
            type: String,
            required: true,
        },

        timezone: {
            type: String,
            default: "PDT",
        },

        // Transaction details
        name: {
            type: String,
            default: null,
        },

        type: {
            type: String,
            required: true,
            index: true,
        },

        status: {
            type: String,
            required: true,
            index: true,
        },

        currency: {
            type: String,
            default: "EUR",
            required: true,
        },

        // Financial details
        grossAmount: {
            type: Number,
            required: true,
        },

        fee: {
            type: Number,
            default: 0,
        },

        netAmount: {
            type: Number,
            required: true,
            index: true,
        },

        // Email addresses
        fromEmail: {
            type: String,
            default: null,
            index: true,
        },

        toEmail: {
            type: String,
            default: null,
            index: true,
        },

        // Transaction identifiers
        transactionId: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },

        referenceTransactionId: {
            type: String,
            default: null,
        },

        invoiceNumber: {
            type: String,
            default: null,
            index: true,
        },

        customerNumber: {
            type: String,
            default: null,
        },

        receiptNumber: {
            type: String,
            default: null,
        },

        // Shipping details
        shippingAddress: {
            fullAddress: { type: String, default: null },
            addressStatus: { type: String, default: null },
            street: { type: String, default: null },
            district: { type: String, default: null },
            city: { type: String, default: null },
            state: { type: String, default: null },
            postalCode: { type: String, default: null },
            country: { type: String, default: null },
            phoneNumber: { type: String, default: null },
        },

        // Item details
        itemTitle: {
            type: String,
            default: null,
        },

        itemNumber: {
            type: String,
            default: null,
        },

        quantity: {
            type: Number,
            default: null,
        },

        // Additional charges
        shippingAndHandling: {
            type: Number,
            default: 0,
        },

        insurance: {
            type: Number,
            default: 0,
        },

        vat: {
            type: Number,
            default: 0,
        },

        // Options
        option1Name: {
            type: String,
            default: null,
        },

        option1Value: {
            type: String,
            default: null,
        },

        option2Name: {
            type: String,
            default: null,
        },

        option2Value: {
            type: String,
            default: null,
        },

        // Balance
        balance: {
            type: Number,
            default: 0,
        },

        // Subject and notes
        subject: {
            type: String,
            default: null,
        },

        note: {
            type: String,
            default: null,
        },

        // Country code
        countryCode: {
            type: String,
            default: null,
        },

        // Balance impact
        balanceImpact: {
            type: String,
            enum: ["Crédit", "Débit", null],
            default: null,
            index: true,
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

// Indexes for faster queries
paypalStatementSchema.index({ date: 1, netAmount: 1 });
paypalStatementSchema.index({ matchedCustomer: 1, reconciliationStatus: 1 });
paypalStatementSchema.index({ fromEmail: 1, toEmail: 1 });

const PayPalStatement = mongoose.model("PayPalStatement", paypalStatementSchema);

module.exports = PayPalStatement;