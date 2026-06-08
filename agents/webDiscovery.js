// agents/webDiscovery.js
// Grounded contact discovery.
// Pipeline: Google Custom Search -> find official website -> crawl contact/impressum
// pages -> extract real emails & phones -> verify (domain match + MX) -> GPT ranks the
// REAL candidates. GPT never invents a contact here; it only chooses among scraped data.

const axios = require('axios');
const cheerio = require('cheerio');
const dns = require('dns').promises;
const { BaseAgent } = require('./baseAgent');

const GOOGLE_ENDPOINT = 'https://www.googleapis.com/customsearch/v1';
const USER_AGENT =
    'Mozilla/5.0 (compatible; HalalSalesContactBot/1.0; +https://halalsales.local/bot)';
const FETCH_TIMEOUT = 8000;
const MAX_PAGES = 5; // homepage + a few contact pages

// Pages most likely to carry a real B2B contact, in priority order.
// Impressum (DE) / mentions-legales (FR) are legally REQUIRED to list email + phone.
const CONTACT_PATHS = [
    '/contact', '/contact-us', '/contactus', '/contacto', '/kontakt',
    '/impressum', '/mentions-legales', '/imprint', '/legal',
    '/about', '/about-us',
];

// Domains that are directories/social/marketplaces — never the supplier's own site.
const NON_OFFICIAL_HOSTS = [
    'facebook.com', 'linkedin.com', 'instagram.com', 'twitter.com', 'x.com',
    'youtube.com', 'wikipedia.org', 'alibaba.com', 'made-in-china.com',
    'europages.', 'yellowpages.', 'yelp.', 'indiamart.com', 'tradeindia.com',
    'crunchbase.com', 'bloomberg.com', 'dnb.com', 'glassdoor.', 'amazon.',
    'pinterest.', 'tiktok.com', 'google.', 'maps.google', 'tripadvisor.',
];

// Email local-parts that are never a useful B2B contact.
const REJECTED_LOCAL = [
    'noreply', 'no-reply', 'donotreply', 'do-not-reply',
    'webmaster', 'postmaster', 'mailer-daemon', 'abuse', 'hostmaster',
];

// Junk "domains" that show up when regex-scraping HTML (assets, placeholders, trackers).
const JUNK_EMAIL_DOMAINS = [
    'example.com', 'example.org', 'domain.com', 'yourdomain.com', 'email.com',
    'sentry.io', 'wixpress.com', 'sentry.wixpress.com', 'godaddy.com',
    'schema.org', 'w3.org', 'placeholder.com',
];
const ASSET_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'css', 'js', 'json', 'woff', 'woff2', 'ico'];

// Role keywords ranked best -> worst for B2B procurement.
const ROLE_PRIORITY = [
    'sales', 'export', 'procurement', 'purchasing', 'commercial', 'ventes',
    'enquir', 'inquir', 'order', 'contact', 'info', 'office', 'hello', 'admin', 'mail',
];

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

class WebDiscovery extends BaseAgent {
    constructor() {
        super('WebDiscovery');
    }

    isConfigured() {
        return !!(process.env.GOOGLE_API_KEY && process.env.GOOGLE_SEARCH_ENGINE_ID);
    }

    /**
     * Main entry. Returns the same shape as DiscoveryAgent.discoverContact, or null
     * if web discovery isn't configured (so the caller can fall back to LLM memory).
     */
    async discover({ vendorName, country, productCategory }) {
        if (!this.isConfigured()) return null;
        if (!vendorName) return { found: false, source: 'web:no-vendor-name' };

        try {
            const query = `${vendorName} ${country || ''} contact email`.trim();
            const results = await this.googleSearch(query, 6);

            if (!results.length) {
                return { found: false, source: 'web:no-search-results' };
            }

            const website = this._pickWebsite(results, vendorName);
            const siteDomain = website ? this._domain(website) : null;

            // Collect candidates from the search snippets themselves first (cheap).
            const emails = new Set();
            const phones = new Set();
            for (const r of results) {
                this._extractFromText(`${r.title} ${r.snippet}`, emails, phones);
            }

            // Then crawl the official site's contact pages for grounded data.
            let crawledText = '';
            if (website) {
                const crawl = await this._crawlSite(website, siteDomain);
                crawl.emails.forEach(e => emails.add(e));
                crawl.phones.forEach(p => phones.add(p));
                crawledText = crawl.text;
            }

            const emailList = [...emails]
                .map(e => e.toLowerCase())
                .filter(e => this._validEmail(e));
            const phoneList = [...phones].map(p => this._normPhone(p)).filter(Boolean);
            const uniqueEmails = [...new Set(emailList)];
            const uniquePhones = [...new Set(phoneList)];

            if (!uniqueEmails.length && !uniquePhones.length) {
                return { found: false, website, source: `web:no-contacts-found (${siteDomain || 'no site'})` };
            }

            // GPT ranks the REAL candidates (or heuristic if GPT unavailable/ambiguous).
            const best = await this._rank({
                vendorName, website, productCategory,
                emailList: uniqueEmails, phoneList: uniquePhones, crawledText,
            });

            const verification = await this._verify(best.email, siteDomain);
            const confidence = this._confidence(best, verification);

            const sourceBits = [website ? `site ${siteDomain}` : 'search results'];
            if (verification.domainMatch) sourceBits.push('domain match');
            if (verification.mx) sourceBits.push('MX ok');

            return {
                email: best.email || null,
                phone: best.phone || null,
                website: website || null,
                contactPerson: best.contactPerson || null,
                confidence,
                source: `Web (${sourceBits.join(', ')})`,
                found: !!(best.email || best.phone),
                candidates: { emails: uniqueEmails, phones: uniquePhones },
            };
        } catch (error) {
            this.logError(`Web discovery failed for ${vendorName}:`, error);
            return { found: false, source: 'web:error', error: error.message };
        }
    }

    // ── Google Custom Search ────────────────────────────────────────────────

    async googleSearch(query, num = 5) {
        const { data } = await axios.get(GOOGLE_ENDPOINT, {
            params: {
                key: process.env.GOOGLE_API_KEY,
                cx: process.env.GOOGLE_SEARCH_ENGINE_ID,
                q: query,
                num: Math.min(num, 10),
            },
            timeout: FETCH_TIMEOUT,
        });
        return (data.items || []).map(i => ({
            title: i.title || '',
            link: i.link || '',
            snippet: i.snippet || '',
            displayLink: i.displayLink || '',
        }));
    }

    /**
     * Choose the supplier's official website from search results.
     * Skips directories/social, prefers a host that echoes the company name.
     */
    _pickWebsite(results, vendorName) {
        const nameTokens = this._nameTokens(vendorName);
        const candidates = results
            .map(r => r.link)
            .filter(Boolean)
            .filter(link => {
                const host = this._origin(link)?.replace(/^https?:\/\//, '') || '';
                return !NON_OFFICIAL_HOSTS.some(bad => host.includes(bad));
            });

        if (!candidates.length) return null;

        // Prefer a host whose domain contains a chunk of the company name.
        const scored = candidates
            .map(link => {
                const host = (this._domain(link) || '').toLowerCase();
                const score = nameTokens.reduce((s, t) => (t.length >= 4 && host.includes(t) ? s + 1 : s), 0);
                return { link, score };
            })
            .sort((a, b) => b.score - a.score);

        // If nothing matched the name, fall back to the first non-directory result.
        return this._origin(scored[0].score > 0 ? scored[0].link : candidates[0]);
    }

    // ── Crawling ────────────────────────────────────────────────────────────

    async _crawlSite(rootUrl, siteDomain) {
        const emails = new Set();
        const phones = new Set();
        let text = '';
        let origin = this._origin(rootUrl);
        if (!origin) return { emails: [], phones: [], text: '' };

        const queue = [];
        const visited = new Set();

        // Start with the homepage, then discover its contact links.
        // Some sites only serve one of www/apex (or have a cert valid for only one),
        // so fall back to the alternate host if the first fails.
        let home = await this._fetch(origin);
        if (!home) {
            const alt = this._toggleWww(origin);
            if (alt && alt !== origin) {
                const altHome = await this._fetch(alt);
                if (altHome) { home = altHome; origin = alt; }
            }
        }
        if (home) {
            visited.add(origin);
            this._extractFromHtml(home, origin, emails, phones);
            text += ' ' + this._textFromHtml(home);

            const $ = cheerio.load(home);
            $('a[href]').each((_, a) => {
                const href = $(a).attr('href') || '';
                const label = ($(a).text() || '').toLowerCase();
                if (/contact|kontakt|impressum|mentions|about|legal|imprint|contacto/i.test(href + ' ' + label)) {
                    const abs = this._abs(origin, href);
                    if (abs && this._origin(abs) === origin) queue.push(abs);
                }
            });
        }

        // Always also probe the common contact paths directly.
        for (const p of CONTACT_PATHS) queue.push(origin + p);

        const unique = [...new Set(queue)].filter(u => !visited.has(u)).slice(0, MAX_PAGES);
        for (const url of unique) {
            if (visited.has(url)) continue;
            visited.add(url);
            const html = await this._fetch(url);
            if (!html) continue;
            this._extractFromHtml(html, origin, emails, phones);
            text += ' ' + this._textFromHtml(html);

            // Short-circuit: once we have a domain-matching email, we have enough.
            if (siteDomain && [...emails].some(e => e.split('@')[1]?.endsWith(siteDomain))) break;
        }

        return { emails: [...emails], phones: [...phones], text: text.replace(/\s+/g, ' ').slice(0, 6000) };
    }

    async _fetch(url) {
        try {
            const { data } = await axios.get(url, {
                timeout: FETCH_TIMEOUT,
                maxRedirects: 5,
                maxContentLength: 3 * 1024 * 1024,
                responseType: 'text',
                headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
                validateStatus: s => s >= 200 && s < 400,
            });
            return typeof data === 'string' ? data : null;
        } catch (_) {
            return null;
        }
    }

    // ── Extraction ──────────────────────────────────────────────────────────

    _extractFromHtml(html, baseUrl, emails, phones) {
        const $ = cheerio.load(html);
        // mailto: / tel: links are the most reliable signals.
        $('a[href^="mailto:"]').each((_, a) => {
            const addr = ($(a).attr('href') || '').replace(/^mailto:/i, '').split('?')[0].trim();
            if (addr) addr.split(/[,;]/).forEach(e => e.trim() && emails.add(decodeURIComponent(e.trim())));
        });
        $('a[href^="tel:"]').each((_, a) => {
            const num = ($(a).attr('href') || '').replace(/^tel:/i, '').trim();
            if (num) phones.add(num);
        });
        // Emails also live in footers and JSON-LD structured data, not just visible text —
        // so regex over the RAW html for emails (junk is filtered later by _validEmail).
        const rawEmails = html.match(EMAIL_RE);
        if (rawEmails) rawEmails.forEach(e => emails.add(e.trim()));
        // Phones are noisy, so only take labelled numbers from visible text.
        this._extractFromText($('body').text() || '', new Set(), phones);
    }

    _extractFromText(text, emails, phones) {
        if (!text) return;
        const em = text.match(EMAIL_RE);
        if (em) em.forEach(e => emails.add(e.trim()));
        // Phone regex is noisy, so only take numbers that sit next to a phone label.
        const phoneLabelled = text.match(/(?:tel|phone|fax|t[ée]l|telefon|call|mob)[^0-9+]{0,12}(\+?\d[\d\s().\-]{7,}\d)/gi);
        if (phoneLabelled) {
            phoneLabelled.forEach(m => {
                const num = m.match(/(\+?\d[\d\s().\-]{7,}\d)/);
                if (num) phones.add(num[1]);
            });
        }
    }

    _textFromHtml(html) {
        try {
            const $ = cheerio.load(html);
            $('script, style, noscript').remove();
            return $('body').text() || '';
        } catch (_) {
            return '';
        }
    }

    // ── Ranking (GPT over REAL candidates only) ─────────────────────────────

    async _rank({ vendorName, website, productCategory, emailList, phoneList, crawledText }) {
        const heuristic = {
            email: this._bestEmailHeuristic(emailList, website),
            phone: phoneList[0] || null,
            contactPerson: null,
        };

        // Not worth an LLM call if there's nothing to disambiguate.
        if (emailList.length <= 1 && !crawledText) return heuristic;

        try {
            const system = `You select the single best B2B procurement contact from REAL data scraped from a food supplier's website.

STRICT RULES:
- ONLY return an email/phone that appears verbatim in the provided candidate lists. NEVER invent, complete, or modify one.
- Prefer sales / export / procurement / commercial contacts over generic info@, and over hr@, jobs@, marketing@, support@.
- Reject noreply-type addresses.
- contactPerson: only if a real person's name clearly appears in the page text next to the contact; otherwise null.

Return ONLY JSON:
{"email":"<a candidate email or null>","phone":"<a candidate phone or null>","contactPerson":"name or null"}`;

            const user = `Company: ${vendorName}
Website: ${website || 'unknown'}
Product category: ${productCategory || 'food products'}

Candidate emails:
${emailList.join('\n') || '(none)'}

Candidate phones:
${phoneList.join('\n') || '(none)'}

Page text excerpt:
${(crawledText || '').slice(0, 3000)}`;

            const resp = await this.callLLM(system, user);
            const parsed = this.extractJSON(this.extractText(resp));
            if (!parsed) return heuristic;

            // Guard against any hallucination: result must be in the candidate set.
            const email = parsed.email && emailList.includes(String(parsed.email).toLowerCase())
                ? String(parsed.email).toLowerCase()
                : heuristic.email;
            const phone = parsed.phone && phoneList.includes(String(parsed.phone))
                ? String(parsed.phone)
                : heuristic.phone;

            return { email, phone, contactPerson: parsed.contactPerson || null };
        } catch (err) {
            this.logError('Rank LLM failed, using heuristic:', err);
            return heuristic;
        }
    }

    _bestEmailHeuristic(emails, website) {
        if (!emails.length) return null;
        const siteDomain = this._domain(website);
        const score = (email) => {
            const [local, edom] = email.split('@');
            let s = 0;
            if (siteDomain && edom && edom.endsWith(siteDomain)) s += 100; // domain match wins
            const idx = ROLE_PRIORITY.findIndex(r => local.includes(r));
            if (idx >= 0) s += (ROLE_PRIORITY.length - idx);
            return s;
        };
        return [...emails].sort((a, b) => score(b) - score(a))[0];
    }

    // ── Verification ────────────────────────────────────────────────────────

    async _verify(email, siteDomain) {
        const out = { domainMatch: false, mx: false };
        if (!email) return out;
        const edom = email.split('@')[1];
        if (!edom) return out;
        if (siteDomain && edom.endsWith(siteDomain)) out.domainMatch = true;
        try {
            const mx = await dns.resolveMx(edom);
            out.mx = Array.isArray(mx) && mx.length > 0;
        } catch (_) {
            out.mx = false;
        }
        return out;
    }

    _confidence(best, verification) {
        if (best.email) {
            if (verification.domainMatch && verification.mx) return 'high';
            if (verification.mx || verification.domainMatch) return 'medium';
            return 'low';
        }
        if (best.phone) return 'medium';
        return 'low';
    }

    // ── Small helpers ────────────────────────────────────────────────────────

    _validEmail(email) {
        if (!email) return false;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
        const [local, domain] = email.toLowerCase().split('@');
        if (REJECTED_LOCAL.includes(local)) return false;
        if (JUNK_EMAIL_DOMAINS.includes(domain)) return false;
        const tld = domain.split('.').pop();
        if (ASSET_EXTENSIONS.includes(tld)) return false; // e.g. logo@2x.png
        return true;
    }

    _normPhone(raw) {
        if (!raw) return null;
        const cleaned = String(raw).replace(/[^\d+]/g, '');
        const digits = cleaned.replace(/\D/g, '');
        if (digits.length < 8 || digits.length > 15) return null; // not a real phone
        return String(raw).trim().replace(/\s+/g, ' ');
    }

    _nameTokens(name) {
        return String(name || '')
            .toLowerCase()
            .replace(/\b(ltd|llc|inc|gmbh|sarl|sa|bv|srl|co|company|foods?|group|international|trading|sas|spa)\b/g, '')
            .replace(/[^a-z0-9\s]/g, '')
            .split(/\s+/)
            .filter(Boolean);
    }

    _origin(url) {
        try {
            const u = new URL(url.startsWith('http') ? url : `https://${url}`);
            return `${u.protocol}//${u.host}`;
        } catch (_) {
            return null;
        }
    }

    _abs(origin, href) {
        try {
            return new URL(href, origin).toString();
        } catch (_) {
            return null;
        }
    }

    /** Toggle the leading www. on an origin (https://www.x.com <-> https://x.com). */
    _toggleWww(origin) {
        if (!origin) return null;
        return /:\/\/www\./i.test(origin)
            ? origin.replace(/:\/\/www\./i, '://')
            : origin.replace(/:\/\//, '://www.');
    }

    /** Registrable-ish domain: host minus leading "www." */
    _domain(url) {
        const origin = this._origin(url);
        if (!origin) return null;
        return origin.replace(/^https?:\/\//, '').replace(/^www\./, '').toLowerCase();
    }
}

module.exports = new WebDiscovery();
