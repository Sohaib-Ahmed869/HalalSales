const express = require("express");
const router = express.Router();
const salesExportController = require("../controllers/Sales.export.controller");
/**
 * @route   GET /api/sales-export/clients
 * @desc    Export all clients with comprehensive sales data
 * @access  Private
 * @query   ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&salesAgentId=xxx&status=active
 */
router.get(
    "/clients",
    salesExportController.exportClientsData
);

/**
 * @route   GET /api/sales-export/insights
 * @desc    Export detailed sales insights (Invoices, Quotations, Abandoned Carts)
 * @access  Private
 * @query   ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&cardCode=xxx
 */
router.get(
    "/insights",
    salesExportController.exportSalesInsights
);

module.exports = router;