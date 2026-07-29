const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const config = require('../config/config');

// Conditional import of pdf-parse (may not work on all systems)
let pdfParse = null;
try {
    pdfParse = require('pdf-parse');
    console.log('✅ pdf-parse loaded successfully in gmailService');
} catch (error) {
    console.warn('⚠️ pdf-parse not available in gmailService - PDF processing will be disabled:', error.message);
}

class GmailService {
    constructor() {
        this.oauth2Client = new google.auth.OAuth2(
            process.env.GMAIL_CLIENT_ID,
            process.env.GMAIL_CLIENT_SECRET,
            process.env.GMAIL_REDIRECT_URI
        );

        if (process.env.GMAIL_REFRESH_TOKEN) {
            this.oauth2Client.setCredentials({
                refresh_token: process.env.GMAIL_REFRESH_TOKEN
            });
        }

        this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
    }

    /**
     * Get OAuth2 URL for initial authentication
     */
    getAuthUrl() {
        const scopes = [
            'https://www.googleapis.com/auth/gmail.send',
            'https://www.googleapis.com/auth/gmail.modify'
        ];
        return this.oauth2Client.generateAuthUrl({
            access_type: 'offline',  // CRITICAL: Must be 'offline'
            scope: scopes,
            prompt: 'consent'  // CRITICAL: Force consent screen
        });
    }

    /**
     * Exchange auth code for refresh token (run once)
     */
    async getTokenFromCode(code) {
        const { tokens } = await this.oauth2Client.getToken(code);

        console.log('🔑 Tokens received:', tokens);

        if (!tokens.refresh_token) {
            console.warn('⚠️ No refresh token received. You may need to revoke access and try again.');
        }

        console.log('🔑 Refresh Token:', tokens.refresh_token);
        console.log('Add this to your .env file as GMAIL_REFRESH_TOKEN');

        return tokens;
    }
    /**
     * Send email via Gmail
     */
    /**
 * Send email via Gmail API (more reliable than SMTP)
 */
    async sendEmail({ to, subject, html, text, attachments = [] }) {
        try {
            const email_lines = [];
            const boundary = "boundary_string";

            // Replies must always land in the shared RFQ mailbox the inbound agent
            // watches — never in a caller-supplied or env-configured address.
            const replyToAddress = config.RFQ_CONTACT_EMAIL;

            email_lines.push(`From: ${process.env.RFQ_EMAIL_FROM}`);
            email_lines.push(`To: ${to}`);
            if (replyToAddress) email_lines.push(`Reply-To: ${replyToAddress}`);
            email_lines.push(`Subject: ${subject}`);
            email_lines.push('MIME-Version: 1.0');
            email_lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
            email_lines.push('');
            email_lines.push(`--${boundary}`);
            email_lines.push('Content-Type: text/html; charset=UTF-8');
            email_lines.push('');
            email_lines.push(html || text);

            // Add attachments
            if (attachments && attachments.length > 0) {
                for (const attachment of attachments) {
                    email_lines.push(`--${boundary}`);
                    email_lines.push(`Content-Type: ${attachment.contentType}`);
                    email_lines.push('Content-Transfer-Encoding: base64');
                    email_lines.push(`Content-Disposition: attachment; filename="${attachment.filename}"`);
                    email_lines.push('');
                    email_lines.push(attachment.content.toString('base64'));
                }
            }

            email_lines.push(`--${boundary}--`);

            const email = email_lines.join('\r\n');
            const encodedEmail = Buffer.from(email)
                .toString('base64')
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/, '');

            const response = await this.gmail.users.messages.send({
                userId: 'me',
                requestBody: {
                    raw: encodedEmail,
                },
            });

            console.log(`✅ Email sent to ${to}:`, response.data.id);

            return {
                success: true,
                messageId: response.data.id,
            };
        } catch (error) {
            console.error('❌ Error sending email:', error);
            throw error;
        }
    }

    /**
     * Fetch unread emails matching RFQ criteria
     */
    async fetchRFQResponses(rfqNumber) {
        try {
            const query = `subject:(RFQ ${rfqNumber} OR RE: RFQ-${rfqNumber}) is:unread`;

            const response = await this.gmail.users.messages.list({
                userId: 'me',
                q: query,
            });

            const messages = response.data.messages || [];
            console.log(`📬 Found ${messages.length} unread responses for ${rfqNumber}`);

            const emails = [];
            for (const message of messages) {
                const email = await this.getEmailDetails(message.id);
                emails.push(email);
            }

            return emails;
        } catch (error) {
            console.error('❌ Error fetching emails:', error);
            return [];
        }
    }

    /**
     * Get full email details including attachments
     */
    /**
  * Get full email details including attachments
  */
    async getEmailDetails(messageId) {
        try {
            const message = await this.gmail.users.messages.get({
                userId: 'me',
                id: messageId,
                format: 'full',
            });

            const headers = message.data.payload.headers;
            const from = headers.find(h => h.name === 'From')?.value || '';
            const subject = headers.find(h => h.name === 'Subject')?.value || '';
            const date = headers.find(h => h.name === 'Date')?.value || '';

            // FIXED: Properly extract email body
            let body = '';
            let htmlBody = '';

            const extractBody = (parts) => {
                if (!parts) return;

                for (const part of parts) {
                    // Extract text/plain
                    if (part.mimeType === 'text/plain' && part.body?.data) {
                        body += Buffer.from(part.body.data, 'base64').toString('utf-8') + '\n\n';
                    }
                    // Extract text/html
                    if (part.mimeType === 'text/html' && part.body?.data) {
                        htmlBody += Buffer.from(part.body.data, 'base64').toString('utf-8') + '\n\n';
                    }
                    // Recurse into nested parts
                    if (part.parts) {
                        extractBody(part.parts);
                    }
                }
            };

            // Handle both simple and multipart messages
            if (message.data.payload.parts) {
                extractBody(message.data.payload.parts);
            } else if (message.data.payload.body?.data) {
                // Single-part message
                const mimeType = message.data.payload.mimeType;
                const decoded = Buffer.from(message.data.payload.body.data, 'base64').toString('utf-8');

                if (mimeType === 'text/plain') {
                    body = decoded;
                } else if (mimeType === 'text/html') {
                    htmlBody = decoded;
                } else {
                    body = decoded; // Fallback
                }
            }

            // Use text body if available, otherwise use HTML
            const finalBody = body.trim() || htmlBody.trim() || 'No email body content';

            // Extract attachments
            const attachments = await this.extractAttachments(message.data);

            return {
                messageId,
                from,
                subject,
                date: new Date(date),
                body: finalBody,
                htmlBody: htmlBody.trim(),
                attachments,
            };
        } catch (error) {
            console.error('❌ Error getting email details:', error);
            throw error;
        }
    }

    /**
     * Extract and download attachments from email
     */
    async extractAttachments(message) {
        const attachments = [];

        if (!message.payload.parts) return attachments;

        for (const part of message.payload.parts) {
            if (part.filename && part.body.attachmentId) {
                try {
                    const attachment = await this.gmail.users.messages.attachments.get({
                        userId: 'me',
                        messageId: message.id,
                        id: part.body.attachmentId,
                    });

                    const data = Buffer.from(attachment.data.data, 'base64');

                    attachments.push({
                        filename: part.filename,
                        mimeType: part.mimeType,
                        data,
                        size: part.body.size,
                    });
                } catch (error) {
                    console.error(`❌ Error downloading attachment ${part.filename}:`, error);
                }
            }
        }

        return attachments;
    }

    /**
     * Mark email as read
     */
    async markAsRead(messageId) {
        try {
            await this.gmail.users.messages.modify({
                userId: 'me',
                id: messageId,
                requestBody: {
                    removeLabelIds: ['UNREAD'],
                },
            });
            console.log(`✅ Marked message ${messageId} as read`);
        } catch (error) {
            console.error('❌ Error marking as read:', error);
        }
    }

    /**
     * Extract text from PDF attachment
     */
    async extractTextFromPDF(pdfBuffer) {
        if (!pdfParse) {
            console.warn('⚠️ PDF parsing skipped - pdf-parse module not available');
            return '';
        }

        try {
            const data = await pdfParse(pdfBuffer);
            return data.text;
        } catch (error) {
            console.error('❌ Error parsing PDF:', error);
            return '';
        }
    }
}

module.exports = new GmailService();