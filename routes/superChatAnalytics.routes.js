const express = require('express');
const router = express.Router();
const { auth, checkRole } = require('../middleware/auth');

// Import analytics controllers
const SuperChatContactsAnalyticsController = require('../controllers/superChatContactsAnalyticsController');
const SuperChatConversationsAnalyticsController = require('../controllers/superChatConversationsAnalyticsController');
const SuperChatTotalAnalyticsController = require('../controllers/superChatTotalAnalyticsController');

// Initialize controllers
const contactsAnalytics = new SuperChatContactsAnalyticsController();
const conversationsAnalytics = new SuperChatConversationsAnalyticsController();
const totalAnalytics = new SuperChatTotalAnalyticsController();

// =============================
// TOTAL/OVERVIEW ANALYTICS
// =============================

// Dashboard overview (main KPIs)
router.get('/dashboard/overview', 
  auth, 
  totalAnalytics.getDashboardOverview.bind(totalAnalytics)
);

// Weekly activity summary
router.get('/dashboard/weekly-activity', 
  auth, 
  totalAnalytics.getWeeklyActivitySummary.bind(totalAnalytics)
);

// Key Performance Indicators
router.get('/dashboard/kpis', 
  auth, 
  totalAnalytics.getKPIs.bind(totalAnalytics)
);

// Real-time activity
router.get('/dashboard/real-time', 
  auth, 
  totalAnalytics.getRealTimeActivity.bind(totalAnalytics)
);

// =============================
// CONTACTS ANALYTICS
// =============================

// Contacts overview
router.get('/contacts/overview', 
  auth, 
  contactsAnalytics.getContactsOverview.bind(contactsAnalytics)
);

// Contacts growth trend
router.get('/contacts/growth-trend', 
  auth, 
  contactsAnalytics.getContactsGrowthTrend.bind(contactsAnalytics)
);

// Contacts engagement metrics
router.get('/contacts/engagement', 
  auth, 
  contactsAnalytics.getContactsEngagement.bind(contactsAnalytics)
);

// Top active contacts
router.get('/contacts/top-active', 
  auth, 
  contactsAnalytics.getTopActiveContacts.bind(contactsAnalytics)
);

// Contacts by source/channel
router.get('/contacts/by-source', 
  auth, 
  contactsAnalytics.getContactsBySource.bind(contactsAnalytics)
);

// =============================
// CONVERSATIONS ANALYTICS
// =============================

// Conversations overview
router.get('/conversations/overview', 
  auth, 
  conversationsAnalytics.getConversationsOverview.bind(conversationsAnalytics)
);

// Conversations volume trend
router.get('/conversations/volume-trend', 
  auth, 
  conversationsAnalytics.getConversationsVolumeTrend.bind(conversationsAnalytics)
);

// Conversations by channel
router.get('/conversations/by-channel', 
  auth, 
  conversationsAnalytics.getConversationsByChannel.bind(conversationsAnalytics)
);

// Response time analytics
router.get('/conversations/response-time', 
  auth, 
  conversationsAnalytics.getResponseTimeAnalytics.bind(conversationsAnalytics)
);

// Busiest conversations
router.get('/conversations/busiest', 
  auth, 
  conversationsAnalytics.getBusiestConversations.bind(conversationsAnalytics)
);

// Conversation completion rate
router.get('/conversations/completion-rate', 
  auth, 
  conversationsAnalytics.getCompletionRate.bind(conversationsAnalytics)
);

module.exports = router;
