// routes/rfqRoutes.js
const express = require('express');
const router = express.Router();
const rfqController = require('../controllers/rfqController');
const { auth, authAllowQueryToken } = require('../middleware/auth');


/**
 * @route   POST /api/rfq/analyze
 * @desc    Analyze natural language RFQ request and get vendor recommendations
 * @access  Private
 * @body    { naturalLanguageInput: string }
 */
router.post('/analyze', auth, rfqController.analyzeRFQRequest);

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
router.post('/create', auth, rfqController.createRFQDraft);

/**
 * @route   POST /api/rfq/:rfqId/send
 * @desc    Send RFQ to selected vendors
 * @access  Private
 * @body    { vendorCodes: string[], customMessage: string }
 */
router.post('/:rfqId/send', auth, rfqController.sendRFQToVendors);

router.get('/gmail/auth-url', auth, (req, res) => {
    const gmailService = require('../services/gmailService');
    const authUrl = gmailService.getAuthUrl();
    res.json({ authUrl });
});

// Add this to your routes (temporary)
// NOTE: deliberately left unauthenticated — Google redirects the browser here
// with ?code=, so no Authorization header can be attached. It is a one-off setup
// utility that returns a refresh_token; it should be removed from production or
// gated behind an env flag rather than left exposed.
router.get('/gmail/get-token', async (req, res) => {
    const { code } = req.query;
    const gmailService = require('../services/gmailService');

    try {
        const tokens = await gmailService.getTokenFromCode(code);
        res.json({
            message: 'Add this refresh_token to your .env file',
            refresh_token: tokens.refresh_token
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * @route   GET /api/rfq/items
 * @desc    Get inventory items for form selection
 * @access  Private
 * @query   { search: string, limit: number }
 */
router.get('/items', auth, rfqController.getInventoryItems);

/**
 * @route   GET /api/rfq/recommend-products
 * @desc    Get related product recommendations based on a product name
 * @access  Private
 * @query   { productName: string, limit: number }
 */
router.get('/recommend-products', auth, rfqController.getProductRecommendations);

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
router.post('/:rfqId/vendor-response', auth, rfqController.recordVendorResponse);

/**
 * @route   POST /api/rfq/:rfqId/select-vendor
 * @desc    Select winning vendor (admin final acceptance)
 * @access  Private
 * @body    { vendorCode: string, notes: string }
 */
router.post('/:rfqId/select-vendor', auth, rfqController.selectWinningVendor);

/**
 * @route   POST /api/rfq/:rfqId/override-recommendation
 * @desc    Admin overrides the bot's acceptance recommendation (continue, reject, or defer)
 * @access  Private
 * @body    { vendorCode: string, action: 'continue_negotiating'|'reject'|'review_later', reason?: string }
 */
router.post('/:rfqId/override-recommendation', auth, rfqController.overrideBotRecommendation);

/**
 * @route   GET /api/rfq/pending-attention
 * @desc    List RFQs where bot flagged acceptance (admin must review) or negotiation stalled
 * @query   countOnly=true for just the count (used by sidebar badge)
 * @access  Private
 */
router.get('/pending-attention', auth, rfqController.getPendingAttentionRFQs);

/**
 * @route   GET /api/rfq
 * @desc    Get all RFQs with pagination and filters
 * @access  Private
 * @query   { page: number, limit: number, status: string, sortBy: string, sortOrder: string }
 */
router.get('/', auth, rfqController.getAllRFQs);

/**
 * @route   GET /api/rfq/:rfqId
 * @desc    Get single RFQ by ID
 * @access  Private
 */
router.get('/:rfqId', auth, rfqController.getRFQById);

/**
 * @route   GET /api/rfq/:rfqId/compare
 * @desc    Compare vendor responses for an RFQ
 * @access  Private
 */
router.get('/:rfqId/compare', auth, rfqController.compareVendorResponses);

/**
 * @route   POST /api/rfq/:rfqId/rerun
 * @desc    Clone/re-run an existing RFQ with fresh dates
 * @access  Private
 * @body    { quotationDueDate, deliveryBy, includeVendors, additionalVendorCodes, excludeVendorCodes }
 */
router.post('/:rfqId/rerun', auth, rfqController.rerunRFQ);

/**
 * @route   POST /api/rfq/:rfqId/cancel
 * @desc    Cancel RFQ
 * @access  Private
 * @body    { reason: string }
 */
router.post('/:rfqId/cancel', auth, rfqController.cancelRFQ);

// NEW: Download RFQ PDF in specific language
// Query params: ?language=fr or ?language=en
router.get('/:rfqId/download-pdf', auth, rfqController.downloadRFQPDF);

// NEW: Preview RFQ PDF in browser
router.get('/:rfqId/preview-pdf', authAllowQueryToken, rfqController.previewRFQPDF);

module.exports = router;