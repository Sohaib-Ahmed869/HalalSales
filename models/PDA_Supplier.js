const mongoose = require('mongoose');
const { Schema } = mongoose;

const PDA_SupplierSchema = new Schema({
    scrapeJobId: {
        type: Schema.Types.ObjectId,
        ref: 'PDA_ScrapeJob',
        required: true,
        index: true,
    },
    sessionId: {
        type: String,
        required: true,
        index: true,
    },
    searchTerm: {
        type: String,
        required: true,
        index: true,
    },
    supplierName: {
        type: String,
        required: true,
        trim: true,
    },
    country: String,
    scrapedFrom: {
        type: String,
        enum: ['europages', 'freshdi', 'globalsources', 'alibaba'],
    },

    email: {
        type: String,
        trim: true,
        lowercase: true,
        index: true,
    },


    // Contact Information
    contactInfo: {
        phone: String,

        address: String,
        website: String,
        additionalInfo: Schema.Types.Mixed,
    },

    // Original scraped data
    rawData: Schema.Types.Mixed,

    // RFQ tracking
    rfqsSent: [{
        type: Schema.Types.ObjectId,
        ref: 'PDA_RFQ',
    }],

    lastRFQSentAt: Date,

    // Status
    isActive: {
        type: Boolean,
        default: true,
    },

}, {
    timestamps: true,
    collection: 'pda_suppliers',
});

// Indexes
PDA_SupplierSchema.index({ supplierName: 1, searchTerm: 1 });
PDA_SupplierSchema.index({ scrapeJobId: 1, isActive: 1 });
PDA_SupplierSchema.index({ 'contactInfo.email': 1 });

// Virtual for display name
PDA_SupplierSchema.virtual('displayName').get(function () {
    return `${this.supplierName} (${this.country || 'Unknown'})`;
});

// Method to check if has contact info
PDA_SupplierSchema.methods.hasContactInfo = function () {
    return !!(this.contactInfo?.email || this.contactInfo?.phone);
};

// Static method to find suppliers by search term
PDA_SupplierSchema.statics.findBySearchTerm = function (searchTerm) {
    return this.find({ searchTerm, isActive: true });
};

PDA_SupplierSchema.set('toJSON', { virtuals: true });
PDA_SupplierSchema.set('toObject', { virtuals: true });

const PDA_Supplier = mongoose.model('PDA_Supplier', PDA_SupplierSchema);

module.exports = PDA_Supplier;