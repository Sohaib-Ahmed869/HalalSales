// controllers/aiSummary.controller.js
const Customer = require("../models/Customer");
const Invoice = require("../models/Invoice");
const SalesOrder = require("../models/SalesOrder");
const CallData = require("../models/CallData");
const User = require("../models/User");
const CreditNotes = require("../models/CreditNotes");

/**
 * Get comprehensive customer analysis for a date range
 * Includes: top products, customer segmentation, overall metrics
 */
exports.getCustomerAnalysis = async (req, res) => {
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

        // Get all invoices in date range
        const invoices = await Invoice.find({
            DocDate: { $gte: start, $lte: end },
        }).lean();

        // Get credit notes
        const creditNotes = await CreditNotes.find({
            DocDate: { $gte: start, $lte: end },
        }).lean();

        // Calculate top products from invoice lines
        const productMap = {};
        invoices.forEach((invoice) => {
            if (invoice.DocumentLines) {
                invoice.DocumentLines.forEach((line) => {
                    const key = line.ItemCode;
                    if (!productMap[key]) {
                        productMap[key] = {
                            itemCode: line.ItemCode,
                            itemName: line.ItemDescription || line.ItemName || "Unknown",
                            totalQuantity: 0,
                            totalRevenue: 0,
                            invoiceCount: 0,
                        };
                    }
                    productMap[key].totalQuantity += line.Quantity || 0;
                    productMap[key].totalRevenue += line.LineTotal || 0;
                    productMap[key].invoiceCount += 1;
                });
            }
        });

        const topProducts = Object.values(productMap)
            .sort((a, b) => b.totalRevenue - a.totalRevenue)
            .slice(0, 20);

        // Customer segmentation based on revenue
        const customerMap = {};
        invoices.forEach((inv) => {
            if (!customerMap[inv.CardCode]) {
                customerMap[inv.CardCode] = {
                    cardCode: inv.CardCode,
                    cardName: inv.CardName,
                    totalRevenue: 0,
                    invoiceCount: 0,
                    lastInvoiceDate: inv.DocDate,
                };
            }
            customerMap[inv.CardCode].totalRevenue += (inv.DocTotal || 0) - (inv.VatSum || 0);
            customerMap[inv.CardCode].invoiceCount += 1;
            if (new Date(inv.DocDate) > new Date(customerMap[inv.CardCode].lastInvoiceDate)) {
                customerMap[inv.CardCode].lastInvoiceDate = inv.DocDate;
            }
        });

        // Subtract credit notes
        creditNotes.forEach((cn) => {
            if (customerMap[cn.CardCode]) {
                customerMap[cn.CardCode].totalRevenue -= (cn.DocTotal || 0) - (cn.VatSum || 0);
            }
        });

        const allCustomers = Object.values(customerMap);
        const sortedByRevenue = [...allCustomers].sort((a, b) => b.totalRevenue - a.totalRevenue);

        // Segmentation
        const bestCustomers = sortedByRevenue.slice(0, 10);
        const goodCustomers = sortedByRevenue.slice(10, 30);
        const badCustomers = sortedByRevenue
            .filter((c) => c.totalRevenue < 1000)
            .slice(0, 10);

        // Overall metrics
        const totalRevenue = allCustomers.reduce((sum, c) => sum + c.totalRevenue, 0);
        const totalInvoices = invoices.length;
        const totalCreditNotes = creditNotes.length;
        const creditNoteAmount = creditNotes.reduce(
            (sum, cn) => sum + ((cn.DocTotal || 0) - (cn.VatSum || 0)),
            0
        );
        const netRevenue = totalRevenue;

        // Calculate average order value
        const avgOrderValue = totalInvoices > 0 ? totalRevenue / totalInvoices : 0;

        // Revenue distribution
        const revenueRanges = {
            "0-1000": 0,
            "1000-5000": 0,
            "5000-10000": 0,
            "10000-50000": 0,
            "50000+": 0,
        };

        allCustomers.forEach((c) => {
            if (c.totalRevenue < 1000) revenueRanges["0-1000"]++;
            else if (c.totalRevenue < 5000) revenueRanges["1000-5000"]++;
            else if (c.totalRevenue < 10000) revenueRanges["5000-10000"]++;
            else if (c.totalRevenue < 50000) revenueRanges["10000-50000"]++;
            else revenueRanges["50000+"]++;
        });

        return res.json({
            success: true,
            data: {
                topProducts,
                customerSegmentation: {
                    best: bestCustomers,
                    good: goodCustomers,
                    bad: badCustomers,
                },
                overallMetrics: {
                    totalCustomers: allCustomers.length,
                    totalRevenue: parseFloat(totalRevenue.toFixed(2)),
                    netRevenue: parseFloat(netRevenue.toFixed(2)),
                    totalInvoices,
                    totalCreditNotes,
                    creditNoteAmount: parseFloat(creditNoteAmount.toFixed(2)),
                    avgOrderValue: parseFloat(avgOrderValue.toFixed(2)),
                    revenueDistribution: revenueRanges,
                },
            },
            dateRange: { startDate: start, endDate: end },
        });
    } catch (error) {
        console.error("Error in customer analysis:", error);
        return res.status(500).json({
            success: false,
            message: "Error generating customer analysis",
            error: error.message,
        });
    }
};

/**
 * Get comprehensive sales agent analysis
 * Includes: best calling times, order-to-invoice conversion patterns
 */
exports.getAgentAnalysis = async (req, res) => {
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

        // Get all sales agents
        const agents = await User.find({ role: "sales_agent" }).lean();

        // Get all calls in date range
        const calls = await CallData.find({
            startTime: { $gte: start, $lte: end },
        }).lean();

        // Analyze calling patterns by hour
        const callsByHour = Array(24).fill(0);
        const successfulCallsByHour = Array(24).fill(0);

        calls.forEach((call) => {
            const hour = new Date(call.startTime).getHours();
            callsByHour[hour]++;
            if (call.callStatus === "completed" || call.inCallDuration > 0) {
                successfulCallsByHour[hour]++;
            }
        });

        // Calculate success rate per hour
        const callingPatterns = callsByHour.map((count, hour) => ({
            hour,
            totalCalls: count,
            successfulCalls: successfulCallsByHour[hour],
            successRate: count > 0 ? (successfulCallsByHour[hour] / count) * 100 : 0,
        }));

        // Find best calling hours (top 5)
        const bestCallingHours = [...callingPatterns]
            .sort((a, b) => b.successRate - a.successRate)
            .slice(0, 5)
            .map((p) => ({
                hour: `${p.hour}:00 - ${p.hour + 1}:00`,
                successRate: parseFloat(p.successRate.toFixed(2)),
                totalCalls: p.totalCalls,
            }));

        // Get sales orders and invoices
        const [salesOrders, invoices] = await Promise.all([
            SalesOrder.find({ DocDate: { $gte: start, $lte: end } }).lean(),
            Invoice.find({ DocDate: { $gte: start, $lte: end } }).lean(),
        ]);

        // Analyze order-to-invoice conversion time
        const conversionTimes = [];
        salesOrders.forEach((order) => {
            const matchingInvoice = invoices.find((inv) => inv.CardCode === order.CardCode);
            if (matchingInvoice) {
                const orderDate = new Date(order.DocDate);
                const invoiceDate = new Date(matchingInvoice.DocDate);
                const daysDiff = Math.floor((invoiceDate - orderDate) / (1000 * 60 * 60 * 24));
                if (daysDiff >= 0 && daysDiff <= 90) {
                    conversionTimes.push({
                        days: daysDiff,
                        orderAmount: order.DocTotal,
                    });
                }
            }
        });

        // Group by time ranges
        const conversionRanges = {
            "0-1 days": 0,
            "2-3 days": 0,
            "4-7 days": 0,
            "8-14 days": 0,
            "15-30 days": 0,
            "30+ days": 0,
        };

        conversionTimes.forEach((conv) => {
            if (conv.days <= 1) conversionRanges["0-1 days"]++;
            else if (conv.days <= 3) conversionRanges["2-3 days"]++;
            else if (conv.days <= 7) conversionRanges["4-7 days"]++;
            else if (conv.days <= 14) conversionRanges["8-14 days"]++;
            else if (conv.days <= 30) conversionRanges["15-30 days"]++;
            else conversionRanges["30+ days"]++;
        });

        const avgConversionTime =
            conversionTimes.length > 0
                ? conversionTimes.reduce((sum, c) => sum + c.days, 0) / conversionTimes.length
                : 0;

        // Agent performance
        const agentPerformance = [];
        for (const agent of agents) {
            const agentCustomers = await Customer.find({ assignedTo: agent._id }).lean();
            const customerCodes = agentCustomers.map((c) => c.CardCode);

            const agentInvoices =
                customerCodes.length > 0
                    ? await Invoice.find({
                        CardCode: { $in: customerCodes },
                        DocDate: { $gte: start, $lte: end },
                    }).lean()
                    : [];

            const agentCalls = calls.filter(
                (c) =>
                    c.userName === `${agent.firstName} ${agent.lastName}` ||
                    c.userName === agent.email ||
                    c.fromNumber === agent.phone ||
                    c.toNumber === agent.phone
            );

            const totalRevenue = agentInvoices.reduce(
                (sum, inv) => sum + ((inv.DocTotal || 0) - (inv.VatSum || 0)),
                0
            );

            agentPerformance.push({
                agentId: agent._id,
                agentName: `${agent.firstName} ${agent.lastName}`,
                totalCustomers: agentCustomers.length,
                totalRevenue: parseFloat(totalRevenue.toFixed(2)),
                totalInvoices: agentInvoices.length,
                totalCalls: agentCalls.length,
                avgRevenuePerCustomer:
                    agentCustomers.length > 0
                        ? parseFloat((totalRevenue / agentCustomers.length).toFixed(2))
                        : 0,
            });
        }

        // Sort by revenue
        agentPerformance.sort((a, b) => b.totalRevenue - a.totalRevenue);

        return res.json({
            success: true,
            data: {
                bestCallingHours,
                callingPatterns: callingPatterns.filter((p) => p.totalCalls > 0),
                orderToInvoiceConversion: {
                    averageDays: parseFloat(avgConversionTime.toFixed(2)),
                    distribution: conversionRanges,
                    totalConversions: conversionTimes.length,
                },
                agentPerformance: agentPerformance.slice(0, 10),
                overallMetrics: {
                    totalAgents: agents.length,
                    totalCalls: calls.length,
                    totalOrders: salesOrders.length,
                    totalInvoices: invoices.length,
                    conversionRate:
                        salesOrders.length > 0
                            ? parseFloat(((invoices.length / salesOrders.length) * 100).toFixed(2))
                            : 0,
                },
            },
            dateRange: { startDate: start, endDate: end },
        });
    } catch (error) {
        console.error("Error in agent analysis:", error);
        return res.status(500).json({
            success: false,
            message: "Error generating agent analysis",
            error: error.message,
        });
    }
};

/**
 * Predictive analysis - which customers are likely to order soon
 * OPTIMIZED: Handles large datasets with batching + disk use + reasoning
 */
exports.getPredictiveAnalysis = async (req, res) => {
    try {
        const { targetDate } = req.query;

        if (!targetDate) {
            return res.status(400).json({
                success: false,
                message: "targetDate is required",
            });
        }

        const target = new Date(targetDate);
        const today = new Date();
        const cutoffDate = new Date(today);
        cutoffDate.setDate(cutoffDate.getDate() - 90);

        // STEP 1: Get active customers with recent orders (lighter query)
        const recentCustomers = await Invoice.aggregate([
            {
                $match: {
                    DocDate: { $gte: cutoffDate },
                },
            },
            {
                $group: {
                    _id: "$CardCode",
                    lastOrderDate: { $max: "$DocDate" },
                    recentOrders: { $sum: 1 },
                },
            },
            {
                $match: {
                    recentOrders: { $gte: 1 },
                },
            },
            {
                $project: {
                    _id: 1,
                },
            },
        ]).allowDiskUse(true);

        const activeCodes = recentCustomers.map((c) => c._id);

        if (activeCodes.length === 0) {
            return res.json({
                success: true,
                data: {
                    targetDate: target,
                    summary: {
                        totalPredictions: 0,
                        overdueCount: 0,
                        highPriorityCount: 0,
                        potentialCount: 0,
                    },
                    predictions: { overdue: [], highPriority: [], potential: [] },
                    allPredictions: [],
                },
            });
        }

        // STEP 2: Process in batches of 100 customers
        const batchSize = 100;
        const predictions = [];

        for (let i = 0; i < activeCodes.length; i += batchSize) {
            const batch = activeCodes.slice(i, i + batchSize);

            // Get patterns for this batch
            const batchPatterns = await Invoice.aggregate([
                {
                    $match: {
                        CardCode: { $in: batch },
                        DocDate: {
                            $gte: new Date(today.getTime() - 365 * 24 * 60 * 60 * 1000),
                        },
                    },
                },
                {
                    $sort: { CardCode: 1, DocDate: -1 },
                },
                {
                    $group: {
                        _id: "$CardCode",
                        cardName: { $first: "$CardName" },
                        totalOrders: { $sum: 1 },
                        lastOrderDate: { $max: "$DocDate" },
                        totalRevenue: { $sum: "$DocTotal" },
                        invoiceDates: { $push: "$DocDate" },
                    },
                },
                {
                    $match: {
                        totalOrders: { $gte: 2 },
                    },
                },
            ]).allowDiskUse(true);

            // Get customer details for this batch
            const batchCodes = batchPatterns.map((p) => p._id);
            const customers = await Customer.find(
                { CardCode: { $in: batchCodes }, status: "active" },
                "CardCode CardName Email assignedTo"
            )
                .populate("assignedTo", "firstName lastName")
                .lean();

            const customerMap = {};
            customers.forEach((c) => {
                customerMap[c.CardCode] = c;
            });

            // Process predictions for this batch
            for (const pattern of batchPatterns) {
                const customer = customerMap[pattern._id];
                if (!customer) continue;

                // Limit to last 6 dates for performance
                const dates = pattern.invoiceDates
                    .sort((a, b) => new Date(b) - new Date(a))
                    .slice(0, 6);

                const orderGaps = [];

                for (let j = 0; j < dates.length - 1; j++) {
                    const gap = Math.floor(
                        (new Date(dates[j]) - new Date(dates[j + 1])) /
                        (1000 * 60 * 60 * 24)
                    );
                    if (gap > 0 && gap < 120) {
                        orderGaps.push(gap);
                    }
                }

                if (orderGaps.length === 0) continue;

                const avgGap = Math.round(
                    orderGaps.reduce((sum, g) => sum + g, 0) / orderGaps.length
                );
                const lastOrderDate = new Date(pattern.lastOrderDate);
                const daysSinceLastOrder = Math.floor(
                    (today - lastOrderDate) / (1000 * 60 * 60 * 24)
                );

                const urgencyScore =
                    daysSinceLastOrder > avgGap
                        ? 100
                        : (daysSinceLastOrder / avgGap) * 100;

                if (urgencyScore < 60) continue;

                const predictedNextOrderDate = new Date(lastOrderDate);
                predictedNextOrderDate.setDate(
                    predictedNextOrderDate.getDate() + avgGap
                );

                const daysUntilPredicted = Math.floor(
                    (predictedNextOrderDate - today) / (1000 * 60 * 60 * 24)
                );

                const daysFromTarget = Math.abs(
                    Math.floor(
                        (predictedNextOrderDate - target) / (1000 * 60 * 60 * 24)
                    )
                );

                if (daysFromTarget > 10 && urgencyScore < 85) continue;

                const likelihood =
                    daysSinceLastOrder >= avgGap * 0.8
                        ? Math.min(100, (daysSinceLastOrder / avgGap) * 100)
                        : 0;

                const avgOrderValue = pattern.totalRevenue / pattern.totalOrders;

                // Generate detailed reason
                const reasons = [];

                // Primary reason based on urgency
                if (urgencyScore > 100) {
                    const daysOverdue = daysSinceLastOrder - avgGap;
                    reasons.push(`⚠️ OVERDUE by ${daysOverdue} days - typically orders every ${avgGap} days`);
                } else if (urgencyScore > 90) {
                    reasons.push(`🔴 Overdue - last order was ${daysSinceLastOrder} days ago (avg: ${avgGap} days)`);
                } else if (urgencyScore > 75) {
                    reasons.push(`🟡 Due soon - ${daysSinceLastOrder} days since last order (avg: ${avgGap} days)`);
                } else if (likelihood > 70) {
                    reasons.push(`🟢 Good timing - approaching next order window`);
                }

                // Order frequency pattern
                if (pattern.totalOrders >= 10) {
                    reasons.push(`Regular customer with ${pattern.totalOrders} orders in past year`);
                } else if (pattern.totalOrders >= 5) {
                    reasons.push(`Active customer with ${pattern.totalOrders} orders in past year`);
                } else {
                    reasons.push(`${pattern.totalOrders} orders in past year`);
                }

                // Revenue significance
                if (avgOrderValue > 10000) {
                    reasons.push(`High-value customer (avg: $${avgOrderValue.toFixed(0)} per order)`);
                } else if (avgOrderValue > 5000) {
                    reasons.push(`Medium-value customer (avg: $${avgOrderValue.toFixed(0)} per order)`);
                }

                // Proximity to target date
                if (daysFromTarget <= 3) {
                    reasons.push(`⭐ Perfect timing - predicted order aligns with target date`);
                } else if (daysFromTarget <= 7) {
                    reasons.push(`Close to target date (within ${daysFromTarget} days)`);
                }

                // Consistency pattern
                const gapVariation = Math.max(...orderGaps) - Math.min(...orderGaps);
                if (gapVariation < avgGap * 0.3) {
                    reasons.push(`Very consistent ordering pattern`);
                } else if (gapVariation < avgGap * 0.6) {
                    reasons.push(`Consistent ordering pattern`);
                }

                predictions.push({
                    customer: {
                        cardCode: customer.CardCode,
                        cardName: customer.CardName,
                        email: customer.Email,
                        assignedTo: customer.assignedTo
                            ? `${customer.assignedTo.firstName} ${customer.assignedTo.lastName}`
                            : null,
                    },
                    orderPattern: {
                        totalOrders: pattern.totalOrders,
                        avgDaysBetweenOrders: avgGap,
                        lastOrderDate: lastOrderDate,
                        daysSinceLastOrder,
                        avgOrderValue: parseFloat(avgOrderValue.toFixed(2)),
                    },
                    prediction: {
                        predictedNextOrderDate,
                        daysUntilPredicted,
                        daysFromTargetDate: daysFromTarget,
                        likelihood: parseFloat(likelihood.toFixed(2)),
                        urgencyScore: parseFloat(urgencyScore.toFixed(2)),
                        recommendation:
                            urgencyScore > 90
                                ? "Contact immediately - overdue"
                                : urgencyScore > 75
                                    ? "High priority - contact soon"
                                    : likelihood > 70
                                        ? "Good timing - reach out"
                                        : "Monitor for now",
                        reasons: reasons, // Array of reasons
                        primaryReason: reasons[0], // Main reason at top
                    },
                });
            }

            // Stop if we have enough high-quality predictions
            if (predictions.length > 200) break;
        }

        // Sort by urgency
        predictions.sort(
            (a, b) => b.prediction.urgencyScore - a.prediction.urgencyScore
        );

        // Categorize
        const overdueCustomers = predictions.filter(
            (p) => p.prediction.urgencyScore > 90
        );
        const highPriorityCustomers = predictions.filter(
            (p) =>
                p.prediction.urgencyScore > 75 &&
                p.prediction.urgencyScore <= 90
        );
        const potentialCustomers = predictions.filter(
            (p) =>
                p.prediction.likelihood > 70 && p.prediction.urgencyScore <= 75
        );

        return res.json({
            success: true,
            data: {
                targetDate: target,
                summary: {
                    totalPredictions: predictions.length,
                    overdueCount: overdueCustomers.length,
                    highPriorityCount: highPriorityCustomers.length,
                    potentialCount: potentialCustomers.length,
                },
                predictions: {
                    overdue: overdueCustomers.slice(0, 20),
                    highPriority: highPriorityCustomers.slice(0, 20),
                    potential: potentialCustomers.slice(0, 20),
                },
                allPredictions: predictions.slice(0, 50),
            },
        });
    } catch (error) {
        console.error("Error in predictive analysis:", error);
        return res.status(500).json({
            success: false,
            message: "Error generating predictive analysis",
            error: error.message,
        });
    }
};