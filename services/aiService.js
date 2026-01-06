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
<body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #ffffff;">
    <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
            <td align="center" style="padding: 20px;">
                <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff;">
                    
                    <!-- Header -->
                    <tr>
                        <td style="padding: 20px 0; border-bottom: 1px solid #cccccc;">
                            <table width="100%" cellpadding="0" cellspacing="0">
                                <tr>
                                    <td>
                                        <img src="https://imageshfs.s3.ap-southeast-2.amazonaws.com/image-removebg-preview+(1).png" alt="Halal Foods" style="height: 40px; display: block;" />
                                    </td>
                                    <td align="right">
                                        <p style="margin: 0; font-size: 14px; color: #000000;">HALAL FOODS</p>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>

                    <!-- Body Content -->
                    <tr>
                        <td style="padding: 20px 0;">
                            ${bodyHtml}
                        </td>
                    </tr>

                    <!-- Footer -->
                    <tr>
                        <td style="padding: 20px 0; border-top: 1px solid #cccccc;">
                            <p style="margin: 0 0 10px 0; color: #000000; font-size: 12px;">
                                <strong>Halal Foods</strong><br/>
                                Email: contact@halalfoods.fr<br/>
                                Phone: +33 1 XX XX XX XX<br/>
                                Paris, France<br/>
                                www.halalfoods.fr
                            </p>
                            <p style="margin: 10px 0 0 0; color: #666666; font-size: 10px;">
                                This email and any attachments are confidential.<br/>
                                © ${new Date().getFullYear()} Halal Foods. All rights reserved.
                            </p>
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
 * @param {boolean} isExistingVendor - Whether this is an existing vendor or new supplier
 * @returns {Object} Email subject and body
 */
async function generateRFQEmail(rfqData, vendor, language = 'both', isExistingVendor = true) {
    // If existing vendor, send simple professional email
    if (isExistingVendor) {
        return generateSimpleRFQEmail(rfqData, vendor);
    }

    // For new suppliers, send detailed company introduction email
    return generateDetailedRFQEmail(rfqData, vendor);
}

/**
 * Simple email for existing vendors (no company intro)
 */
function generateSimpleRFQEmail(rfqData, vendor) {
    const subject = `RFQ ${rfqData.rfqNumber} - Request for Quotation`;

    const bodyHtml = `
        <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
            <h2 style="color: #1a4d2e; margin-bottom: 15px;">Dear ${vendor.vendorName},</h2>
            
            <p style="color: #4b5563; line-height: 1.6; margin-bottom: 15px;">
                Please find attached our Request for Quotation for the products we discussed.
            </p>
            
            <div style="background-color: #f0f9ff; border-left: 4px solid #3b82f6; padding: 15px; margin: 20px 0; border-radius: 4px;">
                <p style="margin: 0; color: #1e40af; font-weight: 600;">
                    📋 RFQ Number: ${rfqData.rfqNumber}<br/>
                    📅 Quotation Due: ${new Date(rfqData.quotationDueDate).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })}<br/>
                    🚚 Delivery By: ${new Date(rfqData.deliveryBy).toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })}
                </p>
            </div>
            
            ${rfqData.customMessage ? `<p style="color: #4b5563; line-height: 1.6; margin-bottom: 15px; font-style: italic;">${rfqData.customMessage}</p>` : ''}
            
            <p style="color: #4b5563; line-height: 1.6; margin-bottom: 15px;">
                Please include:
            </p>
            <ul style="color: #4b5563; line-height: 1.8;">
                <li>Unit and total prices</li>
                <li>Delivery terms</li>
                <li>Payment terms</li>
                <li>Product availability</li>
            </ul>
            
            <p style="color: #4b5563; line-height: 1.6; margin-top: 20px;">
                Best regards,<br/>
                <strong>Halal Foods - Procurement Team</strong>
            </p>
        </div>
    `;

    const bodyText = `
Dear ${vendor.vendorName},

Please find attached our Request for Quotation.

RFQ Number: ${rfqData.rfqNumber}
Quotation Due: ${new Date(rfqData.quotationDueDate).toLocaleDateString('en-GB')}
Delivery By: ${new Date(rfqData.deliveryBy).toLocaleDateString('en-GB')}

${rfqData.customMessage ? `\n${rfqData.customMessage}\n` : ''}

Please include unit prices, delivery terms, payment terms, and product availability.

Best regards,
Halal Foods - Procurement Team

---
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
 * Detailed email for new suppliers (with company introduction)
 */
async function generateDetailedRFQEmail(rfqData, vendor) {
    const relationshipContext = `We are reaching out to establish a new business relationship.`;

    const prompt = `Generate a professional bilingual RFQ email (French and English) for Halal Foods, a premium food wholesaler in Paris.

This is for a NEW SUPPLIER we haven't worked with before.

Vendor Name: ${vendor.vendorName}
Context: First-time contact - introduce Halal Foods company

RFQ Details:
- RFQ Number: ${rfqData.rfqNumber}
- Items: ${rfqData.items.length} products
- Quotation Due: ${new Date(rfqData.quotationDueDate).toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' })}
- Delivery By: ${new Date(rfqData.deliveryBy).toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' })}

${rfqData.customMessage ? `Additional Message: ${rfqData.customMessage}` : ''}

Create an email that:
1. INTRODUCES Halal Foods (premium wholesaler, 600+ products, 100+ suppliers, established brand)
2. Is professional and warm for a first contact
3. Contains BOTH French and English versions (French first, then separator, then English)
4. Highlights the attached RFQ PDF document
5. Emphasizes quality, trust, and potential long-term partnership
6. Has clear call-to-action with deadline
7. Features an impressive, professional footer with:
   - Company motto/values
   - Contact information
   - Social proof (600+ products, 100+ suppliers)
   - Professional certifications/standards

Return as JSON:
{
  "subject": "New Partnership Opportunity - RFQ ${rfqData.rfqNumber} | Halal Foods",
  "bodyHtml": "string (HTML formatted with modern design)",
  "bodyText": "string (plain text version)"
}`;

    try {
        const completion = await openai.chat.completions.create({
            model: config.openai.model || 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: `You are a professional business email writer specializing in procurement communications for NEW supplier outreach. 
                    Create bilingual (French/English) emails that introduce the company professionally while being warm and inviting.
                    The emails should reflect a premium brand looking to establish new partnerships.`,
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
        console.error('Error generating detailed email:', error);
        // Fallback to professional template
        return generateFallbackDetailedEmail(rfqData, vendor);
    }
}

/**
 * Fallback detailed email for new suppliers
 */
function generateFallbackDetailedEmail(rfqData, vendor) {
    const subject = `New Partnership Opportunity - RFQ ${rfqData.rfqNumber} | Halal Foods`;

    const bodyHtml = `
        <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
            <!-- French Version -->
            <div style="margin-bottom: 30px;">
                <h2 style="color: #1a4d2e; margin-bottom: 15px;">Bonjour ${vendor.vendorName},</h2>
                
                <p style="color: #4b5563; line-height: 1.6; margin-bottom: 15px;">
                    Nous sommes <strong>Halal Foods</strong>, un grossiste alimentaire premium basé à Paris, spécialisé dans les produits halal de haute qualité.
                    Avec plus de <strong>600 références produits</strong> et <strong>100+ fournisseurs de confiance</strong>, nous desservons des centaines de clients à travers la France.
                </p>
                
                <p style="color: #4b5563; line-height: 1.6; margin-bottom: 15px;">
                    Nous souhaitons explorer une collaboration avec votre entreprise et vous prions de bien vouloir nous faire parvenir votre meilleure offre pour les produits détaillés ci-joint.
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
                    <li>Certifications (halal, bio, etc.)</li>
                </ul>
                
                <p style="color: #4b5563; line-height: 1.6; margin-top: 20px;">
                    Nous recherchons des partenaires fiables pour une collaboration à long terme et serions ravis d'établir une relation commerciale mutuellement bénéfique.<br/>
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
                    We are <strong>Halal Foods</strong>, a premium food wholesaler based in Paris, specializing in high-quality halal products.
                    With over <strong>600 product references</strong> and <strong>100+ trusted suppliers</strong>, we serve hundreds of clients across France.
                </p>
                
                <p style="color: #4b5563; line-height: 1.6; margin-bottom: 15px;">
                    We are interested in exploring a partnership with your company and kindly request your best quotation for the products detailed in the attached document.
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
                    <li>Certifications (halal, organic, etc.)</li>
                </ul>
                
                <p style="color: #4b5563; line-height: 1.6; margin-top: 20px;">
                    We are looking for reliable partners for long-term collaboration and would be delighted to establish a mutually beneficial business relationship.<br/>
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
NEW PARTNERSHIP OPPORTUNITY
OPPORTUNITÉ DE PARTENARIAT

Dear / Bonjour ${vendor.vendorName},

We are Halal Foods, a premium food wholesaler based in Paris, specializing in high-quality halal products.
Nous sommes Halal Foods, un grossiste alimentaire premium basé à Paris, spécialisé dans les produits halal de haute qualité.

With 600+ product references and 100+ trusted suppliers.
Avec plus de 600 références produits et 100+ fournisseurs de confiance.

RFQ Number / Numéro: ${rfqData.rfqNumber}
Due Date / Date limite: ${new Date(rfqData.quotationDueDate).toLocaleDateString('en-GB')}
Delivery / Livraison: ${new Date(rfqData.deliveryBy).toLocaleDateString('en-GB')}

Please refer to the attached PDF for complete details.
Veuillez consulter le PDF ci-joint pour les détails complets.

${rfqData.customMessage ? `\n${rfqData.customMessage}\n` : ''}

We look forward to establishing a mutually beneficial partnership.
Nous sommes impatients d'établir un partenariat mutuellement bénéfique.

Best regards / Cordialement,
The Halal Foods Team / L'équipe Halal Foods
Procurement Department / Service Achats

---
HALAL FOODS - Trusted Quality Since Generations
600+ Products • 100+ Suppliers • Est. Since Generations

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
You are analyzing an RFQ response. Extract ALL pricing information, even from casual conversational text.

RFQ Number: ${data.rfqNumber}
Vendor: ${data.vendorName} (${data.vendorEmail})
Date: ${data.date}
Subject: ${data.emailSubject}

Email Content:
${data.emailBody}

${data.pdfContent ? `PDF Attachment Content:\n${data.pdfContent}` : ''}

CRITICAL INSTRUCTIONS FOR PRICE EXTRACTION:
1. Look for ANY mention of price, cost, or monetary value
2. Common formats to extract:
   - "The price is 9000 euros"
   - "9000 euros for the items"
   - "I can do it for €9,000"
   - "Total cost: 9000 EUR"
   - "900 Pounds"
   - "$500"
   - "Price: 9000"
3. Extract numbers followed by: euros, euro, EUR, €, pounds, GBP, £, dollars, USD, $
4. If you find ANY price mention, set isValidResponse to TRUE
5. Delivery dates can be informal: "26th December", "next week", "in 5 days"

Extract and return ONLY this JSON structure (no markdown, no extra text):
{
    "isValidResponse": true,
    "responseType": "quotation",
    "quotedItems": [
        {
            "productName": "Full Order",
            "quantity": null,
            "unit": "order",
            "unitPrice": null,
            "totalPrice": 9000,
            "currency": "EUR"
        }
    ],
    "totalQuotedAmount": 9000,
    "currency": "EUR",
    "deliveryTimeInDays": null,
    "deliveryDate": null,
    "paymentTerms": null,
    "validityPeriod": null,
    "additionalNotes": "any relevant notes from the message",
    "certifications": [],
    "contactPerson": null,
    "contactPhone": null
}

EXAMPLES OF WHAT TO EXTRACT:
Input: "The price for the quoted items is 9000 euros this is very good"
Output: {"isValidResponse": true, "totalQuotedAmount": 9000, "currency": "EUR", ...}

Input: "my price is 900 Pounds"
Output: {"isValidResponse": true, "totalQuotedAmount": 900, "currency": "GBP", ...}

Input: "I can supply for $1,200"
Output: {"isValidResponse": true, "totalQuotedAmount": 1200, "currency": "USD", ...}

Input: "Looking forward to your order!"
Output: {"isValidResponse": false, "responseType": "question", ...}

NOW EXTRACT FROM THE CONTENT ABOVE. Return ONLY valid JSON, no markdown, no code blocks.
`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: `You are an expert at extracting pricing information from vendor responses. 
You MUST find prices even in casual conversational text like "the price is 9000 euros".
Extract ANY mention of monetary amounts with their currency.
Return ONLY valid JSON with no markdown formatting.`
                },
                {
                    role: 'user',
                    content: prompt,
                },
            ],
            temperature: 0.1, // Very low for accurate extraction
            response_format: { type: "json_object" } // Force JSON response
        });

        const content = response.choices[0].message.content.trim();

        console.log('🤖 Raw AI Response:', content);

        // Parse the JSON response
        let parsed;
        try {
            // Remove any markdown code blocks if present
            const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
            parsed = JSON.parse(cleanContent);
        } catch (parseError) {
            console.error('❌ Failed to parse AI JSON response:', parseError);
            console.error('Raw content:', content);

            // Try to extract just the JSON object
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                parsed = JSON.parse(jsonMatch[0]);
            } else {
                throw new Error('Could not extract valid JSON from AI response');
            }
        }

        // Extra validation: if we found ANY price, mark as valid
        if (parsed.totalQuotedAmount && parsed.totalQuotedAmount > 0) {
            parsed.isValidResponse = true;
            parsed.responseType = 'quotation';

            // Ensure we have at least one quoted item
            if (!parsed.quotedItems || parsed.quotedItems.length === 0) {
                parsed.quotedItems = [{
                    productName: "Full Order",
                    quantity: null,
                    unit: "order",
                    unitPrice: null,
                    totalPrice: parsed.totalQuotedAmount,
                    currency: parsed.currency || 'EUR'
                }];
            }
        }

        console.log('✅ Parsed AI Response:', JSON.stringify(parsed, null, 2));

        return parsed;
    } catch (error) {
        console.error('❌ Error parsing RFQ response with AI:', error);
        console.error('Error stack:', error.stack);

        return {
            isValidResponse: false,
            responseType: 'error',
            error: error.message,
            additionalNotes: 'AI parsing failed - please review the raw email content'
        };
    }
}

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