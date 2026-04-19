// services/whatsappBusinessApi.js
// Thin wrapper over Meta's WhatsApp Business Cloud API.
// Used by the AI WhatsApp agent for outbound RFQ + negotiation messages.
// Every outbound message is persisted in the WhatsAppMessage collection so the
// agent UI and admin dashboard keep a single source of truth.

const axios = require('axios');
const WhatsAppMessage = require('../models/WhatsAppMessage');
const WhatsAppContact = require('../models/WhatsAppContact');

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';
const API_BASE = `https://graph.facebook.com/${API_VERSION}`;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

function assertConfigured() {
    if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
        throw new Error(
            'WhatsApp Business API not configured. Set WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN in .env.'
        );
    }
}

// Meta wants E.164 digits only, no `+`, no spaces, no `whatsapp:` prefix.
function normalizeToWaNumber(raw) {
    if (!raw) throw new Error('Phone number is required');
    const digits = String(raw).replace(/\D/g, '');
    if (!digits) throw new Error(`Invalid phone number: ${raw}`);
    return digits;
}

// Conversation IDs in the DB are stored as `+<digits>` (see whatsapp.controller).
function toConversationId(waNumber) {
    const digits = normalizeToWaNumber(waNumber);
    return '+' + digits;
}

async function isWithinCustomerServiceWindow(conversationId) {
    const contact = await WhatsAppContact.findOne({ phoneNumber: conversationId }).sort({ lastInboundMessageAt: -1 });
    if (!contact?.lastInboundMessageAt) return false;
    return (Date.now() - new Date(contact.lastInboundMessageAt).getTime()) < CUSTOMER_SERVICE_WINDOW_MS;
}

async function persistOutboundMessage({ response, to, messageType, content, meta = {} }) {
    const conversationId = toConversationId(to);
    const messageId = response?.messages?.[0]?.id;
    if (!messageId) return null;

    try {
        const doc = await WhatsAppMessage.create({
            messageId,
            conversationId,
            from: PHONE_NUMBER_ID,
            to: conversationId,
            direction: 'outbound',
            messageType,
            content,
            status: 'sent',
            timestamp: new Date(),
            metadata: {
                ...meta,
                aiAgent: true,
            },
        });
        return doc;
    } catch (err) {
        if (err?.code === 11000) {
            return WhatsAppMessage.findOne({ messageId });
        }
        throw err;
    }
}

async function sendText({ to, text, replyToMessageId, aiAgentContext }) {
    assertConfigured();
    if (!text || !text.trim()) throw new Error('Text body is required');

    const waNumber = normalizeToWaNumber(to);
    const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: waNumber,
        type: 'text',
        text: { preview_url: false, body: text },
    };
    if (replyToMessageId) payload.context = { message_id: replyToMessageId };

    const response = await axios.post(
        `${API_BASE}/${PHONE_NUMBER_ID}/messages`,
        payload,
        {
            headers: {
                Authorization: `Bearer ${ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
            },
        }
    );

    const doc = await persistOutboundMessage({
        response: response.data,
        to: waNumber,
        messageType: 'text',
        content: { text },
        meta: {
            replyTo: replyToMessageId || null,
            ...(aiAgentContext || {}),
        },
    });

    return {
        success: true,
        messageId: response.data?.messages?.[0]?.id,
        dbId: doc?._id,
        raw: response.data,
    };
}

async function sendTemplate({ to, templateName, languageCode = 'en_US', components = [], aiAgentContext }) {
    assertConfigured();
    if (!templateName) throw new Error('templateName is required');

    const waNumber = normalizeToWaNumber(to);
    const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: waNumber,
        type: 'template',
        template: {
            name: templateName,
            language: { code: languageCode },
        },
    };
    if (components && components.length) payload.template.components = components;

    const response = await axios.post(
        `${API_BASE}/${PHONE_NUMBER_ID}/messages`,
        payload,
        {
            headers: {
                Authorization: `Bearer ${ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
            },
        }
    );

    const doc = await persistOutboundMessage({
        response: response.data,
        to: waNumber,
        messageType: 'template',
        content: { template: { name: templateName, language: languageCode, components } },
        meta: aiAgentContext || {},
    });

    return {
        success: true,
        messageId: response.data?.messages?.[0]?.id,
        dbId: doc?._id,
        raw: response.data,
    };
}

async function sendMedia({ to, mediaType, mediaUrl, caption, filename, aiAgentContext }) {
    assertConfigured();
    if (!['image', 'video', 'audio', 'document'].includes(mediaType)) {
        throw new Error(`Unsupported mediaType: ${mediaType}`);
    }
    if (!mediaUrl) throw new Error('mediaUrl is required');

    const waNumber = normalizeToWaNumber(to);
    const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: waNumber,
        type: mediaType,
        [mediaType]: { link: mediaUrl },
    };
    if (caption && ['image', 'video', 'document'].includes(mediaType)) {
        payload[mediaType].caption = caption;
    }
    if (filename && mediaType === 'document') {
        payload[mediaType].filename = filename;
    }

    const response = await axios.post(
        `${API_BASE}/${PHONE_NUMBER_ID}/messages`,
        payload,
        {
            headers: {
                Authorization: `Bearer ${ACCESS_TOKEN}`,
                'Content-Type': 'application/json',
            },
        }
    );

    const doc = await persistOutboundMessage({
        response: response.data,
        to: waNumber,
        messageType: mediaType,
        content: { mediaUrl, caption, filename },
        meta: aiAgentContext || {},
    });

    return {
        success: true,
        messageId: response.data?.messages?.[0]?.id,
        dbId: doc?._id,
        raw: response.data,
    };
}

// Convenience helper: send a short conversational opener plus 1..n follow-up messages.
// Useful for the chat-style RFQ delivery where we want several short bubbles instead of one long message.
async function sendSequence({ to, messages, delayMs = 700, replyToMessageId, aiAgentContext }) {
    const results = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg || !String(msg).trim()) continue;
        try {
            const res = await sendText({
                to,
                text: String(msg),
                replyToMessageId: i === 0 ? replyToMessageId : undefined,
                aiAgentContext,
            });
            results.push({ success: true, messageId: res.messageId, text: msg });
        } catch (err) {
            results.push({ success: false, error: err.message, text: msg });
            break;
        }
        if (delayMs > 0 && i < messages.length - 1) {
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    return results;
}

module.exports = {
    sendText,
    sendTemplate,
    sendMedia,
    sendSequence,
    normalizeToWaNumber,
    toConversationId,
    isWithinCustomerServiceWindow,
    CUSTOMER_SERVICE_WINDOW_MS,
    PHONE_NUMBER_ID,
};
