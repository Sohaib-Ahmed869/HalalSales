// routes/whatsappAIAgent.routes.js
const express = require('express');
const router = express.Router();
const controller = require('../controllers/whatsappAIAgent.controller');

// List / filter conversations
router.get('/conversations', controller.listConversations);

// Stats
router.get('/stats', controller.getStats);

// RFQ-scoped endpoints
router.post('/rfq/:rfqId/send', controller.sendRFQ);
router.get('/rfq/:rfqId/conversation/:vendorCode', controller.getConversation);
router.post('/rfq/:rfqId/conversation/:vendorCode/manual-reply', controller.sendManualReply);
router.post('/rfq/:rfqId/conversation/:vendorCode/reprocess', controller.reprocessLast);

module.exports = router;
