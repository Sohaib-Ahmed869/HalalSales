// services/translationService.js
const axios = require('axios');

class TranslationService {
  constructor() {
    this.apiKey = process.env.DEEPL_API_KEY;
    this.apiUrl = 'https://api.deepl.com/v2'; // Use api.deepl.com for paid plans
    this.cache = new Map(); // In-memory cache for translations
    this.rateLimitDelay = 1000; // 1 second delay between requests
    this.lastRequestTime = 0;
    
    if (!this.apiKey) {
      console.warn('⚠️  DEEPL_API_KEY not found in environment variables');
    }
  }

  /**
   * Get supported languages from DeepL
   */
  async getSupportedLanguages() {
    try {
      if (!this.apiKey) {
        throw new Error('DeepL API key not configured');
      }

      const response = await axios.get(`${this.apiUrl}/languages`, {
        headers: {
          'Authorization': `DeepL-Auth-Key ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        params: {
          type: 'target' // Get target languages
        }
      });

      return {
        success: true,
        languages: response.data
      };
    } catch (error) {
      console.error('Translation Service - Get Languages Error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message,
        languages: this.getFallbackLanguages()
      };
    }
  }

  /**
   * Check cache for existing translation
   */
  getCachedTranslation(texts, targetLang, sourceLang) {
    const cacheKey = `${JSON.stringify(texts)}:${sourceLang}:${targetLang}`;
    return this.cache.get(cacheKey);
  }

  /**
   * Store translation in cache
   */
  setCachedTranslation(texts, targetLang, sourceLang, result) {
    const cacheKey = `${JSON.stringify(texts)}:${sourceLang}:${targetLang}`;
    this.cache.set(cacheKey, result);
    
    // Clear old cache entries if cache gets too large
    if (this.cache.size > 1000) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  /**
   * Rate limiting helper
   */
  async enforceRateLimit() {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.rateLimitDelay) {
      const waitTime = this.rateLimitDelay - timeSinceLastRequest;
      console.log(`⏳ Rate limiting: waiting ${waitTime}ms before next request`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastRequestTime = Date.now();
  }

  /**
   * Translate text using DeepL API with caching and rate limiting
   * @param {string|string[]} text - Text to translate (string or array of strings)
   * @param {string} targetLang - Target language code (e.g., 'FR', 'ES', 'DE')
   * @param {string} sourceLang - Source language code (optional, auto-detect if not provided)
   */
  async translateText(text, targetLang, sourceLang = null) {
    try {
      if (!this.apiKey) {
        console.warn('DeepL API key not configured, returning original text');
        const fallbackTranslations = Array.isArray(text) 
          ? text.map(t => ({ text: t || '' }))
          : [{ text: text || '' }];
        
        return {
          success: true, // Return success=true for fallback to avoid breaking UI
          translations: fallbackTranslations,
          originalText: text,
          cached: false,
          fallback: true,
          reason: 'API key not configured'
        };
      }

      if (!text || (Array.isArray(text) && text.length === 0)) {
        return {
          success: true,
          translations: Array.isArray(text) ? [] : [{ text: '' }],
          usage: { character_count: 0, character_limit: 0 }
        };
      }

      // Ensure text is array for consistent processing
      const textArray = Array.isArray(text) ? text : [text];
      
      // Filter out empty strings
      const nonEmptyTexts = textArray.filter(t => t && t.trim());
      
      if (nonEmptyTexts.length === 0) {
        return {
          success: true,
          translations: textArray.map(t => ({ text: t || '' })),
          usage: { character_count: 0, character_limit: 0 }
        };
      }

      // Check cache first
      const cachedResult = this.getCachedTranslation(nonEmptyTexts, targetLang, sourceLang);
      if (cachedResult) {
        console.log('✅ Using cached translation');
        return {
          ...cachedResult,
          cached: true
        };
      }

      // Enforce rate limiting
      await this.enforceRateLimit();

      console.log(`🌍 Translating ${nonEmptyTexts.length} texts to ${targetLang}`);

      // Build the request body for form-urlencoded
      const formData = new URLSearchParams();
      
      // Add each text as a separate parameter
      nonEmptyTexts.forEach(text => {
        formData.append('text', text);
      });
      
      formData.append('target_lang', targetLang.toUpperCase());
      
      if (sourceLang) {
        formData.append('source_lang', sourceLang.toUpperCase());
      }
      
      // Optional parameters
      formData.append('preserve_formatting', '1');
      formData.append('tag_handling', 'html');

      // console.log('📤 Request data:', formData.toString()); // Debug only

      const response = await axios.post(`${this.apiUrl}/translate`, formData, {
        headers: {
          'Authorization': `DeepL-Auth-Key ${this.apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000 // 10 second timeout
      });

      // Map results back to original array structure
      const translatedTexts = response.data.translations;
      let translatedIndex = 0;
      
      const finalTranslations = textArray.map(originalText => {
        if (!originalText || !originalText.trim()) {
          return { text: originalText || '' };
        }
        return translatedTexts[translatedIndex++];
      });

      const result = {
        success: true,
        translations: Array.isArray(text) ? finalTranslations : finalTranslations,
        originalText: text,
        targetLanguage: targetLang,
        sourceLanguage: sourceLang,
        cached: false,
        usage: {
          character_count: response.data.translations.reduce((sum, t) => sum + t.text.length, 0),
          character_limit: 500000 // DeepL free tier limit
        }
      };

      // Cache the successful result
      this.setCachedTranslation(nonEmptyTexts, targetLang, sourceLang, result);

      return result;

    } catch (error) {
      console.error('Translation Service - Translate Error:', error.response?.data || error.message);
      
      // Handle specific error cases
      let errorReason = 'Unknown error';
      if (error.response?.status === 429) {
        errorReason = 'Rate limit exceeded - please try again later';
        console.warn('⚠️  DeepL API rate limit hit. Consider upgrading your plan.');
      } else if (error.response?.status === 403) {
        errorReason = 'API key invalid or quota exceeded';
      } else if (error.response?.status === 400) {
        errorReason = 'Invalid request parameters';
      } else if (error.code === 'ECONNABORTED') {
        errorReason = 'Request timeout';
      }
      
      // Return original text as fallback (with success=true to avoid breaking UI)
      const fallbackTranslations = Array.isArray(text) 
        ? text.map(t => ({ text: t || '' }))
        : [{ text: text || '' }];

      return {
        success: true, // Changed to true to avoid breaking frontend
        translations: fallbackTranslations,
        originalText: text,
        cached: false,
        fallback: true,
        error: errorReason,
        errorCode: error.response?.status,
        usage: { character_count: 0, character_limit: 0 }
      };
    }
  }

  /**
   * Translate frontend UI text/labels only
   * This method specifically excludes data fields
   */
  async translateUILabels(uiTexts, targetLang, sourceLang = 'EN') {
    try {
      // Filter out data-like content and only translate UI labels
      const uiOnlyTexts = this.filterUITexts(uiTexts);
      
      console.log(`📊 Translation filter: ${uiTexts.length} → ${uiOnlyTexts.length} texts (${uiTexts.length - uiOnlyTexts.length} filtered)`);
      
      if (uiOnlyTexts.length === 0) {
        console.warn('⚠️  All texts filtered as data, returning originals');
        // Return original texts if everything was filtered
        return {
          success: true,
          translations: uiTexts.map(text => ({ text: text || '' })),
          fallback: true,
          reason: 'All texts filtered as data'
        };
      }

      const result = await this.translateText(uiOnlyTexts, targetLang, sourceLang);
      
      // Map filtered results back to original array
      if (result.success && uiTexts.length !== uiOnlyTexts.length) {
        const fullTranslations = [];
        let filteredIndex = 0;
        
        uiTexts.forEach(originalText => {
          const wasFiltered = !uiOnlyTexts.includes(originalText);
          if (wasFiltered) {
            // Keep original text for filtered items
            fullTranslations.push({ text: originalText });
          } else {
            // Use translation for non-filtered items
            fullTranslations.push(result.translations[filteredIndex++]);
          }
        });
        
        return {
          ...result,
          translations: fullTranslations
        };
      }
      
      return result;

    } catch (error) {
      console.error('Translation Service - UI Labels Error:', error);
      return {
        success: false,
        translations: uiTexts.map(text => ({ text: text || '' })),
        error: error.message
      };
    }
  }

  /**
   * Filter texts to only include UI labels (not data)
   * This prevents translating actual business data
   */
  filterUITexts(texts) {
    const strongDataPatterns = [
      /^[A-Z]{1,2}-[A-Z]{2,4}-\d{4,}/, // Customer codes like "C-001", "NC-HS-123456" 
      /^[\w\.-]+@[\w\.-]+\.\w+$/, // Email addresses
      /^\+?[\d\s\-\(\)]{10,}$/, // Phone numbers (10+ chars)
      /^\$[\d,]+\.?\d*$/, // Monetary values with $ symbol
      /^[A-Z0-9]{10,}$/, // Long IDs/codes (10+ chars)
      /^[A-Z]{2,4}\d{6,}$/ // Product codes like "ABC123456"
    ];

    // UI keywords that should ALWAYS be translated
    const uiKeywords = [
      'profile', 'dashboard', 'settings', 'admin', 'user', 'customer', 'order', 'task',
      'lead', 'sales', 'agent', 'manager', 'chat', 'analytics', 'report', 'invoice',
      'quotation', 'cart', 'role', 'status', 'active', 'inactive', 'pending',
      'edit', 'delete', 'save', 'cancel', 'submit', 'create', 'update', 'view',
      'login', 'logout', 'change', 'password', 'email', 'phone', 'address',
      'name', 'date', 'time', 'joined', 'last', 'first', 'total', 'count'
    ];

    return texts.filter(text => {
      if (!text || typeof text !== 'string') return false;
      
      const trimmedText = text.trim();
      const lowerText = trimmedText.toLowerCase();
      
      // Always include if it contains UI keywords
      const isUIKeyword = uiKeywords.some(keyword => 
        lowerText.includes(keyword) || lowerText === keyword
      );
      
      if (isUIKeyword) return true;
      
      // Check if text matches strong data patterns (definitely exclude these)
      const isStrongData = strongDataPatterns.some(pattern => pattern.test(trimmedText));
      
      if (isStrongData) return false;
      
      // For dates, only exclude if they look like full timestamps
      if (/\d{4}.*\d{1,2}:\d{2}/.test(trimmedText)) return false; // Full datetime
      
      // For pure numbers, only exclude if very large (likely IDs)
      if (/^\d{8,}$/.test(trimmedText)) return false; // 8+ digit numbers
      
      // Include everything else (be more permissive)
      return trimmedText.length > 0 && trimmedText.length < 500;
    });
  }

  /**
   * Get API usage statistics
   */
  async getUsageStats() {
    try {
      if (!this.apiKey) {
        throw new Error('DeepL API key not configured');
      }

      const response = await axios.get(`${this.apiUrl}/usage`, {
        headers: {
          'Authorization': `DeepL-Auth-Key ${this.apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      return {
        success: true,
        usage: response.data
      };
    } catch (error) {
      console.error('Translation Service - Usage Stats Error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.message || error.message,
        usage: { character_count: 0, character_limit: 0 }
      };
    }
  }

  /**
   * Fallback languages if API is unavailable
   */
  getFallbackLanguages() {
    return [
      { language: 'EN', name: 'English' },
      { language: 'FR', name: 'French' },
      { language: 'ES', name: 'Spanish' },
      { language: 'DE', name: 'German' },
      { language: 'IT', name: 'Italian' },
      { language: 'PT', name: 'Portuguese' },
      { language: 'RU', name: 'Russian' },
      { language: 'JA', name: 'Japanese' },
      { language: 'ZH', name: 'Chinese (simplified)' },
      { language: 'AR', name: 'Arabic' }
    ];
  }

  /**
   * Validate language code
   */
  isValidLanguageCode(langCode) {
    const supportedCodes = ['EN', 'FR', 'ES', 'DE', 'IT', 'PT', 'RU', 'JA', 'ZH', 'AR', 'NL', 'PL', 'SV', 'DA', 'NO', 'FI'];
    return supportedCodes.includes(langCode.toUpperCase());
  }
}

module.exports = new TranslationService();
