// controllers/reporting.controller.js
const Invoice = require("../models/Invoice");
const SalesOrder = require("../models/SalesOrder");
const Quotation = require("../models/Quotation");
const Payment = require("../models/payment");
const Customer = require("../models/Customer");
const mongoose = require("mongoose");

// Get customer sales report with invoices and period comparison
exports.getCustomerSalesReport = async (req, res) => {
    try {
        const {
            startDate,
            endDate,
            cardCode,
            sortBy = "totalSales",
            sortOrder = "desc",
            comparisonStartDate,
            comparisonEndDate
        } = req.query;

        console.log("Fetching customer sales report...", {
            startDate,
            endDate,
            cardCode,
            comparisonStartDate,
            comparisonEndDate
        });

        // Build current period date filter
        let dateFilter = {};
        if (startDate || endDate) {
            dateFilter.DocDate = {};
            if (startDate) dateFilter.DocDate.$gte = new Date(startDate);
            if (endDate) dateFilter.DocDate.$lte = new Date(endDate);
        }

        // Build customer filter
        let customerFilter = {};
        if (cardCode) {
            customerFilter.CardCode = cardCode;
        }

        // Combine filters for current period
        const invoiceFilter = { ...dateFilter, ...customerFilter };

        // Aggregate invoice data by customer for CURRENT period
        const customerSales = await Invoice.aggregate([
            { $match: invoiceFilter },
            {
                $group: {
                    _id: "$CardCode",
                    customerName: { $first: "$CardName" },
                    totalSales: { $sum: "$DocTotal" },
                    totalInvoices: { $count: {} },
                    invoiceNumbers: { $push: "$DocNum" },
                    avgInvoiceValue: { $avg: "$DocTotal" },
                    lastInvoiceDate: { $max: "$DocDate" },
                    firstInvoiceDate: { $min: "$DocDate" },
                },
            },
            {
                $lookup: {
                    from: "customers",
                    localField: "_id",
                    foreignField: "CardCode",
                    as: "customerDetails",
                },
            },
            {
                $unwind: {
                    path: "$customerDetails",
                    preserveNullAndEmptyArrays: true,
                },
            },
            {
                $project: {
                    cardCode: "$_id",
                    customerName: 1,
                    totalSales: 1,
                    totalInvoices: 1,
                    invoiceNumbers: 1,
                    avgInvoiceValue: 1,
                    lastInvoiceDate: 1,
                    firstInvoiceDate: 1,
                    assignedTo: "$customerDetails.assignedTo",
                    customerStatus: "$customerDetails.status",
                },
            },
            { $sort: { [sortBy]: sortOrder === "asc" ? 1 : -1 } },
        ]);

        // Get COMPARISON period data if dates provided
        let comparisonSalesMap = new Map();
        if (comparisonStartDate && comparisonEndDate) {
            const comparisonFilter = {
                ...customerFilter,
                DocDate: {
                    $gte: new Date(comparisonStartDate),
                    $lte: new Date(comparisonEndDate),
                },
            };

            const comparisonSales = await Invoice.aggregate([
                { $match: comparisonFilter },
                {
                    $group: {
                        _id: "$CardCode",
                        totalSales: { $sum: "$DocTotal" },
                        totalInvoices: { $count: {} },
                        avgInvoiceValue: { $avg: "$DocTotal" },
                    },
                },
            ]);

            comparisonSalesMap = new Map(
                comparisonSales.map(cs => [cs._id, cs])
            );
        }

        // Get sales orders for the same period
        const salesOrderFilter = { ...dateFilter, ...customerFilter };
        const salesOrders = await SalesOrder.aggregate([
            { $match: salesOrderFilter },
            {
                $group: {
                    _id: "$CardCode",
                    totalOrders: { $count: {} },
                    orderNumbers: { $push: "$DocNum" },
                    totalOrderValue: { $sum: "$DocTotal" },
                },
            },
        ]);

        // Get quotations for the same period
        const quotationFilter = { ...dateFilter, ...customerFilter };
        const quotations = await Quotation.aggregate([
            { $match: quotationFilter },
            {
                $group: {
                    _id: "$CardCode",
                    totalQuotations: { $count: {} },
                    quotationNumbers: { $push: "$DocNum" },
                    totalQuotationValue: { $sum: "$DocTotal" },
                },
            },
        ]);

        // Merge all data
        const salesOrderMap = new Map(salesOrders.map(so => [so._id, so]));
        const quotationMap = new Map(quotations.map(q => [q._id, q]));

        const enrichedData = customerSales.map(customer => {
            const so = salesOrderMap.get(customer.cardCode) || {};
            const qt = quotationMap.get(customer.cardCode) || {};
            const comparison = comparisonSalesMap.get(customer.cardCode);

            // Calculate period-over-period changes
            let periodComparison = null;
            if (comparison) {
                const salesChange = customer.totalSales - comparison.totalSales;
                const salesChangePercent = comparison.totalSales !== 0
                    ? parseFloat(((salesChange / comparison.totalSales) * 100).toFixed(2))
                    : null;

                const invoiceChange = customer.totalInvoices - comparison.totalInvoices;
                const invoiceChangePercent = comparison.totalInvoices !== 0
                    ? parseFloat(((invoiceChange / comparison.totalInvoices) * 100).toFixed(2))
                    : null;

                const avgInvoiceChange = customer.avgInvoiceValue - comparison.avgInvoiceValue;
                const avgInvoiceChangePercent = comparison.avgInvoiceValue !== 0
                    ? parseFloat(((avgInvoiceChange / comparison.avgInvoiceValue) * 100).toFixed(2))
                    : null;

                periodComparison = {
                    previousPeriod: {
                        totalSales: comparison.totalSales,
                        totalInvoices: comparison.totalInvoices,
                        avgInvoiceValue: comparison.avgInvoiceValue,
                    },
                    changes: {
                        salesChange,
                        salesChangePercent,
                        invoiceChange,
                        invoiceChangePercent,
                        avgInvoiceChange,
                        avgInvoiceChangePercent,
                    },
                };
            }

            return {
                ...customer,
                salesOrders: {
                    count: so.totalOrders || 0,
                    numbers: so.orderNumbers || [],
                    totalValue: so.totalOrderValue || 0,
                },
                quotations: {
                    count: qt.totalQuotations || 0,
                    numbers: qt.quotationNumbers || [],
                    totalValue: qt.totalQuotationValue || 0,
                },
                periodComparison,
            };
        });

        res.status(200).json({
            success: true,
            count: enrichedData.length,
            data: enrichedData,
            filters: {
                startDate,
                endDate,
                cardCode,
                comparisonStartDate,
                comparisonEndDate,
            },
        });
    } catch (error) {
        console.error("Error in getCustomerSalesReport:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching customer sales report",
            error: error.message,
        });
    }
};

// Get period comparison analysis
exports.getPeriodComparison = async (req, res) => {
    try {
        const {
            comparisonType = "month", // month, quarter, year
            startDate,
            endDate,
            cardCode,
        } = req.query;

        console.log("Fetching period comparison...", { comparisonType, startDate, endDate, cardCode });

        if (!startDate || !endDate) {
            return res.status(400).json({
                success: false,
                message: "Start date and end date are required",
            });
        }

        // Build filters
        let dateFilter = {
            DocDate: {
                $gte: new Date(startDate),
                $lte: new Date(endDate),
            },
        };

        let customerFilter = {};
        if (cardCode) {
            customerFilter.CardCode = cardCode;
        }

        const filter = { ...dateFilter, ...customerFilter };

        // Define grouping based on comparison type
        let groupByDate;
        switch (comparisonType) {
            case "month":
                groupByDate = {
                    year: { $year: "$DocDate" },
                    month: { $month: "$DocDate" },
                };
                break;
            case "quarter":
                groupByDate = {
                    year: { $year: "$DocDate" },
                    quarter: { $ceil: { $divide: [{ $month: "$DocDate" }, 3] } },
                };
                break;
            case "year":
                groupByDate = {
                    year: { $year: "$DocDate" },
                };
                break;
            default:
                groupByDate = {
                    year: { $year: "$DocDate" },
                    month: { $month: "$DocDate" },
                };
        }

        // Aggregate invoices by period
        const periodSales = await Invoice.aggregate([
            { $match: filter },
            {
                $group: {
                    _id: groupByDate,
                    totalSales: { $sum: "$DocTotal" },
                    totalInvoices: { $count: {} },
                    avgInvoiceValue: { $avg: "$DocTotal" },
                    customers: { $addToSet: "$CardCode" },
                },
            },
            {
                $project: {
                    period: "$_id",
                    totalSales: 1,
                    totalInvoices: 1,
                    avgInvoiceValue: 1,
                    uniqueCustomers: { $size: "$customers" },
                },
            },
            { $sort: { "period.year": 1, "period.month": 1, "period.quarter": 1 } },
        ]);

        // Calculate period-over-period changes
        const enrichedPeriods = periodSales.map((current, index) => {
            if (index === 0) {
                return {
                    ...current,
                    growth: null,
                    growthPercent: null,
                };
            }

            const previous = periodSales[index - 1];
            const growth = current.totalSales - previous.totalSales;
            const growthPercent = previous.totalSales !== 0
                ? ((growth / previous.totalSales) * 100).toFixed(2)
                : null;

            return {
                ...current,
                growth,
                growthPercent: parseFloat(growthPercent),
                previousPeriodSales: previous.totalSales,
            };
        });

        // Generate trend data for sparklines
        const trendData = enrichedPeriods.map(p => ({
            period: formatPeriod(p.period, comparisonType),
            value: p.totalSales,
        }));

        res.status(200).json({
            success: true,
            comparisonType,
            data: enrichedPeriods,
            trendData,
            summary: {
                totalPeriods: enrichedPeriods.length,
                overallGrowth: enrichedPeriods.length > 1
                    ? enrichedPeriods[enrichedPeriods.length - 1].totalSales - enrichedPeriods[0].totalSales
                    : 0,
                avgPeriodSales: enrichedPeriods.reduce((sum, p) => sum + p.totalSales, 0) / enrichedPeriods.length,
            },
        });
    } catch (error) {
        console.error("Error in getPeriodComparison:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching period comparison",
            error: error.message,
        });
    }
};

// Get customer product-level drill-down analysis
exports.getCustomerProductAnalysis = async (req, res) => {
    try {
        const { cardCode } = req.params;
        const { startDate, endDate, comparisonStartDate, comparisonEndDate } = req.query;

        console.log("Fetching customer product analysis...", { cardCode, startDate, endDate });

        if (!cardCode) {
            return res.status(400).json({
                success: false,
                message: "Customer code (cardCode) is required",
            });
        }

        // Build current period filter
        let currentPeriodFilter = { CardCode: cardCode };
        if (startDate || endDate) {
            currentPeriodFilter.DocDate = {};
            if (startDate) currentPeriodFilter.DocDate.$gte = new Date(startDate);
            if (endDate) currentPeriodFilter.DocDate.$lte = new Date(endDate);
        }

        // Get current period product sales
        const currentPeriodProducts = await Invoice.aggregate([
            { $match: currentPeriodFilter },
            { $unwind: "$DocumentLines" },
            {
                $group: {
                    _id: "$DocumentLines.ItemCode",
                    itemDescription: { $first: "$DocumentLines.ItemDescription" },
                    totalQuantity: { $sum: "$DocumentLines.Quantity" },
                    totalSales: { $sum: "$DocumentLines.LineTotal" },
                    avgPrice: { $avg: "$DocumentLines.Price" },
                    invoiceCount: { $addToSet: "$DocNum" },
                    lastPurchaseDate: { $max: "$DocDate" },
                    firstPurchaseDate: { $min: "$DocDate" },
                },
            },
            {
                $project: {
                    itemCode: "$_id",
                    itemDescription: 1,
                    totalQuantity: 1,
                    totalSales: 1,
                    avgPrice: 1,
                    invoiceCount: { $size: "$invoiceCount" },
                    lastPurchaseDate: 1,
                    firstPurchaseDate: 1,
                },
            },
            { $sort: { totalSales: -1 } },
        ]);

        // If comparison period provided, get comparison data
        let comparisonPeriodProducts = [];
        let stoppedProducts = [];
        let newProducts = [];

        if (comparisonStartDate && comparisonEndDate) {
            const comparisonFilter = {
                CardCode: cardCode,
                DocDate: {
                    $gte: new Date(comparisonStartDate),
                    $lte: new Date(comparisonEndDate),
                },
            };

            comparisonPeriodProducts = await Invoice.aggregate([
                { $match: comparisonFilter },
                { $unwind: "$DocumentLines" },
                {
                    $group: {
                        _id: "$DocumentLines.ItemCode",
                        itemDescription: { $first: "$DocumentLines.ItemDescription" },
                        totalQuantity: { $sum: "$DocumentLines.Quantity" },
                        totalSales: { $sum: "$DocumentLines.LineTotal" },
                        avgPrice: { $avg: "$DocumentLines.Price" },
                    },
                },
            ]);

            // Create maps for comparison
            const currentProductMap = new Map(
                currentPeriodProducts.map(p => [p.itemCode, p])
            );
            const comparisonProductMap = new Map(
                comparisonPeriodProducts.map(p => [p._id, p])
            );

            // Find stopped products (in comparison period but not in current)
            stoppedProducts = comparisonPeriodProducts
                .filter(p => !currentProductMap.has(p._id))
                .map(p => ({
                    itemCode: p._id,
                    itemDescription: p.itemDescription,
                    lastPeriodQuantity: p.totalQuantity,
                    lastPeriodSales: p.totalSales,
                    status: "stopped",
                }));

            // Find new products (in current period but not in comparison)
            newProducts = currentPeriodProducts
                .filter(p => !comparisonProductMap.has(p.itemCode))
                .map(p => ({
                    ...p,
                    status: "new",
                }));

            // Enrich current products with comparison data
            currentPeriodProducts.forEach(product => {
                const comparisonProduct = comparisonProductMap.get(product.itemCode);
                if (comparisonProduct) {
                    product.comparison = {
                        quantityChange: product.totalQuantity - comparisonProduct.totalQuantity,
                        quantityChangePercent: comparisonProduct.totalQuantity !== 0
                            ? ((product.totalQuantity - comparisonProduct.totalQuantity) / comparisonProduct.totalQuantity * 100).toFixed(2)
                            : null,
                        salesChange: product.totalSales - comparisonProduct.totalSales,
                        salesChangePercent: comparisonProduct.totalSales !== 0
                            ? ((product.totalSales - comparisonProduct.totalSales) / comparisonProduct.totalSales * 100).toFixed(2)
                            : null,
                        priceChange: product.avgPrice - comparisonProduct.avgPrice,
                    };
                }
            });
        }

        // Get customer info
        const customer = await Customer.findOne({ CardCode: cardCode }).select(
            "CardName Email assignedTo status"
        );

        // Calculate product insights
        const insights = {
            totalProductsPurchased: currentPeriodProducts.length,
            topProducts: currentPeriodProducts.slice(0, 10),
            stoppedProductsCount: stoppedProducts.length,
            newProductsCount: newProducts.length,
            avgProductsPerInvoice: currentPeriodProducts.length > 0
                ? currentPeriodProducts.reduce((sum, p) => sum + p.invoiceCount, 0) / currentPeriodProducts.length
                : 0,
        };

        res.status(200).json({
            success: true,
            customer: customer || { CardCode: cardCode },
            currentPeriod: {
                startDate,
                endDate,
                products: currentPeriodProducts,
            },
            comparisonPeriod: comparisonStartDate && comparisonEndDate ? {
                startDate: comparisonStartDate,
                endDate: comparisonEndDate,
                stoppedProducts,
                newProducts,
            } : null,
            insights,
        });
    } catch (error) {
        console.error("Error in getCustomerProductAnalysis:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching customer product analysis",
            error: error.message,
        });
    }
};

// Get inactive customers (stopped buying)
exports.getInactiveCustomers = async (req, res) => {
    try {
        const { inactiveDays = 90, limit = 50 } = req.query;

        console.log("Fetching inactive customers...", { inactiveDays });

        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - parseInt(inactiveDays));

        // Get customers with their last invoice date
        const customersWithLastInvoice = await Invoice.aggregate([
            {
                $group: {
                    _id: "$CardCode",
                    customerName: { $first: "$CardName" },
                    lastInvoiceDate: { $max: "$DocDate" },
                    totalHistoricalSales: { $sum: "$DocTotal" },
                    totalHistoricalInvoices: { $count: {} },
                },
            },
            {
                $match: {
                    lastInvoiceDate: { $lt: cutoffDate },
                },
            },
            {
                $lookup: {
                    from: "customers",
                    localField: "_id",
                    foreignField: "CardCode",
                    as: "customerDetails",
                },
            },
            {
                $unwind: {
                    path: "$customerDetails",
                    preserveNullAndEmptyArrays: true,
                },
            },
            {
                $project: {
                    cardCode: "$_id",
                    customerName: 1,
                    lastInvoiceDate: 1,
                    daysSinceLastPurchase: {
                        $divide: [
                            { $subtract: [new Date(), "$lastInvoiceDate"] },
                            1000 * 60 * 60 * 24,
                        ],
                    },
                    totalHistoricalSales: 1,
                    totalHistoricalInvoices: 1,
                    assignedTo: "$customerDetails.assignedTo",
                    customerStatus: "$customerDetails.status",
                    email: "$customerDetails.Email",
                },
            },
            { $sort: { daysSinceLastPurchase: -1 } },
            { $limit: parseInt(limit) },
        ]);

        res.status(200).json({
            success: true,
            count: customersWithLastInvoice.length,
            inactiveDays: parseInt(inactiveDays),
            cutoffDate,
            data: customersWithLastInvoice,
        });
    } catch (error) {
        console.error("Error in getInactiveCustomers:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching inactive customers",
            error: error.message,
        });
    }
};

// Get overall sales dashboard summary
exports.getSalesDashboardSummary = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;

        console.log("Fetching sales dashboard summary...", { startDate, endDate });

        // Build date filter
        let dateFilter = {};
        if (startDate || endDate) {
            dateFilter.DocDate = {};
            if (startDate) dateFilter.DocDate.$gte = new Date(startDate);
            if (endDate) dateFilter.DocDate.$lte = new Date(endDate);
        }

        // Get invoice summary
        const invoiceSummary = await Invoice.aggregate([
            { $match: dateFilter },
            {
                $group: {
                    _id: null,
                    totalSales: { $sum: "$DocTotal" },
                    totalInvoices: { $count: {} },
                    avgInvoiceValue: { $avg: "$DocTotal" },
                    uniqueCustomers: { $addToSet: "$CardCode" },
                },
            },
            {
                $project: {
                    totalSales: 1,
                    totalInvoices: 1,
                    avgInvoiceValue: 1,
                    uniqueCustomers: { $size: "$uniqueCustomers" },
                },
            },
        ]);

        // Get sales orders summary
        const salesOrderSummary = await SalesOrder.aggregate([
            { $match: dateFilter },
            {
                $group: {
                    _id: null,
                    totalOrderValue: { $sum: "$DocTotal" },
                    totalOrders: { $count: {} },
                    openOrders: {
                        $sum: { $cond: [{ $eq: ["$DocumentStatus", "bost_Open"] }, 1, 0] },
                    },
                },
            },
        ]);

        // Get quotations summary
        const quotationSummary = await Quotation.aggregate([
            { $match: dateFilter },
            {
                $group: {
                    _id: null,
                    totalQuotationValue: { $sum: "$DocTotal" },
                    totalQuotations: { $count: {} },
                    pendingQuotations: {
                        $sum: { $cond: [{ $eq: ["$approvalStatus", "pending"] }, 1, 0] },
                    },
                },
            },
        ]);

        // Get payment summary
        const paymentSummary = await Payment.aggregate([
            { $match: dateFilter },
            {
                $group: {
                    _id: null,
                    totalPaymentsReceived: { $sum: "$CashSum" },
                    totalPaymentTransactions: { $count: {} },
                },
            },
        ]);

        const summary = {
            invoices: invoiceSummary[0] || {
                totalSales: 0,
                totalInvoices: 0,
                avgInvoiceValue: 0,
                uniqueCustomers: 0,
            },
            salesOrders: salesOrderSummary[0] || {
                totalOrderValue: 0,
                totalOrders: 0,
                openOrders: 0,
            },
            quotations: quotationSummary[0] || {
                totalQuotationValue: 0,
                totalQuotations: 0,
                pendingQuotations: 0,
            },
            payments: paymentSummary[0] || {
                totalPaymentsReceived: 0,
                totalPaymentTransactions: 0,
            },
            dateRange: {
                startDate,
                endDate,
            },
        };

        res.status(200).json({
            success: true,
            data: summary,
        });
    } catch (error) {
        console.error("Error in getSalesDashboardSummary:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching sales dashboard summary",
            error: error.message,
        });
    }
};

// Helper function to format period display
function formatPeriod(period, comparisonType) {
    if (comparisonType === "year") {
        return `${period.year}`;
    } else if (comparisonType === "quarter") {
        return `Q${period.quarter} ${period.year}`;
    } else {
        const monthNames = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun",
            "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
        ];
        return `${monthNames[period.month - 1]} ${period.year}`;
    }
}