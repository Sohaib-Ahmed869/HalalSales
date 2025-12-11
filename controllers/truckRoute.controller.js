// controllers/truckRoute.controller.js
const TruckSchedule = require("../models/TruckSchedule");
const TruckRoute = require("../models/TruckRoute");
const SalesOrder = require("../models/SalesOrder");
const Customer = require("../models/Customer");

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
        const deliveryDate = new Date(date);

        const routes = await TruckRoute.find({ deliveryDate })
            .populate({
                path: "orders.order",
                select: "DocNum CardCode CardName DocTotal Address DocumentStatus",
            })
            .lean();

        // Get customer details for each route
        for (const route of routes) {
            for (const orderItem of route.orders) {
                if (orderItem.order) {
                    const customer = await Customer.findOne({
                        CardCode: orderItem.order.CardCode,
                    })
                        .select("coordinates address deliveryAddress")
                        .lean();

                    if (customer) {
                        orderItem.coordinates = customer.coordinates;
                        orderItem.address = customer.address || customer.deliveryAddress;
                    }
                }
            }
        }

        res.json({
            success: true,
            date: deliveryDate,
            routes,
        });
    } catch (error) {
        console.error("Error fetching routes by date:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching routes",
            error: error.message,
        });
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
        } else if (order.DocTotal) {
            // Fallback: estimate 1kg per £10
            orderWeightKg = order.DocTotal / 10;
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
        const deliveryDate = new Date(date);

        // Set date range for the entire day
        const startOfDay = new Date(deliveryDate);
        startOfDay.setHours(0, 0, 0, 0);

        const endOfDay = new Date(deliveryDate);
        endOfDay.setHours(23, 59, 59, 999);

        // Get all routes for this date
        const routes = await TruckRoute.find({ deliveryDate }).lean();

        // Get all assigned order IDs
        const assignedOrderIds = routes.flatMap((r) =>
            r.orders.map((o) => o.order.toString())
        );

        console.log(`Found ${routes.length} routes with ${assignedOrderIds.length} assigned orders`);

        // Find Sales Orders for this date not yet assigned
        const query = {
            DocDate: {
                $gte: startOfDay,
                $lte: endOfDay,
            },
            _id: { $nin: assignedOrderIds },
            DocumentStatus: { $ne: "Closed" }, // Only open orders
        };

        const orders = await SalesOrder.find(query)
            .select("DocEntry DocNum DocDate CardCode CardName DocTotal Address DocumentStatus U_ExtraData")
            .sort({ DocNum: -1 })
            .lean();

        console.log(`Found ${orders.length} unassigned sales orders for ${date}`);

        // Get customer details with coordinates and calculate weights
        const ordersWithDetails = [];

        for (const order of orders) {
            const customer = await Customer.findOne({ CardCode: order.CardCode })
                .select("coordinates address deliveryAddress")
                .lean();

            // Calculate estimated weight from order
            let estimatedWeightKg = 0;
            if (order.U_ExtraData?.totalWeight) {
                estimatedWeightKg = parseFloat(order.U_ExtraData.totalWeight);
            } else if (order.DocTotal) {
                // Fallback: estimate 1kg per £10 of order value
                estimatedWeightKg = order.DocTotal / 10;
            }

            // Only include orders with valid coordinates
            if (customer && customer.coordinates && customer.coordinates.lat) {
                ordersWithDetails.push({
                    DocEntry: order.DocEntry,
                    DocNum: order.DocNum,
                    DocDate: order.DocDate,
                    CardCode: order.CardCode,
                    CardName: order.CardName,
                    DocTotal: order.DocTotal,
                    DocumentStatus: order.DocumentStatus,
                    coordinates: customer.coordinates,
                    address: customer.address || customer.deliveryAddress,
                    estimatedWeightKg: parseFloat(estimatedWeightKg.toFixed(2)),
                });
            } else {
                console.log(`Order ${order.DocNum} skipped - customer ${order.CardCode} has no coordinates`);
            }
        }

        console.log(`Returning ${ordersWithDetails.length} orders with coordinates and weights`);

        res.json({
            success: true,
            date: deliveryDate,
            totalOrders: ordersWithDetails.length,
            orders: ordersWithDetails,
        });
    } catch (error) {
        console.error("Error fetching available orders:", error);
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