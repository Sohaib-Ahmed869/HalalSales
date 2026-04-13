// whatsappAdmin.routes.js
const express = require("express");
const router = express.Router();
const whatsappAdminController = require("../controllers/whatsappAdmin.controller");

// ── Stats ─────────────────────────────────────────────────────────────────────
// GET /api/whatsapp-admin/stats?startDate=2024-01-01&endDate=2024-12-31
router.get("/stats", whatsappAdminController.getAdminStats);

// ── Agents ────────────────────────────────────────────────────────────────────
// GET /api/whatsapp-admin/agents
router.get("/agents", whatsappAdminController.getAgentsList);

// ── Conversations ─────────────────────────────────────────────────────────────
// GET /api/whatsapp-admin/conversations?page=1&limit=20&agentId=x&unreadOnly=true&search=ali
router.get("/conversations", whatsappAdminController.getAllConversations);

// GET /api/whatsapp-admin/conversations/:phoneNumber/messages?page=1&limit=50
router.get(
    "/conversations/:phoneNumber/messages",
    whatsappAdminController.getConversationMessages
);

// PUT /api/whatsapp-admin/conversations/:conversationId/reassign
router.put(
    "/conversations/:conversationId/reassign",
    whatsappAdminController.reassignConversation
);

module.exports = router;