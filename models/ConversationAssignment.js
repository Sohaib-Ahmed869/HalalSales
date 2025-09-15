// models/ConversationAssignment.js

const mongoose = require('mongoose');

const ConversationAssignmentSchema = new mongoose.Schema({
	conversation_id: { type: String, index: true, unique: true },
	assigned_user_id: { type: String, index: true },
	channel_id: { type: String, index: true },
	updated_at: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('ConversationAssignment', ConversationAssignmentSchema);


