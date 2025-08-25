// controllers/translation.controller.js
const translationService = require('../services/translationService');

const translationController = {
  /**
   * Get supported languages
   * GET /api/translation/languages
   */
  getSupportedLanguages: async (req, res) => {
    try {
      const result = await translationService.getSupportedLanguages();
      
      res.json({
        success: result.success,
        data: {
          languages: result.languages,
          total: result.languages.length
        },
        message: result.success ? 'Languages retrieved successfully' : 'Using fallback languages'
      });

    } catch (error) {
      console.error('Get Languages Error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve supported languages',
        error: error.message,
        data: {
          languages: translationService.getFallbackLanguages(),
          total: translationService.getFallbackLanguages().length
        }
      });
    }
  },

  /**
   * Translate UI text only (NOT data)
   * POST /api/translation/translate-ui
   * Body: { texts: string[], targetLang: string, sourceLang?: string }
   */
  translateUIText: async (req, res) => {
    try {
      const { texts, targetLang, sourceLang = 'EN' } = req.body;

      // Validation
      if (!texts || !Array.isArray(texts) || texts.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'texts array is required and must not be empty',
          data: { translations: [] }
        });
      }

      if (!targetLang) {
        return res.status(400).json({
          success: false,
          message: 'targetLang is required',
          data: { translations: [] }
        });
      }

      // Validate language code
      if (!translationService.isValidLanguageCode(targetLang)) {
        return res.status(400).json({
          success: false,
          message: `Invalid target language code: ${targetLang}`,
          data: { translations: [] }
        });
      }

      // Skip translation if target is same as source
      if (targetLang.toUpperCase() === sourceLang.toUpperCase()) {
        return res.json({
          success: true,
          data: {
            translations: texts.map(text => ({ text: text || '' })),
            targetLanguage: targetLang,
            sourceLanguage: sourceLang,
            skipped: true,
            reason: 'Target language same as source'
          },
          message: 'Translation skipped - same language'
        });
      }

      // Translate UI texts only
      const result = await translationService.translateUILabels(texts, targetLang, sourceLang);

      // Determine response message based on result
      let message = '';
      let warning = null;
      
      if (result.fallback) {
        if (result.errorCode === 429) {
          message = `Rate limit exceeded. Showing original text. Please try again in a few minutes.`;
          warning = 'DeepL API rate limit hit. Consider upgrading your plan or try again later.';
        } else if (result.reason === 'API key not configured') {
          message = `API key not configured. Showing original text.`;
          warning = 'DeepL API key missing. Add DEEPL_API_KEY to environment variables.';
        } else {
          message = `Translation service unavailable. Showing original text.`;
          warning = result.error || 'Translation service temporarily unavailable';
        }
      } else if (result.cached) {
        message = `Using cached translations for ${targetLang}`;
      } else {
        message = `Successfully translated ${result.translations?.length || 0} UI texts to ${targetLang}`;
      }

      res.json({
        success: true, // Always return success=true to avoid breaking frontend
        data: {
          translations: result.translations,
          originalTexts: texts,
          targetLanguage: targetLang,
          sourceLanguage: sourceLang,
          usage: result.usage || { character_count: 0, character_limit: 0 },
          filtered: texts.length - (result.translations?.length || 0),
          cached: result.cached || false,
          fallback: result.fallback || false
        },
        message,
        warning
      });

    } catch (error) {
      console.error('Translate UI Text Error:', error);
      res.status(500).json({
        success: false,
        message: 'Translation service error',
        error: error.message,
        data: { translations: [] }
      });
    }
  },

  /**
   * Translate general text (with data protection)
   * POST /api/translation/translate
   * Body: { text: string|string[], targetLang: string, sourceLang?: string }
   */
  translateText: async (req, res) => {
    try {
      const { text, targetLang, sourceLang = 'EN' } = req.body;

      // Validation
      if (!text) {
        return res.status(400).json({
          success: false,
          message: 'text is required',
          data: { translations: [] }
        });
      }

      if (!targetLang) {
        return res.status(400).json({
          success: false,
          message: 'targetLang is required',
          data: { translations: [] }
        });
      }

      // Validate language code
      if (!translationService.isValidLanguageCode(targetLang)) {
        return res.status(400).json({
          success: false,
          message: `Invalid target language code: ${targetLang}`,
          data: { translations: [] }
        });
      }

      // Skip translation if target is same as source
      if (targetLang.toUpperCase() === sourceLang.toUpperCase()) {
        const translations = Array.isArray(text) 
          ? text.map(t => ({ text: t || '' }))
          : [{ text: text || '' }];

        return res.json({
          success: true,
          data: {
            translations,
            targetLanguage: targetLang,
            sourceLanguage: sourceLang,
            skipped: true,
            reason: 'Target language same as source'
          },
          message: 'Translation skipped - same language'
        });
      }

      // Translate text
      const result = await translationService.translateText(text, targetLang, sourceLang);

      res.json({
        success: result.success,
        data: {
          translations: result.translations,
          originalText: text,
          targetLanguage: targetLang,
          sourceLanguage: sourceLang,
          usage: result.usage
        },
        message: result.success 
          ? `Translation completed to ${targetLang}`
          : `Translation failed: ${result.error}`
      });

    } catch (error) {
      console.error('Translate Text Error:', error);
      res.status(500).json({
        success: false,
        message: 'Translation service error',
        error: error.message,
        data: { translations: [] }
      });
    }
  },

  /**
   * Translate pagination text specifically (preserves numbers and placeholders)
   * POST /api/translation/translate-pagination
   * Body: { texts: string[], targetLang: string, sourceLang?: string }
   */
  translatePaginationText: async (req, res) => {
    try {
      const { texts, targetLang, sourceLang = 'EN' } = req.body;

      // Validation
      if (!texts || !Array.isArray(texts) || texts.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'texts array is required and must not be empty',
          data: { translations: [] }
        });
      }

      if (!targetLang) {
        return res.status(400).json({
          success: false,
          message: 'targetLang is required',
          data: { translations: [] }
        });
      }

      // Validate language code
      if (!translationService.isValidLanguageCode(targetLang)) {
        return res.status(400).json({
          success: false,
          message: `Invalid target language code: ${targetLang}`,
          data: { translations: [] }
        });
      }

      // Skip translation if target is same as source
      if (targetLang.toUpperCase() === sourceLang.toUpperCase()) {
        return res.json({
          success: true,
          data: {
            translations: texts.map(text => ({ text: text || '' })),
            targetLanguage: targetLang,
            sourceLanguage: sourceLang,
            skipped: true,
            reason: 'Target language same as source'
          },
          message: 'Translation skipped - same language'
        });
      }

      // Use special pagination text translation
      const result = await translationService.translatePaginationText(texts, targetLang, sourceLang);

      // Determine response message based on result
      let message = '';
      let warning = null;
      
      if (result.fallback) {
        if (result.errorCode === 429) {
          message = `Rate limit exceeded. Showing pagination templates. Please try again in a few minutes.`;
          warning = 'DeepL API rate limit hit. Consider upgrading your plan or try again later.';
        } else if (result.reason === 'API key not configured') {
          message = `API key not configured. Showing pagination templates.`;
          warning = 'DeepL API key missing. Add DEEPL_API_KEY to environment variables.';
        } else {
          message = `Translation service unavailable. Showing pagination templates.`;
          warning = result.error || 'Translation service temporarily unavailable';
        }
      } else if (result.cached) {
        message = `Using cached pagination translations for ${targetLang}`;
      } else {
        message = `Successfully processed pagination texts for ${targetLang}`;
      }

      res.json({
        success: true,
        data: {
          translations: result.translations,
          originalTexts: texts,
          targetLanguage: targetLang,
          sourceLanguage: sourceLang,
          usage: result.usage || { character_count: 0, character_limit: 0 },
          cached: result.cached || false,
          fallback: result.fallback || false,
          reason: result.reason || null
        },
        message,
        warning
      });

    } catch (error) {
      console.error('Translate Pagination Text Error:', error);
      res.status(500).json({
        success: false,
        message: 'Pagination translation service error',
        error: error.message,
        data: { translations: [] }
      });
    }
  },

  /**
   * Get API usage statistics
   * GET /api/translation/usage
   */
  getUsageStats: async (req, res) => {
    try {
      const result = await translationService.getUsageStats();

      res.json({
        success: result.success,
        data: {
          usage: result.usage,
          percentage: result.usage?.character_limit 
            ? Math.round((result.usage.character_count / result.usage.character_limit) * 100)
            : 0
        },
        message: result.success 
          ? 'Usage statistics retrieved successfully'
          : `Failed to get usage: ${result.error}`
      });

    } catch (error) {
      console.error('Get Usage Stats Error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve usage statistics',
        error: error.message,
        data: { usage: { character_count: 0, character_limit: 0 } }
      });
    }
  },

  /**
   * Health check for translation service
   * GET /api/translation/health
   */
  healthCheck: async (req, res) => {
    try {
      const hasApiKey = !!process.env.DEEPL_API_KEY;
      const result = hasApiKey ? await translationService.getUsageStats() : null;

      res.json({
        success: true,
        data: {
          apiKeyConfigured: hasApiKey,
          serviceAvailable: hasApiKey && result?.success,
          usage: result?.usage || null,
          fallbackLanguages: translationService.getFallbackLanguages().length
        },
        message: hasApiKey 
          ? (result?.success ? 'Translation service is healthy' : 'API key configured but service unavailable')
          : 'API key not configured - using fallback mode'
      });

    } catch (error) {
      console.error('Translation Health Check Error:', error);
      res.status(200).json({ // Still return 200 for health check
        success: false,
        data: {
          apiKeyConfigured: !!process.env.DEEPL_API_KEY,
          serviceAvailable: false,
          error: error.message
        },
        message: 'Translation service health check failed'
      });
    }
  }
};

module.exports = translationController;
