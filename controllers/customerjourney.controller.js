// controllers/customerJourney.controller.js
const Customer = require("../models/Customer");
const Invoice = require("../models/Invoice");
const Payment = require("../models/payment");
const PaymentLink = require("../models/paymentLinks");
const mongoose = require("mongoose");
const calculateActivityByTimePeriod = (
  invoices,
  payments,
  period = "quarterly"
) => {
  const timeframes = {};

  // Define date formatter function based on period
  const getTimeKey = (date) => {
    const dateObj = new Date(date);
    const year = dateObj.getFullYear();

    switch (period) {
      case "weekly":
        // Get week number
        const firstDayOfYear = new Date(year, 0, 1);
        const pastDaysOfYear = (dateObj - firstDayOfYear) / 86400000;
        const weekNum = Math.ceil(
          (pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7
        );
        return `${year}-W${weekNum}`;

      case "monthly":
        const month = dateObj.getMonth() + 1;
        return `${year}-${month.toString().padStart(2, "0")}`;

      case "quarterly":
        const quarter = Math.floor(dateObj.getMonth() / 3) + 1;
        return `${year}-Q${quarter}`;

      case "yearly":
      default:
        return `${year}`;
    }
  };

  // Process invoices by time period
  invoices.forEach((invoice) => {
    const key = getTimeKey(invoice.DocDate);

    if (!timeframes[key]) {
      timeframes[key] = {
        period: key,
        invoiceCount: 0,
        invoiceAmount: 0,
        paymentCount: 0,
        paymentAmount: 0,
      };
    }

    timeframes[key].invoiceCount++;
    timeframes[key].invoiceAmount += invoice.DocTotal || 0;
  });

  // Process payments by time period
  payments.forEach((payment) => {
    const key = getTimeKey(payment.DocDate);
    const paymentTotal =
      (payment.CashSum || 0) +
      (payment.TransferSum || 0) +
      (payment.CheckSum || 0) +
      (payment.CreditSum || 0);

    if (!timeframes[key]) {
      timeframes[key] = {
        period: key,
        invoiceCount: 0,
        invoiceAmount: 0,
        paymentCount: 0,
        paymentAmount: 0,
      };
    }

    timeframes[key].paymentCount++;
    timeframes[key].paymentAmount += paymentTotal;
  });

  // Convert to array and sort chronologically
  return Object.values(timeframes).sort((a, b) =>
    a.period.localeCompare(b.period)
  );
};
/**
 * Get customer journey overview for a specific customer
 */
exports.getCustomerJourney = async (req, res) => {
  try {
    const { customerId } = req.params;
    const { period = 'quarterly' } = req.query; 

    const validPeriods = ['weekly', 'monthly', 'quarterly', 'yearly'];
    const selectedPeriod = validPeriods.includes(period) ? period : 'quarterly';


    // Validate customer ID
    if (!customerId) {
      return res
        .status(400)
        .json({ success: false, message: "Customer ID is required" });
    }

    // Get customer details
    const customer = await Customer.findOne({ CardCode: customerId })
      .populate("assignedTo", "firstName lastName email")
      .lean();

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    // Get customer invoices ordered by date
    const invoices = await Invoice.find({ CardCode: customerId })
      .sort({ DocDate: 1 })
      .lean();

    // Get customer payments ordered by date
    const payments = await Payment.find({ CardCode: customerId })
      .sort({ DocDate: 1 })
      .lean();

    // Get payment links for this customer's invoices and payments
    const invoiceNumbers = invoices.map((invoice) => invoice.DocNum);

    const paymentLinks = await PaymentLink.find({
      invoiceNumber: { $in: invoiceNumbers },
    }).lean();

    // Map payment links to respective invoices and payments
    const linkedPayments = paymentLinks.reduce((acc, link) => {
      if (!acc[link.invoiceNumber]) {
        acc[link.invoiceNumber] = [];
      }
      acc[link.invoiceNumber].push(link);
      return acc;
    }, {});

    // Calculate first and last interaction dates
    let firstInteraction = null;
    let lastInteraction = null;

    if (invoices.length > 0) {
      firstInteraction = invoices[0].DocDate;
      lastInteraction = invoices[invoices.length - 1].DocDate;
    }

    if (payments.length > 0) {
      const firstPaymentDate = payments[0].DocDate;
      const lastPaymentDate = payments[payments.length - 1].DocDate;

      if (!firstInteraction || firstPaymentDate < firstInteraction) {
        firstInteraction = firstPaymentDate;
      }

      if (!lastInteraction || lastPaymentDate > lastInteraction) {
        lastInteraction = lastPaymentDate;
      }
    }

    // Create customer journey timeline
    const timeline = [
      ...invoices.map((invoice) => ({
        type: "invoice",
        date: invoice.DocDate,
        amount: invoice.DocTotal,
        docNum: invoice.DocNum,
        isPaid: invoice.PaidToDate === invoice.DocTotal,
        partiallyPaid:
          invoice.PaidToDate > 0 && invoice.PaidToDate < invoice.DocTotal,
        paidAmount: invoice.PaidToDate,
        balance: invoice.DocTotal - invoice.PaidToDate,
        details: invoice,
      })),
      ...payments.map((payment) => ({
        type: "payment",
        date: payment.DocDate,
        amount: payment.DocTotal,
        docNum: payment.DocNum,
        relatedInvoices:
          payment.PaymentInvoices?.map((pi) => ({
            invoiceNumber: pi.DocEntry,
            amountApplied: pi.SumApplied,
          })) || [],
        details: payment,
      })),
    ].sort((a, b) => new Date(a.date) - new Date(b.date));

    //print payment were DocNum is 202487 from the timeline
    console.log(
      "Payment with DocNum 202487 in timeline:",
      timeline.filter((t) => t.docNum == 202487)
    );

    // Calculate customer journey metrics
    const metrics = {
      totalInvoices: invoices.length,
      totalPayments: payments.length,
      totalInvoiceAmount: invoices.reduce((sum, inv) => sum + inv.DocTotal, 0),
      totalPaidAmount: invoices.reduce((sum, inv) => sum + inv.PaidToDate, 0),
      outstandingBalance: invoices.reduce(
        (sum, inv) => sum + (inv.DocTotal - inv.PaidToDate),
        0
      ),
      averagePaymentTime: calculateAveragePaymentTime(invoices, paymentLinks),
      paymentMethods: analyzePaymentMethods(payments),
      relationshipDuration:
        firstInteraction && lastInteraction
          ? Math.ceil(
              (new Date(lastInteraction) - new Date(firstInteraction)) /
                (1000 * 60 * 60 * 24)
            )
          : 0,
      firstInteractionDate: firstInteraction,
      lastInteractionDate: lastInteraction,
      paymentPatterns: analyzePaymentPatterns(invoices, paymentLinks),
    };

    // Calculate quarterly activity
    const activityData = calculateActivityByTimePeriod(invoices, payments, selectedPeriod);


    // Identify purchase patterns
    const purchasePatterns = identifyPurchasePatterns(invoices);

    return res.status(200).json({
      success: true,
      data: {
        customer,
        journey: {
          timeline,
          metrics,
          activityData,
          purchasePatterns,
          linkedPayments,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching customer journey:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch customer journey",
      error: error.message,
    });
  }
};

/**
 * Calculate average time between invoice creation and payment
 */
const calculateAveragePaymentTime = (invoices, paymentLinks) => {
  if (!paymentLinks || paymentLinks.length === 0) return null;

  const paymentTimes = paymentLinks.map((link) => {
    return Math.floor(
      (new Date(link.paymentDate) - new Date(link.invoiceDate)) /
        (1000 * 60 * 60 * 24)
    );
  });

  // Filter out negative values or anomalies
  const validPaymentTimes = paymentTimes.filter(
    (time) => time >= 0 && time < 365
  );

  if (validPaymentTimes.length === 0) return null;

  const avgDays =
    validPaymentTimes.reduce((sum, time) => sum + time, 0) /
    validPaymentTimes.length;
  return Math.round(avgDays);
};

/**
 * Analyze payment methods used by customer
 */
const analyzePaymentMethods = (payments) => {
  const methodCounts = {};
  const methodAmounts = {};
  let totalPayments = 0;

  payments.forEach((payment) => {
    // Detect payment method
    let method = "Unknown";

    if (payment.CashSum > 0) {
      method = "Cash";
      const amount = payment.CashSum || 0;
      methodAmounts[method] = (methodAmounts[method] || 0) + amount;
      methodCounts[method] = (methodCounts[method] || 0) + 1;
      totalPayments++;
    }

    if (payment.TransferSum > 0) {
      method = "Bank Transfer";
      const amount = payment.TransferSum || 0;
      methodAmounts[method] = (methodAmounts[method] || 0) + amount;
      methodCounts[method] = (methodCounts[method] || 0) + 1;
      totalPayments++;
    }

    if (payment.PaymentCreditCards && payment.PaymentCreditCards.length > 0) {
      method = "Credit Card";
      const amount = payment.PaymentCreditCards.reduce(
        (sum, card) => sum + (card.CreditSum || 0),
        0
      );
      methodAmounts[method] = (methodAmounts[method] || 0) + amount;
      methodCounts[method] = (methodCounts[method] || 0) + 1;
      totalPayments++;
    }

    if (payment.PaymentChecks && payment.PaymentChecks.length > 0) {
      method = "Check";
      const amount = payment.PaymentChecks.reduce(
        (sum, check) => sum + (check.CheckSum || 0),
        0
      );
      methodAmounts[method] = (methodAmounts[method] || 0) + amount;
      methodCounts[method] = (methodCounts[method] || 0) + 1;
      totalPayments++;
    }
  });

  // Calculate percentages
  const methods = Object.keys(methodCounts).map((method) => ({
    method,
    count: methodCounts[method],
    amount: methodAmounts[method],
    percentage:
      totalPayments > 0
        ? ((methodCounts[method] / totalPayments) * 100).toFixed(2)
        : 0,
  }));

  return methods;
};

/**
 * Analyze payment patterns (early, on-time, late)
 */
const analyzePaymentPatterns = (invoices, paymentLinks) => {
  if (!paymentLinks || paymentLinks.length === 0) {
    return {
      earlyPayments: 0,
      onTimePayments: 0,
      latePayments: 0,
    };
  }

  let earlyPayments = 0;
  let onTimePayments = 0;
  let latePayments = 0;

  paymentLinks.forEach((link) => {
    // Calculate days to payment
    const invoiceDate = new Date(link.invoiceDate);
    const paymentDate = new Date(link.paymentDate);
    const daysToPayment = Math.floor(
      (paymentDate - invoiceDate) / (1000 * 60 * 60 * 24)
    );

    // Standard terms: 30 days
    const standardTerms = 30;

    if (daysToPayment <= 0) {
      // Same day payment
      earlyPayments++;
    } else if (daysToPayment < standardTerms * 0.8) {
      // Early payment (within 80% of term)
      earlyPayments++;
    } else if (daysToPayment <= standardTerms) {
      // On time (within term)
      onTimePayments++;
    } else {
      // Late payment
      latePayments++;
    }
  });

  const totalAnalyzed = earlyPayments + onTimePayments + latePayments;

  return {
    earlyPayments,
    onTimePayments,
    latePayments,
    earlyPercentage:
      totalAnalyzed > 0
        ? ((earlyPayments / totalAnalyzed) * 100).toFixed(2)
        : 0,
    onTimePercentage:
      totalAnalyzed > 0
        ? ((onTimePayments / totalAnalyzed) * 100).toFixed(2)
        : 0,
    latePercentage:
      totalAnalyzed > 0 ? ((latePayments / totalAnalyzed) * 100).toFixed(2) : 0,
  };
};

/**
 * Calculate quarterly activity
 */
const calculateQuarterlyActivity = (invoices, payments) => {
  const quarters = {};

  // Process invoices by quarter
  invoices.forEach((invoice) => {
    const date = new Date(invoice.DocDate);
    const year = date.getFullYear();
    const quarter = Math.floor(date.getMonth() / 3) + 1;
    const key = `${year}-Q${quarter}`;

    if (!quarters[key]) {
      quarters[key] = {
        year,
        quarter,
        invoiceCount: 0,
        invoiceAmount: 0,
        paymentCount: 0,
        paymentAmount: 0,
      };
    }

    quarters[key].invoiceCount++;
    quarters[key].invoiceAmount += invoice.DocTotal || 0;
  });

  // Process payments by quarter
  payments.forEach((payment) => {
    const date = new Date(payment.DocDate);
    const year = date.getFullYear();
    const quarter = Math.floor(date.getMonth() / 3) + 1;
    const key = `${year}-Q${quarter}`;
    const paymentTotal =
      (payment.CashSum || 0) +
      (payment.TransferSum || 0) +
      (payment.CheckSum || 0) +
      (payment.CreditSum || 0);

    if (!quarters[key]) {
      quarters[key] = {
        year,
        quarter,
        invoiceCount: 0,
        invoiceAmount: 0,
        paymentCount: 0,
        paymentAmount: 0,
      };
    }

    quarters[key].paymentCount++;
    quarters[key].paymentAmount += paymentTotal;
  });

  // Convert to array and sort by year/quarter
  return Object.values(quarters).sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.quarter - b.quarter;
  });
};

/**
 * Identify purchase patterns
 */
const identifyPurchasePatterns = (invoices) => {
  if (!invoices || invoices.length === 0) {
    return {
      frequency: null,
      averageOrderValue: 0,
      seasonalTrends: [],
    };
  }

  // Calculate days between invoices
  const daysBetweenInvoices = [];
  for (let i = 1; i < invoices.length; i++) {
    const currentDate = new Date(invoices[i].DocDate);
    const prevDate = new Date(invoices[i - 1].DocDate);
    const days = Math.floor((currentDate - prevDate) / (1000 * 60 * 60 * 24));
    if (days > 0) {
      daysBetweenInvoices.push(days);
    }
  }

  // Calculate average order frequency in days
  let averageFrequency = null;
  if (daysBetweenInvoices.length > 0) {
    averageFrequency = Math.round(
      daysBetweenInvoices.reduce((sum, days) => sum + days, 0) /
        daysBetweenInvoices.length
    );
  }

  // Calculate average order value
  const averageOrderValue =
    invoices.length > 0
      ? invoices.reduce((sum, inv) => sum + inv.DocTotal, 0) / invoices.length
      : 0;

  // Analyze seasonal trends by month
  const monthlyTotals = {};
  invoices.forEach((invoice) => {
    const date = new Date(invoice.DocDate);
    const month = date.getMonth(); // 0-11

    if (!monthlyTotals[month]) {
      monthlyTotals[month] = {
        count: 0,
        total: 0,
      };
    }

    monthlyTotals[month].count++;
    monthlyTotals[month].total += invoice.DocTotal || 0;
  });

  // Convert to array of months
  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  const seasonalTrends = [];
  for (let i = 0; i < 12; i++) {
    seasonalTrends.push({
      month: monthNames[i],
      count: monthlyTotals[i]?.count || 0,
      total: monthlyTotals[i]?.total || 0,
      average:
        monthlyTotals[i]?.count > 0
          ? monthlyTotals[i].total / monthlyTotals[i].count
          : 0,
    });
  }

  return {
    frequency: averageFrequency,
    averageOrderValue,
    seasonalTrends,
  };
};

/**
 * Get customer journey summary for all customers
 */
exports.getCustomerJourneySummary = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      sortBy = "totalSpent",
      sortOrder = -1,
      minInvoiceCount,
      minAmount,
      search,
    } = req.query;

    const pageInt = parseInt(page);
    const limitInt = parseInt(limit);
    const skip = (pageInt - 1) * limitInt;

    // Initial match stage - apply at beginning for better index usage
    const matchStage = {};

    if (search) {
      matchStage.$or = [
        { CardCode: new RegExp(search, "i") },
        { CardName: new RegExp(search, "i") },
      ];
    }

    // Build main pipeline to get customer data
    const pipeline = [];

    // Add initial match stage if filters are provided
    if (Object.keys(matchStage).length > 0) {
      pipeline.push({ $match: matchStage });
    }

    // Group by customer - don't store entire invoice documents
    pipeline.push({
      $group: {
        _id: "$CardCode",
        customerName: { $first: "$CardName" },
        firstInvoice: { $min: "$DocDate" },
        lastInvoice: { $max: "$DocDate" },
        invoiceCount: { $sum: 1 },
        totalSpent: { $sum: "$DocTotal" },
        totalPaid: { $sum: "$PaidToDate" },
        // Removed the large invoices array
      },
    });

    // Add filtering stages
    if (minInvoiceCount) {
      pipeline.push({
        $match: { invoiceCount: { $gte: parseInt(minInvoiceCount) } },
      });
    }

    if (minAmount) {
      pipeline.push({
        $match: { totalSpent: { $gte: parseFloat(minAmount) } },
      });
    }

    // Add derived fields
    pipeline.push({
      $addFields: {
        outstandingBalance: { $subtract: ["$totalSpent", "$totalPaid"] },
        daysSinceFirstInvoice: {
          $divide: [
            { $subtract: [new Date(), "$firstInvoice"] },
            1000 * 60 * 60 * 24,
          ],
        },
        daysSinceLastInvoice: {
          $divide: [
            { $subtract: [new Date(), "$lastInvoice"] },
            1000 * 60 * 60 * 24,
          ],
        },
        averageOrderValue: { $divide: ["$totalSpent", "$invoiceCount"] },
      },
    });

    // Use facet to handle count and pagination in a single query
    pipeline.push({
      $facet: {
        totalCount: [{ $count: "count" }],
        paginatedResults: [
          { $sort: { [sortBy]: parseInt(sortOrder) } },
          { $skip: skip },
          { $limit: limitInt },
        ],
      },
    });

    // Execute the single pipeline
    const [result] = await Invoice.aggregate(pipeline);

    const totalCount =
      result.totalCount.length > 0 ? result.totalCount[0].count : 0;
    const customersData = result.paginatedResults;

    // Get unique customer IDs for payment data
    const cardCodes = customersData.map((c) => c._id);

    // Only fetch payment data if we have customers
    const paymentData =
      cardCodes.length > 0
        ? await Payment.aggregate([
            { $match: { CardCode: { $in: cardCodes } } },
            {
              $group: {
                _id: "$CardCode",
                paymentCount: { $sum: 1 },
                firstPayment: { $min: "$DocDate" },
                lastPayment: { $max: "$DocDate" },
              },
            },
          ])
        : [];

    // Convert payment data to a map for easier access
    const paymentDataMap = paymentData.reduce((map, item) => {
      map[item._id] = item;
      return map;
    }, {});

    // Enrich customer data with payment information
    const enrichedCustomerData = customersData.map((customer) => {
      const payments = paymentDataMap[customer._id] || { paymentCount: 0 };

      // Calculate customer journey metrics
      const daysSinceLastActivity = Math.min(
        customer.daysSinceLastInvoice,
        payments.lastPayment
          ? Math.floor(
              (new Date() - new Date(payments.lastPayment)) /
                (1000 * 60 * 60 * 24)
            )
          : Infinity
      );

      // Define lifecycle based on activity
      let lifecycle = "Unknown";
      if (daysSinceLastActivity <= 30) {
        lifecycle = "Active";
      } else if (daysSinceLastActivity <= 90) {
        lifecycle = "Recent";
      } else if (daysSinceLastActivity <= 180) {
        lifecycle = "Lapsed";
      } else {
        lifecycle = "Inactive";
      }

      // Determine payment pattern
      let paymentPattern = "Unknown";
      if (customer.outstandingBalance <= 0) {
        paymentPattern = "Fully Paid";
      } else if (customer.totalPaid > 0) {
        const paymentRatio = customer.totalPaid / customer.totalSpent;
        if (paymentRatio >= 0.8) {
          paymentPattern = "Good Payer";
        } else if (paymentRatio >= 0.5) {
          paymentPattern = "Partial Payer";
        } else {
          paymentPattern = "Slow Payer";
        }
      } else {
        paymentPattern = "No Payments";
      }

      return {
        cardCode: customer._id,
        customerName: customer.customerName,
        invoiceCount: customer.invoiceCount,
        paymentCount: payments.paymentCount || 0,
        firstInteraction:
          customer.firstInvoice < (payments.firstPayment || Infinity)
            ? customer.firstInvoice
            : payments.firstPayment,
        lastInteraction:
          customer.lastInvoice > (payments.lastPayment || 0)
            ? customer.lastInvoice
            : payments.lastPayment,
        totalSpent: customer.totalSpent,
        totalPaid: customer.totalPaid,
        outstandingBalance: customer.outstandingBalance,
        averageOrderValue: customer.averageOrderValue,
        lifecycle,
        paymentPattern,
        daysSinceLastActivity,
        relationshipDuration: Math.ceil(
          (new Date() - new Date(customer.firstInvoice)) / (1000 * 60 * 60 * 24)
        ),
        hasRecentActivity: daysSinceLastActivity <= 90,
      };
    });

    // Calculate distributions efficiently
    const lifecycleDistribution = {
      Active: 0,
      Recent: 0,
      Lapsed: 0,
      Inactive: 0,
    };

    const paymentPatternDistribution = {
      "Fully Paid": 0,
      "Good Payer": 0,
      "Partial Payer": 0,
      "Slow Payer": 0,
      "No Payments": 0,
    };

    enrichedCustomerData.forEach((customer) => {
      if (customer.lifecycle in lifecycleDistribution) {
        lifecycleDistribution[customer.lifecycle]++;
      }
      if (customer.paymentPattern in paymentPatternDistribution) {
        paymentPatternDistribution[customer.paymentPattern]++;
      }
    });

    return res.status(200).json({
      success: true,
      data: {
        customers: enrichedCustomerData,
        lifecycleDistribution,
        paymentPatternDistribution,
        pagination: {
          totalCount,
          totalPages: Math.ceil(totalCount / limitInt),
          currentPage: pageInt,
          pageSize: limitInt,
          hasNext: pageInt < Math.ceil(totalCount / limitInt),
          hasPrevious: pageInt > 1,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching customer journey summary:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch customer journey summary",
      error: error.message,
    });
  }
};

/**
 * Get customer interaction timeline
 */
exports.getCustomerInteractionTimeline = async (req, res) => {
  try {
    const { customerId } = req.params;

    // Validate customer ID
    if (!customerId) {
      return res
        .status(400)
        .json({ success: false, message: "Customer ID is required" });
    }

    // Get all invoices for this customer
    const invoices = await Invoice.find({ CardCode: customerId })
      .sort({ DocDate: 1 })
      .lean();

    // Get all payments for this customer
    const payments = await Payment.find({ CardCode: customerId })
      .sort({ DocDate: 1 })
      .lean();

    // Get payment links
    const invoiceNumbers = invoices.map((invoice) => invoice.DocNum);
    const paymentLinks = await PaymentLink.find({
      invoiceNumber: { $in: invoiceNumbers },
    }).lean();

    // Create detailed timeline with all interactions
    const timeline = [
      // Invoice events
      ...invoices.map((invoice) => ({
        type: "invoice_created",
        date: invoice.DocDate,
        docNum: invoice.DocNum,
        amount: invoice.DocTotal,
        details: {
          invoiceNumber: invoice.DocNum,
          invoiceTotal: invoice.DocTotal,
          paidToDate: invoice.PaidToDate,
        },
      })),

      // Payment events
      ...payments.map((payment) => ({
        type: "payment_made",
        date: payment.DocDate,
        docNum: payment.DocNum,
        amount: payment.DocTotal,
        details: {
          paymentNumber: payment.DocNum,
          paymentMethod:
            payment.CashSum > 0
              ? "Cash"
              : payment.TransferSum > 0
              ? "Bank Transfer"
              : payment.PaymentCreditCards?.length > 0
              ? "Credit Card"
              : payment.PaymentChecks?.length > 0
              ? "Check"
              : "Unknown",
          relatedInvoices:
            payment.PaymentInvoices?.map((pi) => ({
              invoiceNumber: pi.DocEntry,
              amountApplied: pi.SumApplied,
            })) || [],
        },
      })),

      // Invoice payment link events
      ...paymentLinks.map((link) => ({
        type: "invoice_payment",
        date: link.paymentDate,
        docNum: `${link.invoiceNumber}-${link.paymentNumber}`,
        amount: link.paymentAmount,
        details: {
          invoiceNumber: link.invoiceNumber,
          paymentNumber: link.paymentNumber,
          invoiceAmount: link.invoiceAmount,
          paymentAmount: link.paymentAmount,
          invoiceDate: link.invoiceDate,
          daysToPayment: Math.floor(
            (new Date(link.paymentDate) - new Date(link.invoiceDate)) /
              (1000 * 60 * 60 * 24)
          ),
        },
      })),
    ]
      // Sort all events chronologically
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    // Calculate interaction frequency
    const interactionDays = [];
    for (let i = 1; i < timeline.length; i++) {
      const daysBetween = Math.floor(
        (new Date(timeline[i].date) - new Date(timeline[i - 1].date)) /
          (1000 * 60 * 60 * 24)
      );
      if (daysBetween > 0) {
        interactionDays.push(daysBetween);
      }
    }

    const averageInteractionFrequency =
      interactionDays.length > 0
        ? Math.round(
            interactionDays.reduce((sum, days) => sum + days, 0) /
              interactionDays.length
          )
        : null;

    return res.status(200).json({
      success: true,
      data: {
        timeline,
        metrics: {
          totalInteractions: timeline.length,
          firstInteraction: timeline.length > 0 ? timeline[0].date : null,
          lastInteraction:
            timeline.length > 0 ? timeline[timeline.length - 1].date : null,
          averageInteractionFrequency,
          invoiceCount: invoices.length,
          paymentCount: payments.length,
          paymentLinkCount: paymentLinks.length,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching customer interaction timeline:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch customer interaction timeline",
      error: error.message,
    });
  }
};

/**
 * Get global customer journey analytics
 */
exports.getCustomerJourneyAnalytics = async (req, res) => {
  try {
    // Build aggregation pipeline for customer journeys
    const pipeline = [
      // Group invoices by customer
      {
        $group: {
          _id: "$CardCode",
          customerName: { $first: "$CardName" },
          firstInvoice: { $min: "$DocDate" },
          lastInvoice: { $max: "$DocDate" },
          invoiceCount: { $sum: 1 },
          totalSpent: { $sum: "$DocTotal" },
          totalPaid: { $sum: "$PaidToDate" },
        },
      },
      // Add calculated fields
      {
        $addFields: {
          outstandingBalance: { $subtract: ["$totalSpent", "$totalPaid"] },
          daysSinceLastInvoice: {
            $divide: [
              { $subtract: [new Date(), "$lastInvoice"] },
              1000 * 60 * 60 * 24,
            ],
          },
          relationshipDuration: {
            $divide: [
              { $subtract: ["$lastInvoice", "$firstInvoice"] },
              1000 * 60 * 60 * 24,
            ],
          },
          paymentRatio: {
            $cond: [
              { $eq: ["$totalSpent", 0] },
              0,
              { $divide: ["$totalPaid", "$totalSpent"] },
            ],
          },
        },
      },
      // Define customer lifecycle based on activity
      {
        $addFields: {
          lifecycle: {
            $cond: [
              { $lte: ["$daysSinceLastInvoice", 30] },
              "Active",
              {
                $cond: [
                  { $lte: ["$daysSinceLastInvoice", 90] },
                  "Recent",
                  {
                    $cond: [
                      { $lte: ["$daysSinceLastInvoice", 180] },
                      "Lapsed",
                      "Inactive",
                    ],
                  },
                ],
              },
            ],
          },
          // Define payment pattern
          paymentPattern: {
            $cond: [
              { $lte: ["$outstandingBalance", 0] },
              "Fully Paid",
              {
                $cond: [
                  { $gte: ["$paymentRatio", 0.8] },
                  "Good Payer",
                  {
                    $cond: [
                      { $gte: ["$paymentRatio", 0.5] },
                      "Partial Payer",
                      {
                        $cond: [
                          { $gt: ["$paymentRatio", 0] },
                          "Slow Payer",
                          "No Payments",
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
      // Facet to compute various stats
      {
        $facet: {
          // Lifecycle distribution
          lifecycleStats: [
            {
              $group: {
                _id: "$lifecycle",
                count: { $sum: 1 },
                totalRevenue: { $sum: "$totalSpent" },
                averageOrderValue: {
                  $avg: { $divide: ["$totalSpent", "$invoiceCount"] },
                },
              },
            },
          ],

          // Payment pattern distribution
          paymentPatternStats: [
            {
              $group: {
                _id: "$paymentPattern",
                count: { $sum: 1 },
                totalRevenue: { $sum: "$totalSpent" },
                totalOutstanding: { $sum: "$outstandingBalance" },
              },
            },
          ],

          // Customer value segments
          valueSegments: [
            {
              $bucket: {
                groupBy: "$totalSpent",
                boundaries: [
                  0,
                  1000,
                  5000,
                  10000,
                  50000,
                  100000,
                  Number.MAX_VALUE,
                ],
                default: "Unknown",
                output: {
                  count: { $sum: 1 },
                  totalRevenue: { $sum: "$totalSpent" },
                  averageRevenue: { $avg: "$totalSpent" },
                },
              },
            },
          ],

          // Relationship duration segments
          durationSegments: [
            {
              $bucket: {
                groupBy: "$relationshipDuration",
                boundaries: [0, 30, 90, 180, 365, 730, Number.MAX_VALUE],
                default: "Unknown",
                output: {
                  count: { $sum: 1 },
                  totalRevenue: { $sum: "$totalSpent" },
                  averageRevenue: { $avg: "$totalSpent" },
                },
              },
            },
          ],

          // Overall customer stats
          overallStats: [
            {
              $group: {
                _id: null,
                totalCustomers: { $sum: 1 },
                totalRevenue: { $sum: "$totalSpent" },
                totalOutstanding: { $sum: "$outstandingBalance" },
                averageRelationshipDuration: { $avg: "$relationshipDuration" },
                averageOrdersPerCustomer: { $avg: "$invoiceCount" },

                averageSpendPerCustomer: { $avg: "$totalSpent" },
              },
            },
          ],

          // Top customer insights
          topCustomers: [
            { $sort: { totalSpent: -1 } },
            { $limit: 10 },
            {
              $project: {
                _id: 1,
                customerName: 1,
                totalSpent: 1,
                invoiceCount: 1,
                paymentRatio: 1,
                lifecycle: 1,
                paymentPattern: 1,
              },
            },
          ],
        },
      },
    ];

    const results = await Invoice.aggregate(pipeline);

    // Format the results for the API response
    const formattedData = {
      overallStats: results[0].overallStats[0] || {
        totalCustomers: 0,
        totalRevenue: 0,
        totalOutstanding: 0,
        averageRelationshipDuration: 0,
        averageOrdersPerCustomer: 0,
        averageSpendPerCustomer: 0,
        activeCustomerPercentage: 0,
      },

      // Format lifecycle distribution
      lifecycleDistribution: results[0].lifecycleStats.map((item) => ({
        segment: item._id,
        count: item.count,
        percentage: results[0].overallStats[0]
          ? (
              (item.count / results[0].overallStats[0].totalCustomers) *
              100
            ).toFixed(2)
          : 0,
        totalRevenue: item.totalRevenue,
        averageOrderValue: item.averageOrderValue,
      })),

      // Format payment pattern distribution
      paymentPatternDistribution: results[0].paymentPatternStats.map(
        (item) => ({
          segment: item._id,
          count: item.count,
          percentage: results[0].overallStats[0]
            ? (
                (item.count / results[0].overallStats[0].totalCustomers) *
                100
              ).toFixed(2)
            : 0,
          totalRevenue: item.totalRevenue,
          totalOutstanding: item.totalOutstanding,
        })
      ),

      // Format value segments
      valueSegments: results[0].valueSegments.map((item) => {
        let segmentName;
        if (item._id === 0) segmentName = "$0";
        else if (item._id === 1000) segmentName = "$1-1,000";
        else if (item._id === 5000) segmentName = "$1,001-5,000";
        else if (item._id === 10000) segmentName = "$5,001-10,000";
        else if (item._id === 50000) segmentName = "$10,001-50,000";
        else if (item._id === 100000) segmentName = "$50,001-100,000";
        else segmentName = "$100,001+";

        return {
          segment: segmentName,
          count: item.count,
          percentage: results[0].overallStats[0]
            ? (
                (item.count / results[0].overallStats[0].totalCustomers) *
                100
              ).toFixed(2)
            : 0,
          totalRevenue: item.totalRevenue,
          averageRevenue: item.averageRevenue,
        };
      }),

      // Format duration segments
      durationSegments: results[0].durationSegments.map((item) => {
        let segmentName;
        if (item._id === 0) segmentName = "0-30 days";
        else if (item._id === 30) segmentName = "31-90 days";
        else if (item._id === 90) segmentName = "91-180 days";
        else if (item._id === 180) segmentName = "181-365 days";
        else if (item._id === 365) segmentName = "1-2 years";
        else segmentName = "2+ years";

        return {
          segment: segmentName,
          count: item.count,
          percentage: results[0].overallStats[0]
            ? (
                (item.count / results[0].overallStats[0].totalCustomers) *
                100
              ).toFixed(2)
            : 0,
          totalRevenue: item.totalRevenue,
          averageRevenue: item.averageRevenue,
        };
      }),

      // Include top customers
      topCustomers: results[0].topCustomers,
    };

    return res.status(200).json({
      success: true,
      data: formattedData,
    });
  } catch (error) {
    console.error("Error fetching customer journey analytics:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch customer journey analytics",
      error: error.message,
    });
  }
};

module.exports = exports;
