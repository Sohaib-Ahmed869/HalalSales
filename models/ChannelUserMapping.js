// models/ChannelUserMapping.js

const mongoose = require('mongoose');

const ChannelUserMappingSchema = new mongoose.Schema({
	channel_id: { type: String, index: true, unique: true },
	inbox_id: { type: String, index: true },
	user_ids: { type: [String], default: [] },
	updated_at: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('ChannelUserMapping', ChannelUserMappingSchema);


