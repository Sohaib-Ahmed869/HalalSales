// services/rfqService.js
const PurchaseInvoice = require('../models/Purchase');
const Vendor = require('../models/Vendor');
const RFQ = require('../models/RFQ');
const {
    parseNaturalLanguageRFQ,
    generateSearchKeywords,
    analyzeVendorRecommendations
} = require('./aiService');
const EmailVendorHistory = require('../models/EmailVendorHistory');
const vendorEmailService = require('./vendorEmailService');

/**
 * Process natural language RFQ request
 * @param {string} naturalLanguageInput - User's description of what they need
 * @param {string} userId - User ID
 * @param {string} searchMode - 'existing' or 'new' to filter vendor sources
 * @returns {Object} Structured RFQ with vendor recommendations
 */
async function processNaturalLanguageRFQ(naturalLanguageInput, userId, searchMode = 'existing') {
    console.log('=== Starting Natural Language RFQ Processing ===');
    console.log('Input:', naturalLanguageInput);
    console.log('Search Mode:', searchMode); // ADD THIS LOG

    // Step 1: Use AI to parse the natural language input
    const parsedRFQ = await parseNaturalLanguageRFQ(naturalLanguageInput);

    if (!parsedRFQ.success) {
        throw new Error('Failed to parse RFQ request');
    }

    console.log('✅ Parsed RFQ:', JSON.stringify(parsedRFQ.data, null, 2));

    // Step 2: For each item, analyze historical data and find vendors
    const itemsWithVendors = [];

    for (const item of parsedRFQ.data.items) {
        console.log(`\n--- Analyzing item: ${item.productName} ---`);

        // Generate additional search keywords using AI if not provided
        let keywords = item.searchKeywords && item.searchKeywords.length > 0
            ? item.searchKeywords
            : await generateSearchKeywords(item.productName);

        console.log(`Search keywords: ${JSON.stringify(keywords)}`);

        // Find vendors from historical data - PASS searchMode
        let vendorAnalysis = await analyzeHistoricalPurchasesMultiKeyword(
            keywords,
            item.quantity,
            searchMode // PASS searchMode HERE
        );

        console.log(`Found ${vendorAnalysis.length} vendors from initial search (mode: ${searchMode})`);

        // If no vendors found, try broader search
        if (vendorAnalysis.length === 0) {
            console.log('⚠️ No vendors found, trying broader search...');

            const broaderKeywords = [item.productName];
            vendorAnalysis = await analyzeHistoricalPurchasesMultiKeyword(
                broaderKeywords,
                item.quantity,
                searchMode // PASS searchMode HERE
            );

            console.log(`Broader search found ${vendorAnalysis.length} vendors`);

            if (vendorAnalysis.length === 0) {
                const words = item.productName.split(' ').filter(w => w.length > 3);
                if (words.length > 0) {
                    console.log(`Trying word-by-word search: ${JSON.stringify(words)}`);
                    vendorAnalysis = await analyzeHistoricalPurchasesMultiKeyword(
                        words,
                        item.quantity,
                        searchMode // PASS searchMode HERE
                    );
                    console.log(`Word-by-word search found ${vendorAnalysis.length} vendors`);
                }
            }
        }

        // Get full vendor details
        const sapVendorCodes = vendorAnalysis
            .filter(v => v.vendorSource === 'SAP' || v.vendorSource === 'EMAIL')
            .map(v => v._id);
        const pdaSupplierIds = vendorAnalysis
            .filter(v => v.vendorSource === 'PDA_SCRAPER')
            .map(v => v._id);

        console.log(`Looking for ${sapVendorCodes.length} SAP/EMAIL vendors and ${pdaSupplierIds.length} PDA suppliers`);

        const vendors = await Vendor.find({
            CardCode: { $in: sapVendorCodes },
        });

        const PDA_Supplier = require('../models/PDA_Supplier');
        const pdaSuppliers = await PDA_Supplier.find({
            _id: { $in: pdaSupplierIds },
            isActive: true
        });

        console.log(`Vendor.find() returned ${vendors.length} vendors`);
        console.log(`PDA_Supplier.find() returned ${pdaSuppliers.length} suppliers`);

        const enrichedVendors = vendorAnalysis.map(historical => {
            if (historical.vendorSource === 'PDA_SCRAPER') {
                return {
                    ...historical,
                    hasEmail: !!historical.email,
                };
            } else {
                const vendorDetails = vendors.find(v => v.CardCode === historical._id);
                return {
                    ...historical,
                    email: vendorDetails?.email,
                    phone: vendorDetails?.phone,
                    productCategories: vendorDetails?.productCategories,
                    certifications: vendorDetails?.certifications,
                    isEmailVendor: vendorDetails?.customFields?.isEmailVendor || false,
                    vendorSource: historical.vendorSource || 'SAP',
                    hasEmail: !!vendorDetails?.email,
                };
            }
        }).filter(v => v.hasEmail);

        console.log(`Final ${enrichedVendors.length} vendors with email addresses`);

        itemsWithVendors.push({
            ...item,
            keywords,
            vendors: enrichedVendors,
            vendorsFound: enrichedVendors.length,
        });
    }

    // Step 3: Get unique vendors across all items
    const allVendorCodes = new Set();
    itemsWithVendors.forEach(item => {
        item.vendors.forEach(v => allVendorCodes.add(v._id));
    });

    console.log(`\n=== Total unique vendors across all items: ${allVendorCodes.size} ===`);

    // Step 4: Create a consolidated vendor list with scores
    const topVendorsAcrossItems = itemsWithVendors
        .flatMap(item => item.vendors)
        .reduce((acc, vendor) => {
            const existing = acc.find(v => v._id === vendor._id);
            if (existing) {
                existing.itemsCanSupply = (existing.itemsCanSupply || 1) + 1;
                existing.totalScore += vendor.scores.total;
                existing.avgScore = existing.totalScore / existing.itemsCanSupply;
            } else {
                acc.push({
                    ...vendor,
                    itemsCanSupply: 1,
                    totalScore: vendor.scores.total,
                    avgScore: vendor.scores.total,
                });
            }
            return acc;
        }, [])
        .sort((a, b) => {
            // Prioritize vendors who can supply multiple items
            if (b.itemsCanSupply !== a.itemsCanSupply) {
                return b.itemsCanSupply - a.itemsCanSupply;
            }
            // Then sort by average score
            return b.avgScore - a.avgScore;
        });

    console.log('Top vendors (sorted):', topVendorsAcrossItems.slice(0, 5).map(v => ({
        name: v.vendorName,
        code: v._id,
        itemsCanSupply: v.itemsCanSupply,
        avgScore: v.avgScore
    })));

    // Step 5: Get AI recommendations for vendor selection
    const rfqContext = {
        items: parsedRFQ.data.items,
        specialRequirements: parsedRFQ.data.specialRequirements,
        totalVendorsFound: allVendorCodes.size,
    };

    let aiRecommendations = null;

    if (topVendorsAcrossItems.length > 0) {
        console.log('\n--- Getting AI vendor recommendations ---');
        aiRecommendations = await analyzeVendorRecommendations(
            topVendorsAcrossItems,
            rfqContext
        );
    } else {
        console.warn('⚠️ No vendors found in historical data. Cannot generate AI recommendations.');
        aiRecommendations = {
            topRecommendations: [],
            priceInsights: 'No historical purchase data available for price analysis. Consider importing your purchase history or manually adding vendors.',
            riskFactors: 'No vendor history found in the system. You may need to: 1) Import historical purchase data, 2) Add vendors to the vendor database, or 3) Search with different keywords.',
            suggestedVendorCount: 0,
            suggestedVendorCodes: [],
        };
    }

    console.log('=== Natural Language RFQ Processing Complete ===\n');

    return {
        originalInput: naturalLanguageInput,
        parsedData: parsedRFQ.data,
        itemsAnalysis: itemsWithVendors,
        vendorRecommendations: {
            total: allVendorCodes.size,
            topVendors: topVendorsAcrossItems,
            aiInsights: aiRecommendations,
        },
        createdBy: userId,
    };
}

/**
 * Generate flexible keyword variations for better matching
 */
function generateKeywordVariations(keywords) {
    const variations = new Set();

    keywords.forEach(keyword => {
        // Add original
        variations.add(keyword);

        // Add lowercase
        variations.add(keyword.toLowerCase());

        // Split into words and add individual words (if multi-word)
        const words = keyword.toLowerCase().split(/\s+/);
        if (words.length > 1) {
            words.forEach(word => {
                if (word.length > 3) { // Only add meaningful words
                    variations.add(word);
                }
            });
        }

        // Remove plurals (simple approach)
        if (keyword.endsWith('s') && keyword.length > 4) {
            variations.add(keyword.slice(0, -1));
        }
    });

    return Array.from(variations);
}

/**
 * Analyze historical purchases with multiple keywords (ENHANCED for Email Vendors)
 * @param {Array<string>} keywords - Search keywords
 * @param {number} quantity - Required quantity
 * @param {string} searchMode - 'existing' or 'new' to filter vendor sources
 * @returns {Array} Scored vendor list (both SAP and Email vendors)
 */
async function analyzeHistoricalPurchasesMultiKeyword(keywords, quantity, searchMode = 'existing') {
    console.log(`\n>> Searching historical purchases with keywords: ${JSON.stringify(keywords)}`);
    console.log(`>> Search Mode: ${searchMode}`); // ADD THIS LOG

    if (!keywords || keywords.length === 0) {
        console.log('⚠️ No keywords provided, returning empty results');
        return [];
    }

    // Generate keyword variations for better matching
    const expandedKeywords = generateKeywordVariations(keywords);
    console.log(`>> Expanded keywords: ${JSON.stringify(expandedKeywords)}`);

    const regexPatterns = expandedKeywords.map(keyword => ({
        'DocumentLines.ItemDescription': {
            $regex: keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            $options: 'i'
        }
    }));

    try {
        let sapVendors = [];
        let emailVendors = [];
        let pdaSuppliers = [];

        // ====== CONDITIONAL FETCHING BASED ON searchMode ======

        if (searchMode === 'existing') {
            // ONLY fetch SAP and EMAIL vendors (existing)
            console.log('>> MODE: EXISTING - Searching SAP and EMAIL vendors only');

            // Fetch SAP vendors (existing logic)
            sapVendors = await PurchaseInvoice.aggregate([
                // ... existing SAP aggregation pipeline
                {
                    $match: {
                        $or: regexPatterns
                    }
                },
                {
                    $unwind: '$DocumentLines'
                },
                {
                    $match: {
                        $or: regexPatterns
                    }
                },
                {
                    $group: {
                        _id: '$CardCode',
                        vendorName: { $first: '$CardName' },
                        totalPurchases: { $sum: 1 },
                        avgPrice: { $avg: '$DocumentLines.Price' },
                        minPrice: { $min: '$DocumentLines.Price' },
                        maxPrice: { $max: '$DocumentLines.Price' },
                        lastPurchaseDate: { $max: '$DocDate' },
                        firstPurchaseDate: { $min: '$DocDate' },
                        totalQuantity: { $sum: '$DocumentLines.Quantity' },
                        totalValue: { $sum: '$DocumentLines.LineTotal' },
                        items: {
                            $push: {
                                itemCode: '$DocumentLines.ItemCode',
                                description: '$DocumentLines.ItemDescription',
                                price: '$DocumentLines.Price',
                                quantity: '$DocumentLines.Quantity',
                                date: '$DocDate',
                                currency: '$DocCurrency',
                                lineTotal: '$DocumentLines.LineTotal',
                            }
                        }
                    }
                },
                {
                    $project: {
                        _id: 1,
                        vendorName: 1,
                        totalPurchases: 1,
                        avgPrice: 1,
                        minPrice: 1,
                        maxPrice: 1,
                        lastPurchaseDate: 1,
                        firstPurchaseDate: 1,
                        totalQuantity: 1,
                        totalValue: 1,
                        items: { $slice: ['$items', -5] },
                        purchaseHistory: {
                            $map: {
                                input: { $slice: ['$items', -5] },
                                as: 'item',
                                in: {
                                    productName: '$$item.description',
                                    quantity: '$$item.quantity',
                                    unit: 'kg',
                                    price: '$$item.price',
                                    total: '$$item.lineTotal',
                                    date: '$$item.date',
                                    poNumber: null
                                }
                            }
                        }
                    }
                },
                {
                    $sort: { totalPurchases: -1 }
                }
            ]);

            sapVendors = sapVendors.map(vendor => ({
                ...vendor,
                vendorSource: 'SAP',
                purchaseHistory: vendor.items?.map(item => ({
                    productName: item.description,
                    quantity: item.quantity,
                    unit: 'kg',
                    price: item.price,
                    total: item.lineTotal,
                    date: item.date,
                    poNumber: null
                })) || []
            }));

            console.log(`>> Found ${sapVendors.length} SAP vendors`);

        } else if (searchMode === 'new') {
            // Fetch EMAIL vendors + PDA suppliers
            console.log('>> MODE: NEW - Searching EMAIL vendors + PDA suppliers');

            // ===== FETCH EMAIL VENDORS =====
            try {
                const keywordRegex = new RegExp(keywords.join('|'), 'i');

                const emailVendorDetails = await Vendor.find({
                    'customFields.isEmailVendor': true,
                    isActive: true,
                    $or: [
                        { productCategories: { $regex: keywordRegex } },
                        { CardName: { $regex: keywordRegex } }
                    ]
                });

                console.log(`>> Found ${emailVendorDetails.length} email vendors matching product categories`);

                const emailVendorCodes = emailVendorDetails.map(v => v.CardCode);
                const emailVendorHistories = await EmailVendorHistory.find({
                    vendorCardCode: { $in: emailVendorCodes }
                });

                emailVendors = emailVendorDetails.map(vendor => {
                    const history = emailVendorHistories.find(
                        h => h.vendorCardCode === vendor.CardCode
                    );

                    const quotations = history?.interactions.filter(
                        i => i.type === 'quotation_response'
                    ) || [];

                    const quotationsWithPricing = quotations.filter(q => q.quotationData?.quotedItems?.length > 0);
                    let avgPrice = 0;
                    let minPrice = 0;
                    let maxPrice = 0;

                    if (quotationsWithPricing.length > 0) {
                        const allPrices = quotationsWithPricing.flatMap(q =>
                            q.quotationData.quotedItems.map(item => item.unitPrice)
                        ).filter(p => p > 0);

                        if (allPrices.length > 0) {
                            avgPrice = allPrices.reduce((a, b) => a + b, 0) / allPrices.length;
                            minPrice = Math.min(...allPrices);
                            maxPrice = Math.max(...allPrices);
                        }
                    }

                    const allInteractions = history?.interactions || [];

                    return {
                        _id: vendor.CardCode,
                        vendorName: vendor.CardName,
                        vendorSource: 'EMAIL',
                        totalPurchases: vendor.customFields?.emailStats?.quotationsReceived || 0,
                        avgPrice: avgPrice,
                        minPrice: minPrice,
                        maxPrice: maxPrice,
                        lastPurchaseDate: vendor.lastContactDate || vendor.customFields?.emailStats?.firstContactDate || new Date(),
                        firstPurchaseDate: vendor.customFields?.emailStats?.firstContactDate || new Date(),
                        totalQuantity: 0,
                        totalValue: 0,
                        purchaseHistory: quotations.slice(-5).map(q => ({
                            productName: q.snippet?.substring(0, 50) || 'Email quotation',
                            quantity: 0,
                            unit: 'kg',
                            price: 0,
                            total: 0,
                            date: q.date,
                            poNumber: null
                        })),
                        email: vendor.email,
                        phone: vendor.phone,
                        emailStats: vendor.customFields?.emailStats || {},
                        matchedCategories: vendor.productCategories.filter(cat =>
                            keywordRegex.test(cat)
                        ),
                        totalEmailInteractions: allInteractions.length
                    };
                });

                console.log(`>> Found ${emailVendors.length} email vendors`);

            } catch (emailError) {
                console.error('⚠️ Error fetching email vendors:', emailError.message);
            }

            // ===== FETCH PDA SUPPLIERS =====
            try {
                const PDA_Supplier = require('../models/PDA_Supplier');
                const keywordRegex = new RegExp(keywords.join('|'), 'i');

                const pdaSupplierDetails = await PDA_Supplier.find({
                    isActive: true,
                    $or: [
                        { searchTerm: { $regex: keywordRegex } },
                        { supplierName: { $regex: keywordRegex } },
                        { 'rawData.metadata.products': { $regex: keywordRegex } },
                        { 'rawData.productname': { $regex: keywordRegex } }
                    ],
                    'email': { $exists: true, $ne: null, $ne: '' }
                }).limit(20);

                console.log(`>> Found ${pdaSupplierDetails.length} PDA suppliers matching keywords`);

                pdaSuppliers = pdaSupplierDetails.map(supplier => {
                    return {
                        _id: supplier._id.toString(),
                        vendorName: supplier.supplierName,
                        vendorSource: 'PDA_SCRAPER',
                        totalPurchases: 0,
                        avgPrice: 0,
                        minPrice: 0,
                        maxPrice: 0,
                        lastPurchaseDate: supplier.createdAt || new Date(),
                        firstPurchaseDate: supplier.createdAt || new Date(),
                        totalQuantity: 0,
                        totalValue: 0,
                        purchaseHistory: [],
                        email: supplier.email,
                        phone: supplier.contactInfo?.phone,
                        country: supplier.country,
                        scrapedFrom: supplier.scrapedFrom,
                        isNewSupplier: true,
                        supplierMetadata: {
                            searchTerm: supplier.searchTerm,
                            scrapedFrom: supplier.scrapedFrom,
                            country: supplier.country,
                            rawData: supplier.rawData
                        }
                    };
                });

                console.log(`>> Found ${pdaSuppliers.length} PDA suppliers`);

            } catch (pdaError) {
                console.error('⚠️ Error fetching PDA suppliers:', pdaError.message);
            }
        }

        // ====== Combine and Score All Vendors ======
        const allVendors = [...sapVendors, ...emailVendors, ...pdaSuppliers];

        console.log(`>> Combining vendors: ${sapVendors.length} SAP + ${emailVendors.length} EMAIL + ${pdaSuppliers.length} PDA = ${allVendors.length} total`);

        if (allVendors.length === 0) {
            console.log('>> No vendors found from any source');
            return [];
        }

        const scoredVendors = allVendors.map(vendor => {
            const recencyScore = calculateRecencyScore(vendor.lastPurchaseDate);
            const priceScore = calculatePriceScore(vendor.avgPrice, allVendors);
            const reliabilityScore = calculateReliabilityScore(
                vendor.totalPurchases,
                vendor.vendorSource
            );
            const volumeScore = calculateVolumeScore(vendor.totalQuantity, quantity);

            // Boost email vendors slightly if they have good response history
            const emailBoost = vendor.vendorSource === 'EMAIL' &&
                vendor.emailStats?.quotationsReceived > 0 ? 5 : 0;

            const totalScore = (
                recencyScore * 0.25 +
                priceScore * 0.35 +
                reliabilityScore * 0.25 +
                volumeScore * 0.15 +
                emailBoost
            );

            return {
                ...vendor,
                scores: {
                    recency: Math.round(recencyScore * 10) / 10,
                    price: Math.round(priceScore * 10) / 10,
                    reliability: Math.round(reliabilityScore * 10) / 10,
                    volume: Math.round(volumeScore * 10) / 10,
                    emailBoost: emailBoost,
                    total: Math.round(totalScore * 10) / 10,
                }
            };
        }).sort((a, b) => b.scores.total - a.scores.total);

        console.log(`>> Final: ${scoredVendors.length} vendors (${sapVendors.length} SAP + ${emailVendors.length} EMAIL)`);

        return scoredVendors;

    } catch (error) {
        console.error('❌ Error in analyzeHistoricalPurchasesMultiKeyword:', error);
        return [];
    }
}

function calculateRecencyScore(lastPurchaseDate) {
    const daysSinceLastPurchase = (Date.now() - new Date(lastPurchaseDate)) / (1000 * 60 * 60 * 24);
    if (daysSinceLastPurchase < 30) return 100;
    if (daysSinceLastPurchase < 90) return 85;
    if (daysSinceLastPurchase < 180) return 70;
    if (daysSinceLastPurchase < 365) return 50;
    return 30;
}

function calculatePriceScore(price, allVendors) {
    const prices = allVendors.map(v => v.avgPrice).filter(p => p > 0);
    if (prices.length === 0) return 50;

    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const range = maxPrice - minPrice;

    if (range === 0) return 100;

    // Lower price = higher score
    const score = 100 - ((price - minPrice) / range * 100);
    return Math.max(0, Math.min(100, score));
}

function calculateReliabilityScore(totalPurchases, vendorSource = 'SAP') {
    // PDA suppliers get lower baseline since they're new
    let baseAdjustment;
    if (vendorSource === 'PDA_SCRAPER') {
        baseAdjustment = 0.6; // New suppliers, less reliable
    } else if (vendorSource === 'EMAIL') {
        baseAdjustment = 0.85;
    } else {
        baseAdjustment = 1.0; // SAP vendors, most reliable
    }

    let score;
    if (totalPurchases >= 50) score = 100;
    else if (totalPurchases >= 20) score = 90;
    else if (totalPurchases >= 10) score = 75;
    else if (totalPurchases >= 5) score = 60;
    else if (totalPurchases >= 2) score = 40;
    else score = 20;

    return score * baseAdjustment;
}

function calculateVolumeScore(totalHistoricalQuantity, requestedQuantity) {
    if (!requestedQuantity || requestedQuantity === 0) return 50;

    const ratio = totalHistoricalQuantity / requestedQuantity;

    if (ratio >= 10) return 100; // Has supplied 10x what we need
    if (ratio >= 5) return 90;
    if (ratio >= 2) return 80;
    if (ratio >= 1) return 70;
    if (ratio >= 0.5) return 50;
    return 30;
}

/**
 * Create RFQ from processed data
 */
async function createRFQFromAnalysis(analysisResult, additionalData = {}) {
    const rfqData = {
        rfqNumber: '', // Will be auto-generated
        dateIssued: new Date(),
        quotationDueDate: additionalData.quotationDueDate ||
            new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days default
        deliveryBy: additionalData.deliveryBy ||
            analysisResult.parsedData.deliveryPreferences?.preferredDeliveryDate ||
            new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days default

        contactEmail: additionalData.contactEmail || 'contact@halalfoods.fr',
        contactPhone: additionalData.contactPhone || '+33 1 XX XX XX XX',
        location: 'Paris, France',

        items: analysisResult.parsedData.items.map(item => ({
            productName: item.productName,
            specifications: item.specifications,
            quantity: item.quantity,
            unit: item.unit,
        })),

        packagingRequirements: analysisResult.parsedData.specialRequirements?.packaging,
        paymentTermsPreference: additionalData.paymentTerms || '30% advance, 70% on delivery',
        otherNotes: analysisResult.parsedData.specialRequirements?.other,

        vendorsContacted: [],

        status: 'draft',
        createdBy: analysisResult.createdBy,

        // Store AI analysis metadata
        metadata: {
            originalInput: analysisResult.originalInput,
            aiInsights: analysisResult.vendorRecommendations.aiInsights,
            suggestedVendors: analysisResult.vendorRecommendations.topVendors.map(v => ({
                vendorCode: v._id,
                vendorName: v.vendorName,
                score: v.totalScore,
            })),
        },
    };

    const rfq = new RFQ(rfqData);
    await rfq.save();

    return rfq;
}
async function syncVendors() {
    try {

        // Get unique vendors from purchase history
        const uniqueVendors = await PurchaseInvoice.aggregate([
            {
                $group: {
                    _id: '$CardCode',
                    CardName: { $first: '$CardName' },
                    totalOrders: { $sum: 1 },
                    lastOrderDate: { $max: '$DocDate' }
                }
            }
        ]);

        console.log(`Found ${uniqueVendors.length} unique vendors in purchase history`);

        // Create vendor records with dummy emails (REPLACE WITH REAL ONES LATER)
        const vendorDocs = uniqueVendors.map(v => ({
            CardCode: v._id,
            CardName: v.CardName,
            email: `${v._id.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '')}@vendor.com`,
            phone: '+33 1 XX XX XX XX',
            city: 'Paris',
            country: 'France',
            productCategories: [],
            certifications: [],
            performanceMetrics: {
                totalOrders: v.totalOrders,
            },
            lastOrderDate: v.lastOrderDate,
            isActive: true,
        }));

        // Clear and insert
        await Vendor.deleteMany({});
        await Vendor.insertMany(vendorDocs);

        console.log(`✅ Synced ${vendorDocs.length} vendors to Vendor collection`);
        console.log('\n⚠️ WARNING: Dummy emails were created. Update them with real emails:');
        console.log('Example: MS FOODS LTD -> msfoodsltd@vendor.com\n');

        // Show sample vendors created
        const samples = await Vendor.find({}).limit(5);
        console.log('Sample vendors created:');
        samples.forEach(v => {
            console.log(`  - ${v.CardName} (${v.CardCode}) -> ${v.email}`);
        });


    } catch (error) {
        console.error('❌ Error syncing vendors:', error);
        process.exit(1);
    }
}

/**
 * Enrich email vendors with AI-parsed quotation data
 */
async function enrichEmailVendorsWithQuotations(emailVendors, rfqNumber) {
    if (!rfqNumber || emailVendors.length === 0) {
        return emailVendors;
    }

    try {
        console.log('>> Enriching email vendors with quotation data...');

        // Parse responses from email
        const responses = await vendorEmailService.parseRFQResponsesFromEmail(rfqNumber);

        return emailVendors.map(vendor => {
            const response = responses.find(r => r.vendorEmail === vendor.email);

            if (response && response.isValidResponse) {
                return {
                    ...vendor,
                    quotationData: {
                        totalQuoted: response.totalQuotedAmount,
                        deliveryDays: response.deliveryTimeInDays,
                        paymentTerms: response.paymentTerms,
                        items: response.quotedItems,
                        hasValidQuotation: true
                    }
                };
            }

            return vendor;
        });

    } catch (error) {
        console.error('⚠️ Error enriching email vendors:', error.message);
        return emailVendors;
    }
}

/**
 * Sync email vendors into the system
 */
async function syncEmailVendors() {
    try {
        console.log('=== Starting Email Vendor Sync ===');

        const result = await vendorEmailService.storeEmailVendorsInDB();

        console.log(`✅ Synced ${result.length} email vendors`);
        return result;

    } catch (error) {
        console.error('❌ Error syncing email vendors:', error);
        throw error;
    }
}

/**
 * Process form-based RFQ for EXISTING vendors (SAP only)
 * @param {Array<string>} itemCodes - Selected item codes from inventory
 * @param {Array<number>} quantities - Quantities for each item
 * @param {Array<number>} targetPrices - Optional target prices
 * @param {string} userId - User ID
 */
async function processFormBasedRFQ(itemCodes, quantities, targetPrices, userId) {
    console.log('=== Starting Form-Based RFQ Processing (SAP Vendors Only) ===');

    const Item = require('../models/item');

    // Fetch item details from inventory
    const items = await Item.find({ ItemCode: { $in: itemCodes } });

    if (items.length === 0) {
        throw new Error('No items found with provided item codes');
    }

    const itemsWithVendors = [];

    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const quantity = quantities[i] || 1;
        const targetPrice = targetPrices?.[i] || null;

        console.log(`\n--- Analyzing item: ${item.ItemName} (${item.ItemCode}) ---`);

        // Search ONLY SAP vendors for this item
        const keywords = [item.ItemName, item.ForeignName].filter(Boolean);

        let vendorAnalysis = await analyzeHistoricalPurchasesMultiKeyword(
            keywords,
            quantity,
            'existing' // Force SAP-only search
        );

        // Filter to ONLY SAP vendors
        vendorAnalysis = vendorAnalysis.filter(v => v.vendorSource === 'SAP');

        console.log(`Found ${vendorAnalysis.length} SAP vendors`);

        // Get full vendor details
        const sapVendorCodes = vendorAnalysis.map(v => v._id);
        const vendors = await Vendor.find({
            CardCode: { $in: sapVendorCodes },
        });

        const enrichedVendors = vendorAnalysis.map(historical => {
            const vendorDetails = vendors.find(v => v.CardCode === historical._id);
            return {
                ...historical,
                email: vendorDetails?.email,
                phone: vendorDetails?.phone,
                hasEmail: !!vendorDetails?.email,
            };
        }).filter(v => v.hasEmail);

        itemsWithVendors.push({
            itemCode: item.ItemCode,
            productName: item.ItemName,
            specifications: item.ForeignName || '',
            quantity,
            unit: item.SalesUnit || 'kg',
            targetPrice,
            vendors: enrichedVendors,
            vendorsFound: enrichedVendors.length,
        });
    }

    // Get unique SAP vendors
    const allVendorCodes = new Set();
    itemsWithVendors.forEach(item => {
        item.vendors.forEach(v => allVendorCodes.add(v._id));
    });

    console.log(`\n=== Total unique SAP vendors: ${allVendorCodes.size} ===`);

    // Consolidate vendor list
    const topVendorsAcrossItems = itemsWithVendors
        .flatMap(item => item.vendors)
        .reduce((acc, vendor) => {
            const existing = acc.find(v => v._id === vendor._id);
            if (existing) {
                existing.itemsCanSupply = (existing.itemsCanSupply || 1) + 1;
                existing.totalScore += vendor.scores.total;
                existing.avgScore = existing.totalScore / existing.itemsCanSupply;
            } else {
                acc.push({
                    ...vendor,
                    itemsCanSupply: 1,
                    totalScore: vendor.scores.total,
                    avgScore: vendor.scores.total,
                });
            }
            return acc;
        }, [])
        .sort((a, b) => {
            if (b.itemsCanSupply !== a.itemsCanSupply) {
                return b.itemsCanSupply - a.itemsCanSupply;
            }
            return b.avgScore - a.avgScore;
        });

    const rfqContext = {
        items: itemsWithVendors.map(i => ({
            productName: i.productName,
            quantity: i.quantity,
            unit: i.unit,
            targetPrice: i.targetPrice
        })),
        totalVendorsFound: allVendorCodes.size,
    };

    const aiRecommendations = topVendorsAcrossItems.length > 0
        ? await analyzeVendorRecommendations(topVendorsAcrossItems, rfqContext)
        : {
            topRecommendations: [],
            priceInsights: 'No SAP vendor history available',
            riskFactors: 'No SAP vendors found',
            suggestedVendorCount: 0,
            suggestedVendorCodes: [],
        };

    console.log('=== Form-Based RFQ Processing Complete ===\n');

    return {
        parsedData: {
            items: itemsWithVendors.map(i => ({
                itemCode: i.itemCode,
                productName: i.productName,
                specifications: i.specifications,
                quantity: i.quantity,
                unit: i.unit,
                targetPrice: i.targetPrice
            }))
        },
        itemsAnalysis: itemsWithVendors,
        vendorRecommendations: {
            total: allVendorCodes.size,
            topVendors: topVendorsAcrossItems,
            aiInsights: aiRecommendations,
        },
        createdBy: userId,
    };
}
module.exports = {
    processNaturalLanguageRFQ,
    processFormBasedRFQ,
    analyzeHistoricalPurchasesMultiKeyword,
    createRFQFromAnalysis,
    syncEmailVendors,
    enrichEmailVendorsWithQuotations,
};