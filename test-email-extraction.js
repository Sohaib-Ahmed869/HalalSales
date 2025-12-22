require('dotenv').config(); // ← ADD THIS!
const { google } = require('googleapis');
const gmailService = require('./services/gmailService');

async function testEmailExtraction() {
    try {
        console.log('\n🔍 Testing Gmail connection...');
        console.log('Refresh token exists?', !!process.env.GMAIL_REFRESH_TOKEN);

        const gmail = gmailService.gmail;

        // Test connection first
        const profile = await gmail.users.getProfile({ userId: 'me' });
        console.log('✅ Connected as:', profile.data.emailAddress);

        // Get the most recent unread email
        const response = await gmail.users.messages.list({
            userId: 'me',
            q: 'subject:RFQ is:unread',
            maxResults: 1,
        });

        if (!response.data.messages || response.data.messages.length === 0) {
            console.log('\n⚠️ No unread RFQ messages found');
            console.log('Trying to get ANY recent message...');

            const anyMessage = await gmail.users.messages.list({
                userId: 'me',
                maxResults: 1,
            });

            if (!anyMessage.data.messages) {
                console.log('No messages at all!');
                return;
            }

            var messageId = anyMessage.data.messages[0].id;
        } else {
            var messageId = response.data.messages[0].id;
        }

        console.log(`\n📧 Testing with message ID: ${messageId}`);

        const fullMessage = await gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'full',
        });

        const headers = fullMessage.data.payload.headers;
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        const from = headers.find(h => h.name === 'From')?.value || '';

        console.log('\n📋 MESSAGE INFO:');
        console.log('From:', from);
        console.log('Subject:', subject);

        // DIAGNOSTIC: Show structure
        console.log('\n🔍 PAYLOAD STRUCTURE:');
        console.log('MimeType:', fullMessage.data.payload.mimeType);
        console.log('Has body.data?', !!fullMessage.data.payload.body?.data);
        console.log('Has parts?', !!fullMessage.data.payload.parts);

        if (fullMessage.data.payload.parts) {
            console.log('Parts:');
            fullMessage.data.payload.parts.forEach((part, idx) => {
                console.log(`  [${idx}] ${part.mimeType}`, {
                    filename: part.filename || 'none',
                    hasBodyData: !!part.body?.data,
                    bodySize: part.body?.size || 0,
                    hasParts: !!part.parts
                });

                // Check nested parts
                if (part.parts) {
                    part.parts.forEach((subPart, subIdx) => {
                        console.log(`    [${idx}.${subIdx}] ${subPart.mimeType}`, {
                            hasBodyData: !!subPart.body?.data,
                            bodySize: subPart.body?.size || 0
                        });
                    });
                }
            });
        }

        // Extract body
        let emailBody = '';
        let htmlBody = '';

        const extractBody = (part) => {
            if (!part) return;

            if (part.body && part.body.data) {
                try {
                    const decoded = Buffer.from(part.body.data, 'base64').toString('utf-8');

                    if (part.mimeType === 'text/plain') {
                        emailBody += decoded + '\n\n';
                        console.log(`  ✅ Extracted text/plain: ${decoded.length} chars`);
                    } else if (part.mimeType === 'text/html') {
                        htmlBody += decoded + '\n\n';
                        console.log(`  ✅ Extracted text/html: ${decoded.length} chars`);
                    }
                } catch (err) {
                    console.error(`  ❌ Error decoding part:`, err.message);
                }
            }

            if (part.parts && Array.isArray(part.parts)) {
                part.parts.forEach(p => extractBody(p));
            }
        };

        console.log('\n📄 EXTRACTING BODY...');

        const payload = fullMessage.data.payload;

        if (payload.body && payload.body.data) {
            console.log('  Body in payload.body.data');
            emailBody = Buffer.from(payload.body.data, 'base64').toString('utf-8');
        } else if (payload.parts) {
            console.log('  Body in payload.parts');
            payload.parts.forEach(part => extractBody(part));
        }

        console.log('\n📊 EXTRACTION RESULTS:');
        console.log('Text body length:', emailBody.length);
        console.log('HTML body length:', htmlBody.length);

        if (emailBody.length === 0 && htmlBody.length === 0) {
            console.log('\n❌ BOTH BODIES ARE EMPTY!');
            console.log('Full payload structure:');
            console.log(JSON.stringify(fullMessage.data.payload, null, 2));
        } else {
            if (emailBody) {
                console.log('\n✅ TEXT BODY (first 500 chars):');
                console.log(emailBody.substring(0, 500));
            }

            if (htmlBody) {
                console.log('\n✅ HTML BODY (first 500 chars):');
                console.log(htmlBody.substring(0, 500));
            }
        }

    } catch (error) {
        console.error('\n❌ ERROR:', error.message);
        console.error(error);
    }
}

testEmailExtraction();