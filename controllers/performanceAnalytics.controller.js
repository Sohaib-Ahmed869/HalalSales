// controllers/performanceAnalytics.controller.js
// Standalone performance analytics controller for SuperChat integration
// NOTE: This file is self-contained and does not modify existing controllers

const DailyMetric = require('../models/DailyMetric');

function pad2(n) { return String(n).padStart(2, '0'); }
function ymdFromString(input) {
	if (!input) {
		const d = new Date();
		return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
	}
	const s = String(input).trim();
	const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
	if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
	const d = new Date(s);
	return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}

/**
 * Compute overall progress score (0-100)
 * Simple weighted heuristic: messages_sent (40%), responded_to (40%), conversations (20%)
 */
function computeProgress(totalMessages, totalResponded, totalConversations) {
	const weights = { messages: 0.4, responded: 0.4, conversations: 0.2 };
	const scoreMessages = Math.min(totalMessages / 100, 1) * 100;
	const scoreResponded = Math.min(totalResponded / 100, 1) * 100;
	const scoreConversations = Math.min(totalConversations / 50, 1) * 100;
	const overall = (scoreMessages * weights.messages)
		+ (scoreResponded * weights.responded)
		+ (scoreConversations * weights.conversations);
	return Math.round(overall);
}

/**
 * GET /api/analytics/performance
 * Query params: user_id (optional), start_date (optional), end_date (optional)
 */
async function getPerformanceAnalytics(req, res) {
	try {
		console.log('📈 [Performance] Incoming query params:', JSON.stringify(req.query));
		const { user_id: userId } = req.query;
		const startStr = ymdFromString(req.query.start_date);
		const endStr = ymdFromString(req.query.end_date);
		console.log('📅 [Performance] Date range (YMD):', { start: startStr, end: endStr });

		// Build Mongo filter
		const filter = { date: { $gte: startStr, $lte: endStr } };
		if (userId) filter.user_id = userId;
		console.log('🧭 [Performance] Mongo filter:', JSON.stringify(filter));

		// Quick existence checks
		const totalCount = await DailyMetric.estimatedDocumentCount().catch(() => 0);
		console.log(`📚 [Performance] DailyMetric total docs: ${totalCount}`);
		const quickCount = await DailyMetric.countDocuments(filter);
		console.log(`🔎 [Performance] DailyMetric.countDocuments(filter) = ${quickCount}`);
		const distinctUsersInRange = await DailyMetric.distinct('user_id', filter);
		console.log('👥 [Performance] Distinct users (range):', distinctUsersInRange);
		const distinctDatesInRange = await DailyMetric.distinct('date', filter);
		console.log('📆 [Performance] Distinct dates (range):', distinctDatesInRange);

		// Sample first 5 docs in-range
		const sampleInRange = await DailyMetric.find(filter).limit(5).lean();
		console.log('🧪 [Performance] First 5 in-range docs (trimmed):', sampleInRange.map(d => ({
			user_id: d.user_id, date: d.date, messages_sent: d.messages_sent, conversations_handled: d.conversations_handled
		})));

		// Tally by date
		const perDate = {};
		sampleInRange.forEach(d => {
			perDate[d.date] = perDate[d.date] || { msgs: 0, convs: 0 };
			perDate[d.date].msgs += d.messages_sent || 0;
			perDate[d.date].convs += d.conversations_handled || 0;
		});
		console.log('📊 [Performance] Tally (sample) per date:', perDate);

		// Fetch rows for date range (aggregate in Node)
		const rows = await DailyMetric.find(filter).lean();
		console.log(`📦 [Performance] Rows fetched for aggregation: ${rows.length}`);
		if (rows.length > 0) {
			const sample = rows[0];
			console.log('🧪 [Performance] Sample row keys:', Object.keys(sample));
			console.log('🧪 [Performance] Sample row (trimmed):', JSON.stringify({
				user_id: sample.user_id,
				user: sample.user,
				date: sample.date,
				messages_sent: sample.messages_sent,
				messages_responded: sample.messages_responded,
				conversations_handled: sample.conversations_handled,
				time_spent_minutes: sample.time_spent_minutes
			}));
		} else {
			console.log('⚠️ [Performance] No rows in range. Verify date range and that DailyMetric has data for those days.');
		}

		// Aggregate in Node
		const byUser = new Map();
		for (const row of rows) {
			const key = row.user_id || 'unknown';
			if (!byUser.has(key)) {
				byUser.set(key, {
					user: row.user || key,
					total_messages_sent: 0,
					total_responded_to: 0,
					total_conversations: 0,
					total_time_spent: 0,
					messages_sent_by_channel: {},
					total_time_spent_by_channel: {}
				});
			}
			const agg = byUser.get(key);
			agg.total_messages_sent += row.messages_sent || 0;
			agg.total_responded_to += row.messages_responded || 0;
			agg.total_conversations += row.conversations_handled || 0;
			agg.total_time_spent += row.time_spent_minutes || 0;
			if (row.messages_sent_by_channel) {
				for (const [ch, val] of Object.entries(row.messages_sent_by_channel)) {
					agg.messages_sent_by_channel[ch] = (agg.messages_sent_by_channel[ch] || 0) + (val || 0);
				}
			}
			if (row.time_spent_by_channel) {
				for (const [ch, val] of Object.entries(row.time_spent_by_channel)) {
					agg.total_time_spent_by_channel[ch] = (agg.total_time_spent_by_channel[ch] || 0) + (val || 0);
				}
			}
		}
		console.log('🧮 [Performance] Users aggregated:', byUser.size);

		const users = Array.from(byUser.values()).map(u => ({
			user: u.user,
			total_messages_sent: u.total_messages_sent,
			total_responded_to: u.total_responded_to,
			total_time_spent_by_channel: u.total_time_spent_by_channel,
			messages_sent_by_channel: u.messages_sent_by_channel,
			total_conversations: u.total_conversations,
			total_time_spent: u.total_time_spent,
			overall_progress: computeProgress(u.total_messages_sent, u.total_responded_to, u.total_conversations)
		}));
		console.log('📊 [Performance] Response users count:', users.length);
		if (users.length > 0) {
			console.log('📊 [Performance] First user (trimmed):', JSON.stringify({
				user: users[0].user,
				total_messages_sent: users[0].total_messages_sent,
				total_responded_to: users[0].total_responded_to,
				total_conversations: users[0].total_conversations
			}));
		}

		return res.status(200).json({
			date_range: { start: startStr, end: endStr },
			users
		});

	} catch (error) {
		console.error('❌ [Performance] Error:', error);
		return res.status(500).json({
			success: false,
			message: 'Failed to compute performance analytics',
			error: error.message
		});
	}
}

module.exports = {
	getPerformanceAnalytics
};


