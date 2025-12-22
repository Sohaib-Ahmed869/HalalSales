const express = require("express");
const router = express.Router();
const financialStatementsController = require("../controllers/financialStatements.controller");
const financialStatementsController2 = require("../controllers/reconciliationModule/financialStatements.controller");
const multer = require("multer");

// Configure multer for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// Import salary sheet
router.post("/import-salary-sheet", upload.single("file"),
    financialStatementsController2.importSalarySheet);

// Flatten existing statements
router.post("/bank/flatten",
    financialStatementsController2.flattenBankStatements);
router.post("/paypal/flatten",
    financialStatementsController2.flattenPayPalStatements);

// Update payment card code (from frontend)
router.put("/update-payment-cardcode",
    financialStatementsController2.updatePaymentCardCode);

// Get flattened payments
router.get("/flattened-payments",
    financialStatementsController2.getFlattenedPayments);
router.get("/unmatched-payments",
    financialStatementsController2.getUnmatchedPayments);
router.get("/payments/customer/:cardCode",
    financialStatementsController2.getPaymentsByCustomer);

// Payment allocation
router.post("/allocate-payment",
    financialStatementsController2.allocatePaymentToInvoice);
router.post("/payments/auto-match",
    financialStatementsController2.autoMatchPayments);
// Import routes
router.post(
    "/import-bank-statements",
    upload.single("file"),
    financialStatementsController.importBankStatements
);

router.post(
    "/import-sg-bank-statements",
    upload.single("file"),
    financialStatementsController.importSGBankStatements
);

router.post(
    "/import-paypal-statements",
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

router.post('/allocate-outstanding-balance', financialStatementsController2.allocateOutstandingBalanceToInvoice);
router.post('/allocate-credit-note', financialStatementsController2.allocateCreditNoteToInvoice);
router.get('/credit-notes/available/:cardCode', financialStatementsController2.getAvailableCreditNotesByCustomer);
module.exports = router;