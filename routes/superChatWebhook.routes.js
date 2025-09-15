// routes/superChatWebhook.routes.js

const express = require('express');
const router = express.Router();

const { handleWebhook } = require('../controllers/superChatWebhook.controller');

// Main webhook receiver (keep under /api/webhooks prefix)
router.post('/superchat', handleWebhook);

module.exports = router;


