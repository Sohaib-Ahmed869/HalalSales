// agents/outboundAgent.js
const { BaseAgent } = require('./baseAgent');
const RFQ = require('../models/RFQ');
const Vendor = require('../models/Vendor');
const PDA_Supplier = require('../models/PDA_Supplier');
const NewSupplier = require('../models/NewSupplier');
const { generateRFQPDF } = require('../utils/pdfGenerator1');
const { generateRFQEmail } = require('../services/aiService');
const gmailService = require('../services/gmailService');
const { sendRFQViaWhatsApp } = require('../services/whatsappService');

const TOOL_DEFINITIONS = [
    {
        name: 'get_rfq_details',
        description: 'Fetch RFQ from MongoDB by ID',
        input_schema: {
            type: 'object',
            properties: {
                rfqId: { type: 'string' },
            },
            required: ['rfqId'],
        },
    },
    {
        name: 'get_vendor_details',
        description: 'Fetch vendor contact info from Vendor or PDA_Supplier model',
        input_schema: {
            type: 'object',
            properties: {
                vendorCode: { type: 'string' },
            },
            required: ['vendorCode'],
        },
    },
    {
        name: 'check_vendor_contact',
        description: 'Check if vendor has valid email and phone for sending',
        input_schema: {
            type: 'object',
            properties: {
                vendorCode: { type: 'string' },
            },
            required: ['vendorCode'],
        },
    },
    {
        name: 'send_email',
        description: 'Send email to vendor with RFQ PDF attached',
        input_schema: {
            type: 'object',
            properties: {
                vendorCode: { type: 'string' },
                vendorName: { type: 'string' },
                vendorEmail: { type: 'string' },
                rfqId: { type: 'string' },
                emailTone: {
                    type: 'string',
                    enum: ['formal_new', 'warm_existing', 'standard'],
                    description: 'Tone based on vendor relationship',
                },
                customMessage: { type: 'string', description: 'Optional custom note' },
            },
            required: ['vendorCode', 'vendorName', 'vendorEmail', 'rfqId'],
        },
    },
    {
        name: 'send_whatsapp',
        description: 'Send WhatsApp message to vendor with RFQ details',
        input_schema: {
            type: 'object',
            properties: {
                vendorCode: { type: 'string' },
                rfqId: { type: 'string' },
            },
            required: ['vendorCode', 'rfqId'],
        },
    },
    {
        name: 'update_vendor_status',
        description: 'Update vendorsContacted status in RFQ document',
        input_schema: {
            type: 'object',
            properties: {
                rfqId: { type: 'string' },
                vendorCode: { type: 'string' },
                status: { type: 'string', enum: ['draft', 'sent', 'opened', 'responded', 'declined'] },
                messageId: { type: 'string' },
                method: { type: 'string', enum: ['email', 'whatsapp'] },
            },
            required: ['rfqId', 'vendorCode', 'status'],
        },
    },
];

class OutboundAgent extends BaseAgent {
    constructor() {
        super('Outbound');
        this._pdfCache = new Map(); // rfqId -> { buffer, timestamp }
    }

    /**
     * Send RFQ to specified vendors
     * @param {string} rfqId
     * @param {string[]} vendorCodes
     * @param {string} sendMethod - 'email' or 'whatsapp'
     * @param {string} customMessage - optional
     */
    async sendRFQ({ rfqId, vendorCodes, sendMethod = 'email', customMessage }) {
        this.log(`Sending RFQ ${rfqId} to ${vendorCodes.length} vendors via ${sendMethod}`);
        this.addToActionLog('send_rfq_started', { rfqId, vendorCodes, sendMethod });

        try {
            const rfq = await RFQ.findById(rfqId);
            if (!rfq) throw new Error(`RFQ ${rfqId} not found`);

            // Generate PDF once for all vendors
            let pdfBuffer = null;
            if (sendMethod === 'email') {
                pdfBuffer = await generateRFQPDF(rfq, 'en');
                this.log('PDF generated');
            }

            // Resolve all vendor details
            const vendors = await this._resolveVendors(vendorCodes);
            this.log(`Resolved ${vendors.length} vendors`);

            // Use Claude to decide tone for each vendor
            const sendPlan = await this._planSendStrategy(rfq, vendors, sendMethod);

            const results = [];

            for (const plan of sendPlan) {
                try {
                    let result;
                    if (sendMethod === 'whatsapp' && plan.vendor.phone) {
                        result = await this._sendViaWhatsApp(rfq, plan.vendor);
                    } else {
                        result = await this._sendViaEmail(rfq, plan.vendor, pdfBuffer, plan.isExisting, customMessage);
                    }

                    // Update vendor status in RFQ
                    await this._updateVendorStatus(rfq, plan.vendor, 'sent', result.messageId, sendMethod, result.sentEmail);

                    results.push({
                        vendorCode: plan.vendor.CardCode || plan.vendor._id,
                        vendorName: plan.vendor.CardName || plan.vendor.supplierName,
                        success: true,
                        messageId: result.messageId,
                        method: sendMethod,
                    });

                    this.log(`Sent to ${plan.vendor.CardName || plan.vendor.supplierName}`);
                } catch (err) {
                    this.logError(`Failed to send to ${plan.vendor.CardName || plan.vendor.supplierName}:`, err);
                    results.push({
                        vendorCode: plan.vendor.CardCode || plan.vendor._id,
                        vendorName: plan.vendor.CardName || plan.vendor.supplierName,
                        success: false,
                        error: err.message,
                        method: sendMethod,
                    });
                }
            }

            // Update RFQ status
            rfq.status = 'sent';
            rfq.metadata = {
                ...rfq.metadata,
                sentAt: new Date(),
                sendMethod,
            };
            await rfq.save();

            const successCount = results.filter(r => r.success).length;
            this.addToActionLog('send_rfq_completed', {
                rfqId,
                rfqNumber: rfq.rfqNumber,
                totalVendors: vendors.length,
                successfulSends: successCount,
                sendMethod,
            });

            return {
                rfqNumber: rfq.rfqNumber,
                totalVendors: vendors.length,
                successfulSends: successCount,
                failedSends: results.filter(r => !r.success).length,
                sendMethod,
                results,
            };
        } catch (error) {
            this.logError('Error in sendRFQ:', error);
            this.addToActionLog('send_rfq_error', { rfqId, error: error.message });
            throw error;
        }
    }

    /**
     * Resolve vendor codes to full vendor documents (SAP or PDA)
     */
    async _resolveVendors(vendorCodes) {
        const objectIdCodes = vendorCodes.filter(code => /^[0-9a-fA-F]{24}$/.test(code));
        const sapCodes = vendorCodes.filter(code => !/^[0-9a-fA-F]{24}$/.test(code));

        const vendors = [];
        const resolvedIds = new Set();

        if (sapCodes.length > 0) {
            const sapVendors = await Vendor.find({ CardCode: { $in: sapCodes } });
            vendors.push(...sapVendors);
        }

        // ObjectId codes can belong to either PDA_Supplier (web-scraped) or NewSupplier (Excel upload).
        // Look up both and normalise to a vendor-like shape.
        if (objectIdCodes.length > 0) {
            const pdaSuppliers = await PDA_Supplier.find({ _id: { $in: objectIdCodes } });
            for (const s of pdaSuppliers) {
                resolvedIds.add(s._id.toString());
                vendors.push({
                    CardCode: s._id.toString(),
                    CardName: s.supplierName,
                    email: s.email,
                    phone: s.contactInfo?.phone,
                    _isPDA: true,
                    _source: 'PDA_SUPPLIER',
                    performanceMetrics: { totalOrders: 0 },
                });
            }

            const remaining = objectIdCodes.filter(id => !resolvedIds.has(id));
            if (remaining.length > 0) {
                const newSuppliers = await NewSupplier.find({ _id: { $in: remaining }, isActive: true });
                for (const s of newSuppliers) {
                    resolvedIds.add(s._id.toString());
                    vendors.push({
                        CardCode: s._id.toString(),
                        CardName: s.companyName || s.supplierName,
                        supplierName: s.supplierName,
                        email: s.email,
                        phone: s.phone,
                        country: s.country,
                        _isNewSupplier: true,
                        _source: 'NEW_SUPPLIER',
                        performanceMetrics: {
                            totalOrders: s.stats?.totalWins || 0,
                            totalRFQs: s.stats?.totalRFQsSent || 0,
                        },
                    });
                }
            }

            const stillMissing = objectIdCodes.filter(id => !resolvedIds.has(id));
            if (stillMissing.length > 0) {
                this.logError(`Could not resolve vendor codes: ${stillMissing.join(', ')}`);
            }
        }

        return vendors;
    }

    /**
     * Use Claude to plan send strategy — decide tone per vendor
     */
    async _planSendStrategy(rfq, vendors, sendMethod) {
        if (vendors.length === 0) return [];

        const vendorSummaries = vendors.map(v => ({
            code: v.CardCode,
            name: v.CardName,
            totalOrders: v.performanceMetrics?.totalOrders || 0,
            isPreferred: v.isPreferred || false,
            isPDA: v._isPDA || false,
            isNewSupplier: v._isNewSupplier || false,
            hasEmail: !!v.email,
            hasPhone: !!v.phone,
        }));

        try {
            const response = await this.callLLM(
                'You are a procurement communication strategist. Decide the email tone for each vendor. Return only valid JSON.',
                `For RFQ ${rfq.rfqNumber} with ${rfq.items.length} items, classify each vendor's relationship:

Vendors:
${JSON.stringify(vendorSummaries, null, 2)}

Return JSON array:
[{ "code": "vendor_code", "isExisting": true/false, "tone": "formal_new|warm_existing|standard" }]

Rules:
- totalOrders >= 10 → warm_existing
- totalOrders > 0 but < 10 → standard
- totalOrders === 0, isPDA, or isNewSupplier → formal_new (always introduce the business first)`,
            );

            const text = this.extractText(response);
            const plan = this.extractJSON(text);

            if (Array.isArray(plan)) {
                return plan.map(p => {
                    const vendor = vendors.find(v => v.CardCode === p.code);
                    return { vendor, isExisting: p.isExisting, tone: p.tone };
                }).filter(p => p.vendor);
            }
        } catch (err) {
            this.logError('Claude planning failed, using defaults:', err);
        }

        // Fallback: simple logic
        return vendors.map(v => ({
            vendor: v,
            isExisting: (v.performanceMetrics?.totalOrders || 0) > 0,
            tone: (v.performanceMetrics?.totalOrders || 0) >= 10 ? 'warm_existing' : 'formal_new',
        }));
    }

    /**
     * Send via Gmail
     */
    async _sendViaEmail(rfq, vendor, pdfBuffer, isExisting, customMessage) {
        const emailContent = await generateRFQEmail(
            {
                rfqNumber: rfq.rfqNumber,
                items: rfq.items,
                quotationDueDate: rfq.quotationDueDate,
                deliveryBy: rfq.deliveryBy,
                incoterm: rfq.incoterm,
                destination: rfq.destination,
                specialRequirements: {
                    packaging: rfq.packagingRequirements,
                    payment: rfq.paymentTermsPreference,
                    other: rfq.otherNotes,
                    incoterm: rfq.incoterm,
                    destination: rfq.destination,
                },
                customMessage,
            },
            {
                vendorName: vendor.CardName,
                totalPurchases: vendor.performanceMetrics?.totalOrders || 0,
            },
            'en',
            isExisting
        );

        const result = await gmailService.sendEmail({
            to: vendor.email,
            subject: emailContent.subject,
            html: emailContent.bodyHtml,
            text: emailContent.bodyText,
            attachments: pdfBuffer
                ? [{
                    filename: `RFQ-${rfq.rfqNumber}.pdf`,
                    content: pdfBuffer,
                    contentType: 'application/pdf',
                }]
                : [],
        });

        // Surface the sent content so it can be logged into the email thread.
        return {
            ...result,
            sentEmail: {
                subject: emailContent.subject,
                body: emailContent.bodyText,
                htmlBody: emailContent.bodyHtml,
                attachments: pdfBuffer ? [`RFQ-${rfq.rfqNumber}.pdf`] : [],
            },
        };
    }

    /**
     * Send via WhatsApp
     */
    async _sendViaWhatsApp(rfq, vendor) {
        const result = await sendRFQViaWhatsApp(rfq._id.toString(), vendor.CardCode);
        return result;
    }

    /**
     * Update vendor status in RFQ document
     */
    async _updateVendorStatus(rfq, vendor, status, messageId, method, sentEmail = null) {
        const vendorCode = vendor.CardCode;
        let vendorContact = rfq.vendorsContacted.find(v => v.vendorCode === vendorCode);

        if (vendorContact) {
            vendorContact.status = status;
            vendorContact.sentDate = new Date();
            if (method === 'whatsapp') {
                vendorContact.whatsappMessageId = messageId;
                vendorContact.whatsappSentDate = new Date();
            } else {
                vendorContact.emailMessageId = messageId;
            }
        } else {
            let vendorSource = 'SAP';
            if (vendor._isNewSupplier) vendorSource = 'NEW_SUPPLIER';
            else if (vendor._isPDA) vendorSource = 'PDA_SCRAPER';
            else if (vendor.customFields?.isEmailVendor) vendorSource = 'EMAIL';

            vendorContact = {
                vendorCode,
                vendorName: vendor.CardName,
                email: vendor.email,
                phone: vendor.phone,
                status,
                sentDate: new Date(),
                vendorSource,
            };
            rfq.vendorsContacted.push(vendorContact);
            // Re-fetch the pushed subdoc so we can append history to it
            vendorContact = rfq.vendorsContacted[rfq.vendorsContacted.length - 1];
        }

        // Log the outgoing email into the thread
        if (method !== 'whatsapp' && sentEmail) {
            if (!Array.isArray(vendorContact.emailHistory)) vendorContact.emailHistory = [];
            vendorContact.emailHistory.push({
                direction: 'outgoing',
                subject: sentEmail.subject || `RFQ ${rfq.rfqNumber}`,
                body: sentEmail.body || '',
                htmlBody: sentEmail.htmlBody || '',
                attachments: sentEmail.attachments || [],
                timestamp: new Date(),
                messageId: messageId || null,
            });
        }

        rfq.markModified('vendorsContacted');
        await rfq.save();
    }
}

module.exports = new OutboundAgent();
