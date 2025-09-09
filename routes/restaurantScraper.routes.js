// routes/restaurantScraper.routes.js
const express = require('express');
const router = express.Router();
const restaurantScraperController = require('../controllers/restaurantScraper.controller');
const { auth } = require('../middleware/auth');

// Apply authentication to all routes
router.use(auth);

/**
 * @route   GET /api/restaurant-scraper/dashboard
 * @desc    Get scraping dashboard with statistics
 * @access  Private
 * @query   days (optional) - number of days for recent activity
 */
router.get('/dashboard', restaurantScraperController.getScrapingDashboard);

/**
 * @route   GET /api/restaurant-scraper/status
 * @desc    Get scraper service status and database stats
 * @access  Private
 */
router.get('/status', restaurantScraperController.getScraperStatus);

/**
 * @route   GET /api/restaurant-scraper/postal-code/:postalCode
 * @desc    Get all restaurants for a specific postal code
 * @access  Private
 * @query   page, limit, search, sortBy, sortOrder
 */
router.get('/postal-code/:postalCode', restaurantScraperController.getRestaurantsByPostalCode);

/**
 * @route   GET /api/restaurant-scraper/restaurant/:restaurantId
 * @desc    Get detailed restaurant information
 * @access  Private
 */
router.get('/restaurant/:restaurantId', restaurantScraperController.getRestaurantDetails);

/**
 * @route   POST /api/restaurant-scraper/scrape
 * @desc    Start scraping process for a postal code
 * @access  Private
 * @body    { postalCode, maxRestaurants }
 */
router.post('/scrape', restaurantScraperController.startScraping);

/**
 * @route   GET /api/restaurant-scraper/test/:postalCode
 * @desc    Test scraper with limited restaurants
 * @access  Private
 */
router.get('/test/:postalCode', restaurantScraperController.testScraping);

module.exports = router;