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
const { processFormBasedRFQ } = require('../services/rfqService');
const { sendRFQViaWhatsApp } = require('../services/whatsappService');
/**
 * Get items from inventory for form selection
 * GET /api/rfq/items
 */
exports.getInventoryItems = async (req, res) => {
    try {
        const { search, limit = 50 } = req.query;
        const Item = require('../models/item');

        const query = {
            Valid: 'tYES',
            PurchaseItem: 'tYES'
        };

        if (search) {
            query.$or = [
                { ItemName: { $regex: search, $options: 'i' } },
                { ForeignName: { $regex: search, $options: 'i' } },
                { ItemCode: { $regex: search, $options: 'i' } }
            ];
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
 * Step 1: Process natural language input and get vendor recommendations
 * POST /api/rfq/analyze
 */
exports.analyzeRFQRequest = async (req, res) => {
    try {
        const { searchMode = 'existing', itemCodes, quantities, targetPrices } = req.body;
        const userId = req.user?.id || 'admin';

        // For EXISTING vendors: Use form-based input
        if (searchMode === 'existing') {
            if (!itemCodes || itemCodes.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Item codes are required for existing vendor search',
                });
            }

            console.log(`Processing EXISTING vendor search for items:`, itemCodes);

            const analysis = await processFormBasedRFQ(
                itemCodes,
                quantities,
                targetPrices,
                userId
            );

            res.json({
                success: true,
                message: 'RFQ analyzed for existing vendors (SAP)',
                data: analysis,
            });
        }
        // For NEW suppliers: Use natural language
        else if (searchMode === 'new') {
            const { naturalLanguageInput } = req.body;

            if (!naturalLanguageInput || naturalLanguageInput.trim().length === 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Natural language input is required for new supplier search',
                });
            }

            console.log(`Processing NEW supplier search with:`, naturalLanguageInput);

            const analysis = await processNaturalLanguageRFQ(
                naturalLanguageInput,
                userId,
                'new'
            );

            res.json({
                success: true,
                message: 'New suppliers found (Email + PDA)',
                data: {
                    ...analysis,
                    // ADD vendor type counts
                    vendorTypeCounts: {
                        email: analysis.vendorRecommendations.topVendors.filter(v => v.vendorSource === 'EMAIL').length,
                        pda: analysis.vendorRecommendations.topVendors.filter(v => v.vendorSource === 'PDA_SCRAPER').length,
                        total: analysis.vendorRecommendations.total
                    }
                },
            });
        } else {
            return res.status(400).json({
                success: false,
                error: 'Invalid searchMode. Use "existing" or "new"',
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
            searchMode = 'existing', // ADD THIS
            itemCodes, // ADD THIS
            quantities, // ADD THIS
            targetPrices // ADD THIS
        } = req.body;

        const userId = req.user?.id || 'admin';

        let analysis;

        // DETERMINE WHICH PROCESSING METHOD TO USE
        if (searchMode === 'existing' && itemCodes && itemCodes.length > 0) {
            // FORM-BASED RFQ (Existing vendors)
            console.log('Creating RFQ from form-based analysis (existing vendors)');

            analysis = await processFormBasedRFQ(
                itemCodes,
                quantities,
                targetPrices,
                userId
            );
        } else if (naturalLanguageInput && naturalLanguageInput.trim()) {
            // NATURAL LANGUAGE RFQ (New suppliers or existing)
            console.log('Creating RFQ from natural language analysis');

            analysis = await processNaturalLanguageRFQ(
                naturalLanguageInput,
                userId,
                searchMode
            );
        } else {
            return res.status(400).json({
                success: false,
                error: 'Either provide itemCodes (for existing vendors) or naturalLanguageInput (for new suppliers)'
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
        });

        // Add selected vendors to vendorsContacted list
        if (selectedVendorCodes && selectedVendorCodes.length > 0) {
            // STEP 1: Separate vendor codes by type
            const pdaSupplierIds = selectedVendorCodes.filter(code =>
                /^[0-9a-fA-F]{24}$/.test(code)
            );

            const sapVendorCodes = selectedVendorCodes.filter(code =>
                !/^[0-9a-fA-F]{24}$/.test(code)
            );

            console.log(`Fetching vendors: ${sapVendorCodes.length} SAP/EMAIL, ${pdaSupplierIds.length} PDA`);

            // STEP 2: Fetch SAP/EMAIL vendors
            const vendors = await Vendor.find({
                CardCode: { $in: sapVendorCodes }
            });

            console.log(`Found ${vendors.length} SAP/EMAIL vendors`);

            // STEP 3: Fetch PDA suppliers (only if there are valid ObjectIds)
            let pdaSuppliers = [];
            if (pdaSupplierIds.length > 0) {
                const PDA_Supplier = require('../models/PDA_Supplier');
                pdaSuppliers = await PDA_Supplier.find({
                    _id: { $in: pdaSupplierIds }
                });
                console.log(`Found ${pdaSuppliers.length} PDA suppliers`);
            }

            // STEP 4: Convert PDA suppliers to vendor format
            const pdaSuppliersAsVendors = pdaSuppliers.map(s => ({
                CardCode: s._id.toString(),
                CardName: s.supplierName,
                email: s.email,
                phone: s.contactInfo?.phone,
                vendorSource: 'PDA_SCRAPER',
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
                ...pdaSuppliersAsVendors
            ];

            console.log(`Total vendors to contact: ${allSelectedVendors.length}`);

            // STEP 6: Add to RFQ
            rfq.vendorsContacted = allSelectedVendors.map(v => ({
                vendorCode: v.CardCode,
                vendorName: v.CardName,
                email: v.email,
                phone: v.phone, // ADD THIS
                status: 'draft',
                vendorSource: v.vendorSource,
            }));

            await rfq.save();
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
                            specialRequirements: {
                                packaging: rfq.packagingRequirements,
                                payment: rfq.paymentTermsPreference,
                                other: rfq.otherNotes,
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
        };

        rfq.status = 'completed';
        await rfq.save();

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
exports.getAllRFQs = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 10,
            status,
            sortBy = 'createdAt',
            sortOrder = 'desc',
        } = req.query;

        const filter = {};
        if (status) {
            filter.status = status;
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

