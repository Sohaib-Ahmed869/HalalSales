// routes/superChatFullAnalytics.routes.js
const express = require('express');
const router = express.Router();
const superChatFullAnalyticsController = require('../controllers/superChatFullAnalytics.controller');
const { auth, checkRole } = require('../middleware/auth');

// =============================
// DASHBOARD ANALYTICS (Frontend Compatible)
// =============================

/**
 * @route   GET /api/super-chat-analytics/dashboard/overview
 * @desc    Get dashboard overview analytics from stored data (COMPLETE DATA)
 * @access  Private (admin, sales_manager)
 */
router.get('/dashboard/overview', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatFullAnalyticsController.getDashboardOverview
);

/**
 * @route   GET /api/super-chat-analytics/dashboard/real-time
 * @desc    Get real-time dashboard activity
 * @access  Private (admin, sales_manager)
 */
router.get('/dashboard/real-time', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatFullAnalyticsController.getRealTimeActivity
);

/**
 * @route   GET /api/super-chat-analytics/dashboard/weekly-activity
 * @desc    Get weekly activity summary
 * @access  Private (admin, sales_manager)
 */
router.get('/dashboard/weekly-activity', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatFullAnalyticsController.getWeeklyActivity
);

/**
 * @route   GET /api/super-chat-analytics/dashboard/kpis
 * @desc    Get key performance indicators
 * @access  Private (admin, sales_manager)
 */
router.get('/dashboard/kpis', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatFullAnalyticsController.getKPIs
);

// =============================
// CONTACTS ANALYTICS (Frontend Compatible)
// =============================

/**
 * @route   GET /api/super-chat-analytics/contacts/overview
 * @desc    Get contacts overview analytics from stored data
 * @access  Private (admin, sales_manager)
 */
router.get('/contacts/overview', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatFullAnalyticsController.getContactsOverview
);

/**
 * @route   GET /api/super-chat-analytics/contacts/engagement
 * @desc    Get contacts engagement metrics
 * @access  Private (admin, sales_manager)
 */
router.get('/contacts/engagement', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatFullAnalyticsController.getContactsEngagement
);

/**
 * @route   GET /api/super-chat-analytics/contacts/growth-trend
 * @desc    Get contacts growth trend
 * @access  Private (admin, sales_manager)
 */
router.get('/contacts/growth-trend', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatFullAnalyticsController.getContactsGrowthTrend
);

/**
 * @route   GET /api/super-chat-analytics/contacts/top-active
 * @desc    Get top active contacts
 * @access  Private (admin, sales_manager)
 */
router.get('/contacts/top-active', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatFullAnalyticsController.getTopActiveContacts
);

/**
 * @route   GET /api/super-chat-analytics/contacts/by-source
 * @desc    Get contacts by source/channel
 * @access  Private (admin, sales_manager)
 */
router.get('/contacts/by-source', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatFullAnalyticsController.getContactsBySource
);

// =============================
// CONVERSATIONS ANALYTICS (Frontend Compatible)
// =============================

/**
 * @route   GET /api/super-chat-analytics/conversations/overview
 * @desc    Get conversations overview analytics from stored data
 * @access  Private (admin, sales_manager)
 */
router.get('/conversations/overview', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatFullAnalyticsController.getConversationsOverview
);

/**
 * @route   GET /api/super-chat-analytics/conversations/volume-trend
 * @desc    Get conversations volume trend
 * @access  Private (admin, sales_manager)
 */
router.get('/conversations/volume-trend', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatFullAnalyticsController.getConversationsVolumeTrend
);

/**
 * @route   GET /api/super-chat-analytics/conversations/by-channel
 * @desc    Get conversations by channel
 * @access  Private (admin, sales_manager)
 */
router.get('/conversations/by-channel', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatFullAnalyticsController.getConversationsByChannel
);

/**
 * @route   GET /api/super-chat-analytics/conversations/response-time
 * @desc    Get response time analytics
 * @access  Private (admin, sales_manager)
 */
router.get('/conversations/response-time', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatFullAnalyticsController.getResponseTimeAnalytics
);

/**
 * @route   GET /api/super-chat-analytics/conversations/busiest
 * @desc    Get busiest conversations
 * @access  Private (admin, sales_manager)
 */
router.get('/conversations/busiest', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatFullAnalyticsController.getBusiestConversations
);

/**
 * @route   GET /api/super-chat-analytics/conversations/completion-rate
 * @desc    Get conversation completion rate
 * @access  Private (admin, sales_manager)
 */
router.get('/conversations/completion-rate', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatFullAnalyticsController.getCompletionRate
);

// Legacy endpoints for backward compatibility
router.get('/contacts', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatFullAnalyticsController.getContactsAnalytics
);

router.get('/conversations', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatFullAnalyticsController.getConversationsAnalytics
);

// =============================
// SYNC MANAGEMENT
// =============================

/**
 * @route   POST /api/super-chat-analytics/sync/full
 * @desc    Run full synchronization of ALL SuperChat data
 * @access  Private (admin only)
 */
router.post('/sync/full', 
  auth, 
  checkRole(['admin']), 
  superChatFullAnalyticsController.runFullSync
);

/**
 * @route   POST /api/super-chat-analytics/sync/quick
 * @desc    Run quick sync (contacts and conversations only)
 * @access  Private (admin, sales_manager)
 */
router.post('/sync/quick', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatFullAnalyticsController.runQuickSync
);

/**
 * @route   GET /api/super-chat-analytics/sync/status
 * @desc    Get synchronization status for all data types
 * @access  Private (admin, sales_manager)
 */
router.get('/sync/status', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatFullAnalyticsController.getSyncStatus
);

module.exports = router;
