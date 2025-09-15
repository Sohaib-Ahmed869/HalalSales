// routes/analyticsPerformance.routes.js
// Standalone router for performance analytics. Mount separately in server.js if desired.

const express = require('express');
const router = express.Router();

const { getPerformanceAnalytics } = require('../controllers/performanceAnalytics.controller');

// No auth middleware included to avoid touching existing files.
// Add auth in server mounting if required: app.use('/api/analytics', auth, router)

/**
 * @route   GET /api/analytics/performance
 * @query   user_id (optional), start_date (optional, YYYY-MM-DD), end_date (optional, YYYY-MM-DD)
 */
router.get('/performance', getPerformanceAnalytics);

module.exports = router;


