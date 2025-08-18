const express = require('express');
const router = express.Router();
const SuperChatConversationController = require('../controllers/superChatConversationController');
const superChatController = require('../controllers/superChat.controller');
const { auth, checkRole } = require('../middleware/auth');

const conversationController = new SuperChatConversationController();

// =============================
// WEBHOOK MANAGEMENT
// =============================

// Create webhook for receiving messages
router.post('/webhooks', auth, checkRole(['admin']), conversationController.createWebhook.bind(conversationController));

// List all webhooks
router.get('/webhooks', auth, checkRole(['admin']), conversationController.listWebhooks.bind(conversationController));

// Delete webhook
router.delete('/webhooks/:webhookId', auth, checkRole(['admin']), conversationController.deleteWebhook.bind(conversationController));

// Webhook receiver (no auth required - SuperChat calls this)
router.post('/webhook', conversationController.receiveWebhook.bind(conversationController));

// =============================
// DIRECT SUPERCHAT API ENDPOINTS (Real-time data)
// =============================

// Get conversations directly from SuperChat API (working endpoint)
router.get('/conversations', auth, conversationController.getConversationsDirect.bind(conversationController));

// Get contacts directly from SuperChat API
router.get('/contacts', auth, superChatController.getContactsDirect.bind(superChatController));

// Get users directly from SuperChat API  
router.get('/users', auth, superChatController.getUsersDirect.bind(superChatController));

// Get inboxes directly from SuperChat API
router.get('/inboxes', auth, superChatController.getInboxesDirect.bind(superChatController));

// =============================
// CONVERSATION LISTING (LIKE SUPERCHAT UI)
// =============================

// Get all conversations with filters (main conversation list) - LOCAL STORAGE (temporarily no auth for testing)
router.get('/conversations/local', conversationController.getAllConversations.bind(conversationController));

// Get conversation details with messages (LOCAL STORAGE)
router.get('/conversations/:conversationId', auth, conversationController.getConversationDetails.bind(conversationController));

// Get conversation details directly from SuperChat API (for real-time data)
router.get('/conversations/:conversationId/direct', auth, conversationController.getConversationWithMessages.bind(conversationController));

// Get messages for a conversation (temporarily no auth for testing)
router.get('/conversations/:conversationId/messages', conversationController.getConversationMessages.bind(conversationController));

// =============================
// MESSAGE SENDING (REPLY FUNCTIONALITY)
// =============================

// Send message to conversation
router.post('/conversations/:conversationId/messages', auth, conversationController.sendMessage.bind(conversationController));

// =============================
// CONVERSATION MANAGEMENT
// =============================

// Update conversation status, assignment, labels, etc.
router.patch('/conversations/:conversationId/status', auth, conversationController.updateConversationStatus.bind(conversationController));

// Assign conversation to user
router.post('/conversations/:conversationId/assign', auth, conversationController.assignConversation.bind(conversationController));

// =============================
// ANALYTICS ENDPOINTS
// =============================

// Dashboard analytics
router.get('/analytics/dashboard', auth, checkRole(['admin', 'sales_manager']), superChatController.getDashboardAnalytics.bind(superChatController));

// Individual analytics
router.get('/analytics/inboxes', auth, checkRole(['admin', 'sales_manager']), superChatController.getInboxAnalytics.bind(superChatController));
router.get('/analytics/users', auth, checkRole(['admin', 'sales_manager']), superChatController.getUsersAnalytics.bind(superChatController));
router.get('/analytics/channels', auth, checkRole(['admin', 'sales_manager']), superChatController.getChannelsAnalytics.bind(superChatController));
router.get('/analytics/contacts', auth, checkRole(['admin', 'sales_manager']), superChatController.getContactsAnalytics.bind(superChatController));
router.get('/analytics/conversations', auth, checkRole(['admin', 'sales_manager']), superChatController.getConversationsAnalytics.bind(superChatController));

// Batch analytics (for 10M+ records)
router.get('/analytics/batch/channels', auth, checkRole(['admin', 'sales_manager']), superChatController.getChannelsAnalyticsBatch.bind(superChatController));
router.get('/analytics/batch/contacts', auth, checkRole(['admin', 'sales_manager']), superChatController.getContactsAnalyticsBatch.bind(superChatController));
router.get('/analytics/batch/users', auth, checkRole(['admin', 'sales_manager']), superChatController.getUsersAnalyticsBatch.bind(superChatController));

// =============================
// UTILITY ENDPOINTS
// =============================

// Get conversation statistics
router.get('/conversations/stats', auth, conversationController.getConversationStats.bind(conversationController));

// Search conversations
router.get('/conversations/search', auth, conversationController.searchConversations.bind(conversationController));

module.exports = router;
