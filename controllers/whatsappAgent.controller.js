const WhatsAppMessage = require("../models/WhatsAppMessage");
const WhatsAppContact = require("../models/WhatsAppContact");
const User = require("../models/User");
const axios = require("axios");

const WHATSAPP_API_URL = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}`;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

const whatsappAgentController = {
    // Get agent's WhatsApp settings
    getAgentSettings: async (req, res) => {
        try {
            const agentId = req.user.id;
            const agent = await User.findById(agentId).select("whatsappSettings phone firstName lastName");

            if (!agent) {
                return res.status(404).json({ error: "Agent not found" });
            }

            return res.status(200).json({
                success: true,
                data: agent,
            });
        } catch (error) {
            console.error("Error fetching agent settings:", error);
            return res.status(500).json({
                error: "Error fetching settings",
                details: error.message,
            });
        }
    },

    // Update agent's WhatsApp settings (admin only)
    updateAgentSettings: async (req, res) => {
        try {
            const { agentId } = req.params;
            const { enabled, phoneNumberId, businessAccountId, verifiedName } = req.body;

            const agent = await User.findById(agentId);
            if (!agent) {
                return res.status(404).json({ error: "Agent not found" });
            }

            agent.whatsappSettings = {
                ...agent.whatsappSettings,
                enabled,
                phoneNumberId,
                businessAccountId,
                verifiedName,
            };

            await agent.save();

            return res.status(200).json({
                success: true,
                message: "Settings updated successfully",
                data: agent.whatsappSettings,
            });
        } catch (error) {
            console.error("Error updating settings:", error);
            return res.status(500).json({
                error: "Error updating settings",
                details: error.message,
            });
        }
    },

    // Get agent's contacts
    getContacts: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { search, tags, isFavorite, isCustomer, page = 1, limit = 50 } = req.query;

            const filter = { salesAgent: agentId, isBlocked: false };

            if (search) {
                filter.$or = [
                    { name: new RegExp(search, "i") },
                    { phoneNumber: new RegExp(search, "i") },
                    { company: new RegExp(search, "i") },
                ];
            }

            if (tags) {
                filter.tags = { $in: tags.split(",") };
            }

            if (isFavorite !== undefined) {
                filter.isFavorite = isFavorite === "true";
            }

            if (isCustomer !== undefined) {
                filter.isCustomer = isCustomer === "true";
            }

            const skip = (page - 1) * limit;

            const contacts = await WhatsAppContact.find(filter)
                .sort({ lastMessageAt: -1, createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .lean();

            const total = await WhatsAppContact.countDocuments(filter);

            // Get unread message count for each contact
            const contactsWithUnread = await Promise.all(
                contacts.map(async (contact) => {
                    const unreadCount = await WhatsAppMessage.countDocuments({
                        from: contact.phoneNumber,
                        salesAgent: agentId,
                        direction: "inbound",
                        status: { $ne: "read" },
                    });

                    return {
                        ...contact,
                        unreadCount,
                    };
                })
            );

            return res.status(200).json({
                success: true,
                data: contactsWithUnread,
                pagination: {
                    total,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    pages: Math.ceil(total / limit),
                },
            });
        } catch (error) {
            console.error("Error fetching contacts:", error);
            return res.status(500).json({
                error: "Error fetching contacts",
                details: error.message,
            });
        }
    },

    // Add or update contact
    saveContact: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { phoneNumber, name, company, email, tags, notes, isFavorite } = req.body;

            if (!phoneNumber || !name) {
                return res.status(400).json({ error: "Phone number and name are required" });
            }

            const contact = await WhatsAppContact.findOneAndUpdate(
                { phoneNumber, salesAgent: agentId },
                {
                    name,
                    company,
                    email,
                    tags: tags || [],
                    notes,
                    isFavorite: isFavorite || false,
                },
                { upsert: true, new: true }
            );

            return res.status(200).json({
                success: true,
                message: "Contact saved successfully",
                data: contact,
            });
        } catch (error) {
            console.error("Error saving contact:", error);
            return res.status(500).json({
                error: "Error saving contact",
                details: error.message,
            });
        }
    },

    // Delete contact
    deleteContact: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { contactId } = req.params;

            await WhatsAppContact.findOneAndDelete({
                _id: contactId,
                salesAgent: agentId,
            });

            return res.status(200).json({
                success: true,
                message: "Contact deleted successfully",
            });
        } catch (error) {
            console.error("Error deleting contact:", error);
            return res.status(500).json({
                error: "Error deleting contact",
                details: error.message,
            });
        }
    },

    // Get agent's conversations
    getAgentConversations: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { page = 1, limit = 20, unreadOnly } = req.query;

            const agent = await User.findById(agentId).select("phone whatsappSettings");
            if (!agent || !agent.whatsappSettings?.enabled) {
                return res.status(403).json({ error: "WhatsApp not enabled for this agent" });
            }

            const skip = (page - 1) * limit;

            // Get all unique conversation IDs for this agent
            const matchFilter = {
                $or: [
                    { salesAgent: agentId },
                    { salesAgentPhone: agent.phone },
                ],
            };

            if (unreadOnly === "true") {
                matchFilter.direction = "inbound";
                matchFilter.status = { $ne: "read" };
            }

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
                                    {
                                        $and: [
                                            { $eq: ["$direction", "inbound"] },
                                            { $ne: ["$status", "read"] },
                                        ],
                                    },
                                    1,
                                    0,
                                ],
                            },
                        },
                        totalMessages: { $sum: 1 },
                    },
                },
                { $sort: { "lastMessage.timestamp": -1 } },
                { $skip: skip },
                { $limit: parseInt(limit) },
            ]);

            // Get contact info for each conversation
            const conversationsWithContacts = await Promise.all(
                conversations.map(async (conv) => {
                    const contact = await WhatsAppContact.findOne({
                        phoneNumber: conv._id,
                        salesAgent: agentId,
                    }).lean();

                    return {
                        ...conv,
                        contact: contact || {
                            phoneNumber: conv._id,
                            name: conv.lastMessage.metadata?.profileName || "Unknown",
                        },
                    };
                })
            );

            const total = await WhatsAppMessage.distinct("conversationId", matchFilter).then(
                (ids) => ids.length
            );

            return res.status(200).json({
                success: true,
                data: conversationsWithContacts,
                pagination: {
                    total,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    pages: Math.ceil(total / limit),
                },
            });
        } catch (error) {
            console.error("Error fetching conversations:", error);
            return res.status(500).json({
                error: "Error fetching conversations",
                details: error.message,
            });
        }
    },

    // Get conversation messages
    getConversationMessages: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { phoneNumber } = req.params;
            const { page = 1, limit = 50 } = req.query;

            const skip = (page - 1) * limit;

            const messages = await WhatsAppMessage.find({
                salesAgent: agentId,
                $or: [{ from: phoneNumber }, { to: phoneNumber }],
            })
                .sort({ timestamp: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .lean();

            const total = await WhatsAppMessage.countDocuments({
                salesAgent: agentId,
                $or: [{ from: phoneNumber }, { to: phoneNumber }],
            });

            // Get contact info
            const contact = await WhatsAppContact.findOne({
                phoneNumber,
                salesAgent: agentId,
            }).lean();

            return res.status(200).json({
                success: true,
                data: messages.reverse(),
                contact: contact || {
                    phoneNumber,
                    name: messages[0]?.metadata?.profileName || "Unknown",
                },
                pagination: {
                    total,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    pages: Math.ceil(total / limit),
                },
            });
        } catch (error) {
            console.error("Error fetching messages:", error);
            return res.status(500).json({
                error: "Error fetching messages",
                details: error.message,
            });
        }
    },

    // Send message as agent
    sendMessage: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { to, message, messageType = "text", mediaUrl, replyToMessageId } = req.body;

            if (!to) {
                return res.status(400).json({ error: "Recipient phone number is required" });
            }

            const agent = await User.findById(agentId).select("whatsappSettings phone firstName lastName");
            if (!agent || !agent.whatsappSettings?.enabled) {
                return res.status(403).json({ error: "WhatsApp not enabled for this agent" });
            }

            const phoneNumberId = agent.whatsappSettings.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;

            let payload = {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to,
            };

            if (messageType === "text") {
                if (!message) {
                    return res.status(400).json({ error: "Message text is required" });
                }
                payload.type = "text";
                payload.text = {
                    preview_url: true,
                    body: message,
                };
            } else if (["image", "video", "audio", "document"].includes(messageType)) {
                if (!mediaUrl) {
                    return res.status(400).json({ error: "Media URL is required" });
                }
                payload.type = messageType;
                payload[messageType] = {
                    link: mediaUrl,
                };
                if (message) {
                    payload[messageType].caption = message;
                }
            }

            if (replyToMessageId) {
                payload.context = { message_id: replyToMessageId };
            }

            const response = await axios.post(
                `${WHATSAPP_API_URL}/${phoneNumberId}/messages`,
                payload,
                {
                    headers: {
                        Authorization: `Bearer ${ACCESS_TOKEN}`,
                        "Content-Type": "application/json",
                    },
                }
            );

            // Save message to database
            const newMessage = new WhatsAppMessage({
                messageId: response.data.messages[0].id,
                conversationId: to,
                from: phoneNumberId,
                to,
                direction: "outbound",
                messageType,
                content: messageType === "text" ? { text: message } : { mediaUrl, caption: message },
                status: "sent",
                salesAgent: agentId,
                salesAgentPhone: agent.phone,
                metadata: {
                    context: replyToMessageId ? { messageId: replyToMessageId } : null,
                },
            });

            await newMessage.save();

            // Update agent stats
            await User.findByIdAndUpdate(agentId, {
                $inc: { "whatsappSettings.totalMessagesSent": 1 },
                $set: { "whatsappSettings.lastMessageAt": new Date() },
            });

            // Update or create contact
            await WhatsAppContact.findOneAndUpdate(
                { phoneNumber: to, salesAgent: agentId },
                {
                    $inc: { totalMessages: 1 },
                    $set: { lastMessageAt: new Date() },
                },
                { upsert: true, setDefaultsOnInsert: true }
            );

            return res.status(200).json({
                success: true,
                messageId: response.data.messages[0].id,
                data: newMessage,
            });
        } catch (error) {
            console.error("Error sending message:", error.response?.data || error);
            return res.status(500).json({
                error: "Error sending message",
                details: error.response?.data || error.message,
            });
        }
    },

    // Mark messages as read
    markAsRead: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { messageId, phoneNumber } = req.body;

            const agent = await User.findById(agentId).select("whatsappSettings");
            if (!agent || !agent.whatsappSettings?.enabled) {
                return res.status(403).json({ error: "WhatsApp not enabled" });
            }

            const phoneNumberId = agent.whatsappSettings.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;

            if (messageId) {
                // Mark specific message as read
                await axios.post(
                    `${WHATSAPP_API_URL}/${phoneNumberId}/messages`,
                    {
                        messaging_product: "whatsapp",
                        status: "read",
                        message_id: messageId,
                    },
                    {
                        headers: {
                            Authorization: `Bearer ${ACCESS_TOKEN}`,
                            "Content-Type": "application/json",
                        },
                    }
                );

                await WhatsAppMessage.findOneAndUpdate(
                    { messageId, salesAgent: agentId },
                    { status: "read" }
                );
            } else if (phoneNumber) {
                // Mark all messages from this contact as read
                await WhatsAppMessage.updateMany(
                    {
                        from: phoneNumber,
                        salesAgent: agentId,
                        direction: "inbound",
                        status: { $ne: "read" },
                    },
                    { status: "read" }
                );
            }

            return res.status(200).json({
                success: true,
                message: "Messages marked as read",
            });
        } catch (error) {
            console.error("Error marking as read:", error);
            return res.status(500).json({
                error: "Error marking as read",
                details: error.message,
            });
        }
    },

    // Get agent's WhatsApp statistics
    getAgentStats: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { startDate, endDate } = req.query;

            const dateFilter = {};
            if (startDate && endDate) {
                dateFilter.timestamp = {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate),
                };
            }

            const stats = await WhatsAppMessage.aggregate([
                {
                    $match: {
                        salesAgent: agentId,
                        ...dateFilter,
                    },
                },
                {
                    $group: {
                        _id: null,
                        totalMessages: { $sum: 1 },
                        sentMessages: {
                            $sum: { $cond: [{ $eq: ["$direction", "outbound"] }, 1, 0] },
                        },
                        receivedMessages: {
                            $sum: { $cond: [{ $eq: ["$direction", "inbound"] }, 1, 0] },
                        },
                        unreadMessages: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $eq: ["$direction", "inbound"] },
                                            { $ne: ["$status", "read"] },
                                        ],
                                    },
                                    1,
                                    0,
                                ],
                            },
                        },
                    },
                },
            ]);

            const totalContacts = await WhatsAppContact.countDocuments({
                salesAgent: agentId,
            });

            const activeConversations = await WhatsAppMessage.distinct("conversationId", {
                salesAgent: agentId,
                timestamp: {
                    $gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
                },
            }).then((ids) => ids.length);

            return res.status(200).json({
                success: true,
                data: {
                    ...(stats[0] || {
                        totalMessages: 0,
                        sentMessages: 0,
                        receivedMessages: 0,
                        unreadMessages: 0,
                    }),
                    totalContacts,
                    activeConversations,
                },
            });
        } catch (error) {
            console.error("Error fetching stats:", error);
            return res.status(500).json({
                error: "Error fetching statistics",
                details: error.message,
            });
        }
    },
};

module.exports = whatsappAgentController;