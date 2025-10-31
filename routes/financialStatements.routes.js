const express = require("express");
const router = express.Router();
const financialStatementsController = require("../controllers/financialStatements.controller");
const multer = require("multer");

// Configure multer for file uploads
const upload = multer({ storage: multer.memoryStorage() });

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