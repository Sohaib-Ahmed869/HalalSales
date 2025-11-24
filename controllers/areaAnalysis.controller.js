// controllers/areaAnalysis.controller.js
const Customer = require("../models/Customer");
const Invoice = require("../models/Invoice");
const SalesOrder = require("../models/SalesOrder");

/**
 * Helper: Calculate distance between two coordinates (Haversine formula)
 */
function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371; // Earth radius in km
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Get area delivery analysis
 * Input: center coordinates (lat, lng) and radius in km
 * Output: current deliveries and potential customers in area
 */
exports.getAreaAnalysis = async (req, res) => {
    try {
        const { lat, lng, radius = 10, date } = req.query;

        if (!lat || !lng) {
            return res.status(400).json({
                success: false,
                message: "lat and lng are required",
            });
        }

        const centerLat = parseFloat(lat);
        const centerLng = parseFloat(lng);
        const radiusKm = parseFloat(radius);

        // Set target date (default to today)
        const targetDate = date ? new Date(date) : new Date();
        targetDate.setHours(0, 0, 0, 0);

        const nextDay = new Date(targetDate);
        nextDay.setDate(nextDay.getDate() + 1);

        const last30Days = new Date(targetDate);
        last30Days.setDate(last30Days.getDate() - 30);

        // Calculate geospatial bounds for pre-filtering
        const bounds = calculateGeoBounds(centerLat, centerLng, radiusKm);

        // OPTIMIZATION 1: Use $geoWithin or coordinate bounds to pre-filter in database
        // This dramatically reduces the dataset before distance calculations
        const customersInBounds = await Customer.find({
            "coordinates.lat": {
                $gte: bounds.minLat,
                $lte: bounds.maxLat,
                $exists: true,
                $ne: null
            },
            "coordinates.lng": {
                $gte: bounds.minLng,
                $lte: bounds.maxLng
            },
            status: "active",
        })
            .populate("assignedTo", "firstName lastName")
            .lean()
            .select("CardCode CardName Email coordinates assignedTo address"); // Only select needed fields

        // Filter by exact distance
        const customersInArea = customersInBounds.filter((customer) => {
            const distance = calculateDistance(
                centerLat,
                centerLng,
                customer.coordinates.lat,
                customer.coordinates.lng
            );
            customer._distance = distance; // Cache distance for later use
            return distance <= radiusKm;
        });

        if (customersInArea.length === 0) {
            return res.json({
                success: true,
                data: {
                    area: {
                        center: { lat: centerLat, lng: centerLng },
                        radius: radiusKm,
                    },
                    summary: {
                        totalCustomers: 0,
                        currentDeliveries: 0,
                        potentialDeliveries: 0,
                    },
                    customers: [],
                    deliveries: [],
                },
            });
        }

        const customerCodes = customersInArea.map((c) => c.CardCode);

        // OPTIMIZATION 2: Run queries in parallel
        const [deliveriesOnDate, recentInvoices] = await Promise.all([
            // Query 1: Deliveries on target date
            SalesOrder.find({
                CardCode: { $in: customerCodes },
                DocDate: { $gte: targetDate, $lt: nextDay },
            })
                .lean()
                .select("CardCode DocDate"),

            // Query 2: Recent invoices for pattern analysis
            SalesOrder.find({
                CardCode: { $in: customerCodes },
                DocDate: { $gte: last30Days, $lt: targetDate },
            })
                .sort({ CardCode: 1, DocDate: -1 }) // Sort in database
                .lean()
                .select("CardCode DocDate")
        ]);

        // OPTIMIZATION 3: Create lookup maps for O(1) access instead of repeated .filter() calls
        const deliveryMap = new Set(
            deliveriesOnDate.map(inv => inv.CardCode)
        );

        // Group recent invoices by customer for O(1) lookup
        const invoicesByCustomer = new Map();
        recentInvoices.forEach(inv => {
            if (!invoicesByCustomer.has(inv.CardCode)) {
                invoicesByCustomer.set(inv.CardCode, []);
            }
            invoicesByCustomer.get(inv.CardCode).push(inv);
        });

        // OPTIMIZATION 4: Single-pass analysis with pre-computed values
        const customerAnalysis = customersInArea.map((customer) => {
            const hasDeliveryOnDate = deliveryMap.has(customer.CardCode);
            const customerInvoices = invoicesByCustomer.get(customer.CardCode) || [];

            // Calculate order frequency
            let daysSinceLastOrder = null;
            let avgDaysBetweenOrders = null;
            let orderLikelihood = 0;

            if (customerInvoices.length > 0) {
                daysSinceLastOrder = Math.floor(
                    (targetDate - new Date(customerInvoices[0].DocDate)) / 86400000 // Pre-compute ms per day
                );

                // Calculate average days between orders
                if (customerInvoices.length >= 2) {
                    let totalGap = 0;
                    let validGaps = 0;

                    for (let i = 0; i < customerInvoices.length - 1; i++) {
                        const gap = Math.floor(
                            (new Date(customerInvoices[i].DocDate) -
                                new Date(customerInvoices[i + 1].DocDate)) / 86400000
                        );
                        if (gap > 0 && gap < 90) {
                            totalGap += gap;
                            validGaps++;
                        }
                    }

                    if (validGaps > 0) {
                        avgDaysBetweenOrders = Math.round(totalGap / validGaps);
                        const ratio = daysSinceLastOrder / avgDaysBetweenOrders;
                        orderLikelihood = Math.min(100, ratio * 100);
                    }
                }
            }

            return {
                customer: {
                    cardCode: customer.CardCode,
                    cardName: customer.CardName,
                    email: customer.Email,
                    coordinates: customer.coordinates,
                    assignedTo: customer.assignedTo
                        ? `${customer.assignedTo.firstName} ${customer.assignedTo.lastName}`
                        : null,
                },
                location: {
                    distance: parseFloat(customer._distance.toFixed(2)),
                    address: customer.address
                        ? `${customer.address.street || ""}, ${customer.address.city || ""}`.trim()
                        : null,
                },
                deliveryStatus: {
                    hasDeliveryOnDate,
                    recentOrderCount: customerInvoices.length,
                    daysSinceLastOrder,
                    avgDaysBetweenOrders,
                    orderLikelihood: parseFloat(orderLikelihood.toFixed(2)),
                },
            };
        });

        // OPTIMIZATION 5: Separate and sort in single pass
        const currentDeliveries = [];
        const potentialDeliveries = [];

        customerAnalysis.forEach(c => {
            if (c.deliveryStatus.hasDeliveryOnDate) {
                currentDeliveries.push(c);
            } else {
                potentialDeliveries.push(c);
            }
        });

        // Sort only what we need
        potentialDeliveries.sort((a, b) =>
            b.deliveryStatus.orderLikelihood - a.deliveryStatus.orderLikelihood
        );

        const allCustomersSorted = [...customerAnalysis].sort((a, b) =>
            a.location.distance - b.location.distance
        );

        // Calculate capacity metrics
        const totalCapacity = 50;
        const currentLoad = currentDeliveries.length;
        const availableCapacity = Math.max(0, totalCapacity - currentLoad);
        const utilizationRate = (currentLoad / totalCapacity) * 100;

        return res.json({
            success: true,
            data: {
                area: {
                    center: { lat: centerLat, lng: centerLng },
                    radius: radiusKm,
                    targetDate: targetDate,
                },
                summary: {
                    totalCustomers: customersInArea.length,
                    currentDeliveries: currentDeliveries.length,
                    potentialDeliveries: potentialDeliveries.length,
                    totalCapacity,
                    availableCapacity,
                    utilizationRate: parseFloat(utilizationRate.toFixed(2)),
                },
                currentDeliveries: currentDeliveries.slice(0, 1000),
                potentialDeliveries: potentialDeliveries.slice(0, 1000),
                allCustomersInArea: allCustomersSorted.slice(0, 1000),
            },
        });
    } catch (error) {
        console.error("Error in area analysis:", error);
        return res.status(500).json({
            success: false,
            message: "Error analyzing area",
            error: error.message,
        });
    }
};

// Helper function to calculate bounding box
function calculateGeoBounds(lat, lng, radiusKm) {
    // Approximate degrees per km
    const latDegreesPerKm = 1 / 111.32;
    const lngDegreesPerKm = 1 / (111.32 * Math.cos(lat * Math.PI / 180));

    return {
        minLat: lat - (radiusKm * latDegreesPerKm),
        maxLat: lat + (radiusKm * latDegreesPerKm),
        minLng: lng - (radiusKm * lngDegreesPerKm),
        maxLng: lng + (radiusKm * lngDegreesPerKm),
    };
}

/**
 * Get area suggestions based on high delivery density
 */
exports.getAreaSuggestions = async (req, res) => {
    try {
        // Predefined Paris areas
        const parisAreas = [
            { name: "Champs-Élysées", lat: 48.8698, lng: 2.3078 },
            { name: "Montmartre", lat: 48.8867, lng: 2.3431 },
            { name: "Le Marais", lat: 48.8566, lng: 2.3622 },
            { name: "Latin Quarter", lat: 48.8499, lng: 2.3447 },
            { name: "Saint-Germain", lat: 48.8534, lng: 2.3330 },
        ];

        const { date } = req.query;
        const targetDate = date ? new Date(date) : new Date();
        targetDate.setHours(0, 0, 0, 0);

        const nextDay = new Date(targetDate);
        nextDay.setDate(nextDay.getDate() + 1);

        // Get all customers with coordinates
        const customers = await Customer.find({
            "coordinates.lat": { $exists: true, $ne: null },
            status: "active",
        }).lean();

        // Get invoices on target date
        const invoices = await SalesOrder.find({
            DocDate: { $gte: targetDate, $lt: nextDay },
        }).lean();

        // Analyze each predefined area
        const areaSuggestions = parisAreas.map((area) => {
            const radius = 5; // 5km radius

            // Count customers in area
            const customersInArea = customers.filter((customer) => {
                const distance = calculateDistance(
                    area.lat,
                    area.lng,
                    customer.coordinates.lat,
                    customer.coordinates.lng
                );
                return distance <= radius;
            });

            // Count deliveries in area
            const deliveriesInArea = invoices.filter((invoice) => {
                const customer = customers.find((c) => c.CardCode === invoice.CardCode);
                if (!customer || !customer.coordinates) return false;
                const distance = calculateDistance(
                    area.lat,
                    area.lng,
                    customer.coordinates.lat,
                    customer.coordinates.lng
                );
                return distance <= radius;
            });

            return {
                name: area.name,
                center: { lat: area.lat, lng: area.lng },
                deliveryCount: deliveriesInArea.length,
                customerCount: customersInArea.length,
                utilizationRate:
                    customersInArea.length > 0
                        ? parseFloat(((deliveriesInArea.length / customersInArea.length) * 100).toFixed(2))
                        : 0,
                potentialGrowth: customersInArea.length - deliveriesInArea.length,
            };
        }).sort((a, b) => b.deliveryCount - a.deliveryCount);

        return res.json({
            success: true,
            data: {
                targetDate,
                suggestions: areaSuggestions,
            },
        });
    } catch (error) {
        console.error("Error getting area suggestions:", error);
        return res.status(500).json({
            success: false,
            message: "Error getting area suggestions",
            error: error.message,
        });
    }
};