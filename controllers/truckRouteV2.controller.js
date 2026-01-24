// controllers/truckRouteV2.controller.js
const TruckSchedule = require("../models/TruckSchedule");
const TruckRoute = require("../models/TruckRoute");
const SalesOrder = require("../models/SalesOrder");
const Customer = require("../models/Customer");
const Item = require("../models/item");

/**
 * OPTIMIZED TRUCK ROUTE CONTROLLER V2
 * - Simplified logic
 * - Better performance
 * - Cleaner API responses
 */

// ==========================================
// SCHEDULE MANAGEMENT (Templates)
// ==========================================

/**
 * Get all schedules - lightweight
 */
exports.getSchedules = async (req, res) => {
    try {
        const schedules = await TruckSchedule.find({ isActive: true })
            .select('dayOfWeek region departments trucks')
            .sort({ dayOfWeek: 1 })
            .lean();

        res.json({
            success: true,
            schedules,
            count: schedules.length
        });
    } catch (error) {
        console.error("Error fetching schedules:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Create/Update schedule - simplified
 */
exports.upsertSchedule = async (req, res) => {
    try {
        const { dayOfWeek, region, departments = [], trucks } = req.body;

        if (!dayOfWeek || !trucks || trucks.length === 0) {
            return res.status(400).json({
                success: false,
                message: "dayOfWeek and trucks are required"
            });
        }

        const schedule = await TruckSchedule.findOneAndUpdate(
            { dayOfWeek, region },
            {
                dayOfWeek,
                region,
                departments,
                trucks,
                numberOfTrucks: trucks.length,
                isActive: true,
                updatedAt: new Date()
            },
            { upsert: true, new: true }
        );

        res.json({
            success: true,
            schedule,
            message: "Schedule saved"
        });
    } catch (error) {
        console.error("Error saving schedule:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Delete schedule
 */
exports.deleteSchedule = async (req, res) => {
    try {
        await TruckSchedule.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: "Schedule deleted" });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ==========================================
// ROUTE MANAGEMENT (Daily Operations)
// ==========================================

/**
 * Get routes for date - HEAVILY OPTIMIZED
 */
exports.getRoutesForDate = async (req, res) => {
    try {
        const { date } = req.params;
        const targetDate = new Date(date + "T00:00:00.000Z");
        const nextDay = new Date(targetDate);
        nextDay.setDate(nextDay.getDate() + 1);

        // Single aggregation pipeline - much faster
        const routes = await TruckRoute.aggregate([
            {
                $match: {
                    deliveryDate: { $gte: targetDate, $lt: nextDay }
                }
            },
            {
                $lookup: {
                    from: "salesorders",
                    localField: "orders.order",
                    foreignField: "_id",
                    as: "orderDetails"
                }
            },
            {
                $addFields: {
                    enrichedOrders: {
                        $map: {
                            input: "$orders",
                            as: "orderItem",
                            in: {
                                $mergeObjects: [
                                    "$$orderItem",
                                    {
                                        orderData: {
                                            $arrayElemAt: [
                                                {
                                                    $filter: {
                                                        input: "$orderDetails",
                                                        cond: { $eq: ["$$this._id", "$$orderItem.order"] }
                                                    }
                                                },
                                                0
                                            ]
                                        }
                                    }
                                ]
                            }
                        }
                    }
                }
            },
            {
                $project: {
                    truckName: 1,
                    region: 1,
                    maxWeightKg: 1,
                    totalWeightKg: 1,
                    capacityUsedPercent: 1,
                    deliveryDate: 1,
                    status: 1,
                    orders: "$enrichedOrders"
                }
            }
        ]);

        res.json({
            success: true,
            routes,
            count: routes.length
        });
    } catch (error) {
        console.error("Error fetching routes:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Initialize trucks for date - simplified
 */
exports.initializeTrucks = async (req, res) => {
    try {
        const { date } = req.body;
        const deliveryDate = new Date(date);
        const dayOfWeek = deliveryDate.toLocaleDateString("en-US", { weekday: "long" });

        const schedules = await TruckSchedule.find({
            dayOfWeek,
            isActive: true
        }).lean();

        const operations = [];
        for (const schedule of schedules) {
            for (const truck of schedule.trucks) {
                operations.push({
                    updateOne: {
                        filter: {
                            deliveryDate,
                            scheduleId: schedule._id,
                            truckNumber: truck.truckNumber
                        },
                        update: {
                            $setOnInsert: {
                                deliveryDate,
                                scheduleId: schedule._id,
                                dayOfWeek,
                                region: schedule.region,
                                departments: schedule.departments,
                                truckNumber: truck.truckNumber,
                                truckName: truck.truckName,
                                maxWeightKg: truck.maxWeightKg,
                                orders: [],
                                status: "planning",
                                totalWeightKg: 0,
                                capacityUsedPercent: 0
                            }
                        },
                        upsert: true
                    }
                });
            }
        }

        const result = await TruckRoute.bulkWrite(operations);

        res.json({
            success: true,
            message: `Initialized ${result.upsertedCount} trucks`,
            trucksCreated: result.upsertedCount
        });
    } catch (error) {
        console.error("Error initializing trucks:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Get available orders - OPTIMIZED
 */
exports.getAvailableOrders = async (req, res) => {
    try {
        const { date } = req.params;
        const targetDate = new Date(date + "T00:00:00.000Z");
        const nextDay = new Date(targetDate);
        nextDay.setDate(nextDay.getDate() + 1);

        // Get assigned order IDs
        const routes = await TruckRoute.find({
            deliveryDate: { $gte: targetDate, $lt: nextDay }
        }).select('orders.order').lean();

        const assignedIds = new Set(
            routes.flatMap(r => r.orders.map(o => o.order.toString()))
        );

        // Get unassigned orders with customer data in one query
        const mongoose = require('mongoose');
        const excludeIds = Array.from(assignedIds).map(id => new mongoose.Types.ObjectId(id));

        const orders = await SalesOrder.aggregate([
            {
                $match: {
                    RequriedDate: { $gte: targetDate, $lt: nextDay },
                    _id: { $nin: excludeIds }
                }
            },
            {
                $lookup: {
                    from: "customers",
                    localField: "CardCode",
                    foreignField: "CardCode",
                    as: "customer"
                }
            },
            {
                $unwind: { path: "$customer", preserveNullAndEmptyArrays: true }
            },
            {
                $match: {
                    "customer.coordinates.lat": { $exists: true }
                }
            },
            {
                $project: {
                    DocEntry: 1,
                    DocNum: 1,
                    CardCode: 1,
                    CardName: 1,
                    DocTotal: 1,
                    coordinates: "$customer.coordinates",
                    address: "$customer.address",
                    openingTime: "$customer.openingTime",
                    closingTime: "$customer.closingTime"
                }
            }
        ]);

        res.json({
            success: true,
            orders,
            count: orders.length
        });
    } catch (error) {
        console.error("Error fetching available orders:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// ==========================================
// ORDER ASSIGNMENT
// ==========================================

/**
 * Assign order to truck - simplified
 */
exports.assignOrder = async (req, res) => {
    try {
        const { routeId } = req.params;
        const { orderDocEntry } = req.body;

        const route = await TruckRoute.findById(routeId);
        if (!route) {
            return res.status(404).json({ success: false, message: "Route not found" });
        }

        const order = await SalesOrder.findOne({ DocEntry: orderDocEntry });
        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        // Check if already assigned
        if (route.orders.some(o => o.order.toString() === order._id.toString())) {
            return res.status(400).json({ success: false, message: "Order already assigned" });
        }

        // Calculate weight
        const weight = await calculateOrderWeight(order);

        // Check capacity
        const newWeight = (route.totalWeightKg || 0) + weight;
        if (newWeight > route.maxWeightKg) {
            return res.status(400).json({
                success: false,
                message: "Exceeds truck capacity",
                available: route.maxWeightKg - route.totalWeightKg,
                required: weight
            });
        }

        // Add order
        route.orders.push({
            order: order._id,
            sequenceNumber: route.orders.length + 1,
            assignedAt: new Date(),
            orderWeightKg: weight
        });

        route.totalWeightKg = newWeight;
        route.capacityUsedPercent = (newWeight / route.maxWeightKg) * 100;
        await route.save();

        res.json({
            success: true,
            message: "Order assigned",
            route: await enrichRoute(route)
        });
    } catch (error) {
        console.error("Error assigning order:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Remove order from truck
 */
exports.removeOrder = async (req, res) => {
    try {
        const { routeId, orderDocNum } = req.params;

        const route = await TruckRoute.findById(routeId);
        if (!route) {
            return res.status(404).json({ success: false, message: "Route not found" });
        }

        const order = await SalesOrder.findOne({ DocNum: parseInt(orderDocNum) });
        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        const orderItem = route.orders.find(o => o.order.toString() === order._id.toString());
        const removedWeight = orderItem?.orderWeightKg || 0;

        route.orders = route.orders.filter(o => o.order.toString() !== order._id.toString());
        route.totalWeightKg = Math.max(0, route.totalWeightKg - removedWeight);
        route.capacityUsedPercent = (route.totalWeightKg / route.maxWeightKg) * 100;

        await route.save();

        res.json({
            success: true,
            message: "Order removed",
            route: await enrichRoute(route)
        });
    } catch (error) {
        console.error("Error removing order:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

/**
 * Auto-fill truck with smart assignment
 */
exports.autoFillTruck = async (req, res) => {
    try {
        const { routeId } = req.params;
        const { strategy = "balanced" } = req.body;

        const route = await TruckRoute.findById(routeId);
        if (!route) {
            return res.status(404).json({ success: false, message: "Route not found" });
        }

        // Get available orders for this region
        const availableOrders = await getOrdersForRegion(
            route.deliveryDate,
            route.region,
            route.departments
        );

        // Sort by strategy
        const sortedOrders = sortOrdersByStrategy(availableOrders, strategy);

        // Fill truck
        let addedCount = 0;
        const maxWeight = route.maxWeightKg || 1000;
        let currentWeight = route.totalWeightKg || 0;

        for (const order of sortedOrders) {
            const weight = await calculateOrderWeight(order);

            if (currentWeight + weight <= maxWeight) {
                route.orders.push({
                    order: order._id,
                    sequenceNumber: route.orders.length + 1,
                    assignedAt: new Date(),
                    orderWeightKg: weight
                });
                currentWeight += weight;
                addedCount++;
            }
        }

        route.totalWeightKg = currentWeight;
        route.capacityUsedPercent = (currentWeight / maxWeight) * 100;
        await route.save();

        res.json({
            success: true,
            message: `Added ${addedCount} orders`,
            ordersAdded: addedCount,
            capacityUsed: route.capacityUsedPercent.toFixed(1),
            route: await enrichRoute(route)
        });
    } catch (error) {
        console.error("Error auto-filling truck:", error);
        res.status(500).json({ success: false, message: error.message });
    }
};

// ==========================================
// HELPER FUNCTIONS
// ==========================================

async function calculateOrderWeight(order) {
    if (!order.DocumentLines || !Array.isArray(order.DocumentLines)) {
        return 0;
    }

    const itemCodes = order.DocumentLines.map(line => line.ItemCode).filter(Boolean);
    const items = await Item.find({ ItemCode: { $in: itemCodes } })
        .select('ItemCode SalesUnitWeight')
        .lean();

    const itemMap = new Map(items.map(i => [i.ItemCode, i.SalesUnitWeight || 0]));

    return order.DocumentLines.reduce((total, line) => {
        const weight = itemMap.get(line.ItemCode) || 0;
        return total + (weight * (line.Quantity || 0));
    }, 0);
}

async function enrichRoute(route) {
    const populated = await TruckRoute.findById(route._id)
        .populate({
            path: 'orders.order',
            select: 'DocNum CardCode CardName DocTotal'
        })
        .lean();

    // Add customer data
    const cardCodes = populated.orders.map(o => o.order?.CardCode).filter(Boolean);
    const customers = await Customer.find({ CardCode: { $in: cardCodes } })
        .select('CardCode coordinates')
        .lean();

    const customerMap = new Map(customers.map(c => [c.CardCode, c]));

    populated.orders.forEach(orderItem => {
        if (orderItem.order) {
            const customer = customerMap.get(orderItem.order.CardCode);
            if (customer) {
                orderItem.coordinates = customer.coordinates;
            }
        }
    });

    return populated;
}

async function getOrdersForRegion(date, region, departments = []) {
    const targetDate = new Date(date);
    const nextDay = new Date(targetDate);
    nextDay.setDate(nextDay.getDate() + 1);

    // Get assigned order IDs
    const routes = await TruckRoute.find({
        deliveryDate: { $gte: targetDate, $lt: nextDay }
    }).select('orders.order').lean();

    const assignedIds = new Set(routes.flatMap(r => r.orders.map(o => o.order.toString())));

    // Build query
    const query = {
        RequriedDate: { $gte: targetDate, $lt: nextDay }
    };

    if (assignedIds.size > 0) {
        const mongoose = require('mongoose');
        const excludeIds = Array.from(assignedIds).map(id => new mongoose.Types.ObjectId(id));
        query._id = { $nin: excludeIds };
    }

    // Get orders with customer data
    const orders = await SalesOrder.aggregate([
        { $match: query },
        {
            $lookup: {
                from: "customers",
                localField: "CardCode",
                foreignField: "CardCode",
                as: "customer"
            }
        },
        { $unwind: { path: "$customer", preserveNullAndEmptyArrays: true } },
        {
            $match: {
                "customer.coordinates.lat": { $exists: true }
            }
        }
    ]);

    // Filter by region/departments if specified
    if (region || (departments && departments.length > 0)) {
        return orders.filter(order => {
            const zipCode = order.customer?.address?.zipCode;
            if (!zipCode) return false;

            const deptCode = zipCode.toString().substring(0, 2);

            if (departments && departments.length > 0) {
                return departments.includes(deptCode);
            }

            // Check region (simplified - you may need to add full dept->region mapping)
            return true;
        });
    }

    return orders;
}

function sortOrdersByStrategy(orders, strategy) {
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

    if (strategy === "distance") {
        return orders.sort((a, b) => {
            const distA = calculateDistance(WAREHOUSE, a.customer.coordinates);
            const distB = calculateDistance(WAREHOUSE, b.customer.coordinates);
            return distA - distB;
        });
    }

    // Default: balanced (opening time + distance)
    return orders.sort((a, b) => {
        const timeA = a.customer.openingTime || "09:00";
        const timeB = b.customer.openingTime || "09:00";
        return timeA.localeCompare(timeB);
    });
}

module.exports = exports;