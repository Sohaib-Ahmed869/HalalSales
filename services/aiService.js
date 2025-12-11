// services/aiService.js
const OpenAI = require('openai');
const config = require('../config/config')

const openai = new OpenAI({
    apiKey: process.env.NEW_OPENAI_API_KEY,
});


/**
 * Enhance email HTML with professional footer and styling
 */
function enhanceEmailHTML(bodyHtml, rfqData) {
    const enhancedHTML = `
<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>RFQ - Halal Foods</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #f5f5f5;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 20px 0;">
        <tr>
            <td align="center">
                <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
                    
                    <!-- Header -->
                    <tr>
                        <td style="background: linear-gradient(135deg, #1a4d2e 0%, #2d7a4f 100%); padding: 30px; border-radius: 8px 8px 0 0;">
                            <table width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td>
                                        <img src="https://imageshfs.s3.ap-southeast-2.amazonaws.com/image-removebg-preview+(1).png" alt="Halal Foods" style="height: 60px; display: block;" />
                                    </td>
                                    <td align="right">
                                        <h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 700;">HALAL FOODS</h1>
                                        <p style="color: #e0e0e0; margin: 5px 0 0 0; font-size: 12px;">Premium Food Wholesaler</p>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- Body Content -->
                    <tr>
                        <td style="padding: 40px 30px;">
                            ${bodyHtml}
                        </td>
                    </tr>

                    <!-- Divider -->
                    <tr>
                        <td style="padding: 0 30px;">
                            <div style="border-top: 2px solid #4ade80; margin: 20px 0;"></div>
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="background-color: #f8f9fa; padding: 30px; border-radius: 0 0 8px 8px;">
                            
                            <!-- Company Motto -->
                            <table width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td align="center" style="padding-bottom: 20px;">
                                        <h3 style="color: #1a4d2e; margin: 0 0 10px 0; font-size: 18px; font-weight: 700;">
                                            🌟 HALAL FOODS - Qualité de Confiance depuis des Générations
                                        </h3>
                                        <p style="color: #2d7a4f; margin: 0; font-size: 14px; font-style: italic;">
                                            Trusted Quality Since Generations
                                        </p>
                                    </td>
                                </tr>
                            </table>

                            <!-- Stats Bar -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 6px; padding: 20px; margin-bottom: 20px;">
                                <tr>
                                    <td width="33%" align="center" style="border-right: 1px solid #e5e7eb;">
                                        <div style="color: #1a4d2e; font-size: 24px; font-weight: 700; margin-bottom: 5px;">600+</div>
                                        <div style="color: #6b7280; font-size: 12px;">Références Produits</div>
                                        <div style="color: #9ca3af; font-size: 11px;">Product References</div>
                                    </td>
                                    <td width="33%" align="center" style="border-right: 1px solid #e5e7eb;">
                                        <div style="color: #1a4d2e; font-size: 24px; font-weight: 700; margin-bottom: 5px;">100+</div>
                                        <div style="color: #6b7280; font-size: 12px;">Fournisseurs</div>
                                        <div style="color: #9ca3af; font-size: 11px;">Trusted Suppliers</div>
                                    </td>
                                    <td width="33%" align="center">
                                        <div style="color: #1a4d2e; font-size: 24px; font-weight: 700; margin-bottom: 5px;">25+</div>
                                        <div style="color: #6b7280; font-size: 12px;">Années d'Expérience</div>
                                        <div style="color: #9ca3af; font-size: 11px;">Years of Excellence</div>
                                    </td>
                                </tr>
                            </table>

                            <!-- Contact Information -->
                            <table width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td align="center">
                                        <table cellpadding="5" cellspacing="0">
                                            <tr>
                                                <td align="center">
                                                    <a href="mailto:contact@halalfoods.fr" style="color: #1a4d2e; text-decoration: none; font-size: 14px; font-weight: 600;">
                                                        📧 contact@halalfoods.fr
                                                    </a>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td align="center">
                                                    <span style="color: #4b5563; font-size: 14px; font-weight: 600;">
                                                        📞 +33 1 XX XX XX XX
                                                    </span>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td align="center">
                                                    <span style="color: #4b5563; font-size: 14px;">
                                                        📍 Paris, France
                                                    </span>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td align="center" style="padding-top: 10px;">
                                                    <a href="https://www.halalfoods.fr" style="color: #2d7a4f; text-decoration: none; font-size: 13px;">
                                                        🌐 www.halalfoods.fr
                                                    </a>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>

                            <!-- Certifications -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="margin-top: 20px;">
                                <tr>
                                    <td align="center">
                                        <div style="background-color: #ffffff; border-radius: 6px; padding: 15px; display: inline-block;">
                                            <p style="margin: 0; color: #4b5563; font-size: 11px; font-weight: 600;">
                                                ✅ Certifié Halal | Halal Certified
                                            </p>
                                            <p style="margin: 5px 0 0 0; color: #6b7280; font-size: 11px;">
                                                ISO 9001:2015 | HACCP Compliant | Organic Options Available
                                            </p>
                                        </div>
                                    </td>
                                </tr>
                            </table>

                            <!-- Values -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="margin-top: 20px; border-top: 1px solid #e5e7eb; padding-top: 20px;">
                                <tr>
                                    <td align="center">
                                        <p style="color: #1a4d2e; font-size: 12px; font-weight: 600; margin: 0 0 8px 0;">
                                            Notre Engagement / Our Commitment
                                        </p>
                                        <p style="color: #6b7280; font-size: 11px; margin: 0; line-height: 1.5;">
                                            Qualité Premium • Prix Compétitifs • Livraison Fiable • Service d'Excellence<br/>
                                            Premium Quality • Competitive Prices • Reliable Delivery • Excellence in Service
                                        </p>
                                    </td>
                                </tr>
                            </table>

                            <!-- Legal Footer -->
                            <table width="100%" cellpadding="0" cellspacing="0" style="margin-top: 20px;">
                                <tr>
                                    <td align="center">
                                        <p style="color: #9ca3af; font-size: 10px; margin: 0; line-height: 1.4;">
                                            Ce courriel et toutes les pièces jointes sont confidentiels et destinés uniquement au destinataire.<br/>
                                            This email and any attachments are confidential and intended solely for the addressee.<br/>
                                            <br/>
                                            © ${new Date().getFullYear()} Halal Foods. Tous droits réservés / All rights reserved.
                                        </p>
                                    </td>
                                </tr>
                            </table>

                        </td>
                    </tr>

                </table>
            </td>
        </tr>
    </table>
</body>
</html>
    `;

    return enhancedHTML;
}

/**
 * Generate fallback email template
 */
function generateFallbackEmail(rfqData, vendor) {
    const subject = `Demande de devis / Request for Quotation - RFQ ${rfqData.rfqNumber}`;

    const bodyHtml = `
        <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
            <!-- French Version -->
            <div style="margin-bottom: 30px;">
                <h2 style="color: #1a4d2e; margin-bottom: 15px;">Bonjour ${vendor.vendorName},</h2>
                
                <p style="color: #4b5563; line-height: 1.6; margin-bottom: 15px;">
                    Nous vous remercions pour notre collaboration ${vendor.totalPurchases ? 'continue' : 'et souhaitons établir une relation commerciale avec vous'}.
                </p>
                
                <p style="color: #4b5563; line-height: 1.6; margin-bottom: 15px;">
                    Nous vous prions de bien vouloir nous faire parvenir votre meilleure offre pour les produits détaillés dans le document PDF ci-joint.
                </p>
                
                <div style="background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 4px;">
                    <p style="margin: 0; color: #92400e; font-weight: 600;">
                        📋 Numéro de demande: ${rfqData.rfqNumber}<br/>
                        📅 Date limite de soumission: ${new Date(rfqData.quotationDueDate).toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' })}<br/>
                        🚚 Livraison souhaitée: ${new Date(rfqData.deliveryBy).toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' })}
                    </p>
                </div>
                
                ${rfqData.customMessage ? `<p style="color: #4b5563; line-height: 1.6; margin-bottom: 15px; font-style: italic;">${rfqData.customMessage}</p>` : ''}
                
                <p style="color: #4b5563; line-height: 1.6; margin-bottom: 15px;">
                    Veuillez inclure dans votre devis:
                </p>
                <ul style="color: #4b5563; line-height: 1.8;">
                    <li>Prix unitaires et totaux</li>
                    <li>Conditions de livraison</li>
                    <li>Modalités de paiement</li>
                    <li>Disponibilité des produits</li>
                </ul>
                
                <p style="color: #4b5563; line-height: 1.6; margin-top: 20px;">
                    Nous restons à votre disposition pour toute question.<br/>
                    Cordialement,
                </p>
                
                <div style="margin-top: 20px;">
                    <p style="margin: 0; color: #1a4d2e; font-weight: 600;">L'équipe Halal Foods</p>
                    <p style="margin: 5px 0 0 0; color: #6b7280; font-size: 14px;">Service Achats / Procurement Department</p>
                </div>
            </div>
            
            <!-- Separator -->
            <div style="border-top: 3px double #cbd5e1; margin: 40px 0;"></div>
            
            <!-- English Version -->
            <div>
                <h2 style="color: #1a4d2e; margin-bottom: 15px;">Dear ${vendor.vendorName},</h2>
                
                <p style="color: #4b5563; line-height: 1.6; margin-bottom: 15px;">
                    Thank you for ${vendor.totalPurchases ? 'your continued partnership' : 'considering a business relationship with us'}.
                </p>
                
                <p style="color: #4b5563; line-height: 1.6; margin-bottom: 15px;">
                    We kindly request your best quotation for the products detailed in the attached PDF document.
                </p>
                
                <div style="background-color: #dbeafe; border-left: 4px solid #3b82f6; padding: 15px; margin: 20px 0; border-radius: 4px;">
                    <p style="margin: 0; color: #1e40af; font-weight: 600;">
                        📋 RFQ Number: ${rfqData.rfqNumber}<br/>
                        📅 Quotation Due Date: ${new Date(rfqData.quotationDueDate).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })}<br/>
                        🚚 Requested Delivery: ${new Date(rfqData.deliveryBy).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })}
                    </p>
                </div>
                
                <p style="color: #4b5563; line-height: 1.6; margin-bottom: 15px;">
                    Please include in your quotation:
                </p>
                <ul style="color: #4b5563; line-height: 1.8;">
                    <li>Unit and total prices</li>
                    <li>Delivery terms and conditions</li>
                    <li>Payment terms</li>
                    <li>Product availability</li>
                </ul>
                
                <p style="color: #4b5563; line-height: 1.6; margin-top: 20px;">
                    Please do not hesitate to contact us should you have any questions.<br/>
                    Best regards,
                </p>
                
                <div style="margin-top: 20px;">
                    <p style="margin: 0; color: #1a4d2e; font-weight: 600;">The Halal Foods Team</p>
                    <p style="margin: 5px 0 0 0; color: #6b7280; font-size: 14px;">Procurement Department</p>
                </div>
            </div>
        </div>
    `;

    const bodyText = `
DEMANDE DE DEVIS / REQUEST FOR QUOTATION

Bonjour / Dear ${vendor.vendorName},

Numéro de demande / RFQ Number: ${rfqData.rfqNumber}
Date limite / Due Date: ${new Date(rfqData.quotationDueDate).toLocaleDateString('fr-FR')}
Livraison / Delivery: ${new Date(rfqData.deliveryBy).toLocaleDateString('fr-FR')}

Veuillez consulter le document PDF ci-joint pour les détails complets de notre demande de devis.
Please refer to the attached PDF document for complete details of our quotation request.

${rfqData.customMessage ? `\n${rfqData.customMessage}\n` : ''}

Cordialement / Best regards,
L'équipe Halal Foods / The Halal Foods Team
Service Achats / Procurement Department

---
HALAL FOODS - Qualité de Confiance depuis des Générations
Trusted Quality Since Generations

Contact: contact@halalfoods.fr | +33 1 XX XX XX XX
Paris, France | www.halalfoods.fr
    `;

    return {
        subject,
        bodyHtml: enhanceEmailHTML(bodyHtml, rfqData),
        bodyText
    };
}

/**
 * Extract structured RFQ data from natural language input
 * @param {string} userInput - Natural language description of what they need
 * @returns {Object} Structured RFQ data
 */
async function parseNaturalLanguageRFQ(userInput) {
    const systemPrompt = `You are an expert procurement assistant for Halal Foods, a food wholesaler in Paris, France.

Your job is to extract structured RFQ (Request for Quotation) information from natural language descriptions.

Extract the following information:
1. Product items with specifications
2. Quantities and units
3. Any quality requirements (halal, organic, grade, etc.)
4. Delivery preferences
5. Any special requirements

Return ONLY valid JSON in this exact format:
{
  "items": [
    {
      "productName": "string",
      "specifications": "string",
      "quantity": number,
      "unit": "kg|cartons|packs|pieces",
      "searchKeywords": ["keyword1", "keyword2"]
    }
  ],
  "deliveryPreferences": {
    "urgency": "urgent|normal|flexible",
    "preferredDeliveryDate": "ISO date string or null"
  },
  "specialRequirements": {
    "certifications": ["halal", "organic", etc.],
    "packaging": "string or null",
    "other": "string or null"
  },
  "estimatedBudget": "string or null"
}

If information is not provided, use null or empty array. Be intelligent about inferring units and quantities.`;

    const userPrompt = `Parse this RFQ request:

"${userInput}"

Return structured JSON only.`;

    try {
        const completion = await openai.chat.completions.create({
            model: config.openai.model || 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: systemPrompt,
                },
                {
                    role: 'user',
                    content: userPrompt,
                },
            ],
            temperature: 0.3,
            max_tokens: 2000,
            response_format: { type: "json_object" }, // Forces JSON response
        });

        const responseText = completion.choices[0].message.content;

        // Parse JSON response
        const parsedData = JSON.parse(responseText.trim());

        return {
            success: true,
            data: parsedData,
            rawResponse: responseText,
        };
    } catch (error) {
        console.error('Error parsing natural language RFQ:', error);
        throw new Error(`Failed to parse RFQ: ${error.message}`);
    }
}

/**
 * Generate search keywords for historical data analysis
 * @param {string} productDescription - Product description
 * @returns {Array<string>} Search keywords
 */
async function generateSearchKeywords(productDescription) {
    const prompt = `Given this product description: "${productDescription}"

Generate 5-7 search keywords/phrases that would help find this product in a purchase history database.
Include variations, common misspellings, and related terms.

Return as JSON object with a "keywords" array: {"keywords": ["keyword1", "keyword2", ...]}`;

    try {
        const completion = await openai.chat.completions.create({
            model: config.openai.model || 'gpt-4o',
            messages: [
                {
                    role: 'user',
                    content: prompt,
                },
            ],
            temperature: 0.5,
            max_tokens: 500,
            response_format: { type: "json_object" },
        });

        const responseText = completion.choices[0].message.content;
        const parsed = JSON.parse(responseText);

        return parsed.keywords || [productDescription];
    } catch (error) {
        console.error('Error generating keywords:', error);
        return [productDescription];
    }
}

async function analyzeVendorRecommendations(vendors, rfqContext) {
    // ADD THIS CHECK
    if (!vendors || vendors.length === 0) {
        return {
            topRecommendations: [],
            priceInsights: 'No historical vendor data available',
            riskFactors: 'No vendors found in purchase history',
            suggestedVendorCount: 0,
            suggestedVendorCodes: [],
        };
    }

    const prompt = `You are analyzing vendor recommendations for an RFQ.

RFQ Context:
${JSON.stringify(rfqContext, null, 2)}

Vendors (sorted by score):
${JSON.stringify(vendors.slice(0, 10), null, 2)}

IMPORTANT: Only recommend vendors from the list provided above. Do NOT suggest fictional vendors.
Use the exact vendorCode and vendorName from the data provided.

Provide a brief analysis:
1. Top 3 recommended vendors from the list above and why
2. Price range insights based on actual historical data
3. Any risk factors (e.g., haven't purchased recently)
4. Suggested number of vendors to contact (3-7 vendors)

Return as JSON:
{
  "topRecommendations": [
    {
      "vendorCode": "string (from provided list)",
      "vendorName": "string (from provided list)",
      "reason": "string"
    }
  ],
  "priceInsights": "string",
  "riskFactors": "string",
  "suggestedVendorCount": number,
  "suggestedVendorCodes": ["code1", "code2", ...]
}`;

    try {
        const completion = await openai.chat.completions.create({
            model: config.openai.model || 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: 'You are a procurement expert analyzing vendor data and providing recommendations.',
                },
                {
                    role: 'user',
                    content: prompt,
                },
            ],
            temperature: 0.3,
            max_tokens: 1500,
            response_format: { type: "json_object" },
        });

        const responseText = completion.choices[0].message.content;
        return JSON.parse(responseText);
    } catch (error) {
        console.error('Error analyzing vendors:', error);
        return null;
    }
}

/**
 * Generate personalized RFQ email content
 * @param {Object} rfqData - RFQ details
 * @param {Object} vendor - Vendor details
 * @returns {Object} Email subject and body
 */
async function generateRFQEmail(rfqData, vendor, language = 'both') {
    const relationshipContext = vendor.totalPurchases
        ? `Nous avons travaillé ensemble ${vendor.totalPurchases} fois par le passé. / We have worked together ${vendor.totalPurchases} times in the past.`
        : 'Nous souhaitons établir une nouvelle relation commerciale. / We wish to establish a new business relationship.';

    const prompt = `Generate a professional bilingual RFQ email (French and English) for Halal Foods, a premium food wholesaler in Paris.

Vendor Name: ${vendor.vendorName}
Relationship: ${relationshipContext}

RFQ Details:
- RFQ Number: ${rfqData.rfqNumber}
- Items: ${rfqData.items.length} products
- Quotation Due: ${new Date(rfqData.quotationDueDate).toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' })}
- Delivery By: ${new Date(rfqData.deliveryBy).toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' })}

${rfqData.customMessage ? `Additional Message: ${rfqData.customMessage}` : ''}

Create an email that:
1. Is professional and warm
2. Contains BOTH French and English versions (French first, English below with separator)
3. Highlights the attached RFQ PDF document
4. Emphasizes quality, trust, and long-term partnership
5. Has clear call-to-action with deadline
6. Features an impressive, professional footer with:
   - Company motto/values
   - Contact information
   - Social proof (600+ products, 100+ suppliers)
   - Professional certifications/standards

Return as JSON:
{
  "subject": "Demande de devis / Request for Quotation - RFQ ${rfqData.rfqNumber}",
  "bodyHtml": "string (HTML formatted with modern design)",
  "bodyText": "string (plain text version)"
}`;

    try {
        const completion = await openai.chat.completions.create({
            model: config.openai.model || 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: `You are a professional business email writer specializing in procurement communications. 
                    Create bilingual (French/English) emails that are formal yet warm, emphasizing quality, trust, and partnership.
                    The emails should reflect a premium, professional brand image.`,
                },
                {
                    role: 'user',
                    content: prompt,
                },
            ],
            temperature: 0.7,
            max_tokens: 3000,
            response_format: { type: "json_object" },
        });

        const responseText = completion.choices[0].message.content;
        const parsedResponse = JSON.parse(responseText);

        // Enhance the HTML with professional footer
        parsedResponse.bodyHtml = enhanceEmailHTML(parsedResponse.bodyHtml, rfqData);

        return parsedResponse;
    } catch (error) {
        console.error('Error generating email:', error);
        // Fallback to professional template
        return generateFallbackEmail(rfqData, vendor);
    }
}

/**
 * Enhanced function: Extract items from natural language with function calling
 * Uses OpenAI's function calling for more reliable structured output
 */
async function parseNaturalLanguageRFQWithFunctions(userInput) {
    const functions = [
        {
            name: 'create_rfq',
            description: 'Create a structured RFQ from natural language input',
            parameters: {
                type: 'object',
                properties: {
                    items: {
                        type: 'array',
                        description: 'List of items requested',
                        items: {
                            type: 'object',
                            properties: {
                                productName: {
                                    type: 'string',
                                    description: 'Name of the product',
                                },
                                specifications: {
                                    type: 'string',
                                    description: 'Product specifications or certifications',
                                },
                                quantity: {
                                    type: 'number',
                                    description: 'Quantity needed',
                                },
                                unit: {
                                    type: 'string',
                                    enum: ['kg', 'cartons', 'packs', 'pieces', 'liters', 'boxes', 'pallets'],
                                    description: 'Unit of measurement',
                                },
                                searchKeywords: {
                                    type: 'array',
                                    items: { type: 'string' },
                                    description: 'Keywords to search for this product in database',
                                },
                            },
                            required: ['productName', 'quantity', 'unit'],
                        },
                    },
                    deliveryPreferences: {
                        type: 'object',
                        properties: {
                            urgency: {
                                type: 'string',
                                enum: ['urgent', 'normal', 'flexible'],
                                description: 'Urgency of delivery',
                            },
                            preferredDeliveryDate: {
                                type: 'string',
                                description: 'Preferred delivery date in ISO format',
                            },
                        },
                    },
                    specialRequirements: {
                        type: 'object',
                        properties: {
                            certifications: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Required certifications (halal, organic, etc.)',
                            },
                            packaging: {
                                type: 'string',
                                description: 'Special packaging requirements',
                            },
                            other: {
                                type: 'string',
                                description: 'Other special requirements',
                            },
                        },
                    },
                    estimatedBudget: {
                        type: 'string',
                        description: 'Estimated budget if mentioned',
                    },
                },
                required: ['items'],
            },
        },
    ];

    try {
        const completion = await openai.chat.completions.create({
            model: config.openai.model || 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: 'You are an expert procurement assistant for Halal Foods. Extract structured RFQ information from natural language.',
                },
                {
                    role: 'user',
                    content: `Parse this RFQ request: "${userInput}"`,
                },
            ],
            functions: functions,
            function_call: { name: 'create_rfq' },
            temperature: 0.3,
        });

        const functionCall = completion.choices[0].message.function_call;

        if (functionCall && functionCall.name === 'create_rfq') {
            const parsedData = JSON.parse(functionCall.arguments);

            return {
                success: true,
                data: parsedData,
                rawResponse: functionCall.arguments,
            };
        }

        throw new Error('No function call returned');
    } catch (error) {
        console.error('Error parsing with functions:', error);
        // Fallback to regular parsing
        return parseNaturalLanguageRFQ(userInput);
    }
}

/**
 * NEW: Parse vendor information from email using AI
 */
async function parseVendorInfoFromEmail(emailData) {
    try {
        const prompt = `
Extract vendor information from this email communication:

Subject: ${emailData.subject}
Content: ${emailData.text}
Attachments Text: ${emailData.attachments?.join('\n\n')}
Email Type: ${emailData.emailType}

Extract and return JSON with:
{
    "companyName": "company name if mentioned",
    "productCategories": ["array", "of", "products", "mentioned"],
    "certifications": ["halal", "organic", etc if mentioned],
    "phone": "phone number if found",
    "address": "address if found",
    "pricesMentioned": [{"product": "name", "price": number, "unit": "kg"}]
}

Focus on extracting actual structured data. Return only the JSON.
`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                {
                    role: 'system',
                    content: 'You are a data extraction specialist. Extract structured vendor information from emails. Return only valid JSON.',
                },
                {
                    role: 'user',
                    content: prompt,
                },
            ],
            temperature: 0.3,
        });

        const content = response.choices[0].message.content.trim();
        const jsonMatch = content.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }

        return {};
    } catch (error) {
        console.error('Error parsing vendor info from email:', error);
        return {};
    }
};

/**
 * NEW: Parse RFQ response with AI (handles multi-level replies and PDFs)
 */
async function parseRFQResponseWithAI(data) {
    try {
        const prompt = `
Analyze this RFQ response for RFQ Number: ${data.rfqNumber}

Vendor: ${data.vendorName} (${data.vendorEmail})
Date: ${data.date}
Subject: ${data.emailSubject}

Email Content:
${data.emailBody}

${data.pdfContent ? `PDF Attachment Content:\n${data.pdfContent}` : ''}

Extract and return JSON:
{
    "isValidResponse": true/false,
    "responseType": "quotation" or "decline" or "question",
    "quotedItems": [
        {
            "productName": "name",
            "quantity": number,
            "unit": "kg/cartons/etc",
            "unitPrice": number,
            "totalPrice": number,
            "currency": "EUR/USD/etc"
        }
    ],
    "totalQuotedAmount": number,
    "deliveryTimeInDays": number,
    "deliveryDate": "YYYY-MM-DD or null",
    "paymentTerms": "terms mentioned",
    "minimumOrder": "if mentioned",
    "notes": "any special conditions or notes",
    "certifications": ["any certifications mentioned"],
    "contactPerson": "name if mentioned",
    "contactPhone": "phone if mentioned"
}

Return only valid JSON.
`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4',
            messages: [
                {
                    role: 'system',
                    content: 'You are an RFQ response analyzer. Parse vendor quotations from emails and PDFs. Extract all pricing and delivery information. Return only valid JSON.',
                },
                {
                    role: 'user',
                    content: prompt,
                },
            ],
            temperature: 0.2,
        });

        const content = response.choices[0].message.content.trim();
        const jsonMatch = content.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }

        return { isValidResponse: false };
    } catch (error) {
        console.error('Error parsing RFQ response with AI:', error);
        return { isValidResponse: false, error: error.message };
    }
};

/**
 * Parse quotation data from email text using AI
 */
async function parseQuotationFromText(emailText, rfqItems) {
    const prompt = `
You are a quotation parser. Extract structured quotation data from the vendor's email response.

RFQ Items Requested:
${rfqItems.map((item, i) => `${i + 1}. ${item.productName} - ${item.quantity} ${item.unit}`).join('\n')}

Vendor Email Response:
${emailText}

Extract the following information in JSON format:
{
    "quotedItems": [
        {
            "productName": "string",
            "quantity": number,
            "unit": "string",
            "unitPrice": number,
            "totalPrice": number,
            "currency": "string (EUR, USD, etc)"
        }
    ],
    "totalQuotedAmount": number,
    "currency": "string",
    "deliveryTimeInDays": number,
    "deliveryDate": "YYYY-MM-DD or null",
    "paymentTerms": "string",
    "validityPeriod": "string",
    "additionalNotes": "string",
    "isValidQuotation": boolean (true if they provided prices)
}

If prices are not mentioned, set isValidQuotation to false.
Return ONLY the JSON object, no other text.
    `;

    try {
        const response = await callClaudeAPI(prompt);
        const jsonMatch = response.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
        }

        return {
            quotedItems: [],
            totalQuotedAmount: 0,
            isValidQuotation: false,
            additionalNotes: 'Could not parse quotation data',
        };
    } catch (error) {
        console.error('❌ Error parsing quotation:', error);
        return {
            quotedItems: [],
            totalQuotedAmount: 0,
            isValidQuotation: false,
            additionalNotes: 'Error parsing quotation',
        };
    }
}

module.exports = {
    parseNaturalLanguageRFQ,
    parseNaturalLanguageRFQWithFunctions,
    generateSearchKeywords,
    analyzeVendorRecommendations,
    generateRFQEmail,
    parseVendorInfoFromEmail,
    parseRFQResponseWithAI,
    parseQuotationFromText,
};