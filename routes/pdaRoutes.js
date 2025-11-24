const express = require('express');
const router = express.Router();
const pdaController = require('../controllers/pda.controller');
const { auth } = require('../middleware/auth');

// ============ SCRAPING ROUTES ============

// @route   POST /api/pda/scrape/initiate
// @desc    Initiate a new scraping job
// @access  Private
router.post('/scrape/initiate', auth, pdaController.initiateScrape);

// @route   POST /api/pda/scrape-webhook
// @desc    Webhook endpoint for Python server to notify completion
// @access  Public (but should validate source)
router.post('/scrape-webhook', pdaController.scrapeWebhook);

// @route   GET /api/pda/jobs
// @desc    Get all scrape jobs for user
// @access  Private
router.get('/jobs', auth, pdaController.getAllJobs);

// @route   GET /api/pda/jobs/:jobId
// @desc    Get scrape job status and logs
// @access  Private
router.get('/jobs/:jobId', auth, pdaController.getJobStatus);

// @route   GET /api/pda/jobs/:jobId/suppliers
// @desc    Get suppliers for a specific job
// @access  Private
router.get('/jobs/:jobId/suppliers', auth, pdaController.getJobSuppliers);

// ============ SUPPLIER ROUTES ============

// @route   GET /api/pda/suppliers
// @desc    Get all suppliers across all jobs
// @access  Private
router.get('/suppliers', auth, pdaController.getAllSuppliers);

// @route   GET /api/pda/suppliers/search/:searchTerm
// @desc    Get all suppliers by search term
// @access  Private
router.get('/suppliers/search/:searchTerm', auth, pdaController.getSuppliersBySearchTerm);

// ============ RFQ ROUTES ============

// @route   POST /api/pda/rfq/generate-and-send
// @desc    Generate RFQ using AI and send to selected suppliers
// @access  Private
router.post('/rfq/generate-and-send', auth, pdaController.generateAndSendRFQ);

// @route   GET /api/pda/rfqs
// @desc    Get all RFQs
// @access  Private
router.get('/rfqs', auth, pdaController.getAllRFQs);

// @route   GET /api/pda/rfqs/:rfqId
// @desc    Get single RFQ by ID
// @access  Private
router.get('/rfqs/:rfqId', auth, pdaController.getRFQById);

// @route   GET /api/pda/rfqs/:rfqId/responses
// @desc    Get RFQ responses
// @access  Private
router.get('/rfqs/:rfqId/responses', auth, pdaController.getRFQResponses);

// @route   POST /api/pda/rfqs/:rfqId/suppliers/:supplierId/response
// @desc    Mark RFQ response as received
// @access  Private
router.post('/rfqs/:rfqId/suppliers/:supplierId/response', auth, pdaController.markRFQResponse);

module.exports = router;