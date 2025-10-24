// routes/emailLogRoutes.js
const express = require("express");
const router = express.Router();
const emailLogController = require("../controllers/emailLogController");


// Get email logs (with filters)
router.get("/", emailLogController.getEmailLogs);

// Get email statistics
router.get("/stats", emailLogController.getEmailStats);

// Get single email log by ID
router.get("/:id", emailLogController.getEmailLogById);

// Download attachment
router.get("/:id/attachments/:attachmentIndex/download", emailLogController.downloadAttachment);

module.exports = router;