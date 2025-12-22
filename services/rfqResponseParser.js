const { parseQuotationFromText } = require('./aiService');
const gmailService = require('./gmailService');

class RFQResponseParser {
    /**
     * Parse vendor response email and extract quotation data
     */
    async parseVendorResponse(email, rfq) {
        try {
            const aiService = require('./aiService');

            // Parse with AI
            const parsedData = await aiService.parseRFQResponseWithAI({
                rfqNumber: rfq.rfqNumber,
                vendorName: email.from,
                vendorEmail: email.fromEmail,
                emailSubject: email.subject,
                emailBody: email.body,
                date: email.date,
                pdfContent: email.pdfContent || null
            });

            // Find vendor in RFQ
            const vendor = rfq.vendorsContacted.find(
                v => v.email.toLowerCase() === email.fromEmail.toLowerCase()
            );

            return {
                vendorCode: vendor?.vendorCode,
                vendorName: vendor?.vendorName || email.from,
                messageId: email.messageId,
                receivedDate: new Date(email.date),

                // INCLUDE RAW EMAIL CONTENT
                rawEmailContent: {
                    subject: email.subject,
                    body: email.body,
                    htmlBody: email.htmlBody || '',
                    receivedDate: new Date(email.date),
                    attachments: email.attachments || []
                },

                quotationData: {
                    ...parsedData,
                    parsingStatus: parsedData.isValidResponse ? 'success' : 'failed'
                }
            };
        } catch (error) {
            console.error('Error parsing vendor response:', error);
            return null;
        }
    }

    /**
     * Extract email address from "Name <email@example.com>" format
     */
    extractEmail(fromString) {
        const match = fromString.match(/<(.+?)>/);
        return match ? match[1] : fromString;
    }
}

module.exports = new RFQResponseParser();