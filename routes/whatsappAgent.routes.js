const express = require("express");
const router = express.Router();
const whatsappAgentController = require("../controllers/whatsappAgent.controller");
const { auth } = require("../middleware/auth");

// Agent settings
router.get("/settings", auth, whatsappAgentController.getAgentSettings);
router.put("/settings/:agentId", auth, whatsappAgentController.updateAgentSettings);

// Contacts management
router.get("/contacts", auth, whatsappAgentController.getContacts);
router.post("/contacts", auth, whatsappAgentController.saveContact);
router.delete("/contacts/:contactId", auth, whatsappAgentController.deleteContact);

// Media upload (S3)
router.post("/upload", auth, whatsappAgentController.uploadMiddleware, whatsappAgentController.uploadMedia);

// Conversations
router.get("/conversations", auth, whatsappAgentController.getAgentConversations);
router.get("/conversations/:phoneNumber/messages", auth, whatsappAgentController.getConversationMessages);

// Messaging
router.post("/messages/send", auth, whatsappAgentController.sendMessage);
router.post("/messages/read", auth, whatsappAgentController.markAsRead);

// Statistics
router.get("/stats", auth, whatsappAgentController.getAgentStats);

module.exports = router;