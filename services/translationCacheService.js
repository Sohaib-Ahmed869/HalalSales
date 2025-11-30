const fs = require('fs').promises;
const path = require('path');

class TranslationCacheService {
    constructor() {
        this.cacheDir = path.join(__dirname, '../cache');
        this.cacheFile = path.join(this.cacheDir, 'translations.json');
        this.cache = null;
    }

    async initialize() {
        try {
            // Create cache directory if it doesn't exist
            await fs.mkdir(this.cacheDir, { recursive: true });

            // Load existing cache or create new one
            try {
                const data = await fs.readFile(this.cacheFile, 'utf8');
                this.cache = JSON.parse(data);
            } catch (err) {
                // Cache file doesn't exist, create new one
                this.cache = {
                    metadata: {
                        version: '1.0',
                        context: 'food-related-software',
                        lastUpdated: new Date().toISOString()
                    },
                    translations: {}
                };
                await this.saveCache();
            }

            console.log('✅ Translation cache initialized');
        } catch (error) {
            console.error('❌ Error initializing translation cache:', error);
            throw error;
        }
    }

    async saveCache() {
        try {
            await fs.writeFile(
                this.cacheFile,
                JSON.stringify(this.cache, null, 2),
                'utf8'
            );
        } catch (error) {
            console.error('❌ Error saving translation cache:', error);
            throw error;
        }
    }

    getCacheKey(text, sourceLang, targetLang) {
        // Create a unique key for each translation
        return `${sourceLang}:${targetLang}:${text.toLowerCase().trim()}`;
    }

    async get(text, sourceLang, targetLang) {
        if (!this.cache) await this.initialize();

        const key = this.getCacheKey(text, sourceLang, targetLang);
        return this.cache.translations[key];
    }

    async set(text, translation, sourceLang, targetLang) {
        if (!this.cache) await this.initialize();

        const key = this.getCacheKey(text, sourceLang, targetLang);
        this.cache.translations[key] = {
            original: text,
            translated: translation,
            sourceLang,
            targetLang,
            addedAt: new Date().toISOString(),
            context: 'food-related'
        };

        this.cache.metadata.lastUpdated = new Date().toISOString();
        await this.saveCache();
    }

    async bulkGet(texts, sourceLang, targetLang) {
        if (!this.cache) await this.initialize();

        const results = {};
        const missing = [];

        texts.forEach(text => {
            const key = this.getCacheKey(text, sourceLang, targetLang);
            if (this.cache.translations[key]) {
                results[text] = this.cache.translations[key].translated;
            } else {
                missing.push(text);
            }
        });

        return { results, missing };
    }

    async bulkSet(translations, sourceLang, targetLang) {
        if (!this.cache) await this.initialize();

        Object.entries(translations).forEach(([original, translated]) => {
            const key = this.getCacheKey(original, sourceLang, targetLang);
            this.cache.translations[key] = {
                original,
                translated,
                sourceLang,
                targetLang,
                addedAt: new Date().toISOString(),
                context: 'food-related'
            };
        });

        this.cache.metadata.lastUpdated = new Date().toISOString();
        await this.saveCache();
    }

    async getStats() {
        if (!this.cache) await this.initialize();

        const stats = {
            totalTranslations: Object.keys(this.cache.translations).length,
            byLanguagePair: {},
            lastUpdated: this.cache.metadata.lastUpdated
        };

        Object.values(this.cache.translations).forEach(entry => {
            const pair = `${entry.sourceLang}-${entry.targetLang}`;
            stats.byLanguagePair[pair] = (stats.byLanguagePair[pair] || 0) + 1;
        });

        return stats;
    }
}

module.exports = new TranslationCacheService();