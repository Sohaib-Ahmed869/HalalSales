// agents/whatsappOutboundAgent.js
// Sends RFQs to vendors via WhatsApp (Meta Cloud API) in a conversational,
// multi-message style. Parallel to outboundAgent.js (email) but chattier.

const { BaseAgent } = require('./baseAgent');
const RFQ = require('../models/RFQ');
const Vendor = require('../models/Vendor');
const PDA_Supplier = require('../models/PDA_Supplier');
const NewSupplier = require('../models/NewSupplier');
const whatsappBusinessApi = require('../services/whatsappBusinessApi');

class WhatsappOutboundAgent extends BaseAgent {
    constructor() {
        super('WA-Outbound');
    }

    async sendRFQ({ rfqId, vendorCodes, customMessage }) {
        this.log(`Sending RFQ ${rfqId} to ${vendorCodes?.length || 0} vendors via WhatsApp`);
        this.addToActionLog('wa_send_rfq_started', { rfqId, vendorCodes });

        const rfq = await RFQ.findById(rfqId);
        if (!rfq) throw new Error(`RFQ ${rfqId} not found`);

        const vendors = await this._resolveVendors(vendorCodes || []);
        this.log(`Resolved ${vendors.length} vendors for WhatsApp delivery`);

        const results = [];

        for (const vendor of vendors) {
            if (!vendor.phone) {
                results.push({
                    vendorCode: vendor.CardCode,
                    vendorName: vendor.CardName,
                    success: false,
                    error: 'No phone number on file',
                    method: 'whatsapp',
                });
                await this._updateVendorStatus(rfq, vendor, 'draft', null, 'No phone number');
                continue;
            }

            try {
                const conversation = await this._composeOpeningConversation(rfq, vendor, customMessage);
                const sendResults = await whatsappBusinessApi.sendSequence({
                    to: vendor.phone,
                    messages: conversation,
                    delayMs: 800,
                    aiAgentContext: {
                        rfqId: rfq._id.toString(),
                        rfqNumber: rfq.rfqNumber,
                        vendorCode: vendor.CardCode,
                        stage: 'rfq_opening',
                    },
                });

                const firstSuccess = sendResults.find(r => r.success);
                if (!firstSuccess) {
                    const firstError = sendResults.find(r => !r.success);
                    throw new Error(firstError?.error || 'All message sends failed');
                }

                await this._updateVendorStatus(rfq, vendor, 'sent', firstSuccess.messageId, null, conversation);

                results.push({
                    vendorCode: vendor.CardCode,
                    vendorName: vendor.CardName,
                    success: true,
                    messageId: firstSuccess.messageId,
                    messagesSent: sendResults.filter(r => r.success).length,
                    method: 'whatsapp',
                });
                this.log(`Sent opening conversation (${sendResults.length} msgs) to ${vendor.CardName}`);
            } catch (err) {
                this.logError(`WhatsApp send failed for ${vendor.CardName}:`, err);
                results.push({
                    vendorCode: vendor.CardCode,
                    vendorName: vendor.CardName,
                    success: false,
                    error: err?.response?.data?.error?.message || err.message,
                    method: 'whatsapp',
                });
            }
        }

        rfq.status = 'sent';
        rfq.metadata = {
            ...rfq.metadata,
            sentAt: rfq.metadata?.sentAt || new Date(),
            sendMethod: rfq.metadata?.sendMethod === 'email' ? 'mixed' : 'whatsapp',
            whatsappSentAt: new Date(),
        };
        await rfq.save();

        const successCount = results.filter(r => r.success).length;
        this.addToActionLog('wa_send_rfq_completed', {
            rfqId,
            rfqNumber: rfq.rfqNumber,
            totalVendors: vendors.length,
            successfulSends: successCount,
        });

        return {
            rfqNumber: rfq.rfqNumber,
            totalVendors: vendors.length,
            successfulSends: successCount,
            failedSends: results.length - successCount,
            sendMethod: 'whatsapp',
            results,
        };
    }

    async _resolveVendors(vendorCodes) {
        const objectIdCodes = vendorCodes.filter(code => /^[0-9a-fA-F]{24}$/.test(code));
        const sapCodes = vendorCodes.filter(code => !/^[0-9a-fA-F]{24}$/.test(code));

        const vendors = [];

        if (sapCodes.length > 0) {
            const sapVendors = await Vendor.find({ CardCode: { $in: sapCodes } });
            for (const v of sapVendors) {
                vendors.push({
                    CardCode: v.CardCode,
                    CardName: v.CardName,
                    email: v.email,
                    phone: v.phone,
                    country: v.country,
                    performanceMetrics: v.performanceMetrics || { totalOrders: 0 },
                    _source: 'SAP',
                });
            }
        }

        if (objectIdCodes.length > 0) {
            const pdaSuppliers = await PDA_Supplier.find({ _id: { $in: objectIdCodes } });
            const resolvedIds = new Set();
            for (const s of pdaSuppliers) {
                resolvedIds.add(s._id.toString());
                vendors.push({
                    CardCode: s._id.toString(),
                    CardName: s.supplierName,
                    email: s.email,
                    phone: s.contactInfo?.phone,
                    _source: 'PDA_SUPPLIER',
                    _isPDA: true,
                    performanceMetrics: { totalOrders: 0 },
                });
            }

            const remaining = objectIdCodes.filter(id => !resolvedIds.has(id));
            if (remaining.length > 0) {
                const newSuppliers = await NewSupplier.find({ _id: { $in: remaining }, isActive: true });
                for (const s of newSuppliers) {
                    vendors.push({
                        CardCode: s._id.toString(),
                        CardName: s.companyName || s.supplierName,
                        email: s.email,
                        phone: s.phone,
                        country: s.country,
                        _source: 'NEW_SUPPLIER',
                        _isNewSupplier: true,
                        performanceMetrics: { totalOrders: s.stats?.totalWins || 0 },
                    });
                }
            }
        }

        return vendors;
    }

    // Compose the opening WhatsApp conversation — short, chatty messages instead of
    // a single long wall of text. LLM generates tone appropriate to the relationship.
    async _composeOpeningConversation(rfq, vendor, customMessage) {
        const isExisting = (vendor.performanceMetrics?.totalOrders || 0) > 0;
        const deliveryDate = rfq.deliveryBy ? new Date(rfq.deliveryBy).toLocaleDateString('en-GB') : '';
        const dueDate = rfq.quotationDueDate ? new Date(rfq.quotationDueDate).toLocaleDateString('en-GB') : '';

        const itemsList = rfq.items.map(i => {
            const spec = i.specifications ? ` (${i.specifications})` : '';
            return `• ${i.productName}${spec} — ${i.quantity} ${i.unit}`;
        }).join('\n');

        try {
            const systemPrompt = `You generate the opening WhatsApp conversation from Halal Food Service (a French halal food wholesaler in Paris) to a supplier, asking them to quote on an RFQ.

This is a CHAT, not an email. Output must be a JSON array of 3–5 short WhatsApp messages that will be sent one after the other.

RULES:
- Each message ≤ 400 characters. Most should be much shorter.
- Natural, conversational tone — like a procurement buyer messaging a known supplier.
- First message: greeting + one-line reason for contacting. Use vendor name.
- Second message: the item list (may use line breaks and simple bullet points).
- Third message: key terms — delivery target, quotation deadline, incoterm/destination if relevant.
- Fourth message (optional): a one-line ask ("Can you quote? Just reply here or send a PDF — whatever's easiest.")
- Do NOT reveal any target price or budget.
- Do NOT say you are a bot / AI / automated.
- Do NOT include an email-style signature block. A single sign-off "— Halal Food Service" at the end of the last message is enough.
- Use ${isExisting ? 'a warm, familiar tone (we have history with this supplier)' : 'a polite, professional first-contact tone (we have not worked together before, so briefly introduce ourselves in ONE line)'}.
- Respond in English unless the vendor name or country clearly suggests French, in which case use French.

Return ONLY a valid JSON array of strings. No other text.`;

            const userMessage = `Vendor: ${vendor.CardName}${vendor.country ? ` (${vendor.country})` : ''}
Source: ${vendor._source}
Previous orders with us: ${vendor.performanceMetrics?.totalOrders || 0}

RFQ ${rfq.rfqNumber}:
Items:
${itemsList}

Key terms:
- Quotation deadline: ${dueDate || 'asap'}
- Needed by: ${deliveryDate || 'soon'}
- Incoterm: ${rfq.incoterm || 'EXW'}
- Destination: ${rfq.destination || 'Paris, France'}
- Payment terms: ${rfq.paymentTermsPreference || 'Net 30'}
${customMessage ? `\nExtra note from buyer: ${customMessage}` : ''}

Generate the opening WhatsApp conversation as a JSON array.`;

            const response = await this.callLLM(systemPrompt, userMessage);
            const text = this.extractText(response);
            const parsed = this._tryParseArray(text);
            if (Array.isArray(parsed) && parsed.length >= 2) {
                return parsed.map(s => String(s).slice(0, 950));
            }
        } catch (err) {
            this.logError('LLM opening composition failed, falling back to template:', err);
        }

        // Fallback template (used if LLM fails)
        const intro = isExisting
            ? `Hi ${vendor.CardName} 👋 Halal Food Service here — hope you're doing well!`
            : `Hello ${vendor.CardName}, this is Halal Food Service — a halal food wholesaler based in Paris. Hope it's ok to reach out here.`;

        const msgs = [
            intro,
            `We're putting together a new RFQ and would love your pricing on the below:\n\n${itemsList}`,
            `Key terms:\n• Quotation by: ${dueDate}\n• Delivery by: ${deliveryDate}\n• Incoterm: ${rfq.incoterm || 'EXW'}\n• Destination: ${rfq.destination || 'Paris, France'}\n• Payment: ${rfq.paymentTermsPreference || 'Net 30'}`,
            `Can you send over your best offer? You can reply right here or share a PDF — whatever's easiest. Thanks! — Halal Food Service`,
        ];
        if (customMessage && customMessage.trim()) {
            msgs.splice(1, 0, customMessage.trim().slice(0, 400));
        }
        return msgs;
    }

    _tryParseArray(text) {
        if (!text) return null;
        try {
            return JSON.parse(text.trim());
        } catch {
            const match = text.match(/\[[\s\S]*\]/);
            if (match) {
                try { return JSON.parse(match[0]); } catch { return null; }
            }
            return null;
        }
    }

    async _updateVendorStatus(rfq, vendor, status, messageId, notes, openingMessages) {
        const vendorCode = vendor.CardCode;
        let vendorContact = rfq.vendorsContacted.find(v => v.vendorCode === vendorCode);

        if (!vendorContact) {
            let vendorSource = 'SAP';
            if (vendor._isNewSupplier) vendorSource = 'NEW_SUPPLIER';
            else if (vendor._isPDA) vendorSource = 'PDA_SCRAPER';

            rfq.vendorsContacted.push({
                vendorCode,
                vendorName: vendor.CardName,
                email: vendor.email,
                phone: vendor.phone,
                status,
                sentDate: status === 'sent' ? new Date() : null,
                vendorSource,
                whatsappMessageId: messageId || undefined,
                whatsappSentDate: status === 'sent' ? new Date() : undefined,
                notes: notes || undefined,
            });
            vendorContact = rfq.vendorsContacted[rfq.vendorsContacted.length - 1];
        } else {
            vendorContact.status = status;
            if (status === 'sent') {
                vendorContact.sentDate = new Date();
                vendorContact.whatsappMessageId = messageId || vendorContact.whatsappMessageId;
                vendorContact.whatsappSentDate = new Date();
                if (!vendorContact.phone && vendor.phone) vendorContact.phone = vendor.phone;
            }
            if (notes) vendorContact.notes = notes;
        }

        if (openingMessages?.length) {
            if (!vendorContact.whatsappHistory) vendorContact.whatsappHistory = [];
            const ts = new Date();
            for (const msg of openingMessages) {
                vendorContact.whatsappHistory.push({
                    direction: 'outgoing',
                    message: msg,
                    timestamp: ts,
                    messageSid: messageId,
                });
            }
        }

        rfq.markModified('vendorsContacted');
        await rfq.save();
    }
}

module.exports = new WhatsappOutboundAgent();
