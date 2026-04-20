const WhatsAppMessage = require("../models/WhatsAppMessage");
const WhatsAppContact = require("../models/WhatsAppContact");
const User = require("../models/User");
const axios = require("axios");
const crypto = require("crypto");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { v4: uuidv4 } = require("uuid");
const { emitNewMessage, emitMessageStatus } = require("../socket");
const { resolveAgentForConversation, processCallWebhook } = require("./whatsappAgent.controller");
const { getValidToken, invalidateCachedToken } = require("../utils/tokenRefresher");
const os = require("os");
const fs = require("fs");
const pathLib = require("path");
const { convertInboundAudioToMp3 } = require("../utils/whatsappInboundAudio");
const { resolveWhatsAppS3Bucket } = require("../services/whatsappS3Upload");

const findAgentByPhone = async (phoneNumberId) => {
    const agent = await User.findOne({
        "whatsappSettings.phoneNumberId": phoneNumberId,
        "whatsappSettings.enabled": true,
    });
    return agent;
};

const WHATSAPP_API_URL = `https://graph.facebook.com/${process.env.WHATSAPP_API_VERSION}`;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;

// ── S3 client (reused across all media uploads) ──────────────────────────────
// Use the same config as the outbound upload (whatsappAgent.controller.js) to avoid mismatches
const rawRegion =
    process.env.AWS_REGION ||
    process.env.AWS_REGION_LAMBDA ||
    process.env.AWS_DEFAULT_REGION ||
    "eu-north-1";
const S3_REGION = rawRegion && rawRegion !== "undefined" ? rawRegion : "eu-north-1";
const s3 = new S3Client({
    region: S3_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_KEY,
    },
});

/** File extension from WhatsApp filename when MIME is generic (e.g. octet-stream). */
function extFromFilename(name) {
    if (!name || typeof name !== "string") return null;
    const m = name.match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : null;
}

/**
 * Step 2 of Meta media ingest: GET the binary URL returned by Graph.
 * WhatsApp requires `Authorization: Bearer <token>` on this request (same as Step 1).
 * Large payloads need unlimited axios body limits. On 401/403 we retry once without the header (CDN quirk).
 */
async function downloadBinaryFromMetaUrl(tempUrl, graphToken, mediaTimeout) {
    const big = {
        ...mediaTimeout,
        responseType: "arraybuffer",
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
    };
    try {
        return await axios.get(tempUrl, {
            headers: { Authorization: `Bearer ${graphToken}` },
            ...big,
        });
    } catch (err) {
        const st = err.response?.status;
        if (st === 401 || st === 403) {
            try {
                return await axios.get(tempUrl, big);
            } catch {
                throw err;
            }
        }
        throw err;
    }
}

/**
 * Put inbound media to S3. Prefer no ACL (Bucket owner enforced / block public ACLs).
 * If that fails with an ACL-related or AccessDenied response, retry once with public-read.
 */
async function putInboundObjectToS3({ bucket, key, body, contentType }) {
    const base = { Bucket: bucket, Key: key, Body: body, ContentType: contentType };
    try {
        await s3.send(new PutObjectCommand(base));
        console.log(`[Media] S3 upload OK (no ACL): ${key}`);
    } catch (err) {
        const name = err.name || "";
        const msg = String(err.message || err);
        const retryWithAcl =
            name === "AccessDenied" ||
            /ACL|AccessControlList|AclNotSupported|Cannot use ACL|InvalidAccessControlList/i.test(msg);
        if (retryWithAcl) {
            await s3.send(new PutObjectCommand({ ...base, ACL: "public-read" }));
            console.log(`[Media] S3 upload OK (with ACL): ${key}`);
        } else {
            throw err;
        }
    }
}

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

                    // Handle call events
                    for (const change of entry.changes) {
                        const val = change.value;
                        if (val?.calls) {
                            console.log(`[Webhook] Received ${val.calls.length} call event(s)`);
                            for (const callEvent of val.calls) {
                                console.log("[Webhook] Call event:", JSON.stringify(callEvent, null, 2));
                                const callId = callEvent.call_id || callEvent.id;
                                const fromNumber = callEvent.from;

                                // Try 1: resolve agent from conversation history (with + prefix)
                                let agentId = await resolveAgentForConversation(fromNumber);
                                if (!agentId) agentId = await resolveAgentForConversation("+" + fromNumber);

                                // Try 2: resolve from the stored call message by call_id
                                if (!agentId && callId) {
                                    const callMsg = await WhatsAppMessage.findOne({ messageId: callId }).lean();
                                    agentId = callMsg?.salesAgent || null;
                                }

                                if (agentId) {
                                    await processCallWebhook(callEvent, agentId.toString());
                                } else {
                                    console.warn("[Webhook] No agent found for call from:", fromNumber, "callId:", callId);
                                }
                            }
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
                    content.caption = message[messageType].caption;
                    if (messageType === "document") {
                        content.filename = message[messageType].filename;
                    }
                    console.log(
                        `[Media DEBUG] Starting ingest for mediaId: ${message[messageType].id}, type: ${messageType}`
                    );
                    console.log(`[Media DEBUG] S3 bucket (resolved): ${resolveWhatsAppS3Bucket()}`);
                    console.log(`[Media DEBUG] AWS_REGION (effective): ${S3_REGION}`);
                    console.log(`[Media DEBUG] AWS_ACCESS_KEY exists: ${!!process.env.AWS_ACCESS_KEY}`);
                    console.log(`[Media DEBUG] AWS_ACCESS_KEY_ID exists: ${!!process.env.AWS_ACCESS_KEY_ID}`);
                    console.log(`[Media DEBUG] AWS_SECRET_KEY exists: ${!!process.env.AWS_SECRET_KEY}`);
                    console.log(
                        `[Media DEBUG] AWS_SECRET_ACCESS_KEY exists: ${!!process.env.AWS_SECRET_ACCESS_KEY}`
                    );
                    console.log(
                        `[Media DEBUG] WHATSAPP_ACCESS_TOKEN exists: ${!!process.env.WHATSAPP_ACCESS_TOKEN}`
                    );
                    // Download from Meta and re-upload to S3 for a permanent URL
                    // (audio is converted to MP3 inside getMediaUrl for universal browser playback)
                    const ingest = await whatsappController.getMediaUrl(message[messageType].id, {
                        filename: messageType === "document" ? message.document?.filename : undefined,
                    });
                    console.log(`[Media DEBUG] Ingest result:`, JSON.stringify(ingest));
                    content.mediaUrl = ingest?.url ?? null;
                    if (ingest?.error) content.mediaIngestError = String(ingest.error).slice(0, 500);
                    // Store the stripped/final mime type. Audio files are now MP3.
                    content.mimeType = messageType === "audio"
                        ? "audio/mpeg"
                        : (message[messageType].mime_type || "").split(";")[0].trim();
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

            const mediaTypes = ["image", "video", "audio", "document", "sticker"];
            if (mediaTypes.includes(messageType) && content.mediaId && !content.mediaUrl) {
                console.warn(
                    `[Media] Inbound save without S3 URL (messageId=${message.id}, mediaId=${content.mediaId}):`,
                    content.mediaIngestError || "see server log above for Graph/S3 error"
                );
            }

            const messageFrom = "+" + message.from.replace(/\D/g, "");

            // Owning agent: webhook phone_number_id match first, else prior messages in this thread.
            // (Previously we patched salesAgent after save but never set salesAgentPhone — left null.)
            let resolvedAgentId = agent?._id || null;
            if (!resolvedAgentId) {
                resolvedAgentId = await resolveAgentForConversation(messageFrom);
            }
            let resolvedAgentPhone = agent?.phone || null;
            if (resolvedAgentId && !resolvedAgentPhone) {
                const u = await User.findById(resolvedAgentId).select("phone").lean();
                resolvedAgentPhone = u?.phone || null;
            }

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
                salesAgent: resolvedAgentId || null,
                salesAgentPhone: resolvedAgentPhone || null,
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

            const nowDate = new Date();

            if (resolvedAgentId) {
                await User.findByIdAndUpdate(resolvedAgentId, {
                    $inc: { "whatsappSettings.totalMessagesReceived": 1 },
                    $set: { "whatsappSettings.lastMessageAt": nowDate },
                });
            }

            // Upsert contact — use resolved agent if available, otherwise null (unassigned).
            // Unassigned contacts are visible to all agents in the inbox.
            await WhatsAppContact.findOneAndUpdate(
                { phoneNumber: messageFrom, salesAgent: resolvedAgentId || null },
                {
                    $set: {
                        name: contact?.profile?.name || messageFrom,
                        lastMessageAt: nowDate,
                        lastInboundMessageAt: nowDate,
                        "metadata.waId": contact?.wa_id,
                    },
                    $inc: { totalMessages: 1 },
                },
                { upsert: true, setDefaultsOnInsert: true }
            );

            if (resolvedAgentId) {
                emitNewMessage(String(resolvedAgentId), newMessage.toObject());
                console.log(`[Webhook] New message from ${messageFrom} emitted to agent ${resolvedAgentId}`);
            } else {
                // Broadcast unassigned inbound to every connected agent so whoever is online can pick it up
                try {
                    const io = require("../socket").getIO();
                    io.emit("new_unassigned_message", newMessage.toObject());
                    console.log(`[Webhook] Unassigned message from ${messageFrom} broadcast to all agents`);
                } catch (e) {
                    console.warn("[Webhook] Could not broadcast unassigned message:", e.message);
                }
            }

            // AI-agent hook: if this sender is a vendor on an active RFQ, let the
            // conversational WhatsApp agent handle the negotiation. Fire-and-forget —
            // the webhook response has already been sent back to Meta at this point.
            setImmediate(() => {
                const whatsappInboundAgent = require("../agents/whatsappInboundAgent");
                whatsappInboundAgent
                    .handleIncomingMessage({
                        conversationId: messageFrom,
                        incomingMessage: newMessage.toObject(),
                    })
                    .then((result) => {
                        if (result?.handled) {
                            try {
                                const io = require("../socket").getIO();
                                io.emit("wa_ai_conversation_update", {
                                    conversationId: messageFrom,
                                    messageId: newMessage.messageId,
                                });
                            } catch (_) {}
                            console.log(`[AI Agent] Handled WhatsApp message ${newMessage.messageId} for RFQ flow`);
                        } else if (result?.reason && result.reason !== "no_active_rfq") {
                            console.log(`[AI Agent] Skipped message ${newMessage.messageId}: ${result.reason}`);
                        }
                    })
                    .catch((err) => {
                        console.error(`[AI Agent] Error handling WhatsApp message ${newMessage.messageId}:`, err);
                    });
            });

            console.log(`[Webhook] Message ${message.id} saved (type: ${messageType})`);

            // If media ingest failed, retry once after a few seconds (transient Meta/S3).
            if (mediaTypes.includes(messageType) && content.mediaId && !content.mediaUrl) {
                const wamid = message.id;
                const graphMediaId = message[messageType].id;
                const hintFilename = messageType === "document" ? message.document?.filename : undefined;
                const emitAgentId = resolvedAgentId ? String(resolvedAgentId) : "";
                setTimeout(async () => {
                    try {
                        const doc = await WhatsAppMessage.findOne({ messageId: wamid }).lean();
                        if (!doc?.content?.mediaId || doc.content?.mediaUrl) return;
                        const ingest2 = await whatsappController.getMediaUrl(graphMediaId, { filename: hintFilename });
                        console.log(`[Media DEBUG] Ingest result (delayed retry):`, JSON.stringify(ingest2));
                        if (!ingest2?.url) return;
                        const updated = await WhatsAppMessage.findOneAndUpdate(
                            { messageId: wamid },
                            { $set: { "content.mediaUrl": ingest2.url }, $unset: { "content.mediaIngestError": "" } },
                            { new: true }
                        );
                        if (!updated) return;
                        if (emitAgentId) {
                            emitNewMessage(emitAgentId, updated.toObject());
                        } else {
                            try {
                                const io = require("../socket").getIO();
                                io.emit("new_unassigned_message", updated.toObject());
                            } catch {
                                /* ignore */
                            }
                        }
                        console.log(`[Media] Delayed ingest succeeded for ${wamid}`);
                    } catch (e) {
                        console.warn("[Media] Delayed ingest retry failed:", e.message);
                    }
                }, 6000);
            }
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
                if (status.status === "failed" && status.errors?.length) {
                    console.error(`[Webhook] Message ${status.id} FAILED:`, JSON.stringify(status.errors, null, 2));
                } else {
                    console.log(`[Webhook] Message ${status.id} → ${status.status}`);
                }
            }
        } catch (error) {
            console.error("[Webhook] Error updating status:", error);
        }
    },

    // ── Get media from Meta and upload to S3 ──────────────────────────────────
    // Meta's signed media URLs expire within minutes, so we download immediately
    // and store a permanent S3 URL instead. Returns { url } or { url: null, error } on failure.
    // hints.filename — optional WhatsApp document filename (helps extension when MIME is generic).
    getMediaUrl: async (mediaId, hints = {}) => {
        const mediaTimeout = { timeout: 180000 }; // large inbound videos can be slow
        const bucket = resolveWhatsAppS3Bucket();

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                if (!bucket) {
                    return { url: null, error: "S3 bucket not configured (AWS_S3_BUCKET or S3_BUCKET)" };
                }

                const graphToken = await getValidToken();

                // Step 1: Graph — resolve temporary download URL + mime
                const metaResponse = await axios.get(`${WHATSAPP_API_URL}/${mediaId}`, {
                    headers: { Authorization: `Bearer ${graphToken}` },
                    ...mediaTimeout,
                    maxBodyLength: Infinity,
                    maxContentLength: Infinity,
                });
                const tempUrl = metaResponse.data.url;
                if (!tempUrl) {
                    return { url: null, error: "Meta media response had no url field" };
                }
                const rawMimeType = metaResponse.data.mime_type || "application/octet-stream";
                const mimeType = rawMimeType.split(";")[0].trim();

                // Step 2: Download bytes (unlimited size for video)
                const mediaResponse = await downloadBinaryFromMetaUrl(tempUrl, graphToken, mediaTimeout);

                let buffer = Buffer.from(mediaResponse.data);
                let finalMime = mimeType;
                let ext = (mimeType.split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "") || "bin";
                const fromName = extFromFilename(hints.filename);
                if ((ext === "octet-stream" || ext === "bin" || ext === "binary") && fromName) {
                    ext = fromName;
                }

                // Convert incoming audio to MP3 where possible
                if (mimeType.startsWith("audio/")) {
                    try {
                        console.log(`[Media] Converting inbound audio (${rawMimeType}) to MP3...`);
                        buffer = await convertInboundAudioToMp3(buffer);
                        finalMime = "audio/mpeg";
                        ext = "mp3";
                        console.log(`[Media] Audio conversion complete (${buffer.length} bytes)`);
                    } catch (convErr) {
                        console.error(`[Media] Audio conversion failed, uploading original:`, convErr.message);
                    }
                }

                const key = `whatsapp-inbound/${uuidv4()}.${ext}`;
                await putInboundObjectToS3({
                    bucket,
                    key,
                    body: buffer,
                    contentType: finalMime,
                });

                const s3Url = `https://${bucket}.s3.${S3_REGION}.amazonaws.com/${key}`;
                console.log(`[Media] ${mediaId} → S3: ${s3Url}`);
                return { url: s3Url };
            } catch (error) {
                const status = error.response?.status;
                const fbErr = error.response?.data?.error;
                const code = fbErr?.code;
                const oauthish =
                    status === 401 ||
                    code === 190 ||
                    code === "OAuthException" ||
                    (typeof fbErr?.message === "string" && fbErr.message.includes("Session has expired"));

                if (attempt === 0 && oauthish) {
                    console.warn("[Media] Graph OAuth issue — invalidating token cache and retrying once…");
                    invalidateCachedToken();
                    continue;
                }

                const detail = error.response?.data || error.message || String(error);
                const errStr = typeof detail === "string" ? detail : JSON.stringify(detail);
                console.error("Error downloading/uploading media:", errStr);
                return { url: null, error: errStr.slice(0, 800) };
            }
        }

        return { url: null, error: "Media ingest failed after retry" };
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
                { headers: { Authorization: `Bearer ${await getValidToken()}`, "Content-Type": "application/json" } }
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
                { headers: { Authorization: `Bearer ${await getValidToken()}`, "Content-Type": "application/json" } }
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
                { headers: { Authorization: `Bearer ${await getValidToken()}`, "Content-Type": "application/json" } }
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
                { headers: { Authorization: `Bearer ${await getValidToken()}`, "Content-Type": "application/json" } }
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