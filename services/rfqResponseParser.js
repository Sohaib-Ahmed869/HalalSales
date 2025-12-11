const { parseQuotationFromText } = require('./aiService');
const gmailService = require('./gmailService');

class RFQResponseParser {
    /**
     * Parse vendor response email and extract quotation data
     */
    async parseVendorResponse(email, rfq) {
        console.log(`\n📧 Parsing response from: ${email.from}`);

        try {
            // Extract vendor email
            const vendorEmail = this.extractEmail(email.from);

            // Find vendor in RFQ
            const vendor = rfq.vendorsContacted.find(
                v => v.email.toLowerCase() === vendorEmail.toLowerCase()
            );

            if (!vendor) {
                console.log(`⚠️ Email ${vendorEmail} not in RFQ vendor list`);
                return null;
            }

            // Combine body text with PDF attachments
            let fullText = email.body;

            // Extract text from PDF attachments
            for (const attachment of email.attachments) {
                if (attachment.mimeType === 'application/pdf') {
                    console.log(`📄 Extracting text from PDF: ${attachment.filename}`);
                    const pdfText = await gmailService.extractTextFromPDF(attachment.data);
                    fullText += '\n\n' + pdfText;
                }
            }

            // Use AI to extract structured quotation data
            const quotationData = await parseQuotationFromText(fullText, rfq.items);

            return {
                vendorCode: vendor.vendorCode,
                vendorName: vendor.vendorName,
                vendorEmail,
                messageId: email.messageId,
                receivedDate: email.date,
                quotationData,
                rawEmail: {
                    subject: email.subject,
                    body: email.body,
                    attachments: email.attachments.map(a => ({
                        filename: a.filename,
                        mimeType: a.mimeType,
                        size: a.size,
                    })),
                },
            };
        } catch (error) {
            console.error('❌ Error parsing vendor response:', error);
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