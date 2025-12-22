const { google } = require('googleapis');
const gmailService = require('./gmailService');
const rfqResponseParser = require('./rfqResponseParser');
const RFQ = require('../models/RFQ');

class RFQEmailMonitor {
    constructor() {
        this.isMonitoring = false;
        this.monitoringInterval = null;
    }

    /**
     * Start monitoring for RFQ responses
     */
    startMonitoring(intervalMs = 300000) { // Default: 5 minutes
        if (this.isMonitoring) {
            console.log('⚠️ Email monitoring already running');
            return;
        }

        console.log(`🔄 Starting RFQ email monitoring (every ${intervalMs / 1000}s)`);
        this.isMonitoring = true;

        // Run immediately
        this.checkForResponses();

        // Then run periodically
        this.monitoringInterval = setInterval(() => {
            this.checkForResponses();
        }, intervalMs);
    }

    /**
     * Stop monitoring
     */
    stopMonitoring() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.isMonitoring = false;
            console.log('⏹️ Email monitoring stopped');
        }
    }

    /**
     * Check for new RFQ responses
     */
    async checkForResponses() {
        try {
            console.log('\n🔍 Checking for new RFQ responses...');

            // Get all active RFQs (sent or in_progress)
            const activeRFQs = await RFQ.find({
                status: { $in: ['sent', 'in_progress'] },
            });

            console.log(`📋 Found ${activeRFQs.length} active RFQs`);

            for (const rfq of activeRFQs) {
                await this.processRFQResponses(rfq);
            }

            console.log('✅ Email check complete\n');
        } catch (error) {
            console.error('❌ Error checking for responses:', error);
        }
    }

    /**
     * Process responses for a specific RFQ
     */
    async processRFQResponses() {
        try {
            // Use existing gmailService OAuth
            const gmail = gmailService.gmail;

            const response = await gmail.users.messages.list({
                userId: 'me',
                q: 'subject:RFQ- OR subject:"Request for Quotation" is:unread',
                maxResults: 50,
            });

            const messages = response.data.messages || [];
            console.log(`📬 Found ${messages.length} unread RFQ responses`);

            for (const message of messages) {
                try {
                    const fullMessage = await gmail.users.messages.get({
                        userId: 'me',
                        id: message.id,
                        format: 'full',
                    });

                    const headers = fullMessage.data.payload.headers;
                    const subject = headers.find(h => h.name === 'Subject')?.value || '';
                    const from = headers.find(h => h.name === 'From')?.value || '';
                    const date = headers.find(h => h.name === 'Date')?.value || '';

                    // Extract email body
                    let emailBody = '';
                    let htmlBody = '';
                    const attachments = [];

                    const extractBody = (parts) => {
                        if (!parts) return;
                        for (const part of parts) {
                            if (part.mimeType === 'text/plain' && part.body.data) {
                                emailBody += Buffer.from(part.body.data, 'base64').toString('utf-8') + '\n\n';
                            }
                            if (part.mimeType === 'text/html' && part.body.data) {
                                htmlBody += Buffer.from(part.body.data, 'base64').toString('utf-8') + '\n\n';
                            }
                            if (part.filename && part.body.attachmentId) {
                                attachments.push({
                                    filename: part.filename,
                                    mimeType: part.mimeType,
                                    attachmentId: part.body.attachmentId
                                });
                            }
                            if (part.parts) {
                                extractBody(part.parts);
                            }
                        }
                    };

                    if (fullMessage.data.payload.parts) {
                        extractBody(fullMessage.data.payload.parts);
                    } else if (fullMessage.data.payload.body.data) {
                        emailBody = Buffer.from(fullMessage.data.payload.body.data, 'base64').toString('utf-8');
                    }

                    console.log(`\n📧 Processing email from: ${from}`);
                    console.log(`📝 Subject: ${subject}`);
                    console.log(`📄 Body length: ${emailBody.length} chars`);

                    // Extract RFQ number
                    const rfqMatch = subject.match(/RFQ[- ]?(\d{6,8})/i);
                    if (!rfqMatch) {
                        console.log(`⚠️ No valid RFQ number in subject`);
                        continue;
                    }

                    const rfqNumber = `RFQ-${rfqMatch[1]}`;
                    const rfq = await RFQ.findOne({ rfqNumber: rfqNumber });

                    if (!rfq) {
                        console.log(`⚠️ RFQ not found: ${rfqNumber}`);
                        continue;
                    }

                    // Extract vendor email
                    const emailMatch = from.match(/<(.+?)>/);
                    const vendorEmail = (emailMatch ? emailMatch[1] : from).toLowerCase();

                    const vendor = rfq.vendorsContacted.find(v =>
                        v.email.toLowerCase() === vendorEmail
                    );

                    if (!vendor) {
                        console.log(`⚠️ Vendor not found: ${vendorEmail}`);
                        continue;
                    }

                    console.log(`\n✅ MATCH FOUND: ${vendor.vendorName} responded to ${rfqNumber}`);

                    // ========================================
                    // STEP 1: ALWAYS STORE RAW EMAIL FIRST
                    // ========================================
                    vendor.rawEmailContent = {
                        subject: subject,
                        body: emailBody,
                        htmlBody: htmlBody,
                        receivedDate: new Date(date),
                        attachments: attachments.map(a => a.filename)
                    };
                    vendor.status = 'responded';
                    vendor.responseDate = new Date();
                    vendor.emailMessageId = message.id;

                    // Save immediately so raw email is preserved
                    await rfq.save();
                    console.log(`✅ Raw email saved for ${vendor.vendorName}`);

                    // ========================================
                    // STEP 2: TRY AI PARSING (non-critical)
                    // ========================================
                    try {
                        const aiService = require('./aiService');

                        console.log(`🤖 Attempting AI parsing...`);

                        const parsedData = await aiService.parseRFQResponseWithAI({
                            rfqNumber: rfq.rfqNumber,
                            vendorName: vendor.vendorName,
                            vendorEmail: vendor.email,
                            emailSubject: subject,
                            emailBody: emailBody || htmlBody,
                            date: date,
                        });

                        console.log(`🤖 AI Result:`, JSON.stringify(parsedData, null, 2));

                        if (parsedData.isValidResponse && parsedData.totalQuotedAmount) {
                            vendor.quotationData = {
                                quotedItems: parsedData.quotedItems || [],
                                totalQuotedAmount: parsedData.totalQuotedAmount,
                                currency: parsedData.currency || 'EUR',
                                deliveryTimeInDays: parsedData.deliveryTimeInDays,
                                deliveryDate: parsedData.deliveryDate,
                                paymentTerms: parsedData.paymentTerms,
                                validityPeriod: parsedData.validityPeriod,
                                additionalNotes: parsedData.additionalNotes,
                                isValidQuotation: true,
                                parsingStatus: 'success'
                            };

                            vendor.quotedTotal = parsedData.totalQuotedAmount;
                            vendor.paymentTerms = parsedData.paymentTerms;

                            if (parsedData.deliveryDate) {
                                vendor.deliveryDate = new Date(parsedData.deliveryDate);
                            }

                            await rfq.save();
                            console.log(`✅ AI parsing successful: ${parsedData.currency} ${parsedData.totalQuotedAmount}`);
                        } else {
                            // AI couldn't extract pricing
                            vendor.quotationData = {
                                isValidQuotation: false,
                                additionalNotes: `Response received. Please review manually. Preview: "${emailBody.substring(0, 200)}..."`,
                                parsingStatus: 'failed'
                            };
                            vendor.notes = 'Response received - manual review required';

                            await rfq.save();
                            console.log(`⚠️ AI parsing incomplete - manual review needed`);
                        }
                    } catch (aiError) {
                        console.error(`❌ AI parsing error:`, aiError.message);

                        // Even if AI fails completely, we still have the raw email
                        vendor.quotationData = {
                            isValidQuotation: false,
                            additionalNotes: `AI parsing error: ${aiError.message}. Full email content available in rawEmailContent.`,
                            parsingStatus: 'failed'
                        };
                        vendor.notes = 'Response received - AI failed - manual review required';

                        await rfq.save();
                    }

                    console.log(`\n📊 FINAL STATUS for ${vendor.vendorName}:`);
                    console.log(`   - Raw email stored: ${vendor.rawEmailContent ? 'YES' : 'NO'}`);
                    console.log(`   - Parsing status: ${vendor.quotationData?.parsingStatus || 'N/A'}`);
                    console.log(`   - Has quotation: ${vendor.quotationData?.isValidQuotation || false}`);

                    // Mark as read
                    await gmail.users.messages.modify({
                        userId: 'me',
                        id: message.id,
                        requestBody: {
                            removeLabelIds: ['UNREAD'],
                        },
                    });

                } catch (error) {
                    console.error(`❌ Error processing message ${message.id}:`, error);
                }
            }

            console.log('\n✅ Finished processing RFQ responses\n');
        } catch (error) {
            console.error('❌ Error in processRFQResponses:', error);
        }
    }

    /**
  * Update RFQ document with vendor response
  */
    async updateRFQWithResponse(rfq, parsedResponse) {
        const vendor = rfq.vendorsContacted.find(
            v => v.vendorCode === parsedResponse.vendorCode
        );

        if (!vendor) return;

        // Update vendor response
        vendor.status = 'responded';
        vendor.responseDate = parsedResponse.receivedDate;
        vendor.emailMessageId = parsedResponse.messageId;

        // STORE RAW EMAIL CONTENT (if available in parsedResponse)
        if (parsedResponse.rawEmailContent) {
            vendor.rawEmailContent = parsedResponse.rawEmailContent;
        }

        // STORE PARSED QUOTATION DATA
        if (parsedResponse.quotationData && parsedResponse.quotationData.isValidQuotation) {
            vendor.quotationData = parsedResponse.quotationData;
            vendor.quotedTotal = parsedResponse.quotationData.totalQuotedAmount;
            vendor.deliveryDate = parsedResponse.quotationData.deliveryDate
                ? new Date(parsedResponse.quotationData.deliveryDate)
                : null;
            vendor.paymentTerms = parsedResponse.quotationData.paymentTerms;
            vendor.notes = parsedResponse.quotationData.additionalNotes;
        } else {
            // Email received but couldn't parse pricing
            vendor.quotationData = {
                isValidQuotation: false,
                additionalNotes: parsedResponse.quotationData?.additionalNotes || 'Email received - manual review required',
                parsingStatus: 'failed'
            };
            vendor.notes = 'Response received - manual review required';
        }

        // Update RFQ status
        const allResponded = rfq.vendorsContacted.every(
            v => ['responded', 'declined'].includes(v.status)
        );

        rfq.status = allResponded ? 'completed' : 'in_progress';

        await rfq.save();
    }
}

module.exports = new RFQEmailMonitor();