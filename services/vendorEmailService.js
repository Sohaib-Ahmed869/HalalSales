const Imap = require('imap');
const { simpleParser } = require('mailparser');
const { parseVendorInfoFromEmail, parseRFQResponseWithAI } = require('./aiService');
const Vendor = require('../models/Vendor');
const EmailVendorHistory = require('../models/EmailVendorHistory');

// Conditional import of pdf-parse (may not work on all systems)
let pdfParse = null;
try {
    pdfParse = require('pdf-parse');
    console.log('✅ pdf-parse loaded successfully');
} catch (error) {
    console.warn('⚠️ pdf-parse not available - PDF processing will be disabled:', error.message);
}

// Gmail IMAP Configuration
const gmailImapConfig = {
    user: process.env.VENDOR_EMAIL_USER || 'sohaibsipra32@gmail.com',
    password: process.env.VENDOR_EMAIL_PASSWORD, // App password for Gmail
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: { rejectUnauthorized: false }
};
/**
 * Format date for IMAP search (DD-Mon-YYYY)
 */
const formatImapDate = (date) => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const d = new Date(date);
    return `${d.getDate()}-${months[d.getMonth()]}-${d.getFullYear()}`;
};
/**
 * Connect to Gmail IMAP
 */
const connectToGmail = () => {
    return new Promise((resolve, reject) => {
        const imap = new Imap(gmailImapConfig);

        imap.once('ready', () => {
            console.log('✅ Connected to Gmail (vendor email)');
            resolve(imap);
        });

        imap.once('error', (err) => {
            console.error('❌ Gmail IMAP connection error:', err);
            reject(err);
        });

        imap.connect();
    });
};

/**
 * Fetch emails from Gmail
 */
const fetchGmailEmails = async (folderName = 'INBOX', searchCriteria = ['ALL'], limit = 100) => {
    const imap = await connectToGmail();

    return new Promise((resolve, reject) => {
        imap.openBox(folderName, false, (err, box) => {
            if (err) {
                imap.end();
                return reject(err);
            }

            // Fix: Ensure searchCriteria is properly formatted
            let criteria = searchCriteria;

            // If it's a complex OR query, flatten it properly
            if (Array.isArray(criteria) && criteria[0] === 'OR') {
                // IMAP OR only takes 2 arguments at a time
                // So we need to nest them: ['OR', crit1, ['OR', crit2, crit3]]
                const terms = criteria.slice(1); // Remove 'OR'

                if (terms.length === 0) {
                    criteria = ['ALL'];
                } else if (terms.length === 1) {
                    criteria = terms[0];
                } else {
                    // Build nested OR structure
                    let nested = terms[terms.length - 1];
                    for (let i = terms.length - 2; i >= 0; i--) {
                        nested = ['OR', terms[i], nested];
                    }
                    criteria = nested;
                }
            }

            console.log('Search criteria:', JSON.stringify(criteria));

            imap.search(criteria, (err, results) => {
                if (err) {
                    console.error('IMAP search error:', err);
                    imap.end();
                    return reject(err);
                }

                if (results.length === 0) {
                    console.log('No emails found matching criteria');
                    imap.end();
                    return resolve([]);
                }

                const messagesToFetch = results.slice(-limit);
                console.log(`Fetching ${messagesToFetch.length} messages...`);

                const fetch = imap.fetch(messagesToFetch, {
                    bodies: '',
                    struct: true
                });

                const emails = [];
                let processed = 0;

                fetch.on('message', (msg, seqno) => {
                    msg.on('body', (stream) => {
                        simpleParser(stream, async (err, parsed) => {
                            if (err) {
                                console.error('Error parsing email:', err);
                                return;
                            }

                            emails.push({
                                seqno,
                                from: parsed.from?.value?.[0] || {},
                                to: parsed.to?.value || [],
                                cc: parsed.cc?.value || [],
                                subject: parsed.subject,
                                date: parsed.date,
                                text: parsed.text,
                                html: parsed.html,
                                attachments: parsed.attachments || [],
                                messageId: parsed.messageId,
                                inReplyTo: parsed.inReplyTo,
                                references: parsed.references,
                            });

                            processed++;
                        });
                    });
                });

                fetch.once('error', (err) => {
                    console.error('Fetch error:', err);
                    imap.end();
                    reject(err);
                });

                fetch.once('end', () => {
                    // Wait a bit for all parsing to complete
                    setTimeout(() => {
                        console.log(`Successfully parsed ${emails.length} emails`);
                        imap.end();
                        resolve(emails);
                    }, 2000); // Increased timeout
                });
            });
        });
    });
};

/**
 * Extract PDF text content
 */
const extractPDFText = async (pdfBuffer) => {
    try {
        const data = await pdfParse(pdfBuffer);
        return data.text;
    } catch (error) {
        console.error('Error parsing PDF:', error);
        return null;
    }
};

/**
 * Detect email type based on content
 */
const detectEmailType = (email) => {
    const subject = (email.subject || '').toLowerCase();
    const text = (email.text || '').toLowerCase();

    if (subject.includes('rfq') || subject.includes('request for quotation')) {
        return 'rfq_sent';
    } else if (subject.includes('re:') && (text.includes('quote') || text.includes('price'))) {
        return 'quotation_response';
    } else if (subject.includes('order') || subject.includes('purchase')) {
        return 'purchase_order';
    } else if (subject.includes('invoice')) {
        return 'invoice';
    } else if (text.includes('thank you') || text.includes('received')) {
        return 'acknowledgment';
    }

    return 'general';
};

/**
 * TASK 1: Extract vendors from email history
 */
exports.extractVendorsFromEmailHistory = async () => {
    try {
        console.log('📧 Fetching emails to extract vendors...');

        // Use simple 'ALL' search and filter by date in JavaScript
        // This is more reliable than IMAP date searches
        const searchCriteria = ['ALL'];

        const emails = await fetchGmailEmails('INBOX', searchCriteria, 500);
        console.log(`📨 Fetched ${emails.length} total emails`);

        // Filter by date (last 180 days) in JavaScript
        const cutoffDate = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
        const recentEmails = emails.filter(email =>
            email.date && new Date(email.date) >= cutoffDate
        );

        console.log(`📨 ${recentEmails.length} emails from last 180 days`);

        // Filter for vendor-related emails
        const vendorKeywords = ['quotation', 'quote', 'rfq', 'price', 'order', 'invoice', 'purchase'];
        const relevantEmails = recentEmails.filter(email => {
            const subject = (email.subject || '').toLowerCase();
            const text = (email.text || '').toLowerCase();
            return vendorKeywords.some(keyword =>
                subject.includes(keyword) || text.includes(keyword)
            );
        });

        console.log(`📨 Found ${relevantEmails.length} vendor-related emails`);

        const vendorMap = new Map();
        const ourEmail = process.env.VENDOR_EMAIL_USER.toLowerCase();

        for (const email of relevantEmails) {
            const senderEmail = email.from.address?.toLowerCase();
            const senderName = email.from.name || senderEmail?.split('@')[0];

            if (!senderEmail || senderEmail === ourEmail) {
                continue;
            }

            if (!vendorMap.has(senderEmail)) {
                vendorMap.set(senderEmail, {
                    email: senderEmail,
                    name: senderName,
                    domain: senderEmail.split('@')[1],
                    productCategories: new Set(),
                    certifications: new Set(),
                    interactions: [],
                    firstContactDate: email.date,
                    lastContactDate: email.date,
                    totalEmails: 0,
                    quotationsReceived: 0,
                    rfqsSent: 0,
                });
            }

            const vendor = vendorMap.get(senderEmail);
            const emailType = detectEmailType(email);

            vendor.totalEmails++;
            vendor.lastContactDate = email.date > vendor.lastContactDate ? email.date : vendor.lastContactDate;

            if (emailType === 'quotation_response') {
                vendor.quotationsReceived++;
            } else if (emailType === 'rfq_sent') {
                vendor.rfqsSent++;
            }

            // Process attachments (PDFs)
            let attachmentTexts = [];
            for (const attachment of email.attachments) {
                if (attachment.contentType === 'application/pdf') {
                    const pdfText = await extractPDFText(attachment.content);
                    if (pdfText) {
                        attachmentTexts.push(pdfText);
                    }
                }
            }

            // Use AI to extract vendor info
            const vendorInfo = await parseVendorInfoFromEmail({
                subject: email.subject,
                text: email.text,
                html: email.html,
                attachments: attachmentTexts,
                emailType,
            });

            // Merge extracted info
            if (vendorInfo.productCategories) {
                vendorInfo.productCategories.forEach(cat => vendor.productCategories.add(cat));
            }
            if (vendorInfo.certifications) {
                vendorInfo.certifications.forEach(cert => vendor.certifications.add(cert));
            }
            if (vendorInfo.phone) vendor.phone = vendorInfo.phone;
            if (vendorInfo.address) vendor.address = vendorInfo.address;
            if (vendorInfo.companyName && !vendor.companyName) {
                vendor.companyName = vendorInfo.companyName;
            }

            // NEW: Parse pricing data if it's a quotation response
            let quotationData = null;
            if (emailType === 'quotation_response') {
                const parsedQuotation = await parseRFQResponseWithAI({
                    emailSubject: email.subject,
                    emailBody: email.text || email.html,
                    pdfContent: attachmentTexts.length > 0 ? attachmentTexts[0] : null,
                    vendorEmail: senderEmail,
                    vendorName: senderName,
                    date: email.date,
                    rfqNumber: 'UNKNOWN' // We don't have RFQ context here
                });

                if (parsedQuotation.isValidResponse && parsedQuotation.quotedItems?.length > 0) {
                    quotationData = {
                        quotedItems: parsedQuotation.quotedItems,
                        totalQuotedAmount: parsedQuotation.totalQuotedAmount,
                        deliveryTimeInDays: parsedQuotation.deliveryTimeInDays,
                        paymentTerms: parsedQuotation.paymentTerms,
                        notes: parsedQuotation.notes
                    };

                    console.log(`💰 Extracted pricing from ${senderEmail}:`, {
                        items: quotationData.quotedItems.length,
                        total: quotationData.totalQuotedAmount
                    });
                }
            }

            vendor.interactions.push({
                date: email.date,
                subject: email.subject,
                type: emailType,
                hasAttachments: email.attachments.length > 0,
                snippet: email.text?.substring(0, 200),
                quotationData: quotationData // ADD THIS
            });
        }

        const vendors = Array.from(vendorMap.values()).map(v => ({
            ...v,
            productCategories: Array.from(v.productCategories),
            certifications: Array.from(v.certifications),
        }));

        console.log(`✅ Extracted ${vendors.length} unique vendors`);
        return vendors;

    } catch (error) {
        console.error('Error extracting vendors from email history:', error);
        throw error;
    }
};

/**
 * TASK 1: Store extracted vendors in database
 */
exports.storeEmailVendorsInDB = async () => {
    try {
        const extractedVendors = await exports.extractVendorsFromEmailHistory();
        const storedVendors = [];

        for (const vendorData of extractedVendors) {
            // Check if vendor already exists
            let vendor = await Vendor.findOne({ email: vendorData.email });

            if (vendor) {
                // Update existing vendor
                console.log(`Updating existing vendor: ${vendorData.email}`);

                // Merge product categories
                const existingCategories = vendor.productCategories || [];
                vendor.productCategories = [
                    ...new Set([...existingCategories, ...vendorData.productCategories])
                ];

                // Merge certifications
                const existingCerts = vendor.certifications || [];
                vendor.certifications = [
                    ...new Set([...existingCerts, ...vendorData.certifications])
                ];

                // Update last contact date
                vendor.lastContactDate = vendorData.lastContactDate;

                // Mark as email vendor
                vendor.customFields = {
                    ...vendor.customFields,
                    isEmailVendor: true,
                    emailStats: {
                        totalEmails: vendorData.totalEmails,
                        quotationsReceived: vendorData.quotationsReceived,
                        rfqsSent: vendorData.rfqsSent,
                        firstContactDate: vendorData.firstContactDate,
                    }
                };

            } else {
                // Create new vendor
                console.log(`Creating new email vendor: ${vendorData.email}`);

                // Generate unique CardCode for email vendors
                const cardCode = `EMAIL-${Date.now()}-${Math.random().toString(36).substr(2, 5).toUpperCase()}`;

                vendor = new Vendor({
                    CardCode: cardCode,
                    CardName: vendorData.companyName || vendorData.name || vendorData.email,
                    email: vendorData.email,
                    phone: vendorData.phone,
                    address: vendorData.address,
                    productCategories: vendorData.productCategories,
                    certifications: vendorData.certifications,
                    isActive: true,
                    lastContactDate: vendorData.lastContactDate,
                    customFields: {
                        isEmailVendor: true,
                        emailDomain: vendorData.domain,
                        emailStats: {
                            totalEmails: vendorData.totalEmails,
                            quotationsReceived: vendorData.quotationsReceived,
                            rfqsSent: vendorData.rfqsSent,
                            firstContactDate: vendorData.firstContactDate,
                        }
                    },
                    performanceMetrics: {
                        totalOrders: 0,
                        totalOrderValue: 0,
                        responseTime: 24, // Default
                    }
                });
            }

            await vendor.save();
            storedVendors.push(vendor);

            // Store interaction history separately
            await EmailVendorHistory.findOneAndUpdate(
                { vendorEmail: vendorData.email },
                {
                    vendorEmail: vendorData.email,
                    vendorCardCode: vendor.CardCode,
                    interactions: vendorData.interactions,
                    lastSync: new Date(),
                },
                { upsert: true }
            );
        }

        console.log(`✅ Stored ${storedVendors.length} vendors in database`);
        return storedVendors;

    } catch (error) {
        console.error('Error storing email vendors:', error);
        throw error;
    }
};

/**
 * TASK 2: Parse RFQ responses from emails (including PDFs)
 */
exports.parseRFQResponsesFromEmail = async (rfqNumber) => {
    try {
        console.log(`📧 Fetching RFQ responses for: ${rfqNumber}`);

        // Fetch recent emails and filter in JavaScript
        const searchCriteria = ['ALL'];
        const allEmails = await fetchGmailEmails('INBOX', searchCriteria, 200);

        // Filter by RFQ number
        const emails = allEmails.filter(email => {
            const subject = (email.subject || '').toLowerCase();
            const text = (email.text || '').toLowerCase();
            return subject.includes(rfqNumber.toLowerCase()) ||
                text.includes(rfqNumber.toLowerCase());
        });

        console.log(`📨 Found ${emails.length} emails related to ${rfqNumber}`);

        const responses = [];
        const ourEmail = process.env.VENDOR_EMAIL_USER.toLowerCase();

        for (const email of emails) {
            const senderEmail = email.from.address?.toLowerCase();

            if (!senderEmail || senderEmail === ourEmail) {
                continue;
            }

            // Extract PDF content if present
            let pdfContent = null;
            for (const attachment of email.attachments) {
                if (attachment.contentType === 'application/pdf') {
                    pdfContent = await extractPDFText(attachment.content);
                    break;
                }
            }

            // Use AI to parse the response
            const parsedResponse = await parseRFQResponseWithAI({
                emailSubject: email.subject,
                emailBody: email.text || email.html,
                pdfContent: pdfContent,
                vendorEmail: senderEmail,
                vendorName: email.from.name,
                date: email.date,
                rfqNumber: rfqNumber,
            });


            // ADD THIS LOGGING:
            if (parsedResponse.isValidResponse && parsedResponse.quotedItems) {
                console.log(`\n💰 PRICING DATA from ${senderEmail}:`);
                console.log(`   Total Amount: ${parsedResponse.totalQuotedAmount || 'N/A'}`);
                console.log(`   Items quoted: ${parsedResponse.quotedItems.length}`);
                parsedResponse.quotedItems.forEach((item, idx) => {
                    console.log(`   ${idx + 1}. ${item.productName}: ${item.unitPrice} ${item.currency}/${item.unit} (Qty: ${item.quantity})`);
                });
                console.log(`   Source: ${pdfContent ? 'PDF Attachment' : 'Email Body'}`);
            }

            if (parsedResponse.isValidResponse) {
                responses.push({
                    vendorEmail: senderEmail,
                    vendorName: email.from.name,
                    responseDate: email.date,
                    emailSubject: email.subject,
                    ...parsedResponse,
                    rawEmail: {
                        messageId: email.messageId,
                        hasPDF: !!pdfContent,
                    }
                });
            }
        }

        console.log(`✅ Parsed ${responses.length} valid RFQ responses`);
        return responses;

    } catch (error) {
        console.error('Error parsing RFQ responses:', error);
        throw error;
    }
};

/**
 * Track email thread history for RFQ
 */
exports.trackRFQEmailThread = async (rfqNumber) => {
    try {
        const searchCriteria = [
            'OR',
            ['SUBJECT', rfqNumber],
            ['BODY', rfqNumber],
        ];

        const emails = await fetchGmailEmails('INBOX', searchCriteria, 100);

        // Group by conversation thread
        const threads = {};

        for (const email of emails) {
            const threadId = email.inReplyTo || email.messageId;
            if (!threads[threadId]) {
                threads[threadId] = [];
            }
            threads[threadId].push(email);
        }

        return threads;
    } catch (error) {
        console.error('Error tracking email thread:', error);
        throw error;
    }
};

module.exports = exports;