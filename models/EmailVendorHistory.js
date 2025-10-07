// models/EmailVendorHistory.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const EmailInteractionSchema = new Schema({
    date: Date,
    subject: String,
    type: {
        type: String,
        enum: ['rfq_sent', 'quotation_response', 'purchase_order', 'invoice', 'acknowledgment', 'general'],
    },
    hasAttachments: Boolean,
    snippet: String,
    // ADD THESE FIELDS:
    quotationData: {
        type: {
            quotedItems: [{
                productName: String,
                quantity: Number,
                unit: String,
                unitPrice: Number,
                totalPrice: Number,
                currency: String
            }],
            totalQuotedAmount: Number,
            deliveryTimeInDays: Number,
            paymentTerms: String,
            notes: String
        },
        default: null
    }
}, { _id: true });

const EmailVendorHistorySchema = new Schema({
    vendorEmail: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        index: true,
    },
    vendorCardCode: {
        type: String,
        ref: 'Vendor',
        index: true,
    },
    interactions: [EmailInteractionSchema],
    lastSync: {
        type: Date,
        default: Date.now,
    },
    metadata: {
        type: Schema.Types.Mixed,
        default: {},
    },
}, {
    timestamps: true,
    collection: 'email_vendor_history',
});

// Index for faster queries
EmailVendorHistorySchema.index({ vendorEmail: 1, lastSync: -1 });
EmailVendorHistorySchema.index({ 'interactions.date': -1 });

module.exports = mongoose.model('EmailVendorHistory', EmailVendorHistorySchema);