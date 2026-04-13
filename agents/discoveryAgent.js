// agents/discoveryAgent.js
const { BaseAgent } = require('./baseAgent');
const Vendor = require('../models/Vendor');
const PDA_Supplier = require('../models/PDA_Supplier');

class DiscoveryAgent extends BaseAgent {
    constructor() {
        super('Discovery');
    }

    /**
     * Discover contact details for a vendor using OpenAI
     * Uses GPT's training knowledge to find likely contact info.
     * For live web search, integrate a search API (Google/Bing) in the future.
     * @param {Object} params
     * @param {string} params.vendorName - Company name
     * @param {string} params.vendorCode - CardCode or PDA _id
     * @param {string} params.country - Country hint
     * @param {string} params.productCategory - Product category hint
     * @returns {Object} { email, phone, website, source }
     */
    async discoverContact({ vendorName, vendorCode, country, productCategory }) {
        this.log(`Discovering contact for: ${vendorName} (${vendorCode})`);
        this.addToActionLog('discovery_started', { vendorName, vendorCode, country });

        try {
            const systemPrompt = `You are a B2B contact researcher for Halal Foods, a food procurement company.

Your task is to find the best business contact (email and phone) for a food supplier/vendor company.

RULES:
1. Use your knowledge of the company to find their official contact details
2. Prefer direct sales or export department contacts over generic info@ emails
3. Reject noreply@, no-reply@, support@, webmaster@ addresses
4. Validate that the email domain matches the company name or website
5. If you find multiple contacts, pick the most relevant for B2B procurement
6. Phone numbers should include country code
7. If you are not confident about exact contact details, say so honestly

Return ONLY valid JSON:
{
  "email": "found email or null",
  "phone": "found phone or null",
  "website": "company website or null",
  "contactPerson": "name if found or null",
  "confidence": "high|medium|low",
  "source": "description of how you know this information",
  "reasoning": "why you chose this contact"
}`;

            const userMessage = `Find the business/procurement contact details for this company:

Company Name: ${vendorName}
Country: ${country || 'Unknown'}
Product Category: ${productCategory || 'Food products'}

Search for this company and provide the best email and phone for B2B procurement communication.
If you don't know the exact details, provide your best guess with low confidence, or null if you have no information at all.`;

            const response = await this.callLLM(systemPrompt, userMessage);
            const text = this.extractText(response);
            const result = this.extractJSON(text);

            if (!result) {
                this.log('Could not extract contact info from AI response');
                this.addToActionLog('discovery_failed', {
                    vendorName,
                    reason: 'No structured result from AI',
                });
                return { email: null, phone: null, website: null, found: false };
            }

            // Validate email
            if (result.email) {
                const isValid = this._validateEmail(result.email);
                if (!isValid) {
                    this.log(`Rejected invalid email: ${result.email}`);
                    result.email = null;
                }
            }

            // Only save high/medium confidence results
            if ((result.email || result.phone) && result.confidence !== 'low') {
                await this._saveContactToDb(vendorCode, result);
            }

            this.addToActionLog('discovery_completed', {
                vendorName,
                vendorCode,
                email: result.email,
                phone: result.phone,
                confidence: result.confidence,
            });

            this.log(`Discovery result for ${vendorName}: email=${result.email}, phone=${result.phone}, confidence=${result.confidence}`);

            return {
                email: result.email,
                phone: result.phone,
                website: result.website,
                contactPerson: result.contactPerson,
                confidence: result.confidence,
                source: result.source,
                found: !!(result.email || result.phone),
            };
        } catch (error) {
            this.logError(`Discovery failed for ${vendorName}:`, error);
            this.addToActionLog('discovery_error', {
                vendorName,
                vendorCode,
                error: error.message,
            });
            return { email: null, phone: null, website: null, found: false, error: error.message };
        }
    }

    /**
     * Validate email address
     */
    _validateEmail(email) {
        if (!email) return false;

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) return false;

        // Reject generic/useless emails
        const rejectedPrefixes = [
            'noreply', 'no-reply', 'donotreply', 'do-not-reply',
            'webmaster', 'postmaster', 'mailer-daemon',
        ];

        const localPart = email.split('@')[0].toLowerCase();
        return !rejectedPrefixes.some(prefix => localPart === prefix);
    }

    /**
     * Save discovered contact info to the database
     */
    async _saveContactToDb(vendorCode, contactInfo) {
        try {
            // Check if it's a PDA supplier (ObjectId format)
            const isPDA = /^[0-9a-fA-F]{24}$/.test(vendorCode);

            if (isPDA) {
                const updates = {};
                if (contactInfo.email) updates.email = contactInfo.email;
                if (contactInfo.phone) updates['contactInfo.phone'] = contactInfo.phone;
                if (contactInfo.website) updates['contactInfo.website'] = contactInfo.website;

                await PDA_Supplier.findByIdAndUpdate(vendorCode, { $set: updates });
                this.log(`Updated PDA supplier ${vendorCode} with discovered contact`);
            } else {
                const updates = {};
                if (contactInfo.email) updates.email = contactInfo.email;
                if (contactInfo.phone) updates.phone = contactInfo.phone;
                if (contactInfo.contactPerson) {
                    updates['contactPerson.name'] = contactInfo.contactPerson;
                }

                await Vendor.findOneAndUpdate(
                    { CardCode: vendorCode },
                    { $set: updates }
                );
                this.log(`Updated vendor ${vendorCode} with discovered contact`);
            }
        } catch (err) {
            this.logError(`Failed to save contact to DB for ${vendorCode}:`, err);
        }
    }

    /**
     * Batch discover contacts for multiple vendors
     */
    async discoverMultiple(vendors) {
        this.log(`Batch discovering contacts for ${vendors.length} vendors`);
        const results = [];

        for (const vendor of vendors) {
            const result = await this.discoverContact(vendor);
            results.push({ ...vendor, ...result });

            // Rate limit: wait 1 second between calls
            if (vendors.indexOf(vendor) < vendors.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        return results;
    }
}

module.exports = new DiscoveryAgent();
