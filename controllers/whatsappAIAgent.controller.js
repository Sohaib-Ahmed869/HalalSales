// controllers/whatsappAIAgent.controller.js
// API for the AI-driven WhatsApp RFQ agent (Meta Cloud API).

const RFQ = require('../models/RFQ');
const WhatsAppMessage = require('../models/WhatsAppMessage');
const whatsappOutboundAgent = require('../agents/whatsappOutboundAgent');
const whatsappInboundAgent = require('../agents/whatsappInboundAgent');
const whatsappBusinessApi = require('../services/whatsappBusinessApi');

// Utility: canonical conversationId from any phone format
function toConversationId(raw) {
    if (!raw) return null;
    const digits = String(raw).replace(/\D/g, '');
    return digits ? '+' + digits : null;
}

/**
 * POST /api/whatsapp-ai/rfq/:rfqId/send
 * Body: { vendorCodes?: string[], customMessage?: string }
 * Sends the RFQ to vendors via the Meta Cloud API in a conversational style.
 */
exports.sendRFQ = async (req, res) => {
    try {
        const { rfqId } = req.params;
        const { vendorCodes, customMessage } = req.body || {};

        const rfq = await RFQ.findById(rfqId);
        if (!rfq) {
            return res.status(404).json({ success: false, error: 'RFQ not found' });
        }

        // Default: whichever vendors are currently in draft/sent-but-no-phone-yet
        let codes = Array.isArray(vendorCodes) && vendorCodes.length > 0
            ? vendorCodes
            : rfq.vendorsContacted
                .filter(v => v.phone && ['draft', 'sent'].includes(v.status || 'draft'))
                .map(v => v.vendorCode);

        if (!codes.length) {
            return res.status(400).json({
                success: false,
                error: 'No vendors with phone numbers available to send to via WhatsApp',
            });
        }

        const result = await whatsappOutboundAgent.sendRFQ({
            rfqId,
            vendorCodes: codes,
            customMessage,
        });

        res.json({ success: true, data: result });
    } catch (err) {
        console.error('[WhatsAppAIAgent] sendRFQ error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
};

/**
 * GET /api/whatsapp-ai/conversations
 * List all AI-agent-managed WhatsApp conversations, grouped by RFQ vendor.
 * Query: ?rfqId=xxx (optional filter), ?limit=50
 */
exports.listConversations = async (req, res) => {
    try {
        const { rfqId, limit = 50 } = req.query;

        const query = {
            status: { $in: ['sent', 'in_progress', 'completed'] },
            'vendorsContacted.phone': { $exists: true, $ne: null },
        };
        if (rfqId) query._id = rfqId;

        const rfqs = await RFQ.find(query)
            .sort({ updatedAt: -1 })
            .limit(parseInt(limit))
            .lean();

        const conversations = [];
        for (const rfq of rfqs) {
            for (const v of rfq.vendorsContacted || []) {
                if (!v.phone) continue;
                if (!v.whatsappMessageId && !(v.whatsappHistory || []).length) continue;

                const lastEntry = (v.whatsappHistory || []).slice(-1)[0];
                conversations.push({
                    rfqId: rfq._id,
                    rfqNumber: rfq.rfqNumber,
                    rfqStatus: rfq.status,
                    vendorCode: v.vendorCode,
                    vendorName: v.vendorName,
                    phone: v.phone,
                    conversationId: toConversationId(v.phone),
                    status: v.status,
                    negotiationStatus: v.negotiationStatus || 'awaiting_initial_quote',
                    negotiationRound: v.negotiationRound || 0,
                    messageCount: (v.whatsappHistory || []).length,
                    lastMessage: lastEntry
                        ? {
                            direction: lastEntry.direction,
                            text: lastEntry.message,
                            timestamp: lastEntry.timestamp,
                        }
                        : null,
                    pendingAdminReview: !!v.pendingAdminReview,
                    botRecommendation: v.botRecommendation || null,
                    quotationData: v.quotationData || null,
                    updatedAt: rfq.updatedAt,
                });
            }
        }

        conversations.sort((a, b) => {
            const ta = a.lastMessage?.timestamp ? new Date(a.lastMessage.timestamp).getTime() : 0;
            const tb = b.lastMessage?.timestamp ? new Date(b.lastMessage.timestamp).getTime() : 0;
            return tb - ta;
        });

        res.json({ success: true, data: conversations });
    } catch (err) {
        console.error('[WhatsAppAIAgent] listConversations error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
};

/**
 * GET /api/whatsapp-ai/rfq/:rfqId/conversation/:vendorCode
 * Detailed view of one RFQ-vendor WhatsApp conversation including full history and negotiation state.
 */
exports.getConversation = async (req, res) => {
    try {
        const { rfqId, vendorCode } = req.params;

        const rfq = await RFQ.findById(rfqId).lean();
        if (!rfq) return res.status(404).json({ success: false, error: 'RFQ not found' });

        const vendor = (rfq.vendorsContacted || []).find(v => v.vendorCode === vendorCode);
        if (!vendor) return res.status(404).json({ success: false, error: 'Vendor not found on this RFQ' });

        // Also fetch raw WhatsAppMessage docs for media links etc.
        let messageDocs = [];
        if (vendor.phone) {
            const convId = toConversationId(vendor.phone);
            messageDocs = await WhatsAppMessage.find({
                conversationId: convId,
            })
                .sort({ timestamp: 1 })
                .limit(500)
                .lean();
        }

        res.json({
            success: true,
            data: {
                rfq: {
                    _id: rfq._id,
                    rfqNumber: rfq.rfqNumber,
                    status: rfq.status,
                    items: rfq.items,
                    quotationDueDate: rfq.quotationDueDate,
                    deliveryBy: rfq.deliveryBy,
                    incoterm: rfq.incoterm,
                    destination: rfq.destination,
                    paymentTermsPreference: rfq.paymentTermsPreference,
                },
                vendor: {
                    vendorCode: vendor.vendorCode,
                    vendorName: vendor.vendorName,
                    phone: vendor.phone,
                    email: vendor.email,
                    status: vendor.status,
                    negotiationStatus: vendor.negotiationStatus,
                    negotiationRound: vendor.negotiationRound,
                    pendingAdminReview: !!vendor.pendingAdminReview,
                    botRecommendation: vendor.botRecommendation || null,
                    quotationData: vendor.quotationData || null,
                    notes: vendor.notes,
                },
                history: vendor.whatsappHistory || [],
                negotiationHistory: vendor.negotiationHistory || [],
                messageDocs,
            },
        });
    } catch (err) {
        console.error('[WhatsAppAIAgent] getConversation error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
};

/**
 * POST /api/whatsapp-ai/rfq/:rfqId/conversation/:vendorCode/manual-reply
 * Body: { text: string }
 * Let an admin inject a manual message into the AI conversation.
 */
exports.sendManualReply = async (req, res) => {
    try {
        const { rfqId, vendorCode } = req.params;
        const { text } = req.body || {};

        if (!text || !text.trim()) {
            return res.status(400).json({ success: false, error: 'Message text is required' });
        }

        const rfq = await RFQ.findById(rfqId);
        if (!rfq) return res.status(404).json({ success: false, error: 'RFQ not found' });

        const vendor = (rfq.vendorsContacted || []).find(v => v.vendorCode === vendorCode);
        if (!vendor) return res.status(404).json({ success: false, error: 'Vendor not found on this RFQ' });
        if (!vendor.phone) return res.status(400).json({ success: false, error: 'Vendor has no phone number' });

        const result = await whatsappBusinessApi.sendText({
            to: vendor.phone,
            text: text.trim(),
            aiAgentContext: {
                rfqId: rfq._id.toString(),
                rfqNumber: rfq.rfqNumber,
                vendorCode: vendor.vendorCode,
                stage: 'manual_admin_reply',
                actorType: 'admin',
            },
        });

        if (!vendor.whatsappHistory) vendor.whatsappHistory = [];
        vendor.whatsappHistory.push({
            direction: 'outgoing',
            message: text.trim(),
            timestamp: new Date(),
            messageSid: result.messageId,
        });
        rfq.markModified('vendorsContacted');
        await rfq.save();

        res.json({ success: true, data: result });
    } catch (err) {
        console.error('[WhatsAppAIAgent] sendManualReply error:', err);
        res.status(500).json({ success: false, error: err.response?.data?.error?.message || err.message });
    }
};

/**
 * POST /api/whatsapp-ai/rfq/:rfqId/conversation/:vendorCode/reprocess
 * Re-run the AI inbound agent against the most recent inbound message for this vendor.
 * Useful if the first pass errored out and we want a second attempt.
 */
exports.reprocessLast = async (req, res) => {
    try {
        const { rfqId, vendorCode } = req.params;

        const rfq = await RFQ.findById(rfqId).lean();
        if (!rfq) return res.status(404).json({ success: false, error: 'RFQ not found' });
        const vendor = (rfq.vendorsContacted || []).find(v => v.vendorCode === vendorCode);
        if (!vendor?.phone) return res.status(400).json({ success: false, error: 'Vendor has no phone' });

        const convId = toConversationId(vendor.phone);
        const lastInbound = await WhatsAppMessage.findOne({
            conversationId: convId,
            direction: 'inbound',
        }).sort({ timestamp: -1 }).lean();

        if (!lastInbound) {
            return res.status(404).json({ success: false, error: 'No inbound message to reprocess' });
        }

        // Clear the dedup entry for that messageId so it can run again
        await RFQ.updateOne(
            { _id: rfqId },
            { $pull: { 'metadata.processedWhatsAppIds': lastInbound.messageId } }
        );

        const result = await whatsappInboundAgent.handleIncomingMessage({
            conversationId: convId,
            incomingMessage: lastInbound,
        });
        res.json({ success: true, data: result });
    } catch (err) {
        console.error('[WhatsAppAIAgent] reprocessLast error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
};

/**
 * GET /api/whatsapp-ai/stats
 * Summary stats for the AI WhatsApp agent.
 */
exports.getStats = async (req, res) => {
    try {
        const rfqs = await RFQ.find({
            'vendorsContacted.phone': { $exists: true, $ne: null },
            'vendorsContacted.whatsappMessageId': { $exists: true },
        }).lean();

        let activeConversations = 0;
        let totalVendorsContactedViaWA = 0;
        let awaitingAdminReview = 0;
        let stalled = 0;
        let quotesReceived = 0;
        let messagesSent = 0;
        let messagesReceived = 0;

        for (const rfq of rfqs) {
            for (const v of rfq.vendorsContacted || []) {
                if (!v.phone || !(v.whatsappMessageId || (v.whatsappHistory || []).length)) continue;
                totalVendorsContactedViaWA++;
                if (v.pendingAdminReview) awaitingAdminReview++;
                if (v.negotiationStatus === 'stalled') stalled++;
                if (v.quotationData?.isValidQuotation) quotesReceived++;
                if (['sent', 'opened'].includes(v.status) || v.negotiationStatus === 'negotiating') {
                    activeConversations++;
                }
                for (const h of v.whatsappHistory || []) {
                    if (h.direction === 'outgoing') messagesSent++;
                    else messagesReceived++;
                }
            }
        }

        res.json({
            success: true,
            data: {
                totalRFQsUsingWA: rfqs.length,
                totalVendorsContactedViaWA,
                activeConversations,
                quotesReceived,
                awaitingAdminReview,
                stalled,
                messagesSent,
                messagesReceived,
            },
        });
    } catch (err) {
        console.error('[WhatsAppAIAgent] getStats error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
};
