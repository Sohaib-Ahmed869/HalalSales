// routes/aiSummary.routes.js
const express = require("express");
const router = express.Router();
const aiSummaryController = require("../controllers/aiSummary.controller");

// Customer analysis with date range
// GET /api/ai-summary/customer-analysis?startDate=2024-01-01&endDate=2024-12-31
router.get("/customer-analysis", aiSummaryController.getCustomerAnalysis);

// Agent analysis with date range
// GET /api/ai-summary/agent-analysis?startDate=2024-01-01&endDate=2024-12-31
router.get("/agent-analysis", aiSummaryController.getAgentAnalysis);

// Predictive analysis for future date
// GET /api/ai-summary/predictive-analysis?targetDate=2024-12-31
router.get("/predictive-analysis", aiSummaryController.getPredictiveAnalysis);

module.exports = router;