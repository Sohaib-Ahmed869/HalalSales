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

/**
 * Step 1: Process natural language input and get vendor recommendations
 * POST /api/rfq/analyze
 */
exports.analyzeRFQRequest = async (req, res) => {
    try {
        const { naturalLanguageInput } = req.body;
        const userId = req.user?.id || 'admin'; // From auth middleware

        if (!naturalLanguageInput || naturalLanguageInput.trim().length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Natural language input is required',
            });
        }

        console.log(`Processing RFQ request from user ${userId}`);

        // Process the natural language input using AI
        const analysis = await processNaturalLanguageRFQ(naturalLanguageInput, userId);

        res.json({
            success: true,
            message: 'RFQ request analyzed successfully',
            data: {
                parsedRequirements: analysis.parsedData,
                items: analysis.itemsAnalysis.map(item => ({
                    productName: item.productName,
                    specifications: item.specifications,
                    quantity: item.quantity,
                    unit: item.unit,
                    vendorsFound: item.vendorsFound,
                    topVendors: item.vendors.slice(0, 5).map(v => ({
                        vendorCode: v._id,
                        vendorName: v.vendorName,
                        avgPrice: v.avgPrice,
                        totalPurchases: v.totalPurchases,
                        lastPurchaseDate: v.lastPurchaseDate,
                        score: v.scores.total,
                    })),
                })),
                overallRecommendations: {
                    totalVendorsFound: analysis.vendorRecommendations.total,
                    topVendorsAcrossAllItems: analysis.vendorRecommendations.topVendors.slice(0, 10).map(vendor => ({
                        ...vendor,
                        canSupplyItems: analysis.itemsAnalysis
                            .filter(item => item.vendors.some(v => v._id === vendor._id))
                            .map(item => ({
                                productName: item.productName,
                                quantity: item.quantity,
                                unit: item.unit,
                                avgPrice: item.vendors.find(v => v._id === vendor._id)?.avgPrice
                            })),
                        // ADD THIS - Purchase History
                        purchaseHistory: vendor.recentPurchases || vendor.purchaseHistory || []
                    })),
                    aiInsights: analysis.vendorRecommendations.aiInsights,
                },
            },
        });
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
        } = req.body;

        const userId = req.user?.id || 'admin';

        // Re-analyze to get fresh data
        const analysis = await processNaturalLanguageRFQ(naturalLanguageInput, userId);

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
            const vendors = await Vendor.find({
                CardCode: { $in: selectedVendorCodes }
            });

            rfq.vendorsContacted = vendors.map(v => ({
                vendorCode: v.CardCode,
                vendorName: v.CardName,
                email: v.email,
                status: 'sent', // Will be updated when actually sent
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
 * Step 3: Send RFQ to vendors with bilingual support
 * POST /api/rfq/:rfqId/send
 */
exports.sendRFQToVendors = async (req, res) => {
    try {
        const { rfqId } = req.params;
        const { vendorCodes, customMessage, language = 'fr' } = req.body; // Default to French

        const rfq = await RFQ.findById(rfqId);

        if (!rfq) {
            return res.status(404).json({
                success: false,
                error: 'RFQ not found',
            });
        }

        if (rfq.status === 'cancelled') {
            return res.status(400).json({
                success: false,
                error: 'Cannot send cancelled RFQ',
            });
        }

        // Get vendor details
        const vendors = await Vendor.find({
            CardCode: { $in: vendorCodes },
        });

        if (vendors.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No active vendors found',
            });
        }

        // Generate bilingual PDFs (both French and English)
        console.log('Generating bilingual PDF documents...');
      
        const pdfEnglishBuffer = await generateRFQPDF(rfq, 'en');

        // Send emails to each vendor
        const sendResults = [];

        for (const vendor of vendors) {
            try {
                console.log(`Sending RFQ to ${vendor.CardName} (${vendor.email})`);

                // Find historical relationship data
                const vendorHistory = rfq.metadata?.suggestedVendors?.find(
                    v => v.vendorCode === vendor.CardCode
                );

                // Generate personalized bilingual email using AI
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
                    'both' // Generate both French and English
                );

                // Prepare attachments with both language versions
                const attachments = [
                   
                    {
                        filename: `RFQ-${rfq.rfqNumber}-EN.pdf`,
                        content: pdfEnglishBuffer,
                        contentType: 'application/pdf',
                    }
                ];

                // Send email with enhanced footer and bilingual attachments
                const emailResult = await sendEmail({
                    to: vendor.email,
                    subject: emailContent.subject,
                    text: emailContent.bodyText,
                    html: emailContent.bodyHtml,
                    attachments,
                });

                // Update RFQ vendor status
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
                    languagesIncluded: ['French', 'English'],
                });

                console.log(`✅ Successfully sent to ${vendor.CardName}`);

            } catch (error) {
                console.error(`❌ Failed to send to ${vendor.CardName}:`, error);
                sendResults.push({
                    vendorCode: vendor.CardCode,
                    vendorName: vendor.CardName,
                    success: false,
                    error: error.message,
                });
            }
        }

        // Update RFQ status
        rfq.status = 'sent';
        rfq.metadata = {
            ...rfq.metadata,
            sentAt: new Date(),
            languagesUsed: ['fr', 'en'],
        };
        await rfq.save();

        const successCount = sendResults.filter(r => r.success).length;

        res.json({
            success: true,
            message: `RFQ sent successfully to ${successCount} out of ${vendors.length} vendors`,
            data: {
                rfqNumber: rfq.rfqNumber,
                totalVendors: vendors.length,
                successfulSends: successCount,
                failedSends: vendors.length - successCount,
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

