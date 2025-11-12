const express = require("express");
const router = express.Router();
const invoiceController = require("../controllers/invoices.controller");
const invoiceSyncController = require("../controllers/invoiceSync.controller");
const { protect, authorize } = require("../middleware/auth");

const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });
router.post("/fix-duplicate-docentry", invoiceSyncController.fixDuplicateDocEntries);

router.post('/update-totals-for-date', invoiceController.updateInvoiceTotalsForDate);
// Get invoices by customer with pagination and filtering
router.get("/customer", invoiceController.getInvoicesByCustomer);

// Get customer summary with KPIs
router.get("/customers-summary", invoiceController.getCustomersSummary);

// Get global KPIs for all invoices
router.get("/global-kpis", invoiceController.getGlobalKPIs);

// Search invoices with various filters
router.get("/search", invoiceController.searchInvoices);

router.get("/", invoiceController.getInvoices);

router.post(
    "/bulk-import",
    upload.single("excelFile"), // Multer middleware for file upload
    invoiceController.bulkImportInvoices
);

// Get single invoice by DocEntry
router.get("/:docEntry", invoiceController.getInvoiceByDocEntry);

// Add to existing routes

// Credit note routes
router.post(
    "/:docEntry/credit-note",

    invoiceController.createCreditNoteFromInvoice
);

router.get(
    "/:docEntry/credit-notes",

    invoiceController.getCreditNotesForInvoice
);

// Payment routes
router.post(
    "/:docEntry/payment",

    invoiceController.recordPaymentForInvoice
);

router.get(
    "/:docEntry/payments",

    invoiceController.getPaymentsForInvoice
);
// Create invoice from delivery note
router.post(
    "/from-delivery-note/:docEntry",
    invoiceController.createInvoiceFromDeliveryNote
);

// Bulk create invoices from delivery notes
router.post(
    "/bulk-create-from-delivery-notes",
    invoiceController.bulkCreateInvoicesFromDeliveryNotes
);

// Bulk push invoices to SAP
router.post(
    "/bulk-push-to-sap",
    invoiceController.bulkPushInvoicesToSAP
);

// Live sync invoice statuses from SAP (similar to order sync)
router.post("/invoices/sync-status", invoiceSyncController.syncInvoiceStatusesFromSAP);

// Get unpaid invoices by customer
router.get("/unpaid/customer/:cardCode", invoiceController.getUnpaidInvoicesByCustomer);

// Get all unpaid invoices with filters
router.get("/unpaid", invoiceController.getUnpaidInvoices);

// Get invoice payment allocation details
router.get("/:docEntry/allocations", invoiceController.getInvoiceAllocations);

// Update invoice payment status manually
router.put("/:docEntry/payment-status", invoiceController.updateInvoicePaymentStatus);


module.exports = router;
