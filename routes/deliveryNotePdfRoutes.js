// routes/deliveryNotePdfRoutes.js
const express = require('express');
const router = express.Router();
const deliveryNotePdfController = require('../controllers/deliveryNotePdfController');

// Get delivery notes for PDF generation
router.get(
    '/delivery-notes',
    deliveryNotePdfController.getDeliveryNotesForPDF
);

// Generate bulk PDFs for delivery notes
router.post(
    '/generate-bulk-pdf',
    deliveryNotePdfController.generateBulkDeliveryNotePDFs
);

module.exports = router;
