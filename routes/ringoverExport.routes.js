/**
 * Ringover Export Routes
 */

const express = require("express");
const router = express.Router();
const {
  generateExport,
  generateDailyExport,
} = require("../controllers/ringoverExport.controller");

// POST /api/ringover-export/generate
router.post("/generate", generateExport);

// POST /api/ringover-export/daily
router.post("/daily", generateDailyExport);

module.exports = router;
