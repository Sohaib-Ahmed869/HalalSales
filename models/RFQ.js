// models/RFQ.js
const mongoose = require('mongoose');
const mongoosePaginate = require('mongoose-paginate-v2');
const { Schema } = mongoose;

// RFQ Item Schema
const RFQItemSchema = new Schema({
    productName: {
        type: String,
        required: true,
        trim: true,
    },
    specifications: {
        type: String,
        trim: true,
    },
    quantity: {
        type: Number,
        required: true,
        min: 0,
    },
    unit: {
        type: String,
        required: true,
        enum: ['kg', 'cartons', 'packs', 'pieces', 'liters', 'boxes', 'pallets', 'cans'],
    },
    estimatedPrice: {
        type: Number,
        min: 0,
    },
    // MANDATORY target price — INTERNAL ONLY, never sent to suppliers
    targetPrice: {
        type: Number,
        required: true,
        min: 0,
    },
    // Free text for per-item specs, certifications (halal, organic), packaging notes
    additionalInfo: {
        type: String,
        trim: true,
    },
}, { _id: true });

// Main RFQ Schema
const RFQSchema = new Schema({
    // RFQ Identification
    rfqNumber: {
        type: String,
        index: true,
    },

    // Dates
    dateIssued: {
        type: Date,
        default: Date.now,
        index: true,
    },
    quotationDueDate: {
        type: Date,
        required: true,
    },
    deliveryBy: {
        type: Date,
        required: true,
    },

    // Contact Information
    contactEmail: {
        type: String,
        lowercase: true,
        trim: true,
    },
    contactPhone: {
        type: String,
        trim: true,
    },
    location: {
        type: String,
        default: 'Paris, France',
    },

    // Items Requested
    items: {
        type: [RFQItemSchema],
        validate: {
            validator: function (items) {
                return items && items.length > 0;
            },
            message: 'RFQ must have at least one item',
        },
    },

    // Incoterms (delivery/transport terms)
    incoterm: {
        type: String,
        enum: ['EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP', 'FAS', 'FOB', 'CFR', 'CIF'],
        default: 'EXW',
    },

    // Delivery destination
    destination: {
        type: String,
        default: 'Paris, France',
    },

    // Special Requirements
    packagingRequirements: String,
    paymentTermsPreference: {
        type: String,
        default: '30% advance, 70% on delivery',
    },
    otherNotes: String,

    // ⚠️ SINGLE DEFINITION OF vendorsContacted - THIS IS THE ONLY ONE
    vendorsContacted: [
        {
            vendorCode: String,
            vendorName: String,
            email: String,
            phone: String, // ADD THIS if not present
            status: {
                type: String,
                enum: ['draft', 'sent', 'opened', 'responded', 'declined'],
                default: 'draft',
            },
            vendorSource: {
                type: String,
                enum: ['SAP', 'EMAIL', 'PDA_SCRAPER', 'NEW_SUPPLIER'],
                default: 'SAP'
            },
            // When the AI agent believes the quotation is acceptable, it sets this flag
            // and notifies an admin. The admin makes the final call via selectWinningVendor.
            pendingAdminReview: {
                type: Boolean,
                default: false,
            },
            botRecommendation: {
                decision: String,           // e.g., "accept", "counter", "reject"
                reasoning: String,
                recommendedAt: Date,
                suggestedTotalPrice: Number,
            },
            sentDate: Date,
            responseDate: Date,
            quotedPrice: Number,
            quotedTotal: Number,
            deliveryDate: Date,
            paymentTerms: String,
            notes: String,

            // WhatsApp fields
            whatsappMessageId: String,
            whatsappSentDate: Date,
            whatsappHistory: [{
                direction: {
                    type: String,
                    enum: ['incoming', 'outgoing']
                },
                message: String,
                timestamp: Date,
                messageSid: String,
                mediaUrl: String,
                parsedData: Object
            }],
            rawWhatsAppContent: {
                body: String,
                receivedDate: Date,
                messageSid: String,
                mediaUrl: String
            },

            // Negotiation tracking
            negotiationRound: {
                type: Number,
                default: 0,
            },
            negotiationStatus: {
                type: String,
                enum: [
                    // WhatsApp two-phase: template fired, queue of follow-ups
                    // is parked on `pendingOutboundMessages` until vendor replies.
                    'awaiting_template_reply',
                    'awaiting_initial_quote',
                    'negotiating',
                    'awaiting_admin_approval',
                    'accepted',
                    'rejected',
                    'stalled',
                ],
                default: 'awaiting_initial_quote',
            },

            // Outbound messages queued while we wait for the vendor's first
            // reply to the WhatsApp template (24-hour conversation window opener).
            // Flushed by whatsappInboundAgent on first inbound, then cleared.
            pendingOutboundMessages: [{
                text: String,
                queuedAt: { type: Date, default: Date.now },
            }],
            templateSentAt: Date,
            templateName: String,
            negotiationHistory: [{
                round: Number,
                offeredPrice: Number,
                ourCounterOffer: Number,
                timestamp: { type: Date, default: Date.now },
                message: String,
            }],

            // Email fields
            emailMessageId: String,
            quotationData: {
                quotedItems: [{
                    productName: String,
                    quantity: Number,
                    unit: String,
                    unitPrice: Number,
                    totalPrice: Number,
                    currency: String
                }],
                totalQuotedAmount: Number,
                currency: String,
                deliveryTimeInDays: Number,
                paymentTerms: String,
                validityPeriod: String,
                additionalNotes: String,
                isValidQuotation: Boolean,
                parsingStatus: String
            },
            rawEmailContent: {
                subject: String,
                body: String,
                htmlBody: String,
                receivedDate: Date,
                attachments: [String],
                pdfContent: String
            }
        }
    ],

    // If this RFQ was re-run from a previous one
    clonedFrom: {
        type: Schema.Types.ObjectId,
        ref: 'RFQ',
    },

    // Status Tracking
    status: {
        type: String,
        enum: ['draft', 'sent', 'in_progress', 'completed', 'cancelled'],
        default: 'draft',
        index: true,
    },

    // Winner Selection
    selectedVendor: {
        vendorCode: String,
        vendorName: String,
        totalPrice: Number,
        notes: String,
        selectedAt: Date,
    },

    // User Tracking
    createdBy: {
        type: String,
        required: true,
    },

    // Metadata - Store AI analysis and other info
    metadata: {
        type: Schema.Types.Mixed,
        default: {},
    },

}, {
    timestamps: true,
    collection: 'rfqs',
});

// Add pagination plugin
RFQSchema.plugin(mongoosePaginate);

// Indexes for better query performance
RFQSchema.index({ rfqNumber: 1 });
RFQSchema.index({ status: 1, dateIssued: -1 });
RFQSchema.index({ createdBy: 1, dateIssued: -1 });
RFQSchema.index({ quotationDueDate: 1 });
RFQSchema.index({ 'vendorsContacted.vendorCode': 1 });

// Pre-save middleware to generate RFQ number
RFQSchema.pre('save', async function (next) {
    if (this.isNew && !this.rfqNumber) {
        try {
            const count = await mongoose.model('RFQ').countDocuments();
            const date = new Date();
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const sequence = String(count + 1).padStart(4, '0');

            this.rfqNumber = `RFQ-${year}${month}-${sequence}`;
        } catch (error) {
            return next(error);
        }
    }
    next();
});

// Virtual for response rate
RFQSchema.virtual('responseRate').get(function () {
    if (!this.vendorsContacted || this.vendorsContacted.length === 0) {
        return 0;
    }

    const responded = this.vendorsContacted.filter(
        v => v.status === 'responded'
    ).length;

    return (responded / this.vendorsContacted.length * 100).toFixed(2);
});

// Virtual for days until due
RFQSchema.virtual('daysUntilDue').get(function () {
    if (!this.quotationDueDate) return null;

    const now = new Date();
    const due = new Date(this.quotationDueDate);
    const diffTime = due - now;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    return diffDays;
});

// Instance method to check if expired
RFQSchema.methods.isExpired = function () {
    return this.daysUntilDue < 0;
};

// Instance method to get best quote
RFQSchema.methods.getBestQuote = function () {
    const respondedVendors = this.vendorsContacted.filter(
        v => v.status === 'responded' && v.quotedTotal
    );

    if (respondedVendors.length === 0) return null;

    return respondedVendors.reduce((best, current) => {
        return !best || current.quotedTotal < best.quotedTotal ? current : best;
    }, null);
};

// Instance method to get response summary
RFQSchema.methods.getResponseSummary = function () {
    const total = this.vendorsContacted.length;
    const responded = this.vendorsContacted.filter(v => v.status === 'responded').length;
    const declined = this.vendorsContacted.filter(v => v.status === 'declined').length;
    const pending = this.vendorsContacted.filter(v => v.status === 'sent' || v.status === 'opened').length;

    return {
        total,
        responded,
        declined,
        pending,
        responseRate: total > 0 ? ((responded / total) * 100).toFixed(2) : 0,
    };
};

// Static method to find expired RFQs
RFQSchema.statics.findExpired = function () {
    return this.find({
        quotationDueDate: { $lt: new Date() },
        status: { $in: ['sent', 'in_progress'] },
    });
};

// Static method to find RFQs awaiting responses
RFQSchema.statics.findAwaitingResponses = function () {
    return this.find({
        status: { $in: ['sent', 'in_progress'] },
        quotationDueDate: { $gte: new Date() },
    }).sort({ quotationDueDate: 1 });
};

// Ensure virtuals are included in JSON
RFQSchema.set('toJSON', { virtuals: true });
RFQSchema.set('toObject', { virtuals: true });

// Create and export model
const RFQ = mongoose.model('RFQ', RFQSchema);

module.exports = RFQ;