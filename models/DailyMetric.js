// models/DailyMetric.js
// Standalone model to store daily aggregated metrics per user and channel

const mongoose = require('mongoose');

const KeyNumberMap = {
	type: Map,
	of: Number,
	default: {}
};

const DailyMetricSchema = new mongoose.Schema({
	user_id: { type: String, index: true },
	user: { type: String }, // e.g., agent email
	date: { type: String, index: true }, // YYYY-MM-DD

	// Aggregated counters
	messages_sent: { type: Number, default: 0 },
	messages_responded: { type: Number, default: 0 },
	conversations_handled: { type: Number, default: 0 },
	time_spent_minutes: { type: Number, default: 0 },

	// Per channel breakdowns
	messages_sent_by_channel: KeyNumberMap,
	time_spent_by_channel: KeyNumberMap
}, { timestamps: true });

module.exports = mongoose.model('DailyMetric', DailyMetricSchema);


