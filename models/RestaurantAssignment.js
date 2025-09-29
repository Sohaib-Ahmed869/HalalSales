const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const RestaurantAssignmentSchema = new Schema({
    restaurant: {
        type: Schema.Types.ObjectId,
        ref: 'Restaurant',
        required: true
    },
    assignedAgent: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    assignedBy: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    status: {
        type: String,
        enum: ['pending', 'contacted', 'interested', 'not_interested', 'callback_scheduled', 'closed_won', 'closed_lost'],
        default: 'pending'
    },
    priority: {
        type: String,
        enum: ['low', 'medium', 'high'],
        default: 'medium'
    },
    notes: [{
        content: String,
        addedBy: { type: Schema.Types.ObjectId, ref: 'User' },
        addedAt: { type: Date, default: Date.now },
        type: { type: String, enum: ['call', 'email', 'meeting', 'general'], default: 'general' }
    }],
    contactAttempts: { type: Number, default: 0 },
    lastContactDate: Date,
    nextFollowUpDate: Date,
    assignedAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

RestaurantAssignmentSchema.index({ assignedAgent: 1, status: 1 });
RestaurantAssignmentSchema.index({ restaurant: 1 }, { unique: true });

module.exports = mongoose.model('RestaurantAssignment', RestaurantAssignmentSchema);