// routes/superChatUserAnalytics.routes.js
const express = require('express');
const router = express.Router();
const superChatUserAnalyticsController = require('../controllers/superChatUserAnalytics.controller');
const { auth, checkRole } = require('../middleware/auth');

// =============================
// USER ANALYTICS ROUTES
// =============================

/**
 * @route   GET /api/super-chat-user-analytics/overview
 * @desc    Get comprehensive user activity analytics for all users
 * @access  Private (admin, sales_manager)
 */
router.get('/overview', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatUserAnalyticsController.getUserOverview
);

/**
 * @route   GET /api/super-chat-user-analytics/user/:userId
 * @desc    Get analytics for a specific user
 * @access  Private (admin, sales_manager)
 */
router.get('/user/:userId', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatUserAnalyticsController.getUserAnalytics
);

/**
 * @route   GET /api/super-chat-user-analytics/top-performers
 * @desc    Get top performers leaderboard
 * @access  Private (admin, sales_manager)
 */
router.get('/top-performers', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatUserAnalyticsController.getTopPerformers
);

/**
 * @route   GET /api/super-chat-user-analytics/response-times
 * @desc    Get response time analytics for all users
 * @access  Private (admin, sales_manager)
 */
router.get('/response-times', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatUserAnalyticsController.getResponseTimeAnalytics
);

/**
 * @route   GET /api/super-chat-user-analytics/workload
 * @desc    Get workload distribution analytics
 * @access  Private (admin, sales_manager)
 */
router.get('/workload', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatUserAnalyticsController.getWorkloadAnalytics
);

/**
 * @route   GET /api/super-chat-user-analytics/productivity
 * @desc    Get productivity metrics and insights
 * @access  Private (admin, sales_manager)
 */
router.get('/productivity', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatUserAnalyticsController.getProductivityAnalytics
);

/**
 * @route   GET /api/super-chat-user-analytics/trends
 * @desc    Get activity trends over time
 * @access  Private (admin, sales_manager)
 */
router.get('/trends', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatUserAnalyticsController.getActivityTrends
);

/**
 * @route   GET /api/super-chat-user-analytics/performance-comparison
 * @desc    Get detailed user performance comparison
 * @access  Private (admin, sales_manager)
 */
router.get('/performance-comparison', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatUserAnalyticsController.getPerformanceComparison
);

/**
 * @route   GET /api/super-chat-user-analytics/improvements
 * @desc    Get user improvement recommendations
 * @access  Private (admin, sales_manager)
 */
router.get('/improvements', 
  auth, 
  checkRole(['admin', 'sales_manager']), 
  superChatUserAnalyticsController.getImprovementRecommendations
);

module.exports = router;
