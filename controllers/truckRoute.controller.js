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
 * Body: { dayOfWeek, region, departments, cities, trucks: [{truckNumber, truckName, maxWeightKg}], isActive }
 */
exports.createOrUpdateSchedule = async (req, res) => {
    try {
        const { dayOfWeek, region, departments, cities, trucks, isActive = true } = req.body;

        if (!dayOfWeek || !trucks || trucks.length === 0) {
            return res.status(400).json({
                success: false,
                message: "dayOfWeek and trucks array are required",
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
            existingSchedule.numberOfTrucks = trucks.length;
            existingSchedule.trucks = trucks;
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
                numberOfTrucks: trucks.length,
                trucks,
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
        console.log("=== FETCHING TRUCK ROUTES (OPTIMIZED) ===");
        console.log("📅 Requested Date:", date);

        const dateStr = date;
        const targetDate = new Date(dateStr + "T00:00:00.000Z");
        const nextDay = new Date(targetDate);
        nextDay.setDate(nextDay.getDate() + 1);

        const routes = await TruckRoute.find({
            deliveryDate: { $gte: targetDate, $lt: nextDay },
        }).lean();

        console.log(`🚚 Found ${routes.length} truck routes`);

        if (routes.length === 0) {
            return res.json({
                success: true,
                routes: [],
                totalRoutes: 0,
            });
        }

        // Collect all order IDs
        const allOrderIds = [];
        routes.forEach(route => {
            if (route.orders) {
                route.orders.forEach(orderItem => {
                    if (orderItem.order) {
                        allOrderIds.push(orderItem.order);
                    }
                });
            }
        });

        console.log(`📦 Total order references: ${allOrderIds.length}`);

        if (allOrderIds.length === 0) {
            return res.json({
                success: true,
                routes: routes.map(route => ({
                    ...route,
                    orders: [],
                    departureTime: "08:00"
                })),
                totalRoutes: routes.length,
            });
        }

        // PARALLEL FETCH: Orders, Customers, Items
        const allOrders = await SalesOrder.find({
            _id: { $in: allOrderIds }
        }).lean();

        const orderMap = new Map(allOrders.map(o => [o._id.toString(), o]));

        const cardCodes = [...new Set(allOrders.map(o => o.CardCode))];
        const allItemCodes = new Set();
        allOrders.forEach(order => {
            if (order.DocumentLines) {
                order.DocumentLines.forEach(line => {
                    if (line.ItemCode) allItemCodes.add(line.ItemCode);
                });
            }
        });

        const [customers, items] = await Promise.all([
            Customer.find({ CardCode: { $in: cardCodes } })
                .select("CardCode coordinates address deliveryAddress openingTime closingTime")
                .lean(),
            Item.find({ ItemCode: { $in: Array.from(allItemCodes) } })
                .select("ItemCode SalesUnitWeight")
                .lean()
        ]);

        const customerMap = new Map(customers.map(c => [c.CardCode, c]));
        const itemMap = new Map(items.map(i => [i.ItemCode, i]));

        console.log(`✅ Fetched ${allOrders.length} orders, ${customers.length} customers, ${items.length} items`);

        // Time conversion helper
        const timeToMinutes = (timeString) => {
            if (!timeString) return 999999;
            const [hours, minutes] = timeString.split(':').map(Number);
            return hours * 60 + minutes;
        };

        // Enrich routes
        const enrichedRoutes = routes.map(route => {
            const enrichedOrders = route.orders.map(orderItem => {
                const order = orderMap.get(orderItem.order.toString());
                if (!order) return orderItem;

                const customer = customerMap.get(order.CardCode);

                // Calculate weight
                let totalWeight = 0;
                if (order.DocumentLines) {
                    for (const line of order.DocumentLines) {
                        if (line.ItemCode && line.Quantity) {
                            const item = itemMap.get(line.ItemCode);
                            if (item?.SalesUnitWeight) {
                                totalWeight += item.SalesUnitWeight * line.Quantity;
                            }
                        }
                    }
                }

                // ASSIGN RANDOM STORE HOURS IF MISSING
                let openingTime = customer?.openingTime;
                let closingTime = customer?.closingTime;

                if (!openingTime || !closingTime) {
                    const openingHour = 9 + Math.floor(Math.random() * 7);
                    const openingMinute = Math.random() > 0.5 ? "00" : "30";
                    openingTime = `${openingHour.toString().padStart(2, '0')}:${openingMinute}`;

                    const hoursOpen = 4 + Math.floor(Math.random() * 5);
                    const closingHour = openingHour + hoursOpen;
                    closingTime = `${closingHour.toString().padStart(2, '0')}:00`;
                }

                return {
                    ...orderItem,
                    orderWeightKg: parseFloat(totalWeight.toFixed(2)),
                    order: {
                        ...order,
                        address: customer?.address || customer?.deliveryAddress,
                        totalWeight,
                        weightUnit: "kg",
                    },
                    coordinates: customer?.coordinates || null,
                    storeHours: {
                        openingTime,
                        closingTime,
                    }
                };
            });

            // Sort by opening time
            const sortedOrders = enrichedOrders.sort((a, b) => {
                const timeA = timeToMinutes(a.storeHours?.openingTime);
                const timeB = timeToMinutes(b.storeHours?.openingTime);
                return timeA - timeB;
            });

            sortedOrders.forEach((order, index) => {
                order.sequenceNumber = index + 1;
            });

            // Calculate totals
            const calculatedTotalWeight = sortedOrders.reduce((sum, o) =>
                sum + (o.orderWeightKg || 0), 0
            );

            const maxWeight = route.maxWeightKg || 1000;
            const calculatedCapacityPercent = calculatedTotalWeight > 0
                ? parseFloat(((calculatedTotalWeight / maxWeight) * 100).toFixed(2))
                : 0;

            // Departure time = earliest opening
            let departureTime = "08:00";
            if (sortedOrders.length > 0) {
                const earliestOpening = sortedOrders[0].storeHours?.openingTime;
                if (earliestOpening) {
                    departureTime = earliestOpening;
                }
            }

            return {
                ...route,
                orders: sortedOrders,
                totalWeightKg: parseFloat(calculatedTotalWeight.toFixed(2)),
                capacityUsedPercent: calculatedCapacityPercent,
                departureTime,
            };
        });

        // Clean response
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
            totalOrders: route.orders.length,
            totalWeightKg: route.totalWeightKg,
            maxWeightKg: route.maxWeightKg || 1000,
            capacityUsedPercent: route.capacityUsedPercent,
            status: route.status || "planning",
            departureTime: route.departureTime,
            createdAt: route.createdAt,
            updatedAt: route.updatedAt,
            orders: route.orders.map(orderItem => ({
                _id: orderItem._id,
                sequenceNumber: orderItem.sequenceNumber,
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

        console.log(`✅ Sending ${cleanRoutes.length} routes`);
        console.log("=== END FETCH TRUCK ROUTES ===\n");

        res.json({
            success: true,
            routes: cleanRoutes,
            totalRoutes: cleanRoutes.length,
        });
    } catch (error) {
        console.error("❌ ERROR:", error);
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
            // Use individual truck configurations
            for (const truckConfig of schedule.trucks) {
                const existingRoute = await TruckRoute.findOne({
                    deliveryDate,
                    scheduleId: schedule._id,
                    truckNumber: truckConfig.truckNumber,
                });

                if (!existingRoute) {
                    const newRoute = new TruckRoute({
                        deliveryDate,
                        scheduleId: schedule._id,
                        dayOfWeek: schedule.dayOfWeek,
                        region: schedule.region,
                        departments: schedule.departments,
                        cities: schedule.cities,
                        truckNumber: truckConfig.truckNumber,
                        truckName: truckConfig.truckName || `${schedule.region || schedule.dayOfWeek} - Truck ${truckConfig.truckNumber}`,
                        orders: [],
                        status: "planning",
                        maxWeightKg: truckConfig.maxWeightKg || 1000, // USE INDIVIDUAL TRUCK CAPACITY
                        totalWeightKg: 0,
                        capacityUsedPercent: 0,
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

        console.log("\n=== GET AVAILABLE ORDERS (OPTIMIZED) ===");
        console.log("📅 Date:", date);

        const dateStr = date;
        const targetDate = new Date(dateStr + "T00:00:00.000Z");
        const nextDay = new Date(targetDate);
        nextDay.setDate(nextDay.getDate() + 1);

        // OPTIMIZATION 1: Parallel queries
        const [routes, allOrders] = await Promise.all([
            TruckRoute.find({
                deliveryDate: { $gte: targetDate, $lt: nextDay },
            }).select('orders').lean(),

            SalesOrder.find({
                RequriedDate: { $gte: targetDate, $lt: nextDay },
            })
                .select("DocEntry DocNum DocDate RequriedDate CardCode CardName DocTotal DocumentLines")
                .lean()
        ]);

        console.log(`🚚 Found ${routes.length} truck routes`);
        console.log(`📊 Found ${allOrders.length} total orders`);

        // OPTIMIZATION 2: Use Set for O(1) lookups
        const assignedOrderIds = new Set();
        routes.forEach(route => {
            if (route.orders) {
                route.orders.forEach(orderItem => {
                    if (orderItem.order) {
                        assignedOrderIds.add(orderItem.order.toString());
                    }
                });
            }
        });

        console.log(`📦 ${assignedOrderIds.size} orders already assigned`);

        // OPTIMIZATION 3: Filter by ObjectId directly (no DocNum conversion needed)
        const unassignedOrders = allOrders.filter(order =>
            !assignedOrderIds.has(order._id.toString())
        );

        console.log(`✅ ${unassignedOrders.length} unassigned orders`);

        if (unassignedOrders.length === 0) {
            return res.json({
                success: true,
                orders: [],
                totalOrders: 0
            });
        }

        // OPTIMIZATION 4: Batch fetch all data in parallel
        const cardCodes = [...new Set(unassignedOrders.map(o => o.CardCode))];
        const allItemCodes = new Set();
        unassignedOrders.forEach(order => {
            if (order.DocumentLines) {
                order.DocumentLines.forEach(line => {
                    if (line.ItemCode) allItemCodes.add(line.ItemCode);
                });
            }
        });

        const [customers, items] = await Promise.all([
            Customer.find({ CardCode: { $in: cardCodes } })
                .select("CardCode coordinates address deliveryAddress openingTime closingTime")
                .lean(),
            Item.find({ ItemCode: { $in: Array.from(allItemCodes) } })
                .select("ItemCode SalesUnitWeight SalesWeightUnit")
                .lean()
        ]);

        console.log(`👥 Fetched ${customers.length} customers`);
        console.log(`⚖️ Fetched ${items.length} items`);

        // Create lookup maps
        const customerMap = new Map(customers.map(c => [c.CardCode, c]));
        const itemMap = new Map(items.map(i => [i.ItemCode, i]));

        // OPTIMIZATION 5: Single-pass enrichment
        const enrichedOrders = unassignedOrders.map(order => {
            const customer = customerMap.get(order.CardCode);
            if (!customer?.coordinates) return null;

            // Calculate weight
            let totalWeight = 0;
            if (order.DocumentLines) {
                for (const line of order.DocumentLines) {
                    if (line.ItemCode && line.Quantity) {
                        const item = itemMap.get(line.ItemCode);
                        if (item?.SalesUnitWeight) {
                            totalWeight += item.SalesUnitWeight * line.Quantity;
                        }
                    }
                }
            }

            // ASSIGN RANDOM STORE HOURS IF MISSING
            let openingTime = customer.openingTime;
            let closingTime = customer.closingTime;

            if (!openingTime || !closingTime) {
                // Random opening between 09:00 - 15:00
                const openingHour = 9 + Math.floor(Math.random() * 7); // 9-15
                const openingMinute = Math.random() > 0.5 ? "00" : "30";
                openingTime = `${openingHour.toString().padStart(2, '0')}:${openingMinute}`;

                // Closing 4-8 hours after opening
                const hoursOpen = 4 + Math.floor(Math.random() * 5); // 4-8 hours
                const closingHour = openingHour + hoursOpen;
                closingTime = `${closingHour.toString().padStart(2, '0')}:00`;
            }

            return {
                _id: order._id,
                DocEntry: order.DocEntry,
                DocNum: order.DocNum,
                DocDate: order.DocDate,
                RequriedDate: order.RequriedDate,
                CardCode: order.CardCode,
                CardName: order.CardName,
                DocTotal: order.DocTotal,
                coordinates: customer.coordinates,
                address: customer.address || customer.deliveryAddress,
                totalWeight,
                weightUnit: "kg",
                openingTime,
                closingTime,
            };
        }).filter(Boolean); // Remove nulls

        console.log(`📍 ${enrichedOrders.length} orders with coordinates and hours`);
        console.log("=== END GET AVAILABLE ORDERS ===\n");

        res.json({
            success: true,
            orders: enrichedOrders,
            totalOrders: enrichedOrders.length,
        });
    } catch (error) {
        console.error("❌ ERROR in getAvailableOrders:", error);
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
            RequriedDate: { $gte: targetDate, $lt: nextDay },
        };

        if (assignedOrderDocNums.size > 0) {
            ordersQuery.DocNum = { $nin: Array.from(assignedOrderDocNums) };
        }

        const availableOrders = await SalesOrder.find(ordersQuery)
            .select("DocEntry DocNum CardCode CardName DocTotal DocumentLines RequriedDate")
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
            // Use the same FRENCH_DEPARTMENTS from MapPage
            const FRENCH_DEPARTMENTS = {
                "75": { region: "Île-de-France" },
                "77": { region: "Île-de-France" },
                "78": { region: "Île-de-France" },
                "91": { region: "Île-de-France" },
                "92": { region: "Île-de-France" },
                "93": { region: "Île-de-France" },
                "94": { region: "Île-de-France" },
                "95": { region: "Île-de-France" },
                "04": { region: "Provence-Alpes-Côte d'Azur" },
                "05": { region: "Provence-Alpes-Côte d'Azur" },
                "06": { region: "Provence-Alpes-Côte d'Azur" },
                "13": { region: "Provence-Alpes-Côte d'Azur" },
                "83": { region: "Provence-Alpes-Côte d'Azur" },
                "84": { region: "Provence-Alpes-Côte d'Azur" },
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
                // Add all other departments...
                "02": { region: "Hauts-de-France" },
                "59": { region: "Hauts-de-France" },
                "60": { region: "Hauts-de-France" },
                "62": { region: "Hauts-de-France" },
                "80": { region: "Hauts-de-France" },
                // Continue for all regions...
            };

            filteredOrders = enrichedOrders.filter(order => {
                if (!order.address || !order.address.zipCode) return false;

                const zipCode = order.address.zipCode.toString();
                const deptCode = zipCode.startsWith("97") || zipCode.startsWith("98")
                    ? zipCode.substring(0, 3)
                    : zipCode.substring(0, 2);

                const dept = FRENCH_DEPARTMENTS[deptCode];

                // If truck has specific departments, check those
                if (route.departments && route.departments.length > 0) {
                    return route.departments.includes(deptCode);
                }

                // Otherwise, match region
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
 * Auto-fill ALL trucks for a date intelligently
 * POST /api/truck-routes/auto-fill-all/:date
 * Body: { strategy: "balanced" | "distance" | "weight" }
 */
exports.autoFillAllTrucks = async (req, res) => {
    try {
        const { date } = req.params;
        const { strategy = "balanced" } = req.body;

        console.log("\n=== START AUTO-FILL ALL TRUCKS (NEAREST NEIGHBOR) ===");
        console.log(`📅 Date: ${date}, Strategy: ${strategy}`);

        const dateStr = date;
        const targetDate = new Date(dateStr + "T00:00:00.000Z");
        const nextDay = new Date(targetDate);
        nextDay.setDate(nextDay.getDate() + 1);

        // Get all truck routes for this date
        const allRoutes = await TruckRoute.find({
            deliveryDate: { $gte: targetDate, $lt: nextDay },
        }).lean();

        if (allRoutes.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No trucks initialized for this date",
            });
        }

        console.log(`🚚 Found ${allRoutes.length} trucks for this date`);

        // Get all assigned order IDs across all trucks
        const assignedOrderIds = new Set();
        allRoutes.forEach(route => {
            route.orders.forEach(orderItem => {
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

        // Find all available orders for this date
        const ordersQuery = {
            RequriedDate: { $gte: targetDate, $lt: nextDay },
        };

        if (assignedOrderDocNums.size > 0) {
            ordersQuery.DocNum = { $nin: Array.from(assignedOrderDocNums) };
        }

        const availableOrders = await SalesOrder.find(ordersQuery)
            .select("DocEntry DocNum CardCode CardName DocTotal DocumentLines RequriedDate")
            .lean();

        console.log(`📦 Found ${availableOrders.length} unassigned orders`);

        if (availableOrders.length === 0) {
            return res.json({
                success: true,
                message: "No unassigned orders to distribute",
                summary: {
                    totalOrders: 0,
                    ordersAssigned: 0,
                    ordersUnassigned: 0,
                    trucksUsed: 0,
                }
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

        // Get customers with addresses
        const cardCodes = availableOrders.map(o => o.CardCode);
        const customers = await Customer.find({
            CardCode: { $in: cardCodes }
        }).select("CardCode coordinates address openingTime closingTime").lean();

        const customerMap = new Map();
        customers.forEach(customer => {
            customerMap.set(customer.CardCode, customer);
        });

        // French departments mapping (complete)
        const FRENCH_DEPARTMENTS = {
            "75": { region: "Île-de-France" },
            "77": { region: "Île-de-France" },
            "78": { region: "Île-de-France" },
            "91": { region: "Île-de-France" },
            "92": { region: "Île-de-France" },
            "93": { region: "Île-de-France" },
            "94": { region: "Île-de-France" },
            "95": { region: "Île-de-France" },
            "04": { region: "Provence-Alpes-Côte d'Azur" },
            "05": { region: "Provence-Alpes-Côte d'Azur" },
            "06": { region: "Provence-Alpes-Côte d'Azur" },
            "13": { region: "Provence-Alpes-Côte d'Azur" },
            "83": { region: "Provence-Alpes-Côte d'Azur" },
            "84": { region: "Provence-Alpes-Côte d'Azur" },
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
            "02": { region: "Hauts-de-France" },
            "59": { region: "Hauts-de-France" },
            "60": { region: "Hauts-de-France" },
            "62": { region: "Hauts-de-France" },
            "80": { region: "Hauts-de-France" },
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
            "14": { region: "Normandie" },
            "27": { region: "Normandie" },
            "50": { region: "Normandie" },
            "61": { region: "Normandie" },
            "76": { region: "Normandie" },
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
            "44": { region: "Pays de la Loire" },
            "49": { region: "Pays de la Loire" },
            "53": { region: "Pays de la Loire" },
            "72": { region: "Pays de la Loire" },
            "85": { region: "Pays de la Loire" },
            "22": { region: "Bretagne" },
            "29": { region: "Bretagne" },
            "35": { region: "Bretagne" },
            "56": { region: "Bretagne" },
            "18": { region: "Centre-Val de Loire" },
            "28": { region: "Centre-Val de Loire" },
            "36": { region: "Centre-Val de Loire" },
            "37": { region: "Centre-Val de Loire" },
            "41": { region: "Centre-Val de Loire" },
            "45": { region: "Centre-Val de Loire" },
            "21": { region: "Bourgogne-Franche-Comté" },
            "25": { region: "Bourgogne-Franche-Comté" },
            "39": { region: "Bourgogne-Franche-Comté" },
            "58": { region: "Bourgogne-Franche-Comté" },
            "70": { region: "Bourgogne-Franche-Comté" },
            "71": { region: "Bourgogne-Franche-Comté" },
            "89": { region: "Bourgogne-Franche-Comté" },
            "90": { region: "Bourgogne-Franche-Comté" },
            "2A": { region: "Corse" },
            "2B": { region: "Corse" },
        };

        // Calculate weight and enrich orders with region info
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

            // Determine order region from postal code
            let orderRegion = null;
            let orderDepartment = null;
            if (customer?.address?.zipCode) {
                const zipCode = customer.address.zipCode.toString();
                const deptCode = zipCode.startsWith("97") || zipCode.startsWith("98")
                    ? zipCode.substring(0, 3)
                    : zipCode.substring(0, 2);

                const dept = FRENCH_DEPARTMENTS[deptCode];
                if (dept) {
                    orderRegion = dept.region;
                    orderDepartment = deptCode;
                }
            }

            // Parse opening time to minutes for sorting
            let openingMinutes = 9999; // Default late time
            if (customer?.openingTime) {
                const [hours, minutes] = customer.openingTime.split(':').map(Number);
                if (!isNaN(hours) && !isNaN(minutes)) {
                    openingMinutes = hours * 60 + minutes;
                }
            }

            return {
                ...order,
                totalWeight,
                coordinates: customer?.coordinates,
                address: customer?.address,
                openingTime: customer?.openingTime,
                closingTime: customer?.closingTime,
                openingMinutes, // For sorting
                orderRegion,
                orderDepartment,
            };
        }).filter(o => o.coordinates); // Only orders with coordinates

        console.log(`📍 ${enrichedOrders.length} orders have coordinates and region info`);

        // Group orders by region
        const ordersByRegion = {};
        enrichedOrders.forEach(order => {
            if (order.orderRegion) {
                if (!ordersByRegion[order.orderRegion]) {
                    ordersByRegion[order.orderRegion] = [];
                }
                ordersByRegion[order.orderRegion].push(order);
            }
        });

        console.log("\n📊 Orders by Region:");
        Object.entries(ordersByRegion).forEach(([region, orders]) => {
            console.log(`   ${region}: ${orders.length} orders`);
        });

        // Group trucks by base region
        const trucksByRegion = {};
        allRoutes.forEach(route => {
            if (route.region) {
                let baseRegion = route.region;
                const subRegionMatch = route.region.match(/^(.+?)\s+(East|West|South|North|Central)$/i);
                if (subRegionMatch) {
                    baseRegion = subRegionMatch[1];
                }

                if (!trucksByRegion[baseRegion]) {
                    trucksByRegion[baseRegion] = [];
                }
                trucksByRegion[baseRegion].push(route);
            }
        });

        console.log("\n🚚 Trucks by Region:");
        Object.entries(trucksByRegion).forEach(([region, trucks]) => {
            console.log(`   ${region}: ${trucks.length} trucks`);
        });

        // Distance calculation helper
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

        // Assignment results tracking
        const assignmentResults = {
            totalOrders: enrichedOrders.length,
            ordersAssigned: 0,
            ordersUnassigned: 0,
            trucksUsed: 0,
            truckDetails: [],
            unassignedOrders: [],
            missingTruckRegions: [],
        };

        // Track which trucks were modified
        const modifiedTrucks = new Map();

        // WAREHOUSE starting point
        const WAREHOUSE = { lat: 48.922385, lng: 2.395789 };

        // Process each region with NEAREST NEIGHBOR ALGORITHM
        for (const [region, orders] of Object.entries(ordersByRegion)) {
            console.log(`\n🌍 Processing Region: ${region} (${orders.length} orders)`);

            const trucksInRegion = trucksByRegion[region] || [];

            if (trucksInRegion.length === 0) {
                console.log(`   ⚠️  No trucks available for ${region}`);
                assignmentResults.missingTruckRegions.push({
                    region,
                    ordersCount: orders.length,
                    orders: orders.map(o => ({
                        DocNum: o.DocNum,
                        CardName: o.CardName,
                        city: o.address?.city,
                    })),
                });

                assignmentResults.unassignedOrders.push(...orders);
                assignmentResults.ordersUnassigned += orders.length;
                continue;
            }

            console.log(`   ✅ Found ${trucksInRegion.length} trucks for ${region}`);

            // Sort orders by opening time FIRST (earliest to latest)
            const sortedByTime = orders.sort((a, b) => a.openingMinutes - b.openingMinutes);

            // Create a pool of remaining orders
            let remainingOrders = [...sortedByTime];

            // NEAREST NEIGHBOR FILLING for each truck
            for (const truck of trucksInRegion) {
                if (remainingOrders.length === 0) break;

                // Initialize truck tracking
                if (!modifiedTrucks.has(truck._id.toString())) {
                    modifiedTrucks.set(truck._id.toString(), {
                        ...truck,
                        orders: [...truck.orders],
                        totalWeight: truck.totalWeightKg || 0,
                        ordersAdded: 0,
                    });
                }

                const modifiedTruck = modifiedTrucks.get(truck._id.toString());
                const maxWeight = truck.maxWeightKg || 1000;

                // Starting position for this truck
                let currentPosition = WAREHOUSE;

                // If truck already has orders, use last order position
                if (modifiedTruck.orders.length > 0) {
                    const lastOrder = modifiedTruck.orders[modifiedTruck.orders.length - 1];
                    // We need to fetch the coordinates from enrichedOrders
                    const lastOrderData = enrichedOrders.find(o => o._id.toString() === lastOrder.order.toString());
                    if (lastOrderData?.coordinates) {
                        currentPosition = lastOrderData.coordinates;
                    }
                }

                console.log(`\n   🚛 Filling truck: ${truck.truckName}`);
                console.log(`      Starting from: ${currentPosition.lat.toFixed(4)}, ${currentPosition.lng.toFixed(4)}`);
                console.log(`      Current capacity: ${modifiedTruck.totalWeight.toFixed(1)}/${maxWeight}kg`);

                // NEAREST NEIGHBOR LOOP
                while (remainingOrders.length > 0) {
                    // Find nearest order to current position that fits in truck
                    let nearestOrder = null;
                    let nearestDistance = Infinity;
                    let nearestIndex = -1;

                    for (let i = 0; i < remainingOrders.length; i++) {
                        const order = remainingOrders[i];
                        const orderWeight = order.totalWeight || 0;

                        // Check if order fits
                        if (modifiedTruck.totalWeight + orderWeight > maxWeight) {
                            continue; // Skip orders that don't fit
                        }

                        // Calculate distance from current position
                        const distance = calculateDistance(currentPosition, order.coordinates);

                        if (distance < nearestDistance) {
                            nearestDistance = distance;
                            nearestOrder = order;
                            nearestIndex = i;
                        }
                    }

                    // If no order found that fits, truck is full
                    if (!nearestOrder) {
                        console.log(`      ⚠️ No more orders fit in truck (${modifiedTruck.totalWeight.toFixed(1)}/${maxWeight}kg)`);
                        break;
                    }

                    // Assign nearest order to truck
                    modifiedTruck.orders.push({
                        order: nearestOrder._id,
                        sequenceNumber: modifiedTruck.orders.length + 1,
                        assignedAt: new Date(),
                        orderWeightKg: parseFloat(nearestOrder.totalWeight.toFixed(2)),
                    });

                    modifiedTruck.totalWeight += nearestOrder.totalWeight;
                    modifiedTruck.ordersAdded++;
                    assignmentResults.ordersAssigned++;

                    console.log(`      ✅ Added order #${nearestOrder.DocNum} (${nearestOrder.totalWeight.toFixed(1)}kg, ${nearestDistance.toFixed(1)}km away)`);
                    console.log(`         Opens: ${nearestOrder.openingTime || 'N/A'}`);

                    // Update current position to this order's location
                    currentPosition = nearestOrder.coordinates;

                    // Remove from remaining orders
                    remainingOrders.splice(nearestIndex, 1);
                }

                console.log(`      📊 Final: ${modifiedTruck.ordersAdded} orders added, ${modifiedTruck.totalWeight.toFixed(1)}/${maxWeight}kg used`);
            }

            // Add any remaining orders to unassigned
            if (remainingOrders.length > 0) {
                console.log(`   ⚠️  ${remainingOrders.length} orders couldn't fit in available trucks`);
                assignmentResults.unassignedOrders.push(...remainingOrders);
                assignmentResults.ordersUnassigned += remainingOrders.length;
            }
        }

        // Save all modified trucks to database
        console.log(`\n💾 Saving ${modifiedTrucks.size} modified trucks...`);

        for (const [truckId, modifiedTruck] of modifiedTrucks.entries()) {
            const route = await TruckRoute.findById(truckId);
            if (route) {
                route.orders = modifiedTruck.orders;
                route.totalOrders = route.orders.length;
                route.totalWeightKg = parseFloat(modifiedTruck.totalWeight.toFixed(2));

                const maxWeight = route.maxWeightKg || 1000;
                route.capacityUsedPercent = parseFloat(((modifiedTruck.totalWeight / maxWeight) * 100).toFixed(2));
                route.updatedAt = new Date();

                await route.save();

                assignmentResults.truckDetails.push({
                    truckId: route._id,
                    truckName: route.truckName,
                    region: route.region,
                    ordersAdded: modifiedTruck.ordersAdded,
                    totalOrders: route.totalOrders,
                    totalWeight: route.totalWeightKg,
                    capacityUsed: route.capacityUsedPercent,
                });

                assignmentResults.trucksUsed++;
                console.log(`   ✅ Saved ${route.truckName}: ${modifiedTruck.ordersAdded} orders added`);
            }
        }

        console.log("\n=== AUTO-FILL ALL TRUCKS COMPLETE ===");
        console.log(`📊 Summary:`);
        console.log(`   Total Orders: ${assignmentResults.totalOrders}`);
        console.log(`   Assigned: ${assignmentResults.ordersAssigned}`);
        console.log(`   Unassigned: ${assignmentResults.ordersUnassigned}`);
        console.log(`   Trucks Used: ${assignmentResults.trucksUsed}`);

        res.json({
            success: true,
            message: `Auto-filled ${assignmentResults.trucksUsed} trucks with ${assignmentResults.ordersAssigned} orders using nearest-neighbor algorithm`,
            summary: assignmentResults,
        });

    } catch (error) {
        console.error("❌ ERROR AUTO-FILLING TRUCKS:", error);
        res.status(500).json({
            success: false,
            message: "Error auto-filling trucks",
            error: error.message,
        });
    }
};

/**
 * Get single truck route (lightweight - no full reload)
 * GET /api/truck-routes/single/:routeId
 */
exports.getSingleRoute = async (req, res) => {
    try {
        const { routeId } = req.params;

        const route = await TruckRoute.findById(routeId).lean();

        if (!route) {
            return res.status(404).json({
                success: false,
                message: "Route not found"
            });
        }

        // Fetch only the orders for this truck
        const orderIds = route.orders.map(o => o.order);
        const orders = await SalesOrder.find({ _id: { $in: orderIds } })
            .select("DocNum DocEntry CardCode CardName DocTotal DocumentLines")
            .lean();

        const orderMap = new Map(orders.map(o => [o._id.toString(), o]));

        // Get customers
        const cardCodes = orders.map(o => o.CardCode);
        const customers = await Customer.find({ CardCode: { $in: cardCodes } })
            .select("CardCode coordinates address openingTime closingTime")
            .lean();

        const customerMap = new Map(customers.map(c => [c.CardCode, c]));

        // Get items for weight
        const allItemCodes = new Set();
        orders.forEach(order => {
            if (order.DocumentLines) {
                order.DocumentLines.forEach(line => {
                    if (line.ItemCode) allItemCodes.add(line.ItemCode);
                });
            }
        });

        const items = await Item.find({ ItemCode: { $in: Array.from(allItemCodes) } })
            .select("ItemCode SalesUnitWeight")
            .lean();

        const itemMap = new Map(items.map(item => [item.ItemCode, item]));

        // Enrich orders
        const enrichedOrders = route.orders.map(orderItem => {
            const order = orderMap.get(orderItem.order.toString());
            if (!order) return orderItem;

            const customer = customerMap.get(order.CardCode);

            let totalWeight = 0;
            if (order.DocumentLines) {
                order.DocumentLines.forEach(line => {
                    if (line.ItemCode && line.Quantity) {
                        const item = itemMap.get(line.ItemCode);
                        if (item?.SalesUnitWeight) {
                            totalWeight += item.SalesUnitWeight * line.Quantity;
                        }
                    }
                });
            }

            return {
                ...orderItem,
                orderWeightKg: parseFloat(totalWeight.toFixed(2)),
                order: {
                    ...order,
                    address: customer?.address,
                    totalWeight,
                    weightUnit: "kg",
                },
                coordinates: customer?.coordinates || null,
                storeHours: {
                    openingTime: customer?.openingTime || null,
                    closingTime: customer?.closingTime || null,
                }
            };
        });

        res.json({
            success: true,
            route: {
                ...route,
                orders: enrichedOrders
            }
        });
    } catch (error) {
        console.error("Error fetching single route:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching route",
            error: error.message
        });
    }
};