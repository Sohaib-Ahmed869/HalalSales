const express = require("express");
const router = express.Router();
const invoiceController = require("../controllers/invoices.controller");
const { protect, authorize } = require("../middleware/auth");


// Get invoices by customer with pagination and filtering
router.get("/customer", invoiceController.getInvoicesByCustomer);

// Get customer summary with KPIs
router.get("/customers-summary", invoiceController.getCustomersSummary);

// Get global KPIs for all invoices
router.get("/global-kpis", invoiceController.getGlobalKPIs);

// Search invoices with various filters
router.get("/search", invoiceController.searchInvoices);

router.get(
  "/",
  invoiceController.getInvoices
);

module.exports = router;
