// services/knowledgeBase.js
// Central knowledge base for AI agents — company info, product context, price intelligence

const Item = require('../models/item');
const PurchaseInvoice = require('../models/Purchase');
const Vendor = require('../models/Vendor');

/**
 * Static company knowledge — immutable facts the agent can reference
 */
const COMPANY_PROFILE = {
    name: 'Halal Food Service',
    tradingAs: 'Halal Foods',
    legalEntity: 'HALAL FOOD SERVICE SARL',
    address: '32 rue Raspail, Passage Ste Foix, 93120 La Courneuve, France',
    city: 'La Courneuve',
    country: 'France',
    region: 'Île-de-France (Greater Paris)',
    phone: '+33 1 XX XX XX XX',
    email: 'contact@halalfoods.fr',
    website: 'www.halalfoods.fr',

    description: 'Premium halal food wholesaler and distributor based in Greater Paris, France. ' +
        'We supply hundreds of retail and food-service clients across France with a curated catalog of 600+ halal-certified products.',

    stats: {
        productReferences: '600+',
        activeSuppliers: '100+',
        clientBase: 'Hundreds of retailers and restaurants across France',
    },

    certifications: [
        'Halal certified supply chain',
        'EU food safety compliance',
        'HACCP standards',
    ],

    operatingMarkets: ['France', 'Europe', 'Import from Middle East, Asia, South America, Africa'],

    // What the agent can say about the company when asked
    publicDescription: `Halal Food Service is a premium halal food wholesaler based at 32 rue Raspail, Passage Ste Foix, 93120 La Courneuve, France (Greater Paris area). We distribute over 600 product references sourced from 100+ trusted suppliers, serving hundreds of retail and food-service clients across France. We maintain strict halal certification and EU food safety compliance throughout our supply chain.`,
};

/**
 * Build the company context block for AI prompts
 */
function getCompanyContext() {
    return `
COMPANY IDENTITY — Halal Food Service:
- Legal name: ${COMPANY_PROFILE.legalEntity}
- Address: ${COMPANY_PROFILE.address}
- Location: ${COMPANY_PROFILE.region}, ${COMPANY_PROFILE.country}
- Business: Premium halal food wholesaler & distributor
- Catalog: ${COMPANY_PROFILE.stats.productReferences} product references
- Suppliers: ${COMPANY_PROFILE.stats.activeSuppliers} active suppliers
- Clients: ${COMPANY_PROFILE.stats.clientBase}
- Certifications: ${COMPANY_PROFILE.certifications.join(', ')}
- Markets: ${COMPANY_PROFILE.operatingMarkets.join(', ')}

When asked "who are you" / "where are you located" / "tell me about your company":
${COMPANY_PROFILE.publicDescription}
`.trim();
}

/**
 * Load product intelligence for specific items in an RFQ.
 * Returns price history, supplier history, and product details for negotiation context.
 *
 * @param {Array} rfqItems — items from the RFQ (productName, quantity, unit, targetPrice)
 * @returns {Object} productContext keyed by productName
 */
async function getProductContext(rfqItems) {
    const context = {};

    for (const rfqItem of rfqItems) {
        const productName = rfqItem.productName;
        const entry = {
            productName,
            targetPrice: rfqItem.targetPrice || rfqItem.estimatedPrice || null,
            quantity: rfqItem.quantity,
            unit: rfqItem.unit,
            specs: rfqItem.specifications || rfqItem.additionalInfo || null,
            catalogMatch: null,
            priceHistory: null,
            supplierHistory: null,
            marketIntel: null,
        };

        // 1. Find matching product in our catalog (Item model)
        try {
            const escapedName = productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const catalogItem = await Item.findOne({
                Valid: 'tYES',
                $or: [
                    { ItemName: { $regex: escapedName, $options: 'i' } },
                    { ForeignName: { $regex: escapedName, $options: 'i' } },
                    { ItemCode: productName },
                ],
            }).select('ItemCode ItemName ForeignName SalesUnit PurchaseUnit Mainsupplier MovingAveragePrice AvgStdPrice ItemPrices ItemsGroupCode U_SubCategory U_cat_lev_2');

            if (catalogItem) {
                // Get the best available price from price lists
                const prices = (catalogItem.ItemPrices || [])
                    .filter(p => p.Price > 0)
                    .map(p => ({ list: p.PriceList, price: p.Price, currency: p.Currency }));

                entry.catalogMatch = {
                    itemCode: catalogItem.ItemCode,
                    itemName: catalogItem.ItemName,
                    foreignName: catalogItem.ForeignName,
                    salesUnit: catalogItem.SalesUnit,
                    purchaseUnit: catalogItem.PurchaseUnit,
                    mainSupplier: catalogItem.Mainsupplier,
                    movingAvgPrice: catalogItem.MovingAveragePrice,
                    avgStdPrice: catalogItem.AvgStdPrice,
                    category: catalogItem.U_SubCategory || catalogItem.U_cat_lev_2 || null,
                    priceLists: prices.slice(0, 3), // Top 3 price lists
                };
            }
        } catch (err) {
            // Non-critical — continue without catalog data
        }

        // 2. Get purchase price history for this product (last 12 months)
        try {
            const oneYearAgo = new Date();
            oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

            const escapedName = productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const priceHistory = await PurchaseInvoice.aggregate([
                {
                    $match: {
                        DocDate: { $gte: oneYearAgo },
                        'DocumentLines.ItemDescription': { $regex: escapedName, $options: 'i' },
                    },
                },
                { $unwind: '$DocumentLines' },
                {
                    $match: {
                        'DocumentLines.ItemDescription': { $regex: escapedName, $options: 'i' },
                    },
                },
                {
                    $group: {
                        _id: null,
                        avgPrice: { $avg: '$DocumentLines.Price' },
                        minPrice: { $min: '$DocumentLines.Price' },
                        maxPrice: { $max: '$DocumentLines.Price' },
                        lastPrice: { $last: '$DocumentLines.Price' },
                        lastDate: { $max: '$DocDate' },
                        totalPurchases: { $sum: 1 },
                        totalQuantity: { $sum: '$DocumentLines.Quantity' },
                        currencies: { $addToSet: '$DocumentLines.Currency' },
                    },
                },
            ]);

            if (priceHistory.length > 0) {
                const ph = priceHistory[0];
                entry.priceHistory = {
                    avgPrice: Math.round(ph.avgPrice * 100) / 100,
                    minPrice: Math.round(ph.minPrice * 100) / 100,
                    maxPrice: Math.round(ph.maxPrice * 100) / 100,
                    lastPrice: Math.round(ph.lastPrice * 100) / 100,
                    lastPurchaseDate: ph.lastDate,
                    totalPurchases: ph.totalPurchases,
                    totalQuantity: Math.round(ph.totalQuantity),
                    currency: ph.currencies?.[0] || 'EUR',
                    period: '12 months',
                };
            }
        } catch (err) {
            // Non-critical
        }

        // 3. Get supplier history for this product (who supplied it and at what prices)
        try {
            const escapedName = productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const supplierHistory = await PurchaseInvoice.aggregate([
                {
                    $match: {
                        'DocumentLines.ItemDescription': { $regex: escapedName, $options: 'i' },
                    },
                },
                { $unwind: '$DocumentLines' },
                {
                    $match: {
                        'DocumentLines.ItemDescription': { $regex: escapedName, $options: 'i' },
                    },
                },
                {
                    $group: {
                        _id: '$CardCode',
                        vendorName: { $first: '$CardName' },
                        avgPrice: { $avg: '$DocumentLines.Price' },
                        minPrice: { $min: '$DocumentLines.Price' },
                        orders: { $sum: 1 },
                        lastOrder: { $max: '$DocDate' },
                    },
                },
                { $sort: { orders: -1 } },
                { $limit: 5 },
            ]);

            if (supplierHistory.length > 0) {
                entry.supplierHistory = supplierHistory.map(s => ({
                    vendorCode: s._id,
                    vendorName: s.vendorName,
                    avgPrice: Math.round(s.avgPrice * 100) / 100,
                    bestPrice: Math.round(s.minPrice * 100) / 100,
                    orderCount: s.orders,
                    lastOrder: s.lastOrder,
                }));
            }
        } catch (err) {
            // Non-critical
        }

        // 4. Build market intelligence summary
        if (entry.priceHistory || entry.catalogMatch) {
            const refPrice = entry.priceHistory?.avgPrice || entry.catalogMatch?.movingAvgPrice || entry.catalogMatch?.avgStdPrice;
            if (refPrice && entry.targetPrice) {
                const targetVsMarket = ((entry.targetPrice - refPrice) / refPrice * 100).toFixed(1);
                entry.marketIntel = {
                    referencePrice: refPrice,
                    targetVsReference: `${targetVsMarket}%`,
                    isTargetRealistic: Math.abs(parseFloat(targetVsMarket)) < 25,
                    note: parseFloat(targetVsMarket) < -20
                        ? 'Target is significantly below historical average — may be difficult to achieve'
                        : parseFloat(targetVsMarket) > 10
                            ? 'Target is above historical average — should be easily achievable'
                            : 'Target is within reasonable market range',
                };
            }
        }

        context[productName] = entry;
    }

    return context;
}

/**
 * Format product context into a readable string for AI prompts
 */
function formatProductContextForPrompt(productContext) {
    const lines = [];

    for (const [productName, ctx] of Object.entries(productContext)) {
        lines.push(`\n--- ${productName} ---`);
        lines.push(`  Target Price: ${ctx.targetPrice || 'N/A'} per ${ctx.unit}`);
        lines.push(`  Requested Qty: ${ctx.quantity} ${ctx.unit}`);

        if (ctx.specs) {
            lines.push(`  Specifications: ${ctx.specs}`);
        }

        if (ctx.catalogMatch) {
            lines.push(`  Catalog: ${ctx.catalogMatch.itemCode} | ${ctx.catalogMatch.itemName}`);
            if (ctx.catalogMatch.movingAvgPrice > 0) {
                lines.push(`  Our Avg Cost: ${ctx.catalogMatch.movingAvgPrice} (moving average)`);
            }
            if (ctx.catalogMatch.mainSupplier) {
                lines.push(`  Main Supplier: ${ctx.catalogMatch.mainSupplier}`);
            }
        }

        if (ctx.priceHistory) {
            const ph = ctx.priceHistory;
            lines.push(`  Price History (${ph.period}): avg ${ph.avgPrice}, min ${ph.minPrice}, max ${ph.maxPrice}, last ${ph.lastPrice} ${ph.currency}`);
            lines.push(`  Purchase Volume: ${ph.totalPurchases} orders, ${ph.totalQuantity} ${ctx.unit} total`);
        }

        if (ctx.supplierHistory && ctx.supplierHistory.length > 0) {
            lines.push(`  Previous Suppliers:`);
            for (const s of ctx.supplierHistory.slice(0, 3)) {
                lines.push(`    - ${s.vendorName}: avg ${s.avgPrice}, best ${s.bestPrice} (${s.orderCount} orders)`);
            }
        }

        if (ctx.marketIntel) {
            lines.push(`  Market Intel: Reference price ${ctx.marketIntel.referencePrice}, target is ${ctx.marketIntel.targetVsReference} vs reference`);
            lines.push(`  Assessment: ${ctx.marketIntel.note}`);
        }
    }

    return lines.join('\n');
}

/**
 * Build a per-item negotiation analysis comparing quoted prices to targets + history
 */
function buildNegotiationAnalysis(rfqItems, quotedItems, productContext) {
    const analysis = [];

    for (const rfqItem of rfqItems) {
        const ctx = productContext[rfqItem.productName] || {};
        const targetPrice = rfqItem.targetPrice || rfqItem.estimatedPrice || null;

        // Try to find matching quoted item
        const quoted = (quotedItems || []).find(q => {
            const qName = (q.productName || '').toLowerCase();
            const rName = (rfqItem.productName || '').toLowerCase();
            return qName.includes(rName) || rName.includes(qName) ||
                qName.replace(/[^a-z0-9]/g, '').includes(rName.replace(/[^a-z0-9]/g, ''));
        });

        const itemAnalysis = {
            productName: rfqItem.productName,
            requestedQty: rfqItem.quantity,
            unit: rfqItem.unit,
            targetPrice,
            quotedPrice: quoted?.unitPrice || quoted?.totalPrice || null,
            currency: quoted?.currency || 'EUR',
            historicalAvg: ctx.priceHistory?.avgPrice || ctx.catalogMatch?.movingAvgPrice || null,
            historicalMin: ctx.priceHistory?.minPrice || null,
            status: 'not_quoted',
            gapPercent: null,
            recommendation: null,
        };

        if (itemAnalysis.quotedPrice && targetPrice) {
            const gap = ((itemAnalysis.quotedPrice - targetPrice) / targetPrice * 100);
            itemAnalysis.gapPercent = Math.round(gap * 10) / 10;

            if (gap <= 0) {
                itemAnalysis.status = 'at_or_below_target';
                itemAnalysis.recommendation = 'ACCEPT — price meets or beats target';
            } else if (gap <= 5) {
                itemAnalysis.status = 'slightly_above';
                itemAnalysis.recommendation = 'ACCEPT or LIGHT COUNTER — only ' + itemAnalysis.gapPercent + '% above target, may not be worth negotiating';
            } else if (gap <= 15) {
                itemAnalysis.status = 'above_target';
                itemAnalysis.recommendation = 'COUNTER — ' + itemAnalysis.gapPercent + '% above target, room to negotiate';
            } else if (gap <= 30) {
                itemAnalysis.status = 'significantly_above';
                itemAnalysis.recommendation = 'STRONG COUNTER — ' + itemAnalysis.gapPercent + '% above target, significant gap';
            } else {
                itemAnalysis.status = 'far_above';
                itemAnalysis.recommendation = 'CONSIDER REJECT — ' + itemAnalysis.gapPercent + '% above target, may not be viable';
            }

            // Cross-reference with historical
            if (itemAnalysis.historicalAvg && itemAnalysis.quotedPrice > itemAnalysis.historicalAvg * 1.2) {
                itemAnalysis.recommendation += ' | WARNING: Quoted price is >20% above our historical average purchase price';
            }
        } else if (!itemAnalysis.quotedPrice) {
            itemAnalysis.status = 'not_quoted';
            itemAnalysis.recommendation = 'MISSING — vendor did not quote this item, request pricing';
        }

        analysis.push(itemAnalysis);
    }

    return analysis;
}

/**
 * Format the negotiation analysis into a readable prompt section
 */
function formatNegotiationAnalysis(analysis) {
    const lines = ['PER-ITEM NEGOTIATION ANALYSIS:'];

    let allAcceptable = true;
    let anyMissing = false;

    for (const item of analysis) {
        const icon = item.status === 'at_or_below_target' ? '✅' :
            item.status === 'slightly_above' ? '🟡' :
                item.status === 'above_target' ? '🟠' :
                    item.status === 'significantly_above' ? '🔴' :
                        item.status === 'far_above' ? '⛔' : '❓';

        lines.push(`${icon} ${item.productName}:`);
        lines.push(`   Quoted: ${item.quotedPrice || 'NOT QUOTED'} ${item.currency} | Target: ${item.targetPrice} | Gap: ${item.gapPercent !== null ? item.gapPercent + '%' : 'N/A'}`);
        if (item.historicalAvg) {
            lines.push(`   Historical avg: ${item.historicalAvg} ${item.currency}`);
        }
        lines.push(`   → ${item.recommendation}`);

        if (!['at_or_below_target', 'slightly_above'].includes(item.status)) {
            allAcceptable = false;
        }
        if (item.status === 'not_quoted') anyMissing = true;
    }

    lines.push('');
    if (allAcceptable && !anyMissing) {
        lines.push('OVERALL: All items at or near target — RECOMMEND ACCEPT');
    } else if (anyMissing) {
        lines.push('OVERALL: Some items missing — REQUEST COMPLETE QUOTATION before negotiating');
    } else {
        const aboveCount = analysis.filter(a => !['at_or_below_target', 'slightly_above', 'not_quoted'].includes(a.status)).length;
        const totalQuoted = analysis.filter(a => a.status !== 'not_quoted').length;
        lines.push(`OVERALL: ${aboveCount}/${totalQuoted} items above target — RECOMMEND COUNTER on specific items`);
    }

    return lines.join('\n');
}

module.exports = {
    COMPANY_PROFILE,
    getCompanyContext,
    getProductContext,
    formatProductContextForPrompt,
    buildNegotiationAnalysis,
    formatNegotiationAnalysis,
};
