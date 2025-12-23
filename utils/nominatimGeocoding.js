// utils/nominatimGeocoding.js
/**
 * Nominatim Geocoding Utility
 * Uses OpenStreetMap's Nominatim API to get region from postal codes
 * Works for entire Europe and beyond
 */

// In-memory cache to avoid repeated API calls
const regionCache = new Map();

/**
 * Get region from postal code and country code
 * @param {string} postalCode - Postal/Zip code
 * @param {string} countryCode - ISO country code (e.g., "FR", "DE", "ES")
 * @returns {Promise<string|null>} - Region name or null if not found
 */
async function getRegionFromPostalCode(postalCode, countryCode = "FR") {
    const cacheKey = `${countryCode}-${postalCode}`;

    // Check cache first
    if (regionCache.has(cacheKey)) {
        return regionCache.get(cacheKey);
    }

    try {
        const response = await nominatimQuery(postalCode, countryCode);

        if (response && response.length > 0) {
            const result = response[0];
            let region = null;

            // Nominatim returns display_name in format: "postal_code, city, region, ...more_data, country"
            // For most European countries, region is typically 2-3 items from the end
            const displayName = result.display_name || "";
            const parts = displayName.split(", ");
            
            // Strategy: Work backwards from the end
            // Last item is usually country, second-to-last is often a regional/national division
            // We want the actual region name (Île-de-France, not "France métropolitaine")
            
            if (parts.length >= 3) {
                // For postal codes, typically: [postal_code, city, region, subdivision, country]
                // We want the 3rd item (index 2) for most cases
                // But some have more levels, so we try to find the best match
                
                // Filter out common country divisions like "France métropolitaine"
                const regionCandidates = parts.filter(p => 
                    !p.includes('métropolitaine') && 
                    !p.includes('Overseas') &&
                    !p.match(/^[A-Z]{2}$/) && // ISO country codes
                    p.length > 2 // Ignore very short strings
                );
                
                // Take the region before the last candidate (which is usually country/country division)
                if (regionCandidates.length >= 2) {
                    region = regionCandidates[regionCandidates.length - 2];
                } else if (regionCandidates.length === 1) {
                    region = regionCandidates[0];
                }
            }

            // Cache the result (null if not found)
            regionCache.set(cacheKey, region || null);
            return region || null;
        }

        regionCache.set(cacheKey, null);
        return null;
    } catch (error) {
        console.error(`Error querying Nominatim for ${postalCode}, ${countryCode}:`, error.message);
        return null;
    }
}

/**
 * Query Nominatim API using fetch
 * @private
 */
async function nominatimQuery(postalCode, countryCode) {
    const encodedCountry = encodeURIComponent(countryCode.toUpperCase());
    const encodedPostal = encodeURIComponent(postalCode);
    const url = `https://nominatim.openstreetmap.org/search?postalcode=${encodedPostal}&country=${encodedCountry}&format=json&limit=1`;

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'HalalSales-TruckRouting/1.0'
            },
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        return data;
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`Nominatim API timeout for ${postalCode}, ${countryCode}`);
        }
        throw error;
    }
}

/**
 * Batch get regions for multiple postal codes
 * More efficient than calling getRegionFromPostalCode multiple times
 * @param {Array} postalCodes - Array of {postalCode, countryCode} objects
 * @returns {Promise<Map>} - Map of postal code to region
 */
async function getRegionsForPostalCodes(postalCodes) {
    const results = new Map();

    for (const item of postalCodes) {
        const { postalCode, countryCode } = item;
        const region = await getRegionFromPostalCode(postalCode, countryCode);
        results.set(postalCode, region);
    }

    return results;
}

/**
 * Clear cache (useful for testing or manual reset)
 */
function clearCache() {
    regionCache.clear();
}

/**
 * Get cache stats
 */
function getCacheStats() {
    return {
        cachedEntries: regionCache.size,
        cache: Object.fromEntries(regionCache)
    };
}

module.exports = {
    getRegionFromPostalCode,
    getRegionsForPostalCodes,
    clearCache,
    getCacheStats
};
