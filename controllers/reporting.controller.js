// controllers/reporting.controller.js
const Invoice = require("../models/Invoice");
const SalesOrder = require("../models/SalesOrder");
const Quotation = require("../models/Quotation");
const Payment = require("../models/payment");
const Customer = require("../models/Customer");
const CreditNote = require("../models/CreditNotes");
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
            comparisonEndDate,
            assignedTo, // NEW: Agent filter
            page = 1,   // NEW: Pagination
            limit = 50  // NEW: Pagination
        } = req.query;

        console.log("Fetching customer sales report...", {
            startDate,
            endDate,
            cardCode,
            comparisonStartDate,
            comparisonEndDate,
            assignedTo,
            page,
            limit,
            sortBy,
            sortOrder
        });

        // Build current period date filter (only for filtering invoices, not customers)
        let invoiceDateFilter = {};
        if (startDate || endDate) {
            invoiceDateFilter.DocDate = {};
            if (startDate) invoiceDateFilter.DocDate.$gte = new Date(startDate);
            if (endDate) invoiceDateFilter.DocDate.$lte = new Date(endDate);
        }

        // Build customer filter
        let customerFilter = {};
        if (cardCode) {
            customerFilter.CardCode = cardCode;
        }
        // NEW: Add agent filter
        if (assignedTo) {
            customerFilter.assignedTo = assignedTo;
        }

        //only include the customers that have cardcode starting with C (customers)
        customerFilter.CardCode = { $regex: /^C/i };

        // NEW: Get ALL customers matching the filter (not just those with invoices in period)
        const allCustomers = await Customer.find(customerFilter)
            .populate('assignedTo', 'firstName lastName') // ADD THIS LINE
            .select("CardCode CardName assignedTo status Email")
            .lean();

        const customerMap = new Map(
            allCustomers.map(c => [c.CardCode, c])
        );

        // Combine filters for current period invoices
        const invoiceFilter = { ...invoiceDateFilter };
        if (cardCode) {
            invoiceFilter.CardCode = cardCode;
        }

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
                $project: {
                    cardCode: "$_id",
                    customerName: 1,
                    totalSales: 1,
                    totalInvoices: 1,
                    invoiceNumbers: 1,
                    avgInvoiceValue: 1,
                    lastInvoiceDate: 1,
                    firstInvoiceDate: 1,
                },
            },
        ]);

        const customerCreditNotes = await CreditNote.aggregate([
            { $match: invoiceFilter }, // Same date filter as invoices
            {
                $group: {
                    _id: "$CardCode",
                    totalCreditNotes: { $sum: "$DocTotal" },
                    creditNoteCount: { $count: {} },
                    creditNoteNumbers: { $push: "$DocNum" },
                },
            },
        ]);

        // NEW: Get last invoice date for ALL customers (regardless of date range)
        const allLastInvoices = await Invoice.aggregate([
            {
                $match: {
                    CardCode: { $in: Array.from(customerMap.keys()) }
                }
            },
            {
                $group: {
                    _id: "$CardCode",
                    lastInvoiceDate: { $max: "$DocDate" }
                }
            }
        ]);

        const lastInvoiceMap = new Map(
            allLastInvoices.map(li => [li._id, li.lastInvoiceDate])
        );

        let comparisonSalesMap = new Map();
        let comparisonCreditNotesMap = new Map();
        if (comparisonStartDate && comparisonEndDate) {
            const comparisonFilter = {
                DocDate: {
                    $gte: new Date(comparisonStartDate),
                    $lte: new Date(comparisonEndDate),
                },
            };
            if (cardCode) {
                comparisonFilter.CardCode = cardCode;
            }

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

            // Get comparison credit notes
            const comparisonCreditNotes = await CreditNote.aggregate([
                { $match: comparisonFilter },
                {
                    $group: {
                        _id: "$CardCode",
                        totalCreditNotes: { $sum: "$DocTotal" },
                        creditNoteCount: { $count: {} },
                    },
                },
            ]);

            comparisonSalesMap = new Map(
                comparisonSales.map(cs => [cs._id, cs])
            );
            comparisonCreditNotesMap = new Map(
                comparisonCreditNotes.map(cn => [cn._id, cn])
            );
        }

        // Get sales orders for the same period
        const salesOrderFilter = { ...invoiceDateFilter };
        if (cardCode) {
            salesOrderFilter.CardCode = cardCode;
        }
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
        const quotationFilter = { ...invoiceDateFilter };
        if (cardCode) {
            quotationFilter.CardCode = cardCode;
        }
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
        const salesMap = new Map(customerSales.map(cs => [cs.cardCode, cs]));
        const salesOrderMap = new Map(salesOrders.map(so => [so._id, so]));
        const quotationMap = new Map(quotations.map(q => [q._id, q]));
        const creditNotesMap = new Map(customerCreditNotes.map(cn => [cn._id, cn]));

        // NEW: Build enriched data for ALL customers
        const enrichedData = Array.from(customerMap.values()).map(customer => {
            const sales = salesMap.get(customer.CardCode) || {};
            const so = salesOrderMap.get(customer.CardCode) || {};
            const qt = quotationMap.get(customer.CardCode) || {};
            const creditNotes = creditNotesMap.get(customer.CardCode) || {};
            const comparison = comparisonSalesMap.get(customer.CardCode);
            const comparisonCreditNotes = comparisonCreditNotesMap.get(customer.CardCode);

            // Calculate net sales (invoices - credit notes)
            const totalCreditNotesAmount = creditNotes.totalCreditNotes || 0;
            const grossSales = sales.totalSales || 0;
            const netSales = grossSales - totalCreditNotesAmount;

            // Calculate period-over-period changes
            // Calculate period-over-period changes
            let periodComparison = null;
            if (comparison && sales.totalSales !== undefined) {
                const prevCreditNotesAmount = comparisonCreditNotes?.totalCreditNotes || 0;
                const prevGrossSales = comparison.totalSales;
                const prevNetSales = prevGrossSales - prevCreditNotesAmount;

                const salesChange = netSales - prevNetSales;
                const salesChangePercent = prevNetSales !== 0
                    ? parseFloat(((salesChange / prevNetSales) * 100).toFixed(2))
                    : null;

                const creditNotesChange = totalCreditNotesAmount - prevCreditNotesAmount;
                const creditNotesChangePercent = prevCreditNotesAmount !== 0
                    ? parseFloat(((creditNotesChange / prevCreditNotesAmount) * 100).toFixed(2))
                    : null;

                const invoiceChange = (sales.totalInvoices || 0) - comparison.totalInvoices;
                const invoiceChangePercent = comparison.totalInvoices !== 0
                    ? parseFloat(((invoiceChange / comparison.totalInvoices) * 100).toFixed(2))
                    : null;

                const avgInvoiceChange = (sales.avgInvoiceValue || 0) - comparison.avgInvoiceValue;
                const avgInvoiceChangePercent = comparison.avgInvoiceValue !== 0
                    ? parseFloat(((avgInvoiceChange / comparison.avgInvoiceValue) * 100).toFixed(2))
                    : null;

                periodComparison = {
                    previousPeriod: {
                        grossSales: prevGrossSales,
                        totalCreditNotes: prevCreditNotesAmount,
                        netSales: prevNetSales,
                        totalInvoices: comparison.totalInvoices,
                        avgInvoiceValue: comparison.avgInvoiceValue,
                        creditNoteCount: comparisonCreditNotes?.creditNoteCount || 0,
                    },
                    changes: {
                        salesChange,
                        salesChangePercent,
                        creditNotesChange,
                        creditNotesChangePercent,
                        invoiceChange,
                        invoiceChangePercent,
                        avgInvoiceChange,
                        avgInvoiceChangePercent,
                    },
                };
            }

            return {
                cardCode: customer.CardCode,
                customerName: customer.CardName || sales.customerName || "Unknown",
                grossSales: grossSales,
                totalCreditNotes: totalCreditNotesAmount,
                creditNoteCount: creditNotes.creditNoteCount || 0,
                creditNoteNumbers: creditNotes.creditNoteNumbers || [],
                netSales: netSales,
                totalSales: netSales, // For backward compatibility and sorting
                totalInvoices: sales.totalInvoices || 0,
                invoiceNumbers: sales.invoiceNumbers || [],
                avgInvoiceValue: sales.avgInvoiceValue || 0,
                lastInvoiceDate: lastInvoiceMap.get(customer.CardCode) || null,
                firstInvoiceDate: sales.firstInvoiceDate || null,
                assignedTo: customer.assignedTo?._id || customer.assignedTo || null, // NEW: Handle populated object
                assignedToName: customer.assignedTo ? `${customer.assignedTo.firstName} ${customer.assignedTo.lastName}` : null, // NEW
                customerStatus: customer.status || null,
                email: customer.Email || null,
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

        // NEW: Apply sorting
        const validSortFields = ['totalSales', 'netSales', 'grossSales', 'totalCreditNotes', 'totalInvoices', 'avgInvoiceValue', 'lastInvoiceDate', 'customerName', 'cardCode'];
        const actualSortBy = validSortFields.includes(sortBy) ? sortBy : 'totalSales';
        const actualSortOrder = sortOrder === 'asc' ? 1 : -1;

        enrichedData.sort((a, b) => {
            let aVal = a[actualSortBy];
            let bVal = b[actualSortBy];

            // Handle null values
            if (aVal === null || aVal === undefined) return 1;
            if (bVal === null || bVal === undefined) return -1;

            // Handle string comparison
            if (typeof aVal === 'string') {
                return actualSortOrder * aVal.localeCompare(bVal);
            }

            // Handle date comparison
            if (aVal instanceof Date || actualSortBy === 'lastInvoiceDate') {
                aVal = aVal ? new Date(aVal).getTime() : 0;
                bVal = bVal ? new Date(bVal).getTime() : 0;
            }

            return actualSortOrder * (aVal - bVal);
        });

        // NEW: Apply pagination
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const startIndex = (pageNum - 1) * limitNum;
        const endIndex = startIndex + limitNum;
        const paginatedData = enrichedData.slice(startIndex, endIndex);

        res.status(200).json({
            success: true,
            count: paginatedData.length,
            total: enrichedData.length,
            page: pageNum,
            totalPages: Math.ceil(enrichedData.length / limitNum),
            data: paginatedData,
            filters: {
                startDate,
                endDate,
                cardCode,
                comparisonStartDate,
                comparisonEndDate,
                assignedTo,
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

        // Get credit notes summary
        const creditNotesSummary = await CreditNote.aggregate([
            { $match: dateFilter },
            {
                $group: {
                    _id: null,
                    totalCreditNotes: { $sum: "$DocTotal" },
                    creditNoteCount: { $count: {} },
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

        const creditNotesData = creditNotesSummary[0] || {
            totalCreditNotes: 0,
            creditNoteCount: 0,
        };

        const invoiceData = invoiceSummary[0] || {
            totalSales: 0,
            totalInvoices: 0,
            avgInvoiceValue: 0,
            uniqueCustomers: 0,
        };

        const summary = {
            invoices: {
                ...invoiceData,
                grossSales: invoiceData.totalSales,
                totalCreditNotes: creditNotesData.totalCreditNotes,
                creditNoteCount: creditNotesData.creditNoteCount,
                netSales: invoiceData.totalSales - creditNotesData.totalCreditNotes,
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