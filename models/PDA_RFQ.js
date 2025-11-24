const mongoose = require('mongoose');
const { Schema } = mongoose;

const PDA_RFQItemSchema = new Schema({
    productName: {
        type: String,
        required: true,
        trim: true,
    },
    specifications: String,
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
    estimatedPrice: Number,
}, { _id: true });

const PDA_RFQSchema = new Schema({
    rfqNumber: {
        type: String,
        unique: true,
        index: true,
    },

    // Link to scrape job and search
    scrapeJobId: {
        type: Schema.Types.ObjectId,
        ref: 'PDA_ScrapeJob',
        index: true,
    },
    searchTerm: {
        type: String,
        required: true,
        index: true,
    },

    // Suppliers this RFQ was sent to
    suppliers: [{
        supplierId: {
            type: Schema.Types.ObjectId,
            ref: 'PDA_Supplier',
            required: true,
        },
        supplierName: String,
        supplierEmail: String,
        status: {
            type: String,
            enum: ['sent', 'opened', 'responded', 'bounced', 'failed'],
            default: 'sent',
        },
        sentAt: Date,
        openedAt: Date,
        respondedAt: Date,
        emailMessageId: String,
    }],

    // RFQ Details
    subject: {
        type: String,
        required: true,
    },
    body: {
        type: String,
        required: true,
    },
    items: {
        type: [PDA_RFQItemSchema],
        validate: {
            validator: function (items) {
                return items && items.length > 0;
            },
            message: 'RFQ must have at least one item',
        },
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
    deliveryBy: Date,

    // Contact Information
    contactEmail: {
        type: String,
        required: true,
    },
    contactPhone: String,
    companyName: {
        type: String,
        default: 'Halal Food Service',
    },

    // Requirements
    packagingRequirements: String,
    paymentTermsPreference: String,
    otherNotes: String,

    // Status
    status: {
        type: String,
        enum: ['draft', 'sent', 'in_progress', 'completed', 'cancelled'],
        default: 'draft',
        index: true,
    },

    // AI Generation Info
    generatedBy: {
        type: String,
        enum: ['manual', 'ai'],
        default: 'ai',
    },
    aiModel: String,

    // User tracking
    createdBy: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },

    // Metadata
    metadata: Schema.Types.Mixed,

}, {
    timestamps: true,
    collection: 'pda_rfqs',
});

// Indexes
PDA_RFQSchema.index({ rfqNumber: 1 });
PDA_RFQSchema.index({ status: 1, dateIssued: -1 });
PDA_RFQSchema.index({ createdBy: 1, dateIssued: -1 });
PDA_RFQSchema.index({ searchTerm: 1 });

// Pre-save middleware to generate RFQ number
PDA_RFQSchema.pre('save', async function (next) {
    if (this.isNew && !this.rfqNumber) {
        try {
            const count = await mongoose.model('PDA_RFQ').countDocuments();
            const date = new Date();
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const sequence = String(count + 1).padStart(4, '0');

            this.rfqNumber = `RFQ-PDA-${year}${month}-${sequence}`;
        } catch (error) {
            return next(error);
        }
    }
    next();
});

// Virtual for response summary
PDA_RFQSchema.virtual('responseSummary').get(function () {
    const total = this.suppliers.length;
    const sent = this.suppliers.filter(s => s.status === 'sent').length;
    const responded = this.suppliers.filter(s => s.status === 'responded').length;
    const failed = this.suppliers.filter(s => s.status === 'failed' || s.status === 'bounced').length;

    return {
        total,
        sent,
        responded,
        failed,
        responseRate: total > 0 ? ((responded / total) * 100).toFixed(2) : 0,
    };
});

PDA_RFQSchema.set('toJSON', { virtuals: true });
PDA_RFQSchema.set('toObject', { virtuals: true });

const PDA_RFQ = mongoose.model('PDA_RFQ', PDA_RFQSchema);

module.exports = PDA_RFQ;