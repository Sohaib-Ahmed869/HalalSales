// routes/reportingRoutes.js
const express = require("express");
const router = express.Router();
const reportingController = require("../controllers/reporting.controller");
const { auth } = require("../middleware/auth");

// @route   GET /api/reporting/customer-sales
// @desc    Get customer sales report with invoices, orders, quotations
// @access  Private
router.get("/customer-sales", auth, reportingController.getCustomerSalesReport);

// @route   GET /api/reporting/period-comparison
// @desc    Get period-over-period comparison (month/quarter/year)
// @access  Private
router.get("/period-comparison", auth, reportingController.getPeriodComparison);

// @route   GET /api/reporting/customer/:cardCode/product-analysis
// @desc    Get product-level analysis for a specific customer
// @access  Private
router.get("/customer/:cardCode/product-analysis", auth, reportingController.getCustomerProductAnalysis);

// @route   GET /api/reporting/inactive-customers
// @desc    Get customers who stopped buying
// @access  Private
router.get("/inactive-customers", auth, reportingController.getInactiveCustomers);

// @route   GET /api/reporting/dashboard-summary
// @desc    Get overall sales dashboard summary
// @access  Private
router.get("/dashboard-summary", auth, reportingController.getSalesDashboardSummary);

// @route   GET /api/reporting/consolidated
// @desc    Consolidated report: all card codes with sales broken down by month/year
// @access  Private
router.get("/consolidated", auth, reportingController.getConsolidatedReport);

module.exports = router;