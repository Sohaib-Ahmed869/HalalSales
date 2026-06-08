// scripts/testContactDiscovery.js
// Manual end-to-end test for the grounded contact discovery pipeline.
// Usage:
//   node scripts/testContactDiscovery.js "Company Name" "Country"
// Example:
//   node scripts/testContactDiscovery.js "Develey Senf & Feinkost" "Germany"
//
// Requires GOOGLE_API_KEY + GOOGLE_SEARCH_ENGINE_ID in .env and the
// "Custom Search API" enabled on the Google Cloud project.

require('dotenv').config();
const webDiscovery = require('../agents/webDiscovery');

(async () => {
    const vendorName = process.argv[2] || 'Develey Senf & Feinkost';
    const country = process.argv[3] || 'Germany';
    const productCategory = process.argv[4] || 'food products';

    if (!webDiscovery.isConfigured()) {
        console.error('❌ GOOGLE_API_KEY / GOOGLE_SEARCH_ENGINE_ID not set in .env');
        process.exit(1);
    }

    console.log(`\n🔎 Discovering contact for: ${vendorName} (${country})\n`);
    const start = Date.now();
    const result = await webDiscovery.discover({ vendorName, country, productCategory });
    const secs = ((Date.now() - start) / 1000).toFixed(1);

    console.log('Result:');
    console.dir(result, { depth: null });
    console.log(`\n⏱  Took ${secs}s`);
    process.exit(0);
})().catch(err => {
    console.error('Pipeline error:', err.message);
    process.exit(1);
});
