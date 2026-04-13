// agents/inboundAgent.js
const { BaseAgent } = require('./baseAgent');
const RFQ = require('../models/RFQ');
const gmailService = require('../services/gmailService');
const { extractTextFromMultiplePDFs } = require('../utils/pdfExtractor');
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
            name: 'classify_email',
            description: 'Classify the vendor email intent: quotation, question, decline, partial_quote, out_of_office, or unclear',
            parameters: {
                type: 'object',
                properties: {
                    classification: {
                        type: 'string',
                        enum: ['quotation', 'question', 'decline', 'partial_quote', 'out_of_office', 'unclear'],
                    },
                    confidence: { type: 'number', description: 'Confidence 0-1' },
                    reasoning: { type: 'string' },
                    detectedLanguage: { type: 'string', description: 'Language code: en, fr, ar, etc.' },
                },
                required: ['classification', 'confidence', 'reasoning', 'detectedLanguage'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'extract_quotation',
            description: 'Extract structured pricing data from vendor email and/or PDF attachment',
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
                    deliveryDate: { type: 'string' },
                    paymentTerms: { type: 'string' },
                    validityPeriod: { type: 'string' },
                    additionalNotes: { type: 'string' },
                    missingItems: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'RFQ items not quoted by the vendor',
                    },
                },
                required: ['quotedItems', 'totalQuotedAmount', 'currency'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'send_reply',
            description: 'Compose and send a reply email to the vendor',
            parameters: {
                type: 'object',
                properties: {
                    to: { type: 'string', description: 'Vendor email address' },
                    subject: { type: 'string' },
                    body: { type: 'string', description: 'Plain text reply body' },
                    htmlBody: { type: 'string', description: 'HTML reply body' },
                },
                required: ['to', 'subject', 'body'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'update_rfq_vendor',
            description: 'Update vendor quotation data and status in the RFQ MongoDB document',
            parameters: {
                type: 'object',
                properties: {
                    rfqId: { type: 'string' },
                    vendorEmail: { type: 'string' },
                    status: { type: 'string', enum: ['responded', 'declined', 'sent'] },
                    quotationData: { type: 'object', description: 'Full quotation data object' },
                    notes: { type: 'string' },
                },
                required: ['rfqId', 'vendorEmail', 'status'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'negotiate_price',
            description: 'Analyze quoted prices vs internal target prices and decide negotiation strategy per item. Called after extract_quotation. Make ITEM-LEVEL decisions — some items may be acceptable while others need negotiation.',
            parameters: {
                type: 'object',
                properties: {
                    itemDecisions: {
                        type: 'array',
                        description: 'Per-item analysis and decision',
                        items: {
                            type: 'object',
                            properties: {
                                productName: { type: 'string' },
                                quotedPrice: { type: 'number' },
                                targetPrice: { type: 'number' },
                                gapPercent: { type: 'number', description: 'How far above target in %. Negative = below target.' },
                                itemDecision: {
                                    type: 'string',
                                    enum: ['accept', 'counter', 'missing'],
                                    description: 'accept = at/below target; counter = above target; missing = not quoted',
                                },
                                currency: { type: 'string' },
                            },
                            required: ['productName', 'itemDecision'],
                        },
                    },
                    overallDecision: {
                        type: 'string',
                        enum: ['accept_all', 'accept_partial_counter_rest', 'counter_all', 'reject', 'request_complete_quote', 'escalate_to_human'],
                        description: 'accept_all = every item meets target; accept_partial_counter_rest = some good some need negotiation (acknowledge good ones, negotiate bad ones); counter_all = all above target; reject = 3+ rounds and still too far; request_complete_quote = missing items; escalate_to_human = complex',
                    },
                    negotiationRound: { type: 'number', description: 'Current round number (0 = first quote received)' },
                    counterMessage: { type: 'string', description: 'The negotiation reply to send. For partial accept: acknowledge acceptable items by name, then negotiate the specific items that are above target. Be SPECIFIC about which products need better pricing — do not be generic.' },
                    reasoning: { type: 'string', description: 'Internal reasoning for the decision' },
                },
                required: ['itemDecisions', 'overallDecision', 'negotiationRound', 'reasoning'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'mark_email_read',
            description: 'Mark a Gmail message as read by messageId',
            parameters: {
                type: 'object',
                properties: {
                    messageId: { type: 'string' },
                },
                required: ['messageId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'get_rfq_by_number',
            description: 'Fetch an RFQ document from MongoDB by its rfqNumber',
            parameters: {
                type: 'object',
                properties: {
                    rfqNumber: { type: 'string' },
                },
                required: ['rfqNumber'],
            },
        },
    },
];

class InboundAgent extends BaseAgent {
    constructor() {
        super('Inbound');
        // In-memory set of messageIds we've already processed this session
        // Prevents reprocessing if markAsRead has a delay
        this._processedMessageIds = new Set();
    }

    /**
     * Main entry point: check inbox for all active RFQs
     */
    async checkInbox() {
        this.log('Checking inbox for RFQ responses...');
        this.addToActionLog('check_inbox_started');

        try {
            const activeRFQs = await RFQ.find({
                status: { $in: ['sent', 'in_progress'] },
            });

            this.log(`Found ${activeRFQs.length} active RFQs to check`);

            let totalProcessed = 0;

            for (const rfq of activeRFQs) {
                const count = await this.checkRFQResponses(rfq);
                totalProcessed += count;
            }

            this.addToActionLog('check_inbox_completed', {
                activeRFQs: activeRFQs.length,
                emailsProcessed: totalProcessed,
            });

            this.log(`Inbox check complete. Processed ${totalProcessed} emails.`);
            return { activeRFQs: activeRFQs.length, emailsProcessed: totalProcessed };
        } catch (error) {
            this.logError('Error checking inbox:', error);
            this.addToActionLog('check_inbox_error', { error: error.message });
            throw error;
        }
    }

    /**
     * Check responses for a specific RFQ
     */
    async checkRFQResponses(rfq) {
        try {
            const emails = await gmailService.fetchRFQResponses(rfq.rfqNumber);

            if (emails.length === 0) {
                return 0;
            }

            this.log(`Found ${emails.length} unread email(s) for ${rfq.rfqNumber}`);

            // Build set of already-processed messageIds from DB
            const alreadyProcessedIds = new Set();
            if (rfq.metadata?.processedEmailIds) {
                rfq.metadata.processedEmailIds.forEach(id => alreadyProcessedIds.add(id));
            }

            let processedCount = 0;

            for (const email of emails) {
                // DEDUP CHECK 1: Already processed in DB (persisted across restarts)
                if (alreadyProcessedIds.has(email.messageId)) {
                    this.log(`Skipping already-processed email ${email.messageId}`);
                    await gmailService.markAsRead(email.messageId);
                    continue;
                }

                // DEDUP CHECK 2: Already processed this session (catches markAsRead delays)
                if (this._processedMessageIds.has(email.messageId)) {
                    this.log(`Skipping in-session duplicate ${email.messageId}`);
                    await gmailService.markAsRead(email.messageId);
                    continue;
                }

                // Extract PDF content if attachments present
                let pdfContent = '';
                if (email.attachments && email.attachments.length > 0) {
                    const pdfAttachments = email.attachments.filter(
                        a => a.mimeType === 'application/pdf' && a.size < 10485760
                    );

                    if (pdfAttachments.length > 0) {
                        try {
                            const pdfBuffers = pdfAttachments.map(pdf => ({
                                buffer: pdf.data,
                                filename: pdf.filename,
                            }));
                            pdfContent = await extractTextFromMultiplePDFs(pdfBuffers);
                            this.log(`Extracted ${pdfContent.length} chars from PDF(s)`);
                        } catch (pdfError) {
                            this.logError('PDF extraction failed:', pdfError);
                        }
                    }
                }

                await this.processEmail(rfq, email, pdfContent);
                processedCount++;
            }

            return processedCount;
        } catch (error) {
            this.logError(`Error checking RFQ ${rfq.rfqNumber}:`, error);
            return 0;
        }
    }

    /**
     * Process a single vendor email using OpenAI with function calling
     */
    async processEmail(rfq, email, pdfContent) {
        const extractEmailAddress = (str) => {
            const match = str.match(/<([^>]+)>/);
            return match ? match[1].trim().toLowerCase() : str.trim().toLowerCase();
        };

        const vendorEmail = extractEmailAddress(email.from);
        this.log(`Processing email from ${vendorEmail} for RFQ ${rfq.rfqNumber} (msgId: ${email.messageId})`);

        // Mark this messageId as processed IMMEDIATELY (before anything else)
        this._processedMessageIds.add(email.messageId);

        // Persist to DB so it survives restarts
        if (!rfq.metadata) rfq.metadata = {};
        if (!rfq.metadata.processedEmailIds) rfq.metadata.processedEmailIds = [];
        rfq.metadata.processedEmailIds.push(email.messageId);
        await rfq.save();

        // Find vendor in RFQ
        const vendor = rfq.vendorsContacted.find(
            v => v.email && v.email.trim().toLowerCase() === vendorEmail
        );

        if (!vendor) {
            this.log(`Unknown vendor: ${vendorEmail}, marking as read and skipping`);
            await gmailService.markAsRead(email.messageId);
            return;
        }

        // Store raw email content (append to history, don't overwrite)
        const emailBody = email.body?.trim() || email.htmlBody?.trim() || 'No content';
        vendor.rawEmailContent = {
            subject: email.subject || 'No subject',
            body: emailBody,
            htmlBody: email.htmlBody?.trim() || '',
            pdfContent: pdfContent || '',
            receivedDate: email.date,
            attachments: (email.attachments || []).map(a => a.filename),
        };
        vendor.responseDate = email.date;
        vendor.emailMessageId = email.messageId;
        rfq.markModified('vendorsContacted');
        await rfq.save();

        // Build conversation history from previous emails for context
        const previousEmails = (rfq.metadata.processedEmailIds || []).length;
        const conversationContext = previousEmails > 1
            ? `\nNOTE: This is email #${previousEmails} in the conversation with this vendor. Only respond to THIS specific email. Do NOT repeat answers to previous emails.`
            : '';

        // ====== KNOWLEDGE BASE: Load product intelligence ======
        let productContextStr = '';
        let negotiationAnalysisStr = '';
        try {
            const productContext = await getProductContext(rfq.items);
            productContextStr = formatProductContextForPrompt(productContext);

            // If vendor already has quotation data, build item-level analysis
            if (vendor.quotationData?.quotedItems?.length > 0) {
                const analysis = buildNegotiationAnalysis(rfq.items, vendor.quotationData.quotedItems, productContext);
                negotiationAnalysisStr = formatNegotiationAnalysis(analysis);
            }
        } catch (err) {
            this.logError('Failed to load product context:', err);
        }

        // ====== BUILD CONTEXT ======
        const rfqItemsSummary = rfq.items
            .map((item, i) => {
                const parts = [`${i + 1}. ${item.productName} — ${item.quantity} ${item.unit}`];
                if (item.specifications) parts.push(`Specs: ${item.specifications}`);
                if (item.additionalInfo) parts.push(`Info: ${item.additionalInfo}`);
                return parts.join(' | ');
            })
            .join('\n');

        const targetPricesSummary = rfq.items
            .map((item, i) => `${i + 1}. ${item.productName} — Target: ${item.targetPrice || item.estimatedPrice || 'N/A'} per ${item.unit}`)
            .join('\n');

        const currentRound = vendor.negotiationRound || 0;
        const negStatus = vendor.negotiationStatus || 'awaiting_initial_quote';
        const negHistory = (vendor.negotiationHistory || [])
            .map(h => `Round ${h.round}: They offered ${h.offeredPrice}, we ${h.ourCounterOffer ? 'counter-offered ' + h.ourCounterOffer : 'responded'} — "${h.message}"`)
            .join('\n');

        const fullEmailContent = [emailBody, pdfContent].filter(Boolean).join('\n\n=== PDF ATTACHMENT ===\n\n');

        // ====== COMPANY KNOWLEDGE ======
        const companyContext = getCompanyContext();

        const systemPrompt = `You are the AI procurement negotiator for Halal Food Service. You handle vendor email responses for RFQs with intelligence, professionalism, and strategic negotiation skills.

===== WHO YOU ARE =====
${companyContext}

===== RFQ DETAILS =====
- RFQ Number: ${rfq.rfqNumber}
- Quotation Due: ${new Date(rfq.quotationDueDate).toLocaleDateString('en-GB')}
- Delivery By: ${new Date(rfq.deliveryBy).toLocaleDateString('en-GB')}
- Payment Terms: ${rfq.paymentTermsPreference || 'Net 30'}
- Incoterm: ${rfq.incoterm || 'EXW'}
- Destination: ${rfq.destination || 'Paris, France'}
- Contact: ${rfq.contactEmail}

Items Requested (can share with vendor):
${rfqItemsSummary}

===== CONFIDENTIAL — NEVER SHARE WITH VENDORS =====
Internal Target Prices:
${targetPricesSummary}

Product Intelligence (price history, market data):
${productContextStr || 'No historical data available for these products.'}

${negotiationAnalysisStr ? `Current Analysis:\n${negotiationAnalysisStr}` : ''}
===== END CONFIDENTIAL =====

===== VENDOR CONTEXT =====
Vendor: ${vendor.vendorName} (${vendor.vendorCode})
Source: ${vendor.vendorSource || 'SAP'}
Negotiation Round: ${currentRound}
Negotiation Status: ${negStatus}
${negHistory ? `Negotiation History:\n${negHistory}` : 'First contact — no negotiation history yet.'}

===== LANGUAGE RULES =====
- ALWAYS reply in the SAME LANGUAGE the vendor used in their email.
- If they write in French, reply in French. If English, reply in English. If Arabic, reply in Arabic. Etc.
- Match their level of formality.

===== ABSOLUTE PROHIBITIONS =====
- NEVER reveal target prices, internal budgets, or pricing data.
- NEVER say "our target is..." or "we were hoping for X per unit" or any specific number you want to achieve.
- NEVER reveal other vendors' names or their specific prices.
- NEVER say "we have internal pricing data" or "our system shows..."
- NEVER mention that you are an AI or bot.

===== WHEN VENDOR ASKS QUESTIONS =====
Answer using the company info above. Common questions:
- "Where are you located?" → 32 rue Raspail, Passage Ste Foix, 93120 La Courneuve, France (Greater Paris)
- "Who are you?" → Halal Food Service, premium halal food wholesaler in France, 600+ products, 100+ suppliers
- "What volumes?" → Share the actual quantities from this RFQ
- "What payment terms?" → Share the RFQ payment terms
- "What certifications do you need?" → Share from item specs/additionalInfo if available
- "Do you have existing suppliers for this?" → "We work with multiple suppliers and are always looking to optimize our sourcing"
- For anything not covered, answer professionally and offer to have our procurement team follow up

===== NEGOTIATION STRATEGY =====
When a quotation is received, you MUST analyze EACH ITEM SEPARATELY using negotiate_price:

1. ITEM-LEVEL DECISIONS — Do NOT give a generic response when some items are good and others aren't:
   - If product A is at target but product B is 20% above → acknowledge A is acceptable, negotiate specifically on B
   - Name the specific products that need better pricing (but never say the target number)
   - Example: "We appreciate your competitive pricing on [Product A]. However, for [Product B], we believe there is room for improvement based on current market conditions for this category."

2. NEGOTIATION TACTICS BY ROUND:
   Round 0 (first quote received):
   - If all items meet target → ACCEPT immediately, confirm the order interest
   - If some items are close (within 5%) → accept those, gently ask for "best effort" on the others
   - If items are 5-15% above → "We've reviewed your quotation and while we appreciate the offer, we were expecting more competitive pricing on [specific items]. Given our volume of [X units] and regular purchasing needs, could you review the pricing for these items?"
   - If items are 15-30% above → "Thank you for your quotation. After comparing with current market rates for [product category], we find the pricing for [items] to be above what we typically see. We are evaluating several suppliers for this procurement. Could you provide revised pricing?"
   - If items are >30% above → "We appreciate your response. However, the pricing for [items] is significantly above the current market rates we are seeing. If you can revisit these prices substantially, we would be happy to continue discussions."

   Round 1 (second quote / counter):
   - Reference volume commitment: "As a regular buyer purchasing [quantity] every [period], we expect pricing that reflects this ongoing relationship."
   - Mention competition without specifics: "We have received more competitive offers for [specific items] from other suppliers."
   - Offer trade-offs: "We could consider adjusting payment terms or delivery schedule if that helps with pricing."

   Round 2 (third attempt):
   - Final attempt: "This is our final review of quotations for this procurement cycle. We need your absolute best pricing on [items] to include you in our supplier selection."
   - If still too far, accept what's good: "We would like to proceed with [acceptable items] at your quoted prices. For [expensive items], we will explore alternative sources for now but will keep you in mind for future requirements."

   Round 3+ (beyond third attempt):
   - REJECT remaining expensive items: "Thank you for your continued engagement. We have finalized our supplier selection for this RFQ. We appreciate your quotation and will keep your details on file for future procurement opportunities."
   - OR ESCALATE to human if the vendor seems willing but needs executive-level discussion

3. PARTIAL ACCEPTANCE IS PREFERRED OVER BLANKET REJECTION:
   - If 3 out of 5 items meet target → accept those 3, negotiate or reject the other 2
   - Never reject everything just because 1-2 items are expensive

4. USE MARKET INTELLIGENCE:
   - If our price history shows we bought this product cheaper before, you can say "based on our recent procurement experience in this category" (never cite specific numbers)
   - If the vendor is a new supplier, be more formal but also more willing to accept slightly higher prices to establish the relationship

===== PRICE EXTRACTION RULES (CRITICAL) =====
When calling extract_quotation, disambiguate unitPrice vs totalPrice carefully:
- If the vendor writes "unit price", "per kg", "per unit", "per box", "each", "/kg", "/unit", "EUR X/kg", etc. → that number is the UNIT PRICE. Set unitPrice; leave totalPrice for the system to compute.
- If the vendor writes "total", "total price", "grand total", "bundle price", "package price", "lot price", or gives ONE number for an entire batch of items → that number is the TOTAL PRICE. Set totalPrice; leave unitPrice for the system to derive.
- If the vendor writes just "Price: X" with NO qualifier (no "/kg", no "total", no "each") and only ONE line item:
    * If quantity is small (1–20) and X is a plausible unit price → treat as unitPrice.
    * If quantity is large (>20) and X × quantity would be an unusually large or unusually small number for bulk procurement (e.g., makes the unit price implausible given typical supermarket/wholesale ranges for that product) → treat as totalPrice instead.
    * When in doubt, PREFER totalPrice and add a note in additionalNotes: "Price interpretation ambiguous — treated 'Price: X' as total; please confirm."
- Never multiply or divide yourself — always set only one of (unitPrice, totalPrice) per item and let the server fill in the other. Setting both incorrectly causes double-counting.
- totalQuotedAmount should match the sum of item totals; never guess or pad it.

===== PROCESSING INSTRUCTIONS =====
1. Call classify_email to determine email type.
2. Based on classification:
   - quotation / partial_quote → call extract_quotation, then call negotiate_price with per-item analysis:
     - overallDecision "accept_all" → update_rfq_vendor status "responded", send_reply with a HOLDING MESSAGE ONLY (e.g., "Thank you for the quotation. We're reviewing internally and will confirm shortly."). Do NOT confirm the order, do NOT commit to purchasing, do NOT say "we accept" or "approved". The human admin must make the final acceptance.
     - overallDecision "accept_partial_counter_rest" → update_rfq_vendor stays "sent", send_reply acknowledging good items BY NAME, countering on specific expensive items BY NAME
     - overallDecision "counter_all" → update_rfq_vendor stays "sent", send_reply with counter referencing specific items
     - overallDecision "reject" → update_rfq_vendor status "responded", send_reply politely declining with door open for future
     - overallDecision "request_complete_quote" → update_rfq_vendor stays "sent", send_reply requesting pricing for missing items
     - overallDecision "escalate_to_human" → update_rfq_vendor notes "NEEDS HUMAN REVIEW", do NOT send_reply
   - question → send_reply using company info and RFQ details above
   - decline → update_rfq_vendor status "declined", send_reply acknowledging professionally
   - out_of_office → update_rfq_vendor notes with reminder, do NOT send_reply
   - unclear → send_reply asking for clarification
3. Always call mark_email_read at the end.
4. Send EXACTLY ONE reply per email.${conversationContext}

===== EMAIL SIGNATURE =====
Always sign replies:
Best regards,
Halal Food Service — Procurement Team
32 rue Raspail, 93120 La Courneuve, France
contact@halalfoods.fr`;

        const userMessage = `Process this single vendor email (messageId: ${email.messageId}):

From: ${email.from}
Subject: ${email.subject}
Date: ${email.date}

Body:
${fullEmailContent}`;

        // Build tool executors
        const toolExecutors = this._buildToolExecutors(rfq, vendor, email);

        try {
            const result = await this.runToolLoop(
                systemPrompt,
                userMessage,
                TOOL_DEFINITIONS,
                toolExecutors,
                8
            );

            this.addToActionLog('email_processed', {
                rfqNumber: rfq.rfqNumber,
                vendor: vendor.vendorName,
                vendorEmail,
            });

            this.log(`Successfully processed email from ${vendor.vendorName}`);
        } catch (error) {
            this.logError(`Error processing email from ${vendor.vendorName}:`, error);
            this.addToActionLog('email_processing_error', {
                rfqNumber: rfq.rfqNumber,
                vendor: vendor.vendorName,
                error: error.message,
            });

            // Fallback: mark as read so we don't reprocess
            try {
                await gmailService.markAsRead(email.messageId);
            } catch (_) { }
        }
    }

    /**
     * Build tool executor functions for the tool loop
     */
    _buildToolExecutors(rfq, vendor, email) {
        return {
            classify_email: async (input) => {
                this.log(`Email classified as: ${input.classification} (confidence: ${input.confidence})`);
                this.addToActionLog('email_classified', {
                    classification: input.classification,
                    vendor: vendor.vendorName,
                    rfqNumber: rfq.rfqNumber,
                });
                return { success: true, classification: input.classification };
            },

            extract_quotation: async (input) => {
                const quotedItems = input.quotedItems || [];

                // Compute per-item totals and fill missing quantities from RFQ
                for (const qi of quotedItems) {
                    // If vendor gave unitPrice but no quantity, pull from the RFQ item
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
                    // Compute totalPrice if we have unitPrice + quantity
                    if (qi.unitPrice && qi.quantity && (!qi.totalPrice || qi.totalPrice === 0)) {
                        qi.totalPrice = Math.round(qi.unitPrice * qi.quantity * 100) / 100;
                    }
                    // Or derive unitPrice from totalPrice + quantity
                    if (qi.totalPrice && qi.quantity && (!qi.unitPrice || qi.unitPrice === 0)) {
                        qi.unitPrice = Math.round(qi.totalPrice / qi.quantity * 100) / 100;
                    }
                }

                // Compute total: use AI's value if non-zero, otherwise sum item totals
                let totalQuotedAmount = input.totalQuotedAmount || 0;
                if (!totalQuotedAmount || totalQuotedAmount === 0) {
                    totalQuotedAmount = quotedItems.reduce((sum, qi) => sum + (qi.totalPrice || 0), 0);
                    totalQuotedAmount = Math.round(totalQuotedAmount * 100) / 100;
                }

                this.log(`Extracting quotation: ${input.currency} ${totalQuotedAmount} (${quotedItems.length} items)`);

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
                };

                vendor.quotedTotal = totalQuotedAmount;
                if (input.paymentTerms) vendor.paymentTerms = input.paymentTerms;
                if (input.deliveryDate) vendor.deliveryDate = new Date(input.deliveryDate);

                rfq.markModified('vendorsContacted');
                await rfq.save();

                return {
                    success: true,
                    totalQuotedAmount,
                    currency: input.currency,
                    itemsExtracted: quotedItems.length,
                    itemDetails: quotedItems.map(qi => ({
                        product: qi.productName,
                        unitPrice: qi.unitPrice,
                        qty: qi.quantity,
                        total: qi.totalPrice,
                    })),
                    missingItems: input.missingItems || [],
                };
            },

            send_reply: async (input) => {
                this.log(`Sending reply to ${input.to}: ${input.subject}`);

                try {
                    const result = await gmailService.sendEmail({
                        to: input.to,
                        subject: input.subject,
                        html: input.htmlBody || input.body.replace(/\n/g, '<br>'),
                        text: input.body,
                    });

                    this.addToActionLog('reply_sent', {
                        to: input.to,
                        subject: input.subject,
                        rfqNumber: rfq.rfqNumber,
                    });

                    return { success: true, messageId: result.messageId };
                } catch (err) {
                    this.logError('Failed to send reply:', err);
                    return { success: false, error: err.message };
                }
            },

            update_rfq_vendor: async (input) => {
                this.log(`Updating vendor status to: ${input.status}`);

                vendor.status = input.status;
                if (input.notes) vendor.notes = input.notes;

                if (input.quotationData) {
                    vendor.quotationData = {
                        ...vendor.quotationData,
                        ...input.quotationData,
                    };
                }

                // Check if all vendors responded
                const allResponded = rfq.vendorsContacted.every(
                    v => ['responded', 'declined'].includes(v.status)
                );
                rfq.status = allResponded ? 'completed' : 'in_progress';

                rfq.markModified('vendorsContacted');
                await rfq.save();

                return { success: true, rfqStatus: rfq.status };
            },

            negotiate_price: async (input) => {
                const decision = input.overallDecision;
                const round = input.negotiationRound || 0;

                this.log(`Negotiation: ${decision} (round ${round})`);
                this.log(`Reasoning: ${input.reasoning}`);

                // Log per-item decisions
                const itemSummary = (input.itemDecisions || []).map(d =>
                    `${d.productName}: ${d.itemDecision} (quoted ${d.quotedPrice || 'N/A'}, target ${d.targetPrice || 'N/A'}, gap ${d.gapPercent || 0}%)`
                );
                this.log(`Item decisions:\n  ${itemSummary.join('\n  ')}`);

                // Calculate total offered price
                const totalOffered = (input.itemDecisions || [])
                    .filter(d => d.quotedPrice)
                    .reduce((sum, d) => sum + d.quotedPrice, 0);

                // Record negotiation round
                if (!vendor.negotiationHistory) vendor.negotiationHistory = [];
                vendor.negotiationHistory.push({
                    round,
                    offeredPrice: totalOffered,
                    ourCounterOffer: decision.includes('accept') ? totalOffered : null,
                    timestamp: new Date(),
                    message: decision.includes('counter') || decision === 'accept_partial_counter_rest'
                        ? (input.counterMessage || '').substring(0, 1000)
                        : `Decision: ${decision}`,
                });

                vendor.negotiationRound = round + 1;

                // Map overall decision to status
                // IMPORTANT: The AI bot never auto-accepts a quotation for final purchase.
                // "accept_all" means the bot recommends acceptance; admin must still approve.
                let triggerAdminNotification = false;
                let notificationType = null;
                let notificationTitle = null;
                let notificationMessage = null;

                switch (decision) {
                    case 'accept_all':
                        // Bot recommends acceptance — flag for admin review
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
                        notificationTitle = `Quotation ready for approval — ${rfq.rfqNumber}`;
                        notificationMessage = `${vendor.vendorName} quoted €${totalOffered?.toLocaleString() || 'N/A'} for RFQ ${rfq.rfqNumber}. The AI agent recommends acceptance — please review and approve.`;
                        break;
                    case 'accept_partial_counter_rest':
                    case 'counter_all':
                    case 'request_complete_quote':
                        vendor.negotiationStatus = 'negotiating';
                        // Keep status as 'sent' so inbox keeps checking
                        break;
                    case 'reject':
                        vendor.negotiationStatus = 'rejected';
                        vendor.status = 'responded';
                        break;
                    case 'escalate_to_human':
                        vendor.negotiationStatus = 'stalled';
                        vendor.pendingAdminReview = true;
                        vendor.notes = (vendor.notes || '') + ' | NEEDS HUMAN REVIEW — ' + (input.reasoning || '').substring(0, 200);
                        triggerAdminNotification = true;
                        notificationType = 'rfq_stalled';
                        notificationTitle = `RFQ negotiation stalled — ${rfq.rfqNumber}`;
                        notificationMessage = `Negotiation with ${vendor.vendorName} for RFQ ${rfq.rfqNumber} requires human intervention. Reason: ${(input.reasoning || 'Unknown').substring(0, 200)}`;
                        break;
                }

                // Store per-item decisions in metadata for tracking
                if (!rfq.metadata) rfq.metadata = {};
                if (!rfq.metadata.negotiationDetails) rfq.metadata.negotiationDetails = {};
                rfq.metadata.negotiationDetails[vendor.vendorCode] = {
                    lastRound: round,
                    lastDecision: decision,
                    itemDecisions: input.itemDecisions,
                    timestamp: new Date(),
                };

                rfq.markModified('vendorsContacted');
                rfq.markModified('metadata');
                await rfq.save();

                // Trigger admin notification when bot recommends acceptance or escalation
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
                        this.log(`Admin notification sent: ${notificationTitle}`);
                    } catch (notifErr) {
                        this.log(`Failed to send admin notification: ${notifErr.message}`);
                    }
                }

                this.addToActionLog('negotiation_decision', {
                    rfqNumber: rfq.rfqNumber,
                    vendor: vendor.vendorName,
                    decision,
                    round,
                    totalOffered,
                    itemsAccepted: (input.itemDecisions || []).filter(d => d.itemDecision === 'accept').length,
                    itemsCountered: (input.itemDecisions || []).filter(d => d.itemDecision === 'counter').length,
                    itemsMissing: (input.itemDecisions || []).filter(d => d.itemDecision === 'missing').length,
                });

                return {
                    success: true,
                    decision,
                    round,
                    negotiationStatus: vendor.negotiationStatus,
                    itemsAccepted: (input.itemDecisions || []).filter(d => d.itemDecision === 'accept').length,
                    itemsCountered: (input.itemDecisions || []).filter(d => d.itemDecision === 'counter').length,
                };
            },

            mark_email_read: async (input) => {
                await gmailService.markAsRead(input.messageId);
                this.log(`Marked email ${input.messageId} as read`);
                return { success: true };
            },

            get_rfq_by_number: async (input) => {
                const foundRfq = await RFQ.findOne({ rfqNumber: input.rfqNumber });
                if (!foundRfq) return { error: 'RFQ not found' };

                return {
                    rfqId: foundRfq._id.toString(),
                    rfqNumber: foundRfq.rfqNumber,
                    status: foundRfq.status,
                    items: foundRfq.items.map(i => ({
                        productName: i.productName,
                        quantity: i.quantity,
                        unit: i.unit,
                    })),
                    quotationDueDate: foundRfq.quotationDueDate,
                    deliveryBy: foundRfq.deliveryBy,
                    vendorsContacted: foundRfq.vendorsContacted.length,
                };
            },
        };
    }
}

module.exports = new InboundAgent();
