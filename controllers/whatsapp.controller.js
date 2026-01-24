const WhatsAppMessage = require("../models/WhatsAppMessage");
const axios = require("axios");
const crypto = require("crypto");

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

const whatsappController = {
    // Webhook verification (GET)
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

    // Webhook handler (POST) - receives messages
    handleWebhook: async (req, res) => {
        try {
            // Verify webhook signature
            const signature = req.headers["x-hub-signature-256"];
            if (!whatsappController.verifySignature(req.body, signature)) {
                return res.status(401).json({ error: "Invalid signature" });
            }

            const body = req.body;

            // Quick response to Meta
            res.status(200).send("EVENT_RECEIVED");

            // Process webhook asynchronously
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
            // Still return 200 to Meta to avoid retries
            res.status(200).send("ERROR");
        }
    },

    // Verify webhook signature
    verifySignature: (payload, signature) => {
        if (!signature) return false;

        const expectedSignature = crypto
            .createHmac("sha256", process.env.WHATSAPP_APP_SECRET)
            .update(JSON.stringify(payload))
            .digest("hex");

        return signature === `sha256=${expectedSignature}`;
    },

    // Process incoming message
    processMessage: async (value) => {
        try {
            const { messages, statuses, contacts, metadata } = value;

            // Handle message status updates
            if (statuses) {
                for (const status of statuses) {
                    await whatsappController.updateMessageStatus(status);
                }
            }

            // Handle incoming messages
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

    // Save incoming message to database
    saveIncomingMessage: async (message, contact, metadata) => {
        try {
            const messageType = message.type;
            const content = {};

            // Extract content based on message type
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
                    // Download media URL
                    content.mediaUrl = await whatsappController.getMediaUrl(
                        message[messageType].id
                    );
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

            const newMessage = new WhatsAppMessage({
                messageId: message.id,
                conversationId: message.from,
                from: message.from,
                to: metadata?.phone_number_id || PHONE_NUMBER_ID,
                direction: "inbound",
                messageType,
                content,
                status: "delivered",
                timestamp: new Date(parseInt(message.timestamp) * 1000),
                salesAgent: agent?._id,
                salesAgentPhone: agent?.phone,
                metadata: {
                    profileName: contact?.profile?.name,
                    waId: contact?.wa_id,
                    isForwarded: message.context?.forwarded,
                    isFrequentlyForwarded: message.context?.frequently_forwarded,
                    context: message.context
                        ? {
                            messageId: message.context.id,
                            from: message.context.from,
                        }
                        : null,
                },
            });
            await newMessage.save();

            if (agent) {
                await User.findByIdAndUpdate(agent._id, {
                    $inc: { "whatsappSettings.totalMessagesReceived": 1 },
                    $set: { "whatsappSettings.lastMessageAt": new Date() },
                });

                // Auto-create or update contact
                await WhatsAppContact.findOneAndUpdate(
                    { phoneNumber: message.from, salesAgent: agent._id },
                    {
                        $set: {
                            name: contact?.profile?.name || message.from,
                            lastMessageAt: new Date(),
                            "metadata.profilePicUrl": contact?.profile?.picture,
                            "metadata.waId": contact?.wa_id,
                        },
                        $inc: { totalMessages: 1 },
                    },
                    { upsert: true, setDefaultsOnInsert: true }
                );
            }

            console.log(`Message ${message.id} saved successfully`);
        } catch (error) {
            if (error.code === 11000) {
                console.log(`Message ${message.id} already exists`);
            } else {
                console.error("Error saving message:", error);
            }
        }
    },

    // Update message status
    updateMessageStatus: async (status) => {
        try {
            const message = await WhatsAppMessage.findOne({ messageId: status.id });

            if (message) {
                message.status = status.status;
                message.statusUpdates.push({
                    status: status.status,
                    timestamp: new Date(parseInt(status.timestamp) * 1000),
                    errorCode: status.errors?.[0]?.code,
                    errorMessage: status.errors?.[0]?.title,
                });

                if (status.errors && status.errors.length > 0) {
                    message.error = {
                        code: status.errors[0].code,
                        message: status.errors[0].title,
                        details: status.errors[0],
                    };
                }

                await message.save();
                console.log(`Message ${status.id} status updated to ${status.status}`);
            }
        } catch (error) {
            console.error("Error updating message status:", error);
        }
    },

    // Get media URL
    getMediaUrl: async (mediaId) => {
        try {
            const response = await axios.get(`${WHATSAPP_API_URL}/${mediaId}`, {
                headers: {
                    Authorization: `Bearer ${ACCESS_TOKEN}`,
                },
            });
            return response.data.url;
        } catch (error) {
            console.error("Error getting media URL:", error);
            return null;
        }
    },

    // Send text message
    sendTextMessage: async (req, res) => {
        try {
            const { to, message, replyToMessageId } = req.body;

            if (!to || !message) {
                return res.status(400).json({ error: "Missing required fields" });
            }

            const payload = {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to,
                type: "text",
                text: {
                    preview_url: true,
                    body: message,
                },
            };

            if (replyToMessageId) {
                payload.context = { message_id: replyToMessageId };
            }

            const response = await axios.post(
                `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
                payload,
                {
                    headers: {
                        Authorization: `Bearer ${ACCESS_TOKEN}`,
                        "Content-Type": "application/json",
                    },
                }
            );

            // Save outbound message
            const newMessage = new WhatsAppMessage({
                messageId: response.data.messages[0].id,
                conversationId: to,
                from: PHONE_NUMBER_ID,
                to,
                direction: "outbound",
                messageType: "text",
                content: { text: message },
                status: "sent",
                metadata: {
                    context: replyToMessageId
                        ? { messageId: replyToMessageId }
                        : null,
                },
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

    // Send media message (image, video, audio, document)
    sendMediaMessage: async (req, res) => {
        try {
            const { to, mediaType, mediaUrl, caption, filename } = req.body;

            if (!to || !mediaType || !mediaUrl) {
                return res.status(400).json({ error: "Missing required fields" });
            }

            const payload = {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to,
                type: mediaType,
                [mediaType]: {
                    link: mediaUrl,
                },
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
                {
                    headers: {
                        Authorization: `Bearer ${ACCESS_TOKEN}`,
                        "Content-Type": "application/json",
                    },
                }
            );

            // Save outbound message
            const newMessage = new WhatsAppMessage({
                messageId: response.data.messages[0].id,
                conversationId: to,
                from: PHONE_NUMBER_ID,
                to,
                direction: "outbound",
                messageType: mediaType,
                content: {
                    mediaUrl,
                    caption,
                    filename,
                },
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

    // Send template message
    sendTemplateMessage: async (req, res) => {
        try {
            const { to, templateName, languageCode, components } = req.body;

            if (!to || !templateName || !languageCode) {
                return res.status(400).json({ error: "Missing required fields" });
            }

            const payload = {
                messaging_product: "whatsapp",
                recipient_type: "individual",
                to,
                type: "template",
                template: {
                    name: templateName,
                    language: {
                        code: languageCode,
                    },
                },
            };

            if (components) {
                payload.template.components = components;
            }

            const response = await axios.post(
                `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
                payload,
                {
                    headers: {
                        Authorization: `Bearer ${ACCESS_TOKEN}`,
                        "Content-Type": "application/json",
                    },
                }
            );

            // Save outbound message
            const newMessage = new WhatsAppMessage({
                messageId: response.data.messages[0].id,
                conversationId: to,
                from: PHONE_NUMBER_ID,
                to,
                direction: "outbound",
                messageType: "template",
                content: {
                    template: {
                        name: templateName,
                        language: languageCode,
                        components,
                    },
                },
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

    // Get conversation messages
    getConversation: async (req, res) => {
        try {
            const { phoneNumber } = req.params;
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 50;
            const skip = (page - 1) * limit;

            const messages = await WhatsAppMessage.find({
                $or: [{ from: phoneNumber }, { to: phoneNumber }],
            })
                .sort({ timestamp: -1 })
                .skip(skip)
                .limit(limit)
                .lean();

            const total = await WhatsAppMessage.countDocuments({
                $or: [{ from: phoneNumber }, { to: phoneNumber }],
            });

            return res.status(200).json({
                data: messages.reverse(),
                pagination: {
                    total,
                    page,
                    limit,
                    pages: Math.ceil(total / limit),
                },
            });
        } catch (error) {
            console.error("Error fetching conversation:", error);
            return res.status(500).json({
                error: "Error fetching conversation",
                details: error.message,
            });
        }
    },

    // Get all conversations
    getAllConversations: async (req, res) => {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 20;
            const skip = (page - 1) * limit;

            // Get latest message for each conversation
            const conversations = await WhatsAppMessage.aggregate([
                {
                    $sort: { timestamp: -1 },
                },
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
                {
                    $sort: { "lastMessage.timestamp": -1 },
                },
                {
                    $skip: skip,
                },
                {
                    $limit: limit,
                },
            ]);

            const total = await WhatsAppMessage.distinct("conversationId").then(
                (ids) => ids.length
            );

            return res.status(200).json({
                data: conversations,
                pagination: {
                    total,
                    page,
                    limit,
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

    // Mark message as read
    markAsRead: async (req, res) => {
        try {
            const { messageId } = req.params;

            await axios.post(
                `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
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
                { messageId },
                { status: "read" }
            );

            return res.status(200).json({
                success: true,
                message: "Message marked as read",
            });
        } catch (error) {
            console.error("Error marking message as read:", error);
            return res.status(500).json({
                error: "Error marking message as read",
                details: error.message,
            });
        }
    },
};

module.exports = whatsappController;