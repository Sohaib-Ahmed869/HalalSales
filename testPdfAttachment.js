require('dotenv').config();
const { google } = require('googleapis');
const gmailService = require('./services/gmailService');
const { extractTextFromMultiplePDFs } = require('./utils/pdfExtractor');
const { parseRFQResponseWithAI } = require('./services/aiService');

/**
 * Comprehensive PDF Attachment Processing Test
 * Tests the entire flow: Gmail fetch → PDF extraction → AI parsing
 */
async function testPdfAttachmentProcessing() {
    try {
        console.log('\n' + '='.repeat(80));
        console.log('🔍 PDF ATTACHMENT PROCESSING DIAGNOSTIC TEST');
        console.log('='.repeat(80));

        // ============================================
        // STEP 1: Connect to Gmail
        // ============================================
        console.log('\n📧 STEP 1: Connecting to Gmail...');
        console.log('   Refresh token exists?', !!process.env.GMAIL_REFRESH_TOKEN);

        const gmail = gmailService.gmail;

        const profile = await gmail.users.getProfile({ userId: 'me' });
        console.log('   ✅ Connected as:', profile.data.emailAddress);

        // ============================================
        // STEP 2: Fetch Latest RFQ Response
        // ============================================
        console.log('\n📬 STEP 2: Fetching latest RFQ response...');

        // Try to find RFQ emails (both read and unread)
        const searchQueries = [
            'subject:RFQ is:unread',
            'subject:RFQ',
            'subject:"Request for Quotation" is:unread',
            'subject:"Request for Quotation"',
            'has:attachment is:unread',
            'has:attachment'
        ];

        let messages = [];
        let usedQuery = '';

        for (const query of searchQueries) {
            console.log(`   Trying query: "${query}"`);
            const response = await gmail.users.messages.list({
                userId: 'me',
                q: query,
                maxResults: 5,
            });

            if (response.data.messages && response.data.messages.length > 0) {
                messages = response.data.messages;
                usedQuery = query;
                console.log(`   ✅ Found ${messages.length} message(s) with query: "${query}"`);
                break;
            }
        }

        if (messages.length === 0) {
            console.log('\n❌ No RFQ messages found!');
            console.log('   Try sending a test email with subject containing "RFQ" and a PDF attachment');
            return;
        }

        // Use the first (most recent) message
        const messageId = messages[0].id;
        console.log(`   Using message ID: ${messageId}`);

        // ============================================
        // STEP 3: Get Full Message Details
        // ============================================
        console.log('\n📄 STEP 3: Fetching full message details...');

        const fullMessage = await gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'full',
        });

        const headers = fullMessage.data.payload.headers;
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        const from = headers.find(h => h.name === 'From')?.value || '';
        const date = headers.find(h => h.name === 'Date')?.value || '';

        console.log('   From:', from);
        console.log('   Subject:', subject);
        console.log('   Date:', date);

        // ============================================
        // STEP 4: Analyze Message Structure
        // ============================================
        console.log('\n🔍 STEP 4: Analyzing message structure...');
        console.log('   MIME Type:', fullMessage.data.payload.mimeType);
        console.log('   Has body.data?', !!fullMessage.data.payload.body?.data);
        console.log('   Has parts?', !!fullMessage.data.payload.parts);

        if (fullMessage.data.payload.parts) {
            console.log('\n   Parts breakdown:');
            fullMessage.data.payload.parts.forEach((part, idx) => {
                console.log(`   [${idx}] ${part.mimeType}`);
                console.log(`       - Filename: ${part.filename || 'none'}`);
                console.log(`       - Has body.data: ${!!part.body?.data}`);
                console.log(`       - Body size: ${part.body?.size || 0} bytes`);
                console.log(`       - Has attachmentId: ${!!part.body?.attachmentId}`);
                console.log(`       - Has nested parts: ${!!part.parts}`);

                if (part.parts) {
                    part.parts.forEach((subPart, subIdx) => {
                        console.log(`       [${idx}.${subIdx}] ${subPart.mimeType}`);
                        console.log(`           - Filename: ${subPart.filename || 'none'}`);
                        console.log(`           - Has attachmentId: ${!!subPart.body?.attachmentId}`);
                    });
                }
            });
        }

        // ============================================
        // STEP 5: Extract Email Body
        // ============================================
        console.log('\n📝 STEP 5: Extracting email body...');

        let emailBody = '';
        let htmlBody = '';

        const extractBody = (parts) => {
            if (!parts) return;
            for (const part of parts) {
                if (part.mimeType === 'text/plain' && part.body.data) {
                    const decoded = Buffer.from(part.body.data, 'base64').toString('utf-8');
                    emailBody += decoded + '\n\n';
                    console.log(`   ✅ Extracted text/plain: ${decoded.length} chars`);
                }
                if (part.mimeType === 'text/html' && part.body.data) {
                    const decoded = Buffer.from(part.body.data, 'base64').toString('utf-8');
                    htmlBody += decoded + '\n\n';
                    console.log(`   ✅ Extracted text/html: ${decoded.length} chars`);
                }
                if (part.parts) {
                    extractBody(part.parts);
                }
            }
        };

        if (fullMessage.data.payload.parts) {
            extractBody(fullMessage.data.payload.parts);
        } else if (fullMessage.data.payload.body.data) {
            const decoded = Buffer.from(fullMessage.data.payload.body.data, 'base64').toString('utf-8');
            const mimeType = fullMessage.data.payload.mimeType;
            if (mimeType === 'text/plain') {
                emailBody = decoded;
            } else if (mimeType === 'text/html') {
                htmlBody = decoded;
            } else {
                emailBody = decoded;
            }
            console.log(`   ✅ Extracted from payload.body: ${decoded.length} chars`);
        }

        const finalEmailBody = emailBody.trim() || htmlBody.trim() || 'No email body content';

        console.log('\n   BODY EXTRACTION RESULTS:');
        console.log(`   - Text body: ${emailBody.length} chars`);
        console.log(`   - HTML body: ${htmlBody.length} chars`);
        console.log(`   - Final body: ${finalEmailBody.length} chars`);

        if (finalEmailBody.length > 0) {
            console.log(`\n   📄 Body preview (first 300 chars):`);
            console.log('   ' + '-'.repeat(60));
            console.log('   ' + finalEmailBody.substring(0, 300).replace(/\n/g, '\n   '));
            console.log('   ' + '-'.repeat(60));
        }

        // ============================================
        // STEP 6: Find and Download PDF Attachments
        // ============================================
        console.log('\n📎 STEP 6: Finding PDF attachments...');

        const attachments = [];

        const findAttachments = (parts) => {
            if (!parts) return;
            for (const part of parts) {
                if (part.filename && part.body.attachmentId) {
                    attachments.push({
                        filename: part.filename,
                        mimeType: part.mimeType,
                        attachmentId: part.body.attachmentId,
                        size: part.body.size
                    });
                    console.log(`   Found: ${part.filename} (${part.mimeType}, ${(part.body.size / 1024).toFixed(2)} KB)`);
                }
                if (part.parts) {
                    findAttachments(part.parts);
                }
            }
        };

        if (fullMessage.data.payload.parts) {
            findAttachments(fullMessage.data.payload.parts);
        }

        console.log(`\n   Total attachments found: ${attachments.length}`);

        const pdfAttachments = attachments.filter(a =>
            a.mimeType === 'application/pdf' && a.size < 10485760 // Max 10MB
        );

        console.log(`   PDF attachments: ${pdfAttachments.length}`);

        if (pdfAttachments.length === 0) {
            console.log('\n⚠️ No PDF attachments found in this email');
            console.log('   The email body content is still available:');
            console.log(`   - Body: ${finalEmailBody.length} chars`);

            // Test with just email body
            console.log('\n🤖 Testing AI parsing with email body only...');
            await testAIParsing(subject, from, finalEmailBody, '', date);
            return;
        }

        // ============================================
        // STEP 7: Download PDF Attachments
        // ============================================
        console.log('\n📥 STEP 7: Downloading PDF attachments...');

        const pdfBuffers = [];

        for (const pdfAttachment of pdfAttachments) {
            try {
                console.log(`\n   Downloading: ${pdfAttachment.filename}`);
                console.log(`   - Size: ${(pdfAttachment.size / 1024).toFixed(2)} KB`);
                console.log(`   - Attachment ID: ${pdfAttachment.attachmentId}`);

                const attachmentData = await gmail.users.messages.attachments.get({
                    userId: 'me',
                    messageId: messageId,
                    id: pdfAttachment.attachmentId,
                });

                console.log(`   - Downloaded data size: ${(attachmentData.data.data.length / 1024).toFixed(2)} KB`);

                // Decode base64 to buffer
                const pdfBuffer = Buffer.from(attachmentData.data.data, 'base64');

                console.log(`   - Decoded buffer size: ${(pdfBuffer.length / 1024).toFixed(2)} KB`);
                console.log(`   - First 4 bytes (PDF signature): ${pdfBuffer.slice(0, 4).toString()}`);

                // Verify it's actually a PDF
                const isPDF = pdfBuffer.slice(0, 4).toString() === '%PDF';
                console.log(`   - Valid PDF signature: ${isPDF ? '✅ YES' : '❌ NO'}`);

                if (!isPDF) {
                    console.log('   ⚠️ Warning: File does not have valid PDF signature!');
                }

                pdfBuffers.push({
                    buffer: pdfBuffer,
                    filename: pdfAttachment.filename
                });

                console.log(`   ✅ Successfully prepared ${pdfAttachment.filename}`);

            } catch (downloadError) {
                console.error(`   ❌ Failed to download ${pdfAttachment.filename}:`, downloadError.message);
                console.error('   Error details:', downloadError);
            }
        }

        if (pdfBuffers.length === 0) {
            console.log('\n❌ No PDF buffers were successfully prepared');
            return;
        }

        // ============================================
        // STEP 8: Extract Text from PDFs
        // ============================================
        console.log('\n📄 STEP 8: Extracting text from PDFs...');
        console.log(`   Processing ${pdfBuffers.length} PDF(s)...`);

        let pdfContent = '';

        try {
            pdfContent = await extractTextFromMultiplePDFs(pdfBuffers);
            console.log(`\n   ✅ EXTRACTION SUCCESSFUL!`);
            console.log(`   - Total extracted text: ${pdfContent.length} characters`);
            console.log(`   - Size: ${(pdfContent.length / 1024).toFixed(2)} KB`);

            // Show preview
            if (pdfContent.length > 0) {
                console.log(`\n   📄 PDF Content Preview (first 500 chars):`);
                console.log('   ' + '='.repeat(60));
                console.log('   ' + pdfContent.substring(0, 500).replace(/\n/g, '\n   '));
                console.log('   ' + '='.repeat(60));
            }

        } catch (extractError) {
            console.error('\n   ❌ PDF EXTRACTION FAILED!');
            console.error('   Error:', extractError.message);
            console.error('   Stack:', extractError.stack);
            pdfContent = `\n\n=== PDF EXTRACTION FAILED ===\nError: ${extractError.message}\n`;
        }

        // ============================================
        // STEP 9: Combine Content
        // ============================================
        console.log('\n📊 STEP 9: Combining all content...');

        const fullContent = [finalEmailBody, pdfContent]
            .filter(Boolean)
            .join('\n\n=== PDF ATTACHMENT CONTENT ===\n\n');

        console.log(`   - Email body: ${finalEmailBody.length} chars`);
        console.log(`   - PDF content: ${pdfContent.length} chars`);
        console.log(`   - Combined total: ${fullContent.length} chars`);

        // ============================================
        // STEP 10: Test AI Parsing
        // ============================================
        console.log('\n🤖 STEP 10: Testing AI parsing...');

        await testAIParsing(subject, from, finalEmailBody, pdfContent, date, fullContent);

        // ============================================
        // FINAL SUMMARY
        // ============================================
        console.log('\n' + '='.repeat(80));
        console.log('📋 TEST SUMMARY');
        console.log('='.repeat(80));
        console.log(`✅ Gmail Connection: SUCCESS`);
        console.log(`✅ Message Fetched: ${messageId}`);
        console.log(`✅ Email Body: ${finalEmailBody.length} chars`);
        console.log(`✅ Attachments Found: ${attachments.length}`);
        console.log(`✅ PDF Attachments: ${pdfAttachments.length}`);
        console.log(`✅ PDFs Downloaded: ${pdfBuffers.length}`);
        console.log(`✅ PDF Text Extracted: ${pdfContent.length} chars`);
        console.log(`✅ Combined Content: ${fullContent.length} chars`);
        console.log('='.repeat(80));

    } catch (error) {
        console.error('\n❌ CRITICAL ERROR:', error.message);
        console.error('Stack trace:', error.stack);
    }
}

/**
 * Test AI parsing with the extracted content
 */
async function testAIParsing(subject, from, emailBody, pdfContent, date, fullContent = null) {
    try {
        // Extract email address
        const emailMatch = from.match(/<(.+?)>/);
        const vendorEmail = emailMatch ? emailMatch[1] : from;

        // Try to extract RFQ number
        const rfqMatch = subject.match(/RFQ[- ]?(\d{6,8})/i);
        const rfqNumber = rfqMatch ? `RFQ-${rfqMatch[1]}` : 'RFQ-TEST';

        const contentToAnalyze = fullContent || [emailBody, pdfContent]
            .filter(Boolean)
            .join('\n\n=== PDF ATTACHMENT CONTENT ===\n\n');

        console.log('\n   Preparing AI request...');
        console.log(`   - RFQ Number: ${rfqNumber}`);
        console.log(`   - Vendor: ${vendorEmail}`);
        console.log(`   - Content length: ${contentToAnalyze.length} chars`);

        const parsedData = await parseRFQResponseWithAI({
            rfqNumber: rfqNumber,
            vendorName: from,
            vendorEmail: vendorEmail,
            emailSubject: subject,
            emailBody: contentToAnalyze,
            pdfContent: pdfContent,
            date: date,
        });

        console.log('\n   🤖 AI PARSING RESULTS:');
        console.log('   ' + '-'.repeat(60));
        console.log('   Is Valid Response:', parsedData.isValidResponse);
        console.log('   Response Type:', parsedData.responseType);

        if (parsedData.totalQuotedAmount) {
            console.log(`   ✅ PRICE FOUND: ${parsedData.currency} ${parsedData.totalQuotedAmount}`);
        } else {
            console.log('   ⚠️ No price extracted');
        }

        if (parsedData.quotedItems && parsedData.quotedItems.length > 0) {
            console.log(`   Items: ${parsedData.quotedItems.length}`);
            parsedData.quotedItems.forEach((item, idx) => {
                console.log(`     ${idx + 1}. ${item.productName}: ${item.currency} ${item.totalPrice}`);
            });
        }

        if (parsedData.deliveryDate) {
            console.log(`   Delivery: ${parsedData.deliveryDate}`);
        }

        if (parsedData.additionalNotes) {
            console.log(`   Notes: ${parsedData.additionalNotes.substring(0, 100)}...`);
        }

        console.log('\n   Full AI Response:');
        console.log('   ' + JSON.stringify(parsedData, null, 2).split('\n').join('\n   '));
        console.log('   ' + '-'.repeat(60));

    } catch (aiError) {
        console.error('\n   ❌ AI PARSING FAILED:', aiError.message);
        console.error('   Stack:', aiError.stack);
    }
}

// Run the test
console.log('Starting PDF attachment processing test...\n');
testPdfAttachmentProcessing()
    .then(() => {
        console.log('\n✅ Test completed successfully');
        process.exit(0);
    })
    .catch(error => {
        console.error('\n❌ Test failed:', error);
        process.exit(1);
    });