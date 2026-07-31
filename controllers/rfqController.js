// controllers/rfqController.js
const RFQ = require('../models/RFQ');
const Vendor = require('../models/Vendor');
const {
    processNaturalLanguageRFQ,
    createRFQFromAnalysis
} = require('../services/rfqService');
const { generateRFQEmail } = require('../services/aiService');
const { sendEmail } = require('../utils/emailService');
const { generateRFQPDF } = require('../utils/pdfGenerator1');
const { processFormBasedRFQ, processFormBasedRFQForNewSuppliers } = require('../services/rfqService');
const { sendRFQViaWhatsApp } = require('../services/whatsappService');
const { RFQ_CONTACT_EMAIL } = require('../config/config');
/**
 * Get items from inventory for form selection
 * GET /api/rfq/items
 */
exports.getInventoryItems = async (req, res) => {
    try {
        const { search, limit = 20000 } = req.query;
        const Item = require('../models/item');
        const { buildBilingualQuery } = require('../utils/bilingualFoodGlossary');

        const query = {
            Valid: 'tYES',
            PurchaseItem: 'tYES'
        };

        if (search) {
            // Bilingual expansion: "chicken" → matches "Poulet de Filet" via the FR↔EN food glossary.
            // Every query token must match at least one synonym somewhere in ItemName/ForeignName/ItemCode.
            Object.assign(
                query,
                buildBilingualQuery(search, ['ItemName', 'ForeignName', 'ItemCode'])
            );
        }

        const items = await Item.find(query)
            .select('ItemCode ItemName ForeignName SalesUnit QuantityOnStock')
            .limit(parseInt(limit))
            .sort({ ItemName: 1 });

        res.json({
            success: true,
            data: items
        });
    } catch (error) {
        console.error('Error fetching items:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
};
/**
 * Get product recommendations based on a selected product
 * GET /api/rfq/recommend-products
 */
exports.getProductRecommendations = async (req, res) => {
    try {
        const { productName, limit = 20 } = req.query;

        if (!productName || productName.trim().length === 0) {
            return res.status(400).json({
                success: false,
                error: 'productName query parameter is required',
            });
        }

        const Item = require('../models/item');
        const PurchaseInvoice = require('../models/Purchase');

        // Strategy 1: Find items from the same suppliers (purchase history)
        // First find which vendors supply this product
        const supplierMatches = await PurchaseInvoice.aggregate([
            {
                $match: {
                    'DocumentLines.ItemDescription': {
                        $regex: productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                        $options: 'i',
                    },
                },
            },
            { $group: { _id: '$CardCode', vendorName: { $first: '$CardName' } } },
            { $limit: 10 },
        ]);

        const supplierCodes = supplierMatches.map(s => s._id);

        let relatedFromSuppliers = [];
        if (supplierCodes.length > 0) {
            // Find other products from the same suppliers
            const otherProducts = await PurchaseInvoice.aggregate([
                { $match: { CardCode: { $in: supplierCodes } } },
                { $unwind: '$DocumentLines' },
                {
                    $group: {
                        _id: '$DocumentLines.ItemCode',
                        itemName: { $first: '$DocumentLines.ItemDescription' },
                        frequency: { $sum: 1 },
                    },
                },
                { $sort: { frequency: -1 } },
                { $limit: parseInt(limit) },
            ]);

            relatedFromSuppliers = otherProducts.map(p => ({
                ItemCode: p._id,
                ItemName: p.itemName,
                source: 'same_supplier',
                frequency: p.frequency,
            }));
        }

        // Strategy 2: Find items with similar names (brand family)
        // Extract brand keywords (e.g., "Pepsi" from "Pepsi 1.5L")
        const brandKeywords = productName.split(/\s+/).filter(w => w.length > 2 && !/^\d/.test(w));
        const brandRegex = brandKeywords.length > 0
            ? new RegExp(brandKeywords.join('|'), 'i')
            : new RegExp(productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

        const similarItems = await Item.find({
            Valid: 'tYES',
            PurchaseItem: 'tYES',
            $or: [
                { ItemName: { $regex: brandRegex } },
                { ForeignName: { $regex: brandRegex } },
            ],
        })
            .select('ItemCode ItemName ForeignName SalesUnit')
            .limit(parseInt(limit))
            .sort({ ItemName: 1 });

        // Merge and deduplicate
        const seen = new Set();
        const recommendations = [];

        for (const item of similarItems) {
            if (!seen.has(item.ItemCode)) {
                seen.add(item.ItemCode);
                recommendations.push({
                    ItemCode: item.ItemCode,
                    ItemName: item.ItemName,
                    ForeignName: item.ForeignName,
                    SalesUnit: item.SalesUnit,
                    source: 'brand_match',
                });
            }
        }

        for (const item of relatedFromSuppliers) {
            if (!seen.has(item.ItemCode)) {
                seen.add(item.ItemCode);
                recommendations.push({
                    ItemCode: item.ItemCode,
                    ItemName: item.ItemName,
                    source: item.source,
                });
            }
        }

        res.json({
            success: true,
            data: {
                searchedFor: productName,
                brandKeywords,
                suppliersFound: supplierMatches.length,
                recommendations: recommendations.slice(0, parseInt(limit)),
            },
        });
    } catch (error) {
        console.error('Error getting product recommendations:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
};

/**
 * Step 1: Process natural language input and get vendor recommendations
 * POST /api/rfq/analyze
 */
exports.analyzeRFQRequest = async (req, res) => {
    try {
        const { searchMode = 'existing', itemCodes, quantities, targetPrices, customItems = [] } = req.body;
        const userId = req.user?.id || 'admin';

        const hasInventoryItems = Array.isArray(itemCodes) && itemCodes.length > 0;
        const hasCustomItems = Array.isArray(customItems) && customItems.length > 0;

        // Shared custom-item validation — every custom item must have productName + quantity + targetPrice > 0
        if (hasCustomItems) {
            const bad = customItems.some(ci =>
                !ci || !String(ci.productName || '').trim() ||
                !(ci.quantity > 0) ||
                !(ci.targetPrice > 0)
            );
            if (bad) {
                return res.status(400).json({
                    success: false,
                    error: 'Every custom product needs a product name, quantity > 0, and target price > 0.',
                });
            }
        }

        // For EXISTING vendors: Use form-based input (inventory items and/or custom products)
        if (searchMode === 'existing') {
            if (!hasInventoryItems && !hasCustomItems) {
                return res.status(400).json({
                    success: false,
                    error: 'Provide either inventory itemCodes or customItems for existing vendor search',
                });
            }

            // Validate target prices for inventory items
            if (hasInventoryItems) {
                if (!targetPrices || targetPrices.length !== itemCodes.length || targetPrices.some(p => p === null || p === undefined || p <= 0)) {
                    return res.status(400).json({
                        success: false,
                        error: 'Target prices are required for each item. Every item must have a positive target price.',
                    });
                }
            }

            console.log(`Processing EXISTING vendor search — inventory: ${itemCodes?.length || 0}, custom: ${customItems.length}`);

            const analysis = await processFormBasedRFQ(
                itemCodes || [],
                quantities || [],
                targetPrices || [],
                userId,
                req.body.additionalInfos || [],
                customItems
            );

            res.json({
                success: true,
                message: 'RFQ analyzed for existing vendors (SAP)',
                data: analysis,
            });
        }
        // For NEW suppliers (Web / Email vendors): accept form input (inventory or custom) OR NL
        else if (searchMode === 'new') {
            const { naturalLanguageInput, additionalInfos } = req.body;
            const hasForm = hasInventoryItems || hasCustomItems;
            const hasNL = typeof naturalLanguageInput === 'string' && naturalLanguageInput.trim().length > 0;

            if (!hasForm && !hasNL) {
                return res.status(400).json({
                    success: false,
                    error: 'Provide inventory itemCodes, customItems, or naturalLanguageInput for new supplier search',
                });
            }

            let analysis;
            if (hasForm) {
                // Validate target prices for inventory items
                if (hasInventoryItems) {
                    if (!targetPrices || targetPrices.length !== itemCodes.length || targetPrices.some(p => p === null || p === undefined || p <= 0)) {
                        return res.status(400).json({
                            success: false,
                            error: 'Target prices are required for each item. Every item must have a positive target price.',
                        });
                    }
                }
                console.log(`Processing NEW (web/email) supplier search — inventory: ${itemCodes?.length || 0}, custom: ${customItems.length}`);
                analysis = await processFormBasedRFQForNewSuppliers(
                    itemCodes || [], quantities || [], targetPrices || [], userId, additionalInfos || [], customItems
                );
            } else {
                console.log(`Processing NEW supplier search with:`, naturalLanguageInput);
                analysis = await processNaturalLanguageRFQ(naturalLanguageInput, userId, 'new');
            }

            res.json({
                success: true,
                message: 'New suppliers found (Email + PDA)',
                data: {
                    ...analysis,
                    vendorTypeCounts: {
                        email: analysis.vendorRecommendations.topVendors.filter(v => v.vendorSource === 'EMAIL').length,
                        pda: analysis.vendorRecommendations.topVendors.filter(v => v.vendorSource === 'PDA_SCRAPER').length,
                        total: analysis.vendorRecommendations.total
                    }
                },
            });
        }
        // For uploaded NEW SUPPLIERS DATABASE: form OR natural language + match to uploaded supplier DB
        else if (searchMode === 'new_suppliers') {
            const {
                naturalLanguageInput,
                additionalInfos,
                // NEW: suppliers the admin wants to always include (IDs from the DB,
                // e.g., just-uploaded or searched-from-DB suppliers)
                forceIncludeSupplierIds = [],
            } = req.body;

            const NewSupplier = require('../models/NewSupplier');
            const hasFormItems = hasInventoryItems || hasCustomItems;

            // Build parsed items — form input (inventory + custom) or NL parsing
            let parsedData;
            if (hasFormItems) {
                const formAnalysis = await processFormBasedRFQ(
                    itemCodes || [], quantities || [], targetPrices || [],
                    userId, additionalInfos || [], customItems
                );
                parsedData = formAnalysis.parsedData;
            } else if (naturalLanguageInput && naturalLanguageInput.trim().length > 0) {
                const { parseNaturalLanguageRFQ } = require('../services/aiService');
                const parsedRFQ = await parseNaturalLanguageRFQ(naturalLanguageInput);
                if (!parsedRFQ.success) {
                    return res.status(400).json({ success: false, error: 'Failed to parse RFQ request' });
                }
                parsedData = parsedRFQ.data;
            } else {
                return res.status(400).json({
                    success: false,
                    error: 'Provide inventory itemCodes, customItems, or naturalLanguageInput for new_suppliers mode',
                });
            }

            console.log(`Processing NEW SUPPLIERS DB search — items: ${parsedData.items?.length}, forceInclude: ${forceIncludeSupplierIds.length}`);

            // Collect product terms for matching
            const allProductTerms = (parsedData.items || [])
                .flatMap(it => [it.productName, ...(it.searchKeywords || [])])
                .filter(Boolean)
                .map(s => s.toString().trim());

            // 1) Fetch matched suppliers by product
            let matchedSuppliers = [];
            if (allProductTerms.length) {
                const productRegexes = allProductTerms.map(p => new RegExp(p, 'i'));
                const suppliers = await NewSupplier.find({
                    isActive: true,
                    $or: [
                        { productCategories: { $in: productRegexes } },
                        { notes: { $in: productRegexes } },
                        { supplierName: { $in: productRegexes } },
                        { companyName: { $in: productRegexes } },
                    ],
                }).lean();

                matchedSuppliers = suppliers.map(s => {
                    const haystack = [
                        ...(s.productCategories || []),
                        s.supplierName, s.companyName, s.notes,
                    ].join(' ').toLowerCase();

                    const itemsCanSupply = (parsedData.items || []).filter(item => {
                        const terms = [item.productName, ...(item.searchKeywords || [])].filter(Boolean);
                        return terms.some(t => haystack.includes(t.toLowerCase()));
                    }).length;

                    return {
                        _id: s._id.toString(),
                        vendorName: s.supplierName,
                        companyName: s.companyName,
                        email: s.email,
                        phone: s.phone,
                        country: s.country,
                        productCategories: s.productCategories,
                        vendorSource: 'NEW_SUPPLIER',
                        itemsCanSupply,
                        hasEmail: !!s.email,
                        isForceIncluded: false,
                        stats: s.stats,
                        avgScore: itemsCanSupply + (s.stats?.totalResponses / (s.stats?.totalRFQsSent || 1)) * 0.5,
                    };
                })
                .filter(s => s.hasEmail && s.itemsCanSupply > 0)
                .sort((a, b) => b.avgScore - a.avgScore || b.itemsCanSupply - a.itemsCanSupply);
            }

            // 2) Force-include suppliers (always shown regardless of product match)
            const matchedIds = new Set(matchedSuppliers.map(s => s._id));
            const toFetchForceIds = (forceIncludeSupplierIds || [])
                .filter(id => id && /^[0-9a-fA-F]{24}$/.test(id) && !matchedIds.has(id));

            let forceIncluded = [];
            if (toFetchForceIds.length > 0) {
                const forceSuppliers = await NewSupplier.find({
                    _id: { $in: toFetchForceIds },
                    isActive: true,
                }).lean();

                forceIncluded = forceSuppliers.map(s => ({
                    _id: s._id.toString(),
                    vendorName: s.supplierName,
                    companyName: s.companyName,
                    email: s.email,
                    phone: s.phone,
                    country: s.country,
                    productCategories: s.productCategories,
                    vendorSource: 'NEW_SUPPLIER',
                    itemsCanSupply: 0,
                    hasEmail: !!s.email,
                    isForceIncluded: true,
                    stats: s.stats,
                    avgScore: 0.5, // low score, but still shown
                }));
            }

            // Also flag already-matched suppliers that were in force list
            matchedSuppliers.forEach(s => {
                if ((forceIncludeSupplierIds || []).includes(s._id)) s.isForceIncluded = true;
            });

            const allSuppliers = [...forceIncluded, ...matchedSuppliers];

            return res.json({
                success: true,
                message: `${allSuppliers.length} suppliers available for this RFQ (${matchedSuppliers.length} matched, ${forceIncluded.length} force-included)`,
                data: {
                    parsedData,
                    vendorRecommendations: {
                        topVendors: allSuppliers,
                        total: allSuppliers.length,
                    },
                    vendorTypeCounts: {
                        newSupplier: allSuppliers.length,
                        matched: matchedSuppliers.length,
                        forceIncluded: forceIncluded.length,
                        total: allSuppliers.length,
                    },
                },
            });
        } else {
            return res.status(400).json({
                success: false,
                error: 'Invalid searchMode. Use "existing", "new", or "new_suppliers"',
            });
        }
    } catch (error) {
        console.error('Error analyzing RFQ:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
};

/**
 * Step 2: Create RFQ draft
 * POST /api/rfq/create
 */
exports.createRFQDraft = async (req, res) => {
    try {
        const {
            naturalLanguageInput,
            selectedVendorCodes,
            quotationDueDate,
            deliveryBy,
            contactEmail,
            contactPhone,
            paymentTerms,
            searchMode = 'existing',
            itemCodes,
            quantities,
            targetPrices,
            additionalInfos, // per-item additional info array
            customItems = [],
            incoterm,
            destination,
        } = req.body;

        const userId = req.user?.id || 'admin';

        let analysis;

        // DETERMINE WHICH PROCESSING METHOD TO USE
        const hasItemCodes = Array.isArray(itemCodes) && itemCodes.length > 0;
        const hasCustom = Array.isArray(customItems) && customItems.length > 0;
        const hasForm = hasItemCodes || hasCustom;
        const hasNL = typeof naturalLanguageInput === 'string' && naturalLanguageInput.trim().length > 0;

        if (searchMode === 'existing' && hasForm) {
            // FORM-BASED RFQ (Existing vendors) — inventory + custom products
            console.log('Creating RFQ from form-based analysis (existing vendors)');

            analysis = await processFormBasedRFQ(
                itemCodes || [],
                quantities || [],
                targetPrices || [],
                userId,
                additionalInfos || [],
                customItems
            );
        } else if (searchMode === 'new' && hasForm) {
            // FORM-BASED RFQ (Web / Email vendors) — inventory + custom products
            console.log('Creating RFQ from form-based analysis (new / web-email vendors)');
            analysis = await processFormBasedRFQForNewSuppliers(
                itemCodes || [],
                quantities || [],
                targetPrices || [],
                userId,
                additionalInfos || [],
                customItems
            );
        } else if (searchMode === 'new_suppliers' && hasForm) {
            // NEW SUPPLIERS DB RFQ — form input (inventory + custom). Parse items from the form
            // but skip SAP vendor scoring — the vendors come from the NewSupplier DB /
            // force-include list passed via selectedVendorCodes.
            console.log('Creating RFQ from form-based analysis for NEW SUPPLIERS DB mode');
            const formAnalysis = await processFormBasedRFQ(
                itemCodes || [],
                quantities || [],
                targetPrices || [],
                userId,
                additionalInfos || [],
                customItems
            );
            analysis = {
                parsedData: formAnalysis.parsedData,
                vendorRecommendations: { topVendors: [], total: 0, aiInsights: null },
                createdBy: userId,
            };
        } else if (searchMode === 'new_suppliers' && hasNL) {
            // NEW SUPPLIERS DB RFQ — natural-language fallback
            console.log('Creating RFQ from natural language for NEW SUPPLIERS DB mode');
            const { parseNaturalLanguageRFQ } = require('../services/aiService');
            const parsedRFQ = await parseNaturalLanguageRFQ(naturalLanguageInput);
            if (!parsedRFQ.success) {
                return res.status(400).json({ success: false, error: 'Failed to parse RFQ request' });
            }
            analysis = {
                parsedData: parsedRFQ.data,
                vendorRecommendations: { topVendors: [], total: 0, aiInsights: null },
                createdBy: userId,
                originalInput: naturalLanguageInput,
            };
        } else if (hasNL) {
            // NATURAL LANGUAGE RFQ (Web/email search for new vendors, etc.)
            console.log('Creating RFQ from natural language analysis');

            analysis = await processNaturalLanguageRFQ(
                naturalLanguageInput,
                userId,
                searchMode
            );
        } else {
            return res.status(400).json({
                success: false,
                error: 'Provide inventory itemCodes, customItems (with productName/quantity/targetPrice), or naturalLanguageInput'
            });
        }

        // Validate that we have items
        if (!analysis.parsedData?.items || analysis.parsedData.items.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No items could be parsed from the input. Please check your request.'
            });
        }

        // Create RFQ
        const rfq = await createRFQFromAnalysis(analysis, {
            quotationDueDate: quotationDueDate ? new Date(quotationDueDate) : undefined,
            deliveryBy: deliveryBy ? new Date(deliveryBy) : undefined,
            contactEmail,
            contactPhone,
            paymentTerms,
            incoterm,
            destination,
        });

        // Add selected vendors to vendorsContacted list
        if (selectedVendorCodes && selectedVendorCodes.length > 0) {
            // STEP 1: Separate vendor codes by type
            // ObjectIds can be PDA_Supplier OR NewSupplier — we disambiguate by querying both
            const objectIdCodes = selectedVendorCodes.filter(code =>
                /^[0-9a-fA-F]{24}$/.test(code)
            );

            const sapVendorCodes = selectedVendorCodes.filter(code =>
                !/^[0-9a-fA-F]{24}$/.test(code)
            );

            console.log(`Fetching vendors: ${sapVendorCodes.length} SAP/EMAIL, ${objectIdCodes.length} ObjectId-based`);

            // STEP 2: Fetch SAP/EMAIL vendors
            const vendors = await Vendor.find({
                CardCode: { $in: sapVendorCodes }
            });

            console.log(`Found ${vendors.length} SAP/EMAIL vendors`);

            // STEP 3: Fetch ObjectId-based suppliers (PDA_Supplier OR NewSupplier)
            let pdaSuppliers = [];
            let newSuppliers = [];
            if (objectIdCodes.length > 0) {
                const PDA_Supplier = require('../models/PDA_Supplier');
                const NewSupplier = require('../models/NewSupplier');
                [pdaSuppliers, newSuppliers] = await Promise.all([
                    PDA_Supplier.find({ _id: { $in: objectIdCodes } }),
                    NewSupplier.find({ _id: { $in: objectIdCodes } }),
                ]);
                console.log(`Found ${pdaSuppliers.length} PDA suppliers, ${newSuppliers.length} new suppliers`);
            }

            // STEP 4: Convert each source to unified vendor format
            const pdaSuppliersAsVendors = pdaSuppliers.map(s => ({
                CardCode: s._id.toString(),
                CardName: s.supplierName,
                email: s.email,
                phone: s.contactInfo?.phone,
                vendorSource: 'PDA_SCRAPER',
            }));

            const newSuppliersAsVendors = newSuppliers.map(s => ({
                CardCode: s._id.toString(),
                CardName: s.supplierName,
                email: s.email,
                phone: s.phone,
                vendorSource: 'NEW_SUPPLIER',
            }));

            // STEP 5: Combine all vendors and mark their source
            const allSelectedVendors = [
                ...vendors.map(v => ({
                    CardCode: v.CardCode,
                    CardName: v.CardName,
                    email: v.email,
                    phone: v.phone,
                    vendorSource: v.customFields?.isEmailVendor ? 'EMAIL' : 'SAP'
                })),
                ...pdaSuppliersAsVendors,
                ...newSuppliersAsVendors,
            ];

            console.log(`Total vendors to contact: ${allSelectedVendors.length}`);

            // STEP 6: Add to RFQ
            rfq.vendorsContacted = allSelectedVendors.map(v => ({
                vendorCode: v.CardCode,
                vendorName: v.CardName,
                email: v.email,
                phone: v.phone,
                status: 'draft',
                vendorSource: v.vendorSource,
            }));

            await rfq.save();

            // STEP 7: Update NewSupplier stats (totalRFQsSent, lastRFQSentAt)
            if (newSuppliers.length > 0) {
                const NewSupplier = require('../models/NewSupplier');
                await NewSupplier.updateMany(
                    { _id: { $in: newSuppliers.map(s => s._id) } },
                    {
                        $inc: { "stats.totalRFQsSent": 1 },
                        $set: { "stats.lastRFQSentAt": new Date() },
                    }
                );
            }
        }

        res.json({
            success: true,
            message: 'RFQ draft created successfully',
            data: {
                rfq: rfq.toObject(),
            },
        });
    } catch (error) {
        console.error('Error creating RFQ:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
};

/**
 * Step 3: Send RFQ to vendors using Gmail
 * POST /api/rfq/:rfqId/send
 */
exports.sendRFQToVendors = async (req, res) => {
    try {
        const { rfqId } = req.params;
        const { vendorCodes, customMessage, language = 'fr', sendVia = 'email' } = req.body;

        console.log(`Sending RFQ ${rfqId} to vendors:`, vendorCodes);
        console.log(`Send method: ${sendVia}`); // ADD LOG

        const rfq = await RFQ.findById(rfqId);

        if (!rfq) {
            return res.status(404).json({
                success: false,
                error: 'RFQ not found',
            });
        }

        // STEP 1: Separate vendor codes by type
        const pdaSupplierIds = vendorCodes.filter(code =>
            /^[0-9a-fA-F]{24}$/.test(code)
        );

        const sapVendorCodes = vendorCodes.filter(code =>
            !/^[0-9a-fA-F]{24}$/.test(code)
        );

        console.log(`Sending to: ${sapVendorCodes.length} SAP/EMAIL vendors, ${pdaSupplierIds.length} PDA suppliers`);

        // STEP 2: Fetch SAP/EMAIL vendors
        const vendors = await Vendor.find({
            CardCode: { $in: sapVendorCodes },
        });

        console.log(`Found ${vendors.length} SAP/EMAIL vendors`);

        // STEP 3: Fetch PDA suppliers
        let pdaSuppliers = [];
        if (pdaSupplierIds.length > 0) {
            const PDA_Supplier = require('../models/PDA_Supplier');
            pdaSuppliers = await PDA_Supplier.find({
                _id: { $in: pdaSupplierIds }
            });
            console.log(`Found ${pdaSuppliers.length} PDA suppliers`);
        }

        // STEP 4: Convert PDA suppliers to vendor format and ADD vendorSource
        const pdaSuppliersAsVendors = pdaSuppliers.map(s => ({
            CardCode: s._id.toString(),
            CardName: s.supplierName,
            email: s.email,
            phone: s.contactInfo?.phone,
            vendorSource: 'PDA_SCRAPER',
        }));

        // STEP 5: Combine all vendors and ADD vendorSource to SAP vendors
        const allVendors = [
            ...vendors.map(v => ({
                ...v.toObject(), // Convert mongoose doc to plain object
                vendorSource: v.customFields?.isEmailVendor ? 'EMAIL' : 'SAP' // ADD THIS
            })),
            ...pdaSuppliersAsVendors
        ];

        console.log(`Total vendors to send to: ${allVendors.length} (${vendors.length} SAP/EMAIL + ${pdaSuppliers.length} PDA)`);

        // Generate PDF (only if sending via email)
        const pdfBuffer = sendVia === 'email' ? await generateRFQPDF(rfq, 'en') : null;

        // Import Gmail service (only if sending via email)
        const gmailService = sendVia === 'email' ? require('../services/gmailService') : null;

        // Send messages
        const sendResults = [];

        for (const vendor of allVendors) {
            try {
                // CHECK: WhatsApp is ONLY for SAP vendors (not PDA, not EMAIL) with phone numbers
                const isSAPVendor = vendor.vendorSource === 'SAP';
                const hasPhone = vendor.phone && vendor.phone.trim() !== '';

                if (sendVia === 'whatsapp' && isSAPVendor && hasPhone) {
                    console.log(`📱 Sending via WhatsApp to ${vendor.CardName} (${vendor.phone})`);

                    const whatsappResult = await sendRFQViaWhatsApp(rfqId, vendor.CardCode);

                    // UPDATE VENDOR CONTACT STATUS FOR WHATSAPP
                    const vendorContact = rfq.vendorsContacted.find(
                        v => v.vendorCode === vendor.CardCode
                    );

                    if (vendorContact) {
                        vendorContact.status = 'sent';
                        vendorContact.sentDate = new Date();
                        vendorContact.whatsappMessageId = whatsappResult.messageId; // ADD THIS
                        vendorContact.whatsappSentDate = new Date(); // ADD THIS
                    } else {
                        rfq.vendorsContacted.push({
                            vendorCode: vendor.CardCode,
                            vendorName: vendor.CardName,
                            email: vendor.email,
                            phone: vendor.phone, // ADD THIS
                            status: 'sent',
                            sentDate: new Date(),
                            whatsappMessageId: whatsappResult.messageId, // ADD THIS
                            whatsappSentDate: new Date(), // ADD THIS
                        });
                    }

                    sendResults.push({
                        vendorCode: vendor.CardCode,
                        vendorName: vendor.CardName,
                        success: whatsappResult.success,
                        messageId: whatsappResult.messageId,
                        method: 'whatsapp'
                    });

                    console.log(`✅ WhatsApp sent to ${vendor.CardName}`);

                } else if (sendVia === 'whatsapp' && isSAPVendor && !hasPhone) {
                    // SAP vendor but no phone - skip with warning
                    console.log(`⚠️ Skipping ${vendor.CardName} - No phone number for WhatsApp`);

                    sendResults.push({
                        vendorCode: vendor.CardCode,
                        vendorName: vendor.CardName,
                        success: false,
                        error: 'No phone number available',
                        method: 'whatsapp'
                    });

                } else if (sendVia === 'whatsapp' && !isSAPVendor) {
                    // Not SAP vendor - skip with info
                    console.log(`⚠️ Skipping ${vendor.CardName} - WhatsApp only for SAP vendors`);

                    sendResults.push({
                        vendorCode: vendor.CardCode,
                        vendorName: vendor.CardName,
                        success: false,
                        error: 'WhatsApp only available for SAP vendors',
                        method: 'whatsapp'
                    });

                } else {
                    // SEND VIA EMAIL (default)
                    console.log(`📧 Sending RFQ to ${vendor.CardName} (${vendor.email})`);

                    const vendorHistory = rfq.metadata?.suggestedVendors?.find(
                        v => v.vendorCode === vendor.CardCode
                    );

                    const isExistingVendor = vendor.vendorSource !== 'PDA_SCRAPER';

                    console.log(`📧 Vendor Type: ${isExistingVendor ? 'EXISTING VENDOR' : 'NEW SUPPLIER'} - ${vendor.CardName}`);

                    const emailContent = await generateRFQEmail(
                        {
                            rfqNumber: rfq.rfqNumber,
                            items: rfq.items,
                            quotationDueDate: rfq.quotationDueDate,
                            deliveryBy: rfq.deliveryBy,
                            incoterm: rfq.incoterm,
                            destination: rfq.destination,
                            specialRequirements: {
                                packaging: rfq.packagingRequirements,
                                payment: rfq.paymentTermsPreference,
                                other: rfq.otherNotes,
                                incoterm: rfq.incoterm,
                                destination: rfq.destination,
                            },
                            customMessage,
                        },
                        {
                            vendorName: vendor.CardName,
                            totalPurchases: vendorHistory?.totalPurchases || 0,
                        },
                        'en',
                        isExistingVendor
                    );

                    const emailResult = await gmailService.sendEmail({
                        to: vendor.email,
                        subject: emailContent.subject,
                        text: emailContent.bodyText,
                        html: emailContent.bodyHtml,
                        attachments: [
                            {
                                filename: `RFQ-${rfq.rfqNumber}-EN.pdf`,
                                content: pdfBuffer,
                                contentType: 'application/pdf',
                            }
                        ],
                    });

                    const vendorContact = rfq.vendorsContacted.find(
                        v => v.vendorCode === vendor.CardCode
                    );

                    if (vendorContact) {
                        vendorContact.status = 'sent';
                        vendorContact.sentDate = new Date();
                    } else {
                        rfq.vendorsContacted.push({
                            vendorCode: vendor.CardCode,
                            vendorName: vendor.CardName,
                            email: vendor.email,
                            status: 'sent',
                            sentDate: new Date(),
                        });
                    }

                    sendResults.push({
                        vendorCode: vendor.CardCode,
                        vendorName: vendor.CardName,
                        success: true,
                        messageId: emailResult.messageId,
                        method: 'email'
                    });

                    console.log(`✅ Email sent to ${vendor.CardName}`);
                }

            } catch (error) {
                console.error(`❌ Failed to send to ${vendor.CardName}:`, error);
                sendResults.push({
                    vendorCode: vendor.CardCode,
                    vendorName: vendor.CardName,
                    success: false,
                    error: error.message,
                    method: sendVia
                });
            }
        }

        // Update RFQ status
        rfq.status = 'sent';
        rfq.metadata = {
            ...rfq.metadata,
            sentAt: new Date(),
            sendMethod: sendVia // ADD THIS to track what method was used
        };
        await rfq.save();

        const successCount = sendResults.filter(r => r.success).length;
        const method = sendVia === 'whatsapp' ? 'WhatsApp' : 'Email';

        res.json({
            success: true,
            message: `RFQ sent via ${method} to ${successCount} out of ${allVendors.length} vendors`,
            data: {
                rfqNumber: rfq.rfqNumber,
                totalVendors: allVendors.length,
                successfulSends: successCount,
                failedSends: sendResults.filter(r => !r.success).length,
                sendMethod: sendVia,
                sendResults,
                rfq: rfq.toObject(),
            },
        });
    } catch (error) {
        console.error('Error sending RFQ:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
};

/**
 * NEW: Download RFQ PDF in specific language
 * GET /api/rfq/:rfqId/download-pdf
 */
exports.downloadRFQPDF = async (req, res) => {
    try {
        const { rfqId } = req.params;
        const { language = 'fr' } = req.query; // 'fr' or 'en'

        const rfq = await RFQ.findById(rfqId);

        if (!rfq) {
            return res.status(404).json({
                success: false,
                error: 'RFQ not found',
            });
        }

        // Validate language parameter
        const lang = ['fr', 'en'].includes(language) ? language : 'fr';

        // Generate PDF
        const pdfBuffer = await generateRFQPDF(rfq, lang);

        const languageSuffix = lang === 'fr' ? 'FR' : 'EN';
        const filename = `RFQ-${rfq.rfqNumber}-${languageSuffix}.pdf`;

        // Set response headers
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', pdfBuffer.length);

        // Send PDF
        res.send(pdfBuffer);

    } catch (error) {
        console.error('Error generating PDF:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
};

/**
 * NEW: Preview RFQ PDF in browser
 * GET /api/rfq/:rfqId/preview-pdf
 */
exports.previewRFQPDF = async (req, res) => {
    try {
        const { rfqId } = req.params;
        const { language = 'fr' } = req.query;

        const rfq = await RFQ.findById(rfqId);

        if (!rfq) {
            return res.status(404).json({
                success: false,
                error: 'RFQ not found',
            });
        }

        const lang = ['fr', 'en'].includes(language) ? language : 'fr';
        const pdfBuffer = await generateRFQPDF(rfq, lang);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline');
        res.send(pdfBuffer);

    } catch (error) {
        console.error('Error previewing PDF:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
};

/**
 * Step 4: Record vendor response/quotation
 * POST /api/rfq/:rfqId/vendor-response
 */
exports.recordVendorResponse = async (req, res) => {
    try {
        const { rfqId } = req.params;
        const {
            vendorCode,
            quotedPrice,
            quotedTotal,
            deliveryDate,
            paymentTerms,
            notes,
            status,
        } = req.body;

        const rfq = await RFQ.findById(rfqId);

        if (!rfq) {
            return res.status(404).json({
                success: false,
                error: 'RFQ not found',
            });
        }

        // Find and update vendor response
        const vendorContact = rfq.vendorsContacted.find(
            v => v.vendorCode === vendorCode
        );

        if (!vendorContact) {
            return res.status(404).json({
                success: false,
                error: 'Vendor not found in RFQ',
            });
        }

        vendorContact.status = status || 'responded';
        vendorContact.quotedPrice = quotedPrice;
        vendorContact.quotedTotal = quotedTotal;
        vendorContact.deliveryDate = deliveryDate ? new Date(deliveryDate) : null;
        vendorContact.paymentTerms = paymentTerms;
        vendorContact.responseDate = new Date();
        vendorContact.notes = notes;

        // Update RFQ status if all vendors have responded
        const allResponded = rfq.vendorsContacted.every(
            v => ['responded', 'declined'].includes(v.status)
        );

        if (allResponded) {
            rfq.status = 'completed';
        } else {
            rfq.status = 'in_progress';
        }

        await rfq.save();

        // Update NewSupplier stats if this vendor was a new supplier
        if (vendorContact.vendorSource === 'NEW_SUPPLIER' && /^[0-9a-fA-F]{24}$/.test(vendorCode)) {
            try {
                const NewSupplier = require('../models/NewSupplier');
                const statsUpdate = {
                    $inc: { "stats.totalResponses": 1 },
                    $set: { "stats.lastResponseAt": new Date() },
                };
                if (status === 'responded' && quotedTotal) {
                    statsUpdate.$inc["stats.totalQuotations"] = 1;
                }
                await NewSupplier.findByIdAndUpdate(vendorCode, statsUpdate);
            } catch (err) {
                console.warn('Failed to update NewSupplier stats:', err.message);
            }
        }

        res.json({
            success: true,
            message: 'Vendor response recorded successfully',
            data: {
                rfq: rfq.toObject(),
            },
        });
    } catch (error) {
        console.error('Error recording vendor response:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
};

/**
 * Step 5: Select winning vendor
 * POST /api/rfq/:rfqId/select-vendor
 */
exports.selectWinningVendor = async (req, res) => {
    try {
        const { rfqId } = req.params;
        const { vendorCode, notes } = req.body;

        const rfq = await RFQ.findById(rfqId);

        if (!rfq) {
            return res.status(404).json({
                success: false,
                error: 'RFQ not found',
            });
        }

        const selectedVendor = rfq.vendorsContacted.find(
            v => v.vendorCode === vendorCode
        );

        if (!selectedVendor) {
            return res.status(404).json({
                success: false,
                error: 'Vendor not found in RFQ',
            });
        }

        if (selectedVendor.status !== 'responded') {
            return res.status(400).json({
                success: false,
                error: 'Can only select vendors who have responded',
            });
        }

        rfq.selectedVendor = {
            vendorCode: selectedVendor.vendorCode,
            vendorName: selectedVendor.vendorName,
            totalPrice: selectedVendor.quotedTotal,
            notes,
            selectedAt: new Date(),
        };

        // Mark the winning vendor as accepted and clear pending flag
        selectedVendor.negotiationStatus = 'accepted';
        selectedVendor.pendingAdminReview = false;

        // Clear pending flag on all non-winning vendors too
        rfq.vendorsContacted.forEach(v => {
            if (v.vendorCode !== vendorCode) {
                v.pendingAdminReview = false;
            }
        });
        rfq.markModified('vendorsContacted');

        rfq.status = 'completed';
        await rfq.save();

        // Clearing the pending flags lowers the admin attention badge — push it.
        await require('../utils/rfqAttention').pushPendingAttentionCount();

        // Track win for NewSupplier
        if (selectedVendor.vendorSource === 'NEW_SUPPLIER' && /^[0-9a-fA-F]{24}$/.test(vendorCode)) {
            try {
                const NewSupplier = require('../models/NewSupplier');
                await NewSupplier.findByIdAndUpdate(vendorCode, { $inc: { "stats.totalWins": 1 } });
            } catch (err) {
                console.warn('Failed to update NewSupplier win stats:', err.message);
            }
        }

        res.json({
            success: true,
            message: 'Winning vendor selected successfully',
            data: {
                rfq: rfq.toObject(),
            },
        });
    } catch (error) {
        console.error('Error selecting vendor:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
};

/**
 * Get all RFQs with pagination and filters
 * GET /api/rfq
 */
/**
 * Admin overrides the bot's recommendation — either keep negotiating, reject the vendor, or mark for review.
 * POST /api/rfq/:rfqId/override-recommendation
 * Body: { vendorCode, action: 'continue_negotiating'|'reject'|'review_later', reason? }
 */
exports.overrideBotRecommendation = async (req, res) => {
    try {
        const { rfqId } = req.params;
        const { vendorCode, action, reason } = req.body;

        const rfq = await RFQ.findById(rfqId);
        if (!rfq) return res.status(404).json({ success: false, error: 'RFQ not found' });

        const vendor = rfq.vendorsContacted.find(v => v.vendorCode === vendorCode);
        if (!vendor) return res.status(404).json({ success: false, error: 'Vendor not found in RFQ' });

        switch (action) {
            case 'continue_negotiating':
                vendor.negotiationStatus = 'negotiating';
                vendor.pendingAdminReview = false;
                vendor.status = 'sent'; // allow bot to re-engage
                break;
            case 'reject':
                vendor.negotiationStatus = 'rejected';
                vendor.pendingAdminReview = false;
                vendor.status = 'responded';
                break;
            case 'review_later':
                // Keep pendingAdminReview true but add a note
                vendor.notes = (vendor.notes || '') + ` | Admin deferred review: ${reason || 'No reason'} at ${new Date().toISOString()}`;
                break;
            default:
                return res.status(400).json({ success: false, error: 'Invalid action. Use continue_negotiating, reject, or review_later' });
        }

        if (reason) {
            vendor.notes = (vendor.notes || '') + ` | Admin note: ${reason}`;
        }

        rfq.markModified('vendorsContacted');
        await rfq.save();

        // continue_negotiating / reject clear the pending flag — refresh the badge.
        await require('../utils/rfqAttention').pushPendingAttentionCount();

        res.json({ success: true, data: { rfq: rfq.toObject() } });
    } catch (error) {
        console.error('Error overriding recommendation:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

/**
 * Get RFQs that need admin attention (bot recommended acceptance OR negotiation stalled)
 * GET /api/rfq/pending-attention
 */
exports.getPendingAttentionRFQs = async (req, res) => {
    try {
        const { countOnly } = req.query;
        const { PENDING_ATTENTION_FILTER, getPendingAttentionCount } = require('../utils/rfqAttention');
        const filter = PENDING_ATTENTION_FILTER;

        if (countOnly === 'true') {
            const count = await getPendingAttentionCount();
            return res.json({ success: true, count });
        }

        const rfqs = await RFQ.find(filter)
            .select('rfqNumber dateIssued status items vendorsContacted quotationDueDate')
            .sort({ updatedAt: -1 })
            .limit(50)
            .lean();

        // Attach summary of which vendor(s) need attention
        const enriched = rfqs.map(rfq => {
            const vendorsNeedingAttention = (rfq.vendorsContacted || []).filter(v =>
                v.pendingAdminReview || ['awaiting_admin_approval', 'stalled'].includes(v.negotiationStatus)
            );
            return {
                ...rfq,
                vendorsNeedingAttention: vendorsNeedingAttention.map(v => ({
                    vendorCode: v.vendorCode,
                    vendorName: v.vendorName,
                    negotiationStatus: v.negotiationStatus,
                    quotedTotal: v.quotedTotal,
                    botRecommendation: v.botRecommendation,
                })),
            };
        });

        res.json({
            success: true,
            count: enriched.length,
            data: enriched,
        });
    } catch (error) {
        console.error('Error fetching pending-attention RFQs:', error);
        res.status(500).json({ success: false, error: error.message });
    }
};

exports.getAllRFQs = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 10,
            status,
            search,
            sortBy = 'createdAt',
            sortOrder = 'desc',
        } = req.query;

        const filter = {};
        if (status) {
            filter.status = status;
        }
        if (search) {
            const regex = new RegExp(search, 'i');
            filter.$or = [
                { 'items.productName': regex },
                { rfqNumber: regex },
            ];
        }

        const options = {
            page: parseInt(page),
            limit: parseInt(limit),
            sort: { [sortBy]: sortOrder === 'desc' ? -1 : 1 },
        };

        const rfqs = await RFQ.paginate(filter, options);

        res.json({
            success: true,
            data: rfqs,
        });
    } catch (error) {
        console.error('Error fetching RFQs:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
};

/**
 * Get single RFQ by ID
 * GET /api/rfq/:rfqId
 */
exports.getRFQById = async (req, res) => {
    try {
        const { rfqId } = req.params;

        const rfq = await RFQ.findById(rfqId);

        if (!rfq) {
            return res.status(404).json({
                success: false,
                error: 'RFQ not found',
            });
        }

        res.json({
            success: true,
            data: rfq,
        });
    } catch (error) {
        console.error('Error fetching RFQ:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
};

/**
 * Compare vendor responses
 * GET /api/rfq/:rfqId/compare
 */
exports.compareVendorResponses = async (req, res) => {
    try {
        const { rfqId } = req.params;

        const rfq = await RFQ.findById(rfqId);

        if (!rfq) {
            return res.status(404).json({
                success: false,
                error: 'RFQ not found',
            });
        }

        // Get only vendors who responded
        const respondedVendors = rfq.vendorsContacted.filter(
            v => v.status === 'responded'
        );

        if (respondedVendors.length === 0) {
            return res.json({
                success: true,
                message: 'No vendor responses yet',
                data: {
                    comparison: [],
                },
            });
        }

        // Sort by price
        const comparison = respondedVendors
            .map(v => ({
                vendorCode: v.vendorCode,
                vendorName: v.vendorName,
                quotedTotal: v.quotedTotal,
                deliveryDate: v.deliveryDate,
                paymentTerms: v.paymentTerms,
                responseDate: v.responseDate,
                notes: v.notes,
            }))
            .sort((a, b) => (a.quotedTotal || Infinity) - (b.quotedTotal || Infinity));

        // Calculate savings vs highest quote
        const prices = comparison.map(v => v.quotedTotal).filter(p => p);
        const lowestPrice = Math.min(...prices);
        const highestPrice = Math.max(...prices);

        res.json({
            success: true,
            data: {
                rfqNumber: rfq.rfqNumber,
                totalResponses: respondedVendors.length,
                comparison,
                priceAnalysis: {
                    lowestPrice,
                    highestPrice,
                    potentialSavings: highestPrice - lowestPrice,
                    savingsPercentage: highestPrice > 0
                        ? ((highestPrice - lowestPrice) / highestPrice * 100).toFixed(2)
                        : 0,
                },
            },
        });
    } catch (error) {
        console.error('Error comparing vendors:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
};

/**
 * Rerun/Clone an existing RFQ
 * POST /api/rfq/:rfqId/rerun
 */
exports.rerunRFQ = async (req, res) => {
    try {
        const { rfqId } = req.params;
        const {
            quotationDueDate,
            deliveryBy,
            includeVendors = true,
            additionalVendorCodes = [],
            excludeVendorCodes = [],
            updatedItems,
        } = req.body;

        const originalRFQ = await RFQ.findById(rfqId);

        if (!originalRFQ) {
            return res.status(404).json({
                success: false,
                error: 'Original RFQ not found',
            });
        }

        // Clone items — apply updated target prices/quantities if provided
        const clonedItems = originalRFQ.items.map((item, idx) => {
            const override = updatedItems?.find(u => u.index === idx) || {};
            return {
                productName: item.productName,
                specifications: item.specifications,
                quantity: override.quantity ?? item.quantity,
                unit: override.unit ?? item.unit,
                estimatedPrice: override.estimatedPrice ?? item.estimatedPrice,
                targetPrice: override.targetPrice ?? item.targetPrice,
                additionalInfo: item.additionalInfo,
            };
        });

        // Build vendor list
        let vendorsContacted = [];
        if (includeVendors) {
            vendorsContacted = originalRFQ.vendorsContacted
                .filter(v => !excludeVendorCodes.includes(v.vendorCode))
                .map(v => ({
                    vendorCode: v.vendorCode,
                    vendorName: v.vendorName,
                    email: v.email,
                    phone: v.phone,
                    status: 'draft',
                    vendorSource: v.vendorSource,
                    negotiationRound: 0,
                    negotiationStatus: 'awaiting_initial_quote',
                    negotiationHistory: [],
                }));
        }

        // Add any additional vendors
        if (additionalVendorCodes.length > 0) {
            const pdaIds = additionalVendorCodes.filter(c => /^[0-9a-fA-F]{24}$/.test(c));
            const sapCodes = additionalVendorCodes.filter(c => !/^[0-9a-fA-F]{24}$/.test(c));

            if (sapCodes.length > 0) {
                const vendors = await Vendor.find({ CardCode: { $in: sapCodes } });
                for (const v of vendors) {
                    if (!vendorsContacted.find(vc => vc.vendorCode === v.CardCode)) {
                        vendorsContacted.push({
                            vendorCode: v.CardCode,
                            vendorName: v.CardName,
                            email: v.email,
                            phone: v.phone,
                            status: 'draft',
                            vendorSource: v.customFields?.isEmailVendor ? 'EMAIL' : 'SAP',
                        });
                    }
                }
            }

            if (pdaIds.length > 0) {
                const PDA_Supplier = require('../models/PDA_Supplier');
                const NewSupplier = require('../models/NewSupplier');
                const [pdaSuppliers, newSuppliers] = await Promise.all([
                    PDA_Supplier.find({ _id: { $in: pdaIds } }),
                    NewSupplier.find({ _id: { $in: pdaIds } }),
                ]);
                for (const s of pdaSuppliers) {
                    const code = s._id.toString();
                    if (!vendorsContacted.find(vc => vc.vendorCode === code)) {
                        vendorsContacted.push({
                            vendorCode: code,
                            vendorName: s.supplierName,
                            email: s.email,
                            phone: s.contactInfo?.phone,
                            status: 'draft',
                            vendorSource: 'PDA_SCRAPER',
                        });
                    }
                }
                for (const s of newSuppliers) {
                    const code = s._id.toString();
                    if (!vendorsContacted.find(vc => vc.vendorCode === code)) {
                        vendorsContacted.push({
                            vendorCode: code,
                            vendorName: s.supplierName,
                            email: s.email,
                            phone: s.phone,
                            status: 'draft',
                            vendorSource: 'NEW_SUPPLIER',
                        });
                    }
                }
            }
        }

        // Create new RFQ
        const newRFQ = new RFQ({
            dateIssued: new Date(),
            quotationDueDate: quotationDueDate
                ? new Date(quotationDueDate)
                : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
            deliveryBy: deliveryBy
                ? new Date(deliveryBy)
                : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
            // Fixed company mailbox, not whatever the original RFQ carried
            contactEmail: RFQ_CONTACT_EMAIL,
            contactPhone: originalRFQ.contactPhone,
            location: originalRFQ.location,
            destination: originalRFQ.destination,
            incoterm: originalRFQ.incoterm,
            items: clonedItems,
            packagingRequirements: originalRFQ.packagingRequirements,
            paymentTermsPreference: originalRFQ.paymentTermsPreference,
            otherNotes: originalRFQ.otherNotes,
            vendorsContacted,
            status: 'draft',
            createdBy: req.user?.id || originalRFQ.createdBy,
            clonedFrom: originalRFQ._id,
            metadata: {
                rerunFrom: {
                    rfqNumber: originalRFQ.rfqNumber,
                    rfqId: originalRFQ._id,
                    rerunDate: new Date(),
                },
            },
        });

        await newRFQ.save();

        res.json({
            success: true,
            message: `RFQ re-run created from ${originalRFQ.rfqNumber}`,
            data: {
                originalRFQNumber: originalRFQ.rfqNumber,
                newRFQ: newRFQ.toObject(),
            },
        });
    } catch (error) {
        console.error('Error re-running RFQ:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
};

/**
 * Cancel RFQ
 * POST /api/rfq/:rfqId/cancel
 */
exports.cancelRFQ = async (req, res) => {
    try {
        const { rfqId } = req.params;
        const { reason } = req.body;

        const rfq = await RFQ.findById(rfqId);

        if (!rfq) {
            return res.status(404).json({
                success: false,
                error: 'RFQ not found',
            });
        }

        rfq.status = 'cancelled';
        rfq.metadata = {
            ...rfq.metadata,
            cancellationReason: reason,
            cancelledAt: new Date(),
        };

        await rfq.save();

        res.json({
            success: true,
            message: 'RFQ cancelled successfully',
            data: {
                rfq: rfq.toObject(),
            },
        });
    } catch (error) {
        console.error('Error cancelling RFQ:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
};

