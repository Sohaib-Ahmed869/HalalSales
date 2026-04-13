// whatsappAdmin.controller.js
const WhatsAppMessage = require("../models/WhatsAppMessage");
const WhatsAppContact = require("../models/WhatsAppContact");
const User = require("../models/User");

const whatsappAdminController = {

    // ── Overview stats across all agents ─────────────────────────────────────
    getAdminStats: async (req, res) => {
        try {
            const { startDate, endDate } = req.query;
            const dateFilter = {};
            if (startDate && endDate) {
                dateFilter.timestamp = {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate),
                };
            }

            const [msgStats] = await WhatsAppMessage.aggregate([
                { $match: dateFilter },
                {
                    $group: {
                        _id: null,
                        totalMessages: { $sum: 1 },
                        sentMessages: { $sum: { $cond: [{ $eq: ["$direction", "outbound"] }, 1, 0] } },
                        receivedMessages: { $sum: { $cond: [{ $eq: ["$direction", "inbound"] }, 1, 0] } },
                        unreadMessages: {
                            $sum: {
                                $cond: [
                                    { $and: [{ $eq: ["$direction", "inbound"] }, { $ne: ["$status", "read"] }] },
                                    1, 0,
                                ],
                            },
                        },
                        failedMessages: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
                    },
                },
            ]);

            const totalContacts = await WhatsAppContact.countDocuments({});
            const totalAgents = await User.countDocuments({ "whatsappSettings.enabled": true });

            const activeConversations = await WhatsAppMessage.distinct("conversationId", {
                timestamp: { $gte: new Date(Date.now() - 86400000) },
            }).then((ids) => ids.length);

            // Overall call stats
            const [callOverview] = await WhatsAppMessage.aggregate([
                { $match: { messageType: "call", ...dateFilter } },
                {
                    $group: {
                        _id: null,
                        totalCalls: { $sum: 1 },
                        outboundCalls: { $sum: { $cond: [{ $eq: ["$content.callDirection", "outbound"] }, 1, 0] } },
                        inboundCalls: { $sum: { $cond: [{ $eq: ["$content.callDirection", "inbound"] }, 1, 0] } },
                        answeredCalls: { $sum: { $cond: [{ $in: ["$content.callStatus", ["ended", "active"]] }, 1, 0] } },
                        missedCalls: { $sum: { $cond: [{ $eq: ["$content.callStatus", "missed"] }, 1, 0] } },
                        failedCalls: { $sum: { $cond: [{ $eq: ["$content.callStatus", "failed"] }, 1, 0] } },
                        totalDuration: { $sum: { $ifNull: ["$content.duration", 0] } },
                        avgDuration: { $avg: { $cond: [{ $gt: ["$content.duration", 0] }, "$content.duration", null] } },
                    },
                },
            ]);

            // Per-agent breakdown (messages + calls)
            const agentBreakdown = await WhatsAppMessage.aggregate([
                { $match: { salesAgent: { $exists: true, $ne: null }, ...dateFilter } },
                {
                    $group: {
                        _id: "$salesAgent",
                        sent: { $sum: { $cond: [{ $and: [{ $eq: ["$direction", "outbound"] }, { $ne: ["$messageType", "call"] }] }, 1, 0] } },
                        received: { $sum: { $cond: [{ $and: [{ $eq: ["$direction", "inbound"] }, { $ne: ["$messageType", "call"] }] }, 1, 0] } },
                        unread: {
                            $sum: {
                                $cond: [
                                    { $and: [{ $eq: ["$direction", "inbound"] }, { $ne: ["$status", "read"] }, { $ne: ["$messageType", "call"] }] },
                                    1, 0,
                                ],
                            },
                        },
                        totalCalls: { $sum: { $cond: [{ $eq: ["$messageType", "call"] }, 1, 0] } },
                        answeredCalls: { $sum: { $cond: [{ $and: [{ $eq: ["$messageType", "call"] }, { $in: ["$content.callStatus", ["ended", "active"]] }] }, 1, 0] } },
                        missedCalls: { $sum: { $cond: [{ $and: [{ $eq: ["$messageType", "call"] }, { $eq: ["$content.callStatus", "missed"] }] }, 1, 0] } },
                        totalCallDuration: { $sum: { $cond: [{ $eq: ["$messageType", "call"] }, { $ifNull: ["$content.duration", 0] }, 0] } },
                        avgCallDuration: { $avg: { $cond: [{ $and: [{ $eq: ["$messageType", "call"] }, { $gt: ["$content.duration", 0] }] }, "$content.duration", null] } },
                        lastActivity: { $max: "$timestamp" },
                    },
                },
                { $sort: { lastActivity: -1 } },
            ]);

            // Hydrate agent names
            const agentIds = agentBreakdown.map((a) => a._id);
            const agents = await User.find({ _id: { $in: agentIds } })
                .select("firstName lastName phone email")
                .lean();
            const agentMap = Object.fromEntries(agents.map((a) => [a._id.toString(), a]));

            const agentStats = agentBreakdown.map((a) => ({
                agentId: a._id,
                agent: agentMap[a._id.toString()] || { firstName: "Unknown", lastName: "" },
                sent: a.sent,
                received: a.received,
                unread: a.unread,
                lastActivity: a.lastActivity,
                calls: {
                    total: a.totalCalls || 0,
                    answered: a.answeredCalls || 0,
                    missed: a.missedCalls || 0,
                    totalDuration: a.totalCallDuration || 0,
                    avgDuration: Math.round(a.avgCallDuration || 0),
                    answerRate: a.totalCalls > 0 ? Math.round((a.answeredCalls / a.totalCalls) * 100) : 0,
                },
            }));

            // Daily volume for last 7 days
            const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
            const dailyVolume = await WhatsAppMessage.aggregate([
                { $match: { timestamp: { $gte: sevenDaysAgo } } },
                {
                    $group: {
                        _id: {
                            $dateToString: { format: "%Y-%m-%d", date: "$timestamp" },
                        },
                        sent: { $sum: { $cond: [{ $eq: ["$direction", "outbound"] }, 1, 0] } },
                        received: { $sum: { $cond: [{ $eq: ["$direction", "inbound"] }, 1, 0] } },
                    },
                },
                { $sort: { _id: 1 } },
            ]);

            const defaultCallOverview = {
                totalCalls: 0, outboundCalls: 0, inboundCalls: 0,
                answeredCalls: 0, missedCalls: 0, failedCalls: 0,
                totalDuration: 0, avgDuration: 0,
            };
            const callData = callOverview ? { ...defaultCallOverview, ...callOverview, _id: undefined } : defaultCallOverview;
            callData.answerRate = callData.totalCalls > 0
                ? Math.round((callData.answeredCalls / callData.totalCalls) * 100)
                : 0;

            return res.status(200).json({
                success: true,
                data: {
                    overview: {
                        ...(msgStats || {
                            totalMessages: 0,
                            sentMessages: 0,
                            receivedMessages: 0,
                            unreadMessages: 0,
                            failedMessages: 0,
                        }),
                        totalContacts,
                        totalAgents,
                        activeConversations,
                    },
                    callOverview: callData,
                    agentStats,
                    dailyVolume,
                },
            });
        } catch (error) {
            return res.status(500).json({ error: "Error fetching admin stats", details: error.message });
        }
    },

    // ── All conversations across every agent ──────────────────────────────────
    getAllConversations: async (req, res) => {
        try {
            const {
                page = 1,
                limit = 20,
                agentId,
                unreadOnly,
                search,
                sortBy = "lastMessage",
            } = req.query;

            const matchFilter = {};
            if (agentId) matchFilter.salesAgent = require("mongoose").Types.ObjectId(agentId);
            if (unreadOnly === "true") {
                matchFilter.direction = "inbound";
                matchFilter.status = { $ne: "read" };
            }

            const skip = (parseInt(page) - 1) * parseInt(limit);

            const conversations = await WhatsAppMessage.aggregate([
                { $match: matchFilter },
                { $sort: { timestamp: -1 } },
                {
                    $group: {
                        _id: "$conversationId",
                        lastMessage: { $first: "$$ROOT" },
                        unreadCount: {
                            $sum: {
                                $cond: [
                                    { $and: [{ $eq: ["$direction", "inbound"] }, { $ne: ["$status", "read"] }] },
                                    1, 0,
                                ],
                            },
                        },
                        totalMessages: { $sum: 1 },
                        salesAgent: { $first: "$salesAgent" },
                    },
                },
                { $sort: { "lastMessage.timestamp": -1 } },
                { $skip: skip },
                { $limit: parseInt(limit) },
            ]);

            // Hydrate contact + agent info
            const hydrated = await Promise.all(
                conversations.map(async (conv) => {
                    const contact = await WhatsAppContact.findOne({
                        phoneNumber: conv._id,
                    }).lean();

                    const agent = conv.salesAgent
                        ? await User.findById(conv.salesAgent)
                            .select("firstName lastName phone email")
                            .lean()
                        : null;

                    // Apply search filter after hydration
                    if (search) {
                        const q = search.toLowerCase();
                        const nameMatch = (contact?.name || "").toLowerCase().includes(q);
                        const phoneMatch = (conv._id || "").includes(q);
                        const agentMatch = agent
                            ? `${agent.firstName} ${agent.lastName}`.toLowerCase().includes(q)
                            : false;
                        if (!nameMatch && !phoneMatch && !agentMatch) return null;
                    }

                    return {
                        ...conv,
                        contact: contact || {
                            phoneNumber: conv._id,
                            name: conv.lastMessage?.metadata?.profileName || conv._id,
                        },
                        agent,
                    };
                })
            );

            const filtered = hydrated.filter(Boolean);
            const total = await WhatsAppMessage.distinct("conversationId", matchFilter).then(
                (ids) => ids.length
            );

            return res.status(200).json({
                success: true,
                data: filtered,
                pagination: {
                    total,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    pages: Math.ceil(total / parseInt(limit)),
                },
            });
        } catch (error) {
            return res.status(500).json({ error: "Error fetching conversations", details: error.message });
        }
    },

    // ── Messages for any conversation (admin view — no agent filter) ──────────
    getConversationMessages: async (req, res) => {
        try {
            const { phoneNumber } = req.params;
            const { page = 1, limit = 50 } = req.query;
            const skip = (parseInt(page) - 1) * parseInt(limit);

            const messages = await WhatsAppMessage.find({ conversationId: phoneNumber })
                .sort({ timestamp: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .lean();

            const total = await WhatsAppMessage.countDocuments({ conversationId: phoneNumber });

            const contact = await WhatsAppContact.findOne({ phoneNumber }).lean();

            const agentId = messages.find((m) => m.salesAgent)?.salesAgent;
            const agent = agentId
                ? await User.findById(agentId).select("firstName lastName phone email").lean()
                : null;

            return res.status(200).json({
                success: true,
                data: messages.reverse(),
                contact: contact || {
                    phoneNumber,
                    name: messages[0]?.metadata?.profileName || "Unknown",
                },
                agent,
                pagination: {
                    total,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    pages: Math.ceil(total / parseInt(limit)),
                },
            });
        } catch (error) {
            return res.status(500).json({ error: "Error fetching messages", details: error.message });
        }
    },

    // ── List all agents with WhatsApp enabled ─────────────────────────────────
    getAgentsList: async (req, res) => {
        try {
            const agents = await User.find({ "whatsappSettings.enabled": true })
                .select("firstName lastName phone email whatsappSettings")
                .lean();
            return res.status(200).json({ success: true, data: agents });
        } catch (error) {
            return res.status(500).json({ error: "Error fetching agents", details: error.message });
        }
    },

    // ── Reassign conversation to different agent ───────────────────────────────
    reassignConversation: async (req, res) => {
        try {
            const { conversationId } = req.params;
            const { agentId } = req.body;
            if (!agentId) return res.status(400).json({ error: "agentId required" });

            await WhatsAppMessage.updateMany(
                { conversationId },
                { $set: { salesAgent: agentId } }
            );

            await WhatsAppContact.findOneAndUpdate(
                { phoneNumber: conversationId },
                { $set: { salesAgent: agentId } }
            );

            return res.status(200).json({ success: true });
        } catch (error) {
            return res.status(500).json({ error: "Error reassigning conversation", details: error.message });
        }
    },
};

module.exports = whatsappAdminController;