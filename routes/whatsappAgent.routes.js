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

// Imported ZIP media (S3 private under whatsapp-imports/): presigned URL for streaming, or full stream fallback
router.get("/imported-media/:messageId/signed-url", auth, whatsappAgentController.getImportedMediaSignedUrl);
router.get("/imported-media/:messageId", auth, whatsappAgentController.streamImportedMedia);

// Import WhatsApp app export (ZIP + _chat.txt)
router.post(
    "/import/chat-export",
    auth,
    (req, res, next) => {
        whatsappAgentController.importZipMiddleware(req, res, (err) => {
            if (err) return res.status(400).json({ error: err.message || "Invalid upload" });
            next();
        });
    },
    whatsappAgentController.importChatExport
);

// Conversations
router.get("/conversations", auth, whatsappAgentController.getAgentConversations);
router.get("/conversations/:phoneNumber/messages", auth, whatsappAgentController.getConversationMessages);

// Messaging
router.post("/messages/send", auth, whatsappAgentController.sendMessage);
router.post("/messages/send-template", auth, whatsappAgentController.sendTemplateMessage);
router.post("/messages/read", auth, whatsappAgentController.markAsRead);

// Approved Meta templates (for re-engagement after the 24h window)
router.get("/templates", auth, whatsappAgentController.listTemplates);

// Statistics
router.get("/stats", auth, whatsappAgentController.getAgentStats);

// ── Calling ───────────────────────────────────────────────────────────────────
// POST /calls/permission  — send call permission request to customer (outbound pre-auth)
router.post("/calls/permission", auth, whatsappAgentController.requestCallPermission);
// POST /calls/initiate    — create outbound call with SDP offer after permission granted
router.post("/calls/initiate", auth, whatsappAgentController.initiateCall);
// POST /calls/action      — accept (with SDP answer) | reject | terminate
router.post("/calls/action", auth, whatsappAgentController.handleCallAction);
// GET  /calls/:callId/status — poll for SDP answer (fallback if socket missed)
router.get("/calls/:callId/status", auth, whatsappAgentController.getCallStatus);
// GET  /calls/logs        — call history for a conversation or all
router.get("/calls/logs", auth, whatsappAgentController.getCallLogs);

module.exports = router;