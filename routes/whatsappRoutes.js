const express = require('express');
const router = express.Router();
const whatsappController = require('../controllers/whatsappController');
// Webhook endpoint (no auth required - Twilio calls this)
router.post('/webhook', whatsappController.whatsappWebhook);
router.get('/webhook', whatsappController.verifyWebhook);

module.exports = router;