const { google } = require('googleapis');
const gmailService = require('./gmailService');
const rfqResponseParser = require('./rfqResponseParser');
const RFQ = require('../models/RFQ');
const { extractTextFromMultiplePDFs } = require('../utils/pdfExtractor');
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

                    // ========================================
                    // FIXED: Extract email body properly
                    // ========================================
                    let emailBody = '';
                    let htmlBody = '';
                    const attachments = [];

                    const extractBody = (parts) => {
                        if (!parts) return;
                        for (const part of parts) {
                            // FIXED: Check if body exists
                            if (part.mimeType === 'text/plain' && part.body && part.body.data) {
                                emailBody += Buffer.from(part.body.data, 'base64').toString('utf-8') + '\n\n';
                            }
                            if (part.mimeType === 'text/html' && part.body && part.body.data) {
                                htmlBody += Buffer.from(part.body.data, 'base64').toString('utf-8') + '\n\n';
                            }
                            if (part.filename && part.body && part.body.attachmentId) {
                                attachments.push({
                                    filename: part.filename,
                                    mimeType: part.mimeType,
                                    attachmentId: part.body.attachmentId,
                                    size: part.body.size
                                });
                            }
                            if (part.parts) {
                                extractBody(part.parts);
                            }
                        }
                    };

                    if (fullMessage.data.payload.parts) {
                        extractBody(fullMessage.data.payload.parts);
                    } else if (fullMessage.data.payload.body && fullMessage.data.payload.body.data) {
                        // ADDED: Handle single-part message
                        const decoded = Buffer.from(fullMessage.data.payload.body.data, 'base64').toString('utf-8');
                        const mimeType = fullMessage.data.payload.mimeType;

                        if (mimeType === 'text/plain') {
                            emailBody = decoded;
                        } else if (mimeType === 'text/html') {
                            htmlBody = decoded;
                        } else {
                            emailBody = decoded;
                        }
                    }

                    // Use text body if available, otherwise HTML
                    const finalEmailBody = emailBody.trim() || htmlBody.trim() || 'No email body content';

                    console.log(`\n📧 Processing email from: ${from}`);
                    console.log(`📝 Subject: ${subject}`);
                    console.log(`📄 Body length: ${finalEmailBody.length} chars`);
                    console.log(`📎 Attachments: ${attachments.length}`);

                    // ========================================
                    // EXTRACT PDF CONTENT USING PDF.js
                    // ========================================
                    let pdfContent = '';
                    const pdfAttachments = attachments.filter(a =>
                        a.mimeType === 'application/pdf' && a.size < 10485760 // Max 10MB
                    );

                    if (pdfAttachments.length > 0) {
                        console.log(`\n📄 Found ${pdfAttachments.length} PDF attachment(s), extracting text...`);

                        const pdfBuffers = [];

                        for (const pdfAttachment of pdfAttachments) {
                            try {
                                console.log(`📥 Downloading PDF: ${pdfAttachment.filename}`);

                                // Download attachment
                                const attachmentData = await gmail.users.messages.attachments.get({
                                    userId: 'me',
                                    messageId: message.id,
                                    id: pdfAttachment.attachmentId,
                                });

                                // Decode base64 to buffer
                                const pdfBuffer = Buffer.from(attachmentData.data.data, 'base64');

                                pdfBuffers.push({
                                    buffer: pdfBuffer,
                                    filename: pdfAttachment.filename
                                });

                                console.log(`✅ Downloaded ${pdfAttachment.filename} (${(pdfBuffer.length / 1024).toFixed(2)} KB)`);
                            } catch (downloadError) {
                                console.error(`❌ Failed to download PDF ${pdfAttachment.filename}:`, downloadError.message);
                            }
                        }

                        // Extract text from all PDFs
                        if (pdfBuffers.length > 0) {
                            try {
                                const { extractTextFromMultiplePDFs } = require('../utils/pdfExtractor');
                                pdfContent = await extractTextFromMultiplePDFs(pdfBuffers);
                                console.log(`✅ Successfully extracted ${pdfContent.length} characters from ${pdfBuffers.length} PDF(s)`);
                            } catch (extractError) {
                                console.error(`❌ Failed to extract PDF content:`, extractError.message);
                                pdfContent = `\n\n=== PDF EXTRACTION FAILED ===\nError: ${extractError.message}\n`;
                            }
                        }
                    }

                    // Extract RFQ number
                    const rfqMatch = subject.match(/RFQ[- ]?(\d{6,8})/i);
                    if (!rfqMatch) {
                        console.log(`⚠️ No valid RFQ number in subject`);
                        await gmail.users.messages.modify({
                            userId: 'me',
                            id: message.id,
                            requestBody: { removeLabelIds: ['UNREAD'] },
                        });
                        continue;
                    }

                    const rfqNumber = `RFQ-${rfqMatch[1]}`;
                    const rfq = await RFQ.findOne({ rfqNumber: rfqNumber });

                    if (!rfq) {
                        console.log(`⚠️ RFQ not found: ${rfqNumber}`);
                        await gmail.users.messages.modify({
                            userId: 'me',
                            id: message.id,
                            requestBody: { removeLabelIds: ['UNREAD'] },
                        });
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
                        await gmail.users.messages.modify({
                            userId: 'me',
                            id: message.id,
                            requestBody: { removeLabelIds: ['UNREAD'] },
                        });
                        continue;
                    }

                    console.log(`\n✅ MATCH FOUND: ${vendor.vendorName} responded to ${rfqNumber}`);

                    // ========================================
                    // STEP 1: ALWAYS STORE RAW EMAIL FIRST
                    // ========================================
                    console.log('\n📝 STEP 1: Storing raw email content...');

                    vendor.rawEmailContent = {
                        subject: subject,
                        body: finalEmailBody,
                        htmlBody: htmlBody.trim(),
                        pdfContent: pdfContent,  // FIXED: Include PDF content
                        receivedDate: new Date(date),
                        attachments: attachments.map(a => a.filename)
                    };
                    vendor.status = 'responded';
                    vendor.responseDate = new Date();
                    vendor.emailMessageId = message.id;

                    rfq.markModified('vendorsContacted');
                    await rfq.save();

                    console.log(`✅ Raw email saved for ${vendor.vendorName}`);
                    console.log(`   - Email body: ${finalEmailBody.length} chars`);
                    console.log(`   - PDF content: ${pdfContent.length} chars`);

                    // Verify save
                    const verifyRfq = await RFQ.findById(rfq._id);
                    const verifyVendor = verifyRfq.vendorsContacted.find(v => v.email === vendor.email);

                    console.log('\n🔍 Verification after save:');
                    console.log(`   - Has rawEmailContent: ${!!verifyVendor.rawEmailContent}`);
                    console.log(`   - Body length: ${verifyVendor.rawEmailContent?.body?.length || 0} chars`);
                    console.log(`   - PDF length: ${verifyVendor.rawEmailContent?.pdfContent?.length || 0} chars`);

                    // ========================================
                    // STEP 2: TRY AI PARSING (non-critical)
                    // ========================================
                    try {
                        const aiService = require('./aiService');

                        console.log(`\n🤖 STEP 2: Attempting AI parsing...`);

                        // FIXED: COMBINE email body + PDF content for AI analysis
                        const fullContent = [finalEmailBody, pdfContent]
                            .filter(Boolean)
                            .join('\n\n=== PDF ATTACHMENT CONTENT ===\n\n');

                        console.log(`📊 Sending to AI: ${fullContent.length} total characters`);
                        console.log(`   - Email: ${finalEmailBody.length} chars`);
                        console.log(`   - PDF: ${pdfContent.length} chars`);

                        const parsedData = await aiService.parseRFQResponseWithAI({
                            rfqNumber: rfq.rfqNumber,
                            vendorName: vendor.vendorName,
                            vendorEmail: vendor.email,
                            emailSubject: subject,
                            emailBody: fullContent, // FIXED: Send combined content
                            pdfContent: pdfContent, // Also send PDF separately for context
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

                            rfq.markModified('vendorsContacted');
                            await rfq.save();
                            console.log(`✅ AI parsing successful: ${parsedData.currency} ${parsedData.totalQuotedAmount}`);
                        } else {
                            vendor.quotationData = {
                                isValidQuotation: false,
                                additionalNotes: `Response received. ${pdfContent ? `PDF content extracted (${(pdfContent.length / 1024).toFixed(2)} KB) but no pricing found.` : 'No PDF attachments.'} Please review manually.`,
                                parsingStatus: 'failed'
                            };
                            vendor.notes = 'Response received - manual review required';

                            rfq.markModified('vendorsContacted');
                            await rfq.save();
                            console.log(`⚠️ AI parsing incomplete - manual review needed`);
                        }
                    } catch (aiError) {
                        console.error(`❌ AI parsing error:`, aiError.message);

                        vendor.quotationData = {
                            isValidQuotation: false,
                            additionalNotes: `AI parsing error: ${aiError.message}. Full email content (including ${pdfContent.length} chars of PDF text) available in rawEmailContent.`,
                            parsingStatus: 'failed'
                        };
                        vendor.notes = 'Response received - AI failed - manual review required';

                        rfq.markModified('vendorsContacted');
                        await rfq.save();
                    }

                    console.log(`\n📊 FINAL STATUS for ${vendor.vendorName}:`);
                    console.log(`   - Raw email stored: ${vendor.rawEmailContent ? 'YES' : 'NO'}`);
                    console.log(`   - Email body: ${vendor.rawEmailContent?.body?.length || 0} chars`);
                    console.log(`   - PDF content: ${vendor.rawEmailContent?.pdfContent?.length || 0} chars`);
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
                    console.error(error.stack);
                }
            }

            console.log('\n✅ Finished processing RFQ responses\n');
        } catch (error) {
            console.error('❌ Error in processRFQResponses:', error);
            console.error(error.stack);
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