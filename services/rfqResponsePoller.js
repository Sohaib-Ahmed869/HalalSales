const cron = require('node-cron');
const gmailService = require('./gmailService');
const RFQ = require('../models/RFQ');

class RFQResponsePoller {
    constructor() {
        this.isRunning = false;
    }

    /**
     * Start polling for RFQ responses
     * Runs every 5 minutes (or based on GMAIL_POLLING_INTERVAL)
     */
    start() {
        if (this.isRunning) {
            console.log('⚠️ RFQ Response Poller already running');
            return;
        }

        const intervalMinutes = process.env.RFQ_EMAIL_POLLING_INTERVAL
            ? Math.floor(process.env.RFQ_EMAIL_POLLING_INTERVAL / 60000)
            : 5;

        console.log(`🔄 Starting RFQ Response Poller (every ${intervalMinutes} minutes)`);

        // Run every X minutes
        this.cronJob = cron.schedule(`*/${intervalMinutes} * * * *`, async () => {
            await this.pollForResponses();
        });

        this.isRunning = true;

        // Run once immediately on start
        this.pollForResponses();
    }

    /**
     * Stop polling
     */
    stop() {
        if (this.cronJob) {
            this.cronJob.stop();
            this.isRunning = false;
            console.log('🛑 RFQ Response Poller stopped');
        }
    }

    /**
     * Poll for new RFQ responses
     */
    async pollForResponses() {
        try {
            console.log('📬 Checking for new RFQ responses...');

            // Get all active RFQs (sent or in_progress)
            const activeRFQs = await RFQ.find({
                status: { $in: ['sent', 'in_progress'] }
            });

            console.log(`📋 Found ${activeRFQs.length} active RFQs to check`);

            for (const rfq of activeRFQs) {
                await this.checkRFQResponses(rfq);
            }

            console.log('✅ RFQ response check completed');
        } catch (error) {
            console.error('❌ Error polling for RFQ responses:', error);
        }
    }

    /**
  * Check responses for a specific RFQ
  */
    async checkRFQResponses(rfq) {
        try {
            console.log(`🔍 Checking responses for RFQ ${rfq.rfqNumber}`);

            // Fetch emails matching this RFQ number
            const emails = await gmailService.fetchRFQResponses(rfq.rfqNumber);

            if (emails.length === 0) {
                console.log(`   No new responses for ${rfq.rfqNumber}`);
                return;
            }

            console.log(`   📧 Found ${emails.length} new response(s) for ${rfq.rfqNumber}`);

            for (const email of emails) {
                // ========================================
                // EXTRACT PDF CONTENT HERE
                // ========================================
                let pdfContent = '';

                if (email.attachments && email.attachments.length > 0) {
                    console.log(`\n📎 Found ${email.attachments.length} attachment(s)`);

                    const pdfAttachments = email.attachments.filter(a =>
                        a.mimeType === 'application/pdf' && a.size < 10485760 // Max 10MB
                    );

                    if (pdfAttachments.length > 0) {
                        console.log(`📄 Processing ${pdfAttachments.length} PDF attachment(s)...`);

                        const { extractTextFromMultiplePDFs } = require('../utils/pdfExtractor');

                        try {
                            // PDFs are already downloaded in email.attachments with .data property
                            const pdfBuffers = pdfAttachments.map(pdf => ({
                                buffer: pdf.data,
                                filename: pdf.filename
                            }));

                            pdfContent = await extractTextFromMultiplePDFs(pdfBuffers);
                            console.log(`✅ Extracted ${pdfContent.length} characters from PDF(s)`);
                            console.log(`📝 PDF Preview: "${pdfContent.substring(0, 200)}..."`);
                        } catch (pdfError) {
                            console.error(`❌ PDF extraction failed:`, pdfError.message);
                            pdfContent = `\n\n=== PDF EXTRACTION FAILED ===\nError: ${pdfError.message}\n`;
                        }
                    }
                }

                // FIXED: Add PDF content to email object
                email.pdfContent = pdfContent;

                await this.processVendorResponse(rfq, email);
            }

        } catch (error) {
            console.error(`❌ Error checking RFQ ${rfq.rfqNumber}:`, error);
        }
    }

    /**
 * Process a vendor email response - FIXED VERSION
 */
    async processVendorResponse(rfq, email) {
        try {
            console.log(`\n${'='.repeat(60)}`);
            console.log(`📨 Processing response from: ${email.from}`);
            console.log(`Subject: ${email.subject}`);
            console.log(`Body length: ${email.body?.length || 0} chars`);
            console.log(`${'='.repeat(60)}`);

            // CRITICAL: Check if body is empty
            if (!email.body || email.body.trim().length === 0) {
                console.error('❌ EMAIL BODY IS EMPTY! Raw email data:');
                console.error('From:', email.from);
                console.error('Subject:', email.subject);
                console.error('Body preview:', email.body);
                console.error('HTML Body length:', email.htmlBody?.length || 0);

                // Try to use HTML body as fallback
                email.body = email.htmlBody || 'No email content available';
                console.log(`⚠️ Using HTML body as fallback (${email.body.length} chars)`);
            }

            // Extract vendor email address
            const extractEmailAddress = (emailString) => {
                const match = emailString.match(/<([^>]+)>/);
                return match ? match[1].trim().toLowerCase() : emailString.trim().toLowerCase();
            };

            const vendorEmail = extractEmailAddress(email.from);
            console.log(`🔍 Looking for vendor: ${vendorEmail}`);

            // Find vendor in RFQ
            const vendor = rfq.vendorsContacted.find(v =>
                v.email.trim().toLowerCase() === vendorEmail
            );

            if (!vendor) {
                console.log(`⚠️ Email from unknown vendor: ${vendorEmail}`);
                console.log(`Available vendors: ${rfq.vendorsContacted.map(v => v.email).join(', ')}`);
                await gmailService.markAsRead(email.messageId);
                return;
            }

            console.log(`✅ Vendor matched: ${vendor.vendorName}`);

            // Check if already processed
            if (vendor.status === 'responded' && vendor.rawEmailContent?.body) {
                console.log(`ℹ️ Vendor ${vendor.vendorName} already responded`);
                await gmailService.markAsRead(email.messageId);
                return;
            }

            // ============================================
            // STEP 1: STORE RAW EMAIL CONTENT FIRST
            // ============================================
            console.log('\n📝 STEP 1: Storing raw email content...');

            // FIXED: Ensure we're storing the actual body content
            const emailBodyContent = email.body?.trim() || email.htmlBody?.trim() || 'No content';

            vendor.rawEmailContent = {
                subject: email.subject || 'No subject',
                body: emailBodyContent,
                htmlBody: email.htmlBody?.trim() || '',
                pdfContent: email.pdfContent || '', // FIXED: Include PDF content
                receivedDate: email.date,
                attachments: (email.attachments || []).map(a => a.filename)
            };

            vendor.status = 'responded';
            vendor.responseDate = email.date;
            vendor.emailMessageId = email.messageId;
            vendor.notes = `Email response received: ${(email.subject || '').substring(0, 50)}...`;

            // CRITICAL: Mark as modified for Mongoose
            rfq.markModified('vendorsContacted');

            await rfq.save();
            console.log('✅ Raw email saved');

            // Verify it saved
            const verifyRfq = await RFQ.findById(rfq._id);
            const verifyVendor = verifyRfq.vendorsContacted.find(v => v.email === vendor.email);

            console.log('🔍 Verification:');
            console.log(`   - Has rawEmailContent: ${!!verifyVendor.rawEmailContent}`);
            console.log(`   - Has body: ${!!verifyVendor.rawEmailContent?.body}`);
            console.log(`   - Body length: ${verifyVendor.rawEmailContent?.body?.length || 0} chars`);
            console.log(`   - PDF length: ${verifyVendor.rawEmailContent?.pdfContent?.length || 0} chars`);
            console.log(`   - Body preview: "${(verifyVendor.rawEmailContent?.body || '').substring(0, 100)}..."`);

            if (!verifyVendor.rawEmailContent?.body || verifyVendor.rawEmailContent.body.length === 0) {
                console.error('❌ RAW EMAIL STILL NOT SAVED!');
                console.error('Debug info:');
                console.error('  - Original email.body length:', email.body?.length || 0);
                console.error('  - Original email.htmlBody length:', email.htmlBody?.length || 0);
                console.error('  - Original email.pdfContent length:', email.pdfContent?.length || 0);
                console.error('  - Saved body length:', verifyVendor.rawEmailContent?.body?.length || 0);
                return;
            }

            // ============================================
            // STEP 2: TRY AI PARSING
            // ============================================
            console.log('\n🤖 STEP 2: Attempting AI parsing...');

            try {
                const aiService = require('./aiService');

                // FIXED: COMBINE email body + PDF content for AI analysis
                const fullContent = [emailBodyContent, email.pdfContent]
                    .filter(Boolean)
                    .join('\n\n=== PDF ATTACHMENT CONTENT ===\n\n');

                console.log(`📊 Sending to AI: ${fullContent.length} total characters`);
                console.log(`   - Email: ${emailBodyContent.length} chars`);
                console.log(`   - PDF: ${(email.pdfContent || '').length} chars`);

                const parsedData = await aiService.parseRFQResponseWithAI({
                    rfqNumber: rfq.rfqNumber,
                    vendorName: vendor.vendorName,
                    vendorEmail: vendor.email,
                    emailSubject: email.subject,
                    emailBody: fullContent, // FIXED: Use combined content
                    pdfContent: email.pdfContent || '', // Also send PDF separately
                    date: email.date.toISOString(),
                });

                console.log('AI Response:', JSON.stringify(parsedData, null, 2));

                if (parsedData.isValidResponse && parsedData.totalQuotedAmount) {
                    console.log(`✅ AI extracted price: ${parsedData.currency} ${parsedData.totalQuotedAmount}`);

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

                    vendor.notes = `Quotation: ${parsedData.currency} ${parsedData.totalQuotedAmount}`;
                } else {
                    console.log(`⚠️ AI could not extract complete pricing`);

                    vendor.quotationData = {
                        isValidQuotation: false,
                        additionalNotes: `Response received. ${email.pdfContent ? `PDF content extracted (${(email.pdfContent.length / 1024).toFixed(2)} KB) but no pricing found.` : 'No PDF attachments.'} Manual review required.`,
                        parsingStatus: 'failed'
                    };
                    vendor.notes = `Response received - manual review required`;
                }
            } catch (aiError) {
                console.error(`❌ AI parsing error:`, aiError.message);

                vendor.quotationData = {
                    isValidQuotation: false,
                    additionalNotes: `AI error: ${aiError.message}. Email content (including ${(email.pdfContent || '').length} chars of PDF text) available in rawEmailContent.`,
                    parsingStatus: 'failed'
                };
                vendor.notes = `Response received - AI failed - manual review required`;
            }

            // Update RFQ status
            const allResponded = rfq.vendorsContacted.every(v =>
                ['responded', 'declined'].includes(v.status)
            );

            if (allResponded) {
                rfq.status = 'completed';
                console.log(`✅ All vendors responded - RFQ ${rfq.rfqNumber} completed`);
            } else {
                rfq.status = 'in_progress';
            }

            // Save with AI parsing results
            rfq.markModified('vendorsContacted');
            await rfq.save();

            // Mark email as read
            await gmailService.markAsRead(email.messageId);

            console.log(`\n✅ Successfully processed response from ${vendor.vendorName}`);
            console.log(`   - Raw email: SAVED (${emailBodyContent.length} chars)`);
            console.log(`   - PDF content: ${(email.pdfContent || '').length} chars`);
            console.log(`   - AI parsing: ${vendor.quotationData?.parsingStatus || 'N/A'}`);
            console.log(`   - Has price: ${!!vendor.quotationData?.totalQuotedAmount}\n`);

        } catch (error) {
            console.error(`❌ Error processing email:`, error);
            console.error(error.stack);
        }
    }
}

module.exports = new RFQResponsePoller();