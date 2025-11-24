const OpenAI = require('openai');

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Generate RFQ content using OpenAI
 */
async function generateRFQContent(options) {
    const {
        items,
        searchTerm,
        packagingRequirements,
        paymentTermsPreference,
        otherNotes,
    } = options;

    // Format items for the prompt
    const itemsText = items.map((item, index) =>
        `${index + 1}. ${item.productName}${item.specifications ? ` (${item.specifications})` : ''} - Quantity: ${item.quantity} ${item.unit}${item.estimatedPrice ? `, Est. Price: €${item.estimatedPrice}` : ''}`
    ).join('\n');

    const prompt = `You are a professional procurement specialist writing a Request for Quotation (RFQ) email.

Generate a professional RFQ email with the following details:

SEARCH CONTEXT: We are looking for suppliers for "${searchTerm}"

ITEMS REQUESTED:
${itemsText}

ADDITIONAL REQUIREMENTS:
${packagingRequirements ? `- Packaging Requirements: ${packagingRequirements}` : ''}
${paymentTermsPreference ? `- Payment Terms Preference: ${paymentTermsPreference}` : ''}
${otherNotes ? `- Other Notes: ${otherNotes}` : ''}

Please generate:
1. A professional email subject line
2. A complete professional email body that:
   - Addresses the supplier professionally
   - Clearly states we are seeking quotations
   - Lists all items with specifications
   - Mentions any special requirements
   - Requests pricing, delivery timelines, and payment terms
   - Provides clear contact information placeholder
   - Has a professional closing
   - Uses a polite and professional tone

Return the response in JSON format:
{
  "subject": "email subject here",
  "body": "complete email body here with proper formatting using \\n for line breaks"
}`;

    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'system',
                    content: 'You are a professional procurement specialist. Generate clear, professional RFQ emails in proper business format.',
                },
                {
                    role: 'user',
                    content: prompt,
                },
            ],
            temperature: 0.7,
            response_format: { type: 'json_object' },
        });

        const result = JSON.parse(completion.choices[0].message.content);

        // Add company signature
        result.body += '\n\nBest regards,\nHalal Food Service\nProcurement Department';

        return result;
    } catch (error) {
        console.error('Error generating RFQ with OpenAI:', error);

        // Fallback to template-based RFQ if AI fails
        return generateFallbackRFQ(options);
    }
}

/**
 * Fallback RFQ generator (template-based)
 */
function generateFallbackRFQ(options) {
    const { items, searchTerm, packagingRequirements, paymentTermsPreference, otherNotes } = options;

    const itemsList = items.map((item, index) =>
        `${index + 1}. ${item.productName}${item.specifications ? ` - ${item.specifications}` : ''}\n   Quantity: ${item.quantity} ${item.unit}`
    ).join('\n\n');

    const subject = `Request for Quotation - ${searchTerm}`;

    const body = `Dear [Supplier Name],

We hope this message finds you well.

We are interested in procuring the following items and would like to request a formal quotation from your company:

${itemsList}

${packagingRequirements ? `Packaging Requirements:\n${packagingRequirements}\n\n` : ''}${paymentTermsPreference ? `Payment Terms Preference:\n${paymentTermsPreference}\n\n` : ''}${otherNotes ? `Additional Notes:\n${otherNotes}\n\n` : ''}Please provide us with:
- Your best pricing per unit
- Delivery timeline and shipping costs
- Payment terms and conditions
- Product certifications (if applicable)
- Minimum order quantities

We look forward to receiving your quotation at your earliest convenience.

Best regards,
Halal Food Service
Procurement Department`;

    return { subject, body };
}

module.exports = {
    generateRFQContent,
};