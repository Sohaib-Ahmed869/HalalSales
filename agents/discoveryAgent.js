// agents/discoveryAgent.js
const { BaseAgent } = require('./baseAgent');
const Vendor = require('../models/Vendor');
const PDA_Supplier = require('../models/PDA_Supplier');
const NewSupplier = require('../models/NewSupplier');
const webDiscovery = require('./webDiscovery');

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
     * @param {string} [params.supplierType] - 'new' | 'pda' | 'sap' — which collection vendorCode belongs to.
     *                                          When omitted, falls back to an ObjectId heuristic.
     * @param {boolean} [params.skipSave] - When true, do not persist the result (caller saves it).
     * @returns {Object} { email, phone, website, source }
     */
    async discoverContact({ vendorName, vendorCode, country, productCategory, supplierType, skipSave }) {
        this.log(`Discovering contact for: ${vendorName} (${vendorCode})`);
        this.addToActionLog('discovery_started', { vendorName, vendorCode, country });

        try {
            let result = null;
            let method = 'llm-memory';

            // 1. Grounded web discovery (Google search + crawl + verify) — preferred.
            if (webDiscovery.isConfigured()) {
                const web = await webDiscovery.discover({ vendorName, country, productCategory });
                if (web && web.found) {
                    result = web;
                    method = 'web';
                    this.log(`Web discovery found contact for ${vendorName}: email=${web.email}, phone=${web.phone}, confidence=${web.confidence}`);
                } else {
                    this.log(`Web discovery found nothing for ${vendorName}; falling back to LLM memory`);
                }
            }

            // 2. Fallback: GPT recall from training knowledge (clearly lower-trust).
            if (!result) {
                result = await this._discoverViaLLMMemory({ vendorName, country, productCategory });
            }

            if (!result) {
                this.addToActionLog('discovery_failed', { vendorName, reason: 'No result from any method' });
                return { email: null, phone: null, website: null, found: false };
            }

            // Validate email regardless of source
            if (result.email && !this._validateEmail(result.email)) {
                this.log(`Rejected invalid email: ${result.email}`);
                result.email = null;
            }

            // Only save high/medium confidence results (unless the caller persists itself)
            if (!skipSave && (result.email || result.phone) && result.confidence !== 'low') {
                await this._saveContactToDb(vendorCode, result, supplierType);
            }

            this.addToActionLog('discovery_completed', {
                vendorName,
                vendorCode,
                method,
                email: result.email,
                phone: result.phone,
                confidence: result.confidence,
            });

            this.log(`Discovery result for ${vendorName} [${method}]: email=${result.email}, phone=${result.phone}, confidence=${result.confidence}`);

            return {
                email: result.email || null,
                phone: result.phone || null,
                website: result.website || null,
                contactPerson: result.contactPerson || null,
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
     * Fallback discovery using the LLM's training knowledge (no live web data).
     * Lower trust than web discovery — used only when web discovery is unconfigured
     * or returns nothing.
     */
    async _discoverViaLLMMemory({ vendorName, country, productCategory }) {
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

Provide the best email and phone for B2B procurement communication.
If you don't know the exact details, provide your best guess with low confidence, or null if you have no information at all.`;

        const response = await this.callLLM(systemPrompt, userMessage);
        const result = this.extractJSON(this.extractText(response));
        if (!result) return null;

        // Cap LLM-memory confidence at "medium" — it is never verified against live data.
        let confidence = result.confidence === 'high' ? 'medium' : result.confidence;

        // Safety net: an LLM-recalled email whose domain has no mail server is almost
        // certainly hallucinated. Downgrade to "low" so it is not auto-saved.
        if (result.email && confidence !== 'low') {
            const verification = await webDiscovery._verify(result.email, null);
            if (!verification.mx) {
                this.log(`LLM-memory email ${result.email} has no MX record — downgrading to low confidence`);
                confidence = 'low';
            }
        }

        return {
            email: result.email || null,
            phone: result.phone || null,
            website: result.website || null,
            contactPerson: result.contactPerson || null,
            confidence,
            source: result.source ? `AI knowledge: ${result.source}` : 'AI knowledge (unverified)',
            found: !!(result.email || result.phone),
        };
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
     * Save discovered contact info to the database.
     * @param {string} vendorCode - CardCode (SAP) or ObjectId (PDA / NewSupplier)
     * @param {Object} contactInfo
     * @param {string} [supplierType] - 'new' | 'pda' | 'sap'. When omitted, an ObjectId
     *                                  is treated as PDA and anything else as a SAP vendor.
     */
    async _saveContactToDb(vendorCode, contactInfo, supplierType) {
        try {
            // Normalise vendorSource-style values (e.g. 'NEW_SUPPLIER') to a simple type
            const type = (supplierType || '').toLowerCase();

            // NewSupplier (Excel-uploaded) — its _id is also a 24-hex ObjectId, so it must
            // be resolved by explicit type, not the heuristic below.
            if (type === 'new' || type === 'new_supplier') {
                await this._saveToNewSupplier(vendorCode, contactInfo);
                return;
            }

            // Decide PDA vs SAP. Honour explicit type, else fall back to the ObjectId heuristic.
            const isPDA = type === 'pda' || type === 'pda_scraper'
                || (!type && /^[0-9a-fA-F]{24}$/.test(vendorCode));

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
     * Persist a discovered contact onto a NewSupplier document (Excel-uploaded suppliers).
     */
    async _saveToNewSupplier(supplierId, contactInfo) {
        const updates = {};
        if (contactInfo.email) updates.email = contactInfo.email;
        if (contactInfo.phone) updates.phone = contactInfo.phone;
        if (contactInfo.website) updates.website = contactInfo.website;
        await NewSupplier.findByIdAndUpdate(supplierId, { $set: updates });
        this.log(`Updated new supplier ${supplierId} with discovered contact`);
    }

    /**
     * Batch discover contacts for multiple vendors.
     * Each vendor may carry `supplierType` (or `vendorSource`) so the result is saved
     * to the correct collection.
     */
    async discoverMultiple(vendors) {
        this.log(`Batch discovering contacts for ${vendors.length} vendors`);
        const results = [];

        for (const vendor of vendors) {
            const supplierType = vendor.supplierType || vendor.vendorSource;
            const result = await this.discoverContact({ ...vendor, supplierType });
            results.push({ ...vendor, ...result });

            // Rate limit: wait 1 second between calls
            if (vendors.indexOf(vendor) < vendors.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        return results;
    }

    /**
     * Auto-enrich NewSupplier records that are missing a contact email.
     * Runs the discovery LLM for each, records the outcome on `contactDiscovery`,
     * and persists any usable contact. Rate-limited (1s between calls).
     *
     * Designed to be fired from supplier upload/create (fire-and-forget) or from a
     * manual "find all contacts" action.
     *
     * @param {Array} suppliers - NewSupplier docs/objects ({ _id, supplierName, companyName, country, productCategories })
     * @param {Object} [opts]
     * @param {string} [opts.productCategory] - fallback product hint
     * @returns {Array} per-supplier results
     */
    async enrichNewSuppliers(suppliers, opts = {}) {
        const list = (suppliers || []).filter(Boolean);
        this.log(`Auto-enriching contacts for ${list.length} new supplier(s)`);
        const results = [];

        for (let i = 0; i < list.length; i++) {
            const s = list[i];
            try {
                // Mark as pending so the UI can show "searching…"
                await NewSupplier.findByIdAndUpdate(s._id, {
                    $set: { 'contactDiscovery.status': 'pending' },
                }).catch(() => {});

                const result = await this.discoverContact({
                    vendorName: s.supplierName || s.companyName,
                    vendorCode: String(s._id),
                    country: s.country || '',
                    productCategory: (s.productCategories && s.productCategories[0]) || opts.productCategory || '',
                    supplierType: 'new',
                    skipSave: true, // we persist below together with the discovery status
                });

                const updates = {
                    'contactDiscovery.confidence': result.confidence || null,
                    'contactDiscovery.source': result.source || null,
                    'contactDiscovery.contactPerson': result.contactPerson || null,
                    'contactDiscovery.discoveredAt': new Date(),
                };

                const usable = (result.email || result.phone) && result.confidence !== 'low';
                if (usable) {
                    if (result.email) updates.email = result.email;
                    if (result.phone) updates.phone = result.phone;
                    if (result.website) updates.website = result.website;
                    updates['contactDiscovery.status'] = 'done';
                } else {
                    updates['contactDiscovery.status'] = 'not_found';
                }

                await NewSupplier.findByIdAndUpdate(s._id, { $set: updates });
                results.push({ _id: s._id, supplierName: s.supplierName, ...result, saved: usable });
            } catch (err) {
                this.logError(`Enrichment failed for supplier ${s._id}:`, err);
                await NewSupplier.findByIdAndUpdate(s._id, {
                    $set: { 'contactDiscovery.status': 'failed' },
                }).catch(() => {});
                results.push({ _id: s._id, supplierName: s.supplierName, found: false, error: err.message });
            }

            // Rate limit between calls
            if (i < list.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        return results;
    }
}

module.exports = new DiscoveryAgent();
