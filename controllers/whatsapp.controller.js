const WhatsAppMessage = require("../models/WhatsAppMessage");
const WhatsAppContact = require("../models/WhatsAppContact");
const User = require("../models/User");
const axios = require("axios");
const crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { v4: uuidv4 } = require("uuid");
const { emitNewMessage, emitMessageStatus } = require("../socket");
const { resolveAgentForConversation } = require("./whatsappAgent.controller");

const findAgentByPhone = async (phoneNumberId) => {
    const agent = await User.findOne({
        "whatsappSettings.phoneNumberId": phoneNumberId,
        "whatsappSettings.enabled": true,
    });
    return agent;
};

const WHATSAPP_API_URL = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}`;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

// ── S3 client (reused across all media uploads) ──────────────────────────────
const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
});

const whatsappController = {

    // ── Webhook verification (GET) ────────────────────────────────────────────
    verifyWebhook: (req, res) => {
        const mode = req.query["hub.mode"];
        const token = req.query["hub.verify_token"];
        const challenge = req.query["hub.challenge"];

        if (mode === "subscribe" && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
            console.log("Webhook verified successfully!");
            return res.status(200).send(challenge);
        } else {
            return res.status(403).json({ error: "Verification failed" });
        }
    },

    // ── Webhook handler (POST) ────────────────────────────────────────────────
    handleWebhook: async (req, res) => {
        try {
            if (!whatsappController.verifySignature(req)) {
                return res.status(401).json({ error: "Invalid signature" });
            }

            const body = req.body;

            // Respond to Meta immediately before async processing
            res.status(200).send("EVENT_RECEIVED");

            if (body.object === "whatsapp_business_account") {
                for (const entry of body.entry) {
                    for (const change of entry.changes) {
                        if (change.field === "messages") {
                            await whatsappController.processMessage(change.value);
                        }
                    }
                }
            }
        } catch (error) {
            console.error("Webhook handling error:", error);
            res.status(200).send("ERROR");
        }
    },

    // ── Signature verification using raw body buffer ──────────────────────────
    // Uses req.rawBody (set by express.json verify in app.js) to avoid
    // JSON.stringify key-order mismatches that break media webhook signatures.
    verifySignature: (req) => {
        const signature = req.headers["x-hub-signature-256"];
        if (!signature) return false;

        const payload = req.rawBody || Buffer.from(JSON.stringify(req.body));

        const expectedSignature = crypto
            .createHmac("sha256", process.env.WHATSAPP_APP_SECRET)
            .update(payload)
            .digest("hex");

        return signature === `sha256=${expectedSignature}`;
    },

    // ── Process incoming webhook value ────────────────────────────────────────
    processMessage: async (value) => {
        try {
            const { messages, statuses, contacts, metadata } = value;

            if (statuses) {
                for (const status of statuses) {
                    await whatsappController.updateMessageStatus(status);
                }
            }

            if (messages) {
                for (const message of messages) {
                    const contact = contacts?.find((c) => c.wa_id === message.from);
                    await whatsappController.saveIncomingMessage(message, contact, metadata);
                }
            }
        } catch (error) {
            console.error("Error processing message:", error);
        }
    },

    // ── Save incoming message to DB ───────────────────────────────────────────
    saveIncomingMessage: async (message, contact, metadata) => {
        try {
            const agent = await findAgentByPhone(metadata?.phone_number_id || PHONE_NUMBER_ID);
            const messageType = message.type;
            const content = {};

            switch (messageType) {
                case "text":
                    content.text = message.text.body;
                    break;

                case "image":
                case "video":
                case "audio":
                case "document":
                case "sticker":
                    content.mediaId = message[messageType].id;
                    content.mimeType = message[messageType].mime_type;
                    content.caption = message[messageType].caption;
                    if (messageType === "document") {
                        content.filename = message[messageType].filename;
                    }
                    // Download from Meta and re-upload to S3 for a permanent URL
                    content.mediaUrl = await whatsappController.getMediaUrl(message[messageType].id);
                    break;

                case "location":
                    content.latitude = message.location.latitude;
                    content.longitude = message.location.longitude;
                    content.locationName = message.location.name;
                    content.locationAddress = message.location.address;
                    break;

                case "contacts":
                    content.contacts = message.contacts;
                    break;

                case "interactive":
                    content.interactive = message.interactive;
                    break;

                case "reaction":
                    content.reaction = message.reaction;
                    break;
            }

            const messageFrom = "+" + message.from.replace(/\D/g, "");

            const newMessage = new WhatsAppMessage({
                messageId: message.id,
                conversationId: messageFrom,
                from: messageFrom,
                to: metadata?.phone_number_id || PHONE_NUMBER_ID,
                direction: "inbound",
                messageType,
                content,
                status: "delivered",
                timestamp: new Date(parseInt(message.timestamp) * 1000),
                salesAgent: agent?._id || null,
                salesAgentPhone: agent?.phone || null,
                metadata: {
                    profileName: contact?.profile?.name,
                    waId: contact?.wa_id,
                    isForwarded: message.context?.forwarded,
                    context: message.context
                        ? { messageId: message.context.id, from: message.context.from }
                        : null,
                },
            });

            await newMessage.save();

            if (agent) {
                await User.findByIdAndUpdate(agent._id, {
                    $inc: { "whatsappSettings.totalMessagesReceived": 1 },
                    $set: { "whatsappSettings.lastMessageAt": new Date() },
                });

                await WhatsAppContact.findOneAndUpdate(
                    { phoneNumber: messageFrom, salesAgent: agent._id },
                    {
                        $set: {
                            name: contact?.profile?.name || messageFrom,
                            lastMessageAt: new Date(),
                            "metadata.waId": contact?.wa_id,
                        },
                        $inc: { totalMessages: 1 },
                    },
                    { upsert: true, setDefaultsOnInsert: true }
                );

                emitNewMessage(String(agent._id), newMessage.toObject());
            } else {
                // Agent not found via phoneNumberId — try resolving from conversation history
                const fallbackAgentId = await resolveAgentForConversation(messageFrom);
                if (fallbackAgentId) {
                    emitNewMessage(String(fallbackAgentId), newMessage.toObject());
                }
            }

            console.log(`[Webhook] Message ${message.id} saved (type: ${messageType})`);
        } catch (error) {
            if (error.code === 11000) {
                console.log(`[Webhook] Message ${message.id} already exists — skipping`);
            } else {
                console.error("[Webhook] Error saving message:", error);
            }
        }
    },

    // ── Update message delivery/read status ───────────────────────────────────
    updateMessageStatus: async (status) => {
        try {
            const msg = await WhatsAppMessage.findOneAndUpdate(
                { messageId: status.id },
                {
                    $set: { status: status.status },
                    $push: {
                        statusUpdates: {
                            status: status.status,
                            timestamp: new Date(parseInt(status.timestamp) * 1000),
                            errorCode: status.errors?.[0]?.code,
                            errorMessage: status.errors?.[0]?.title,
                        },
                    },
                },
                { new: true }
            );

            if (msg) {
                if (msg.salesAgent) {
                    emitMessageStatus(String(msg.salesAgent), {
                        messageId: status.id,
                        status: status.status,
                        conversationId: msg.conversationId,
                    });
                }
                console.log(`[Webhook] Message ${status.id} → ${status.status}`);
            }
        } catch (error) {
            console.error("[Webhook] Error updating status:", error);
        }
    },

    // ── Get media from Meta and upload to S3 ──────────────────────────────────
    // Meta's signed media URLs expire within minutes, so we download immediately
    // and store a permanent S3 URL instead.
    getMediaUrl: async (mediaId) => {
        try {
            // Step 1: Get the temporary signed URL + mime type from Meta
            const metaResponse = await axios.get(`${WHATSAPP_API_URL}/${mediaId}`, {
                headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
            });
            const tempUrl = metaResponse.data.url;
            const mimeType = metaResponse.data.mime_type || "application/octet-stream";

            // Step 2: Download actual media bytes from Meta
            const mediaResponse = await axios.get(tempUrl, {
                headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
                responseType: "arraybuffer",
            });

            // Step 3: Upload to S3
            const ext = mimeType.split("/")[1]?.split(";")[0] || "bin";
            const key = `whatsapp-inbound/${uuidv4()}.${ext}`;

            await s3.send(new PutObjectCommand({
                Bucket: process.env.AWS_S3_BUCKET,
                Key: key,
                Body: Buffer.from(mediaResponse.data),
                ContentType: mimeType,
                ACL: "public-read",
            }));

            const s3Url = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
            console.log(`[Media] ${mediaId} → S3: ${s3Url}`);
            return s3Url;

        } catch (error) {
            console.error("Error downloading/uploading media:", error.response?.data || error.message);
            return null;
        }
    },

    // ── Send text message ─────────────────────────────────────────────────────
    sendTextMessage: async (req, res) => {
        try {
            const { to, message, replyToMessageId } = req.body;
            if (!to || !message) return res.status(400).json({ error: "Missing required fields" });

            const payload = {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to,
                type: "text",
                text: { preview_url: true, body: message },
            };
            if (replyToMessageId) payload.context = { message_id: replyToMessageId };

            const response = await axios.post(
                `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
                payload,
                { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
            );

            const newMessage = new WhatsAppMessage({
                messageId: response.data.messages[0].id,
                conversationId: to,
                from: PHONE_NUMBER_ID,
                to,
                direction: "outbound",
                messageType: "text",
                content: { text: message },
                status: "sent",
                metadata: { context: replyToMessageId ? { messageId: replyToMessageId } : null },
            });
            await newMessage.save();

            return res.status(200).json({
                success: true,
                messageId: response.data.messages[0].id,
                data: newMessage,
            });
        } catch (error) {
            console.error("Error sending text message:", error.response?.data || error);
            return res.status(500).json({
                error: "Error sending message",
                details: error.response?.data || error.message,
            });
        }
    },

    // ── Send media message ────────────────────────────────────────────────────
    sendMediaMessage: async (req, res) => {
        try {
            const { to, mediaType, mediaUrl, caption, filename } = req.body;
            if (!to || !mediaType || !mediaUrl) return res.status(400).json({ error: "Missing required fields" });

            const payload = {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to,
                type: mediaType,
                [mediaType]: { link: mediaUrl },
            };
            if (caption && ["image", "video", "document"].includes(mediaType)) {
                payload[mediaType].caption = caption;
            }
            if (filename && mediaType === "document") {
                payload[mediaType].filename = filename;
            }

            const response = await axios.post(
                `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
                payload,
                { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
            );

            const newMessage = new WhatsAppMessage({
                messageId: response.data.messages[0].id,
                conversationId: to,
                from: PHONE_NUMBER_ID,
                to,
                direction: "outbound",
                messageType: mediaType,
                content: { mediaUrl, caption, filename },
                status: "sent",
            });
            await newMessage.save();

            return res.status(200).json({
                success: true,
                messageId: response.data.messages[0].id,
                data: newMessage,
            });
        } catch (error) {
            console.error("Error sending media message:", error.response?.data || error);
            return res.status(500).json({
                error: "Error sending media message",
                details: error.response?.data || error.message,
            });
        }
    },

    // ── Send template message ─────────────────────────────────────────────────
    sendTemplateMessage: async (req, res) => {
        try {
            const { to, templateName, languageCode, components } = req.body;
            if (!to || !templateName || !languageCode) return res.status(400).json({ error: "Missing required fields" });

            const payload = {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to,
                type: "template",
                template: { name: templateName, language: { code: languageCode } },
            };
            if (components) payload.template.components = components;

            const response = await axios.post(
                `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
                payload,
                { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
            );

            const newMessage = new WhatsAppMessage({
                messageId: response.data.messages[0].id,
                conversationId: to,
                from: PHONE_NUMBER_ID,
                to,
                direction: "outbound",
                messageType: "template",
                content: { template: { name: templateName, language: languageCode, components } },
                status: "sent",
            });
            await newMessage.save();

            return res.status(200).json({
                success: true,
                messageId: response.data.messages[0].id,
                data: newMessage,
            });
        } catch (error) {
            console.error("Error sending template message:", error.response?.data || error);
            return res.status(500).json({
                error: "Error sending template message",
                details: error.response?.data || error.message,
            });
        }
    },

    // ── Get conversation messages ─────────────────────────────────────────────
    getConversation: async (req, res) => {
        try {
            const { phoneNumber } = req.params;
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 50;
            const skip = (page - 1) * limit;

            const messages = await WhatsAppMessage.find({
                $or: [{ from: phoneNumber }, { to: phoneNumber }],
            }).sort({ timestamp: -1 }).skip(skip).limit(limit).lean();

            const total = await WhatsAppMessage.countDocuments({
                $or: [{ from: phoneNumber }, { to: phoneNumber }],
            });

            return res.status(200).json({
                data: messages.reverse(),
                pagination: { total, page, limit, pages: Math.ceil(total / limit) },
            });
        } catch (error) {
            console.error("Error fetching conversation:", error);
            return res.status(500).json({ error: "Error fetching conversation", details: error.message });
        }
    },

    // ── Get all conversations ─────────────────────────────────────────────────
    getAllConversations: async (req, res) => {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 20;
            const skip = (page - 1) * limit;

            const conversations = await WhatsAppMessage.aggregate([
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
                    },
                },
                { $sort: { "lastMessage.timestamp": -1 } },
                { $skip: skip },
                { $limit: limit },
            ]);

            const total = await WhatsAppMessage.distinct("conversationId").then(ids => ids.length);

            return res.status(200).json({
                data: conversations,
                pagination: { total, page, limit, pages: Math.ceil(total / limit) },
            });
        } catch (error) {
            console.error("Error fetching conversations:", error);
            return res.status(500).json({ error: "Error fetching conversations", details: error.message });
        }
    },

    // ── Mark message as read ──────────────────────────────────────────────────
    markAsRead: async (req, res) => {
        try {
            const { messageId } = req.params;

            await axios.post(
                `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
                { messaging_product: "whatsapp", status: "read", message_id: messageId },
                { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
            );

            await WhatsAppMessage.findOneAndUpdate({ messageId }, { status: "read" });

            return res.status(200).json({ success: true, message: "Message marked as read" });
        } catch (error) {
            console.error("Error marking message as read:", error);
            return res.status(500).json({ error: "Error marking message as read", details: error.message });
        }
    },
};

module.exports = whatsappController;