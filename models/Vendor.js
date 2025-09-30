// models/Vendor.js
const mongoose = require('mongoose');
const mongoosePaginate = require('mongoose-paginate-v2');
const { Schema } = mongoose;

const VendorSchema = new Schema({
    // SAP Business One Integration
    CardCode: {
        type: String,
        required: true,
        unique: true,
        index: true,
        trim: true,
    },
    CardName: {
        type: String,
        required: true,
        trim: true,
    },

    // Contact Information
    email: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
        validate: {
            validator: function (v) {
                return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
            },
            message: props => `${props.value} is not a valid email!`
        }
    },
    secondaryEmail: {
        type: String,
        lowercase: true,
        trim: true,
    },
    phone: {
        type: String,
        trim: true,
    },
    mobile: {
        type: String,
        trim: true,
    },
    fax: String,

    // Address Information
    address: String,
    street: String,
    block: String,
    city: String,
    zipCode: String,
    county: String,
    country: String,

    // Business Information
    vatNumber: String,
    taxId: String,
    companyRegistrationNumber: String,

    // Product Categories
    productCategories: {
        type: [String],
        index: true,
        default: [],
    },

    // Certifications
    certifications: {
        type: [String],
        default: [],
        // e.g., ['halal', 'organic', 'iso9001', 'haccp']
    },

    // Performance Metrics
    performanceMetrics: {
        totalOrders: {
            type: Number,
            default: 0,
        },
        totalOrderValue: {
            type: Number,
            default: 0,
        },
        averageOrderValue: {
            type: Number,
            default: 0,
        },
        onTimeDeliveryRate: {
            type: Number,
            default: 100,
            min: 0,
            max: 100,
        },
        qualityRating: {
            type: Number,
            default: 5,
            min: 0,
            max: 5,
        },
        responseTime: {
            type: Number, // in hours
            default: 24,
        },
        averageDeliveryDays: {
            type: Number,
            default: 7,
        },
    },

    // Payment Terms
    defaultPaymentTerms: {
        type: String,
        default: 'Net 30',
    },
    creditLimit: {
        type: Number,
        default: 0,
    },

    // Status and Preferences
    isActive: {
        type: Boolean,
        default: true,
        index: true,
    },
    isPreferred: {
        type: Boolean,
        default: false,
    },
    preferredForCategories: [String],

    // RFQ Preferences
    rfqPreferences: {
        autoSendRFQ: {
            type: Boolean,
            default: true,
        },
        preferredLanguage: {
            type: String,
            enum: ['en', 'fr', 'ar', 'es'],
            default: 'fr',
        },
        minimumOrderValue: Number,
        excludeFromAutoRFQ: {
            type: Boolean,
            default: false,
        },
    },

    // Contact Person
    contactPerson: {
        name: String,
        title: String,
        email: String,
        phone: String,
        mobile: String,
    },

    // Notes and Comments
    notes: String,
    internalNotes: String, // Not shared with vendor

    // Timestamps for last interactions
    lastOrderDate: Date,
    lastRFQSentDate: Date,
    lastContactDate: Date,

    // Metadata
    tags: [String],
    customFields: {
        type: Schema.Types.Mixed,
        default: {},
    },

}, {
    timestamps: true,
    collection: 'vendors',
});

// Add pagination plugin
VendorSchema.plugin(mongoosePaginate);

// Indexes for better query performance
VendorSchema.index({ CardCode: 1 });
VendorSchema.index({ CardName: 1 });
VendorSchema.index({ email: 1 });
VendorSchema.index({ productCategories: 1 });
VendorSchema.index({ isActive: 1, isPreferred: -1 });
VendorSchema.index({ 'performanceMetrics.qualityRating': -1 });
VendorSchema.index({ lastOrderDate: -1 });

// Virtual for vendor reliability score
VendorSchema.virtual('reliabilityScore').get(function () {
    const metrics = this.performanceMetrics;

    // Calculate composite score (0-100)
    const deliveryScore = metrics.onTimeDeliveryRate || 0;
    const qualityScore = ((metrics.qualityRating || 0) / 5) * 100;
    const responseScore = Math.max(0, 100 - (metrics.responseTime / 48) * 100);
    const orderCountScore = Math.min(100, (metrics.totalOrders || 0) * 2);

    const compositeScore = (
        deliveryScore * 0.3 +
        qualityScore * 0.3 +
        responseScore * 0.2 +
        orderCountScore * 0.2
    );

    return Math.round(compositeScore);
});

// Virtual for days since last order
VendorSchema.virtual('daysSinceLastOrder').get(function () {
    if (!this.lastOrderDate) return null;

    const now = new Date();
    const lastOrder = new Date(this.lastOrderDate);
    const diffTime = now - lastOrder;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    return diffDays;
});

// Instance method to update performance metrics
VendorSchema.methods.updatePerformanceMetrics = function (orderData) {
    const metrics = this.performanceMetrics;

    // Update order counts and values
    metrics.totalOrders = (metrics.totalOrders || 0) + 1;
    metrics.totalOrderValue = (metrics.totalOrderValue || 0) + (orderData.orderValue || 0);
    metrics.averageOrderValue = metrics.totalOrderValue / metrics.totalOrders;

    // Update last order date
    this.lastOrderDate = new Date();

    return this.save();
};

// Instance method to check if vendor can supply product category
VendorSchema.methods.canSupplyCategory = function (category) {
    if (!this.productCategories || this.productCategories.length === 0) {
        return true; // If no categories specified, assume can supply anything
    }

    return this.productCategories.some(
        cat => cat.toLowerCase().includes(category.toLowerCase())
    );
};

// Instance method to get vendor summary
VendorSchema.methods.getSummary = function () {
    return {
        code: this.CardCode,
        name: this.CardName,
        email: this.email,
        phone: this.phone,
        city: this.city,
        country: this.country,
        isActive: this.isActive,
        isPreferred: this.isPreferred,
        reliabilityScore: this.reliabilityScore,
        categories: this.productCategories,
        certifications: this.certifications,
        totalOrders: this.performanceMetrics.totalOrders,
        qualityRating: this.performanceMetrics.qualityRating,
        daysSinceLastOrder: this.daysSinceLastOrder,
    };
};

// Static method to find preferred vendors by category
VendorSchema.statics.findPreferredByCategory = function (category) {
    return this.find({
        isActive: true,
        isPreferred: true,
        productCategories: { $regex: category, $options: 'i' },
    }).sort({ 'performanceMetrics.qualityRating': -1 });
};

// Static method to find vendors by reliability
VendorSchema.statics.findByReliability = function (minScore = 70) {
    return this.find({
        isActive: true,
    }).then(vendors => {
        return vendors
            .filter(v => v.reliabilityScore >= minScore)
            .sort((a, b) => b.reliabilityScore - a.reliabilityScore);
    });
};

// Static method to find inactive vendors (no orders in last 180 days)
VendorSchema.statics.findInactive = function (days = 180) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    return this.find({
        $or: [
            { lastOrderDate: { $lt: cutoffDate } },
            { lastOrderDate: { $exists: false } },
        ],
        isActive: true,
    });
};

// Pre-save middleware to update computed fields
VendorSchema.pre('save', function (next) {
    // Update average order value
    if (this.performanceMetrics.totalOrders > 0) {
        this.performanceMetrics.averageOrderValue =
            this.performanceMetrics.totalOrderValue / this.performanceMetrics.totalOrders;
    }

    next();
});

// Ensure virtuals are included in JSON
VendorSchema.set('toJSON', { virtuals: true });
VendorSchema.set('toObject', { virtuals: true });

// Create and export model
const Vendor = mongoose.model('Vendor', VendorSchema);

module.exports = Vendor;