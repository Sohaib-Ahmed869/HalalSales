// controllers/map.controller.js
const Customer = require("../models/Customer");
const Invoice = require("../models/Invoice");
const SalesOrder = require("../models/SalesOrder");
const Quotation = require("../models/Quotation");
const { geocodingService } = require("../utils/geocodingService");

/**
 * Get color for invoice based on amount
 * Uses gradient from light red (low) to dark red (high)
 */
const getInvoiceColor = (amount, minAmount, maxAmount) => {
    if (maxAmount === minAmount) return "#e74c3c"; // Default red

    // Normalize amount to 0-1 range
    const normalized = (amount - minAmount) / (maxAmount - minAmount);

    // Color gradient from light red to dark red
    // Low sales: #ffcccc (light red/pink)
    // Medium sales: #e74c3c (red)
    // High sales: #8b0000 (dark red)

    if (normalized < 0.33) {
        // Light red - low sales
        return "#ff9999";
    } else if (normalized < 0.66) {
        // Medium red
        return "#e74c3c";
    } else {
        // Dark red - high sales
        return "#8b0000";
    }
};

/**
 * Get all documents (invoices, orders, quotations) within a date range
 * with customer coordinates for map display
 */
exports.getDocumentsByDateRange = async (req, res) => {
    try {
        const { startDate, endDate, type = "all", includePotentialCustomers = "false" } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                message: "startDate and endDate are required",
            });
        }

        const start = new Date(startDate);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);

        console.log(`Fetching map data from ${start} to ${end}, type: ${type}, potential: ${includePotentialCustomers}`);

        const results = {
            invoices: [],
            orders: [],
            quotations: [],
            customers: [],
            potentialCustomers: [],
            stats: {
                totalInvoices: 0,
                totalOrders: 0,
                totalQuotations: 0,
                totalCustomers: 0,
                totalPotentialCustomers: 0,
                invoiceAmountRange: { min: 0, max: 0 },
            },
        };

        // Get all customers with coordinates
        const customersWithCoords = await Customer.find({
            "coordinates.lat": { $exists: true, $ne: null },
        })
            .select("CardCode CardName coordinates address deliveryAddress")
            .lean();

        const customerMap = new Map();
        customersWithCoords.forEach((c) => {
            customerMap.set(c.CardCode, c);
        });

        console.log(`Found ${customersWithCoords.length} customers with coordinates`);

        // Fetch Invoices
        if (type === "all" || type === "invoice") {
            const invoices = await Invoice.find({
                DocDate: { $gte: start, $lte: end },
            })
                .select("DocEntry DocNum DocDate CardCode CardName DocTotal Address DocumentStatus")
                .lean();

            const amounts = invoices.map((inv) => inv.DocTotal || 0).filter((a) => a > 0);
            if (amounts.length > 0) {
                results.stats.invoiceAmountRange.min = Math.min(...amounts);
                results.stats.invoiceAmountRange.max = Math.max(...amounts);
            }

            for (const invoice of invoices) {
                const customer = customerMap.get(invoice.CardCode);
                if (customer && customer.coordinates) {
                    results.invoices.push({
                        type: "invoice",
                        docEntry: invoice.DocEntry,
                        docNum: invoice.DocNum,
                        docDate: invoice.DocDate,
                        cardCode: invoice.CardCode,
                        cardName: invoice.CardName || customer.CardName,
                        amount: invoice.DocTotal || 0,
                        status: invoice.DocumentStatus,
                        coordinates: customer.coordinates,
                        color: getInvoiceColor(
                            invoice.DocTotal || 0,
                            results.stats.invoiceAmountRange.min,
                            results.stats.invoiceAmountRange.max
                        ),
                    });
                }
            }
            results.stats.totalInvoices = results.invoices.length;
        }

        let orders = [];

        // Fetch Sales Orders
        if (type === "all" || type === "order") {
            orders = await SalesOrder.find({
                StartDeliveryDate: { $gte: start, $lte: end },
            })
                .select("DocEntry DocNum DocDate StartDeliveryDate DocDueDate CardCode CardName DocTotal DocumentStatus")
                .lean();

            for (const order of orders) {
                const customer = customerMap.get(order.CardCode);
                if (customer && customer.coordinates) {
                    results.orders.push({
                        type: "order",
                        docEntry: order.DocEntry,
                        docNum: order.DocNum,
                        docDate: order.DocDate,
                        cardCode: order.CardCode,
                        cardName: order.CardName || customer.CardName,
                        amount: order.DocTotal || 0,
                        status: order.DocumentStatus,
                        coordinates: customer.coordinates,
                        color: "#3498db",
                    });
                }
            }
            results.stats.totalOrders = results.orders.length;
        }

        // Fetch Quotations
        // Line ~170: Fetch Quotations - CHANGE THIS
        if (type === "all" || type === "quotation") {
            const quotations = await Quotation.find({
                DocDueDate: { $gte: start, $lte: end }, // CHANGED from DocDate
            })
                .select("DocEntry DocNum DocDate DocDueDate CardCode CardName DocTotal DocumentStatus approvalStatus") // ADDED DocDueDate
                .lean();

            for (const quotation of quotations) {
                const customer = customerMap.get(quotation.CardCode);
                if (customer && customer.coordinates) {
                    results.quotations.push({
                        type: "quotation",
                        docEntry: quotation.DocEntry,
                        docNum: quotation.DocNum,
                        docDate: quotation.DocDate,
                        cardCode: quotation.CardCode,
                        cardName: quotation.CardName || customer.CardName,
                        amount: quotation.DocTotal || 0,
                        status: quotation.DocumentStatus,
                        approvalStatus: quotation.approvalStatus,
                        coordinates: customer.coordinates,
                        color: "#27ae60",
                    });
                }
            }
            results.stats.totalQuotations = results.quotations.length;
        }

        // Get customers who placed orders in date range
        // Get customers who placed orders in date range WITH KPIS
        if (type === "all" || type === "customer") {
            const uniqueCustomerCodes = new Set();
            for (const order of orders) {
                uniqueCustomerCodes.add(order.CardCode);
            }

            // CHANGED: Fetch customer KPIs
            for (const cardCode of uniqueCustomerCodes) {
                const customer = customerMap.get(cardCode);
                if (customer && customer.coordinates) {
                    // Calculate customer KPIs
                    const customerInvoices = await Invoice.find({ CardCode: cardCode })
                        .select("DocTotal DocDate")
                        .lean();

                    const totalSales = customerInvoices.reduce((sum, inv) => sum + (inv.DocTotal || 0), 0);
                    const lastInvoice = customerInvoices.length > 0
                        ? customerInvoices.sort((a, b) => new Date(b.DocDate) - new Date(a.DocDate))[0]
                        : null;

                    const avgOrderValue = customerInvoices.length > 0
                        ? totalSales / customerInvoices.length
                        : 0;

                    results.customers.push({
                        type: "customer",
                        cardCode: customer.CardCode,
                        cardName: customer.CardName,
                        address: customer.address || customer.deliveryAddress,
                        coordinates: customer.coordinates,
                        color: "#f39c12",
                        kpis: {
                            totalSales: totalSales,
                            totalInvoices: customerInvoices.length,
                            lastInvoiceDate: lastInvoice ? lastInvoice.DocDate : null,
                            avgOrderValue: avgOrderValue,
                        },
                    });
                }
            }
            results.stats.totalCustomers = results.customers.length;
        }

        console.log(includePotentialCustomers);

        // Get potential customers (those WITHOUT orders in date range)
        if (includePotentialCustomers === "true") {
            const customersWithOrders = new Set(orders.map(o => o.CardCode));

            for (const customer of customersWithCoords) {
                if (!customersWithOrders.has(customer.CardCode)) {
                    results.potentialCustomers.push({
                        type: "potentialCustomer",
                        cardCode: customer.CardCode,
                        cardName: customer.CardName,
                        address: customer.address || customer.deliveryAddress,
                        coordinates: customer.coordinates,
                        color: "#95a5a6", // Gray for potential customers
                    });
                }
            }
            results.stats.totalPotentialCustomers = results.potentialCustomers.length;
        }

        res.json({
            success: true,
            data: results,
            dateRange: { startDate: start, endDate: end },
        });
    } catch (error) {
        console.error("Error fetching documents for map:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching map data",
            error: error.message,
        });
    }
};

/**
 * Get documents for a specific customer
 */
exports.getCustomerDocumentsForMap = async (req, res) => {
    try {
        const { cardCode } = req.params;
        const { type = "all", startDate, endDate } = req.query;

        if (!cardCode) {
            return res.status(400).json({
                success: false,
                message: "cardCode is required",
            });
        }

        // Find customer
        const customer = await Customer.findOne({ CardCode: cardCode }).lean();
        if (!customer) {
            return res.status(404).json({
                success: false,
                message: "Customer not found",
            });
        }

        // Check if customer has coordinates, if not try to geocode
        let coordinates = customer.coordinates;
        if (!coordinates || !coordinates.lat) {
            const address = customer.address || customer.deliveryAddress;
            if (address) {
                coordinates = await geocodingService.geocodeAddress(address);
                if (coordinates) {
                    // Save coordinates for future use
                    await Customer.updateOne(
                        { _id: customer._id },
                        {
                            $set: {
                                coordinates: {
                                    lat: coordinates.lat,
                                    lng: coordinates.lng,
                                    geocodedAt: new Date(),
                                    geocodeSource: "nominatim",
                                },
                            },
                        }
                    );
                }
            }
        }

        if (!coordinates || !coordinates.lat) {
            return res.status(400).json({
                success: false,
                message: "Customer address could not be geocoded",
            });
        }

        const results = {
            customer: {
                cardCode: customer.CardCode,
                cardName: customer.CardName,
                email: customer.Email,
                phone: customer.phoneNumber,
                address: customer.address,
                coordinates: coordinates,
            },
            invoices: [],
            orders: [],
            quotations: [],
        };

        // Build date filter if provided
        const dateFilter = {};
        if (startDate) {
            dateFilter.$gte = new Date(startDate);
        }
        if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            dateFilter.$lte = end;
        }

        const baseQuery = { CardCode: cardCode };
        if (Object.keys(dateFilter).length > 0) {
            baseQuery.DocDueDate = dateFilter; // CHANGED from DocDate
        }

        // Fetch documents based on type
        if (type === "all" || type === "invoice") {
            const invoices = await Invoice.find(baseQuery)
                .select("DocEntry DocNum DocDate DocDueDate DocTotal DocumentStatus") // ADDED DocDueDate
                .sort({ DocDueDate: -1 }) // CHANGED from DocDate
                .lean();

            // Calculate color range
            const amounts = invoices.map((i) => i.DocTotal || 0).filter((a) => a > 0);
            const minAmount = amounts.length > 0 ? Math.min(...amounts) : 0;
            const maxAmount = amounts.length > 0 ? Math.max(...amounts) : 0;

            results.invoices = invoices.map((inv) => ({
                type: "invoice",
                docEntry: inv.DocEntry,
                docNum: inv.DocNum,
                docDate: inv.DocDate,
                amount: inv.DocTotal || 0,
                status: inv.DocumentStatus,
                color: getInvoiceColor(inv.DocTotal || 0, minAmount, maxAmount),
            }));
        }

        if (type === "all" || type === "order") {
            const orders = await SalesOrder.find(baseQuery)
                .select("DocEntry DocNum DocDate DocTotal DocumentStatus")
                .sort({ DocDate: -1 })
                .lean();

            results.orders = orders.map((order) => ({
                type: "order",
                docEntry: order.DocEntry,
                docNum: order.DocNum,
                docDate: order.DocDate,
                amount: order.DocTotal || 0,
                status: order.DocumentStatus,
                color: "#3498db",
            }));
        }

        if (type === "all" || type === "quotation") {
            const quotations = await Quotation.find(baseQuery)
                .select("DocEntry DocNum DocDate DocTotal DocumentStatus approvalStatus")
                .sort({ DocDate: -1 })
                .lean();

            results.quotations = quotations.map((q) => ({
                type: "quotation",
                docEntry: q.DocEntry,
                docNum: q.DocNum,
                docDate: q.DocDate,
                amount: q.DocTotal || 0,
                status: q.DocumentStatus,
                approvalStatus: q.approvalStatus,
                color: "#27ae60",
            }));
        }

        res.json({
            success: true,
            data: results,
        });
    } catch (error) {
        console.error("Error fetching customer documents for map:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching customer map data",
            error: error.message,
        });
    }
};

// controllers/map.controller.js - REPLACE your batchGeocodeCustomers with this

const axios = require("axios");

/**
 * Batch geocode customers
 * 
 * Query params:
 * - limit: number of customers to process (default: 1000)
 * - provider: "photon" (free/fast) or "google" (paid/accurate)
 * 
 * Example: POST /api/map/geocoding/batch?limit=1000&provider=photon
 */
exports.batchGeocodeCustomers = async (req, res) => {
    try {
        const { limit = 100000, provider = "photon" } = req.query;
        const startTime = Date.now();

        // Validate provider
        if (!["photon", "google"].includes(provider)) {
            return res.status(400).json({
                success: false,
                message: "Invalid provider. Use 'photon' (free) or 'google' (paid)",
            });
        }

        // Check Google API key if using Google
        if (provider === "google" && !process.env.GOOGLE_MAPS_API_KEY) {
            return res.status(400).json({
                success: false,
                message: "GOOGLE_MAPS_API_KEY not configured in environment",
            });
        }

        // Find customers without coordinates
        const customersToGeocode = await Customer.find({
            $or: [
                { coordinates: { $exists: false } },
                { "coordinates.lat": { $exists: false } },
                { "coordinates.lat": null },
            ],
            $and: [
                {
                    $or: [
                        { "address.street": { $exists: true, $ne: "" } },
                        { "address.city": { $exists: true, $ne: "" } },
                        { "deliveryAddress.street": { $exists: true, $ne: "" } },
                        { "deliveryAddress.city": { $exists: true, $ne: "" } },
                    ],
                },
            ],
        })
            .select("CardCode CardName address deliveryAddress")
            .limit(parseInt(limit))
            .lean();

        console.log(`Found ${customersToGeocode.length} customers to geocode with ${provider}`);

        if (customersToGeocode.length === 0) {
            return res.json({
                success: true,
                message: "No customers need geocoding",
                results: { success: 0, failed: 0, total: 0 },
            });
        }

        // Select geocoding function based on provider
        const geocodeFunction = provider === "google" ? geocodeWithGoogle : geocodeWithPhoton;
        const BATCH_SIZE = provider === "google" ? 10 : 5; // Google allows more parallel
        const DELAY_MS = provider === "google" ? 100 : 200;

        const results = { success: 0, failed: 0, errors: [] };
        const bulkOps = [];

        // Process in parallel batches
        for (let i = 0; i < customersToGeocode.length; i += BATCH_SIZE) {
            const batch = customersToGeocode.slice(i, i + BATCH_SIZE);

            const batchResults = await Promise.allSettled(
                batch.map(customer => geocodeFunction(customer))
            );

            batchResults.forEach((result, index) => {
                const customer = batch[index];
                if (result.status === "fulfilled" && result.value) {
                    bulkOps.push({
                        updateOne: {
                            filter: { CardCode: customer.CardCode },
                            update: {
                                $set: {
                                    coordinates: {
                                        lat: result.value.lat,
                                        lng: result.value.lng,
                                        geocodedAt: new Date(),
                                        geocodeSource: provider,
                                        displayName: result.value.displayName,
                                    },
                                },
                            },
                        },
                    });
                    results.success++;
                } else {
                    results.failed++;
                    if (result.reason) {
                        results.errors.push({ CardCode: customer.CardCode, error: result.reason.message });
                    }
                }
            });

            // Delay between batches
            if (i + BATCH_SIZE < customersToGeocode.length) {
                await sleep(DELAY_MS);
            }

            // Log progress every 100
            if ((i + BATCH_SIZE) % 100 === 0) {
                console.log(`Progress: ${Math.min(i + BATCH_SIZE, customersToGeocode.length)}/${customersToGeocode.length} (${results.success} success)`);
            }
        }

        // Bulk update all at once
        let updateCount = 0;
        if (bulkOps.length > 0) {
            const bulkResult = await Customer.bulkWrite(bulkOps, { ordered: false });
            updateCount = bulkResult.modifiedCount || bulkOps.length;
        }

        const totalTime = Date.now() - startTime;

        res.json({
            success: true,
            message: `Geocoded ${results.success} of ${customersToGeocode.length} customers in ${(totalTime / 1000).toFixed(1)}s`,
            provider,
            results: {
                total: customersToGeocode.length,
                success: results.success,
                failed: results.failed,
                updated: updateCount,
                processingTimeMs: totalTime,
                customersPerSecond: Math.round((customersToGeocode.length / totalTime) * 1000),
                sampleErrors: results.errors.slice(0, 10),
            },
        });
    } catch (error) {
        console.error("Error batch geocoding:", error);
        res.status(500).json({
            success: false,
            message: "Error geocoding customers",
            error: error.message,
        });
    }
};

// ============================================
// PHOTON (Free - Komoot/OpenStreetMap)
// ============================================
async function geocodeWithPhoton(customer) {
    const address = buildAddressString(customer);
    if (!address) return null;

    try {
        const response = await axios.get("https://photon.komoot.io/api/", {
            params: { q: address, limit: 1, lang: "en" },
            timeout: 8000,
        });

        if (response.data?.features?.length > 0) {
            const feature = response.data.features[0];
            const [lng, lat] = feature.geometry.coordinates;
            return {
                lat,
                lng,
                displayName: feature.properties.name || address,
            };
        }
        return null;
    } catch (error) {
        console.error(`Photon error for ${customer.CardCode}:`, error.message);
        return null;
    }
}

// ============================================
// GOOGLE MAPS (Paid - More Accurate)
// ============================================
async function geocodeWithGoogle(customer) {
    const address = buildAddressString(customer);
    if (!address) return null;

    try {
        const response = await axios.get(
            "https://maps.googleapis.com/maps/api/geocode/json",
            {
                params: {
                    address: address,
                    key: process.env.GOOGLE_MAPS_API_KEY,
                },
                timeout: 8000,
            }
        );

        if (response.data.status === "OK" && response.data.results.length > 0) {
            const result = response.data.results[0];
            return {
                lat: result.geometry.location.lat,
                lng: result.geometry.location.lng,
                displayName: result.formatted_address,
            };
        }

        if (response.data.status === "OVER_QUERY_LIMIT") {
            console.error("Google API quota exceeded!");
        }

        return null;
    } catch (error) {
        console.error(`Google error for ${customer.CardCode}:`, error.message);
        return null;
    }
}

// ============================================
// HELPERS
// ============================================
function buildAddressString(customer) {
    const address = (customer.address?.street || customer.address?.city)
        ? customer.address
        : customer.deliveryAddress;

    if (!address) return null;

    const parts = [
        address.street,
        address.zipCode,
        address.city,
        address.country || "France"
    ].filter(Boolean);

    const result = parts.join(", ");
    return (result && result !== "France") ? result : null;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Geocode with Nominatim (OpenStreetMap)
 */
async function geocodeWithNominatim(addressString) {
    try {
        const response = await axios.get(
            "https://nominatim.openstreetmap.org/search",
            {
                params: {
                    q: addressString,
                    format: "json",
                    limit: 1,
                },
                headers: {
                    "User-Agent": "CRM-Application/1.0",
                },
                timeout: 5000,
            }
        );

        if (response.data && response.data.length > 0) {
            const result = response.data[0];
            return {
                lat: parseFloat(result.lat),
                lng: parseFloat(result.lon),
                displayName: result.display_name,
            };
        }
        return null;
    } catch (error) {
        return null;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get geocoding statistics
 */
exports.getGeocodingStats = async (req, res) => {
    try {
        const [totalCustomers, geocodedCustomers, customersWithAddress] =
            await Promise.all([
                Customer.countDocuments(),
                Customer.countDocuments({
                    "coordinates.lat": { $exists: true, $ne: null },
                }),
                Customer.countDocuments({
                    $or: [
                        { "address.street": { $exists: true, $ne: "" } },
                        { "address.city": { $exists: true, $ne: "" } },
                        { "deliveryAddress.street": { $exists: true, $ne: "" } },
                        { "deliveryAddress.city": { $exists: true, $ne: "" } },
                    ],
                }),
            ]);

        res.json({
            success: true,
            stats: {
                totalCustomers,
                geocodedCustomers,
                customersWithAddress,
                pendingGeocoding: customersWithAddress - geocodedCustomers,
                geocodingPercentage:
                    customersWithAddress > 0
                        ? Math.round((geocodedCustomers / customersWithAddress) * 100)
                        : 0,
            },
        });
    } catch (error) {
        console.error("Error fetching geocoding stats:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching geocoding statistics",
            error: error.message,
        });
    }
};

/**
 * Manually set coordinates for a customer
 */
exports.setCustomerCoordinates = async (req, res) => {
    try {
        const { cardCode } = req.params;
        const { lat, lng } = req.body;

        if (!lat || !lng) {
            return res.status(400).json({
                success: false,
                message: "lat and lng are required",
            });
        }

        const result = await Customer.updateOne(
            { CardCode: cardCode },
            {
                $set: {
                    coordinates: {
                        lat: parseFloat(lat),
                        lng: parseFloat(lng),
                        geocodedAt: new Date(),
                        geocodeSource: "manual",
                    },
                },
            }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({
                success: false,
                message: "Customer not found",
            });
        }

        res.json({
            success: true,
            message: "Coordinates updated successfully",
        });
    } catch (error) {
        console.error("Error setting customer coordinates:", error);
        res.status(500).json({
            success: false,
            message: "Error setting coordinates",
            error: error.message,
        });
    }
};

/**
 * Search customers for map selection (autocomplete)
 */
exports.searchCustomersForMap = async (req, res) => {
    try {
        const { search } = req.query;

        if (!search || search.length < 2) {
            return res.json({ success: true, customers: [] });
        }

        const customers = await Customer.find({
            $or: [
                { CardCode: { $regex: search, $options: "i" } },
                { CardName: { $regex: search, $options: "i" } },
            ],
            "coordinates.lat": { $exists: true, $ne: null },
        })
            .select("CardCode CardName Email coordinates")
            .limit(20)
            .lean();

        res.json({
            success: true,
            customers: customers.map((c) => ({
                cardCode: c.CardCode,
                cardName: c.CardName,
                email: c.Email,
                hasCoordinates: !!(c.coordinates && c.coordinates.lat),
            })),
        });
    } catch (error) {
        console.error("Error searching customers for map:", error);
        res.status(500).json({
            success: false,
            message: "Error searching customers",
            error: error.message,
        });
    }
};

/**
 * Get customers geocoded outside France
 * France bounding box: lat 41.3 to 51.1, lng -5.1 to 9.6
 */
exports.getCustomersOutsideFrance = async (req, res) => {
    try {
        // France approximate bounding box
        const FRANCE_BOUNDS = {
            minLat: 41.3,
            maxLat: 51.1,
            minLng: -5.1,
            maxLng: 9.6,
        };

        const customersOutside = await Customer.find({
            "coordinates.lat": { $exists: true, $ne: null },
            $or: [
                { "coordinates.lat": { $lt: FRANCE_BOUNDS.minLat } },
                { "coordinates.lat": { $gt: FRANCE_BOUNDS.maxLat } },
                { "coordinates.lng": { $lt: FRANCE_BOUNDS.minLng } },
                { "coordinates.lng": { $gt: FRANCE_BOUNDS.maxLng } },
            ],
        })
            .select("CardCode CardName address deliveryAddress coordinates Email phoneNumber")
            .lean();

        // Format response with full address for easy review
        const formatted = customersOutside.map(c => {
            const addr = c.address || c.deliveryAddress || {};
            return {
                CardCode: c.CardCode,
                CardName: c.CardName,
                Email: c.Email,
                phone: c.phoneNumber,
                address: {
                    street: addr.street,
                    zipCode: addr.zipCode,
                    city: addr.city,
                    country: addr.country,
                    fullAddress: [addr.street, addr.zipCode, addr.city, addr.country].filter(Boolean).join(", "),
                },
                currentCoordinates: {
                    lat: c.coordinates.lat,
                    lng: c.coordinates.lng,
                    source: c.coordinates.geocodeSource,
                },
                googleMapsLink: `https://www.google.com/maps?q=${c.coordinates.lat},${c.coordinates.lng}`,
            };
        });

        res.json({
            success: true,
            count: formatted.length,
            customers: formatted,
        });
    } catch (error) {
        console.error("Error finding customers outside France:", error);
        res.status(500).json({
            success: false,
            message: "Error finding customers",
            error: error.message,
        });
    }
};

/**
 * Verify and fix a single customer's coordinates using Google
 * POST /api/map/customer/:cardCode/verify-location
 * Body: { useGoogle: true } - to re-geocode with Google
 * Body: { lat: number, lng: number } - to manually set coordinates
 */
exports.verifyAndFixCustomerLocation = async (req, res) => {
    try {
        const { cardCode } = req.params;
        const { useGoogle, lat, lng } = req.body;

        const customer = await Customer.findOne({ CardCode: cardCode });
        if (!customer) {
            return res.status(404).json({
                success: false,
                message: "Customer not found",
            });
        }

        // Build address string
        const addr = customer.address || customer.deliveryAddress || {};
        const addressString = [addr.street, addr.zipCode, addr.city, addr.country || "France"]
            .filter(Boolean)
            .join(", ");

        let newCoordinates = null;
        let source = "manual";

        if (lat && lng) {
            // Manual coordinates provided
            newCoordinates = { lat: parseFloat(lat), lng: parseFloat(lng) };
            source = "manual";
        } else if (useGoogle) {
            // Re-geocode with Google
            if (!process.env.GOOGLE_MAPS_API_KEY) {
                return res.status(400).json({
                    success: false,
                    message: "GOOGLE_MAPS_API_KEY not configured",
                });
            }

            const googleResult = await geocodeWithGoogleSingle(addressString);
            if (googleResult) {
                newCoordinates = { lat: googleResult.lat, lng: googleResult.lng };
                source = "google";
            } else {
                return res.status(400).json({
                    success: false,
                    message: "Google could not geocode this address",
                    address: addressString,
                });
            }
        } else {
            return res.status(400).json({
                success: false,
                message: "Provide either { useGoogle: true } or { lat, lng }",
            });
        }

        // Check if new coordinates are in France
        const FRANCE_BOUNDS = { minLat: 41.3, maxLat: 51.1, minLng: -5.1, maxLng: 9.6 };
        const isInFrance =
            newCoordinates.lat >= FRANCE_BOUNDS.minLat &&
            newCoordinates.lat <= FRANCE_BOUNDS.maxLat &&
            newCoordinates.lng >= FRANCE_BOUNDS.minLng &&
            newCoordinates.lng <= FRANCE_BOUNDS.maxLng;

        // Update customer
        const oldCoordinates = customer.coordinates;
        customer.coordinates = {
            lat: newCoordinates.lat,
            lng: newCoordinates.lng,
            geocodedAt: new Date(),
            geocodeSource: source,
        };
        await customer.save();

        res.json({
            success: true,
            message: "Coordinates updated",
            customer: {
                CardCode: customer.CardCode,
                CardName: customer.CardName,
                address: addressString,
            },
            oldCoordinates: oldCoordinates ? { lat: oldCoordinates.lat, lng: oldCoordinates.lng } : null,
            newCoordinates,
            source,
            isInFrance,
            googleMapsLink: `https://www.google.com/maps?q=${newCoordinates.lat},${newCoordinates.lng}`,
        });
    } catch (error) {
        console.error("Error verifying customer location:", error);
        res.status(500).json({
            success: false,
            message: "Error updating coordinates",
            error: error.message,
        });
    }
};

exports.fixCustomersOutsideFrance = async (req, res) => {
    try {
        if (!process.env.GOOGLE_MAPS_API_KEY) {
            return res.status(400).json({
                success: false,
                message: "GOOGLE_MAPS_API_KEY not configured",
            });
        }

        // Metropolitan France bounds
        const FRANCE_BOUNDS = { minLat: 41.3, maxLat: 51.1, minLng: -5.1, maxLng: 9.6 };

        // French overseas territories bounds (approximate)
        const OVERSEAS_BOUNDS = {
            // Réunion (974xx)
            reunion: { minLat: -21.4, maxLat: -20.8, minLng: 55.2, maxLng: 55.9 },
            // Mayotte (976xx)
            mayotte: { minLat: -13.1, maxLat: -12.6, minLng: 44.9, maxLng: 45.4 },
            // Martinique (972xx)
            martinique: { minLat: 14.3, maxLat: 14.9, minLng: -61.3, maxLng: -60.8 },
            // Guadeloupe (971xx)
            guadeloupe: { minLat: 15.8, maxLat: 16.6, minLng: -61.9, maxLng: -61.0 },
            // French Guiana (973xx)
            guyane: { minLat: 2.0, maxLat: 6.0, minLng: -55.0, maxLng: -51.5 },
            // Saint-Barthélemy (97133)
            stbarth: { minLat: 17.85, maxLat: 17.97, minLng: -62.92, maxLng: -62.78 },
            // Saint-Martin (97150)
            stmartin: { minLat: 18.0, maxLat: 18.13, minLng: -63.16, maxLng: -62.97 },
            // New Caledonia (988xx)
            newcaledonia: { minLat: -23.0, maxLat: -19.5, minLng: 163.5, maxLng: 169.0 },
        };

        // Helper: Check if coordinates are in any valid French territory
        function isInFrenchTerritory(lat, lng) {
            // Check metropolitan France
            if (lat >= FRANCE_BOUNDS.minLat && lat <= FRANCE_BOUNDS.maxLat &&
                lng >= FRANCE_BOUNDS.minLng && lng <= FRANCE_BOUNDS.maxLng) {
                return { valid: true, territory: "metropolitan" };
            }

            // Check overseas territories
            for (const [name, bounds] of Object.entries(OVERSEAS_BOUNDS)) {
                if (lat >= bounds.minLat && lat <= bounds.maxLat &&
                    lng >= bounds.minLng && lng <= bounds.maxLng) {
                    return { valid: true, territory: name };
                }
            }

            return { valid: false, territory: null };
        }

        // Helper: Check if postal code indicates overseas territory
        function isOverseasPostalCode(zipCode) {
            if (!zipCode) return false;
            const zip = zipCode.toString().replace(/\s/g, "");
            return zip.startsWith("97") || zip.startsWith("98");
        }

        // Helper: Get expected territory from postal code
        function getExpectedTerritory(zipCode) {
            if (!zipCode) return null;
            const zip = zipCode.toString().replace(/\s/g, "");

            if (zip.startsWith("971")) return "guadeloupe";
            if (zip.startsWith("972")) return "martinique";
            if (zip.startsWith("973")) return "guyane";
            if (zip.startsWith("974")) return "reunion";
            if (zip.startsWith("976")) return "mayotte";
            if (zip.startsWith("97133")) return "stbarth";
            if (zip.startsWith("97150")) return "stmartin";
            if (zip.startsWith("988")) return "newcaledonia";

            return null;
        }

        // Find customers with coordinates outside ALL French territories
        const allCustomersWithCoords = await Customer.find({
            "coordinates.lat": { $exists: true, $ne: null },
        })
            .select("CardCode CardName address deliveryAddress coordinates")
            .lean();

        // Filter to only those truly outside French territories
        const customersOutside = allCustomersWithCoords.filter(customer => {
            const check = isInFrenchTerritory(
                customer.coordinates.lat,
                customer.coordinates.lng
            );
            return !check.valid;
        });

        console.log(`Found ${customersOutside.length} customers outside all French territories to re-geocode`);

        if (customersOutside.length === 0) {
            return res.json({
                success: true,
                message: "No customers found outside French territories",
                results: { total: 0 },
            });
        }

        const results = {
            fixed: 0,
            stillOutside: 0,
            failed: 0,
            overseas: 0,
            details: []
        };

        for (const customer of customersOutside) {
            const addr = customer.address || customer.deliveryAddress || {};
            const zipCode = addr.zipCode;
            const expectedTerritory = getExpectedTerritory(zipCode);

            // Build address string - use territory-specific country for overseas
            let countryHint = "France";
            if (expectedTerritory === "reunion") countryHint = "Réunion, France";
            else if (expectedTerritory === "mayotte") countryHint = "Mayotte, France";
            else if (expectedTerritory === "martinique") countryHint = "Martinique, France";
            else if (expectedTerritory === "guadeloupe") countryHint = "Guadeloupe, France";
            else if (expectedTerritory === "guyane") countryHint = "French Guiana";
            else if (expectedTerritory === "stbarth") countryHint = "Saint Barthélemy";
            else if (expectedTerritory === "stmartin") countryHint = "Saint Martin, France";
            else if (expectedTerritory === "newcaledonia") countryHint = "New Caledonia";

            const addressString = [addr.street, addr.zipCode, addr.city, countryHint]
                .filter(Boolean)
                .join(", ");

            if (!addressString || addressString === countryHint) {
                results.failed++;
                results.details.push({
                    CardCode: customer.CardCode,
                    status: "no_address",
                    expectedTerritory
                });
                continue;
            }

            try {
                const googleResult = await geocodeWithGoogleSingle(addressString, expectedTerritory);
                await sleep(100); // Rate limit

                if (googleResult) {
                    const territoryCheck = isInFrenchTerritory(googleResult.lat, googleResult.lng);

                    await Customer.updateOne(
                        { CardCode: customer.CardCode },
                        {
                            $set: {
                                coordinates: {
                                    lat: googleResult.lat,
                                    lng: googleResult.lng,
                                    geocodedAt: new Date(),
                                    geocodeSource: "google",
                                    displayName: googleResult.displayName,
                                    territory: territoryCheck.territory,
                                },
                            },
                        }
                    );

                    if (territoryCheck.valid) {
                        if (territoryCheck.territory === "metropolitan") {
                            results.fixed++;
                        } else {
                            results.overseas++;
                        }
                        results.details.push({
                            CardCode: customer.CardCode,
                            status: "fixed",
                            territory: territoryCheck.territory,
                            newLat: googleResult.lat,
                            newLng: googleResult.lng,
                        });
                    } else {
                        results.stillOutside++;
                        results.details.push({
                            CardCode: customer.CardCode,
                            status: "still_outside",
                            address: addressString,
                            expectedTerritory,
                            newLat: googleResult.lat,
                            newLng: googleResult.lng,
                            googleMapsLink: `https://www.google.com/maps?q=${googleResult.lat},${googleResult.lng}`,
                        });
                    }
                } else {
                    results.failed++;
                    results.details.push({
                        CardCode: customer.CardCode,
                        status: "google_failed",
                        address: addressString
                    });
                }
            } catch (error) {
                results.failed++;
                results.details.push({
                    CardCode: customer.CardCode,
                    status: "error",
                    error: error.message
                });
            }
        }

        res.json({
            success: true,
            message: `Processed ${customersOutside.length} customers`,
            results: {
                total: customersOutside.length,
                fixedMetropolitan: results.fixed,
                fixedOverseas: results.overseas,
                stillOutside: results.stillOutside,
                failed: results.failed,
                stillOutsideDetails: results.details.filter(d => d.status === "still_outside"),
            },
        });
    } catch (error) {
        console.error("Error fixing customers outside France:", error);
        res.status(500).json({
            success: false,
            message: "Error processing customers",
            error: error.message,
        });
    }
};

// Updated Google geocode helper with region hints
async function geocodeWithGoogleSingle(addressString, expectedTerritory = null) {
    try {
        // Set region hint based on expected territory
        let region = "fr";
        if (expectedTerritory === "guyane") region = "gf";
        else if (expectedTerritory === "martinique") region = "mq";
        else if (expectedTerritory === "guadeloupe") region = "gp";
        else if (expectedTerritory === "reunion") region = "re";
        else if (expectedTerritory === "mayotte") region = "yt";
        else if (expectedTerritory === "newcaledonia") region = "nc";

        const response = await axios.get(
            "https://maps.googleapis.com/maps/api/geocode/json",
            {
                params: {
                    address: addressString,
                    key: process.env.GOOGLE_MAPS_API_KEY,
                    region: region,
                },
                timeout: 8000,
            }
        );

        if (response.data.status === "OK" && response.data.results.length > 0) {
            const result = response.data.results[0];
            return {
                lat: result.geometry.location.lat,
                lng: result.geometry.location.lng,
                displayName: result.formatted_address,
            };
        }
        return null;
    } catch (error) {
        console.error(`Google geocode error: ${error.message}`);
        return null;
    }
}

/**
 * Get customers outside French territories with Google suggestions
 * Returns list for manual review - you provide coordinates
 * GET /api/map/geocoding/review-outside
 */
exports.getCustomersForManualReview = async (req, res) => {
    try {
        const FRANCE_BOUNDS = { minLat: 41.3, maxLat: 51.1, minLng: -5.1, maxLng: 9.6 };

        const OVERSEAS_BOUNDS = {
            reunion: { minLat: -21.4, maxLat: -20.8, minLng: 55.2, maxLng: 55.9 },
            mayotte: { minLat: -13.1, maxLat: -12.6, minLng: 44.9, maxLng: 45.4 },
            martinique: { minLat: 14.3, maxLat: 14.9, minLng: -61.3, maxLng: -60.8 },
            guadeloupe: { minLat: 15.8, maxLat: 16.6, minLng: -61.9, maxLng: -61.0 },
            guyane: { minLat: 2.0, maxLat: 6.0, minLng: -55.0, maxLng: -51.5 },
            stbarth: { minLat: 17.85, maxLat: 17.97, minLng: -62.92, maxLng: -62.78 },
            stmartin: { minLat: 18.0, maxLat: 18.13, minLng: -63.16, maxLng: -62.97 },
            newcaledonia: { minLat: -23.0, maxLat: -19.5, minLng: 163.5, maxLng: 169.0 },
        };

        function isInFrenchTerritory(lat, lng) {
            if (lat >= FRANCE_BOUNDS.minLat && lat <= FRANCE_BOUNDS.maxLat &&
                lng >= FRANCE_BOUNDS.minLng && lng <= FRANCE_BOUNDS.maxLng) {
                return { valid: true, territory: "metropolitan" };
            }
            for (const [name, bounds] of Object.entries(OVERSEAS_BOUNDS)) {
                if (lat >= bounds.minLat && lat <= bounds.maxLat &&
                    lng >= bounds.minLng && lng <= bounds.maxLng) {
                    return { valid: true, territory: name };
                }
            }
            return { valid: false, territory: null };
        }

        // Find customers outside French territories
        const allCustomers = await Customer.find({
            "coordinates.lat": { $exists: true, $ne: null },
        })
            .select("CardCode CardName address deliveryAddress coordinates")
            .lean();

        const customersOutside = allCustomers.filter(c => {
            return !isInFrenchTerritory(c.coordinates.lat, c.coordinates.lng).valid;
        });

        if (customersOutside.length === 0) {
            return res.json({
                success: true,
                message: "All customers are within French territories",
                customers: []
            });
        }

        // Get Google suggestions for each
        const reviewList = [];

        for (const customer of customersOutside) {
            const addr = customer.address || customer.deliveryAddress || {};
            const addressString = [addr.street, addr.zipCode, addr.city, addr.country]
                .filter(Boolean)
                .join(", ");

            let googleSuggestion = null;

            if (process.env.GOOGLE_MAPS_API_KEY && addressString.length > 5) {
                try {
                    const response = await axios.get(
                        "https://maps.googleapis.com/maps/api/geocode/json",
                        {
                            params: {
                                address: addressString,
                                key: process.env.GOOGLE_MAPS_API_KEY,
                            },
                            timeout: 8000,
                        }
                    );

                    if (response.data.status === "OK" && response.data.results.length > 0) {
                        const result = response.data.results[0];
                        googleSuggestion = {
                            lat: result.geometry.location.lat,
                            lng: result.geometry.location.lng,
                            formattedAddress: result.formatted_address,
                            googleMapsLink: `https://www.google.com/maps?q=${result.geometry.location.lat},${result.geometry.location.lng}`,
                        };
                    }
                    await sleep(100); // Rate limit
                } catch (err) {
                    console.error(`Google error for ${customer.CardCode}:`, err.message);
                }
            }

            reviewList.push({
                CardCode: customer.CardCode,
                CardName: customer.CardName,
                address: {
                    street: addr.street,
                    zipCode: addr.zipCode,
                    city: addr.city,
                    country: addr.country,
                    full: addressString,
                },
                currentCoordinates: {
                    lat: customer.coordinates.lat,
                    lng: customer.coordinates.lng,
                    source: customer.coordinates.geocodeSource,
                    currentMapLink: `https://www.google.com/maps?q=${customer.coordinates.lat},${customer.coordinates.lng}`,
                },
                googleSuggestion: googleSuggestion,
                // Endpoint to update this customer
                updateEndpoint: `POST /api/map/customer/${customer.CardCode}/coordinates`,
                updateBody: googleSuggestion
                    ? { lat: googleSuggestion.lat, lng: googleSuggestion.lng }
                    : { lat: "ENTER_LAT", lng: "ENTER_LNG" },
            });
        }

        res.json({
            success: true,
            message: `Found ${reviewList.length} customers outside French territories for review`,
            totalCount: reviewList.length,
            instructions: {
                step1: "Review each customer below",
                step2: "Click 'currentMapLink' to see where they are currently placed",
                step3: "Click 'googleSuggestion.googleMapsLink' to see Google's suggestion",
                step4: "If Google suggestion is correct, use the 'updateBody' coordinates",
                step5: "Call the 'updateEndpoint' with correct lat/lng to fix",
            },
            customers: reviewList,
        });
    } catch (error) {
        console.error("Error getting customers for review:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching customers",
            error: error.message,
        });
    }
};


/**
 * Accept Google suggestion for a single customer
 * POST /api/map/customer/:cardCode/accept-google
 */
exports.acceptGoogleSuggestion = async (req, res) => {
    try {
        const { cardCode } = req.params;

        const customer = await Customer.findOne({ CardCode: cardCode });
        if (!customer) {
            return res.status(404).json({ success: false, message: "Customer not found" });
        }

        const addr = customer.address || customer.deliveryAddress || {};
        const addressString = [addr.street, addr.zipCode, addr.city, addr.country]
            .filter(Boolean)
            .join(", ");

        if (!process.env.GOOGLE_MAPS_API_KEY) {
            return res.status(400).json({ success: false, message: "GOOGLE_MAPS_API_KEY not configured" });
        }

        const response = await axios.get(
            "https://maps.googleapis.com/maps/api/geocode/json",
            {
                params: { address: addressString, key: process.env.GOOGLE_MAPS_API_KEY },
                timeout: 8000,
            }
        );

        if (response.data.status !== "OK" || response.data.results.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Google could not geocode this address",
                address: addressString,
            });
        }

        const result = response.data.results[0];
        const newLat = result.geometry.location.lat;
        const newLng = result.geometry.location.lng;

        await Customer.updateOne(
            { CardCode: cardCode },
            {
                $set: {
                    coordinates: {
                        lat: newLat,
                        lng: newLng,
                        geocodedAt: new Date(),
                        geocodeSource: "google-accepted",
                        displayName: result.formatted_address,
                    },
                },
            }
        );

        res.json({
            success: true,
            message: "Coordinates updated from Google suggestion",
            customer: { CardCode: cardCode, CardName: customer.CardName },
            newCoordinates: { lat: newLat, lng: newLng },
            googleMapsLink: `https://www.google.com/maps?q=${newLat},${newLng}`,
        });
    } catch (error) {
        console.error("Error accepting Google suggestion:", error);
        res.status(500).json({ success: false, message: "Error updating", error: error.message });
    }
};

/**
 * Interactive terminal-based bulk coordinate fixer
 * Run with: node -e "require('./controllers/map.controller').bulkUpdateCoordinates()"
 * Or call via API and check terminal for prompts
 */
exports.bulkUpdateCoordinates = async (req, res) => {
    const readline = require("readline");

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const prompt = (question) => new Promise((resolve) => rl.question(question, resolve));

    try {
        const FRANCE_BOUNDS = { minLat: 41.3, maxLat: 51.1, minLng: -5.1, maxLng: 9.6 };

        const OVERSEAS_BOUNDS = {
            reunion: { minLat: -21.4, maxLat: -20.8, minLng: 55.2, maxLng: 55.9 },
            mayotte: { minLat: -13.1, maxLat: -12.6, minLng: 44.9, maxLng: 45.4 },
            martinique: { minLat: 14.3, maxLat: 14.9, minLng: -61.3, maxLng: -60.8 },
            guadeloupe: { minLat: 15.8, maxLat: 16.6, minLng: -61.9, maxLng: -61.0 },
            guyane: { minLat: 2.0, maxLat: 6.0, minLng: -55.0, maxLng: -51.5 },
            stbarth: { minLat: 17.85, maxLat: 17.97, minLng: -62.92, maxLng: -62.78 },
            stmartin: { minLat: 18.0, maxLat: 18.13, minLng: -63.16, maxLng: -62.97 },
            newcaledonia: { minLat: -23.0, maxLat: -19.5, minLng: 163.5, maxLng: 169.0 },
        };

        function isInFrenchTerritory(lat, lng) {
            if (lat >= FRANCE_BOUNDS.minLat && lat <= FRANCE_BOUNDS.maxLat &&
                lng >= FRANCE_BOUNDS.minLng && lng <= FRANCE_BOUNDS.maxLng) {
                return { valid: true, territory: "metropolitan" };
            }
            for (const [name, bounds] of Object.entries(OVERSEAS_BOUNDS)) {
                if (lat >= bounds.minLat && lat <= bounds.maxLat &&
                    lng >= bounds.minLng && lng <= bounds.maxLng) {
                    return { valid: true, territory: name };
                }
            }
            return { valid: false, territory: null };
        }

        console.log("\n========================================");
        console.log("   BULK COORDINATE FIXER - INTERACTIVE");
        console.log("========================================\n");

        // Find customers outside French territories
        const allCustomers = await Customer.find({
            "coordinates.lat": { $exists: true, $ne: null },
            "coordinates.reviewStatus": { $exists: false },
        })
            .select("CardCode CardName address deliveryAddress coordinates")
            .lean();

        const customersOutside = allCustomers.filter(c => {
            return !isInFrenchTerritory(c.coordinates.lat, c.coordinates.lng).valid;
        });

        if (customersOutside.length === 0) {
            console.log("🎉 All customers are within French territories! Nothing to fix.\n");
            rl.close();
            return res.json({ success: true, message: "No customers to fix" });
        }

        console.log(`Found ${customersOutside.length} customers outside French territories.\n`);

        const results = { fixed: 0, skipped: 0, international: 0 };

        for (let i = 0; i < customersOutside.length; i++) {
            const customer = customersOutside[i];
            const addr = customer.address || customer.deliveryAddress || {};
            const addressString = [addr.street, addr.zipCode, addr.city, addr.country]
                .filter(Boolean)
                .join(", ");

            console.log("\n────────────────────────────────────────");
            console.log(`📍 Customer ${i + 1} of ${customersOutside.length}`);
            console.log("────────────────────────────────────────");
            console.log(`CardCode:    ${customer.CardCode}`);
            console.log(`CardName:    ${customer.CardName}`);
            console.log(`Address:     ${addressString}`);
            console.log(`Current:     lat: ${customer.coordinates.lat}, lng: ${customer.coordinates.lng}`);
            console.log(`Current Map: https://www.google.com/maps?q=${customer.coordinates.lat},${customer.coordinates.lng}`);

            // Get Google suggestion
            let googleSuggestion = null;
            if (process.env.GOOGLE_MAPS_API_KEY && addressString.length > 5) {
                try {
                    const response = await axios.get(
                        "https://maps.googleapis.com/maps/api/geocode/json",
                        { params: { address: addressString, key: process.env.GOOGLE_MAPS_API_KEY }, timeout: 8000 }
                    );

                    if (response.data.status === "OK" && response.data.results.length > 0) {
                        const result = response.data.results[0];
                        googleSuggestion = {
                            lat: result.geometry.location.lat,
                            lng: result.geometry.location.lng,
                            address: result.formatted_address,
                        };
                        const check = isInFrenchTerritory(googleSuggestion.lat, googleSuggestion.lng);

                        console.log(`\n🔍 Google Suggests:`);
                        console.log(`   Address:  ${googleSuggestion.address}`);
                        console.log(`   Coords:   lat: ${googleSuggestion.lat}, lng: ${googleSuggestion.lng}`);
                        console.log(`   In France: ${check.valid ? `Yes (${check.territory})` : "No"}`);
                        console.log(`   Map:      https://www.google.com/maps?q=${googleSuggestion.lat},${googleSuggestion.lng}`);
                    } else {
                        console.log(`\n🔍 Google: No suggestion found`);
                    }
                } catch (err) {
                    console.log(`\n🔍 Google Error: ${err.message}`);
                }
            } else {
                console.log(`\n🔍 Google: API key not set or address too short`);
            }

            console.log(`\n📝 OPTIONS:`);
            console.log(`   [g] Accept Google suggestion`);
            console.log(`   [m] Enter manual coordinates`);
            console.log(`   [i] Mark as international (not France)`);
            console.log(`   [s] Skip this customer`);
            console.log(`   [q] Quit\n`);

            const answer = await prompt("Your choice: ");

            if (answer.toLowerCase() === "q") {
                console.log("\n👋 Quitting...");
                break;
            }

            if (answer.toLowerCase() === "g" && googleSuggestion) {
                await Customer.updateOne(
                    { CardCode: customer.CardCode },
                    {
                        $set: {
                            coordinates: {
                                lat: googleSuggestion.lat,
                                lng: googleSuggestion.lng,
                                geocodedAt: new Date(),
                                geocodeSource: "google-accepted",
                                reviewStatus: "fixed",
                            },
                        },
                    }
                );
                console.log(`✅ Updated with Google coordinates`);
                results.fixed++;

            } else if (answer.toLowerCase() === "m") {
                const latInput = await prompt("Enter latitude: ");
                const lngInput = await prompt("Enter longitude: ");

                const lat = parseFloat(latInput);
                const lng = parseFloat(lngInput);

                if (isNaN(lat) || isNaN(lng)) {
                    console.log("❌ Invalid coordinates, skipping...");
                    results.skipped++;
                } else {
                    await Customer.updateOne(
                        { CardCode: customer.CardCode },
                        {
                            $set: {
                                coordinates: {
                                    lat: lat,
                                    lng: lng,
                                    geocodedAt: new Date(),
                                    geocodeSource: "manual",
                                    reviewStatus: "fixed",
                                },
                            },
                        }
                    );
                    console.log(`✅ Updated with manual coordinates: ${lat}, ${lng}`);
                    results.fixed++;
                }

            } else if (answer.toLowerCase() === "i") {
                await Customer.updateOne(
                    { CardCode: customer.CardCode },
                    {
                        $set: {
                            "coordinates.reviewStatus": "international",
                            "coordinates.territory": "international",
                            "coordinates.reviewedAt": new Date(),
                        },
                    }
                );
                console.log(`🌍 Marked as international customer`);
                results.international++;

            } else if (answer.toLowerCase() === "s") {
                await Customer.updateOne(
                    { CardCode: customer.CardCode },
                    { $set: { "coordinates.reviewStatus": "skipped", "coordinates.reviewedAt": new Date() } }
                );
                console.log(`⏭️ Skipped`);
                results.skipped++;

            } else {
                console.log(`⏭️ Invalid option, skipping...`);
                results.skipped++;
            }
        }

        console.log("\n========================================");
        console.log("   SUMMARY");
        console.log("========================================");
        console.log(`Fixed:         ${results.fixed}`);
        console.log(`International: ${results.international}`);
        console.log(`Skipped:       ${results.skipped}`);
        console.log("========================================\n");

        rl.close();

        res.json({
            success: true,
            message: "Bulk update completed",
            results,
        });

    } catch (error) {
        console.error("Error:", error);
        rl.close();
        res.status(500).json({ success: false, message: error.message });
    }
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}