// controllers/dashboardController.js
const SalesOrder = require("../models/SalesOrder");
const Quotation = require("../models/Quotation");
const Invoice = require("../models/Invoice");
const Item = require("../models/item");
const User = require("../models/User");
const mongoose = require("mongoose");

// Helper: Get date range from query params (defaults to this week)
function getDateRange(query) {
    const now = new Date();
    let fromDate, toDate;

    if (query.fromDate && query.toDate) {
        fromDate = new Date(query.fromDate);
        toDate = new Date(query.toDate);
        toDate.setHours(23, 59, 59, 999);
    } else {
        // Default: this week (Monday to now)
        const dayOfWeek = now.getDay();
        const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        fromDate = new Date(now);
        fromDate.setDate(now.getDate() - diffToMonday);
        fromDate.setHours(0, 0, 0, 0);
        toDate = new Date(now);
        toDate.setHours(23, 59, 59, 999);
    }

    return { fromDate, toDate };
}

// Helper: Get previous period of same length for comparison
function getPreviousPeriod(fromDate, toDate) {
    const duration = toDate.getTime() - fromDate.getTime();
    const prevTo = new Date(fromDate.getTime() - 1);
    const prevFrom = new Date(prevTo.getTime() - duration);
    return { prevFrom, prevTo };
}

// Helper: Calculate percentage change
function pctChange(current, previous) {
    if (previous === 0) return current > 0 ? 100 : 0;
    return parseFloat((((current - previous) / previous) * 100).toFixed(1));
}

/**
 * GET /api/dashboard/summary
 * Top-level KPI cards with period comparison
 */
exports.getSummary = async (req, res) => {
    try {
        const { fromDate, toDate } = getDateRange(req.query);
        const { prevFrom, prevTo } = getPreviousPeriod(fromDate, toDate);

        const dateFilter = { $gte: fromDate, $lte: toDate };
        const prevDateFilter = { $gte: prevFrom, $lte: prevTo };

        // Current period aggregations (run in parallel)
        const [
            orderStats,
            prevOrderStats,
            invoiceStats,
            prevInvoiceStats,
            quotationStats,
            prevQuotationStats,
            activeCustomersCount,
            prevActiveCustomersCount,
        ] = await Promise.all([
            // Orders - current
            SalesOrder.aggregate([
                { $match: { DocDate: dateFilter } },
                {
                    $group: {
                        _id: null,
                        count: { $sum: 1 },
                        totalValue: { $sum: "$DocTotal" },
                        avgOrderValue: { $avg: "$DocTotal" },
                        totalVat: { $sum: "$VatSum" },
                        openOrders: {
                            $sum: {
                                $cond: [
                                    { $in: ["$DocumentStatus", ["bost_Open", "O"]] },
                                    1,
                                    0,
                                ],
                            },
                        },
                        closedOrders: {
                            $sum: {
                                $cond: [
                                    { $in: ["$DocumentStatus", ["bost_Close", "C"]] },
                                    1,
                                    0,
                                ],
                            },
                        },
                        syncedCount: {
                            $sum: { $cond: [{ $eq: ["$SyncedWithSAP", true] }, 1, 0] },
                        },
                        unsyncedCount: {
                            $sum: { $cond: [{ $eq: ["$SyncedWithSAP", false] }, 1, 0] },
                        },
                    },
                },
            ]),
            // Orders - previous
            SalesOrder.aggregate([
                { $match: { DocDate: prevDateFilter } },
                {
                    $group: {
                        _id: null,
                        count: { $sum: 1 },
                        totalValue: { $sum: "$DocTotal" },
                    },
                },
            ]),
            // Invoices - current
            Invoice.aggregate([
                { $match: { DocDate: dateFilter } },
                {
                    $group: {
                        _id: null,
                        count: { $sum: 1 },
                        totalValue: { $sum: "$DocTotal" },
                        avgInvoiceValue: { $avg: "$DocTotal" },
                        totalVat: { $sum: "$VatSum" },
                        totalPaid: { $sum: "$PaidToDate" },
                        posCount: {
                            $sum: { $cond: [{ $eq: ["$isPOS", true] }, 1, 0] },
                        },
                        deliveryCount: {
                            $sum: { $cond: [{ $eq: ["$isDelivery", true] }, 1, 0] },
                        },
                    },
                },
            ]),
            // Invoices - previous
            Invoice.aggregate([
                { $match: { DocDate: prevDateFilter } },
                {
                    $group: {
                        _id: null,
                        count: { $sum: 1 },
                        totalValue: { $sum: "$DocTotal" },
                    },
                },
            ]),
            // Quotations - current
            Quotation.aggregate([
                { $match: { DocDate: dateFilter } },
                {
                    $group: {
                        _id: null,
                        count: { $sum: 1 },
                        totalValue: { $sum: "$DocTotal" },
                        approvedCount: {
                            $sum: {
                                $cond: [{ $eq: ["$approvalStatus", "approved"] }, 1, 0],
                            },
                        },
                        pendingCount: {
                            $sum: {
                                $cond: [{ $eq: ["$approvalStatus", "pending"] }, 1, 0],
                            },
                        },
                        rejectedCount: {
                            $sum: {
                                $cond: [{ $eq: ["$approvalStatus", "rejected"] }, 1, 0],
                            },
                        },
                        convertedCount: {
                            $sum: {
                                $cond: [
                                    { $ne: ["$ConvertedToOrderDocEntry", null] },
                                    1,
                                    0,
                                ],
                            },
                        },
                    },
                },
            ]),
            // Quotations - previous
            Quotation.aggregate([
                { $match: { DocDate: prevDateFilter } },
                {
                    $group: {
                        _id: null,
                        count: { $sum: 1 },
                        totalValue: { $sum: "$DocTotal" },
                    },
                },
            ]),
            // Active customers (unique CardCodes in orders this period)
            SalesOrder.distinct("CardCode", { DocDate: dateFilter }),
            SalesOrder.distinct("CardCode", { DocDate: prevDateFilter }),
        ]);

        const cur = {
            orders: orderStats[0] || { count: 0, totalValue: 0, avgOrderValue: 0, totalVat: 0, openOrders: 0, closedOrders: 0, syncedCount: 0, unsyncedCount: 0 },
            invoices: invoiceStats[0] || { count: 0, totalValue: 0, avgInvoiceValue: 0, totalVat: 0, totalPaid: 0, posCount: 0, deliveryCount: 0 },
            quotations: quotationStats[0] || { count: 0, totalValue: 0, approvedCount: 0, pendingCount: 0, rejectedCount: 0, convertedCount: 0 },
        };
        const prev = {
            orders: prevOrderStats[0] || { count: 0, totalValue: 0 },
            invoices: prevInvoiceStats[0] || { count: 0, totalValue: 0 },
            quotations: prevQuotationStats[0] || { count: 0, totalValue: 0 },
        };

        res.status(200).json({
            success: true,
            data: {
                period: { fromDate, toDate },
                previousPeriod: { fromDate: prevFrom, toDate: prevTo },
                orders: {
                    ...cur.orders,
                    change: {
                        count: pctChange(cur.orders.count, prev.orders.count),
                        value: pctChange(cur.orders.totalValue, prev.orders.totalValue),
                    },
                },
                invoices: {
                    ...cur.invoices,
                    outstandingAmount: (cur.invoices.totalValue || 0) - (cur.invoices.totalPaid || 0),
                    change: {
                        count: pctChange(cur.invoices.count, prev.invoices.count),
                        value: pctChange(cur.invoices.totalValue, prev.invoices.totalValue),
                    },
                },
                quotations: {
                    ...cur.quotations,
                    conversionRate: cur.quotations.count > 0
                        ? parseFloat(((cur.quotations.convertedCount / cur.quotations.count) * 100).toFixed(1))
                        : 0,
                    change: {
                        count: pctChange(cur.quotations.count, prev.quotations.count),
                        value: pctChange(cur.quotations.totalValue, prev.quotations.totalValue),
                    },
                },
                customers: {
                    activeCount: activeCustomersCount.length,
                    previousActiveCount: prevActiveCustomersCount.length,
                    change: pctChange(activeCustomersCount.length, prevActiveCustomersCount.length),
                },
            },
        });
    } catch (error) {
        console.error("Error in getSummary:", error);
        res.status(500).json({ success: false, message: "Error fetching dashboard summary", error: error.message });
    }
};

/**
 * GET /api/dashboard/sales-chart
 * Daily sales data for charting (orders + invoices)
 */
exports.getSalesChart = async (req, res) => {
    try {
        const { fromDate, toDate } = getDateRange(req.query);

        const [ordersByDay, invoicesByDay] = await Promise.all([
            SalesOrder.aggregate([
                { $match: { DocDate: { $gte: fromDate, $lte: toDate } } },
                {
                    $group: {
                        _id: { $dateToString: { format: "%Y-%m-%d", date: "$DocDate" } },
                        orderCount: { $sum: 1 },
                        orderValue: { $sum: "$DocTotal" },
                    },
                },
                { $sort: { _id: 1 } },
            ]),
            Invoice.aggregate([
                { $match: { DocDate: { $gte: fromDate, $lte: toDate } } },
                {
                    $group: {
                        _id: { $dateToString: { format: "%Y-%m-%d", date: "$DocDate" } },
                        invoiceCount: { $sum: 1 },
                        invoiceValue: { $sum: "$DocTotal" },
                    },
                },
                { $sort: { _id: 1 } },
            ]),
        ]);

        // Merge into a unified daily dataset
        const dayMap = {};
        const current = new Date(fromDate);
        while (current <= toDate) {
            const key = current.toISOString().split("T")[0];
            dayMap[key] = { date: key, orderCount: 0, orderValue: 0, invoiceCount: 0, invoiceValue: 0 };
            current.setDate(current.getDate() + 1);
        }
        ordersByDay.forEach((d) => {
            if (dayMap[d._id]) {
                dayMap[d._id].orderCount = d.orderCount;
                dayMap[d._id].orderValue = d.orderValue;
            }
        });
        invoicesByDay.forEach((d) => {
            if (dayMap[d._id]) {
                dayMap[d._id].invoiceCount = d.invoiceCount;
                dayMap[d._id].invoiceValue = d.invoiceValue;
            }
        });

        res.status(200).json({
            success: true,
            data: Object.values(dayMap),
        });
    } catch (error) {
        console.error("Error in getSalesChart:", error);
        res.status(500).json({ success: false, message: "Error fetching sales chart data", error: error.message });
    }
};

/**
 * GET /api/dashboard/top-customers
 * Top customers by revenue in the period
 */
exports.getTopCustomers = async (req, res) => {
    try {
        const { fromDate, toDate } = getDateRange(req.query);
        const limit = parseInt(req.query.limit) || 10;

        const topCustomers = await SalesOrder.aggregate([
            { $match: { DocDate: { $gte: fromDate, $lte: toDate } } },
            {
                $group: {
                    _id: "$CardCode",
                    cardName: { $first: "$CardName" },
                    orderCount: { $sum: 1 },
                    totalRevenue: { $sum: "$DocTotal" },
                    avgOrderValue: { $avg: "$DocTotal" },
                    lastOrderDate: { $max: "$DocDate" },
                },
            },
            { $sort: { totalRevenue: -1 } },
            { $limit: limit },
            {
                $project: {
                    _id: 0,
                    cardCode: "$_id",
                    cardName: 1,
                    orderCount: 1,
                    totalRevenue: { $round: ["$totalRevenue", 2] },
                    avgOrderValue: { $round: ["$avgOrderValue", 2] },
                    lastOrderDate: 1,
                },
            },
        ]);

        res.status(200).json({ success: true, data: topCustomers });
    } catch (error) {
        console.error("Error in getTopCustomers:", error);
        res.status(500).json({ success: false, message: "Error fetching top customers", error: error.message });
    }
};

/**
 * GET /api/dashboard/top-items
 * Top selling items by quantity and revenue
 */
exports.getTopItems = async (req, res) => {
    try {
        const { fromDate, toDate } = getDateRange(req.query);
        const limit = parseInt(req.query.limit) || 15;
        const source = req.query.source || "orders"; // "orders" or "invoices"

        const Model = source === "invoices" ? Invoice : SalesOrder;

        const topItems = await Model.aggregate([
            { $match: { DocDate: { $gte: fromDate, $lte: toDate } } },
            { $unwind: "$DocumentLines" },
            {
                $group: {
                    _id: "$DocumentLines.ItemCode",
                    itemDescription: { $first: "$DocumentLines.ItemDescription" },
                    totalQuantity: { $sum: "$DocumentLines.Quantity" },
                    totalRevenue: { $sum: "$DocumentLines.LineTotal" },
                    avgPrice: { $avg: "$DocumentLines.Price" },
                    orderCount: { $addToSet: "$DocNum" },
                },
            },
            {
                $project: {
                    _id: 0,
                    itemCode: "$_id",
                    itemDescription: 1,
                    totalQuantity: 1,
                    totalRevenue: { $round: ["$totalRevenue", 2] },
                    avgPrice: { $round: ["$avgPrice", 2] },
                    orderCount: { $size: "$orderCount" },
                },
            },
            { $sort: { totalRevenue: -1 } },
            { $limit: limit },
        ]);

        res.status(200).json({ success: true, data: topItems });
    } catch (error) {
        console.error("Error in getTopItems:", error);
        res.status(500).json({ success: false, message: "Error fetching top items", error: error.message });
    }
};

/**
 * GET /api/dashboard/team-performance
 * Sales agent performance: orders, revenue, login activity
 */
exports.getTeamPerformance = async (req, res) => {
    try {
        const { fromDate, toDate } = getDateRange(req.query);

        // Get all active sales agents and managers
        const agents = await User.find({
            role: { $in: ["sales_agent", "sales_manager"] },
            deactivated: false,
        }).select("firstName lastName email role target lastLogin manager").lean();

        const agentIds = agents.map((a) => a._id);

        // Orders per agent in period
        const agentOrders = await SalesOrder.aggregate([
            {
                $match: {
                    DocDate: { $gte: fromDate, $lte: toDate },
                    salesAgent: { $in: agentIds },
                },
            },
            {
                $group: {
                    _id: "$salesAgent",
                    orderCount: { $sum: 1 },
                    totalRevenue: { $sum: "$DocTotal" },
                    avgOrderValue: { $avg: "$DocTotal" },
                    uniqueCustomers: { $addToSet: "$CardCode" },
                },
            },
        ]);

        // Quotations per agent
        const agentQuotations = await Quotation.aggregate([
            {
                $match: {
                    DocDate: { $gte: fromDate, $lte: toDate },
                    salesAgent: { $in: agentIds },
                },
            },
            {
                $group: {
                    _id: "$salesAgent",
                    quotationCount: { $sum: 1 },
                    quotationValue: { $sum: "$DocTotal" },
                    convertedCount: {
                        $sum: {
                            $cond: [{ $ne: ["$ConvertedToOrderDocEntry", null] }, 1, 0],
                        },
                    },
                },
            },
        ]);

        // Build lookup maps
        const orderMap = {};
        agentOrders.forEach((a) => { orderMap[a._id.toString()] = a; });
        const quotationMap = {};
        agentQuotations.forEach((a) => { quotationMap[a._id.toString()] = a; });

        const teamData = agents.map((agent) => {
            const id = agent._id.toString();
            const orders = orderMap[id] || { orderCount: 0, totalRevenue: 0, avgOrderValue: 0, uniqueCustomers: [] };
            const quotes = quotationMap[id] || { quotationCount: 0, quotationValue: 0, convertedCount: 0 };

            return {
                agentId: agent._id,
                name: `${agent.firstName} ${agent.lastName}`,
                email: agent.email,
                role: agent.role,
                lastLogin: agent.lastLogin,
                target: agent.target || 0,
                orders: {
                    count: orders.orderCount,
                    totalRevenue: parseFloat((orders.totalRevenue || 0).toFixed(2)),
                    avgOrderValue: parseFloat((orders.avgOrderValue || 0).toFixed(2)),
                    uniqueCustomers: (orders.uniqueCustomers || []).length,
                },
                quotations: {
                    count: quotes.quotationCount,
                    totalValue: parseFloat((quotes.quotationValue || 0).toFixed(2)),
                    converted: quotes.convertedCount,
                    conversionRate: quotes.quotationCount > 0
                        ? parseFloat(((quotes.convertedCount / quotes.quotationCount) * 100).toFixed(1))
                        : 0,
                },
                targetAchievement: agent.target > 0
                    ? parseFloat((((orders.totalRevenue || 0) / agent.target) * 100).toFixed(1))
                    : null,
            };
        });

        // Sort by revenue descending
        teamData.sort((a, b) => b.orders.totalRevenue - a.orders.totalRevenue);

        res.status(200).json({ success: true, data: teamData });
    } catch (error) {
        console.error("Error in getTeamPerformance:", error);
        res.status(500).json({ success: false, message: "Error fetching team performance", error: error.message });
    }
};

/**
 * GET /api/dashboard/invoices
 * Invoices list with pagination for the period (for side-drawer "view all")
 */
exports.getInvoices = async (req, res) => {
    try {
        const { fromDate, toDate } = getDateRange(req.query);
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        let query = { DocDate: { $gte: fromDate, $lte: toDate } };

        if (req.query.cardCode) {
            query.CardCode = { $regex: req.query.cardCode, $options: "i" };
        }
        if (req.query.paymentStatus) {
            query.paymentStatus = req.query.paymentStatus;
        }
        if (req.query.tag) {
            query.tag = req.query.tag;
        }
        if (req.query.search) {
            const s = { $regex: req.query.search, $options: "i" };
            query.$or = [{ CardCode: s }, { CardName: s }, { DocNum: !isNaN(req.query.search) ? parseInt(req.query.search) : -1 }];
        }

        const [invoices, total] = await Promise.all([
            Invoice.find(query)
                .select("DocNum DocDate CardCode CardName DocTotal VatSum DocCurrency paymentStatus tag isPOS isDelivery PaidToDate DocumentLines")
                .sort({ DocDate: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Invoice.countDocuments(query),
        ]);

        res.status(200).json({
            success: true,
            count: invoices.length,
            total,
            page,
            pages: Math.ceil(total / limit),
            data: invoices,
        });
    } catch (error) {
        console.error("Error in getInvoices:", error);
        res.status(500).json({ success: false, message: "Error fetching invoices", error: error.message });
    }
};

/**
 * GET /api/dashboard/invoice/:docEntry
 * Full invoice detail for side-drawer
 */
exports.getInvoiceDetail = async (req, res) => {
    try {
        const invoice = await Invoice.findOne({ DocEntry: req.params.docEntry }).lean();
        if (!invoice) {
            return res.status(404).json({ success: false, message: "Invoice not found" });
        }
        res.status(200).json({ success: true, data: invoice });
    } catch (error) {
        console.error("Error in getInvoiceDetail:", error);
        res.status(500).json({ success: false, message: "Error fetching invoice detail", error: error.message });
    }
};

/**
 * GET /api/dashboard/orders
 * Orders list with pagination for the period
 */
exports.getOrders = async (req, res) => {
    try {
        const { fromDate, toDate } = getDateRange(req.query);
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        let query = { DocDate: { $gte: fromDate, $lte: toDate } };

        if (req.query.status) query.DocumentStatus = req.query.status;
        if (req.query.cardCode) query.CardCode = { $regex: req.query.cardCode, $options: "i" };
        if (req.query.salesAgent) query.salesAgent = req.query.salesAgent;
        if (req.query.syncStatus === "synced") query.SyncedWithSAP = true;
        if (req.query.syncStatus === "unsynced") query.SyncedWithSAP = false;
        if (req.query.search) {
            const s = { $regex: req.query.search, $options: "i" };
            query.$or = [{ CardCode: s }, { CardName: s }];
            if (!isNaN(req.query.search)) {
                query.$or.push({ DocNum: parseInt(req.query.search) });
            }
        }

        const [orders, total] = await Promise.all([
            SalesOrder.find(query)
                .populate("salesAgent", "firstName lastName")
                .select("DocNum DocDate CardCode CardName DocTotal DocCurrency DocumentStatus SyncedWithSAP LocalStatus StartDeliveryDate salesAgent")
                .sort({ DocDate: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            SalesOrder.countDocuments(query),
        ]);

        res.status(200).json({
            success: true,
            count: orders.length,
            total,
            page,
            pages: Math.ceil(total / limit),
            data: orders,
        });
    } catch (error) {
        console.error("Error in getOrders:", error);
        res.status(500).json({ success: false, message: "Error fetching orders", error: error.message });
    }
};

/**
 * GET /api/dashboard/quotations
 * Quotations list with pagination
 */
exports.getQuotations = async (req, res) => {
    try {
        const { fromDate, toDate } = getDateRange(req.query);
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        let query = { DocDate: { $gte: fromDate, $lte: toDate } };

        if (req.query.approvalStatus) query.approvalStatus = req.query.approvalStatus;
        if (req.query.cardCode) query.CardCode = { $regex: req.query.cardCode, $options: "i" };
        if (req.query.salesAgent) query.salesAgent = req.query.salesAgent;
        if (req.query.search) {
            const s = { $regex: req.query.search, $options: "i" };
            query.$or = [{ CardCode: s }, { CardName: s }];
        }

        const [quotations, total] = await Promise.all([
            Quotation.find(query)
                .populate("salesAgent", "firstName lastName")
                .select("DocNum DocDate CardCode CardName DocTotal DocCurrency approvalStatus DocumentStatus ConvertedToOrderDocEntry salesAgent")
                .sort({ DocDate: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Quotation.countDocuments(query),
        ]);

        res.status(200).json({
            success: true,
            count: quotations.length,
            total,
            page,
            pages: Math.ceil(total / limit),
            data: quotations,
        });
    } catch (error) {
        console.error("Error in getQuotations:", error);
        res.status(500).json({ success: false, message: "Error fetching quotations", error: error.message });
    }
};

/**
 * GET /api/dashboard/item-analytics
 * Item catalog stats: total items, average prices, category breakdown
 */
exports.getItemAnalytics = async (req, res) => {
    try {
        const [
            totalItems,
            activeItems,
            frozenItems,
            priceStats,
            categoryBreakdown,
            stockSummary,
        ] = await Promise.all([
            Item.countDocuments(),
            Item.countDocuments({ Valid: "tYES", Frozen: "tNO" }),
            Item.countDocuments({ Frozen: "tYES" }),
            Item.aggregate([
                { $match: { Valid: "tYES" } },
                { $unwind: "$ItemPrices" },
                { $match: { "ItemPrices.Price": { $gt: 0 } } },
                {
                    $group: {
                        _id: "$ItemPrices.PriceList",
                        avgPrice: { $avg: "$ItemPrices.Price" },
                        minPrice: { $min: "$ItemPrices.Price" },
                        maxPrice: { $max: "$ItemPrices.Price" },
                        itemCount: { $sum: 1 },
                    },
                },
                { $sort: { _id: 1 } },
            ]),
            Item.aggregate([
                { $match: { Valid: "tYES" } },
                {
                    $group: {
                        _id: "$ItemsGroupCode",
                        count: { $sum: 1 },
                        totalStock: { $sum: "$QuantityOnStock" },
                    },
                },
                { $sort: { count: -1 } },
                { $limit: 20 },
            ]),
            Item.aggregate([
                { $match: { Valid: "tYES" } },
                {
                    $group: {
                        _id: null,
                        totalStock: { $sum: "$QuantityOnStock" },
                        totalOrdered: { $sum: "$QuantityOrderedByCustomers" },
                        totalFromVendors: { $sum: "$QuantityOrderedFromVendors" },
                        lowStockItems: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $gt: ["$MinInventory", 0] },
                                            { $lt: ["$QuantityOnStock", "$MinInventory"] },
                                        ],
                                    },
                                    1,
                                    0,
                                ],
                            },
                        },
                        outOfStockItems: {
                            $sum: {
                                $cond: [{ $lte: ["$QuantityOnStock", 0] }, 1, 0],
                            },
                        },
                    },
                },
            ]),
        ]);

        res.status(200).json({
            success: true,
            data: {
                totalItems,
                activeItems,
                frozenItems,
                priceListStats: priceStats.map((p) => ({
                    priceList: p._id,
                    avgPrice: parseFloat(p.avgPrice.toFixed(2)),
                    minPrice: parseFloat(p.minPrice.toFixed(2)),
                    maxPrice: parseFloat(p.maxPrice.toFixed(2)),
                    itemCount: p.itemCount,
                })),
                categoryBreakdown,
                stock: stockSummary[0] || {
                    totalStock: 0,
                    totalOrdered: 0,
                    totalFromVendors: 0,
                    lowStockItems: 0,
                    outOfStockItems: 0,
                },
            },
        });
    } catch (error) {
        console.error("Error in getItemAnalytics:", error);
        res.status(500).json({ success: false, message: "Error fetching item analytics", error: error.message });
    }
};

/**
 * GET /api/dashboard/revenue-breakdown
 * Revenue by payment method, POS vs delivery, customer segments
 */
exports.getRevenueBreakdown = async (req, res) => {
    try {
        const { fromDate, toDate } = getDateRange(req.query);

        const [byPaymentMethod, byTag, byCustomerSegment] = await Promise.all([
            Invoice.aggregate([
                { $match: { DocDate: { $gte: fromDate, $lte: toDate } } },
                {
                    $group: {
                        _id: "$paymentMethod",
                        count: { $sum: 1 },
                        totalValue: { $sum: "$DocTotal" },
                    },
                },
                { $sort: { totalValue: -1 } },
            ]),
            Invoice.aggregate([
                { $match: { DocDate: { $gte: fromDate, $lte: toDate } } },
                {
                    $group: {
                        _id: "$tag",
                        count: { $sum: 1 },
                        totalValue: { $sum: "$DocTotal" },
                    },
                },
                { $sort: { totalValue: -1 } },
            ]),
            // Top 10 customer segments by first 2 chars of CardCode
            SalesOrder.aggregate([
                { $match: { DocDate: { $gte: fromDate, $lte: toDate } } },
                {
                    $group: {
                        _id: "$CardCode",
                        cardName: { $first: "$CardName" },
                        totalValue: { $sum: "$DocTotal" },
                        orderCount: { $sum: 1 },
                    },
                },
                { $sort: { totalValue: -1 } },
                { $limit: 10 },
            ]),
        ]);

        res.status(200).json({
            success: true,
            data: {
                byPaymentMethod: byPaymentMethod.map((p) => ({
                    method: p._id || "Unknown",
                    count: p.count,
                    totalValue: parseFloat((p.totalValue || 0).toFixed(2)),
                })),
                byTag: byTag.map((t) => ({
                    tag: t._id || "None",
                    count: t.count,
                    totalValue: parseFloat((t.totalValue || 0).toFixed(2)),
                })),
                topCustomersByRevenue: byCustomerSegment.map((c) => ({
                    cardCode: c._id,
                    cardName: c.cardName,
                    totalValue: parseFloat((c.totalValue || 0).toFixed(2)),
                    orderCount: c.orderCount,
                })),
            },
        });
    } catch (error) {
        console.error("Error in getRevenueBreakdown:", error);
        res.status(500).json({ success: false, message: "Error fetching revenue breakdown", error: error.message });
    }
};

/**
 * GET /api/dashboard/team-logins
 * Recent login activity for all team members
 */
exports.getTeamLogins = async (req, res) => {
    try {
        const users = await User.find({ deactivated: false })
            .select("firstName lastName email role lastLogin createdAt")
            .sort({ lastLogin: -1 })
            .lean();

        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const result = users.map((u) => ({
            ...u,
            isOnlineToday: u.lastLogin && u.lastLogin >= oneDayAgo,
            isActiveThisWeek: u.lastLogin && u.lastLogin >= oneWeekAgo,
        }));

        const summary = {
            totalUsers: users.length,
            onlineToday: result.filter((u) => u.isOnlineToday).length,
            activeThisWeek: result.filter((u) => u.isActiveThisWeek).length,
            inactive: result.filter((u) => !u.isActiveThisWeek).length,
        };

        res.status(200).json({ success: true, data: { summary, users: result } });
    } catch (error) {
        console.error("Error in getTeamLogins:", error);
        res.status(500).json({ success: false, message: "Error fetching team logins", error: error.message });
    }
};

/**
 * GET /api/dashboard/sync-status
 * SAP sync health overview
 */
exports.getSyncStatus = async (req, res) => {
    try {
        const [orderSync, quotationSync] = await Promise.all([
            SalesOrder.aggregate([
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        synced: { $sum: { $cond: [{ $eq: ["$SyncedWithSAP", true] }, 1, 0] } },
                        unsynced: { $sum: { $cond: [{ $eq: ["$SyncedWithSAP", false] }, 1, 0] } },
                        failed: { $sum: { $cond: [{ $eq: ["$LocalStatus", "SyncFailed"] }, 1, 0] } },
                        disabled: { $sum: { $cond: [{ $eq: ["$SAPSyncDisabled", true] }, 1, 0] } },
                    },
                },
            ]),
            Quotation.aggregate([
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        synced: { $sum: { $cond: [{ $eq: ["$SyncedWithSAP", true] }, 1, 0] } },
                        unsynced: { $sum: { $cond: [{ $eq: ["$SyncedWithSAP", false] }, 1, 0] } },
                        failed: { $sum: { $cond: [{ $eq: ["$LocalStatus", "SyncFailed"] }, 1, 0] } },
                    },
                },
            ]),
        ]);

        res.status(200).json({
            success: true,
            data: {
                orders: orderSync[0] || { total: 0, synced: 0, unsynced: 0, failed: 0, disabled: 0 },
                quotations: quotationSync[0] || { total: 0, synced: 0, unsynced: 0, failed: 0 },
            },
        });
    } catch (error) {
        console.error("Error in getSyncStatus:", error);
        res.status(500).json({ success: false, message: "Error fetching sync status", error: error.message });
    }
};

/**
 * GET /api/dashboard/hourly-distribution
 * Hourly distribution of orders/invoices for the period
 */
exports.getHourlyDistribution = async (req, res) => {
    try {
        const { fromDate, toDate } = getDateRange(req.query);

        const [orderHours, invoiceHours] = await Promise.all([
            SalesOrder.aggregate([
                { $match: { DocDate: { $gte: fromDate, $lte: toDate } } },
                {
                    $group: {
                        _id: { $hour: "$createdAt" },
                        count: { $sum: 1 },
                        value: { $sum: "$DocTotal" },
                    },
                },
                { $sort: { _id: 1 } },
            ]),
            Invoice.aggregate([
                { $match: { DocDate: { $gte: fromDate, $lte: toDate } } },
                {
                    $group: {
                        _id: { $hour: "$createdAt" },
                        count: { $sum: 1 },
                        value: { $sum: "$DocTotal" },
                    },
                },
                { $sort: { _id: 1 } },
            ]),
        ]);

        // Build 24-hour dataset
        const hours = Array.from({ length: 24 }, (_, i) => ({
            hour: i,
            label: `${i.toString().padStart(2, "0")}:00`,
            orders: 0,
            orderValue: 0,
            invoices: 0,
            invoiceValue: 0,
        }));

        orderHours.forEach((h) => {
            if (hours[h._id]) {
                hours[h._id].orders = h.count;
                hours[h._id].orderValue = h.value;
            }
        });
        invoiceHours.forEach((h) => {
            if (hours[h._id]) {
                hours[h._id].invoices = h.count;
                hours[h._id].invoiceValue = h.value;
            }
        });

        res.status(200).json({ success: true, data: hours });
    } catch (error) {
        console.error("Error in getHourlyDistribution:", error);
        res.status(500).json({ success: false, message: "Error fetching hourly distribution", error: error.message });
    }
};