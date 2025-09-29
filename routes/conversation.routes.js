// routes/conversation.routes.js
const express = require("express");
const router = express.Router();
const conversationController = require("../controllers/conversation.controller");

router.get("/debug/dates", conversationController.debugDateRange);
router.get("/stats/all-time", conversationController.getStatsAllTime);
// WEBHOOK ENDPOINTS
router.post("/webhook/message", conversationController.saveMessageEvent);
router.post("/webhook/contact", conversationController.saveContactEvent);

// STATS ENDPOINT (must be before /:conversationId)
router.get("/stats", conversationController.getConversationStats);
// Enhanced stats endpoint with agent and customer insights
router.get("/stats/enhanced", conversationController.getEnhancedConversationStats);

// SEARCH ENDPOINT
router.get("/search", conversationController.searchConversations);

// AGENT ENDPOINTS (NEW)
router.get("/agents", conversationController.getAllAgentsWithStats);
router.get("/agents/:agentId/conversations", conversationController.getAgentConversations);
router.get("/agent/:agentId/insights", conversationController.getAgentConversationInsights);

// MEDIA ENDPOINTS (NEW)
router.get("/media/:fileId", conversationController.getMediaFile);
router.get("/media/:fileId/info", conversationController.getMediaFileInfo);


// Agent-specific conversation insights
router.get("/agent/:agentId/insights", conversationController.getAgentConversationInsights);

// CONVERSATION ENDPOINTS
router.get("/", conversationController.getAllConversations);
router.get("/:conversationId", conversationController.getConversationById);

// CONTACT ENDPOINTS
router.get("/contact/:contactId", conversationController.getContactById);
router.get("/contact/:contactIdentifier/messages", conversationController.getMessagesByContact);

module.exports = router;