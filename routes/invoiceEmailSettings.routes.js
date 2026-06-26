const express = require("express");
const router = express.Router();
const controller = require("../controllers/invoiceEmailSettings.controller");

// Settings
router.get("/", controller.getSettings);
router.put("/", controller.updateSettings);

// Preview which invoices the next run would send
router.get("/preview", controller.preview);

// Manually trigger a run now
router.post("/run-now", controller.runNow);

module.exports = router;
