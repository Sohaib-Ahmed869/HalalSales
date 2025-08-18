const express = require("express");
const router = express.Router();
const { auth, checkRole, updateLastLogin } = require("../middleware/auth");
const superChatController = require("../controllers/superChat.controller");

// =============================
// DIRECT SUPER CHAT API ENDPOINTS (Real-time data)
// =============================
router.get("/conversations", auth, updateLastLogin, superChatController.getConversationsDirect);
router.get("/conversations/enriched", auth, updateLastLogin, superChatController.getConversationsWithContacts);
router.get("/conversations/:conversationId", auth, updateLastLogin, superChatController.getConversationWithMessages);
router.get("/contacts", auth, updateLastLogin, superChatController.getContactsDirect);
router.get("/users", auth, updateLastLogin, superChatController.getUsersDirect);
router.get("/inboxes", auth, updateLastLogin, superChatController.getInboxesDirect);
router.get("/files", auth, updateLastLogin, superChatController.getFilesDirect);

// =============================
// CONVERSATION MANAGEMENT ENDPOINTS
// =============================
router.get("/conversations/open", auth, updateLastLogin, superChatController.getOpenConversations);
router.post("/conversations/:conversationId/messages", auth, updateLastLogin, superChatController.sendMessageToConversation);
router.patch("/conversations/:conversationId/status", auth, updateLastLogin, superChatController.updateConversationStatus);
router.post("/conversations/:conversationId/assign", auth, updateLastLogin, superChatController.assignConversation);

// =============================
// LOCAL DATABASE ENDPOINTS (Stored data)
// =============================
// Admin & Manager
router.get("/chats", auth, updateLastLogin, superChatController.getAllChats);
router.get("/chats/team/:teamId", auth, checkRole(["admin", "sales_manager"]), superChatController.getTeamChats);

// Agent
router.get("/chats/my", auth, checkRole(["sales_agent"]), superChatController.getMyChats);

// Shared
router.get("/chats/:chatId", auth, superChatController.getChatById);
router.post("/chats/:chatId/assign", auth, checkRole(["admin", "sales_manager"]), superChatController.assignChat);
router.post("/chats/:chatId/messages", auth, superChatController.sendMessage);
router.put("/chats/:chatId/status", auth, superChatController.updateChatStatus);

// =============================
// ANALYTICS ENDPOINTS (Fixed paths)
// =============================
router.get("/analytics/dashboard", auth, checkRole(["admin", "sales_manager"]), superChatController.getDashboardAnalytics);
router.get("/analytics/inboxes", auth, checkRole(["admin", "sales_manager"]), superChatController.getInboxAnalytics);
router.get("/analytics/users", auth, checkRole(["admin", "sales_manager"]), superChatController.getUsersAnalytics);
router.get("/analytics/channels", auth, checkRole(["admin", "sales_manager"]), superChatController.getChannelsAnalytics);
router.get("/analytics/contacts", auth, checkRole(["admin", "sales_manager"]), superChatController.getContactsAnalytics);
router.get("/analytics/conversations", auth, checkRole(["admin", "sales_manager"]), superChatController.getConversationsAnalytics);

// =============================
// BATCH ANALYTICS ENDPOINTS (For 10M+ records)
// =============================
router.get("/analytics/batch/channels", auth, checkRole(["admin", "sales_manager"]), superChatController.getChannelsAnalyticsBatch);
router.get("/analytics/batch/contacts", auth, checkRole(["admin", "sales_manager"]), superChatController.getContactsAnalyticsBatch);
router.get("/analytics/batch/users", auth, checkRole(["admin", "sales_manager"]), superChatController.getUsersAnalyticsBatch);

router.get("/analytics/trends", auth, checkRole(["admin", "sales_manager"]), superChatController.getTimeTrends);
router.get("/analytics/workload", auth, checkRole(["admin", "sales_manager"]), superChatController.getWorkloadDistribution);
router.get("/analytics/customer-insights", auth, checkRole(["admin", "sales_manager"]), superChatController.getCustomerInsights);
router.get("/analytics/performance-comparison", auth, checkRole(["admin", "sales_manager"]), superChatController.getPerformanceComparison);
router.get("/analytics/performance/:agentId", auth, superChatController.getAgentPerformance);

// =============================
// ADMIN & UTILITY ENDPOINTS
// =============================
router.get("/test-connection", auth, checkRole(["admin"]), superChatController.testApiConnection);
router.post("/sync", auth, checkRole(["admin"]), superChatController.syncChats);
router.post("/webhooks", auth, checkRole(["admin"]), superChatController.createWebhook);
router.get("/webhooks", auth, checkRole(["admin"]), superChatController.listWebhooks);
router.delete("/webhooks/:webhookId", auth, checkRole(["admin"]), superChatController.deleteWebhook);

// Health check
router.get("/health", superChatController.healthCheck);

module.exports = router;


