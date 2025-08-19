// routes/translation.routes.js
const express = require('express');
const router = express.Router();
const translationController = require('../controllers/translation.controller');
const { auth, checkRole } = require('../middleware/auth');

/**
 * @route   GET /api/translation/health
 * @desc    Health check for translation service
 * @access  Public (no auth required for health check)
 */
router.get('/health', translationController.healthCheck);

/**
 * @route   GET /api/translation/languages
 * @desc    Get supported languages for translation
 * @access  Private (authenticated users)
 */
router.get('/languages', auth, translationController.getSupportedLanguages);

/**
 * @route   POST /api/translation/translate-ui
 * @desc    Translate UI text/labels only (NOT data)
 * @access  Private (authenticated users)
 * @body    { texts: string[], targetLang: string, sourceLang?: string }
 */
router.post('/translate-ui', auth, translationController.translateUIText);

/**
 * @route   POST /api/translation/translate
 * @desc    Translate general text (with data protection)
 * @access  Private (authenticated users)
 * @body    { text: string|string[], targetLang: string, sourceLang?: string }
 */
router.post('/translate', auth, translationController.translateText);

/**
 * @route   GET /api/translation/usage
 * @desc    Get API usage statistics
 * @access  Private (admin and sales_manager only)
 */
router.get('/usage', auth, checkRole(['admin', 'sales_manager']), translationController.getUsageStats);

module.exports = router;
