// controllers/truckRoute.controller.js
const TruckSchedule = require("../models/TruckSchedule");
const TruckRoute = require("../models/TruckRoute");
const SalesOrder = require("../models/SalesOrder");
const Customer = require("../models/Customer");
const Item = require("../models/item");

/**
 * Get all truck schedules (weekly templates)
 * These define which areas get deliveries on which days
 */
exports.getTruckSchedules = async (req, res) => {
    try {
        const schedules = await TruckSchedule.find({ isActive: true })
            .sort({ dayOfWeek: 1, region: 1 })
            .lean();

        res.json({
            success: true,
            schedules,
        });
    } catch (error) {
        console.error("Error fetching truck schedules:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching truck schedules",
            error: error.message,
        });
    }
};

/**
 * Create or update truck schedule template
 * POST /api/truck-routes/schedules
 * Body: { dayOfWeek, region, departments, cities, numberOfTrucks, isActive }
 */
exports.createOrUpdateSchedule = async (req, res) => {
    try {
        const { dayOfWeek, region, departments, cities, numberOfTrucks, isActive = true } = req.body;

        if (!dayOfWeek || !numberOfTrucks) {
            return res.status(400).json({
                success: false,
                message: "dayOfWeek and numberOfTrucks are required",
            });
        }

        // Check if schedule exists
        const existingSchedule = await TruckSchedule.findOne({
            dayOfWeek,
            region,
        });

        if (existingSchedule) {
            // Update existing
            existingSchedule.departments = departments || [];
            existingSchedule.cities = cities || [];
            existingSchedule.numberOfTrucks = numberOfTrucks;
            existingSchedule.isActive = isActive;
            existingSchedule.updatedAt = new Date();
            await existingSchedule.save();

            res.json({
                success: true,
                message: "Schedule updated",
                schedule: existingSchedule,
            });
        } else {
            // Create new
            const newSchedule = new TruckSchedule({
                dayOfWeek,
                region,
                departments: departments || [],
                cities: cities || [],
                numberOfTrucks,
                isActive,
            });
            await newSchedule.save();

            res.json({
                success: true,
                message: "Schedule created",
                schedule: newSchedule,
            });
        }
    } catch (error) {
        console.error("Error creating/updating schedule:", error);
        res.status(500).json({
            success: false,
            message: "Error managing schedule",
            error: error.message,
        });
    }
};

/**
 * Delete a truck schedule
 * DELETE /api/truck-routes/schedules/:id
 */
exports.deleteSchedule = async (req, res) => {
    try {
        const { id } = req.params;

        const result = await TruckSchedule.findByIdAndDelete(id);

        if (!result) {
            return res.status(404).json({
                success: false,
                message: "Schedule not found",
            });
        }

        res.json({
            success: true,
            message: "Schedule deleted",
        });
    } catch (error) {
        console.error("Error deleting schedule:", error);
        res.status(500).json({
            success: false,
            message: "Error deleting schedule",
            error: error.message,
        });
    }
};

/**
 * Get truck routes for a specific date
 * This returns actual delivery routes with assigned orders
 * GET /api/truck-routes/date/:date
 */
exports.getRoutesByDate = async (req, res) => {
    try {
        const { date } = req.params;
        console.log("=== FETCHING TRUCK ROUTES ===");
        console.log("📅 Requested Date:", date);

        // Parse the date string directly without timezone conversion
        const dateStr = date; // e.g., "2025-12-15"
        const targetDate = new Date(dateStr + "T00:00:00.000Z"); // Force UTC

        const nextDay = new Date(targetDate);
        nextDay.setDate(nextDay.getDate() + 1);

        console.log("🕐 Date Range:", {
            from: targetDate.toISOString(),
            to: nextDay.toISOString()
        });

        const routes = await TruckRoute.find({
            deliveryDate: { $gte: targetDate, $lt: nextDay },
        }).lean();

        console.log(`🚚 Found ${routes.length} truck routes for this date`);

        // Collect all order ObjectIds (not DocNums)
        const allOrderIds = [];
        routes.forEach(route => {
            route.orders.forEach(orderItem => {
                if (orderItem.order) {
                    // orderItem.order is an ObjectId
                    allOrderIds.push(orderItem.order);
                }
            });
        });

        console.log(`📦 Total orders to fetch: ${allOrderIds.length}`);

        // Fetch all orders at once using ObjectIds
        const allOrders = await SalesOrder.find({
            _id: { $in: allOrderIds }  // Use _id instead of DocNum
        }).lean();

        console.log(`✅ Successfully fetched ${allOrders.length} sales orders`);

        // Create order map using ObjectId strings as keys
        const orderMap = new Map();
        allOrders.forEach(order => {
            orderMap.set(order._id.toString(), order);
        });

        // Collect all unique ItemCodes
        const allItemCodes = new Set();
        allOrders.forEach(order => {
            if (order.DocumentLines && order.DocumentLines.length > 0) {
                order.DocumentLines.forEach(line => {
                    if (line.ItemCode) {
                        allItemCodes.add(line.ItemCode);
                    }
                });
            }
        });

        console.log(`📊 Fetching ${allItemCodes.size} unique items for weight calculation`);

        const items = await Item.find({
            ItemCode: { $in: Array.from(allItemCodes) }
        })
            .select("ItemCode SalesUnitWeight SalesWeightUnit")
            .lean();

        console.log(`⚖️  Found ${items.length} items with weight data`);

        // Create item map
        const itemMap = new Map();
        items.forEach(item => {
            itemMap.set(item.ItemCode, item);
        });


        // Collect all unique CardCodes
        const allCardCodes = new Set();
        allOrders.forEach(order => {
            if (order.CardCode) {
                allCardCodes.add(order.CardCode);
            }
        });

        console.log(`👥 Fetching ${allCardCodes.size} unique customers with store hours`);

        // Fetch all customers at once WITH opening and closing times
        const customers = await Customer.find({
            CardCode: { $in: Array.from(allCardCodes) }
        })
            .select("CardCode coordinates address deliveryAddress openingTime closingTime")
            .lean();

        console.log(`✅ Found ${customers.length} customers`);

        // Create customer map
        const customerMap = new Map();
        customers.forEach(customer => {
            customerMap.set(customer.CardCode, customer);
        });

        // Log store hours summary
        const customersWithHours = customers.filter(c => c.openingTime || c.closingTime);
        console.log(`🕒 Customers with store hours: ${customersWithHours.length}/${customers.length}`);

        // Helper function to convert time to minutes for comparison
        const timeToMinutes = (timeString) => {
            if (!timeString) return 999999; // Put orders without time at the end
            const [hours, minutes] = timeString.split(':').map(Number);
            return hours * 60 + minutes;
        };

        // Helper function to validate store hours
        const validateStoreHours = (openingTime, closingTime, customerName) => {
            if (!openingTime || !closingTime) return { valid: true, reason: null };

            const openMinutes = timeToMinutes(openingTime);
            const closeMinutes = timeToMinutes(closingTime);

            // Check if closing is before opening (invalid unless overnight)
            if (closeMinutes <= openMinutes && closeMinutes < 999999) {
                return {
                    valid: false,
                    reason: `⚠️  INVALID HOURS: ${customerName} - Closing time (${closingTime}) is before/equal to opening time (${openingTime})`
                };
            }

            return { valid: true, reason: null };
        };

        // Helper function to calculate truck departure time based on earliest opening
        const calculateDepartureTime = (orders) => {
            let earliestOpening = null;
            let earliestCustomer = null;

            orders.forEach(orderItem => {
                if (orderItem.order && orderItem.order.CardCode) {
                    const customer = customerMap.get(orderItem.order.CardCode);
                    if (customer?.openingTime) {
                        if (earliestOpening === null || customer.openingTime < earliestOpening) {
                            earliestOpening = customer.openingTime;
                            earliestCustomer = orderItem.order.CardName;
                        }
                    }
                }
            });

            if (earliestOpening && earliestCustomer) {
                console.log(`   🚦 Earliest opening: ${earliestOpening} (${earliestCustomer})`);
            }

            return earliestOpening || "08:00"; // Default to 8 AM if no opening times
        };

        console.log("\n🔧 ENRICHING ROUTES WITH DATA...");

        // Enrich routes with full order details and coordinates
        const enrichedRoutes = routes.map((route, routeIndex) => {
            console.log(`\n--- Processing Route ${routeIndex + 1}/${routes.length}: ${route.truckName} ---`);

            const enrichedOrders = route.orders.map((orderItem, orderIndex) => {
                const order = orderMap.get(orderItem.order.toString());

                if (!order) {
                    console.log(`⚠️  Order ${orderIndex + 1}: Not found in database`);
                    return orderItem;
                }

                const customer = customerMap.get(order.CardCode);

                // Validate store hours
                if (customer?.openingTime && customer?.closingTime) {
                    const validation = validateStoreHours(customer.openingTime, customer.closingTime, order.CardName);
                    if (!validation.valid) {
                        console.log(`   ${validation.reason}`);
                    }
                }

                // Calculate weight from items
                let totalWeight = 0;
                if (order.DocumentLines && order.DocumentLines.length > 0) {
                    for (const line of order.DocumentLines) {
                        if (line.ItemCode && line.Quantity) {
                            const item = itemMap.get(line.ItemCode);

                            if (item && item.SalesUnitWeight) {
                                const lineWeight = item.SalesUnitWeight * line.Quantity;
                                totalWeight += lineWeight;
                            }
                        }
                    }
                }

                const storeHoursDisplay = customer?.openingTime && customer?.closingTime
                    ? `${customer.openingTime} - ${customer.closingTime}`
                    : 'Not set';

                console.log(`   Order ${orderIndex + 1} (DocNum: ${order.DocNum}):`, {
                    customer: order.CardName,
                    weight: `${totalWeight.toFixed(2)} kg`,
                    hasCoordinates: !!customer?.coordinates,
                    storeHours: storeHoursDisplay
                });

                return {
                    ...orderItem,
                    orderWeightKg: parseFloat(totalWeight.toFixed(2)),
                    order: {
                        ...order,
                        address: customer?.address || customer?.deliveryAddress,
                        totalWeight: totalWeight,
                        weightUnit: "kg",
                    },
                    coordinates: customer?.coordinates || null,
                    storeHours: {
                        openingTime: customer?.openingTime || null,
                        closingTime: customer?.closingTime || null,
                    }
                };
            });

            // ===== SMART SORTING BY OPENING TIME =====
            console.log('\n🔄 SORTING ORDERS BY OPENING TIME...');

            const sortedOrders = enrichedOrders.sort((a, b) => {
                const timeA = timeToMinutes(a.storeHours?.openingTime);
                const timeB = timeToMinutes(b.storeHours?.openingTime);
                return timeA - timeB;
            });

            // Update sequence numbers after sorting
            sortedOrders.forEach((order, index) => {
                order.sequenceNumber = index + 1;
            });

            console.log('📋 Sorted order sequence:');
            sortedOrders.forEach((orderItem, index) => {
                const openTime = orderItem.storeHours?.openingTime || 'No time';
                const closeTime = orderItem.storeHours?.closingTime || 'No time';
                console.log(`   ${index + 1}. ${orderItem.order?.CardName} - Opens: ${openTime}, Closes: ${closeTime}`);
            });

            // Calculate total truck weight from sorted orders
            const calculatedTotalWeight = sortedOrders.reduce((sum, orderItem) => {
                return sum + (orderItem.orderWeightKg || 0);
            }, 0);

            const maxWeight = route.maxWeightKg || 1000;
            const calculatedCapacityPercent = calculatedTotalWeight > 0
                ? parseFloat(((calculatedTotalWeight / maxWeight) * 100).toFixed(2))
                : 0;

            // Calculate departure time
            const departureTime = calculateDepartureTime(sortedOrders);

            const departureReason = departureTime !== "08:00"
                ? `Truck departs at ${departureTime} (earliest store opening time)`
                : 'Using default departure time (no store hours defined)';

            console.log(`📊 Route Summary:`, {
                totalOrders: sortedOrders.length,
                totalWeight: `${calculatedTotalWeight.toFixed(2)} kg`,
                capacity: `${calculatedCapacityPercent}%`,
                departureTime: departureTime,
                reason: departureReason
            });

            return {
                ...route,
                orders: sortedOrders, // Use sorted orders
                totalWeightKg: parseFloat(calculatedTotalWeight.toFixed(2)),
                capacityUsedPercent: calculatedCapacityPercent,
                departureTime: departureTime,
            };
        });

        // Clean up the response - convert to plain objects and ensure all route data is included
        const cleanRoutes = enrichedRoutes.map(route => ({
            _id: route._id,
            deliveryDate: route.deliveryDate,
            scheduleId: route.scheduleId,
            dayOfWeek: route.dayOfWeek,
            region: route.region,
            departments: route.departments || [],
            cities: route.cities || [],
            truckNumber: route.truckNumber,
            truckName: route.truckName,
            totalOrders: route.totalOrders || route.orders.length,
            totalWeightKg: route.totalWeightKg,
            maxWeightKg: route.maxWeightKg || 1000,
            capacityUsedPercent: route.capacityUsedPercent,
            status: route.status || "planning",
            departureTime: route.departureTime,
            createdAt: route.createdAt,
            updatedAt: route.updatedAt,
            completedAt: route.completedAt,
            orders: route.orders.map(orderItem => ({
                _id: orderItem._id,
                sequenceNumber: orderItem.sequenceNumber, // Now properly sorted
                assignedAt: orderItem.assignedAt,
                orderWeightKg: orderItem.orderWeightKg,
                order: orderItem.order ? {
                    _id: orderItem.order._id,
                    DocEntry: orderItem.order.DocEntry,
                    DocNum: orderItem.order.DocNum,
                    DocDate: orderItem.order.DocDate,
                    CardCode: orderItem.order.CardCode,
                    CardName: orderItem.order.CardName,
                    DocTotal: orderItem.order.DocTotal,
                    address: orderItem.order.address,
                    totalWeight: orderItem.order.totalWeight,
                    weightUnit: orderItem.order.weightUnit,
                } : null,
                coordinates: orderItem.coordinates,
                storeHours: orderItem.storeHours,
            })),
        }));

        console.log("\n✅ ROUTE PROCESSING COMPLETE");
        console.log(`📤 Sending ${cleanRoutes.length} routes to frontend`);
        console.log("=== END FETCH TRUCK ROUTES ===\n");

        res.json({
            success: true,
            routes: cleanRoutes,
            totalRoutes: cleanRoutes.length,
        });
    } catch (error) {
        console.error("❌ ERROR FETCHING ROUTES:", error);
        console.error("Stack trace:", error.stack);
        res.status(500).json({
            success: false,
            message: "Error fetching truck routes",
            error: error.message,
        });
    }
};
/**
 * Optimize route order based on weight, time, and proximity
 * POST /api/truck-routes/:routeId/optimize
 * Body: { optimizationStrategy: "weight" | "distance" | "balanced" }
 */
exports.optimizeRoute = async (req, res) => {
    try {
        const { routeId } = req.params;
        const { optimizationStrategy = "balanced" } = req.body;

        const route = await TruckRoute.findById(routeId);
        if (!route) {
            return res.status(404).json({
                success: false,
                message: "Route not found",
            });
        }

        if (route.orders.length < 2) {
            return res.status(400).json({
                success: false,
                message: "Need at least 2 orders to optimize",
            });
        }

        // Fetch all orders with customer data
        const orderIds = route.orders.map(o => o.order);
        const orders = await SalesOrder.find({ _id: { $in: orderIds } })
            .select("DocNum CardCode DocTotal DocumentLines")
            .lean();

        const orderMap = new Map(orders.map(o => [o._id.toString(), o]));

        // Get customer coordinates for all orders
        const cardCodes = orders.map(o => o.CardCode);
        const customers = await Customer.find({ CardCode: { $in: cardCodes } })
            .select("CardCode coordinates")
            .lean();

        const customerMap = new Map(customers.map(c => [c.CardCode, c]));

        // Enrich orders with coordinates and weights
        const enrichedOrders = route.orders.map(orderItem => {
            const order = orderMap.get(orderItem.order.toString());
            const customer = customerMap.get(order?.CardCode);

            return {
                ...orderItem.toObject(),
                coordinates: customer?.coordinates,
                weight: orderItem.orderWeightKg || 0,
                orderId: orderItem.order.toString(),
            };
        }).filter(o => o.coordinates); // Only orders with coordinates

        if (enrichedOrders.length < 2) {
            return res.status(400).json({
                success: false,
                message: "Not enough orders with coordinates to optimize",
            });
        }

        // Warehouse starting point
        const WAREHOUSE = { lat: 48.922385, lng: 2.395789 };

        // Calculate distance between two points (Haversine)
        const calculateDistance = (coord1, coord2) => {
            const R = 6371; // Earth radius in km
            const dLat = (coord2.lat - coord1.lat) * Math.PI / 180;
            const dLng = (coord2.lng - coord1.lng) * Math.PI / 180;
            const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(coord1.lat * Math.PI / 180) * Math.cos(coord2.lat * Math.PI / 180) *
                Math.sin(dLng / 2) * Math.sin(dLng / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            return R * c;
        };

        let optimizedOrders = [];

        if (optimizationStrategy === "weight") {
            // Heaviest first strategy (stability)
            optimizedOrders = enrichedOrders.sort((a, b) => b.weight - a.weight);
        }
        else if (optimizationStrategy === "distance") {
            // Nearest neighbor algorithm starting from warehouse
            optimizedOrders = [];
            const remaining = [...enrichedOrders];
            let currentPos = WAREHOUSE;

            while (remaining.length > 0) {
                let nearestIdx = 0;
                let minDist = calculateDistance(currentPos, remaining[0].coordinates);

                for (let i = 1; i < remaining.length; i++) {
                    const dist = calculateDistance(currentPos, remaining[i].coordinates);
                    if (dist < minDist) {
                        minDist = dist;
                        nearestIdx = i;
                    }
                }

                const nearest = remaining.splice(nearestIdx, 1)[0];
                optimizedOrders.push(nearest);
                currentPos = nearest.coordinates;
            }
        }
        else { // "balanced" strategy
            // Balanced: Sort by distance from warehouse, but consider weight
            // Calculate a score: distance * (1 + weight/maxWeight * 0.3)
            const maxWeight = Math.max(...enrichedOrders.map(o => o.weight));

            optimizedOrders = enrichedOrders.map(order => {
                const distance = calculateDistance(WAREHOUSE, order.coordinates);
                const weightFactor = maxWeight > 0 ? (order.weight / maxWeight) * 0.3 : 0;
                const score = distance * (1 + weightFactor);
                return { ...order, score };
            }).sort((a, b) => a.score - b.score);
        }

        // Update sequence numbers
        route.orders = optimizedOrders.map((order, index) => ({
            order: order.order,
            sequenceNumber: index + 1,
            assignedAt: order.assignedAt,
            orderWeightKg: order.orderWeightKg,
        }));

        route.updatedAt = new Date();
        await route.save();

        // Return populated route
        const populatedRoute = await TruckRoute.findById(route._id)
            .populate({
                path: "orders.order",
                select: "DocNum DocEntry CardCode CardName DocTotal DocumentStatus DocDate",
            })
            .lean();

        // Add coordinates back
        for (const orderItem of populatedRoute.orders) {
            if (orderItem.order) {
                const customer = await Customer.findOne({
                    CardCode: orderItem.order.CardCode,
                })
                    .select("coordinates address")
                    .lean();

                if (customer?.coordinates) {
                    orderItem.coordinates = customer.coordinates;
                }
                if (customer?.address) {
                    orderItem.order.address = customer.address;
                }
            }
        }

        res.json({
            success: true,
            message: `Route optimized using ${optimizationStrategy} strategy`,
            route: populatedRoute,
            strategy: optimizationStrategy,
        });
    } catch (error) {
        console.error("Error optimizing route:", error);
        res.status(500).json({
            success: false,
            message: "Error optimizing route",
            error: error.message,
        });
    }
};

// Add this temporarily to test
exports.debugRoutes = async (req, res) => {
    try {
        const allRoutes = await TruckRoute.find({}).lean();

        res.json({
            totalRoutes: allRoutes.length,
            sampleRoute: allRoutes[0] || null,
            allDates: allRoutes.map(r => ({
                date: r.date,
                deliveryDate: r.deliveryDate,
                truckName: r.truckName
            }))
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * Create trucks for a specific date based on schedule
 * POST /api/truck-routes/initialize-date
 * Body: { date }
 */
exports.initializeTrucksForDate = async (req, res) => {
    try {
        const { date } = req.body;

        if (!date) {
            return res.status(400).json({
                success: false,
                message: "date is required",
            });
        }

        const deliveryDate = new Date(date);
        const dayOfWeek = deliveryDate.toLocaleDateString("en-US", { weekday: "long" });

        // Find schedules for this day
        const schedules = await TruckSchedule.find({
            dayOfWeek,
            isActive: true,
        }).lean();

        if (schedules.length === 0) {
            return res.status(404).json({
                success: false,
                message: `No truck schedules defined for ${dayOfWeek}`,
            });
        }

        const createdRoutes = [];

        // Create truck routes for each schedule
        for (const schedule of schedules) {
            for (let i = 1; i <= schedule.numberOfTrucks; i++) {
                const existingRoute = await TruckRoute.findOne({
                    deliveryDate,
                    scheduleId: schedule._id,
                    truckNumber: i,
                });

                if (!existingRoute) {
                    const newRoute = new TruckRoute({
                        deliveryDate,
                        scheduleId: schedule._id,
                        dayOfWeek: schedule.dayOfWeek,
                        region: schedule.region,
                        departments: schedule.departments,
                        cities: schedule.cities,
                        truckNumber: i,
                        truckName: `${schedule.region || schedule.dayOfWeek} - Truck ${i}`,
                        orders: [],
                        status: "planning",
                    });

                    await newRoute.save();
                    createdRoutes.push(newRoute);
                }
            }
        }

        res.json({
            success: true,
            message: `Initialized ${createdRoutes.length} trucks for ${date}`,
            routes: createdRoutes,
        });
    } catch (error) {
        console.error("Error initializing trucks:", error);
        res.status(500).json({
            success: false,
            message: "Error initializing trucks",
            error: error.message,
        });
    }
};

/**
 * Assign order to a truck
 * POST /api/truck-routes/:routeId/assign-order
 * Body: { orderDocEntry, sequenceNumber }
 */
exports.assignOrderToTruck = async (req, res) => {
    try {
        const { routeId } = req.params;
        const { orderDocEntry, sequenceNumber } = req.body;

        if (!orderDocEntry) {
            return res.status(400).json({
                success: false,
                message: "orderDocEntry is required",
            });
        }

        const route = await TruckRoute.findById(routeId);
        if (!route) {
            return res.status(404).json({
                success: false,
                message: "Route not found",
            });
        }

        // Find Sales Order by DocEntry
        const order = await SalesOrder.findOne({ DocEntry: orderDocEntry });
        if (!order) {
            return res.status(404).json({
                success: false,
                message: "Sales Order not found",
            });
        }

        // Check if order already assigned to this route
        const existingIndex = route.orders.findIndex(
            (o) => o.order.toString() === order._id.toString()
        );

        if (existingIndex !== -1) {
            return res.status(400).json({
                success: false,
                message: "Order already assigned to this truck",
            });
        }

        // Check if order assigned to another route on same date
        const otherRoute = await TruckRoute.findOne({
            deliveryDate: route.deliveryDate,
            _id: { $ne: route._id },
            "orders.order": order._id,
        });

        if (otherRoute) {
            return res.status(400).json({
                success: false,
                message: `Order already assigned to ${otherRoute.truckName}`,
                existingRoute: {
                    id: otherRoute._id,
                    name: otherRoute.truckName,
                },
            });
        }

        // Calculate order weight
        let orderWeightKg = 0;
        if (order.U_ExtraData?.totalWeight) {
            orderWeightKg = parseFloat(order.U_ExtraData.totalWeight);
        }

        // Check if adding this order would exceed truck capacity
        const currentWeight = route.totalWeightKg || 0;
        const maxWeight = route.maxWeightKg || 1000;
        const newTotalWeight = currentWeight + orderWeightKg;

        if (newTotalWeight > maxWeight) {
            return res.status(400).json({
                success: false,
                message: `Cannot add order: would exceed capacity (${newTotalWeight.toFixed(2)}kg / ${maxWeight}kg)`,
                currentWeight: currentWeight.toFixed(2),
                orderWeight: orderWeightKg.toFixed(2),
                maxWeight,
                remainingCapacity: (maxWeight - currentWeight).toFixed(2),
            });
        }

        // Add order to route with weight
        route.orders.push({
            order: order._id,
            sequenceNumber: sequenceNumber || route.orders.length + 1,
            assignedAt: new Date(),
            orderWeightKg: parseFloat(orderWeightKg.toFixed(2)),
        });

        // Update route totals
        route.totalOrders = route.orders.length;
        route.totalWeightKg = parseFloat(newTotalWeight.toFixed(2));
        route.capacityUsedPercent = parseFloat(((newTotalWeight / maxWeight) * 100).toFixed(2));
        route.updatedAt = new Date();

        await route.save();

        // Return populated route with customer coordinates
        const populatedRoute = await TruckRoute.findById(route._id)
            .populate({
                path: "orders.order",
                select: "DocNum DocEntry CardCode CardName DocTotal DocumentStatus DocDate",
            })
            .lean();

        // Add coordinates to each order
        for (const orderItem of populatedRoute.orders) {
            if (orderItem.order) {
                const customer = await Customer.findOne({
                    CardCode: orderItem.order.CardCode,
                })
                    .select("coordinates")
                    .lean();

                if (customer?.coordinates) {
                    orderItem.coordinates = customer.coordinates;
                }
            }
        }

        res.json({
            success: true,
            message: "Order assigned to truck",
            route: populatedRoute,
            weightAdded: parseFloat(orderWeightKg.toFixed(2)),
            newTotalWeight: parseFloat(newTotalWeight.toFixed(2)),
            remainingWeight: parseFloat((maxWeight - newTotalWeight).toFixed(2)),
            capacityUsed: parseFloat(((newTotalWeight / maxWeight) * 100).toFixed(2)),
        });
    } catch (error) {
        console.error("Error assigning order:", error);
        res.status(500).json({
            success: false,
            message: "Error assigning order",
            error: error.message,
        });
    }
};

/**
 * Remove order from truck
 * DELETE /api/truck-routes/:routeId/orders/:orderDocEntry
 */
exports.removeOrderFromTruck = async (req, res) => {
    try {
        const { routeId, orderDocEntry } = req.params;

        const route = await TruckRoute.findById(routeId);
        if (!route) {
            return res.status(404).json({
                success: false,
                message: "Route not found",
            });
        }

        // Find order by DocNum (which is passed as orderDocEntry in URL)
        const order = await SalesOrder.findOne({ DocNum: parseInt(orderDocEntry) });
        if (!order) {
            return res.status(404).json({
                success: false,
                message: "Sales Order not found",
            });
        }

        // Find the order item to get its weight before removing
        const orderItem = route.orders.find(
            (o) => o.order.toString() === order._id.toString()
        );

        const removedWeight = orderItem?.orderWeightKg || 0;

        // Remove order from route
        route.orders = route.orders.filter(
            (o) => o.order.toString() !== order._id.toString()
        );

        // Recalculate totals
        route.totalOrders = route.orders.length;
        route.totalWeightKg = route.orders.reduce((sum, o) => sum + (o.orderWeightKg || 0), 0);
        route.totalWeightKg = parseFloat(route.totalWeightKg.toFixed(2));

        const maxWeight = route.maxWeightKg || 1000;
        route.capacityUsedPercent = route.totalWeightKg > 0
            ? parseFloat(((route.totalWeightKg / maxWeight) * 100).toFixed(2))
            : 0;

        route.updatedAt = new Date();

        await route.save();

        // Return populated route
        const populatedRoute = await TruckRoute.findById(route._id)
            .populate({
                path: "orders.order",
                select: "DocNum DocEntry CardCode CardName DocTotal DocumentStatus",
            })
            .lean();

        res.json({
            success: true,
            message: "Order removed from truck",
            route: populatedRoute,
            weightRemoved: parseFloat(removedWeight.toFixed(2)),
            newTotalWeight: route.totalWeightKg,
            remainingCapacity: parseFloat((maxWeight - route.totalWeightKg).toFixed(2)),
        });
    } catch (error) {
        console.error("Error removing order:", error);
        res.status(500).json({
            success: false,
            message: "Error removing order",
            error: error.message,
        });
    }
};

/**
 * Reorder orders in a truck (change sequence)
 * PUT /api/truck-routes/:routeId/reorder
 * Body: { orderedDocEntries: [docEntry1, docEntry2, ...] }
 */
exports.reorderOrders = async (req, res) => {
    try {
        const { routeId } = req.params;
        const { orderedDocEntries } = req.body;

        if (!Array.isArray(orderedDocEntries)) {
            return res.status(400).json({
                success: false,
                message: "orderedDocEntries must be an array",
            });
        }

        const route = await TruckRoute.findById(routeId);
        if (!route) {
            return res.status(404).json({
                success: false,
                message: "Route not found",
            });
        }

        // Get order IDs from DocEntries
        const orders = await SalesOrder.find({
            DocEntry: { $in: orderedDocEntries },
        }).select("_id DocEntry");

        const orderMap = new Map(orders.map((o) => [o.DocEntry, o._id]));

        // Reorder based on provided sequence
        const newOrders = [];
        orderedDocEntries.forEach((docEntry, index) => {
            const orderId = orderMap.get(docEntry);
            const existingOrder = route.orders.find(
                (o) => o.order.toString() === orderId.toString()
            );

            if (existingOrder) {
                newOrders.push({
                    ...existingOrder.toObject(),
                    sequenceNumber: index + 1,
                });
            }
        });

        route.orders = newOrders;
        route.updatedAt = new Date();

        await route.save();

        const populatedRoute = await TruckRoute.findById(route._id)
            .populate({
                path: "orders.order",
                select: "DocNum CardCode CardName DocTotal DocumentStatus",
            })
            .lean();

        res.json({
            success: true,
            message: "Orders reordered",
            route: populatedRoute,
        });
    } catch (error) {
        console.error("Error reordering orders:", error);
        res.status(500).json({
            success: false,
            message: "Error reordering orders",
            error: error.message,
        });
    }
};

/**
 * Get available orders for a date (orders not yet assigned to any truck)
 * GET /api/truck-routes/available-orders/:date
 */
exports.getAvailableOrders = async (req, res) => {
    try {
        const { date } = req.params;
        const { region, department } = req.query;


        const dateStr = date;
        const targetDate = new Date(dateStr + "T00:00:00.000Z");

        const nextDay = new Date(targetDate);
        nextDay.setDate(nextDay.getDate() + 1);


        // Find all routes for this date
        const routes = await TruckRoute.find({
            deliveryDate: { $gte: targetDate, $lt: nextDay }, // CHANGED: was 'date', should be 'deliveryDate'
        }).lean();


        // Get all assigned order DocNums
        // Get all assigned order ObjectIds (not DocNums)
        const assignedOrderIds = new Set();
        routes.forEach(route => {
            if (route.orders) {
                route.orders.forEach(orderItem => {
                    if (orderItem.order) {
                        // orderItem.order is an ObjectId reference
                        assignedOrderIds.add(orderItem.order.toString());
                    }
                });
            }
        });


        // Now we need to find the DocNums for these ObjectIds
        let assignedOrderDocNums = new Set();
        if (assignedOrderIds.size > 0) {
            const assignedOrders = await SalesOrder.find({
                _id: { $in: Array.from(assignedOrderIds) }
            })
                .select("DocNum")
                .lean();

            assignedOrders.forEach(order => {
                if (order.DocNum) {
                    assignedOrderDocNums.add(order.DocNum);
                }
            });

        }


        // Find orders for this date that aren't assigned
        const ordersQuery = {
            StartDeliveryDate: { $gte: targetDate, $lt: nextDay },
        };

        if (assignedOrderDocNums.size > 0) {
            ordersQuery.DocNum = { $nin: Array.from(assignedOrderDocNums) };
        }


        const orders = await SalesOrder.find(ordersQuery)
            .select("DocEntry DocNum DocDate StartDeliveryDate CardCode CardName DocTotal DocumentLines")
            .lean();


        if (orders.length === 0) {
            return res.json({
                success: true,
                orders: [],
                totalOrders: 0,
            });
        }

        // Collect all unique ItemCodes first
        const allItemCodes = new Set();
        orders.forEach(order => {
            if (order.DocumentLines && Array.isArray(order.DocumentLines)) {
                order.DocumentLines.forEach(line => {
                    if (line.ItemCode) {
                        allItemCodes.add(line.ItemCode);
                    }
                });
            }
        });


        // Fetch items
        let items = [];
        const itemMap = new Map();

        if (allItemCodes.size > 0) {
            try {
                items = await Item.find({
                    ItemCode: { $in: Array.from(allItemCodes) }
                })
                    .select("ItemCode SalesUnitWeight SalesWeightUnit")
                    .lean();

                // Create item map
                items.forEach(item => {
                    itemMap.set(item.ItemCode, item);
                });
            } catch (itemError) {
                console.error("Error fetching items (continuing without weights):", itemError);
            }
        }

        // Enrich with coordinates and calculate weight

        const ordersWithCoordinates = await Promise.all(
            orders.map(async (order) => {
                try {
                    const customer = await Customer.findOne({ CardCode: order.CardCode })
                        .select("coordinates address deliveryAddress")
                        .lean();

                    const coordinates = customer?.coordinates;
                    const address = customer?.address || customer?.deliveryAddress;

                    // Calculate total weight from order lines
                    let totalWeight = 0;
                    if (order.DocumentLines && Array.isArray(order.DocumentLines)) {
                        for (const line of order.DocumentLines) {
                            if (line.ItemCode && line.Quantity) {
                                const item = itemMap.get(line.ItemCode);

                                if (item && item.SalesUnitWeight) {
                                    const lineWeight = item.SalesUnitWeight * line.Quantity;
                                    totalWeight += lineWeight;
                                }
                            }
                        }
                    }

                    return {
                        DocEntry: order.DocEntry,
                        DocNum: order.DocNum,
                        DocDate: order.DocDate,
                        StartDeliveryDate: order.StartDeliveryDate,
                        CardCode: order.CardCode,
                        CardName: order.CardName,
                        DocTotal: order.DocTotal,
                        coordinates: coordinates || null,
                        address: address || null,
                        totalWeight: totalWeight,
                        weightUnit: "kg",
                    };
                } catch (orderError) {
                    console.error(`Error processing order ${order.DocNum}:`, orderError);
                    return null;
                }
            })
        );

        // Filter out null values and orders without coordinates
        const filteredOrders = ordersWithCoordinates.filter(o => o && o.coordinates);


        res.json({
            success: true,
            orders: filteredOrders,
            totalOrders: filteredOrders.length,
        });
    } catch (error) {
        console.error("=== ERROR in getAvailableOrders ===");
        console.error("Error:", error);
        console.error("Stack:", error.stack);
        res.status(500).json({
            success: false,
            message: "Error fetching available orders",
            error: error.message,
        });
    }
};
/**
 * Update truck route status
 * PATCH /api/truck-routes/:routeId/status
 * Body: { status: "planning" | "in_progress" | "completed" }
 */
exports.updateRouteStatus = async (req, res) => {
    try {
        const { routeId } = req.params;
        const { status } = req.body;

        const validStatuses = ["planning", "in_progress", "completed"];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: `Status must be one of: ${validStatuses.join(", ")}`,
            });
        }

        const route = await TruckRoute.findById(routeId);
        if (!route) {
            return res.status(404).json({
                success: false,
                message: "Route not found",
            });
        }

        route.status = status;
        route.updatedAt = new Date();

        if (status === "completed") {
            route.completedAt = new Date();
        }

        await route.save();

        res.json({
            success: true,
            message: "Route status updated",
            route,
        });
    } catch (error) {
        console.error("Error updating route status:", error);
        res.status(500).json({
            success: false,
            message: "Error updating status",
            error: error.message,
        });
    }
};

/**
 * Get truck route statistics for a date range
 * GET /api/truck-routes/stats?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 */
exports.getRouteStatistics = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;

        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                message: "startDate and endDate are required",
            });
        }

        const start = new Date(startDate);
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);

        const routes = await TruckRoute.find({
            deliveryDate: { $gte: start, $lte: end },
        }).lean();

        const stats = {
            totalRoutes: routes.length,
            totalOrders: routes.reduce((sum, r) => sum + r.totalOrders, 0),
            byStatus: {
                planning: routes.filter((r) => r.status === "planning").length,
                in_progress: routes.filter((r) => r.status === "in_progress").length,
                completed: routes.filter((r) => r.status === "completed").length,
            },
            byRegion: {},
            byDay: {},
        };

        // Group by region
        routes.forEach((route) => {
            const region = route.region || "Unknown";
            if (!stats.byRegion[region]) {
                stats.byRegion[region] = { trucks: 0, orders: 0 };
            }
            stats.byRegion[region].trucks++;
            stats.byRegion[region].orders += route.totalOrders;
        });

        // Group by day
        routes.forEach((route) => {
            const day = route.deliveryDate.toISOString().split("T")[0];
            if (!stats.byDay[day]) {
                stats.byDay[day] = { trucks: 0, orders: 0 };
            }
            stats.byDay[day].trucks++;
            stats.byDay[day].orders += route.totalOrders;
        });

        res.json({
            success: true,
            dateRange: { startDate: start, endDate: end },
            stats,
        });
    } catch (error) {
        console.error("Error fetching route statistics:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching statistics",
            error: error.message,
        });
    }
};

/**
 * Auto-generate truck route by intelligently assigning orders
 * POST /api/truck-routes/:routeId/generate
 */
exports.generateTruckRoute = async (req, res) => {
    try {
        const { routeId } = req.params;
        const { strategy = "balanced" } = req.body;

        console.log("=== START AUTO-GENERATE TRUCK ROUTE ===");

        const route = await TruckRoute.findById(routeId);
        if (!route) {
            return res.status(404).json({
                success: false,
                message: "Route not found",
            });
        }

        console.log(`📅 Truck: ${route.truckName}, Region: ${route.region}`);

        // Get available orders for this date
        const dateStr = route.deliveryDate.toISOString().split("T")[0];
        const targetDate = new Date(dateStr + "T00:00:00.000Z");
        const nextDay = new Date(targetDate);
        nextDay.setDate(nextDay.getDate() + 1);

        // Find already assigned order IDs
        const allRoutes = await TruckRoute.find({
            deliveryDate: { $gte: targetDate, $lt: nextDay },
        }).lean();

        const assignedOrderIds = new Set();
        allRoutes.forEach(r => {
            r.orders.forEach(orderItem => {
                if (orderItem.order) {
                    assignedOrderIds.add(orderItem.order.toString());
                }
            });
        });

        // Get assigned DocNums
        let assignedOrderDocNums = new Set();
        if (assignedOrderIds.size > 0) {
            const assignedOrders = await SalesOrder.find({
                _id: { $in: Array.from(assignedOrderIds) }
            }).select("DocNum").lean();

            assignedOrders.forEach(order => {
                if (order.DocNum) {
                    assignedOrderDocNums.add(order.DocNum);
                }
            });
        }

        // Find available orders
        const ordersQuery = {
            StartDeliveryDate: { $gte: targetDate, $lt: nextDay },
        };

        if (assignedOrderDocNums.size > 0) {
            ordersQuery.DocNum = { $nin: Array.from(assignedOrderDocNums) };
        }

        const availableOrders = await SalesOrder.find(ordersQuery)
            .select("DocEntry DocNum CardCode CardName DocTotal DocumentLines StartDeliveryDate")
            .lean();

        console.log(`📦 Found ${availableOrders.length} available orders`);

        if (availableOrders.length === 0) {
            return res.json({
                success: true,
                message: "No available orders to assign",
                route: route,
                ordersAdded: 0,
            });
        }

        // Get all ItemCodes for weight calculation
        const allItemCodes = new Set();
        availableOrders.forEach(order => {
            if (order.DocumentLines && Array.isArray(order.DocumentLines)) {
                order.DocumentLines.forEach(line => {
                    if (line.ItemCode) {
                        allItemCodes.add(line.ItemCode);
                    }
                });
            }
        });

        // Fetch items with weights
        const items = await Item.find({
            ItemCode: { $in: Array.from(allItemCodes) }
        }).select("ItemCode SalesUnitWeight SalesWeightUnit").lean();

        const itemMap = new Map();
        items.forEach(item => {
            itemMap.set(item.ItemCode, item);
        });

        // Get customers with addresses for region filtering
        const cardCodes = availableOrders.map(o => o.CardCode);
        const customers = await Customer.find({
            CardCode: { $in: cardCodes }
        }).select("CardCode coordinates address openingTime closingTime").lean();

        const customerMap = new Map();
        customers.forEach(customer => {
            customerMap.set(customer.CardCode, customer);
        });

        // Calculate weight and enrich orders
        const enrichedOrders = availableOrders.map(order => {
            let totalWeight = 0;
            if (order.DocumentLines && Array.isArray(order.DocumentLines)) {
                for (const line of order.DocumentLines) {
                    if (line.ItemCode && line.Quantity) {
                        const item = itemMap.get(line.ItemCode);
                        if (item && item.SalesUnitWeight) {
                            totalWeight += item.SalesUnitWeight * line.Quantity;
                        }
                    }
                }
            }

            const customer = customerMap.get(order.CardCode);

            return {
                ...order,
                totalWeight,
                coordinates: customer?.coordinates,
                address: customer?.address,
                openingTime: customer?.openingTime,
            };
        }).filter(o => o.coordinates); // Only orders with coordinates

        console.log(`📍 ${enrichedOrders.length} orders have coordinates`);

        // Filter by region if truck has a region
        let filteredOrders = enrichedOrders;
        if (route.region) {
            const FRENCH_DEPARTMENTS = {
                "75": { region: "Île-de-France" },
                "77": { region: "Île-de-France" },
                "78": { region: "Île-de-France" },
                "91": { region: "Île-de-France" },
                "92": { region: "Île-de-France" },
                "93": { region: "Île-de-France" },
                "94": { region: "Île-de-France" },
                "95": { region: "Île-de-France" },
                // Add all other departments from your existing FRENCH_DEPARTMENTS object
            };

            filteredOrders = enrichedOrders.filter(order => {
                if (!order.address || !order.address.zipCode) return false;

                const zipCode = order.address.zipCode.toString();
                const deptCode = zipCode.startsWith("97") || zipCode.startsWith("98")
                    ? zipCode.substring(0, 3)
                    : zipCode.substring(0, 2);

                const dept = FRENCH_DEPARTMENTS[deptCode];
                return dept && dept.region === route.region;
            });

            console.log(`🌍 ${filteredOrders.length} orders match region: ${route.region}`);
        }

        if (filteredOrders.length === 0) {
            return res.json({
                success: true,
                message: `No available orders found for region: ${route.region}`,
                route: route,
                ordersAdded: 0,
            });
        }

        // Sort orders based on strategy
        let sortedOrders = [];
        const WAREHOUSE = { lat: 48.922385, lng: 2.395789 };

        const calculateDistance = (coord1, coord2) => {
            const R = 6371;
            const dLat = (coord2.lat - coord1.lat) * Math.PI / 180;
            const dLng = (coord2.lng - coord1.lng) * Math.PI / 180;
            const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(coord1.lat * Math.PI / 180) * Math.cos(coord2.lat * Math.PI / 180) *
                Math.sin(dLng / 2) * Math.sin(dLng / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            return R * c;
        };

        if (strategy === "weight") {
            sortedOrders = filteredOrders.sort((a, b) => b.totalWeight - a.totalWeight);
        } else if (strategy === "distance") {
            sortedOrders = filteredOrders.sort((a, b) => {
                const distA = calculateDistance(WAREHOUSE, a.coordinates);
                const distB = calculateDistance(WAREHOUSE, b.coordinates);
                return distA - distB;
            });
        } else { // balanced
            const maxWeight = Math.max(...filteredOrders.map(o => o.totalWeight || 0));
            sortedOrders = filteredOrders.map(order => {
                const distance = calculateDistance(WAREHOUSE, order.coordinates);
                const weightFactor = maxWeight > 0 ? (order.totalWeight / maxWeight) * 0.3 : 0;
                const score = distance * (1 + weightFactor);
                return { ...order, score };
            }).sort((a, b) => a.score - b.score);
        }

        // Add orders to truck until capacity is reached
        const maxWeight = route.maxWeightKg || 1000;
        let currentWeight = route.totalWeightKg || 0;
        let ordersAdded = 0;

        for (const order of sortedOrders) {
            const orderWeight = order.totalWeight || 0;

            if (currentWeight + orderWeight <= maxWeight) {
                // Add order to route
                route.orders.push({
                    order: order._id,
                    sequenceNumber: route.orders.length + 1,
                    assignedAt: new Date(),
                    orderWeightKg: parseFloat(orderWeight.toFixed(2)),
                });

                currentWeight += orderWeight;
                ordersAdded++;
                console.log(`✅ Added order #${order.DocNum} (${orderWeight.toFixed(2)}kg)`);
            } else {
                console.log(`⚠️ Capacity reached. Cannot add order #${order.DocNum}`);
                break;
            }
        }

        // Update route totals
        route.totalOrders = route.orders.length;
        route.totalWeightKg = parseFloat(currentWeight.toFixed(2));
        route.capacityUsedPercent = parseFloat(((currentWeight / maxWeight) * 100).toFixed(2));
        route.updatedAt = new Date();

        await route.save();

        console.log(`🎉 Added ${ordersAdded} orders to ${route.truckName}`);
        console.log(`📊 Capacity: ${route.capacityUsedPercent}% (${route.totalWeightKg}/${maxWeight}kg)`);
        console.log("=== END AUTO-GENERATE TRUCK ROUTE ===\n");

        // Return populated route
        const populatedRoute = await TruckRoute.findById(route._id)
            .populate({
                path: "orders.order",
                select: "DocNum DocEntry CardCode CardName DocTotal DocumentStatus DocDate",
            })
            .lean();

        // Add coordinates
        for (const orderItem of populatedRoute.orders) {
            if (orderItem.order) {
                const customer = await Customer.findOne({
                    CardCode: orderItem.order.CardCode,
                }).select("coordinates address openingTime closingTime").lean();

                if (customer?.coordinates) {
                    orderItem.coordinates = customer.coordinates;
                }
                if (customer?.address) {
                    orderItem.order.address = customer.address;
                }
                if (customer) {
                    orderItem.storeHours = {
                        openingTime: customer.openingTime || null,
                        closingTime: customer.closingTime || null,
                    };
                }
            }
        }

        res.json({
            success: true,
            message: `Successfully added ${ordersAdded} orders to ${route.truckName}`,
            route: populatedRoute,
            ordersAdded,
            capacityUsed: route.capacityUsedPercent,
            strategy,
        });

    } catch (error) {
        console.error("❌ ERROR GENERATING ROUTE:", error);
        res.status(500).json({
            success: false,
            message: "Error generating truck route",
            error: error.message,
        });
    }
};

/**
 * Get available orders for a specific truck based on its region
 * GET /api/truck-route/:truckId/available-orders?date=YYYY-MM-DD
 * Returns unassigned orders that match the truck's region
 */
exports.getAvailableOrdersByTruckRegion = async (req, res) => {
    try {
        const { truckId } = req.params;
        const { date } = req.query;

        if (!date) {
            return res.status(400).json({
                status: "error",
                message: "date query parameter is required (format: YYYY-MM-DD)",
            });
        }

        if (!truckId) {
            return res.status(400).json({
                status: "error",
                message: "truckId is required",
            });
        }

        // Find the truck
        const truck = await TruckRoute.findById(truckId).lean();
        if (!truck) {
            return res.status(404).json({
                status: "error",
                message: "Truck not found",
            });
        }

        const truckRegion = truck.region;

        console.log(`\n=== FETCHING ORDERS FOR TRUCK REGION ===`);
        console.log(`🚚 Truck: ${truck.truckName} (ID: ${truckId})`);
        console.log(`🌍 Region: ${truckRegion}`);
        console.log(`📅 Date: ${date}`);

        // Parse date
        const dateStr = date;
        const targetDate = new Date(dateStr + "T00:00:00.000Z");
        const nextDay = new Date(targetDate);
        nextDay.setDate(nextDay.getDate() + 1);

        // Find all routes for this date to get assigned orders
        const allRoutes = await TruckRoute.find({
            deliveryDate: { $gte: targetDate, $lt: nextDay },
        }).lean();

        console.log(`📍 Total truck routes for this date: ${allRoutes.length}`);

        // Get all assigned order IDs
        const assignedOrderIds = new Set();
        allRoutes.forEach(route => {
            if (route.orders) {
                route.orders.forEach(orderItem => {
                    if (orderItem.order) {
                        assignedOrderIds.add(orderItem.order.toString());
                    }
                });
            }
        });

        console.log(`📌 Already assigned order IDs: ${assignedOrderIds.size}`);

        // Get assigned DocNums
        let assignedOrderDocNums = new Set();
        if (assignedOrderIds.size > 0) {
            const assignedOrders = await SalesOrder.find({
                _id: { $in: Array.from(assignedOrderIds) }
            }).select("DocNum").lean();

            assignedOrders.forEach(order => {
                if (order.DocNum) {
                    assignedOrderDocNums.add(order.DocNum);
                }
            });
        }

        console.log(`📍 Already assigned orders: ${assignedOrderDocNums.size}`);

        // Find unassigned orders for this date
        const ordersQuery = {
            StartDeliveryDate: { $gte: targetDate, $lt: nextDay },
        };

        if (assignedOrderDocNums.size > 0) {
            ordersQuery.DocNum = { $nin: Array.from(assignedOrderDocNums) };
        }

        const availableOrders = await SalesOrder.find(ordersQuery)
            .select("DocEntry DocNum DocDate CardCode CardName DocTotal DocumentLines")
            .lean();

        console.log(`📦 Unassigned orders for date: ${availableOrders.length}`);

        if (availableOrders.length === 0) {
            return res.json({
                status: "success",
                data: {
                    truckId: truckId,
                    truckName: truck.truckName,
                    region: truckRegion,
                    availableOrders: [],
                    totalCount: 0,
                    totalWeight: 0,
                    totalValue: 0,
                },
                message: "No orders available for this truck region",
            });
        }

        // Get all ItemCodes for weight calculation
        const allItemCodes = new Set();
        availableOrders.forEach(order => {
            if (order.DocumentLines && Array.isArray(order.DocumentLines)) {
                order.DocumentLines.forEach(line => {
                    if (line.ItemCode) {
                        allItemCodes.add(line.ItemCode);
                    }
                });
            }
        });

        // Fetch items with weights
        const items = await Item.find({
            ItemCode: { $in: Array.from(allItemCodes) }
        }).select("ItemCode SalesUnitWeight SalesWeightUnit").lean();

        const itemMap = new Map();
        items.forEach(item => {
            itemMap.set(item.ItemCode, item);
        });

        // Get customers for address and coordinates
        const cardCodes = availableOrders.map(o => o.CardCode);
        const customers = await Customer.find({
            CardCode: { $in: cardCodes }
        }).select("CardCode coordinates address deliveryAddress").lean();

        const customerMap = new Map();
        customers.forEach(customer => {
            customerMap.set(customer.CardCode, customer);
        });

        // Region department mapping (French postal codes) - Complete mapping
        const FRENCH_DEPARTMENTS = {
            // Île-de-France
            "75": { region: "Île-de-France" },
            "77": { region: "Île-de-France" },
            "78": { region: "Île-de-France" },
            "91": { region: "Île-de-France" },
            "92": { region: "Île-de-France" },
            "93": { region: "Île-de-France" },
            "94": { region: "Île-de-France" },
            "95": { region: "Île-de-France" },
            // Normandie
            "14": { region: "Normandie" },
            "27": { region: "Normandie" },
            "50": { region: "Normandie" },
            "61": { region: "Normandie" },
            "76": { region: "Normandie" },
            // Bretagne
            "22": { region: "Bretagne" },
            "29": { region: "Bretagne" },
            "35": { region: "Bretagne" },
            "56": { region: "Bretagne" },
            // Nouvelle-Aquitaine
            "16": { region: "Nouvelle-Aquitaine" },
            "17": { region: "Nouvelle-Aquitaine" },
            "19": { region: "Nouvelle-Aquitaine" },
            "23": { region: "Nouvelle-Aquitaine" },
            "24": { region: "Nouvelle-Aquitaine" },
            "33": { region: "Nouvelle-Aquitaine" },
            "40": { region: "Nouvelle-Aquitaine" },
            "47": { region: "Nouvelle-Aquitaine" },
            "64": { region: "Nouvelle-Aquitaine" },
            "79": { region: "Nouvelle-Aquitaine" },
            "86": { region: "Nouvelle-Aquitaine" },
            "87": { region: "Nouvelle-Aquitaine" },
            // Occitanie
            "09": { region: "Occitanie" },
            "11": { region: "Occitanie" },
            "12": { region: "Occitanie" },
            "30": { region: "Occitanie" },
            "31": { region: "Occitanie" },
            "32": { region: "Occitanie" },
            "34": { region: "Occitanie" },
            "46": { region: "Occitanie" },
            "48": { region: "Occitanie" },
            "65": { region: "Occitanie" },
            "66": { region: "Occitanie" },
            "81": { region: "Occitanie" },
            "82": { region: "Occitanie" },
            // Auvergne-Rhône-Alpes
            "01": { region: "Auvergne-Rhône-Alpes" },
            "03": { region: "Auvergne-Rhône-Alpes" },
            "07": { region: "Auvergne-Rhône-Alpes" },
            "15": { region: "Auvergne-Rhône-Alpes" },
            "26": { region: "Auvergne-Rhône-Alpes" },
            "38": { region: "Auvergne-Rhône-Alpes" },
            "42": { region: "Auvergne-Rhône-Alpes" },
            "43": { region: "Auvergne-Rhône-Alpes" },
            "63": { region: "Auvergne-Rhône-Alpes" },
            "69": { region: "Auvergne-Rhône-Alpes" },
            "73": { region: "Auvergne-Rhône-Alpes" },
            "74": { region: "Auvergne-Rhône-Alpes" },
            // Provence-Alpes-Côte d'Azur
            "04": { region: "Provence-Alpes-Côte d'Azur" },
            "05": { region: "Provence-Alpes-Côte d'Azur" },
            "06": { region: "Provence-Alpes-Côte d'Azur" },
            "13": { region: "Provence-Alpes-Côte d'Azur" },
            "83": { region: "Provence-Alpes-Côte d'Azur" },
            "84": { region: "Provence-Alpes-Côte d'Azur" },
            // Pays de la Loire
            "44": { region: "Pays de la Loire" },
            "49": { region: "Pays de la Loire" },
            "53": { region: "Pays de la Loire" },
            "72": { region: "Pays de la Loire" },
            "85": { region: "Pays de la Loire" },
            // Centre-Val de Loire
            "18": { region: "Centre-Val de Loire" },
            "28": { region: "Centre-Val de Loire" },
            "36": { region: "Centre-Val de Loire" },
            "37": { region: "Centre-Val de Loire" },
            "41": { region: "Centre-Val de Loire" },
            "45": { region: "Centre-Val de Loire" },
            // Bourgogne-Franche-Comté
            "21": { region: "Bourgogne-Franche-Comté" },
            "25": { region: "Bourgogne-Franche-Comté" },
            "39": { region: "Bourgogne-Franche-Comté" },
            "58": { region: "Bourgogne-Franche-Comté" },
            "70": { region: "Bourgogne-Franche-Comté" },
            "71": { region: "Bourgogne-Franche-Comté" },
            "89": { region: "Bourgogne-Franche-Comté" },
            "90": { region: "Bourgogne-Franche-Comté" },
            // Hauts-de-France
            "02": { region: "Hauts-de-France" },
            "59": { region: "Hauts-de-France" },
            "60": { region: "Hauts-de-France" },
            "62": { region: "Hauts-de-France" },
            "80": { region: "Hauts-de-France" },
            // Grand Est
            "08": { region: "Grand Est" },
            "10": { region: "Grand Est" },
            "51": { region: "Grand Est" },
            "52": { region: "Grand Est" },
            "54": { region: "Grand Est" },
            "55": { region: "Grand Est" },
            "57": { region: "Grand Est" },
            "67": { region: "Grand Est" },
            "68": { region: "Grand Est" },
            "88": { region: "Grand Est" },
        };

        // Filter orders by truck region (matching original frontend logic)
        const filteredOrders = availableOrders
            .map(order => {
                const customer = customerMap.get(order.CardCode);
                
                // Step 1: Check if order exists with address & zipCode
                if (!customer) {
                    return null;
                }

                // Get address
                const address = customer.address || customer.deliveryAddress;
                if (!address || !address.zipCode) {
                    return null;
                }

                // Step 2: Extract department code from zipCode
                const zipCode = address.zipCode.toString();
                const deptCode = zipCode.startsWith("97") || zipCode.startsWith("98")
                    ? zipCode.substring(0, 3)
                    : zipCode.substring(0, 2);

                // Step 3: Lookup department in FRENCH_DEPARTMENTS dict
                const dept = FRENCH_DEPARTMENTS[deptCode];
                if (!dept) {
                    return null;
                }

                // Step 4: Compare regions (truck.region === dept.region)
                if (dept.region !== truckRegion) {
                    return null;
                }

                // Calculate total weight from order lines
                let totalWeight = 0;
                if (order.DocumentLines && Array.isArray(order.DocumentLines)) {
                    for (const line of order.DocumentLines) {
                        if (line.ItemCode && line.Quantity) {
                            const item = itemMap.get(line.ItemCode);
                            if (item && item.SalesUnitWeight) {
                                totalWeight += item.SalesUnitWeight * line.Quantity;
                            }
                        }
                    }
                }

                // Return order with coordinates if available
                return {
                    DocEntry: order.DocEntry,
                    DocNum: order.DocNum,
                    DocDate: order.DocDate,
                    CardCode: order.CardCode,
                    CardName: order.CardName,
                    DocTotal: order.DocTotal,
                    address: {
                        street: address.street || "",
                        city: address.city || "",
                        zipCode: address.zipCode,
                        country: address.country || "France",
                    },
                    coordinates: customer?.coordinates || null,  // Optional, can be null
                    totalWeight: parseFloat(totalWeight.toFixed(2)),
                    weightUnit: "kg",
                };
            })
            .filter(o => o !== null);

        console.log(`✅ Orders matching region "${truckRegion}": ${filteredOrders.length}`);

        // Calculate totals
        const totalWeight = filteredOrders.reduce((sum, o) => sum + o.totalWeight, 0);
        const totalValue = filteredOrders.reduce((sum, o) => sum + o.DocTotal, 0);

        console.log(`📊 Summary:`, {
            count: filteredOrders.length,
            totalWeight: totalWeight.toFixed(2),
            totalValue: totalValue.toFixed(2),
        });

        console.log(`=== END FETCH ORDERS BY TRUCK REGION ===\n`);

        res.json({
            status: "success",
            data: {
                truckId: truckId,
                truckName: truck.truckName,
                region: truckRegion,
                availableOrders: filteredOrders,
                totalCount: filteredOrders.length,
                totalWeight: parseFloat(totalWeight.toFixed(2)),
                totalValue: parseFloat(totalValue.toFixed(2)),
            },
            message: "Orders retrieved successfully",
        });
    } catch (error) {
        console.error("❌ ERROR FETCHING ORDERS BY TRUCK REGION:", error);
        console.error("Stack trace:", error.stack);
        res.status(500).json({
            status: "error",
            message: "Error fetching orders by truck region",
            error: error.message,
        });
    }
};