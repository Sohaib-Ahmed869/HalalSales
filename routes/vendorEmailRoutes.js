// routes/vendorEmailRoutes.js
const express = require('express');
const router = express.Router();
const vendorEmailController = require('../controllers/vendorEmailController');

/**
 * @route   POST /api/vendor-email/sync
 * @desc    Sync vendors from Gmail history
 * @access  Private
 */
router.post('/sync', vendorEmailController.syncVendorsFromEmail);

/**
 * @route   GET /api/vendor-email/list
 * @desc    Get all email vendors
 * @access  Private
 */
router.get('/list', vendorEmailController.getEmailVendors);

/**
 * @route   GET /api/vendor-email/rfq-responses/:rfqNumber
 * @desc    Get RFQ responses from email for specific RFQ
 * @access  Private
 */
router.get('/rfq-responses/:rfqNumber', vendorEmailController.getRFQResponsesFromEmail);

module.exports = router;