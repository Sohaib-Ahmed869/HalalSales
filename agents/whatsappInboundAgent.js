// agents/whatsappInboundAgent.js
// Conversational RFQ negotiation over WhatsApp (Meta Cloud API).
// Equivalent to inboundAgent.js (email) but tuned for short, chat-style replies.

const { BaseAgent } = require('./baseAgent');
const RFQ = require('../models/RFQ');
const WhatsAppMessage = require('../models/WhatsAppMessage');
const whatsappBusinessApi = require('../services/whatsappBusinessApi');
const whatsappOutboundAgent = require('./whatsappOutboundAgent');
const {
    getCompanyContext,
    getProductContext,
    formatProductContextForPrompt,
    buildNegotiationAnalysis,
    formatNegotiationAnalysis,
} = require('../services/knowledgeBase');

const TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'classify_message',
            description: 'Classify the intent of the vendor WhatsApp message',
            parameters: {
                type: 'object',
                properties: {
                    classification: {
                        type: 'string',
                        enum: ['greeting', 'quotation', 'question', 'decline', 'partial_quote', 'out_of_office', 'acknowledgement', 'unclear'],
                    },
                    confidence: { type: 'number' },
                    reasoning: { type: 'string' },
                    detectedLanguage: { type: 'string', description: 'ISO code: en, fr, ar, etc.' },
                },
                required: ['classification', 'confidence', 'reasoning', 'detectedLanguage'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'extract_quotation',
            description: 'Extract structured pricing data from the vendor WhatsApp conversation. Only call this when a real price is present.',
            parameters: {
                type: 'object',
                properties: {
                    quotedItems: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                productName: { type: 'string' },
                                quantity: { type: 'number' },
                                unit: { type: 'string' },
                                unitPrice: { type: 'number' },
                                totalPrice: { type: 'number' },
                                currency: { type: 'string' },
                            },
                            required: ['productName'],
                        },
                    },
                    totalQuotedAmount: { type: 'number' },
                    currency: { type: 'string' },
                    deliveryTimeInDays: { type: 'number' },
                    paymentTerms: { type: 'string' },
                    validityPeriod: { type: 'string' },
                    additionalNotes: { type: 'string' },
                    missingItems: { type: 'array', items: { type: 'string' } },
                },
                required: ['quotedItems', 'totalQuotedAmount', 'currency'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'negotiate_price',
            description: 'Analyze quoted prices against internal target prices and decide per-item negotiation strategy',
            parameters: {
                type: 'object',
                properties: {
                    itemDecisions: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                productName: { type: 'string' },
                                quotedPrice: { type: 'number' },
                                targetPrice: { type: 'number' },
                                gapPercent: { type: 'number' },
                                itemDecision: { type: 'string', enum: ['accept', 'counter', 'missing'] },
                                currency: { type: 'string' },
                            },
                            required: ['productName', 'itemDecision'],
                        },
                    },
                    overallDecision: {
                        type: 'string',
                        enum: ['accept_all', 'accept_partial_counter_rest', 'counter_all', 'reject', 'request_complete_quote', 'escalate_to_human'],
                    },
                    negotiationRound: { type: 'number' },
                    reasoning: { type: 'string' },
                },
                required: ['itemDecisions', 'overallDecision', 'negotiationRound', 'reasoning'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'send_whatsapp_reply',
            description: 'Send one or more short WhatsApp messages back to the vendor. Each message will be delivered as a separate WhatsApp bubble. Keep each message conversational and under 400 chars. Usually 1–3 messages is enough.',
            parameters: {
                type: 'object',
                properties: {
                    messages: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Array of 1–3 short chat messages to send in order',
                    },
                    replyToMessageId: {
                        type: 'string',
                        description: 'Meta message ID to quote-reply to (optional)',
                    },
                },
                required: ['messages'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'update_rfq_vendor',
            description: 'Update the vendor entry on the RFQ (status, notes, quotation data)',
            parameters: {
                type: 'object',
                properties: {
                    status: { type: 'string', enum: ['sent', 'opened', 'responded', 'declined'] },
                    notes: { type: 'string' },
                    negotiationStatus: {
                        type: 'string',
                        enum: ['awaiting_initial_quote', 'negotiating', 'awaiting_admin_approval', 'accepted', 'rejected', 'stalled'],
                    },
                },
                required: ['status'],
            },
        },
    },
];

class WhatsappInboundAgent extends BaseAgent {
    constructor() {
        super('WA-Inbound');
        // Dedup: messages processed in-memory this run
        this._processedMessageIds = new Set();
        // Per-conversation serialization. Inbound webhooks are fire-and-forget
        // (setImmediate), so a vendor sending a burst ("...?" then "are you
        // there") would otherwise spawn concurrent handlers that each load the
        // same RFQ doc, run their own LLM loop, and clobber each other's
        // rfq.save() (last-write-wins on the whatsappHistory array). We chain
        // handling per phone number so messages are processed strictly in order.
        this._conversationQueues = new Map();
    }

    /**
     * Public entry point. Serializes processing per conversation so concurrent
     * inbound webhooks for the same vendor can't race on the shared RFQ doc.
     */
    async handleIncomingMessage(params) {
        const key = String(params?.conversationId || '').replace(/\D/g, '') || 'unknown';
        const prev = this._conversationQueues.get(key) || Promise.resolve();

        // Chain the actual work after whatever is already queued for this phone.
        const result = prev
            .catch(() => {}) // a prior failure must not break the chain
            .then(() => this._processIncomingMessage(params));

        // The stored tail swallows rejections so the next message still runs.
        const tail = result.catch(() => {});
        this._conversationQueues.set(key, tail);

        // Drop the map entry once the chain drains (no newer message queued).
        tail.then(() => {
            if (this._conversationQueues.get(key) === tail) {
                this._conversationQueues.delete(key);
            }
        });

        return result;
    }

    /**
     * Process a single incoming WhatsApp message that belongs to an active RFQ.
     * Called from the Meta webhook handler in whatsapp.controller.js.
     *
     * @param {Object} params
     * @param {String} params.conversationId - e.g. "+33612345678"
     * @param {Object} params.incomingMessage - the WhatsAppMessage DB doc (lean / plain)
     * @param {Object} params.extraText - optional already-extracted text from media
     */
    async _processIncomingMessage({ conversationId, incomingMessage, extraText = '' }) {
        if (!incomingMessage?.messageId) return { handled: false, reason: 'missing_messageId' };
        if (this._processedMessageIds.has(incomingMessage.messageId)) {
            return { handled: false, reason: 'already_processed_in_session' };
        }
        this._processedMessageIds.add(incomingMessage.messageId);

        // Find the active RFQ linked to this phone number.
        // Phone is stored with `+` prefix in RFQ.vendorsContacted[].phone via outbound agent.
        const digits = conversationId.replace(/\D/g, '');
        const phoneVariants = [conversationId, '+' + digits, digits];

        // IMPORTANT: keep this lookup forgiving. The conversation is identified
        // by the vendor's phone number, NOT by transient status fields. Earlier
        // versions gated on rfq.status in ['sent','in_progress'] and vendor
        // status in ['sent','opened','responded']; once the agent marked a
        // single-vendor RFQ 'completed' (or a vendor 'declined'/'responded'
        // dropped out of the set) the lookup stopped matching and the agent went
        // permanently silent mid-conversation. We now match any live RFQ for the
        // phone and only exclude clearly terminal states.
        const rfq = await RFQ.findOne({
            status: { $in: ['sent', 'in_progress'] },
            'vendorsContacted': {
                $elemMatch: {
                    phone: { $in: phoneVariants },
                    status: { $ne: 'declined' },
                },
            },
        }).sort({ dateIssued: -1 });

        if (!rfq) {
            this.log(`No active RFQ found for ${conversationId}`);
            this.addToActionLog('wa_inbound_no_rfq', { conversationId });
            return { handled: false, reason: 'no_active_rfq' };
        }

        const vendor = rfq.vendorsContacted.find(v => {
            const p = (v.phone || '').replace(/\D/g, '');
            return p === digits;
        });

        if (!vendor) {
            return { handled: false, reason: 'vendor_not_in_rfq' };
        }

        // Dedup via DB: record this message ID against the RFQ so restarts don't reprocess.
        if (!rfq.metadata) rfq.metadata = {};
        if (!rfq.metadata.processedWhatsAppIds) rfq.metadata.processedWhatsAppIds = [];
        if (rfq.metadata.processedWhatsAppIds.includes(incomingMessage.messageId)) {
            return { handled: false, reason: 'already_processed_in_db' };
        }
        rfq.metadata.processedWhatsAppIds.push(incomingMessage.messageId);
        rfq.markModified('metadata');

        const inboundText = this._extractTextFromMessage(incomingMessage, extraText);

        // Append to vendor's whatsappHistory
        if (!vendor.whatsappHistory) vendor.whatsappHistory = [];
        vendor.whatsappHistory.push({
            direction: 'incoming',
            message: inboundText,
            timestamp: incomingMessage.timestamp || new Date(),
            messageSid: incomingMessage.messageId,
            mediaUrl: incomingMessage.content?.mediaUrl || null,
        });
        vendor.rawWhatsAppContent = {
            body: inboundText,
            receivedDate: new Date(),
            messageSid: incomingMessage.messageId,
            mediaUrl: incomingMessage.content?.mediaUrl || null,
        };
        rfq.markModified('vendorsContacted');
        await rfq.save();

        // Two-phase send: if the vendor has queued opening messages parked on
        // them, the 24-hour customer-service window has just been opened by
        // this very inbound. Dispatch the queued conversation now, mark them
        // as awaiting the initial quote, and DO NOT run the AI tool loop on
        // this first reply (it's usually a generic "ok" / button tap from the
        // template — no useful negotiation signal yet).
        if (
            vendor.negotiationStatus === 'awaiting_template_reply' &&
            Array.isArray(vendor.pendingOutboundMessages) &&
            vendor.pendingOutboundMessages.length > 0
        ) {
            try {
                const flushResult = await whatsappOutboundAgent.flushPendingForVendor({
                    rfq,
                    vendor,
                });
                this.addToActionLog('wa_inbound_flushed_queue', {
                    rfqNumber: rfq.rfqNumber,
                    vendorName: vendor.vendorName,
                    messageId: incomingMessage.messageId,
                    ...flushResult,
                });
                return { handled: true, flushedPending: true, ...flushResult };
            } catch (err) {
                this.logError('Failed to flush queued opening messages:', err);
                this.addToActionLog('wa_inbound_flush_error', {
                    rfqNumber: rfq.rfqNumber,
                    vendorName: vendor.vendorName,
                    error: err.message,
                });
                // Fall through to the AI loop as a best-effort fallback so we
                // don't ghost the vendor entirely.
            }
        }

        // Run the conversational tool loop
        try {
            await this._runAgentLoop({ rfq, vendor, inboundText, incomingMessage });
            this.addToActionLog('wa_inbound_handled', {
                rfqNumber: rfq.rfqNumber,
                vendorName: vendor.vendorName,
                messageId: incomingMessage.messageId,
            });
            return { handled: true };
        } catch (err) {
            this.logError('WhatsApp agent loop failed:', err);
            this.addToActionLog('wa_inbound_error', {
                rfqNumber: rfq.rfqNumber,
                vendorName: vendor.vendorName,
                error: err.message,
            });
            return { handled: false, reason: 'agent_error', error: err.message };
        }
    }

    _extractTextFromMessage(msg, extraText) {
        const content = msg.content || {};
        if (content.text) return content.text;
        if (content.caption) return content.caption;
        if (content.interactive?.button_reply?.title) return content.interactive.button_reply.title;
        if (content.interactive?.list_reply?.title) return content.interactive.list_reply.title;
        if (extraText) return extraText;
        return `[${msg.messageType} message received]`;
    }

    async _runAgentLoop({ rfq, vendor, inboundText, incomingMessage }) {
        const currentRound = vendor.negotiationRound || 0;
        const negStatus = vendor.negotiationStatus || 'awaiting_initial_quote';

        // ===== Build context =====
        const rfqItemsSummary = rfq.items.map((item, i) => {
            const parts = [`${i + 1}. ${item.productName} — ${item.quantity} ${item.unit}`];
            if (item.specifications) parts.push(`Specs: ${item.specifications}`);
            if (item.additionalInfo) parts.push(`Info: ${item.additionalInfo}`);
            return parts.join(' | ');
        }).join('\n');

        const targetPricesSummary = rfq.items.map((item, i) =>
            `${i + 1}. ${item.productName} — Target: ${item.targetPrice || item.estimatedPrice || 'N/A'} per ${item.unit}`
        ).join('\n');

        // Product intelligence
        let productContextStr = '';
        let negotiationAnalysisStr = '';
        try {
            const productContext = await getProductContext(rfq.items);
            productContextStr = formatProductContextForPrompt(productContext);
            if (vendor.quotationData?.quotedItems?.length > 0) {
                const analysis = buildNegotiationAnalysis(rfq.items, vendor.quotationData.quotedItems, productContext);
                negotiationAnalysisStr = formatNegotiationAnalysis(analysis);
            }
        } catch (err) {
            this.logError('Failed to load product context:', err);
        }

        // Full conversation so far (take last ~20 messages for context)
        const recentHistory = (vendor.whatsappHistory || []).slice(-20).map(h => {
            const who = h.direction === 'incoming' ? 'VENDOR' : 'US';
            const when = h.timestamp ? new Date(h.timestamp).toISOString() : '';
            return `[${when}] ${who}: ${h.message}`;
        }).join('\n');

        const negHistory = (vendor.negotiationHistory || []).map(h =>
            `Round ${h.round}: vendor offered ${h.offeredPrice ?? 'N/A'}, we ${h.ourCounterOffer ? 'countered ' + h.ourCounterOffer : 'replied'} — "${(h.message || '').slice(0, 200)}"`
        ).join('\n');

        const companyContext = getCompanyContext();

        const systemPrompt = `You are the AI procurement negotiator for Halal Food Service, handling a vendor RFQ conversation over WhatsApp.

This is WHATSAPP CHAT — not email. Your replies must be:
- SHORT. Most messages ≤ 200 chars. Never send a wall of text.
- Conversational, warm, human. Contractions are fine. A single well-placed emoji (👍 ✅ 🙏) is OK occasionally but don't overdo it.
- Split into 1–3 small bubbles if needed, using the \`send_whatsapp_reply.messages\` array. Usually ONE short message is enough.
- Match the vendor's language (English / French / Arabic / etc.).
- Match their formality. If they write casually, reply casually. If they write formally, stay polite and professional.
- No email-style signature. A natural sign-off like "Thanks!" or "— HFS" is fine, but only sometimes.
- NEVER say you are a bot or AI. You are "Halal Food Service procurement".

===== WHO YOU ARE =====
${companyContext}

===== RFQ DETAILS =====
- RFQ Number: ${rfq.rfqNumber}
- Quotation Due: ${new Date(rfq.quotationDueDate).toLocaleDateString('en-GB')}
- Delivery By: ${new Date(rfq.deliveryBy).toLocaleDateString('en-GB')}
- Payment Terms: ${rfq.paymentTermsPreference || 'Net 30'}
- Incoterm: ${rfq.incoterm || 'EXW'}
- Destination: ${rfq.destination || 'Paris, France'}

Items requested (OK to share):
${rfqItemsSummary}

===== CONFIDENTIAL (NEVER share with vendor) =====
Internal target prices:
${targetPricesSummary}

Product intelligence:
${productContextStr || 'No historical data available.'}

${negotiationAnalysisStr ? `Current item analysis:\n${negotiationAnalysisStr}\n` : ''}
===== END CONFIDENTIAL =====

===== VENDOR CONTEXT =====
Vendor: ${vendor.vendorName} (${vendor.vendorCode})
Source: ${vendor.vendorSource || 'SAP'}
Current negotiation round: ${currentRound}
Current negotiation status: ${negStatus}
${negHistory ? `Past rounds:\n${negHistory}` : 'First time we\'re hearing from them.'}

===== CONVERSATION SO FAR (most recent 20 messages) =====
${recentHistory || '(no prior messages)'}

===== ABSOLUTE RULES =====
- NEVER reveal target prices, internal budgets, or pricing data.
- NEVER quote other suppliers' prices or names.
- NEVER say "our target is X" or "we were hoping for X".
- NEVER promise or confirm the order. Only an admin can finalise a deal. When you recommend acceptance, the vendor gets a holding reply like "thanks, let me confirm internally and come back to you shortly".
- NEVER reveal you are an AI.

===== HANDLING BY INTENT =====
After calling classify_message, handle based on intent:

- greeting / acknowledgement → Reply warmly and briefly. Nudge them for the quote if we're still waiting. e.g. "Hi! 👋 Looking forward to your numbers whenever they're ready." For update_rfq_vendor use status='opened' (NOT 'responded' — they haven't quoted yet).

- question →
   * If it's about the RFQ (specs, quantities, delivery, terms) → answer clearly from the RFQ details above, keep it short.
   * If it's about us ("who are you?", "where are you based?") → answer from the company context, one sentence.
   * Never make up specifics you don't have.
   * For update_rfq_vendor use status='opened' (NOT 'responded' — answering their question is not a quotation).

- quotation / partial_quote → MUST do this:
   1. Call extract_quotation with the parsed prices. Be careful: "per kg" / "each" / "/unit" = unitPrice. "total" / "lot" = totalPrice. Never fill both unless both are explicitly given.
   2. Call negotiate_price with per-item decisions (accept / counter / missing) AND an overallDecision.
   3. Call update_rfq_vendor with the right status. For accept_all, status='responded' AND negotiationStatus='awaiting_admin_approval'. For counter decisions, status stays 'sent' and negotiationStatus='negotiating'. For reject, status='responded' and negotiationStatus='rejected'.
   4. Send a reply via send_whatsapp_reply:
      * accept_all → HOLDING MESSAGE ONLY (e.g., "Perfect, thanks for this! Let me confirm internally and I'll come back to you shortly 🙏"). DO NOT say "accepted" or "approved".
      * accept_partial_counter_rest → short acknowledgement of the good items BY NAME + short ask for a better number on the specific expensive ones BY NAME. Never quote a target number.
      * counter_all → gently push back on the specific items, referencing volume and market conditions. 1–2 short messages.
      * reject → polite, keep door open for future, no specifics.
      * request_complete_quote → briefly ask for the missing items by name.
      * escalate_to_human → just call update_rfq_vendor with notes="NEEDS HUMAN REVIEW" and DO NOT send a reply.

- decline → Acknowledge politely, thank them, keep relationship open, ONE short message. Call update_rfq_vendor status='declined'.

- out_of_office → Note it in update_rfq_vendor, do NOT send a reply.

- unclear → Ask a short, friendly clarifying question. ONE message. For update_rfq_vendor use status='opened'.

IMPORTANT about status: only use status='responded' when the vendor has actually sent a price/quotation (intent quotation or partial_quote) or you recorded a real negotiation decision. For greetings, questions, small talk and acknowledgements use status='opened'. Use 'declined' ONLY when they explicitly refuse to quote. Picking 'responded'/'declined' too early can close the conversation prematurely.

===== NEGOTIATION STYLE BY ROUND =====
Round 0 (first quote received):
- All items at/below target → recommend accept_all (status='responded', negotiationStatus='awaiting_admin_approval'), send HOLDING message only.
- Some close, some 5–15% over → accept_partial_counter_rest. Acknowledge the good ones, gently push on the others. e.g. "Thanks! The pricing on [A] and [B] looks good. Is there any flex on [C]? We're comparing several offers and it's a bit higher than what we're seeing."
- 15–30% over → counter_all or partial. Reference volume and market, ask for revised pricing.
- >30% over → firmer pushback, still polite.

Round 1 (second quote):
- Cite volume commitment ("we order these regularly"), hint at competitive offers, offer small trade-offs (payment terms, delivery flex) in exchange for better pricing.

Round 2 (third attempt):
- Final-best-price framing. Accept what's good, park what's still too expensive.

Round 3+:
- If still far off → polite close, keep door open for future.

===== PRICE EXTRACTION RULES =====
- "unit price", "per kg", "each", "/unit", "EUR X/kg" → unitPrice. Do NOT also set totalPrice.
- "total", "grand total", "lot", "bundle" → totalPrice. Do NOT also set unitPrice.
- When ambiguous, prefer totalPrice and add a short note in additionalNotes. The server will compute the missing side.
- If they only sent a number with no context, ask them to clarify ("Sorry — is that per kg or total?").

===== ALWAYS CALL TOOLS IN THIS ORDER =====
1. classify_message
2. If quotation/partial_quote → extract_quotation, then negotiate_price
3. update_rfq_vendor
4. send_whatsapp_reply (UNLESS decision = escalate_to_human or intent = out_of_office)

Send EXACTLY one reply per incoming message (one call to send_whatsapp_reply with 1–3 bubble messages).`;

        const userMessage = `New inbound WhatsApp message from vendor ${vendor.vendorName}:

Meta messageId: ${incomingMessage.messageId}
Received at: ${incomingMessage.timestamp || new Date()}
Message type: ${incomingMessage.messageType}
${incomingMessage.content?.mediaUrl ? `Media: ${incomingMessage.content.mediaUrl}\n` : ''}
Content:
${inboundText}

Process this message now.`;

        const toolExecutors = this._buildToolExecutors(rfq, vendor, incomingMessage);

        await this.runToolLoop(systemPrompt, userMessage, TOOL_DEFINITIONS, toolExecutors, 8);
    }

    _buildToolExecutors(rfq, vendor, incomingMessage) {
        return {
            classify_message: async (input) => {
                this.log(`Classified ${incomingMessage.messageId} as ${input.classification} (conf ${input.confidence})`);
                this.addToActionLog('wa_classified', {
                    classification: input.classification,
                    vendor: vendor.vendorName,
                    rfqNumber: rfq.rfqNumber,
                });
                return { success: true, classification: input.classification };
            },

            extract_quotation: async (input) => {
                const quotedItems = input.quotedItems || [];

                for (const qi of quotedItems) {
                    if (qi.unitPrice && (!qi.quantity || qi.quantity === 0)) {
                        const matchName = (qi.productName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                        const rfqMatch = rfq.items.find(ri => {
                            const riName = (ri.productName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                            return riName.includes(matchName) || matchName.includes(riName) ||
                                riName.split(/\s+/).some(w => w.length > 3 && matchName.includes(w));
                        });
                        if (rfqMatch) {
                            qi.quantity = rfqMatch.quantity;
                            qi.unit = qi.unit || rfqMatch.unit;
                        }
                    }
                    if (qi.unitPrice && qi.quantity && (!qi.totalPrice || qi.totalPrice === 0)) {
                        qi.totalPrice = Math.round(qi.unitPrice * qi.quantity * 100) / 100;
                    }
                    if (qi.totalPrice && qi.quantity && (!qi.unitPrice || qi.unitPrice === 0)) {
                        qi.unitPrice = Math.round(qi.totalPrice / qi.quantity * 100) / 100;
                    }
                }

                let totalQuotedAmount = input.totalQuotedAmount || 0;
                if (!totalQuotedAmount || totalQuotedAmount === 0) {
                    totalQuotedAmount = quotedItems.reduce((sum, qi) => sum + (qi.totalPrice || 0), 0);
                    totalQuotedAmount = Math.round(totalQuotedAmount * 100) / 100;
                }

                vendor.quotationData = {
                    quotedItems,
                    totalQuotedAmount,
                    currency: input.currency || 'EUR',
                    deliveryTimeInDays: input.deliveryTimeInDays,
                    paymentTerms: input.paymentTerms,
                    validityPeriod: input.validityPeriod,
                    additionalNotes: input.additionalNotes,
                    isValidQuotation: true,
                    parsingStatus: 'success',
                    source: 'whatsapp',
                };
                vendor.quotedTotal = totalQuotedAmount;
                if (input.paymentTerms) vendor.paymentTerms = input.paymentTerms;

                rfq.markModified('vendorsContacted');
                await rfq.save();

                this.log(`Extracted quotation: ${input.currency} ${totalQuotedAmount} (${quotedItems.length} items)`);
                this.addToActionLog('wa_quotation_extracted', {
                    rfqNumber: rfq.rfqNumber,
                    vendor: vendor.vendorName,
                    total: totalQuotedAmount,
                    currency: input.currency,
                    items: quotedItems.length,
                });

                return {
                    success: true,
                    totalQuotedAmount,
                    currency: input.currency,
                    itemsExtracted: quotedItems.length,
                    missingItems: input.missingItems || [],
                };
            },

            negotiate_price: async (input) => {
                const decision = input.overallDecision;
                const round = input.negotiationRound || 0;

                const totalOffered = (input.itemDecisions || [])
                    .filter(d => d.quotedPrice)
                    .reduce((sum, d) => sum + d.quotedPrice, 0);

                if (!vendor.negotiationHistory) vendor.negotiationHistory = [];
                vendor.negotiationHistory.push({
                    round,
                    offeredPrice: totalOffered,
                    ourCounterOffer: decision.includes('accept') ? totalOffered : null,
                    timestamp: new Date(),
                    message: `Decision: ${decision}`,
                });

                vendor.negotiationRound = round + 1;

                let triggerAdminNotification = false;
                let notificationType = null;
                let notificationTitle = null;
                let notificationMessage = null;

                switch (decision) {
                    case 'accept_all':
                        vendor.negotiationStatus = 'awaiting_admin_approval';
                        vendor.status = 'responded';
                        vendor.pendingAdminReview = true;
                        vendor.botRecommendation = {
                            decision: 'accept',
                            reasoning: (input.reasoning || '').substring(0, 1000),
                            recommendedAt: new Date(),
                            suggestedTotalPrice: totalOffered,
                        };
                        triggerAdminNotification = true;
                        notificationType = 'rfq_needs_attention';
                        notificationTitle = `WhatsApp quotation ready for approval — ${rfq.rfqNumber}`;
                        notificationMessage = `${vendor.vendorName} quoted €${totalOffered?.toLocaleString() || 'N/A'} over WhatsApp for ${rfq.rfqNumber}. AI recommends acceptance — please review.`;
                        break;
                    case 'accept_partial_counter_rest':
                    case 'counter_all':
                    case 'request_complete_quote':
                        vendor.negotiationStatus = 'negotiating';
                        break;
                    case 'reject':
                        vendor.negotiationStatus = 'rejected';
                        vendor.status = 'responded';
                        break;
                    case 'escalate_to_human':
                        vendor.negotiationStatus = 'stalled';
                        vendor.pendingAdminReview = true;
                        vendor.notes = (vendor.notes || '') + ' | WA NEEDS HUMAN REVIEW — ' + (input.reasoning || '').substring(0, 200);
                        triggerAdminNotification = true;
                        notificationType = 'rfq_stalled';
                        notificationTitle = `WhatsApp negotiation stalled — ${rfq.rfqNumber}`;
                        notificationMessage = `WhatsApp negotiation with ${vendor.vendorName} needs human intervention. Reason: ${(input.reasoning || '').substring(0, 200)}`;
                        break;
                }

                if (!rfq.metadata) rfq.metadata = {};
                if (!rfq.metadata.whatsappNegotiationDetails) rfq.metadata.whatsappNegotiationDetails = {};
                rfq.metadata.whatsappNegotiationDetails[vendor.vendorCode] = {
                    lastRound: round,
                    lastDecision: decision,
                    itemDecisions: input.itemDecisions,
                    timestamp: new Date(),
                };

                rfq.markModified('vendorsContacted');
                rfq.markModified('metadata');
                await rfq.save();

                if (triggerAdminNotification && notificationType) {
                    try {
                        const NotificationService = require('../utils/notificationService');
                        await NotificationService.notifyAdminsAboutRFQ({
                            rfq,
                            vendor,
                            type: notificationType,
                            title: notificationTitle,
                            message: notificationMessage,
                        });
                    } catch (notifErr) {
                        this.log(`Failed to send admin notification: ${notifErr.message}`);
                    }
                }

                this.addToActionLog('wa_negotiation_decision', {
                    rfqNumber: rfq.rfqNumber,
                    vendor: vendor.vendorName,
                    decision,
                    round,
                });

                return {
                    success: true,
                    decision,
                    round,
                    negotiationStatus: vendor.negotiationStatus,
                };
            },

            send_whatsapp_reply: async (input) => {
                const messages = (input.messages || []).filter(m => m && String(m).trim()).slice(0, 4);
                if (messages.length === 0) return { success: false, error: 'No messages to send' };

                const phone = vendor.phone;
                if (!phone) return { success: false, error: 'Vendor has no phone number' };

                const sendResults = await whatsappBusinessApi.sendSequence({
                    to: phone,
                    messages,
                    delayMs: 700,
                    replyToMessageId: input.replyToMessageId,
                    aiAgentContext: {
                        rfqId: rfq._id.toString(),
                        rfqNumber: rfq.rfqNumber,
                        vendorCode: vendor.vendorCode,
                        stage: 'negotiation',
                    },
                });

                // Mirror into vendor.whatsappHistory
                if (!vendor.whatsappHistory) vendor.whatsappHistory = [];
                const now = new Date();
                for (let i = 0; i < messages.length; i++) {
                    const sent = sendResults[i];
                    vendor.whatsappHistory.push({
                        direction: 'outgoing',
                        message: messages[i],
                        timestamp: now,
                        messageSid: sent?.messageId || null,
                    });
                }
                rfq.markModified('vendorsContacted');
                await rfq.save();

                const sentCount = sendResults.filter(r => r.success).length;
                this.addToActionLog('wa_reply_sent', {
                    rfqNumber: rfq.rfqNumber,
                    vendor: vendor.vendorName,
                    messageCount: sentCount,
                });

                return {
                    success: sentCount > 0,
                    sentCount,
                    results: sendResults,
                };
            },

            update_rfq_vendor: async (input) => {
                if (input.status) vendor.status = input.status;
                if (input.notes) vendor.notes = (vendor.notes || '') + ' | ' + input.notes;
                if (input.negotiationStatus) vendor.negotiationStatus = input.negotiationStatus;

                // Keep the RFQ live while a conversation is ongoing. Do NOT
                // auto-flip it to 'completed' just because vendors are marked
                // 'responded'/'declined' — "responded" only means they sent
                // something, not that a deal is done, and a 'completed' RFQ drops
                // out of the inbound lookup and permanently ghosts the vendor.
                // Completion happens only when an admin selects a winning vendor.
                if (rfq.status === 'sent') rfq.status = 'in_progress';

                rfq.markModified('vendorsContacted');
                await rfq.save();

                return { success: true, rfqStatus: rfq.status, vendorStatus: vendor.status };
            },
        };
    }
}

module.exports = new WhatsappInboundAgent();
