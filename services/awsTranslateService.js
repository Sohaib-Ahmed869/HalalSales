const { TranslateClient, TranslateTextCommand } = require('@aws-sdk/client-translate');
const translationCacheService = require('./translationCacheService');

class AWSTranslateService {
    constructor() {
        this.client = new TranslateClient({
            region: process.env.AWS_REGION || 'us-east-1',
            credentials: {
                accessKeyId: process.env.AWS_Translator_Access_Key,
                secretAccessKey: process.env.AWS_Translator_Secret_Access_Key
            }
        });

        // Food-related context terms
        this.foodContext = [
            'menu', 'order', 'delivery', 'invoice', 'quotation', 'customer',
            'restaurant', 'supplier', 'product', 'item', 'price', 'discount',
            'payment', 'sales', 'agent', 'target', 'lead', 'cart', 'checkout',
            'food', 'dish', 'meal', 'cuisine', 'chef', 'kitchen', 'recipe',
            'ingredient', 'portion', 'serving', 'booking', 'reservation'
        ];

        // Rate limiting
        this.requestQueue = [];
        this.isProcessingQueue = false;
        this.maxConcurrent = 3; // Max 3 concurrent requests
        this.delayBetweenRequests = 100; // 100ms delay between requests
    }

    async initialize() {
        await translationCacheService.initialize();
        console.log('✅ AWS Translate service initialized');
    }

    isFoodRelated(text) {
        const lowerText = text.toLowerCase();
        return this.foodContext.some(term => lowerText.includes(term));
    }

    // Add to queue instead of translating immediately
    async queueTranslation(text, sourceLang, targetLang) {
        return new Promise((resolve, reject) => {
            this.requestQueue.push({
                text,
                sourceLang,
                targetLang,
                resolve,
                reject
            });

            if (!this.isProcessingQueue) {
                this.processQueue();
            }
        });
    }

    // Process queue with rate limiting
    async processQueue() {
        if (this.isProcessingQueue) return;
        this.isProcessingQueue = true;

        while (this.requestQueue.length > 0) {
            const batch = this.requestQueue.splice(0, this.maxConcurrent);

            try {
                await Promise.all(
                    batch.map(req => this.translateNow(req.text, req.sourceLang, req.targetLang)
                        .then(req.resolve)
                        .catch(req.reject)
                    )
                );
            } catch (error) {
                console.error('Batch translation error:', error);
            }

            // Delay before next batch
            if (this.requestQueue.length > 0) {
                await new Promise(resolve => setTimeout(resolve, this.delayBetweenRequests));
            }
        }

        this.isProcessingQueue = false;
    }

    // Actual translation (called by queue processor)
    async translateNow(text, sourceLang = 'en', targetLang = 'fr') {
        try {
            if (!text || text.trim() === '') {
                return text;
            }

            // Check cache first
            const cached = await translationCacheService.get(text, sourceLang, targetLang);
            if (cached) {
                console.log(`✅ Cache hit for: "${text.substring(0, 30)}..."`);
                return cached.translated;
            }

            console.log(`🌐 Translating via AWS: "${text.substring(0, 30)}..."`);

            const command = new TranslateTextCommand({
                Text: text,
                SourceLanguageCode: sourceLang,
                TargetLanguageCode: targetLang,
                Settings: {
                    Formality: 'INFORMAL'
                }
            });

            const response = await this.client.send(command);
            const translation = response.TranslatedText;

            // Cache the translation
            await translationCacheService.set(text, translation, sourceLang, targetLang);

            return translation;
        } catch (error) {
            console.error('❌ Translation error:', error);
            return text;
        }
    }

    // Public method - uses queue
    async translate(text, sourceLang = 'en', targetLang = 'fr') {
        try {
            if (!text || text.trim() === '') {
                return text;
            }

            // Check cache first (before queuing)
            const cached = await translationCacheService.get(text, sourceLang, targetLang);
            if (cached) {
                return cached.translated;
            }

            // Queue for translation
            return await this.queueTranslation(text, sourceLang, targetLang);
        } catch (error) {
            console.error('❌ Translation error:', error);
            return text;
        }
    }

    async translateBulk(texts, sourceLang = 'en', targetLang = 'fr') {
        try {
            const validTexts = texts.filter(text => text && text.trim() !== '');

            if (validTexts.length === 0) {
                return {};
            }

            // Check cache for all texts
            const { results, missing } = await translationCacheService.bulkGet(
                validTexts,
                sourceLang,
                targetLang
            );

            console.log(`✅ Cache hits: ${Object.keys(results).length}/${validTexts.length}`);

            if (missing.length === 0) {
                return results;
            }

            console.log(`🌐 Translating ${missing.length} texts via AWS`);

            // Process in smaller chunks with delays
            const chunkSize = 5; // Smaller chunks
            const translations = {};

            for (let i = 0; i < missing.length; i += chunkSize) {
                const chunk = missing.slice(i, i + chunkSize);

                // Translate chunk
                const chunkPromises = chunk.map(text => this.translate(text, sourceLang, targetLang));
                const chunkResults = await Promise.all(chunkPromises);

                chunk.forEach((text, index) => {
                    translations[text] = chunkResults[index];
                });

                // Delay between chunks
                if (i + chunkSize < missing.length) {
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
            }

            return { ...results, ...translations };
        } catch (error) {
            console.error('❌ Bulk translation error:', error);
            throw error;
        }
    }

    async getCacheStats() {
        return await translationCacheService.getStats();
    }

    async clearCache() {
        translationCacheService.cache = {
            metadata: {
                version: '1.0',
                context: 'food-related-software',
                lastUpdated: new Date().toISOString()
            },
            translations: {}
        };
        await translationCacheService.saveCache();
        console.log('✅ Translation cache cleared');
    }
}

module.exports = new AWSTranslateService();