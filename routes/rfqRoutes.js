// routes/rfqRoutes.js
const express = require('express');
const router = express.Router();
const rfqController = require('../controllers/rfqController');


/**
 * @route   POST /api/rfq/analyze
 * @desc    Analyze natural language RFQ request and get vendor recommendations
 * @access  Private
 * @body    { naturalLanguageInput: string }
 */
router.post('/analyze', rfqController.analyzeRFQRequest);

/**
 * @route   POST /api/rfq/create
 * @desc    Create RFQ draft from analysis
 * @access  Private
 * @body    { 
 *            naturalLanguageInput: string,
 *            selectedVendorCodes: string[],
 *            quotationDueDate: Date,
 *            deliveryBy: Date,
 *            contactEmail: string,
 *            contactPhone: string,
 *            paymentTerms: string
 *          }
 */
router.post('/create', rfqController.createRFQDraft);

/**
 * @route   POST /api/rfq/:rfqId/send
 * @desc    Send RFQ to selected vendors
 * @access  Private
 * @body    { vendorCodes: string[], customMessage: string }
 */
router.post('/:rfqId/send', rfqController.sendRFQToVendors);

/**
 * @route   POST /api/rfq/:rfqId/vendor-response
 * @desc    Record vendor quotation response
 * @access  Private
 * @body    {
 *            vendorCode: string,
 *            quotedPrice: number,
 *            quotedTotal: number,
 *            deliveryDate: Date,
 *            paymentTerms: string,
 *            notes: string,
 *            status: string
 *          }
 */
router.post('/:rfqId/vendor-response', rfqController.recordVendorResponse);

/**
 * @route   POST /api/rfq/:rfqId/select-vendor
 * @desc    Select winning vendor
 * @access  Private
 * @body    { vendorCode: string, notes: string }
 */
router.post('/:rfqId/select-vendor', rfqController.selectWinningVendor);

/**
 * @route   GET /api/rfq
 * @desc    Get all RFQs with pagination and filters
 * @access  Private
 * @query   { page: number, limit: number, status: string, sortBy: string, sortOrder: string }
 */
router.get('/', rfqController.getAllRFQs);

/**
 * @route   GET /api/rfq/:rfqId
 * @desc    Get single RFQ by ID
 * @access  Private
 */
router.get('/:rfqId', rfqController.getRFQById);

/**
 * @route   GET /api/rfq/:rfqId/compare
 * @desc    Compare vendor responses for an RFQ
 * @access  Private
 */
router.get('/:rfqId/compare', rfqController.compareVendorResponses);

/**
 * @route   POST /api/rfq/:rfqId/cancel
 * @desc    Cancel RFQ
 * @access  Private
 * @body    { reason: string }
 */
router.post('/:rfqId/cancel', rfqController.cancelRFQ);

// NEW: Download RFQ PDF in specific language
// Query params: ?language=fr or ?language=en
router.get('/:rfqId/download-pdf', rfqController.downloadRFQPDF);

// NEW: Preview RFQ PDF in browser
router.get('/:rfqId/preview-pdf', rfqController.previewRFQPDF);

module.exports = router;