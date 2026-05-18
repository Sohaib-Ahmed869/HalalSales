// controllers/dashboardController.js
const SalesOrder = require("../models/SalesOrder");
const Quotation = require("../models/Quotation");
const Invoice = require("../models/Invoice");
const Item = require("../models/item");
const User = require("../models/User");
const Customer = require("../models/Customer");
const Lead = require("../models/Lead");
const mongoose = require("mongoose");

// Helper: Get date range from query params (defaults to this week)
// IMPORTANT: parses YYYY-MM-DD strings explicitly as UTC to avoid timezone
// drift that causes "April 1" to include March 31 records.
function getDateRange(query) {
    const now = new Date();
    let fromDate, toDate;

    if (query.fromDate && query.toDate) {
        // If frontend sends YYYY-MM-DD, anchor it to UTC midnight so the
        // backend's day boundaries match what the user picked locally.
        const fromStr = String(query.fromDate).slice(0, 10);
        const toStr = String(query.toDate).slice(0, 10);
        fromDate = new Date(fromStr + "T00:00:00.000Z");
        toDate = new Date(toStr + "T23:59:59.999Z");
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

// Helper: optional sales-agent filter from query string.
// Returns an object you can spread into a Mongo match, e.g. { salesAgent: ObjectId(...) },
// or {} if no agent / invalid id was supplied.
function getAgentFilter(query) {
    const id = query?.salesAgent;
    if (!id) return {};
    if (!mongoose.Types.ObjectId.isValid(id)) return {};
    return { salesAgent: new mongoose.Types.ObjectId(id) };
}

/**
 * GET /api/dashboard/summary
 * Top-level KPI cards with period comparison
 */
exports.getSummary = async (req, res) => {
    try {
        const { fromDate, toDate } = getDateRange(req.query);
        const { prevFrom, prevTo } = getPreviousPeriod(fromDate, toDate);
        const agentFilter = getAgentFilter(req.query);

        const dateFilter = { $gte: fromDate, $lte: toDate };
        const prevDateFilter = { $gte: prevFrom, $lte: prevTo };
        const baseMatch = { DocDate: dateFilter, ...agentFilter };
        const basePrevMatch = { DocDate: prevDateFilter, ...agentFilter };

        // Current period aggregations (run in parallel)
        // NET = DocTotal - VatSum (turnover without VAT).
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
            // Orders - current (net values)
            SalesOrder.aggregate([
                { $match: baseMatch },
                {
                    $addFields: {
                        netTotal: { $subtract: [{ $ifNull: ["$DocTotal", 0] }, { $ifNull: ["$VatSum", 0] }] },
                    },
                },
                {
                    $group: {
                        _id: null,
                        count: { $sum: 1 },
                        totalValue: { $sum: "$netTotal" },
                        avgOrderValue: { $avg: "$netTotal" },
                        totalVat: { $sum: { $ifNull: ["$VatSum", 0] } },
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
            // Orders - previous (net values)
            SalesOrder.aggregate([
                { $match: basePrevMatch },
                {
                    $group: {
                        _id: null,
                        count: { $sum: 1 },
                        totalValue: { $sum: { $subtract: [{ $ifNull: ["$DocTotal", 0] }, { $ifNull: ["$VatSum", 0] }] } },
                    },
                },
            ]),
            // Invoices - current (net values)
            Invoice.aggregate([
                { $match: baseMatch },
                {
                    $addFields: {
                        netTotal: { $subtract: [{ $ifNull: ["$DocTotal", 0] }, { $ifNull: ["$VatSum", 0] }] },
                    },
                },
                {
                    $group: {
                        _id: null,
                        count: { $sum: 1 },
                        totalValue: { $sum: "$netTotal" },
                        avgInvoiceValue: { $avg: "$netTotal" },
                        totalVat: { $sum: { $ifNull: ["$VatSum", 0] } },
                        totalPaid: { $sum: { $ifNull: ["$PaidToDate", 0] } },
                        posCount: {
                            $sum: { $cond: [{ $eq: ["$isPOS", true] }, 1, 0] },
                        },
                        deliveryCount: {
                            $sum: { $cond: [{ $eq: ["$isDelivery", true] }, 1, 0] },
                        },
                    },
                },
            ]),
            // Invoices - previous (net values)
            Invoice.aggregate([
                { $match: basePrevMatch },
                {
                    $group: {
                        _id: null,
                        count: { $sum: 1 },
                        totalValue: { $sum: { $subtract: [{ $ifNull: ["$DocTotal", 0] }, { $ifNull: ["$VatSum", 0] }] } },
                    },
                },
            ]),
            // Quotations - current (net values)
            Quotation.aggregate([
                { $match: baseMatch },
                {
                    $addFields: {
                        netTotal: { $subtract: [{ $ifNull: ["$DocTotal", 0] }, { $ifNull: ["$VatSum", 0] }] },
                    },
                },
                {
                    $group: {
                        _id: null,
                        count: { $sum: 1 },
                        totalValue: { $sum: "$netTotal" },
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
            // Quotations - previous (net values)
            Quotation.aggregate([
                { $match: basePrevMatch },
                {
                    $group: {
                        _id: null,
                        count: { $sum: 1 },
                        totalValue: { $sum: { $subtract: [{ $ifNull: ["$DocTotal", 0] }, { $ifNull: ["$VatSum", 0] }] } },
                    },
                },
            ]),
            // Active customers = unique CardCodes that were *invoiced* this period
            // (per business: invoice-based, not order-based). Honors agent filter.
            Invoice.distinct("CardCode", baseMatch),
            Invoice.distinct("CardCode", basePrevMatch),
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

        const agentFilter = getAgentFilter(req.query);
        const match = { DocDate: { $gte: fromDate, $lte: toDate }, ...agentFilter };

        const [ordersByDay, invoicesByDay] = await Promise.all([
            SalesOrder.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: { $dateToString: { format: "%Y-%m-%d", date: "$DocDate", timezone: "UTC" } },
                        orderCount: { $sum: 1 },
                        orderValue: { $sum: { $subtract: [{ $ifNull: ["$DocTotal", 0] }, { $ifNull: ["$VatSum", 0] }] } },
                    },
                },
                { $sort: { _id: 1 } },
            ]),
            Invoice.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: { $dateToString: { format: "%Y-%m-%d", date: "$DocDate", timezone: "UTC" } },
                        invoiceCount: { $sum: 1 },
                        invoiceValue: { $sum: { $subtract: [{ $ifNull: ["$DocTotal", 0] }, { $ifNull: ["$VatSum", 0] }] } },
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
 * Top customers by NET invoice revenue (without VAT) in the period.
 * Source: finalised invoices, NOT orders (per business rule).
 */
exports.getTopCustomers = async (req, res) => {
    try {
        const { fromDate, toDate } = getDateRange(req.query);
        const limit = parseInt(req.query.limit) || 10;
        const agentFilter = getAgentFilter(req.query);

        const topCustomers = await Invoice.aggregate([
            { $match: { DocDate: { $gte: fromDate, $lte: toDate }, ...agentFilter } },
            {
                $addFields: {
                    netTotal: { $subtract: [{ $ifNull: ["$DocTotal", 0] }, { $ifNull: ["$VatSum", 0] }] },
                },
            },
            {
                $group: {
                    _id: "$CardCode",
                    cardName: { $first: "$CardName" },
                    invoiceCount: { $sum: 1 },
                    totalRevenue: { $sum: "$netTotal" },
                    avgOrderValue: { $avg: "$netTotal" },
                    lastInvoiceDate: { $max: "$DocDate" },
                },
            },
            { $sort: { totalRevenue: -1 } },
            { $limit: limit },
            {
                $project: {
                    _id: 0,
                    cardCode: "$_id",
                    cardName: 1,
                    // Keep `orderCount` alias for frontend backwards-compat — it now
                    // represents invoice count (per business rule)
                    orderCount: "$invoiceCount",
                    invoiceCount: 1,
                    totalRevenue: { $round: ["$totalRevenue", 2] },
                    avgOrderValue: { $round: ["$avgOrderValue", 2] },
                    lastOrderDate: "$lastInvoiceDate",
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
 * Top selling items by quantity and NET revenue (without VAT).
 * Defaults to invoices (finalised) per business rule.
 * `?source=orders` still supported for backwards compatibility.
 */
exports.getTopItems = async (req, res) => {
    try {
        const { fromDate, toDate } = getDateRange(req.query);
        const limit = parseInt(req.query.limit) || 15;
        const source = req.query.source || "invoices"; // default to finalised invoices
        const agentFilter = getAgentFilter(req.query);

        const Model = source === "orders" ? SalesOrder : Invoice;

        // LineTotal in SAP B1 is already NET (before tax) for a row, so we use it directly.
        // For safety against schemas that lack LineTotal, fall back to Quantity*Price.
        const topItems = await Model.aggregate([
            { $match: { DocDate: { $gte: fromDate, $lte: toDate }, ...agentFilter } },
            { $unwind: "$DocumentLines" },
            {
                $addFields: {
                    "DocumentLines.netLineTotal": {
                        $ifNull: [
                            "$DocumentLines.LineTotal",
                            { $multiply: [{ $ifNull: ["$DocumentLines.Quantity", 0] }, { $ifNull: ["$DocumentLines.Price", 0] }] },
                        ],
                    },
                },
            },
            {
                $group: {
                    _id: "$DocumentLines.ItemCode",
                    itemDescription: { $first: "$DocumentLines.ItemDescription" },
                    totalQuantity: { $sum: "$DocumentLines.Quantity" },
                    totalRevenue: { $sum: "$DocumentLines.netLineTotal" },
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
 * Per-agent performance based on finalised invoices (not orders), without VAT.
 * Includes: revenue, # invoices finalised, # open unconverted quotations,
 * # customers from invoices, avg order value, total quotations, conversion rate,
 * and target achievement for the chosen period.
 *
 * Only active agents (deactivated: false) and only role: sales_agent — sales
 * managers are intentionally excluded from the agent performance grid.
 */
exports.getTeamPerformance = async (req, res) => {
    try {
        const { fromDate, toDate } = getDateRange(req.query);

        const agents = await User.find({
            role: "sales_agent",
            deactivated: false,
        })
            .select("firstName lastName email role target targetHistory lastLogin manager")
            .lean();

        const agentIds = agents.map((a) => a._id);

        // Invoice-based revenue per agent (NET = DocTotal - VatSum)
        const agentInvoices = await Invoice.aggregate([
            {
                $match: {
                    DocDate: { $gte: fromDate, $lte: toDate },
                    salesAgent: { $in: agentIds },
                },
            },
            {
                $addFields: {
                    netTotal: { $subtract: [{ $ifNull: ["$DocTotal", 0] }, { $ifNull: ["$VatSum", 0] }] },
                },
            },
            {
                $group: {
                    _id: "$salesAgent",
                    invoiceCount: { $sum: 1 },
                    totalRevenue: { $sum: "$netTotal" },
                    avgOrderValue: { $avg: "$netTotal" },
                    uniqueCustomers: { $addToSet: "$CardCode" },
                },
            },
        ]);

        // Quotations per agent — count total, converted, and open (not converted yet)
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
                    quotationValue: { $sum: { $subtract: [{ $ifNull: ["$DocTotal", 0] }, { $ifNull: ["$VatSum", 0] }] } },
                    convertedCount: {
                        $sum: {
                            $cond: [{ $ne: ["$ConvertedToOrderDocEntry", null] }, 1, 0],
                        },
                    },
                    openUnconvertedCount: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $eq: ["$ConvertedToOrderDocEntry", null] },
                                        { $not: { $in: ["$approvalStatus", ["rejected"]] } },
                                    ],
                                },
                                1,
                                0,
                            ],
                        },
                    },
                },
            },
        ]);

        // Build lookup maps
        const invoiceMap = {};
        agentInvoices.forEach((a) => { invoiceMap[a._id.toString()] = a; });
        const quotationMap = {};
        agentQuotations.forEach((a) => { quotationMap[a._id.toString()] = a; });

        // Get current month/year target from targetHistory if available
        const periodMonth = String(fromDate.getUTCMonth() + 1).padStart(2, "0");
        const periodYear = fromDate.getUTCFullYear();

        const teamData = agents.map((agent) => {
            const id = agent._id.toString();
            const inv = invoiceMap[id] || { invoiceCount: 0, totalRevenue: 0, avgOrderValue: 0, uniqueCustomers: [] };
            const quotes = quotationMap[id] || { quotationCount: 0, quotationValue: 0, convertedCount: 0, openUnconvertedCount: 0 };

            // Resolve a period-aware target: prefer targetHistory entry for
            // (year, month) of the range, else fall back to user.target.
            let periodTarget = 0;
            if (Array.isArray(agent.targetHistory) && agent.targetHistory.length > 0) {
                const match = agent.targetHistory.find(
                    (t) => String(t.month) === periodMonth && Number(t.year) === periodYear
                );
                if (match) periodTarget = Number(match.target) || 0;
            }
            if (!periodTarget) periodTarget = Number(agent.target) || 0;

            // FIX: conversion rate must be 0 when there are no quotations (was
            // showing 100% incorrectly due to falsy guards elsewhere).
            const conversionRate = quotes.quotationCount > 0
                ? parseFloat(((quotes.convertedCount / quotes.quotationCount) * 100).toFixed(1))
                : 0;

            return {
                agentId: agent._id,
                name: `${agent.firstName} ${agent.lastName}`,
                email: agent.email,
                role: agent.role,
                lastLogin: agent.lastLogin,
                target: periodTarget,
                // keep `orders` key for frontend backwards-compat — values are now
                // invoice-based per business rule
                orders: {
                    count: inv.invoiceCount,
                    totalRevenue: parseFloat((inv.totalRevenue || 0).toFixed(2)),
                    avgOrderValue: parseFloat((inv.avgOrderValue || 0).toFixed(2)),
                    uniqueCustomers: (inv.uniqueCustomers || []).length,
                },
                invoices: {
                    count: inv.invoiceCount,
                    totalRevenue: parseFloat((inv.totalRevenue || 0).toFixed(2)),
                    avgInvoiceValue: parseFloat((inv.avgOrderValue || 0).toFixed(2)),
                    uniqueCustomers: (inv.uniqueCustomers || []).length,
                },
                quotations: {
                    count: quotes.quotationCount,
                    totalValue: parseFloat((quotes.quotationValue || 0).toFixed(2)),
                    converted: quotes.convertedCount,
                    openUnconverted: quotes.openUnconvertedCount,
                    conversionRate,
                },
                targetAchievement: periodTarget > 0
                    ? parseFloat((((inv.totalRevenue || 0) / periodTarget) * 100).toFixed(1))
                    : null,
            };
        });

        // Sort by revenue descending
        teamData.sort((a, b) => b.invoices.totalRevenue - a.invoices.totalRevenue);

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
        let { fromDate, toDate } = getDateRange(req.query);
        // Optional: drill-down to a single day inside the period
        if (req.query.date) {
            const d = String(req.query.date).slice(0, 10);
            fromDate = new Date(d + "T00:00:00.000Z");
            toDate = new Date(d + "T23:59:59.999Z");
        }
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
        let { fromDate, toDate } = getDateRange(req.query);
        if (req.query.date) {
            const d = String(req.query.date).slice(0, 10);
            fromDate = new Date(d + "T00:00:00.000Z");
            toDate = new Date(d + "T23:59:59.999Z");
        }
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
                .select("DocNum DocDate CardCode CardName DocTotal VatSum DocCurrency DocumentStatus SyncedWithSAP LocalStatus StartDeliveryDate salesAgent")
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
        let { fromDate, toDate } = getDateRange(req.query);
        if (req.query.date) {
            const d = String(req.query.date).slice(0, 10);
            fromDate = new Date(d + "T00:00:00.000Z");
            toDate = new Date(d + "T23:59:59.999Z");
        }
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
                .select("DocNum DocDate CardCode CardName DocTotal VatSum DocCurrency approvalStatus DocumentStatus ConvertedToOrderDocEntry salesAgent")
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
 * GET /api/main-admin-dashboard/active-agents
 * Active sales agents only — used by the dashboard's agent filter dropdown.
 */
exports.getActiveAgents = async (req, res) => {
    try {
        const agents = await User.find({
            role: "sales_agent",
            deactivated: false,
        })
            .select("firstName lastName email")
            .sort({ firstName: 1, lastName: 1 })
            .lean();

        res.status(200).json({
            success: true,
            data: agents.map((a) => ({
                _id: a._id,
                name: `${a.firstName || ""} ${a.lastName || ""}`.trim() || a.email,
                email: a.email,
            })),
        });
    } catch (error) {
        console.error("Error in getActiveAgents:", error);
        res.status(500).json({ success: false, message: "Error fetching active agents", error: error.message });
    }
};

/**
 * GET /api/dashboard/team-logins
 * Recent login activity for all team members
 */
exports.getTeamLogins = async (req, res) => {
    try {
        // Active sales agents only (and managers) — admin/logistics excluded
        const users = await User.find({
            deactivated: false,
            role: { $in: ["sales_agent", "sales_manager"] },
        })
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

/**
 * GET /api/main-admin-dashboard/customer-analytics
 * Customer + new-account analytics for sales manager / admin dashboard.
 * Returns:
 *   - totalCustomers         — entire customer base in the system
 *   - newAccountsInPeriod    — accounts created within [fromDate, toDate]
 *   - newAccountsOrdered     — of those new accounts, how many have an invoice
 *                              in the period (i.e. they actually placed an order)
 *   - invoicedCustomers      — distinct customers invoiced in the period
 *   - quotedCustomers        — distinct customers that received a quotation
 *   - contactedCustomers     — distinct customers with any quotation OR invoice
 *                              OR order (treated as "contacted" via business activity)
 *   - notContactedCount      — total - contactedCustomers (customers with no
 *                              business activity in the period)
 *   - notContactedCustomers  — sample list (max 50) for drill-down
 */
exports.getCustomerAnalytics = async (req, res) => {
    try {
        const { fromDate, toDate } = getDateRange(req.query);
        const dateFilter = { $gte: fromDate, $lte: toDate };
        const agentFilter = getAgentFilter(req.query);
        // When filtering to a single agent:
        //   - totalCustomers becomes "customers in this agent's portfolio"
        //     (Customer.assignedTo = agent)
        //   - newAccounts is scoped to customers assigned to that agent
        //   - invoiced/quoted/ordered card codes are scoped to that agent's docs
        //   - notContacted is the agent's portfolio minus their contacted set
        const customerScopedFilter = agentFilter.salesAgent
            ? { assignedTo: agentFilter.salesAgent }
            : {};

        const [
            totalCustomers,
            newAccountsList,
            invoicedCardCodes,
            quotedCardCodes,
            orderedCardCodes,
        ] = await Promise.all([
            Customer.countDocuments(customerScopedFilter),
            Customer.find({ createdAt: dateFilter, ...customerScopedFilter })
                .select("CardCode CardName createdAt assignedTo phoneNumber Email customerType status")
                .populate("assignedTo", "firstName lastName")
                .lean(),
            Invoice.distinct("CardCode", { DocDate: dateFilter, ...agentFilter }),
            Quotation.distinct("CardCode", { DocDate: dateFilter, ...agentFilter }),
            SalesOrder.distinct("CardCode", { DocDate: dateFilter, ...agentFilter }),
        ]);

        const invoicedSet = new Set(invoicedCardCodes.filter(Boolean));
        const quotedSet = new Set(quotedCardCodes.filter(Boolean));
        const orderedSet = new Set(orderedCardCodes.filter(Boolean));
        // Contacted = any business activity (invoice / quotation / order) in the period
        const contactedSet = new Set([...invoicedSet, ...quotedSet, ...orderedSet]);

        const newAccounts = newAccountsList.map((c) => ({
            CardCode: c.CardCode,
            CardName: c.CardName,
            createdAt: c.createdAt,
            assignedAgent: c.assignedTo
                ? `${c.assignedTo.firstName || ""} ${c.assignedTo.lastName || ""}`.trim()
                : null,
            phoneNumber: c.phoneNumber,
            Email: c.Email,
            customerType: c.customerType,
            status: c.status,
            hasOrdered: invoicedSet.has(c.CardCode),
        }));

        const newAccountsOrdered = newAccounts.filter((c) => c.hasOrdered).length;

        // Sample of customers with no activity in the period (limited to 50).
        // When an agent is selected, scope to their portfolio.
        const notContactedSample = await Customer.find({
            CardCode: { $exists: true, $ne: null, $nin: [...contactedSet] },
            ...customerScopedFilter,
        })
            .select("CardCode CardName lastActivityDate assignedTo")
            .populate("assignedTo", "firstName lastName")
            .limit(50)
            .lean();

        res.status(200).json({
            success: true,
            data: {
                period: { fromDate, toDate },
                totalCustomers,
                newAccountsInPeriod: newAccounts.length,
                newAccountsOrdered,
                newAccountsConversionRate: newAccounts.length > 0
                    ? parseFloat(((newAccountsOrdered / newAccounts.length) * 100).toFixed(1))
                    : 0,
                invoicedCustomers: invoicedSet.size,
                quotedCustomers: quotedSet.size,
                orderedCustomers: orderedSet.size,
                contactedCustomers: contactedSet.size,
                notContactedCount: Math.max(0, totalCustomers - contactedSet.size),
                newAccounts,
                notContactedSample: notContactedSample.map((c) => ({
                    CardCode: c.CardCode,
                    CardName: c.CardName,
                    lastActivityDate: c.lastActivityDate,
                    assignedAgent: c.assignedTo
                        ? `${c.assignedTo.firstName || ""} ${c.assignedTo.lastName || ""}`.trim()
                        : null,
                })),
            },
        });
    } catch (error) {
        console.error("Error in getCustomerAnalytics:", error);
        res.status(500).json({ success: false, message: "Error fetching customer analytics", error: error.message });
    }
};

/**
 * GET /api/main-admin-dashboard/leads-analytics
 * Leads funnel for the dashboard: received, by status, conversion, time-to-contact.
 * Used by both the admin dashboard and the leads-screen header.
 */
exports.getLeadsAnalytics = async (req, res) => {
    try {
        const { fromDate, toDate } = getDateRange(req.query);
        const dateFilter = { $gte: fromDate, $lte: toDate };

        const filter = { createdAt: dateFilter };
        // Accept both `assignedTo` (the underlying Lead field) and `salesAgent`
        // (the dashboard's global filter key) — they mean the same person here.
        const agentRaw = req.query.assignedTo || req.query.salesAgent;
        if (agentRaw && mongoose.Types.ObjectId.isValid(agentRaw)) {
            filter.assignedTo = new mongoose.Types.ObjectId(agentRaw);
        }
        if (req.query.status) {
            filter.status = req.query.status;
        }

        const [
            statusBreakdown,
            byAgent,
            recentLeads,
        ] = await Promise.all([
            Lead.aggregate([
                { $match: filter },
                {
                    $group: {
                        _id: "$status",
                        count: { $sum: 1 },
                    },
                },
            ]),
            Lead.aggregate([
                { $match: filter },
                {
                    $group: {
                        _id: "$assignedTo",
                        total: { $sum: 1 },
                        converted: {
                            $sum: { $cond: [{ $eq: ["$status", "converted"] }, 1, 0] },
                        },
                        new: {
                            $sum: { $cond: [{ $eq: ["$status", "new"] }, 1, 0] },
                        },
                        qualified: {
                            $sum: { $cond: [{ $eq: ["$status", "qualified"] }, 1, 0] },
                        },
                        dead: {
                            $sum: { $cond: [{ $eq: ["$status", "dead"] }, 1, 0] },
                        },
                        avgAgeDays: {
                            $avg: {
                                $divide: [
                                    { $subtract: ["$updatedAt", "$createdAt"] },
                                    1000 * 60 * 60 * 24,
                                ],
                            },
                        },
                    },
                },
                {
                    $lookup: {
                        from: "users",
                        localField: "_id",
                        foreignField: "_id",
                        as: "agent",
                    },
                },
                { $unwind: { path: "$agent", preserveNullAndEmptyArrays: true } },
                {
                    $project: {
                        agentId: "$_id",
                        agentName: {
                            $cond: [
                                { $ifNull: ["$agent", false] },
                                { $concat: [{ $ifNull: ["$agent.firstName", ""] }, " ", { $ifNull: ["$agent.lastName", ""] }] },
                                "Unassigned",
                            ],
                        },
                        total: 1,
                        converted: 1,
                        new: 1,
                        qualified: 1,
                        dead: 1,
                        avgAgeDays: { $round: ["$avgAgeDays", 1] },
                        conversionRate: {
                            $cond: [
                                { $gt: ["$total", 0] },
                                { $round: [{ $multiply: [{ $divide: ["$converted", "$total"] }, 100] }, 1] },
                                0,
                            ],
                        },
                    },
                },
                { $sort: { total: -1 } },
            ]),
            Lead.find(filter)
                .populate("assignedTo", "firstName lastName")
                .sort({ createdAt: -1 })
                .limit(50)
                .lean(),
        ]);

        const byStatus = { new: 0, qualified: 0, converted: 0, dead: 0 };
        statusBreakdown.forEach((s) => {
            if (s._id && byStatus[s._id] !== undefined) byStatus[s._id] = s.count;
        });

        const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

        res.status(200).json({
            success: true,
            data: {
                period: { fromDate, toDate },
                total,
                byStatus,
                conversionRate: total > 0
                    ? parseFloat(((byStatus.converted / total) * 100).toFixed(1))
                    : 0,
                byAgent,
                recentLeads: recentLeads.map((l) => ({
                    id: l._id,
                    fullName: l.fullName,
                    company: l.company,
                    status: l.status,
                    createdAt: l.createdAt,
                    updatedAt: l.updatedAt,
                    assignedAgent: l.assignedTo
                        ? `${l.assignedTo.firstName || ""} ${l.assignedTo.lastName || ""}`.trim()
                        : "Unassigned",
                    daysSinceCreation: Math.floor(
                        (Date.now() - new Date(l.createdAt).getTime()) /
                            (1000 * 60 * 60 * 24)
                    ),
                })),
            },
        });
    } catch (error) {
        console.error("Error in getLeadsAnalytics:", error);
        res.status(500).json({ success: false, message: "Error fetching leads analytics", error: error.message });
    }
};

/**
 * GET /api/main-admin-dashboard/recent-activity
 * Recent orders + recent quotations across the team for the dashboard.
 * Optionally scoped to a salesAgent.
 */
exports.getRecentActivity = async (req, res) => {
    try {
        const { fromDate, toDate } = getDateRange(req.query);
        const dateFilter = { DocDate: { $gte: fromDate, $lte: toDate } };
        if (req.query.salesAgent && mongoose.Types.ObjectId.isValid(req.query.salesAgent)) {
            dateFilter.salesAgent = new mongoose.Types.ObjectId(req.query.salesAgent);
        }

        const [recentOrders, recentQuotations, recentInvoices] = await Promise.all([
            SalesOrder.find(dateFilter)
                .populate("salesAgent", "firstName lastName")
                .select("DocNum DocDate CardCode CardName DocTotal VatSum DocumentStatus salesAgent")
                .sort({ DocDate: -1 })
                .limit(10)
                .lean(),
            Quotation.find(dateFilter)
                .populate("salesAgent", "firstName lastName")
                .select("DocNum DocDate CardCode CardName DocTotal VatSum approvalStatus ConvertedToOrderDocEntry salesAgent")
                .sort({ DocDate: -1 })
                .limit(10)
                .lean(),
            Invoice.find(dateFilter)
                .populate("salesAgent", "firstName lastName")
                .select("DocNum DocDate CardCode CardName DocTotal VatSum paymentStatus salesAgent")
                .sort({ DocDate: -1 })
                .limit(10)
                .lean(),
        ]);

        const normalizeAgent = (a) =>
            a ? `${a.firstName || ""} ${a.lastName || ""}`.trim() : "—";
        const netOf = (d) => (Number(d.DocTotal || 0) - Number(d.VatSum || 0));

        res.status(200).json({
            success: true,
            data: {
                recentOrders: recentOrders.map((o) => ({
                    docNum: o.DocNum,
                    docDate: o.DocDate,
                    cardCode: o.CardCode,
                    cardName: o.CardName,
                    netTotal: netOf(o),
                    status: o.DocumentStatus,
                    agent: normalizeAgent(o.salesAgent),
                })),
                recentQuotations: recentQuotations.map((q) => ({
                    docNum: q.DocNum,
                    docDate: q.DocDate,
                    cardCode: q.CardCode,
                    cardName: q.CardName,
                    netTotal: netOf(q),
                    approvalStatus: q.approvalStatus,
                    converted: !!q.ConvertedToOrderDocEntry,
                    convertedToOrderDocEntry: q.ConvertedToOrderDocEntry || null,
                    agent: normalizeAgent(q.salesAgent),
                })),
                recentInvoices: recentInvoices.map((i) => ({
                    docNum: i.DocNum,
                    docDate: i.DocDate,
                    cardCode: i.CardCode,
                    cardName: i.CardName,
                    netTotal: netOf(i),
                    paymentStatus: i.paymentStatus,
                    agent: normalizeAgent(i.salesAgent),
                })),
            },
        });
    } catch (error) {
        console.error("Error in getRecentActivity:", error);
        res.status(500).json({ success: false, message: "Error fetching recent activity", error: error.message });
    }
};