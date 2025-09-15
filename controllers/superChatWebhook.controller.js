// controllers/superChatWebhook.controller.js

const axios = require('axios');
const DailyMetric = require('../models/DailyMetric');
const ConversationAssignment = require('../models/ConversationAssignment');
const ChannelUserMapping = require('../models/ChannelUserMapping');
const superChatConfig = require('../services/superChatConfig');

function pad2(n) { return n.toString().padStart(2, '0'); }
function toYMD(date) {
	const d = new Date(date);
	return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}
function ymdFromString(input) {
	if (!input) return toYMD(new Date());
	const m = String(input).match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
	if (!m) return toYMD(new Date(input));
	const y = Number(m[1]);
	const mo = Number(m[2]);
	const da = Number(m[3]);
	return `${y}-${pad2(mo)}-${pad2(da)}`;
}
function deriveChannelType(channel) {
	const id = channel?.id || channel;
	const type = channel?.type || '';
	const s = String(id || '').toLowerCase();
	if (type) return type;
	if (s.includes('wa') || s.includes('whats')) return 'whats_app';
	if (s.includes('ig') || s.includes('insta')) return 'instagram';
	if (s.includes('fb')) return 'facebook_messenger';
	return 'unknown';
}

function getAuthHeaders() {
	const headers = { 'Content-Type': 'application/json' };
	if (superChatConfig.api.apiKey) {
		headers[superChatConfig.api.authMethod] = superChatConfig.api.apiKey;
	}
	return headers;
}

const api = axios.create({
	baseURL: superChatConfig.api.baseUrl,
	timeout: superChatConfig.api.timeoutMs,
	headers: getAuthHeaders()
});

async function refreshUsersAndChannels() {
	// Build channel -> inbox -> users mapping
	const usersResp = await api.get('/users');
	const channelsResp = await api.get('/channels');
	const users = usersResp.data?.results || usersResp.data || [];
	const channels = channelsResp.data?.results || channelsResp.data || [];

	const inboxToUserIds = {};
	for (const u of users) {
		(u.inbox_ids || []).forEach(inboxId => {
			inboxToUserIds[inboxId] = inboxToUserIds[inboxId] || [];
			inboxToUserIds[inboxId].push(u.id);
		});
	}

	for (const ch of channels) {
		const inboxId = ch.inbox?.id || ch.inbox_id;
		const userIds = inboxId ? (inboxToUserIds[inboxId] || []) : [];
		await ChannelUserMapping.updateOne(
			{ channel_id: ch.id },
			{ $set: { channel_id: ch.id, inbox_id: inboxId || null, user_ids: userIds, updated_at: new Date() } },
			{ upsert: true }
		);
	}

	return { usersCount: users.length, channelsCount: channels.length };
}

async function fetchConversationAssignment(conversationId) {
	try {
		const resp = await api.get(`/conversations/${conversationId}`);
		const conv = resp.data?.data || resp.data || {};
		const assignedUserId = conv.assigned_user_id || conv.assigned_user?.id || (Array.isArray(conv.assigned_users) && conv.assigned_users[0]) || null;
		const channelId = conv.channel?.id || conv.channel_id || null;
		if (assignedUserId) {
			await ConversationAssignment.updateOne(
				{ conversation_id: conversationId },
				{ $set: { assigned_user_id: assignedUserId, channel_id: channelId, updated_at: new Date() } },
				{ upsert: true }
			);
		}
		return { assignedUserId, channelId };
	} catch (err) {
		console.error('❌ [Webhook] fetchConversationAssignment error:', err.response?.data || err.message);
		return { assignedUserId: null, channelId: null };
	}
}

async function upsertDailyMetric({ userId, userEmail, channelType, at, inc }) {
	const date = ymdFromString(at ? toYMD(at) : toYMD(new Date()));
	const setOnInsert = { date, user_id: userId, user: userEmail || userId };
	const update = { $setOnInsert: setOnInsert, $inc: {} };
	if (inc && typeof inc === 'object') {
		for (const [k,v] of Object.entries(inc)) update.$inc[k] = v;
	}
	if (channelType && (inc?.messages_sent || 0) > 0) {
		update.$inc[`messages_sent_by_channel.${channelType}`] = (update.$inc[`messages_sent_by_channel.${channelType}`] || 0) + inc.messages_sent;
	}
	await DailyMetric.updateOne({ user_id: userId, date }, update, { upsert: true });
}

async function handleWebhook(req, res) {
	try {
		const event = req.body?.event || req.body?.type || 'unknown';
		console.log('📨 [Webhook] Event received:', event);

		if (event === 'message_outbound') {
			const msg = req.body.message || req.body.data || {};
			const conversationId = msg.conversation_id;
			const channelId = msg.from?.channel_id || msg.channel_id;
			const createdAt = msg.created_at || new Date().toISOString();
			console.log('✉️  [Webhook] Outbound message:', { conversationId, channelId, createdAt });

			let assignment = await ConversationAssignment.findOne({ conversation_id: conversationId }).lean();
			if (!assignment) {
				console.log('🔄 [Webhook] Assignment not cached. Fetching conversation details...');
				const fetched = await fetchConversationAssignment(conversationId);
				assignment = { conversation_id: conversationId, assigned_user_id: fetched.assignedUserId, channel_id: fetched.channelId };
			}

			let userId = assignment?.assigned_user_id || null;
			const channelType = deriveChannelType(channelId);
			if (!userId) {
				const mapping = await ChannelUserMapping.findOne({ channel_id: channelId }).lean();
				if (mapping?.user_ids?.length === 1) userId = mapping.user_ids[0];
			}

			if (!userId) userId = 'unassigned';
			await upsertDailyMetric({ userId, channelType, at: createdAt, inc: { messages_sent: 1 } });
			console.log('✅ [Webhook] Metric upserted for user:', userId, 'date:', ymdFromString(createdAt));
		}

		if (event === 'conversation_assigned') {
			const data = req.body.data || req.body.conversation || {};
			const conversationId = data.conversation_id || data.id;
			const assignedUserId = data.assigned_user_id || data.assigned_user?.id;
			const channelId = data.channel_id || data.channel?.id;
			console.log('👤 [Webhook] Conversation assigned:', { conversationId, assignedUserId });
			if (conversationId && assignedUserId) {
				await ConversationAssignment.updateOne(
					{ conversation_id: conversationId },
					{ $set: { assigned_user_id: assignedUserId, channel_id: channelId, updated_at: new Date() } },
					{ upsert: true }
				);
			}
		}

		res.status(200).json({ ok: true });
	} catch (err) {
		console.error('❌ [Webhook] Handler error:', err.response?.data || err.message);
		res.status(200).json({ ok: false });
	}
}

async function syncDirectory(req, res) {
	try {
		const result = await refreshUsersAndChannels();
		res.json({ ok: true, ...result });
	} catch (err) {
		console.error('❌ [Webhook] syncDirectory error:', err.response?.data || err.message);
		res.status(500).json({ ok: false, error: err.message });
	}
}

async function backfillConversations(req, res) {
	try {
		const limit = Math.min(parseInt(req.query.limit || '500', 10), 1000);
		const startDate = req.query.start_date ? ymdFromString(req.query.start_date) : null;
		const endDate = req.query.end_date ? ymdFromString(req.query.end_date) : null;
		console.log('🔁 [Backfill] Starting conversations backfill', { limit, startDate, endDate });

		const usersResp = await api.get('/users');
		const channelsResp = await api.get('/channels');
		const users = usersResp.data?.results || usersResp.data || [];
		const channels = channelsResp.data?.results || channelsResp.data || [];
		const emailToUserId = {};
		users.forEach(u => { if (u.email) emailToUserId[String(u.email).toLowerCase()] = u.id; });
		const channelInfo = {};
		channels.forEach(ch => {
			channelInfo[ch.id] = {
				id: ch.id,
				type: ch.type,
				email: ch.email_address || null,
				inbox_id: ch.inbox?.id || null
			};
		});
		console.log('📚 [Backfill] Preloaded users:', users.length, 'channels:', channels.length);

		let fetched = 0;
		let after = null;
		let created = 0;
		let updated = 0;
		let upserts = 0;
		let assignedViaConversation = 0;
		let assignedViaChannelOwner = 0;
		let assignedUnassigned = 0;
		const seenConvIds = new Set();

		while (fetched < limit) {
			const params = { limit: Math.min(100, limit - fetched) };
			if (after) params.after = after;
			const resp = await api.get('/conversations', { params });
			const results = resp.data?.results || resp.data?.data || resp.data || [];
			if (!Array.isArray(results) || results.length === 0) break;

			for (const conv of results) {
				if (fetched >= limit) break;
				const id = conv.id || conv.conversation_id;
				if (!id || seenConvIds.has(id)) continue;
				seenConvIds.add(id);
				fetched++;

				const createdAt = conv.created_at || conv.createdAt || conv.time_window?.open_until || new Date().toISOString();
				const ymd = ymdFromString(createdAt);
				if (startDate && ymd < startDate) continue;
				if (endDate && ymd > endDate) continue;

				let assignedUserId = (Array.isArray(conv.assigned_users) && conv.assigned_users[0]) || conv.assigned_user_id || conv.assigned_user?.id || null;
				let chId = conv.channel?.id || conv.channel_id || null;
				if (!assignedUserId) {
					const det = await fetchConversationAssignment(id);
					assignedUserId = det.assignedUserId || null;
					chId = chId || det.channelId || null;
					if (assignedUserId) assignedViaConversation++;
				}
				if (!assignedUserId && chId && channelInfo[chId]?.email) {
					const ownerEmail = String(channelInfo[chId].email).toLowerCase();
					assignedUserId = emailToUserId[ownerEmail] || null;
					if (assignedUserId) assignedViaChannelOwner++;
				}
				if (!assignedUserId) {
					assignedUserId = 'unassigned';
					assignedUnassigned++;
				}

				const r = await ConversationAssignment.updateOne(
					{ conversation_id: id },
					{ $set: { assigned_user_id: assignedUserId, channel_id: chId || null, updated_at: new Date() } },
					{ upsert: true }
				);
				if (r.upsertedCount) created++; else if (r.modifiedCount) updated++;

				await DailyMetric.updateOne(
					{ user_id: assignedUserId, date: ymd },
					{ $setOnInsert: { user_id: assignedUserId, user: assignedUserId, date: ymd }, $inc: { conversations_handled: 1 } },
					{ upsert: true }
				);
				upserts++;
			}

			after = resp.data?.pagination?.next_cursor || resp.data?.next_cursor || null;
			if (!after) break;
		}

		console.log('✅ [Backfill] Completed', { fetched, created, updated, upserts, assignedViaConversation, assignedViaChannelOwner, assignedUnassigned });
		res.json({ ok: true, fetched, created, updated, upserts, assignedViaConversation, assignedViaChannelOwner, assignedUnassigned });
	} catch (err) {
		console.error('❌ [Backfill] Error:', err.response?.data || err.message);
		res.status(500).json({ ok: false, error: err.message });
	}
}

async function listUsers(req, res) {
	try {
		const resp = await api.get('/users');
		const results = resp.data?.results || resp.data || [];
		console.log('👥 [Users] Fetched users:', results.length);
		const slim = results.map(u => ({ id: u.id, email: u.email, first_name: u.first_name, last_name: u.last_name, role: u.role }));
		res.json({ ok: true, total: results.length, users: slim, raw: results });
	} catch (err) {
		console.error('❌ [Users] Error:', err.response?.data || err.message);
		res.status(500).json({ ok: false, error: err.message });
	}
}

async function fetchConversationMessagesMeta(conversationId) {
	try {
		const resp = await api.get(`/conversations/${conversationId}/messages`, { params: { limit: 200 } });
		const messages = resp.data?.results || resp.data?.data || resp.data || [];
		return Array.isArray(messages) ? messages : [];
	} catch (err) {
		return [];
	}
}

async function fetchConversationDetail(conversationId) {
	try {
		const resp = await api.get(`/conversations/${conversationId}`);
		return resp.data?.data || resp.data || null;
	} catch (err) {
		return null;
	}
}

function computeTimingFromMessages(messages) {
	if (!messages || messages.length === 0) return { handlingMs: null, firstReplyMs: null };
	const sorted = messages
		.map(m => ({
			createdAt: new Date(m.created_at || m.createdAt || m.timestamp || m.date || Date.now()).getTime(),
			direction: (m.direction || '').toLowerCase(),
			sender: (m.sender?.type || m.sender_type || '').toLowerCase()
		}))
		.filter(m => !Number.isNaN(m.createdAt))
		.sort((a,b) => a.createdAt - b.createdAt);
	if (sorted.length === 0) return { handlingMs: null, firstReplyMs: null };
	const first = sorted[0].createdAt;
	const last = sorted[sorted.length - 1].createdAt;
	const handlingMs = Math.max(0, last - first);
	const firstInbound = sorted.find(m => m.direction === 'inbound' || m.sender === 'contact' || m.sender === 'customer');
	let firstReplyMs = null;
	if (firstInbound) {
		const firstOutbound = sorted.find(m => (m.direction === 'outbound' || m.sender === 'user' || m.sender === 'agent') && m.createdAt > firstInbound.createdAt);
		if (firstOutbound) firstReplyMs = Math.max(0, firstOutbound.createdAt - firstInbound.createdAt);
	}
	return { handlingMs, firstReplyMs };
}

function computeTimingFromDetail(detail) {
	if (!detail) return { handlingMs: null, firstReplyMs: null, messagesCount: null };
	// Heuristics using conversation detail fields if available
	const firstTs = detail.first_message_at || detail.created_at || detail.createdAt || detail.time_window?.open_until || null;
	const lastTs = detail.last_message_at || detail.updated_at || detail.updatedAt || null;
	const handlingMs = (firstTs && lastTs) ? Math.max(0, new Date(lastTs) - new Date(firstTs)) : null;
	// Many APIs expose first_reply_at or similar; if not, we can't get firstReplyMs without messages
	const firstReplyTs = detail.first_reply_at || detail.first_agent_reply_at || null;
	const firstInboundTs = detail.first_customer_message_at || firstTs;
	const firstReplyMs = (firstReplyTs && firstInboundTs) ? Math.max(0, new Date(firstReplyTs) - new Date(firstInboundTs)) : null;
	const messagesCount = detail.messages_count || detail.message_count || null;
	return { handlingMs, firstReplyMs, messagesCount };
}

function pLimit(concurrency) {
	let active = 0;
	const queue = [];
	const next = () => {
		active--;
		if (queue.length) queue.shift()();
	};
	return fn => new Promise((resolve, reject) => {
		const run = () => {
			active++;
			fn().then((v)=>{ resolve(v); next(); }).catch((e)=>{ reject(e); next(); });
		};
		if (active < concurrency) run(); else queue.push(run);
	});
}

async function getConversationsByInbox(req, res) {
	try {
		const totalLimit = Math.min(parseInt(req.query.limit || '100', 10), 2000);
		const pageLimit = Math.min(parseInt(req.query.pageLimit || '100', 10), 200);
		const startDate = req.query.start_date ? ymdFromString(req.query.start_date) : null;
		const endDate = req.query.end_date ? ymdFromString(req.query.end_date) : null;
		const mode = String(req.query.mode || 'balanced');
		const initialAfter = req.query.after || null;
		const inboxFilter = req.query.inbox_id || null;
		const CONCURRENCY = Number(process.env.SUPERCHAT_CONCURRENCY || 6);
		console.log('🗂️  [ByInbox] Conversations aggregate', { totalLimit, pageLimit, startDate, endDate, mode, CONCURRENCY, initialAfter, inboxFilter });

		let channelsMap = {};
		try {
			const chResp = await api.get('/channels');
			const channels = chResp.data?.results || chResp.data || [];
			channels.forEach(ch => { channelsMap[ch.id] = ch; });
			console.log('📡 [ByInbox] Channels fetched for enrichment:', channels.length);
		} catch (e) {
			console.warn('⚠️  [ByInbox] Channels enrichment skipped:', e.response?.data || e.message);
		}

		const byInbox = new Map();
		let fetched = 0;
		let after = initialAfter;
		let lastNextCursor = null;

		while (fetched < totalLimit) {
			// SuperChat hard limit is 100 per page; enforce here to avoid 400s
			const perPage = Math.min(100, pageLimit, totalLimit - fetched);
			const params = { limit: perPage };
			if (after) params.after = after;
			const convResp = await api.get('/conversations', { params });
			const conversations = convResp.data?.results || convResp.data?.data || convResp.data || [];
			if (!Array.isArray(conversations) || conversations.length === 0) break;

			const limitRun = pLimit(CONCURRENCY);
			const timingTasks = [];

			for (const c of conversations) {
				if (fetched >= totalLimit) break;
				const ts = c.created_at || c.createdAt || c.time_window?.open_until || null;
				const ymd = ts ? ymdFromString(ts) : null;
				if (startDate && ymd && ymd < startDate) continue;
				if (endDate && ymd && ymd > endDate) continue;

				const inboxId = c.inbox?.id || 'unknown_inbox';
				if (inboxFilter && inboxId !== inboxFilter) continue;

				fetched++;
				const inboxName = c.inbox?.name || 'Unknown';
				const chId = c.channel?.id || null;
				const ch = chId ? channelsMap[chId] : null;
				const chEmail = ch?.email_address || null;
				const chName = ch?.name || ch?.email_address || ch?.phone_number || c.channel?.type || 'Channel';
				const chType = c.channel?.type || ch?.type || 'unknown';
				if (!byInbox.has(inboxId)) {
					byInbox.set(inboxId, { inbox_id: inboxId, inbox_name: inboxName, emails: new Set(), total_conversations: 0, channels: new Map() });
				}
				const agg = byInbox.get(inboxId);
				agg.total_conversations += 1;
				if (chEmail) agg.emails.add(String(chEmail).toLowerCase());
				if (chId) {
					if (!agg.channels.has(chId)) {
						agg.channels.set(chId, { channel_id: chId, channel_name: chName, channel_type: chType, total_conversations: 0, timing: { totalHandlingMs: 0, countHandling: 0, totalFirstReplyMs: 0, countFirstReply: 0 } });
					}
					const chAgg = agg.channels.get(chId);
					chAgg.total_conversations += 1;

					timingTasks.push(limitRun(async () => {
						const detail = await fetchConversationDetail(c.id);
						const { handlingMs: detHandling, firstReplyMs: detFirst } = computeTimingFromDetail(detail || {});
						let handlingMs = detHandling;
						let firstReplyMs = detFirst;
						if (mode !== 'fast' && (handlingMs === null || firstReplyMs === null)) {
							const msgs = await fetchConversationMessagesMeta(c.id);
							const calc = computeTimingFromMessages(msgs);
							if (handlingMs === null) handlingMs = calc.handlingMs;
							if (firstReplyMs === null) firstReplyMs = calc.firstReplyMs;
						}
						if (handlingMs !== null) { chAgg.timing.totalHandlingMs += handlingMs; chAgg.timing.countHandling += 1; }
						if (firstReplyMs !== null) { chAgg.timing.totalFirstReplyMs += firstReplyMs; chAgg.timing.countFirstReply += 1; }
					}));
				}
			}

			await Promise.allSettled(timingTasks);

			lastNextCursor = convResp.data?.pagination?.next_cursor || convResp.data?.next_cursor || null;
			after = lastNextCursor;
			if (!after) break;
		}

		const result = Array.from(byInbox.values()).map(v => ({
			inbox_id: v.inbox_id,
			inbox_name: v.inbox_name,
			emails: Array.from(v.emails),
			total_conversations: v.total_conversations,
			channels: Array.from(v.channels.values()).map(ch => ({
				channel_id: ch.channel_id,
				channel_name: ch.channel_name,
				channel_type: ch.channel_type,
				total_conversations: ch.total_conversations,
				avg_handling_ms: ch.timing.countHandling ? Math.round(ch.timing.totalHandlingMs / ch.timing.countHandling) : null,
				avg_first_reply_ms: ch.timing.countFirstReply ? Math.round(ch.timing.totalFirstReplyMs / ch.timing.countFirstReply) : null
			})).sort((a,b) => b.total_conversations - a.total_conversations)
		}));

		result.sort((a,b) => b.total_conversations - a.total_conversations);

		res.json({ ok: true, total_inboxes: result.length, items: result, fetched, next_cursor: lastNextCursor, has_more: !!lastNextCursor });
	} catch (err) {
		const status = err.response?.status;
		const data = err.response?.data;
		console.error('❌ [ByInbox] Error:', status, data || err.message);
		res.status(500).json({ ok: false, error: status ? `${status}` : err.message, details: data || undefined });
	}
}

module.exports = {
	handleWebhook,
	syncDirectory,
	backfillConversations,
	listUsers,
	getConversationsByInbox
};


