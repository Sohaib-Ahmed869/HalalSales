const express = require('express');
const router = express.Router();
const awsTranslateService = require('../services/awsTranslateService');

let initialized = false;
const ensureInitialized = async (req, res, next) => {
    if (!initialized) {
        try {
            await awsTranslateService.initialize();
            initialized = true;
        } catch (error) {
            console.error('Failed to initialize translation service:', error);
            return res.status(500).json({
                success: false,
                error: 'Translation service initialization failed'
            });
        }
    }
    next();
};

router.use(ensureInitialized);

// Translate single text
router.post('/translate', async (req, res) => {
    try {
        const { text, sourceLang = 'en', targetLang = 'fr' } = req.body;

        if (!text) {
            return res.status(400).json({
                success: false,
                error: 'Text is required'
            });
        }

        // Limit text length
        if (text.length > 5000) {
            return res.status(400).json({
                success: false,
                error: 'Text too long (max 5000 characters)'
            });
        }

        const translation = await awsTranslateService.translate(text, sourceLang, targetLang);

        res.json({
            success: true,
            original: text,
            translated: translation,
            sourceLang,
            targetLang
        });
    } catch (error) {
        console.error('Translation error:', error);
        res.status(500).json({
            success: false,
            error: 'Translation failed',
            message: error.message
        });
    }
});

// Translate multiple texts
router.post('/translate/bulk', async (req, res) => {
    try {
        const { texts, sourceLang = 'en', targetLang = 'fr' } = req.body;

        if (!texts || !Array.isArray(texts)) {
            return res.status(400).json({
                success: false,
                error: 'Texts array is required'
            });
        }

        // Limit number of texts
        if (texts.length > 100) {
            return res.status(400).json({
                success: false,
                error: 'Too many texts (max 100 per request)'
            });
        }

        // Limit individual text length
        const tooLong = texts.find(t => t && t.length > 5000);
        if (tooLong) {
            return res.status(400).json({
                success: false,
                error: 'Individual text too long (max 5000 characters)'
            });
        }

        const translations = await awsTranslateService.translateBulk(texts, sourceLang, targetLang);

        res.json({
            success: true,
            translations,
            sourceLang,
            targetLang,
            count: texts.length,
            cached: Object.keys(translations).length
        });
    } catch (error) {
        console.error('Bulk translation error:', error);
        res.status(500).json({
            success: false,
            error: 'Bulk translation failed',
            message: error.message
        });
    }
});

// Get cache statistics
router.get('/stats', async (req, res) => {
    try {
        const stats = await awsTranslateService.getCacheStats();
        res.json({
            success: true,
            stats
        });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to get stats',
            message: error.message
        });
    }
});

// Clear cache
router.post('/cache/clear', async (req, res) => {
    try {
        await awsTranslateService.clearCache();
        res.json({
            success: true,
            message: 'Translation cache cleared successfully'
        });
    } catch (error) {
        console.error('Clear cache error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to clear cache',
            message: error.message
        });
    }
});

module.exports = router;