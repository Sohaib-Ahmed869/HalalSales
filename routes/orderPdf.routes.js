// routes/orderPdf.routes.js
const express = require("express");
const router = express.Router();
const orderPdfController = require("../controllers/orderPdfController");

// Get orders for PDF generation (with filters)
router.get(
  "/pdf-list",
  orderPdfController.getOrdersForPDF
);

// Generate bulk PDFs
router.post(
  "/generate-bulk-pdf",
  orderPdfController.generateBulkOrderPDFs
);

module.exports = router;