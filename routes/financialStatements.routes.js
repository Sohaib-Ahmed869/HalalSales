const express = require("express");
const router = express.Router();
const financialStatementsController = require("../controllers/financialStatements.controller");
const financialStatementsController2 = require("../controllers/reconciliationModule/financialStatements.controller");
const multer = require("multer");

// Configure multer for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// Import salary sheet
router.post("/salary-sheet/import", upload.single("file"),
    financialStatementsController2.importSalarySheet);

// Flatten existing statements
router.post("/bank/flatten",
    financialStatementsController2.flattenBankStatements);
router.post("/paypal/flatten",
    financialStatementsController2.flattenPayPalStatements);

// Update payment card code (from frontend)
router.put("/payment/update-cardcode",
    financialStatementsController2.updatePaymentCardCode);

// Get flattened payments
router.get("/payments/flattened",
    financialStatementsController2.getFlattenedPayments);
router.get("/payments/unmatched",
    financialStatementsController2.getUnmatchedPayments);
router.get("/payments/customer/:cardCode",
    financialStatementsController2.getPaymentsByCustomer);

// Payment allocation
router.post("/payments/allocate",
    financialStatementsController2.allocatePaymentToInvoice);
router.post("/payments/auto-match",
    financialStatementsController2.autoMatchPayments);
// Import routes
router.post(
    "/bank/import",
    upload.single("file"),
    financialStatementsController.importBankStatements
);

router.post(
    "/paypal/import",
    upload.single("file"),
    financialStatementsController.importPayPalStatements
);

// Get statements with filters and pagination
router.get("/bank", financialStatementsController.getBankStatements);
router.get("/paypal", financialStatementsController.getPayPalStatements);

// Get financial summary/dashboard
router.get("/summary", financialStatementsController.getFinancialSummary);

// Manual reconciliation
router.post("/match", financialStatementsController.matchStatementToInvoice);

module.exports = router;