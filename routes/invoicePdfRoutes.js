// routes/invoicePdfRoutes.js
const express = require("express");
const router = express.Router();
const invoicePdfController = require("../controllers/invoicePdfController");

// Get invoices for PDF generation (with filters)
router.get(
    "/invoices",
    invoicePdfController.getInvoicesForPDF
);

// Generate bulk invoice PDFs
router.post(
    "/generate-bulk",
    invoicePdfController.generateBulkInvoicePDFs
);

// Email invoice to customer
router.post(
    "/email",
    invoicePdfController.emailInvoiceToCustomer
);

router.post("/bulk-email-by-customer", invoicePdfController.bulkEmailInvoicesByCustomer);

module.exports = router;