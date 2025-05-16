// routes/quotationRoutes.js
const express = require("express");
const router = express.Router();
const quotationController = require("../controllers/quotation.controller");
const { auth } = require("../middleware/auth");

// @route   POST /api/quotations
// @desc    Create a new quotation in local DB
// @access  Private
router.post("/", auth, quotationController.createQuotation);

// @route   GET /api/quotations
// @desc    Get all quotations with pagination and filtering
// @access  Private
router.get(
  "/cardCode/:cardCode",
  auth,
  quotationController.getQuotationsByCustomer
);
router.get("/", auth, quotationController.getAllQuotations);

// @route   GET /api/quotations/cardCode/:cardCode
// @desc    Get quotations for a specific customer
// @access  Private

// @route   GET /api/quotations/:docEntry
// @desc    Get a single quotation by DocEntry
// @access  Private
router.get("/:docEntry", auth, quotationController.getQuotationByDocEntry);

// @route   PATCH /api/quotations/:docEntry
// @desc    Update a quotation
// @access  Private
router.patch("/:docEntry", auth, quotationController.updateQuotation);

// @route   POST /api/quotations/:docEntry/convert
// @desc    Convert a quotation to a sales order
// @access  Private
router.post("/:docEntry/convert", auth, quotationController.convertToOrder);

// @route   PATCH /api/quotations/:docEntry/cancel
// @desc    Cancel/deactivate a quotation
// @access  Private
router.patch("/:docEntry/cancel", auth, quotationController.cancelQuotation);

// @route   POST /api/quotations/:docEntry/duplicate
// @desc    Create a duplicate of an existing quotation
// @access  Private
router.post(
  "/:docEntry/duplicate",
  auth,
  quotationController.duplicateQuotation
);

// Send quotation by email
router.post(
  "/:docEntry/send-email",
  auth,
  quotationController.sendQuotationByEmail
);

module.exports = router;
