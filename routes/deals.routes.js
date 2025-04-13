const express = require("express");
const router = express.Router();
const dealController = require("../controllers/deals.controller");
/**
 * @route   GET /api/deals/customers
 * @desc    Get all customers with their deals summary
 * @access  Private
 * @query   {number} skip - Number of records to skip
 * @query   {number} limit - Number of records to return
 */
router.get("/customers", dealController.getCustomerDeals);

/**
 * @route   GET /api/deals/customers/:email
 * @desc    Get details for a specific customer
 * @access  Private
 * @param   {string} email - Customer's email address
 */
router.get("/customers/:email", dealController.getCustomerDetail);

// Basic CRUD routes
router.get("/:id", dealController.getDealById);
router.get("/", dealController.getDeals);
router.post("/", dealController.createDeal);
router.put("/:id", dealController.updateDeal);
router.delete("/:id", dealController.deleteDeal);

// Analytics routes

/**
 * @route   GET /api/deals/analytics/abandoned-carts
 * @desc    Get abandoned carts (where orderNumber is null)
 * @access  Private
 * @query   {number} page - Page number
 * @query   {number} limit - Number of results per page
 * @query   {number} daysAgo - Only return carts from the last X days
 */
router.get("/analytics/abandoned-carts", dealController.getAbandonedCarts);

/**
 * @route   GET /api/deals/analytics/abandoned-cart-recovery
 * @desc    Get abandoned carts with contact information for recovery
 * @access  Private
 */
router.get(
  "/analytics/abandoned-cart-recovery",
  dealController.getAbandonedCartRecoveryOpportunities
);

/**
 * @route   GET /api/deals/analytics/sales-performance
 * @desc    Get sales performance over time
 * @access  Private
 * @query   {string} period - daily, weekly, monthly, yearly
 * @query   {number} months - Number of months to look back
 */
router.get("/analytics/sales-performance", dealController.getSalesPerformance);

/**
 * @route   GET /api/deals/analytics/product-performance
 * @desc    Get product performance data
 * @access  Private
 * @query   {string} timeframe - all, month, quarter, year
 */
router.get(
  "/analytics/product-performance",
  dealController.getProductPerformance
);

/**
 * @route   GET /api/deals/analytics/conversion-stats
 * @desc    Get conversion rate statistics
 * @access  Private
 * @query   {string} period - all, month, quarter, year
 */
router.get("/analytics/conversion-stats", dealController.getConversionStats);

/**
 * @route   GET /api/deals/analytics/customer-insights
 * @desc    Get insights about customer behavior
 * @access  Private
 */
router.get("/analytics/customer-insights", dealController.getCustomerInsights);

/**
 * @route   GET /api/deals/analytics/abandoned-cart-analytics
 * @desc    Get abandoned cart analytics over time
 * @access  Private
 * @query   {string} timeframe - daily, weekly, monthly
 */
router.get(
  "/analytics/abandoned-cart-analytics",
  dealController.getAbandonedCartAnalytics
);

/**
 * @route   GET /api/deals/analytics/top-abandoned-products
 * @desc    Get the most frequently abandoned products
 * @access  Private
 */
router.get(
  "/analytics/top-abandoned-products",
  dealController.getTopAbandonedProducts
);

/**
 * @route   GET /api/deals/analytics/pipeline
 * @desc    Get deal pipeline stage analytics
 * @access  Private
 */
router.get("/analytics/pipeline", dealController.getPipelineAnalytics);

/**
 * @route   GET /api/deals/analytics/sources
 * @desc    Get deal sources analytics
 * @access  Private
 */
router.get("/analytics/sources", dealController.getDealSourcesAnalytics);

/**
 * @route   GET /api/deals/export/abandoned-carts
 * @desc    Export abandoned cart data for marketing campaigns
 * @access  Private
 * @query   {number} daysAgo - Only export carts from the last X days
 */
router.get("/export/abandoned-carts", dealController.exportAbandonedCarts);

module.exports = router;
