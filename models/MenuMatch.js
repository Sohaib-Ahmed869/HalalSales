const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const MenuMatchSchema = new Schema({
    restaurantAssignment: {
        type: Schema.Types.ObjectId,
        ref: 'RestaurantAssignment',
        required: true
    },
    restaurant: {
        type: Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true
    },

    // NEW: Categorized menu analysis
    menuAnalysis: {
        categories: [{
            name: String, // 'Beverages', 'Pizzas', 'Desserts', 'Proteins', etc.
            items: [{
                title: String,
                description: String,
                price: String,
                frequency: Number // How many times this type appears
            }]
        }],
        summary: {
            totalItems: Number,
            uniqueCategories: Number,
            priceRange: { min: Number, max: Number, avg: Number }
        }
    },

    // NEW: Sales opportunities instead of simple matches
    salesOpportunities: [{
        category: String, // 'Current Products', 'Expansion Opportunities', 'Packaging'
        opportunityType: String, // 'exact_match', 'size_variant', 'new_product', 'packaging'

        // What they're doing
        restaurantContext: {
            menuItems: [String], // List of related menu items
            estimatedVolume: String, // 'high', 'medium', 'low'
            pricePoint: String
        },

        // What we can offer
        recommendations: [{
            inventoryItem: {
                type: Schema.Types.ObjectId,
                ref: 'Item'
            },
            productName: String,
            sizes: [String],
            unitPrice: Number,
            reasoning: String,
            priority: { type: String, enum: ['high', 'medium', 'low'] }
        }],

        estimatedValue: Number, // Potential order value
        notes: String
    }],

    // NEW: Packaging opportunities
    packagingOpportunities: [{
        menuItem: String,
        packagingType: String, // 'takeout', 'delivery', 'display'
        recommendedProducts: [{
            inventoryItem: {
                type: Schema.Types.ObjectId,
                ref: 'Item'
            },
            productName: String,
            suitableFor: String,
            specifications: String
        }]
    }],

    // Keep simplified matches for reference
    detailedMatches: [{
        restaurantMenuItem: {
            title: String,
            description: String,
            price: String,
            category: String
        },
        matchedItems: [{
            inventoryItem: {
                type: Schema.Types.ObjectId,
                ref: 'Item'
            },
            matchType: String,
            confidence: Number,
            sizes: [String]
        }],
        status: {
            type: String,
            enum: ['reviewed', 'pending'],
            default: 'pending'
        }
    }],

    // NEW: Executive summary for sales team
    executiveSummary: {
        keyFindings: [String],
        topOpportunities: [String],
        estimatedTotalValue: Number,
        recommendedActions: [String]
    },

    matchingMetadata: {
        totalRestaurantItems: Number,
        categoriesFound: Number,
        opportunitiesIdentified: Number,
        processingTime: Number,
        aiModel: String,
        matchingDate: Date,
        version: { type: String, default: '2.0' }
    },

    status: {
        type: String,
        enum: ['pending', 'in_progress', 'completed', 'needs_review'],
        default: 'pending'
    },
    createdBy: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

MenuMatchSchema.index({ restaurantAssignment: 1 });
MenuMatchSchema.index({ restaurant: 1 });

module.exports = mongoose.model('MenuMatch', MenuMatchSchema);