const express = require("express");
const router = express.Router();
const whatsappController = require("../controllers/whatsapp.controller");
const { auth } = require("../middleware/auth");

// Webhook verification and handling (no auth needed)
router.get("/webhook", whatsappController.verifyWebhook);
router.post("/webhook", whatsappController.handleWebhook);

// Send messages (requires auth)
router.post("/send/text", auth, whatsappController.sendTextMessage);
router.post("/send/media", auth, whatsappController.sendMediaMessage);
router.post("/send/template", auth, whatsappController.sendTemplateMessage);

// Get conversations (requires auth)
router.get("/conversations", auth, whatsappController.getAllConversations);
router.get("/conversations/:phoneNumber", auth, whatsappController.getConversation);

// Mark as read
router.post("/messages/:messageId/read", auth, whatsappController.markAsRead);

module.exports = router;