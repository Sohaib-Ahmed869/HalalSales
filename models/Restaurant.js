// models/Restaurant.js
const mongoose = require('mongoose');

const menuItemSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true
    },
    description: {
        type: String,
        default: 'N/A'
    },
    price: {
        type: String,
        default: 'N/A'
    },
    rating: {
        type: String,
        default: 'N/A'
    }
}, { _id: false });

const contactInfoSchema = new mongoose.Schema({
    email: {
        type: String,
        default: 'N/A'
    },
    phone: {
        type: String,
        default: 'N/A'
    },
    address: {
        type: String,
        default: 'N/A'
    }
}, { _id: false });

const restaurantSchema = new mongoose.Schema({
    url: {
        type: String,
        required: true,
        unique: true
    },
    name: {
        type: String,
        required: true
    },
    postal_code: {
        type: String,
        required: true,
        index: true
    },
    menu_items: [menuItemSchema],
    menu_items_count: {
        type: Number,
        default: 0
    },
    contact_info: contactInfoSchema,
    scraped_at: {
        type: Date,
        default: Date.now
    },
    scraper_version: {
        type: String,
        default: 'ultra_fast_v1'
    },
    // Additional metadata
    status: {
        type: String,
        enum: ['active', 'inactive', 'failed'],
        default: 'active'
    },
    last_updated: {
        type: Date,
        default: Date.now
    }
}, {
    timestamps: true
});

// Indexes for better performance
restaurantSchema.index({ postal_code: 1, scraped_at: -1 });
restaurantSchema.index({ name: 'text', 'menu_items.title': 'text' });

// Virtual for menu items with prices
restaurantSchema.virtual('menuItemsWithPrices').get(function () {
    return this.menu_items.filter(item => item.price !== 'N/A');
});

// Virtual for average price calculation
restaurantSchema.virtual('averagePrice').get(function () {
    const itemsWithPrices = this.menu_items.filter(item => {
        const price = item.price;
        return price !== 'N/A' && price.match(/\d+[,\.]\d+/);
    });

    if (itemsWithPrices.length === 0) return 0;

    const total = itemsWithPrices.reduce((sum, item) => {
        const priceMatch = item.price.match(/(\d+)[,\.](\d+)/);
        if (priceMatch) {
            return sum + parseFloat(`${priceMatch[1]}.${priceMatch[2]}`);
        }
        return sum;
    }, 0);

    return total / itemsWithPrices.length;
});

module.exports = mongoose.model('Restaurant', restaurantSchema);