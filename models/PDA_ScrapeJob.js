const mongoose = require('mongoose');
const { Schema } = mongoose;

const PDA_ScrapeJobSchema = new Schema({
    sessionId: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    searchTerm: {
        type: String,
        required: true,
        trim: true,
        index: true,
    },
    numSuppliers: {
        type: Number,
        required: true,
        min: 1,
    },
    europeanOnly: {
        type: Boolean,
        default: false,
    },
    status: {
        type: String,
        enum: ['pending', 'in_progress', 'completed', 'failed', 'cancelled'],
        default: 'pending',
        index: true,
    },
    progress: {
        type: Number,
        default: 0,
        min: 0,
        max: 100,
    },
    sources: [{
        type: String,
        enum: ['europages', 'freshdi', 'globalsources', 'alibaba']
    }],
    totalSuppliersFound: {
        type: Number,
        default: 0,
    },
    startedAt: {
        type: Date,
    },
    completedAt: {
        type: Date,
    },
    error: {
        type: String,
    },
    logs: [{
        timestamp: {
            type: Date,
            default: Date.now,
        },
        level: {
            type: String,
            enum: ['info', 'warning', 'error'],
            default: 'info',
        },
        message: String,
    }],
    createdBy: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
}, {
    timestamps: true,
    collection: 'pda_scrape_jobs',
});

// Index for efficient querying
PDA_ScrapeJobSchema.index({ createdBy: 1, createdAt: -1 });
PDA_ScrapeJobSchema.index({ searchTerm: 1, status: 1 });

// Method to add log entry
PDA_ScrapeJobSchema.methods.addLog = function (level, message) {
    this.logs.push({ level, message, timestamp: new Date() });
    return this.save();
};

// Static method to find jobs by user
PDA_ScrapeJobSchema.statics.findByUser = function (userId) {
    return this.find({ createdBy: userId }).sort({ createdAt: -1 });
};

const PDA_ScrapeJob = mongoose.model('PDA_ScrapeJob', PDA_ScrapeJobSchema);

module.exports = PDA_ScrapeJob;