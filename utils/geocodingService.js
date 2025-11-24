// utils/geocodingService.js
const axios = require("axios");

// Nominatim rate limit: 1 request per second
// We'll use a queue system to respect this

class GeocodingService {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.lastRequestTime = 0;
        this.RATE_LIMIT_MS = 1100; // 1.1 seconds between requests to be safe
    }

    /**
     * Geocode a single address using Nominatim (OpenStreetMap)
     * @param {Object} address - Address object with street, city, zipCode, country
     * @returns {Promise<{lat: number, lng: number} | null>}
     */
    async geocodeAddress(address) {
        if (!address || (!address.street && !address.city && !address.zipCode)) {
            return null;
        }

        // Build address string
        const addressParts = [
            address.street,
            address.zipCode,
            address.city,
            address.country || "France",
        ].filter(Boolean);

        const addressString = addressParts.join(", ");

        if (!addressString || addressString.trim() === "") {
            return null;
        }

        try {
            // Respect rate limit
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastRequestTime;
            if (timeSinceLastRequest < this.RATE_LIMIT_MS) {
                await this.sleep(this.RATE_LIMIT_MS - timeSinceLastRequest);
            }

            this.lastRequestTime = Date.now();

            const response = await axios.get(
                "https://nominatim.openstreetmap.org/search",
                {
                    params: {
                        q: addressString,
                        format: "json",
                        limit: 1,
                        addressdetails: 1,
                    },
                    headers: {
                        "User-Agent": "CRM-Application/1.0", // Required by Nominatim
                    },
                    timeout: 10000,
                }
            );

            if (response.data && response.data.length > 0) {
                const result = response.data[0];
                return {
                    lat: parseFloat(result.lat),
                    lng: parseFloat(result.lon),
                    displayName: result.display_name,
                    confidence: result.importance || 0,
                };
            }

            // If full address fails, try with just city and zip code
            if (address.city || address.zipCode) {
                await this.sleep(this.RATE_LIMIT_MS);
                this.lastRequestTime = Date.now();

                const fallbackAddress = [
                    address.zipCode,
                    address.city,
                    address.country || "France",
                ]
                    .filter(Boolean)
                    .join(", ");

                const fallbackResponse = await axios.get(
                    "https://nominatim.openstreetmap.org/search",
                    {
                        params: {
                            q: fallbackAddress,
                            format: "json",
                            limit: 1,
                        },
                        headers: {
                            "User-Agent": "CRM-Application/1.0",
                        },
                        timeout: 10000,
                    }
                );

                if (fallbackResponse.data && fallbackResponse.data.length > 0) {
                    const result = fallbackResponse.data[0];
                    return {
                        lat: parseFloat(result.lat),
                        lng: parseFloat(result.lon),
                        displayName: result.display_name,
                        confidence: (result.importance || 0) * 0.8, // Lower confidence for fallback
                        isFallback: true,
                    };
                }
            }

            return null;
        } catch (error) {
            console.error(`Geocoding error for "${addressString}":`, error.message);
            return null;
        }
    }

    /**
     * Batch geocode multiple customers
     * @param {Array} customers - Array of customer objects
     * @param {Function} progressCallback - Optional callback for progress updates
     * @returns {Promise<{success: number, failed: number, results: Array}>}
     */
    async batchGeocodeCustomers(customers, progressCallback = null) {
        const results = {
            success: 0,
            failed: 0,
            skipped: 0,
            results: [],
        };

        for (let i = 0; i < customers.length; i++) {
            const customer = customers[i];

            // Skip if already geocoded
            if (
                customer.coordinates &&
                customer.coordinates.lat &&
                customer.coordinates.lng
            ) {
                results.skipped++;
                results.results.push({
                    CardCode: customer.CardCode,
                    status: "skipped",
                    reason: "Already geocoded",
                });
                continue;
            }

            // Try billing address first, then delivery address
            const addressToGeocode =
                customer.address && (customer.address.street || customer.address.city)
                    ? customer.address
                    : customer.deliveryAddress;

            if (!addressToGeocode) {
                results.failed++;
                results.results.push({
                    CardCode: customer.CardCode,
                    status: "failed",
                    reason: "No address available",
                });
                continue;
            }

            const coords = await this.geocodeAddress(addressToGeocode);

            if (coords) {
                results.success++;
                results.results.push({
                    CardCode: customer.CardCode,
                    CardName: customer.CardName,
                    status: "success",
                    coordinates: coords,
                });
            } else {
                results.failed++;
                results.results.push({
                    CardCode: customer.CardCode,
                    status: "failed",
                    reason: "Geocoding returned no results",
                });
            }

            // Progress callback
            if (progressCallback) {
                progressCallback({
                    current: i + 1,
                    total: customers.length,
                    percent: Math.round(((i + 1) / customers.length) * 100),
                    lastProcessed: customer.CardCode,
                });
            }
        }

        return results;
    }

    /**
     * Get coordinates for a customer, geocoding if necessary
     * @param {Object} customer - Customer object
     * @returns {Promise<{lat: number, lng: number} | null>}
     */
    async getCustomerCoordinates(customer) {
        // Return existing coordinates if available
        if (
            customer.coordinates &&
            customer.coordinates.lat &&
            customer.coordinates.lng
        ) {
            return {
                lat: customer.coordinates.lat,
                lng: customer.coordinates.lng,
            };
        }

        // Try to geocode
        const address =
            customer.address && (customer.address.street || customer.address.city)
                ? customer.address
                : customer.deliveryAddress;

        return await this.geocodeAddress(address);
    }

    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

// Export singleton instance
const geocodingService = new GeocodingService();

module.exports = {
    geocodingService,
    GeocodingService,
};