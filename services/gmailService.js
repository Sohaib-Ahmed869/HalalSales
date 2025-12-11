const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const pdfParse = require('pdf-parse');

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
        const scopes = ['https://www.googleapis.com/auth/gmail.modify'];
        return this.oauth2Client.generateAuthUrl({
            access_type: 'offline',
            scope: scopes,
        });
    }

    /**
     * Exchange auth code for refresh token (run once)
     */
    async getTokenFromCode(code) {
        const { tokens } = await this.oauth2Client.getToken(code);
        console.log('🔑 Refresh Token:', tokens.refresh_token);
        console.log('Add this to your .env file as GMAIL_REFRESH_TOKEN');
        return tokens;
    }

    /**
     * Send email via Gmail
     */
    async sendEmail({ to, subject, html, text, attachments = [] }) {
        try {
            const accessToken = await this.oauth2Client.getAccessToken();

            const transporter = nodemailer.createTransport({
                service: 'gmail',
                auth: {
                    type: 'OAuth2',
                    user: process.env.RFQ_EMAIL_FROM,
                    clientId: process.env.GMAIL_CLIENT_ID,
                    clientSecret: process.env.GMAIL_CLIENT_SECRET,
                    refreshToken: process.env.GMAIL_REFRESH_TOKEN,
                    accessToken: accessToken.token,
                },
            });

            const mailOptions = {
                from: process.env.RFQ_EMAIL_FROM,
                to,
                subject,
                text,
                html,
                attachments,
            };

            const result = await transporter.sendMail(mailOptions);
            console.log(`✅ Email sent to ${to}:`, result.messageId);

            return {
                success: true,
                messageId: result.messageId,
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

            // Extract email body
            let body = '';
            if (message.data.payload.body.data) {
                body = Buffer.from(message.data.payload.body.data, 'base64').toString('utf-8');
            } else if (message.data.payload.parts) {
                const textPart = message.data.payload.parts.find(
                    part => part.mimeType === 'text/plain' || part.mimeType === 'text/html'
                );
                if (textPart?.body?.data) {
                    body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
                }
            }

            // Extract attachments
            const attachments = await this.extractAttachments(message.data);

            return {
                messageId,
                from,
                subject,
                date: new Date(date),
                body,
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