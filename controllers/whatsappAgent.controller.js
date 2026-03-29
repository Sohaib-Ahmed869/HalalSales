// whatsappAgentController.js  — full replacement
const WhatsAppMessage = require("../models/WhatsAppMessage");
const WhatsAppContact = require("../models/WhatsAppContact");
const User = require("../models/User");
const axios = require("axios");
const multer = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const { emitNewMessage, emitMessageStatus } = require("../socket");

// ── AWS S3 setup ─────────────────────────────────────────────────────────────
const s3 = new S3Client({
    region: "eu-north-1",
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY,
        secretAccessKey: process.env.AWS_SECRET_KEY,
    },
});

// Multer: store in memory, max 25 MB
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
});

const uploadToS3 = async (file) => {
    const ext = path.extname(file.originalname);
    const key = `whatsapp-media/${uuidv4()}${ext}`;

    await s3.send(new PutObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
        // Remove ACL if your bucket uses BucketOwnerEnforced
        ACL: "public-read",
    }));

    return `https://${process.env.AWS_S3_BUCKET}.s3.eu-north-1.amazonaws.com/${key}`;
};

const WHATSAPP_API_URL = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}`;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

// ── Helper: resolve agentId for an inbound message ───────────────────────────
// Used by the webhook controller to know which socket room to emit to.
// Export this so whatsappController.js can call it.
const resolveAgentForConversation = async (conversationId) => {
    // Try finding a message in this conversation that has a salesAgent set
    const sample = await WhatsAppMessage.findOne({
        conversationId,
        salesAgent: { $exists: true, $ne: null },
    }).lean();
    return sample?.salesAgent || null;
};

const whatsappAgentController = {

    // ── expose multer middleware so router can use it ────────────────────────
    uploadMiddleware: upload.single("file"),

    // ── Upload file to S3 and return URL ────────────────────────────────────
    uploadMedia: async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: "No file provided" });

            const url = await uploadToS3(req.file);

            // Determine WhatsApp message type from mime
            let messageType = "document";
            if (req.file.mimetype.startsWith("image/")) messageType = "image";
            else if (req.file.mimetype.startsWith("video/")) messageType = "video";
            else if (req.file.mimetype.startsWith("audio/")) messageType = "audio";

            return res.status(200).json({
                success: true,
                url,
                messageType,
                filename: req.file.originalname,
                mimetype: req.file.mimetype,
                size: req.file.size,
            });
        } catch (error) {
            console.error("S3 upload error:", error);
            return res.status(500).json({ error: "Upload failed", details: error.message });
        }
    },

    // ── Get agent settings ───────────────────────────────────────────────────
    getAgentSettings: async (req, res) => {
        try {
            const agent = await User.findById(req.user.id).select("whatsappSettings phone firstName lastName");
            if (!agent) return res.status(404).json({ error: "Agent not found" });
            return res.status(200).json({ success: true, data: agent });
        } catch (error) {
            return res.status(500).json({ error: "Error fetching settings", details: error.message });
        }
    },

    // ── Update agent settings ────────────────────────────────────────────────
    updateAgentSettings: async (req, res) => {
        try {
            const { agentId } = req.params;
            const { enabled, phoneNumberId, businessAccountId, verifiedName } = req.body;
            const agent = await User.findById(agentId);
            if (!agent) return res.status(404).json({ error: "Agent not found" });
            agent.whatsappSettings = { ...agent.whatsappSettings, enabled, phoneNumberId, businessAccountId, verifiedName };
            await agent.save();
            return res.status(200).json({ success: true, data: agent.whatsappSettings });
        } catch (error) {
            return res.status(500).json({ error: "Error updating settings", details: error.message });
        }
    },

    // ── Get contacts ─────────────────────────────────────────────────────────
    getContacts: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { search, tags, isFavorite, isCustomer, page = 1, limit = 50 } = req.query;
            const filter = { salesAgent: agentId, isBlocked: false };
            if (search) filter.$or = [
                { name: new RegExp(search, "i") },
                { phoneNumber: new RegExp(search, "i") },
                { company: new RegExp(search, "i") },
            ];
            if (tags) filter.tags = { $in: tags.split(",") };
            if (isFavorite !== undefined) filter.isFavorite = isFavorite === "true";
            if (isCustomer !== undefined) filter.isCustomer = isCustomer === "true";

            const skip = (page - 1) * limit;
            const contacts = await WhatsAppContact.find(filter)
                .sort({ lastMessageAt: -1, createdAt: -1 })
                .skip(skip).limit(parseInt(limit)).lean();
            const total = await WhatsAppContact.countDocuments(filter);

            const contactsWithUnread = await Promise.all(contacts.map(async (c) => ({
                ...c,
                unreadCount: await WhatsAppMessage.countDocuments({
                    from: c.phoneNumber, salesAgent: agentId, direction: "inbound", status: { $ne: "read" },
                }),
            })));

            return res.status(200).json({ success: true, data: contactsWithUnread, pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / limit) } });
        } catch (error) {
            return res.status(500).json({ error: "Error fetching contacts", details: error.message });
        }
    },

    // ── Save contact ─────────────────────────────────────────────────────────
    saveContact: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { phoneNumber, name, company, email, tags, notes, isFavorite } = req.body;
            if (!phoneNumber || !name) return res.status(400).json({ error: "Phone number and name are required" });
            const contact = await WhatsAppContact.findOneAndUpdate(
                { phoneNumber, salesAgent: agentId },
                { name, company, email, tags: tags || [], notes, isFavorite: isFavorite || false },
                { upsert: true, new: true }
            );
            return res.status(200).json({ success: true, data: contact });
        } catch (error) {
            return res.status(500).json({ error: "Error saving contact", details: error.message });
        }
    },

    // ── Delete contact ───────────────────────────────────────────────────────
    deleteContact: async (req, res) => {
        try {
            await WhatsAppContact.findOneAndDelete({ _id: req.params.contactId, salesAgent: req.user.id });
            return res.status(200).json({ success: true });
        } catch (error) {
            return res.status(500).json({ error: "Error deleting contact", details: error.message });
        }
    },

    // ── Get conversations ────────────────────────────────────────────────────
    getAgentConversations: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { page = 1, limit = 20, unreadOnly } = req.query;
            const agent = await User.findById(agentId).select("phone whatsappSettings");
            if (!agent?.whatsappSettings?.enabled) return res.status(403).json({ error: "WhatsApp not enabled" });

            const matchFilter = {
                $or: [{ salesAgent: agentId }, { salesAgentPhone: agent.phone }],
            };
            if (unreadOnly === "true") { matchFilter.direction = "inbound"; matchFilter.status = { $ne: "read" }; }

            const skip = (parseInt(page) - 1) * parseInt(limit);
            const conversations = await WhatsAppMessage.aggregate([
                { $match: matchFilter },
                { $sort: { timestamp: -1 } },
                { $group: { _id: "$conversationId", lastMessage: { $first: "$$ROOT" }, unreadCount: { $sum: { $cond: [{ $and: [{ $eq: ["$direction", "inbound"] }, { $ne: ["$status", "read"] }] }, 1, 0] } }, totalMessages: { $sum: 1 } } },
                { $sort: { "lastMessage.timestamp": -1 } },
                { $skip: skip },
                { $limit: parseInt(limit) },
            ]);

            const conversationsWithContacts = await Promise.all(conversations.map(async (conv) => {
                const contact = await WhatsAppContact.findOne({ phoneNumber: conv._id, salesAgent: agentId }).lean();
                return { ...conv, contact: contact || { phoneNumber: conv._id, name: conv.lastMessage.metadata?.profileName || conv._id } };
            }));

            const total = await WhatsAppMessage.distinct("conversationId", matchFilter).then(ids => ids.length);
            return res.status(200).json({ success: true, data: conversationsWithContacts, pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) } });
        } catch (error) {
            return res.status(500).json({ error: "Error fetching conversations", details: error.message });
        }
    },

    // ── Get messages for a conversation ──────────────────────────────────────
    getConversationMessages: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { phoneNumber } = req.params;
            const { page = 1, limit = 50 } = req.query;
            const skip = (parseInt(page) - 1) * parseInt(limit);

            const messages = await WhatsAppMessage.find({
                conversationId: phoneNumber,
                $or: [
                    { salesAgent: agentId },
                    { salesAgent: { $exists: false } },
                    { salesAgent: null },
                ],
            })
                .sort({ timestamp: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .lean();

            const total = await WhatsAppMessage.countDocuments({ conversationId: phoneNumber });
            const contact = await WhatsAppContact.findOne({ phoneNumber, salesAgent: agentId }).lean();

            return res.status(200).json({
                success: true,
                data: messages.reverse(),
                contact: contact || { phoneNumber, name: messages[0]?.metadata?.profileName || "Unknown" },
                pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
            });
        } catch (error) {
            return res.status(500).json({ error: "Error fetching messages", details: error.message });
        }
    },

    // ── Send message (text or media) ─────────────────────────────────────────
    sendMessage: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { to, message, messageType = "text", mediaUrl, filename, replyToMessageId } = req.body;

            if (!to) return res.status(400).json({ error: "Recipient is required" });

            const agent = await User.findById(agentId).select("whatsappSettings phone firstName lastName");
            if (!agent?.whatsappSettings?.enabled) return res.status(403).json({ error: "WhatsApp not enabled" });

            const phoneNumberId = agent.whatsappSettings.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;

            // Build WhatsApp API payload
            let payload = { messaging_product: "whatsapp", recipient_type: "individual", to };

            if (messageType === "text") {
                if (!message) return res.status(400).json({ error: "Message text required" });
                payload.type = "text";
                payload.text = { preview_url: true, body: message };
            } else if (["image", "video", "audio", "document"].includes(messageType)) {
                if (!mediaUrl) return res.status(400).json({ error: "mediaUrl required for media messages" });
                payload.type = messageType;
                payload[messageType] = { link: mediaUrl };
                if (message) payload[messageType].caption = message;
                if (filename && messageType === "document") payload[messageType].filename = filename;
            }

            if (replyToMessageId) payload.context = { message_id: replyToMessageId };

            const response = await axios.post(
                `${WHATSAPP_API_URL}/${phoneNumberId}/messages`,
                payload,
                { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
            );

            const newMessage = new WhatsAppMessage({
                messageId: response.data.messages[0].id,
                conversationId: to,
                from: phoneNumberId,
                to,
                direction: "outbound",
                messageType,
                content: messageType === "text"
                    ? { text: message }
                    : { mediaUrl, caption: message, filename },
                status: "sent",
                salesAgent: agentId,
                salesAgentPhone: agent.phone,
                metadata: { context: replyToMessageId ? { messageId: replyToMessageId } : null },
            });

            await newMessage.save();

            await User.findByIdAndUpdate(agentId, {
                $inc: { "whatsappSettings.totalMessagesSent": 1 },
                $set: { "whatsappSettings.lastMessageAt": new Date() },
            });

            await WhatsAppContact.findOneAndUpdate(
                { phoneNumber: to, salesAgent: agentId },
                { $inc: { totalMessages: 1 }, $set: { lastMessageAt: new Date() } },
                { upsert: true, setDefaultsOnInsert: true }
            );

            return res.status(200).json({ success: true, messageId: response.data.messages[0].id, data: newMessage });
        } catch (error) {
            console.error("Send message error:", error.response?.data || error.message);
            return res.status(500).json({ error: "Error sending message", details: error.response?.data || error.message });
        }
    },

    // ── Mark messages as read ────────────────────────────────────────────────
    markAsRead: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { messageId, phoneNumber } = req.body;
            const agent = await User.findById(agentId).select("whatsappSettings");
            if (!agent?.whatsappSettings?.enabled) return res.status(403).json({ error: "WhatsApp not enabled" });

            const phoneNumberId = agent.whatsappSettings.phoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID;

            if (messageId) {
                await axios.post(`${WHATSAPP_API_URL}/${phoneNumberId}/messages`,
                    { messaging_product: "whatsapp", status: "read", message_id: messageId },
                    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
                );
                await WhatsAppMessage.findOneAndUpdate({ messageId, salesAgent: agentId }, { status: "read" });
            } else if (phoneNumber) {
                await WhatsAppMessage.updateMany(
                    { from: phoneNumber, salesAgent: agentId, direction: "inbound", status: { $ne: "read" } },
                    { status: "read" }
                );
            }

            return res.status(200).json({ success: true });
        } catch (error) {
            return res.status(500).json({ error: "Error marking as read", details: error.message });
        }
    },

    // ── Stats ────────────────────────────────────────────────────────────────
    getAgentStats: async (req, res) => {
        try {
            const agentId = req.user.id;
            const { startDate, endDate } = req.query;
            const dateFilter = {};
            if (startDate && endDate) dateFilter.timestamp = { $gte: new Date(startDate), $lte: new Date(endDate) };

            const [stats] = await WhatsAppMessage.aggregate([
                { $match: { salesAgent: agentId, ...dateFilter } },
                {
                    $group: {
                        _id: null,
                        totalMessages: { $sum: 1 },
                        sentMessages: { $sum: { $cond: [{ $eq: ["$direction", "outbound"] }, 1, 0] } },
                        receivedMessages: { $sum: { $cond: [{ $eq: ["$direction", "inbound"] }, 1, 0] } },
                        unreadMessages: { $sum: { $cond: [{ $and: [{ $eq: ["$direction", "inbound"] }, { $ne: ["$status", "read"] }] }, 1, 0] } },
                    },
                },
            ]);

            const totalContacts = await WhatsAppContact.countDocuments({ salesAgent: agentId });
            const activeConversations = await WhatsAppMessage.distinct("conversationId", {
                salesAgent: agentId,
                timestamp: { $gte: new Date(Date.now() - 86400000) },
            }).then(ids => ids.length);

            return res.status(200).json({
                success: true,
                data: { ...(stats || { totalMessages: 0, sentMessages: 0, receivedMessages: 0, unreadMessages: 0 }), totalContacts, activeConversations },
            });
        } catch (error) {
            return res.status(500).json({ error: "Error fetching stats", details: error.message });
        }
    },
};

// ── Export helper for webhook controller ──────────────────────────────────────
module.exports = { ...whatsappAgentController, resolveAgentForConversation };