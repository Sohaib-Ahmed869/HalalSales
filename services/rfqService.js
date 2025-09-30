// services/rfqService.js
const PurchaseInvoice = require('../models/Purchase');
const Vendor = require('../models/Vendor');
const RFQ = require('../models/RFQ');
const {
    parseNaturalLanguageRFQ,
    generateSearchKeywords,
    analyzeVendorRecommendations
} = require('./aiService');

/**
 * Process natural language RFQ request
 * @param {string} naturalLanguageInput - User's description of what they need
 * @returns {Object} Structured RFQ with vendor recommendations
 */
async function processNaturalLanguageRFQ(naturalLanguageInput, userId) {
    console.log('=== Starting Natural Language RFQ Processing ===');
    console.log('Input:', naturalLanguageInput);

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

        // Find vendors from historical data
        let vendorAnalysis = await analyzeHistoricalPurchasesMultiKeyword(
            keywords,
            item.quantity
        );

        console.log(`Found ${vendorAnalysis.length} vendors from initial search`);

        // If no vendors found, try broader search
        if (vendorAnalysis.length === 0) {
            console.log('⚠️ No vendors found, trying broader search...');

            // Try with just product name
            const broaderKeywords = [item.productName];
            vendorAnalysis = await analyzeHistoricalPurchasesMultiKeyword(
                broaderKeywords,
                item.quantity
            );

            console.log(`Broader search found ${vendorAnalysis.length} vendors`);

            // If still nothing, try with individual words from product name
            if (vendorAnalysis.length === 0) {
                const words = item.productName.split(' ').filter(w => w.length > 3);
                if (words.length > 0) {
                    console.log(`Trying word-by-word search: ${JSON.stringify(words)}`);
                    vendorAnalysis = await analyzeHistoricalPurchasesMultiKeyword(
                        words,
                        item.quantity
                    );
                    console.log(`Word-by-word search found ${vendorAnalysis.length} vendors`);
                }
            }
        }

        // Get full vendor details
        const vendorCodes = vendorAnalysis.map(v => v._id);
        console.log(`Looking for vendors with CardCodes: ${JSON.stringify(vendorCodes)}`);

        const vendors = await Vendor.find({
            CardCode: { $in: vendorCodes },
        });

        console.log(`Vendor.find() returned ${vendors.length} vendors`);

        // Debug: Check what's actually in Vendor collection
        const totalVendorsInDb = await Vendor.countDocuments();
        console.log(`Total vendors in Vendor collection: ${totalVendorsInDb}`);
        console.log(`Found ${vendors.length} active vendors in Vendor collection`);

        // Merge vendor data with historical analysis
        const enrichedVendors = vendorAnalysis.map(historical => {
            const vendorDetails = vendors.find(v => v.CardCode === historical._id);
            return {
                ...historical,
                email: vendorDetails?.email,
                phone: vendorDetails?.phone,
                productCategories: vendorDetails?.productCategories,
                hasEmail: !!vendorDetails?.email,
            };
        }).filter(v => v.hasEmail); // Only include vendors with emails

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
            topVendors: topVendorsAcrossItems.slice(0, 10),
            aiInsights: aiRecommendations,
        },
        createdBy: userId,
    };
}

/**
 * Analyze historical purchases with multiple keywords
 * @param {Array<string>} keywords - Search keywords
 * @param {number} quantity - Required quantity
 * @returns {Array} Scored vendor list
 */
async function analyzeHistoricalPurchasesMultiKeyword(keywords, quantity) {
    console.log(`\n>> Searching historical purchases with keywords: ${JSON.stringify(keywords)}`);

    // Handle empty keywords
    if (!keywords || keywords.length === 0) {
        console.log('⚠️ No keywords provided, returning empty results');
        return [];
    }

    // Build regex patterns for each keyword (OR condition)
    const regexPatterns = keywords.map(keyword => ({
        'DocumentLines.ItemDescription': {
            $regex: keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            $options: 'i'
        }
    }));

    try {
        const sampleDocs = await PurchaseInvoice.find({}).limit(3).lean();
        console.log('=== DATABASE SAMPLE ===');
        sampleDocs.forEach(doc => {
            console.log(`Vendor: ${doc.CardName}`);
            if (doc.DocumentLines && doc.DocumentLines.length > 0) {
                doc.DocumentLines.forEach(line => {
                    console.log(`  - Item: ${line.ItemDescription}`);
                });
            }
        });
        console.log('=== END SAMPLE ===\n');
        let historicalPurchases = await PurchaseInvoice.aggregate([
            // Stage 1: Match documents that have at least one matching line
            {
                $match: {
                    $or: regexPatterns
                }
            },
            // Stage 2: Unwind document lines
            {
                $unwind: '$DocumentLines'
            },
            // Stage 3: Match only the lines that match our keywords
            {
                $match: {
                    $or: regexPatterns
                }
            },
            // Stage 4: Group by vendor (CardCode)
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
            // Stage 5: Project only needed fields
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
                    items: { $slice: ['$items', -5] }, // Only keep last 5 items for reference
                    // ADD THIS - Map items to purchaseHistory format
                    purchaseHistory: {
                        $map: {
                            input: { $slice: ['$items', -5] },
                            as: 'item',
                            in: {
                                productName: '$$item.description',
                                quantity: '$$item.quantity',
                                unit: 'kg', // You might need to extract this from somewhere
                                price: '$$item.price',
                                total: '$$item.lineTotal',
                                date: '$$item.date',
                                poNumber: null // Not available in current structure
                            }
                        }
                    }
                }

            },
            // Stage 6: Sort by total purchases (most reliable vendors first)
            {
                $sort: { totalPurchases: -1 }
            }
        ]);

        console.log(`>> Query returned ${historicalPurchases.length} vendors`);
        historicalPurchases = historicalPurchases.map(vendor => ({
            ...vendor,
            purchaseHistory: vendor.items?.map(item => ({
                productName: item.description,
                quantity: item.quantity,
                unit: 'kg', // Default unit, adjust as needed
                price: item.price,
                total: item.lineTotal,
                date: item.date,
                poNumber: null // Not in current data structure
            })) || []
        }));
        if (historicalPurchases.length > 0) {
            console.log('>> Sample vendor data:', {
                vendor: historicalPurchases[0].vendorName,
                totalPurchases: historicalPurchases[0].totalPurchases,
                avgPrice: historicalPurchases[0].avgPrice,
                lastPurchase: historicalPurchases[0].lastPurchaseDate
            });
        }

        // Score vendors based on multiple factors
        const scoredVendors = historicalPurchases.map(vendor => {
            const recencyScore = calculateRecencyScore(vendor.lastPurchaseDate);
            const priceScore = calculatePriceScore(vendor.avgPrice, historicalPurchases);
            const reliabilityScore = calculateReliabilityScore(vendor.totalPurchases);
            const volumeScore = calculateVolumeScore(vendor.totalQuantity, quantity);

            const totalScore = (
                recencyScore * 0.25 +
                priceScore * 0.35 +
                reliabilityScore * 0.25 +
                volumeScore * 0.15
            );

            return {
                ...vendor,
                scores: {
                    recency: Math.round(recencyScore * 10) / 10,
                    price: Math.round(priceScore * 10) / 10,
                    reliability: Math.round(reliabilityScore * 10) / 10,
                    volume: Math.round(volumeScore * 10) / 10,
                    total: Math.round(totalScore * 10) / 10,
                }
            };
        }).sort((a, b) => b.scores.total - a.scores.total);

        console.log(`>> Scored and sorted ${scoredVendors.length} vendors`);

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

function calculateReliabilityScore(totalPurchases) {
    if (totalPurchases >= 50) return 100;
    if (totalPurchases >= 20) return 90;
    if (totalPurchases >= 10) return 75;
    if (totalPurchases >= 5) return 60;
    if (totalPurchases >= 2) return 40;
    return 20;
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


module.exports = {
    processNaturalLanguageRFQ,
    analyzeHistoricalPurchasesMultiKeyword,
    createRFQFromAnalysis,
};