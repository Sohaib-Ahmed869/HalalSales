// routes/areaAnalysis.routes.js
const express = require("express");
const router = express.Router();
const areaAnalysisController = require("../controllers/areaAnalysis.controller");

// Get area delivery analysis
// GET /api/area-analysis?lat=48.8566&lng=2.3522&radius=10&date=2024-12-31
router.get("/", areaAnalysisController.getAreaAnalysis);

// Get area suggestions based on delivery density
// GET /api/area-analysis/suggestions?date=2024-12-31
router.get("/suggestions", areaAnalysisController.getAreaSuggestions);

module.exports = router;