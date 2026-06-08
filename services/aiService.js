// services/aiService.js
const OpenAI = require('openai');
const config = require('../config/config')

const openai = new OpenAI({
    apiKey: process.env.NEW_OPENAI_API_KEY,
});
/**
 * Generate AI response to vendor question
 */
async function generateQuestionResponse(question, rfqContext) {
    const prompt = `You are a professional customer service representative for Halal Foods, a premium food wholesaler.

RFQ Context:
- RFQ Number: ${rfqContext.rfqNumber}
- Items: ${rfqContext.items.map(i => `${i.productName} (${i.quantity} ${i.unit})`).join(', ')}
- Quotation Due: ${new Date(rfqContext.quotationDueDate).toLocaleDateString()}
- Delivery By: ${new Date(rfqContext.deliveryBy).toLocaleDateString()}
- Payment Terms: ${rfqContext.paymentTerms}

Vendor Name: ${rfqContext.vendorName}
Vendor Question: "${question}"

Generate a helpful, professional WhatsApp response (max 300 characters) that:
1. Addresses their specific question
2. Provides relevant RFQ information
3. Is warm and professional
4. Ends with "Best regards, Halal Foods Team"

Return only the message text, no JSON.`;

    try {
        const completion = await openai.chat.completions.create({
            model: config.openai.model || 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: 'You are a professional customer service representative. Keep responses concise and helpful.'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ],
            temperature: 0.7,
            max_tokens: 200
        });

        return completion.choices[0].message.content.trim();
    } catch (error) {
        console.error('Error generating question response:', error);
        return `Thank you for your question about RFQ ${rfqContext.rfqNumber}. Our team will review it and respond shortly.\n\nBest regards,\nHalal Foods Team`;
    }
}

/**
 * Company details — single source of truth (from config/.env).
 * Any field left empty in .env is OMITTED rather than printed as a placeholder.
 */
function getCompany() {
    return (config && config.company) || {};
}

/** HTML footer contact block — only renders lines that have a real value. */
function buildFooterHtml() {
    const c = getCompany();
    const line = (label, val) => (val ? `${label}${val}<br/>` : '');
    return [
        `<strong>${c.name || 'Halal Foods'}</strong><br/>`,
        line('Email : ', c.email),
        line('Tél / Phone : ', c.phone),
        line('', c.address),
        line('', c.website),
        line('VAT / SIRET : ', c.vat),
    ].join('');
}

/** Plain-text contact lines — only the ones with real values. */
function buildContactLinesText() {
    const c = getCompany();
    const out = [];
    if (c.email) out.push(`Email : ${c.email}`);
    if (c.phone) out.push(`Tél / Phone : ${c.phone}`);
    if (c.address) out.push(c.address);
    if (c.website) out.push(c.website);
    if (c.vat) out.push(`VAT / SIRET : ${c.vat}`);
    return out;
}

/** A human signature: a real person's name + title where available, else the company team. */
function buildSignatureHtml() {
    const c = getCompany();
    const name = c.signerName
        ? `${c.signerName}${c.signerTitle ? ` <span style="color:#6b7280;">— ${c.signerTitle}</span>` : ''}`
        : `${c.name || 'Halal Foods'} — Service Achats / Procurement`;
    return `<p style="margin:0;color:#1a4d2e;font-weight:600;">${name}</p>
            <p style="margin:4px 0 0 0;color:#374151;">${c.name || 'Halal Foods'}</p>`;
}

function buildSignatureText() {
    const c = getCompany();
    const who = c.signerName
        ? `${c.signerName}${c.signerTitle ? ` — ${c.signerTitle}` : ''}`
        : `${c.name || 'Halal Foods'} — Service Achats / Procurement`;
    return `${who}\n${c.name || 'Halal Foods'}`;
}

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
                                ${buildFooterHtml()}
                            </p>
                            <p style="margin: 10px 0 0 0; color: #666666; font-size: 10px;">
                                This email and any attachments are confidential.<br/>
                                © ${new Date().getFullYear()} ${getCompany().name || 'Halal Foods'}. All rights reserved.
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
    // Ensure incoterm/destination are accessible on rfqData for templates
    if (rfqData.specialRequirements) {
        rfqData.specialRequirements.incoterm = rfqData.specialRequirements.incoterm || rfqData.incoterm;
        rfqData.specialRequirements.destination = rfqData.specialRequirements.destination || rfqData.destination;
    }

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
    const c = getCompany();
    const subject = `Demande de devis / Request for Quotation — RFQ ${rfqData.rfqNumber}`;

    const fmt = (d, loc) => new Date(d).toLocaleDateString(loc, { year: 'numeric', month: 'long', day: 'numeric' });
    const dueFr = fmt(rfqData.quotationDueDate, 'fr-FR');
    const dueEn = fmt(rfqData.quotationDueDate, 'en-GB');
    const delFr = fmt(rfqData.deliveryBy, 'fr-FR');
    const delEn = fmt(rfqData.deliveryBy, 'en-GB');
    const incoterm = rfqData.specialRequirements?.incoterm || rfqData.incoterm || 'EXW';
    const destination = rfqData.specialRequirements?.destination || rfqData.destination || c.address || '';

    // Bilingual items table (NO target prices — internal only)
    const itemsTableRows = (rfqData.items || []).map((item, i) => `
                    <tr>
                        <td style="padding:8px;border-bottom:1px solid #eee;">${i + 1}</td>
                        <td style="padding:8px;border-bottom:1px solid #eee;">${item.productName}</td>
                        <td style="padding:8px;border-bottom:1px solid #eee;">${item.quantity} ${item.unit}</td>
                        <td style="padding:8px;border-bottom:1px solid #eee;">${item.specifications || item.additionalInfo || '-'}</td>
                    </tr>`).join('');

    const itemsTable = (rfqData.items && rfqData.items.length > 0) ? `
            <table style="width:100%;border-collapse:collapse;margin:15px 0;font-size:14px;">
                <tr style="background:#f3f4f6;">
                    <th style="padding:8px;text-align:left;">#</th>
                    <th style="padding:8px;text-align:left;">Produit / Product</th>
                    <th style="padding:8px;text-align:left;">Qté / Qty</th>
                    <th style="padding:8px;text-align:left;">Spécifications / Specs</th>
                </tr>
                ${itemsTableRows}
            </table>` : '';

    const callPrompt = c.phone ? ` ou par téléphone au ${c.phone}` : '';
    const callPromptEn = c.phone ? ` or by phone at ${c.phone}` : '';
    const signature = buildSignatureHtml();

    const bodyHtml = `
        <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;color:#374151;line-height:1.6;font-size:15px;">
            <!-- ===== Français ===== -->
            <p style="margin:0 0 14px;">Bonjour,</p>
            <p style="margin:0 0 14px;">
                J'espère que vous allez bien. Nous préparons une commande et serions ravis de recevoir votre meilleure offre
                pour les produits repris ci-dessous. Le détail complet se trouve dans le document PDF joint.
            </p>

            <div style="background:#f0f9ff;border-left:4px solid #3b82f6;padding:14px 16px;margin:18px 0;border-radius:4px;">
                <p style="margin:0;color:#1e40af;font-weight:600;">
                    RFQ ${rfqData.rfqNumber}<br/>
                    Réponse souhaitée avant le : ${dueFr}<br/>
                    Livraison souhaitée : ${delFr}<br/>
                    Incoterm : ${incoterm}${destination ? `<br/>Destination : ${destination}` : ''}
                </p>
            </div>

            ${itemsTable}

            ${rfqData.customMessage ? `<p style="margin:14px 0;font-style:italic;">${rfqData.customMessage}</p>` : ''}

            <p style="margin:14px 0 6px;">Merci de bien vouloir préciser dans votre devis :</p>
            <ul style="margin:0 0 14px;line-height:1.8;">
                <li>Prix unitaires et total</li>
                <li>Délais et conditions de livraison</li>
                <li>Conditions de paiement</li>
                <li>Disponibilité des produits</li>
            </ul>

            <p style="margin:14px 0;">
                N'hésitez pas à me répondre directement${callPrompt} pour toute question — je reste à votre disposition.
            </p>
            <p style="margin:0 0 4px;">Bien cordialement,</p>
            ${signature}

            <div style="border-top:1px solid #e5e7eb;margin:28px 0;"></div>

            <!-- ===== English ===== -->
            <p style="margin:0 0 6px;color:#6b7280;font-size:13px;">— English version —</p>
            <p style="margin:0 0 14px;">Hello,</p>
            <p style="margin:0 0 14px;">
                I hope you're doing well. We're putting together an order and would love to receive your best offer
                for the products listed below. Full details are in the attached PDF.
            </p>

            <div style="background:#f0f9ff;border-left:4px solid #3b82f6;padding:14px 16px;margin:18px 0;border-radius:4px;">
                <p style="margin:0;color:#1e40af;font-weight:600;">
                    RFQ ${rfqData.rfqNumber}<br/>
                    Please reply by: ${dueEn}<br/>
                    Requested delivery: ${delEn}<br/>
                    Incoterm: ${incoterm}${destination ? `<br/>Destination: ${destination}` : ''}
                </p>
            </div>

            <p style="margin:14px 0 6px;">Please include in your quotation:</p>
            <ul style="margin:0 0 14px;line-height:1.8;">
                <li>Unit and total prices</li>
                <li>Delivery terms and timeline</li>
                <li>Payment terms</li>
                <li>Product availability</li>
            </ul>

            <p style="margin:14px 0;">
                Feel free to reply to me directly${callPromptEn} with any questions — happy to help.
            </p>
            <p style="margin:0 0 4px;">Best regards,</p>
            ${signature}
        </div>
    `;

    const contactLines = buildContactLinesText();
    const bodyText = `Bonjour,

J'espère que vous allez bien. Nous préparons une commande et serions ravis de recevoir votre meilleure offre pour les produits ci-dessous. Le détail complet se trouve dans le PDF joint.

RFQ ${rfqData.rfqNumber}
Réponse souhaitée avant le : ${dueFr}
Livraison souhaitée : ${delFr}
Incoterm : ${incoterm}${destination ? `\nDestination : ${destination}` : ''}
${rfqData.customMessage ? `\n${rfqData.customMessage}\n` : ''}
Merci d'indiquer vos prix unitaires, délais et conditions de livraison, conditions de paiement et la disponibilité des produits.

Bien cordialement,
${buildSignatureText()}

— English —

Hello,

I hope you're doing well. We're putting together an order and would love your best offer for the products below — full details are in the attached PDF.

RFQ ${rfqData.rfqNumber}
Please reply by: ${dueEn}
Requested delivery: ${delEn}
Incoterm: ${incoterm}${destination ? `\nDestination: ${destination}` : ''}

Please include unit and total prices, delivery terms, payment terms, and product availability.

Best regards,
${buildSignatureText()}
${contactLines.length ? `\n---\n${contactLines.join('\n')}` : ''}
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

    const incoterm = rfqData.specialRequirements?.incoterm || rfqData.incoterm || 'EXW';
    const destination = rfqData.specialRequirements?.destination || rfqData.destination || getCompany().address || '';

    // Product list (names + qty) so the email can reference actual products, not "[Product Name]"
    const productList = (rfqData.items || [])
        .slice(0, 10)
        .map(it => `- ${it.productName} (${it.quantity} ${it.unit || 'units'})`)
        .join('\n');
    const moreProducts = (rfqData.items || []).length > 10 ? `\n- …and ${rfqData.items.length - 10} more (see attached PDF)` : '';

    // Real sender / company details from config (.env) — the LLM must use these verbatim.
    // Empty values are intentionally omitted (the prompt tells the model to skip blanks).
    const c = getCompany();
    const senderName = c.signerName || `${c.name || 'Halal Foods'} — Service Achats / Procurement`;
    const senderTitle = c.signerTitle || 'Procurement';
    const companyEmail = c.email || '';
    const companyPhone = c.phone || '';
    const companyWebsite = c.website || '';
    const companyAddress = c.address || '';

    const prompt = `Generate a professional bilingual RFQ email (French and English) for Halal Foods, a premium food wholesaler in Paris.

This is for a NEW SUPPLIER we haven't worked with before.

Vendor Name: ${vendor.vendorName}
Context: First-time contact - introduce Halal Foods company

RFQ Details:
- RFQ Number: ${rfqData.rfqNumber}
- Items: ${rfqData.items.length} products
- Quotation Due: ${new Date(rfqData.quotationDueDate).toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' })}
- Delivery By: ${new Date(rfqData.deliveryBy).toLocaleDateString('fr-FR', { year: 'numeric', month: 'long', day: 'numeric' })}
- Incoterm: ${incoterm}
- Destination: ${destination}

Products requested (use these actual names — never write "[Product Name]"):
${productList}${moreProducts}

${rfqData.customMessage ? `Additional Message: ${rfqData.customMessage}` : ''}

Sender / Company details (use these EXACT values — never write placeholders like "[Votre Nom]", "[Your Name]", "[Phone]"). Only the fields listed below are known; do NOT add any contact field that is not listed:
- Greeting to vendor: "Bonjour équipe ${vendor.vendorName}," (French) / "Hello ${vendor.vendorName} team," (English) — address the company, not an unknown individual contact
- Sender signature name: ${senderName}
- Sender title: ${senderTitle}
${[
        companyEmail ? `- Company email: ${companyEmail}` : '',
        companyPhone ? `- Company phone: ${companyPhone}` : '',
        companyWebsite ? `- Company website: ${companyWebsite}` : '',
        companyAddress ? `- Company address: ${companyAddress}` : '',
        c.vat ? `- VAT / SIRET: ${c.vat}` : '',
    ].filter(Boolean).join('\n')}

=== STRICT RULES ===
1. NEVER output placeholder brackets of any kind — no [Nom du contact], [Contact Name], [Votre Nom], [Your Name], [Product Name], [Nom du produit], [Phone], [Numéro de téléphone], [Adresse e-mail], [Normes et certifications], [Liens vers les réseaux sociaux], [XX], [TBD], [...], etc. If you don't have a real value for something, OMIT that line entirely.
2. Address the vendor by their COMPANY name (${vendor.vendorName}), not by an individual contact name. Use phrasing like "Bonjour équipe ${vendor.vendorName}," / "Hello ${vendor.vendorName} team,".
3. Sign the email with "${senderName}" — Procurement Team, Halal Foods. Do NOT invent or ask for a personal name.
4. In the footer / contact block, use only the real values above. Do not invent social media links or certification lists; omit them instead of using placeholders.
5. Refer to the actual products from the list above when mentioning "Product" — or write "the products listed in the attached PDF" if you'd otherwise need to name a single one.
6. Do NOT include any target prices or budget information. Only product names, quantities, and specifications.

Create an email that:
1. INTRODUCES Halal Foods (premium wholesaler, 600+ products, 100+ suppliers, established brand)
2. Is professional and warm for a first contact
3. Contains BOTH French and English versions (French first, then separator, then English)
4. Highlights the attached RFQ PDF document
5. Emphasizes quality, trust, and potential long-term partnership
6. Has a clear call-to-action with the quotation deadline
7. Ends with a clean signature block using the real contact details above (no placeholders).

Return as JSON:
{
  "subject": "New Partnership Opportunity - RFQ ${rfqData.rfqNumber} | Halal Foods",
  "bodyHtml": "string (HTML formatted with modern design, NO placeholder brackets)",
  "bodyText": "string (plain text version, NO placeholder brackets)"
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

        // Post-process: scrub any stray placeholder brackets the model left in.
        // Matches [Anything], [...], [Your Name], [Nom du contact], etc.
        parsedResponse.bodyHtml = scrubPlaceholders(parsedResponse.bodyHtml, vendor, rfqData);
        parsedResponse.bodyText = scrubPlaceholders(parsedResponse.bodyText, vendor, rfqData);
        parsedResponse.subject = scrubPlaceholders(parsedResponse.subject, vendor, rfqData);

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
 * Strip leftover LLM placeholders like [Contact Name], [Your Name], [Numéro de téléphone]
 * and replace them with real values or drop the line entirely. Keeps numeric refs like
 * "600+" and currency values intact — only bracketed placeholder text is removed.
 */
function scrubPlaceholders(text, vendor, rfqData) {
    if (!text || typeof text !== 'string') return text;

    const realValues = {
        // sender identity
        'votre nom': 'Procurement Team',
        'your name': 'Procurement Team',
        'nom de l\'expéditeur': 'Procurement Team',
        'sender name': 'Procurement Team',
        'agent name': 'Procurement Team',

        // vendor contact — address the company, no invented contact person
        'nom du contact': `équipe ${vendor.vendorName}`,
        'nom de contact': `équipe ${vendor.vendorName}`,
        'contact name': `${vendor.vendorName} team`,
        'recipient name': `${vendor.vendorName} team`,

        // phone/email/web
        'numéro de téléphone': '+33 1 XX XX XX XX',
        'phone number': '+33 1 XX XX XX XX',
        'phone': '+33 1 XX XX XX XX',
        'téléphone': '+33 1 XX XX XX XX',
        'adresse e-mail': 'contact@halalfoods.fr',
        'adresse email': 'contact@halalfoods.fr',
        'email': 'contact@halalfoods.fr',
        'e-mail': 'contact@halalfoods.fr',

        // product
        'nom du produit': 'see attached PDF',
        'product name': 'see attached PDF',
    };

    // Replace exact-match known placeholders first (e.g., "[Votre Nom]" → "Procurement Team")
    let cleaned = text.replace(/\[([^\[\]\n]{1,80})\]/g, (full, inner) => {
        const key = inner.trim().toLowerCase();
        if (realValues[key] !== undefined) return realValues[key];
        // Unknown placeholder — drop it. If the whole line becomes orphaned punctuation, a later sweep handles it.
        return '';
    });

    // Remove empty "label:" lines created by dropped placeholders (e.g., "Phone: " or "Product: ")
    cleaned = cleaned
        .split('\n')
        .filter(line => {
            const trimmed = line.trim();
            if (!trimmed) return true; // preserve blank lines for spacing
            // Drop lines that are just "Label:" (no value after the colon, ignoring HTML tags)
            const stripped = trimmed.replace(/<[^>]+>/g, '').trim();
            return !/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'’\s\-]*:\s*$/.test(stripped);
        })
        .join('\n');

    return cleaned;
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
    generateQuestionResponse
};