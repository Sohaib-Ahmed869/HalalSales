const express = require("express");
const router = express.Router();
const callAcceptanceController = require("../controllers/callAcceptance.controller");
const { auth } = require("../middleware/auth");

// Get analyzed calls for acceptance review
router.get("/calls", auth, callAcceptanceController.getAnalyzedCalls);

// Get single call details
router.get("/calls/:callID", auth, callAcceptanceController.getCallDetails);

// Submit feedback for a call
router.post("/calls/:callID/feedback", auth, callAcceptanceController.submitFeedback);

// Get feedback statistics
router.get("/stats", auth, callAcceptanceController.getFeedbackStats);

module.exports = router;