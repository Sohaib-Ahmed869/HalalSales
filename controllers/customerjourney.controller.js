// controllers/customerJourney.controller.js
const Customer = require("../models/Customer");
const Invoice = require("../models/Invoice");
const Payment = require("../models/payment");
const PaymentLink = require("../models/paymentLinks");
const SalesOrder = require("../models/SalesOrder");
const Quotation = require("../models/Quotation");
const CallData = require("../models/CallData");
const Deal = require("../models/Deal");
const mongoose = require("mongoose");

const calculatePaymentTotal = (payment) => {
  return (
    (payment.CashSum || 0) +
    (payment.TransferSum || 0) +
    (payment.CheckSum || 0) +
    // Handle credit cards collection
    (payment.PaymentCreditCards?.reduce(
      (sum, card) => sum + (card.CreditSum || 0),
      0
    ) || 0) +
    // Handle checks collection
    (payment.PaymentChecks?.reduce(
      (sum, check) => sum + (check.CheckSum || 0),
      0
    ) || 0) +
    // Handle DocTotal as fallback
    (!payment.CashSum &&
      !payment.TransferSum &&
      !payment.CheckSum &&
      (!payment.PaymentCreditCards || payment.PaymentCreditCards.length === 0) &&
      (!payment.PaymentChecks || payment.PaymentChecks.length === 0)
      ? payment.DocTotal || 0
      : 0)
  );
};
const weeklyDataFormatter = {
  // Takes a week string in format "YYYY-WWW" and returns a Date object for the week's start
  getWeekStartDate: (weekStr) => {
    const match = weekStr.match(/^(\d{4})-W(\d{2})$/);
    if (!match) return null;

    const [_, year, weekNum] = match;

    // Get the first day of the year
    const firstDayOfYear = new Date(parseInt(year), 0, 1);

    // Calculate days to add to get to the start of the specified week
    // Week 1 is the week containing January 1
    const daysToAdd = (parseInt(weekNum) - 1) * 7;

    // Adjust for day of week of January 1
    const firstDayWeekday = firstDayOfYear.getDay(); // 0 = Sunday, 1 = Monday, etc.
    const adjustedDaysToAdd = daysToAdd - firstDayWeekday + 1; // +1 because we want to start from Monday

    // Create new date for the start of the week
    const weekStart = new Date(firstDayOfYear);
    weekStart.setDate(firstDayOfYear.getDate() + adjustedDaysToAdd);

    return weekStart;
  },

  // Format week as a readable string (e.g., "Jan 1-7, 2025")
  formatWeekDisplay: (weekStr) => {
    const weekStart = weeklyDataFormatter.getWeekStartDate(weekStr);
    if (!weekStart) return weekStr;

    // Calculate week end (6 days after start)
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);

    // Format dates
    const formatMonth = (date) =>
      date.toLocaleString("default", { month: "short" });
    const formatDay = (date) => date.getDate();
    const year = weekStart.getFullYear();

    // Check if week spans month boundaries
    if (weekStart.getMonth() === weekEnd.getMonth()) {
      // Same month (e.g., "Jan 1-7, 2025")
      return `${formatMonth(weekStart)} ${formatDay(weekStart)}-${formatDay(
        weekEnd
      )}, ${year}`;
    } else {
      // Different months (e.g., "Dec 29-Jan 4, 2025")
      return `${formatMonth(weekStart)} ${formatDay(weekStart)}-${formatMonth(
        weekEnd
      )} ${formatDay(weekEnd)}, ${year}`;
    }
  },

  // Generate week keys for a date range
  generateWeekKeys: (startDate, endDate) => {
    const weeks = [];
    const currentDate = new Date(startDate);
    const end = new Date(endDate);

    while (currentDate <= end) {
      // Get year and week number
      const year = currentDate.getFullYear();
      const weekNum = Math.ceil(
        ((currentDate - new Date(year, 0, 1)) / 86400000 +
          new Date(year, 0, 1).getDay() +
          1) /
        7
      );

      // Create week key
      const weekKey = `${year}-W${String(weekNum).padStart(2, "0")}`;

      // Add to list if not already present
      if (!weeks.includes(weekKey)) {
        weeks.push(weekKey);
      }

      // Move to next week
      currentDate.setDate(currentDate.getDate() + 7);
    }

    return weeks;
  },

  // Fill in missing weeks in data with zero values
  fillMissingWeeks: (data, startDate, endDate) => {
    // Get all week keys in the date range
    const allWeekKeys = weeklyDataFormatter.generateWeekKeys(
      startDate,
      endDate
    );

    // Convert data to map for easy lookup
    const dataMap = data.reduce((map, item) => {
      map[item.period] = item;
      return map;
    }, {});

    // Create complete dataset with missing weeks filled in
    const completedData = allWeekKeys.map((weekKey) => {
      if (dataMap[weekKey]) {
        return {
          ...dataMap[weekKey],
          displayName: weekKey,
          formattedDisplayName: weeklyDataFormatter.formatWeekDisplay(weekKey),
        };
      } else {
        return {
          period: weekKey,
          displayName: weekKey,
          formattedDisplayName: weeklyDataFormatter.formatWeekDisplay(weekKey),
          total: 0,
          average: 0,
          count: 0,
          invoiceCount: 0,
          invoiceAmount: 0,
          paymentCount: 0,
          paymentAmount: 0,
        };
      }
    });

    return completedData;
  },
};
// Updated calculateActivityByTimePeriod function for proper weekly display
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
        // Use a more intuitive approach for weeks
        const firstDayOfYear = new Date(year, 0, 1);
        // Get the week number (1-52/53)
        const weekNum = Math.ceil(
          ((dateObj - new Date(year, 0, 1)) / 86400000 +
            new Date(year, 0, 1).getDay() +
            1) /
          7
        );

        // Format as YYYY-Www for sorting and display consistency
        return `${year}-W${String(weekNum).padStart(2, "0")}`;

      case "monthly":
        const month = dateObj.getMonth() + 1;
        return `${year}-${String(month).padStart(2, "0")}`;

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
    const netAmount = (invoice.DocTotal || 0) - (invoice.VatSum || 0);

    if (!timeframes[key]) {
      timeframes[key] = {
        period: key,
        invoiceCount: 0,
        invoiceAmount: 0,
        invoiceAmountGross: 0, // Keep gross for reference
        paymentCount: 0,
        paymentAmount: 0,
      };
    }

    timeframes[key].invoiceCount++;
    timeframes[key].invoiceAmount += netAmount; // Net amount
    timeframes[key].invoiceAmountGross += invoice.DocTotal || 0; // Gross amount
  });

  // Process payments by time period
  payments.forEach((payment) => {
    const key = getTimeKey(payment.DocDate);
    const paymentTotal = calculatePaymentTotal(payment);

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
    const { period = "quarterly", startDate, endDate } = req.query;

    const validPeriods = ["weekly", "monthly", "quarterly", "yearly"];
    const selectedPeriod = validPeriods.includes(period) ? period : "quarterly";

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

    // Build date filter for invoices if provided
    const invoiceFilter = { CardCode: customerId };
    if (startDate && endDate) {
      invoiceFilter.DocDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    } else if (startDate) {
      invoiceFilter.DocDate = { $gte: new Date(startDate) };
    } else if (endDate) {
      invoiceFilter.DocDate = { $lte: new Date(endDate) };
    }

    // Get customer invoices ordered by date with date filter
    const invoices = await Invoice.find(invoiceFilter)
      .sort({ DocDate: 1 })
      .lean();

    // Apply the same date filter to payments
    const paymentFilter = { CardCode: customerId };
    if (startDate && endDate) {
      paymentFilter.DocDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    } else if (startDate) {
      paymentFilter.DocDate = { $gte: new Date(startDate) };
    } else if (endDate) {
      paymentFilter.DocDate = { $lte: new Date(endDate) };
    }

    const payments = await Payment.find(paymentFilter)
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

    const paymentLinksByPayment = paymentLinks.reduce((acc, link) => {
      if (!acc[link.paymentNumber]) {
        acc[link.paymentNumber] = [];
      }
      acc[link.paymentNumber].push(link);
      return acc;
    }, {});

    // Create customer journey timeline
    // Create customer journey timeline
    const timeline = [
      ...invoices.map((invoice) => {
        const netAmount = (invoice.DocTotal || 0) - (invoice.VatSum || 0);

        // Calculate total payments from PaymentLinks for this invoice
        const paymentLinksForInvoice = paymentLinks.filter(
          (link) => link.invoiceNumber === invoice.DocNum
        );
        const totalPaymentsFromLinks = paymentLinksForInvoice.reduce(
          (sum, link) => sum + (link.paymentAmount || 0),
          0
        );

        // Use the higher of PaidToDate or PaymentLinks total
        const actualPaidAmount = Math.max(
          invoice.PaidToDate || 0,
          totalPaymentsFromLinks
        );

        return {
          type: "invoice",
          date: invoice.DocDate,
          amount: netAmount, // Use net amount instead of DocTotal
          grossAmount: invoice.DocTotal, // Keep gross for reference
          vatAmount: invoice.VatSum || 0,
          docNum: invoice.DocNum,
          isPaid: actualPaidAmount >= invoice.DocTotal,
          partiallyPaid:
            actualPaidAmount > 0 && actualPaidAmount < invoice.DocTotal,
          paidAmount: actualPaidAmount,
          balance: invoice.DocTotal - actualPaidAmount,
          details: invoice,
        };
      }),
      ...payments.map((payment) => {
        // Determine the payment method
        let paymentMethod = "Unknown";
        if (payment.CashSum > 0) paymentMethod = "Cash";
        else if (payment.TransferSum > 0) paymentMethod = "Bank Transfer";
        else if (
          (payment.PaymentChecks && payment.PaymentChecks.length > 0) ||
          payment.CheckSum > 0
        )
          paymentMethod = "Check";
        else if (
          (payment.PaymentCreditCards &&
            payment.PaymentCreditCards.length > 0) ||
          payment.CreditSum > 0
        )
          paymentMethod = "Credit Card";
        else if (payment.DocTotal > 0) paymentMethod = "Other";

        // Calculate payment total
        const paymentTotal = calculatePaymentTotal(payment);

        // Get related invoices from PaymentLink collection
        const linkedInvoices = paymentLinksByPayment[payment.DocNum] || [];

        // Also get from payment document itself as fallback
        const paymentInvoices =
          payment.PaymentInvoices?.map((pi) => ({
            invoiceNumber: pi.DocEntry,
            amountApplied: pi.SumApplied,
          })) || [];

        // Combine both sources and deduplicate
        const allRelatedInvoices = [
          ...linkedInvoices.map((link) => ({
            invoiceNumber: link.invoiceNumber,
            amountApplied: link.paymentAmount,
            linkSource: "PaymentLink",
          })),
          ...paymentInvoices.map((pi) => ({
            invoiceNumber: pi.invoiceNumber,
            amountApplied: pi.amountApplied,
            linkSource: "PaymentDocument",
          })),
        ];

        // Remove duplicates based on invoice number
        const uniqueRelatedInvoices = allRelatedInvoices.reduce((acc, curr) => {
          const existing = acc.find(
            (item) => item.invoiceNumber === curr.invoiceNumber
          );
          if (!existing) {
            acc.push(curr);
          }
          return acc;
        }, []);

        return {
          type: "payment",
          date: payment.DocDate,
          amount: paymentTotal,
          docNum: payment.DocNum,
          paymentMethod: paymentMethod,
          relatedInvoices: uniqueRelatedInvoices, // Now properly populated
          details: {
            ...payment,
            paymentMethod: paymentMethod,
            calculatedTotal: paymentTotal,
          },
        };
      }),
    ].sort((a, b) => new Date(a.date) - new Date(b.date));

    //print payment were DocNum is 202487 from the timeline
    console.log(
      "Payment with DocNum 202487 in timeline:",
      timeline.filter((t) => t.docNum == 202487)
    );

    // Calculate customer journey metrics
    // Calculate total paid amount using PaymentLinks data
    const totalPaidAmountFromLinks = invoices.reduce((sum, inv) => {
      const paymentLinksForInvoice = paymentLinks.filter(
        (link) => link.invoiceNumber === inv.DocNum
      );
      const totalPaymentsFromLinks = paymentLinksForInvoice.reduce(
        (linkSum, link) => linkSum + (link.paymentAmount || 0),
        0
      );
      const actualPaidAmount = Math.max(
        inv.PaidToDate || 0,
        totalPaymentsFromLinks
      );
      return sum + actualPaidAmount;
    }, 0);

    const outstandingBalanceFromLinks = invoices.reduce((sum, inv) => {
      const paymentLinksForInvoice = paymentLinks.filter(
        (link) => link.invoiceNumber === inv.DocNum
      );
      const totalPaymentsFromLinks = paymentLinksForInvoice.reduce(
        (linkSum, link) => linkSum + (link.paymentAmount || 0),
        0
      );
      const actualPaidAmount = Math.max(
        inv.PaidToDate || 0,
        totalPaymentsFromLinks
      );
      return sum + (inv.DocTotal - actualPaidAmount);
    }, 0);

    const metrics = {
      totalInvoices: invoices.length,
      totalPayments: payments.length,
      totalInvoiceAmount: invoices.reduce(
        (sum, inv) => sum + ((inv.DocTotal || 0) - (inv.VatSum || 0)),
        0
      ),
      totalInvoiceAmountGross: invoices.reduce(
        (sum, inv) => sum + (inv.DocTotal || 0),
        0
      ), // Keep gross for reference
      totalPaidAmount: totalPaidAmountFromLinks,
      outstandingBalance: outstandingBalanceFromLinks,
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
    const activityData = calculateActivityByTimePeriod(
      invoices,
      payments,
      selectedPeriod
    );

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
    let methodsDetected = 0;

    // Check for Cash payments
    if (payment.CashSum > 0) {
      const method = "Cash";
      const amount = payment.CashSum || 0;
      methodAmounts[method] = (methodAmounts[method] || 0) + amount;
      methodCounts[method] = (methodCounts[method] || 0) + 1;
      methodsDetected++;
    }

    // Check for Bank Transfer payments
    if (payment.TransferSum > 0) {
      const method = "Bank Transfer";
      const amount = payment.TransferSum || 0;
      methodAmounts[method] = (methodAmounts[method] || 0) + amount;
      methodCounts[method] = (methodCounts[method] || 0) + 1;
      methodsDetected++;
    }

    // Check for Credit Card payments
    if (
      (payment.PaymentCreditCards && payment.PaymentCreditCards.length > 0) ||
      payment.CreditSum > 0
    ) {
      const method = "Credit Card";
      let amount = 0;
      if (payment.PaymentCreditCards) {
        amount = payment.PaymentCreditCards.reduce(
          (sum, card) => sum + (card.CreditSum || 0),
          0
        );
      } else {
        amount = payment.CreditSum || 0;
      }
      methodAmounts[method] = (methodAmounts[method] || 0) + amount;
      methodCounts[method] = (methodCounts[method] || 0) + 1;
      methodsDetected++;
    }

    // Check for Check payments
    if (
      (payment.PaymentChecks && payment.PaymentChecks.length > 0) ||
      payment.CheckSum > 0
    ) {
      const method = "Check";
      let amount = 0;
      if (payment.PaymentChecks) {
        amount = payment.PaymentChecks.reduce(
          (sum, check) => sum + (check.CheckSum || 0),
          0
        );
      } else {
        amount = payment.CheckSum || 0;
      }
      methodAmounts[method] = (methodAmounts[method] || 0) + amount;
      methodCounts[method] = (methodCounts[method] || 0) + 1;
      methodsDetected++;
    }

    // If no specific payment method was detected but DocTotal exists
    if (methodsDetected === 0 && payment.DocTotal > 0) {
      const method = "Other";
      const amount = payment.DocTotal || 0;
      methodAmounts[method] = (methodAmounts[method] || 0) + amount;
      methodCounts[method] = (methodCounts[method] || 0) + 1;
      methodsDetected++;
    }

    // Count the total number of payments detected
    totalPayments += methodsDetected;
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
  const totalNetAmount = invoices.reduce(
    (sum, inv) => sum + ((inv.DocTotal || 0) - (inv.VatSum || 0)),
    0
  );
  const averageOrderValue =
    invoices.length > 0 ? totalNetAmount / invoices.length : 0;

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
      startDate,
      endDate,
    } = req.query;

    // Convert to integers/floats
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

    // Add date range filter if provided
    if (startDate && endDate) {
      matchStage.DocDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    } else if (startDate) {
      matchStage.DocDate = { $gte: new Date(startDate) };
    } else if (endDate) {
      matchStage.DocDate = { $lte: new Date(endDate) };
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
                : (payment.PaymentCreditCards &&
                  payment.PaymentCreditCards.length > 0) ||
                  payment.CreditSum > 0
                  ? "Credit Card"
                  : (payment.PaymentChecks && payment.PaymentChecks.length > 0) ||
                    payment.CheckSum > 0
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
    // Get date filters from request
    const { startDate, endDate } = req.query;

    // Build match stage for pipeline
    const matchStage = {};

    // Add date range filter if provided
    if (startDate && endDate) {
      matchStage.DocDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    } else if (startDate) {
      matchStage.DocDate = { $gte: new Date(startDate) };
    } else if (endDate) {
      matchStage.DocDate = { $lte: new Date(endDate) };
    }

    // Build aggregation pipeline for customer journeys
    const pipeline = [];

    // Add initial match stage if we have date filters
    if (Object.keys(matchStage).length > 0) {
      pipeline.push({ $match: matchStage });
    }

    pipeline.push(
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
                  customers: {
                    $push: {
                      cardCode: "$_id",
                      customerName: "$customerName",
                      totalSpent: "$totalSpent",
                      invoiceCount: "$invoiceCount",
                      outstandingBalance: "$outstandingBalance",
                    },
                  },
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
      }
    );

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

/**
 * Fetch invoices by revenue segment
 * @param {Object} segmentParams - The segment parameters (min, max values)
 * @param {Object} filters - Additional filters such as date range
 * @returns {Promise} API response with invoices data
 */
exports.getInvoicesBySegment = async (req, res) => {
  try {
    const { minAmount, maxAmount, startDate, endDate } = req.query;

    // Build match stage for pipeline
    const matchStage = {};

    // Add date range filter if provided
    if (startDate && endDate) {
      matchStage.DocDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    } else if (startDate) {
      matchStage.DocDate = { $gte: new Date(startDate) };
    } else if (endDate) {
      matchStage.DocDate = { $lte: new Date(endDate) };
    }

    // Build aggregation pipeline
    const pipeline = [];

    // Add initial match stage if we have date filters
    if (Object.keys(matchStage).length > 0) {
      pipeline.push({ $match: matchStage });
    }

    pipeline.push(
      // Group by customer
      {
        $group: {
          _id: "$CardCode",
          customerName: { $first: "$CardName" },
          invoiceCount: { $sum: 1 },
          totalSpent: { $sum: "$DocTotal" },
          totalPaid: { $sum: "$PaidToDate" },
          firstInvoice: { $min: "$DocDate" },
          lastInvoice: { $max: "$DocDate" },
        },
      },
      // Add calculated fields
      {
        $addFields: {
          outstandingBalance: { $subtract: ["$totalSpent", "$totalPaid"] },
          averageOrderValue: { $divide: ["$totalSpent", "$invoiceCount"] },
        },
      }
    );

    // Add amount range filter for customers
    if (minAmount !== undefined && maxAmount !== undefined) {
      const maxAmountValue =
        parseFloat(maxAmount) === Infinity
          ? Number.MAX_VALUE
          : parseFloat(maxAmount);
      pipeline.push({
        $match: {
          totalSpent: {
            $gte: parseFloat(minAmount),
            $lte: maxAmountValue,
          },
        },
      });
    } else if (minAmount !== undefined) {
      pipeline.push({
        $match: { totalSpent: { $gte: parseFloat(minAmount) } },
      });
    } else if (maxAmount !== undefined && parseFloat(maxAmount) !== Infinity) {
      pipeline.push({
        $match: { totalSpent: { $lte: parseFloat(maxAmount) } },
      });
    }

    // Sort by total spent descending and limit results
    pipeline.push({ $sort: { totalSpent: -1 } }, { $limit: 100 });

    // Execute the pipeline
    const customers = await Invoice.aggregate(pipeline);

    // Calculate totals
    const totalCustomers = customers.length;
    const totalRevenue = customers.reduce(
      (sum, customer) => sum + (customer.totalSpent || 0),
      0
    );
    const totalInvoices = customers.reduce(
      (sum, customer) => sum + (customer.invoiceCount || 0),
      0
    );

    return res.status(200).json({
      success: true,
      data: {
        customers: customers.map((customer) => ({
          cardCode: customer._id,
          customerName: customer.customerName,
          invoiceCount: customer.invoiceCount,
          totalSpent: customer.totalSpent,
          totalPaid: customer.totalPaid,
          outstandingBalance: customer.outstandingBalance,
          averageOrderValue: customer.averageOrderValue,
          firstInvoice: customer.firstInvoice,
          lastInvoice: customer.lastInvoice,
        })),
        summary: {
          totalCustomers,
          totalRevenue,
          totalInvoices,
          averageSpendPerCustomer:
            totalCustomers > 0 ? totalRevenue / totalCustomers : 0,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching customers by segment:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch customers by segment",
      error: error.message,
    });
  }
};

/**
 * Get comprehensive AI summary for a specific customer
 */
exports.getCustomerAISummary = async (req, res) => {
  try {
    const { customerId } = req.params;
    const { startDate, endDate } = req.query;

    // Build date filter
    const dateFilter = {};
    if (startDate && endDate) {
      dateFilter.DocDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate)
      };
    } else if (startDate) {
      dateFilter.DocDate = { $gte: new Date(startDate) };
    } else if (endDate) {
      dateFilter.DocDate = { $lte: new Date(endDate) };
    }

    // Fetch all data in parallel from MongoDB models
    const [customer, salesOrders, quotations, invoices, payments, calls, deals] = await Promise.all([
      // Customer Details
      Customer.findOne({ CardCode: customerId }).lean(),

      // Sales Orders
      SalesOrder.find({ CardCode: customerId, ...dateFilter })
        .sort({ DocDate: -1 })
        .lean(),

      // Quotations
      Quotation.find({ CardCode: customerId, ...dateFilter })
        .sort({ DocDate: -1 })
        .lean(),

      // Invoices
      Invoice.find({ CardCode: customerId, ...dateFilter })
        .sort({ DocDate: -1 })
        .lean(),

      // Payments
      Payment.find({ CardCode: customerId, ...dateFilter })
        .sort({ DocDate: -1 })
        .lean(),

      // Calls
      CallData.find({ CardCode: customerId })
        .sort({ startTime: -1 })
        .lean(),

      // Deals
      Deal.find({ CardCode: customerId })
        .sort({ createdAt: -1 })
        .lean()
    ]);

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    // Calculate product statistics from sales orders
    const productStats = calculateProductStats(salesOrders);

    // Build comprehensive summary
    const summary = {
      customer: {
        code: customer.CardCode,
        name: customer.CardName,
        email: customer.Email,
        phone: customer.Phone,
        status: customer.status,
        assignedTo: customer.assignedTo
      },

      sales: {
        total: salesOrders.length,
        totalValue: salesOrders.reduce((sum, o) => sum + (o.DocTotal || 0), 0),
        averageValue: salesOrders.length > 0
          ? salesOrders.reduce((sum, o) => sum + (o.DocTotal || 0), 0) / salesOrders.length
          : 0,
        completed: salesOrders.filter(o => o.DocumentStatus === 'bost_Close').length,
        pending: salesOrders.filter(o => o.DocumentStatus === 'bost_Open').length,
        cancelled: salesOrders.filter(o => o.DocumentStatus === 'bost_Cancel').length,
        lastOrderDate: salesOrders[0]?.DocDate || null,
        recentOrders: salesOrders.slice(0, 5).map(o => ({
          docNum: o.DocNum,
          date: o.DocDate,
          total: o.DocTotal,
          status: o.DocumentStatus
        }))
      },

      quotations: {
        total: quotations.length,
        totalValue: quotations.reduce((sum, q) => sum + (q.DocTotal || 0), 0),
        converted: quotations.filter(q => q.DocumentStatus === 'bost_Close').length,
        pending: quotations.filter(q => q.DocumentStatus === 'bost_Open').length,
        conversionRate: quotations.length > 0
          ? ((quotations.filter(q => q.DocumentStatus === 'bost_Close').length / quotations.length) * 100).toFixed(1)
          : 0,
        recent: quotations.slice(0, 5).map(q => ({
          docNum: q.DocNum,
          date: q.DocDate,
          total: q.DocTotal,
          status: q.DocumentStatus
        }))
      },

      invoices: {
        total: invoices.length,
        totalValue: invoices.reduce((sum, i) => sum + (i.DocTotal || 0), 0),
        paid: invoices.filter(i => i.DocumentStatus === 'bost_Close').length,
        unpaid: invoices.filter(i => i.DocumentStatus === 'bost_Open').length,
        totalPaid: invoices.reduce((sum, i) => sum + (i.PaidToDate || 0), 0),
        totalUnpaid: invoices.reduce((sum, i) => sum + ((i.DocTotal || 0) - (i.PaidToDate || 0)), 0),
        overdue: invoices.filter(i =>
          i.DocumentStatus === 'bost_Open' &&
          i.DocDueDate &&
          new Date(i.DocDueDate) < new Date()
        ).length,
        averagePaymentTime: calculateAveragePaymentTime2(invoices, payments),
        recent: invoices.slice(0, 5).map(i => ({
          docNum: i.DocNum,
          date: i.DocDate,
          dueDate: i.DocDueDate,
          total: i.DocTotal,
          paid: i.PaidToDate,
          status: i.DocumentStatus
        }))
      },

      calls: {
        total: calls.length,
        totalDuration: calls.reduce((sum, c) => sum + (c.duration || 0), 0),
        averageDuration: calls.length > 0
          ? calls.reduce((sum, c) => sum + (c.duration || 0), 0) / calls.length
          : 0,
        incoming: calls.filter(c => c.direction === 'inbound').length,
        outgoing: calls.filter(c => c.direction === 'outbound').length,
        lastCallDate: calls[0]?.startTime || null,
        recent: calls.slice(0, 5).map(c => ({
          id: c._id,
          date: c.startTime,
          duration: c.duration,
          direction: c.direction,
          status: c.callStatus
        }))
      },

      deals: {
        total: deals.length,
        totalValue: deals.reduce((sum, d) => sum + (d.amount || 0), 0),
        won: deals.filter(d => d.status === 'won').length,
        lost: deals.filter(d => d.status === 'lost').length,
        active: deals.filter(d => d.status === 'active' || d.status === 'in_progress').length,
        recent: deals.slice(0, 5).map(d => ({
          id: d._id,
          title: d.title,
          amount: d.amount,
          status: d.status,
          stage: d.stage
        }))
      },

      products: {
        total: productStats.length,
        top10: productStats.slice(0, 10).map(p => ({
          code: p.ItemCode,
          name: p.ItemName,
          quantity: p.totalQuantity,
          revenue: p.totalRevenue,
          orderCount: p.orderCount,
          lastPurchased: p.lastPurchaseDate
        })),
        favorite: productStats[0] || null
      },

      engagement: {
        score: calculateEngagementScore(salesOrders, calls, quotations),
        status: determineCustomerStatus(salesOrders, calls, invoices),
        riskLevel: calculateRiskLevel(invoices, salesOrders, calls),
        lastInteraction: getLastInteractionDate(salesOrders, calls, quotations, invoices),
        lifetimeValue: invoices.reduce((sum, i) => sum + (i.PaidToDate || 0), 0),
        daysSinceLastOrder: salesOrders[0]
          ? Math.floor((new Date() - new Date(salesOrders[0].DocDate)) / (1000 * 60 * 60 * 24))
          : null
      },

      aiSummary: generateAISummaryText({
        customer,
        salesOrders,
        quotations,
        invoices,
        calls,
        deals,
        products: productStats
      }),

      insights: generateQuickInsights({
        salesOrders,
        quotations,
        invoices,
        calls,
        deals,
        products: productStats
      })
    };

    res.json({
      success: true,
      data: summary
    });

  } catch (error) {
    console.error('Error generating customer AI summary:', error);
    res.status(500).json({
      success: false,
      message: 'Error generating customer summary',
      error: error.message
    });
  }
};

// Helper Functions

function calculateProductStats(salesOrders) {
  const productMap = {};

  salesOrders.forEach(order => {
    if (order.DocumentLines) {
      order.DocumentLines.forEach(line => {
        if (!productMap[line.ItemCode]) {
          productMap[line.ItemCode] = {
            ItemCode: line.ItemCode,
            ItemName: line.ItemDescription || line.ItemName,
            totalQuantity: 0,
            totalRevenue: 0,
            orderCount: 0,
            lastPurchaseDate: order.DocDate
          };
        }

        productMap[line.ItemCode].totalQuantity += line.Quantity || 0;
        productMap[line.ItemCode].totalRevenue += line.LineTotal || 0;
        productMap[line.ItemCode].orderCount += 1;

        if (new Date(order.DocDate) > new Date(productMap[line.ItemCode].lastPurchaseDate)) {
          productMap[line.ItemCode].lastPurchaseDate = order.DocDate;
        }
      });
    }
  });

  return Object.values(productMap).sort((a, b) => b.totalRevenue - a.totalRevenue);
}

function calculateAveragePaymentTime2(invoices, payments) {
  const paidInvoices = invoices.filter(inv =>
    inv.DocumentStatus === 'bost_Close' && inv.DocDate && inv.DocDueDate
  );

  if (paidInvoices.length === 0) return null;

  const paymentTimes = paidInvoices.map(inv => {
    const dueDate = new Date(inv.DocDueDate);
    const paidDate = new Date(inv.UpdateDate || inv.DocDate);
    return Math.floor((paidDate - dueDate) / (1000 * 60 * 60 * 24));
  });

  const avgDays = paymentTimes.reduce((sum, days) => sum + days, 0) / paymentTimes.length;
  return Math.round(avgDays);
}

function calculateEngagementScore(orders, calls, quotations) {
  let score = 0;
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);

  // Recent orders (40 points max)
  const recentOrders = orders.filter(o => new Date(o.DocDate) >= ninetyDaysAgo).length;
  score += Math.min(recentOrders * 10, 40);

  // Recent calls (30 points max)
  const recentCalls = calls.filter(c => new Date(c.startTime) >= ninetyDaysAgo).length;
  score += Math.min(recentCalls * 6, 30);

  // Recent quotations (30 points max)
  const recentQuotations = quotations.filter(q => new Date(q.DocDate) >= ninetyDaysAgo).length;
  score += Math.min(recentQuotations * 10, 30);

  return Math.min(score, 100);
}

function determineCustomerStatus(orders, calls, invoices) {
  const lastOrderDate = orders[0] ? new Date(orders[0].DocDate) : null;
  const lastCallDate = calls[0] ? new Date(calls[0].startTime) : null;

  const lastInteraction = [lastOrderDate, lastCallDate]
    .filter(d => d)
    .sort((a, b) => b - a)[0];

  if (!lastInteraction) return 'Inactive';

  const daysSince = Math.floor((new Date() - lastInteraction) / (1000 * 60 * 60 * 24));

  const overdueInvoices = invoices.filter(i =>
    i.DocumentStatus === 'bost_Open' &&
    i.DocDueDate &&
    new Date(i.DocDueDate) < new Date()
  ).length;

  if (overdueInvoices > 0) return 'At Risk';
  if (daysSince < 30) return 'Active';
  if (daysSince < 90) return 'Moderate';
  if (daysSince < 180) return 'Low Activity';
  return 'Inactive';
}

function calculateRiskLevel(invoices, orders, calls) {
  let riskScore = 0;

  // Overdue invoices
  const overdueInvoices = invoices.filter(i =>
    i.DocumentStatus === 'bost_Open' &&
    i.DocDueDate &&
    new Date(i.DocDueDate) < new Date()
  );
  riskScore += overdueInvoices.length * 20;

  // No recent orders
  const daysSinceLastOrder = orders[0]
    ? Math.floor((new Date() - new Date(orders[0].DocDate)) / (1000 * 60 * 60 * 24))
    : 365;
  if (daysSinceLastOrder > 90) riskScore += 30;

  // No recent calls
  const daysSinceLastCall = calls[0]
    ? Math.floor((new Date() - new Date(calls[0].startTime)) / (1000 * 60 * 60 * 24))
    : 365;
  if (daysSinceLastCall > 90) riskScore += 20;

  if (riskScore >= 50) return 'High';
  if (riskScore >= 30) return 'Medium';
  return 'Low';
}

function getLastInteractionDate(orders, calls, quotations, invoices) {
  const dates = [
    ...orders.map(o => new Date(o.DocDate)),
    ...calls.map(c => new Date(c.startTime)),
    ...quotations.map(q => new Date(q.DocDate)),
    ...invoices.map(i => new Date(i.DocDate))
  ].filter(d => !isNaN(d));

  return dates.length > 0 ? new Date(Math.max(...dates)) : null;
}

function generateAISummaryText(data) {
  const { customer, salesOrders, quotations, invoices, calls, deals, products } = data;

  let text = `${customer.CardName} `;

  // Revenue classification
  const totalRevenue = invoices.reduce((sum, i) => sum + (i.DocTotal || 0), 0);
  if (totalRevenue > 100000) text += 'is a high-value customer ';
  else if (totalRevenue > 50000) text += 'is a mid-tier customer ';
  else if (totalRevenue > 0) text += 'is an emerging customer ';
  else text += 'is a new customer ';

  // Order activity
  if (salesOrders.length > 0) {
    text += `with ${salesOrders.length} order${salesOrders.length > 1 ? 's' : ''} totaling €${totalRevenue.toFixed(2)}. `;

    const daysSinceOrder = Math.floor((new Date() - new Date(salesOrders[0].DocDate)) / (1000 * 60 * 60 * 24));
    if (daysSinceOrder < 30) text += 'Recently active. ';
    else if (daysSinceOrder < 90) text += `Last order ${daysSinceOrder} days ago. `;
    else text += `⚠️ Inactive for ${daysSinceOrder} days - needs attention. `;
  } else {
    text += 'with no order history yet. ';
  }

  // Quotation performance
  if (quotations.length > 0) {
    const converted = quotations.filter(q => q.DocumentStatus === 'bost_Close').length;
    const rate = ((converted / quotations.length) * 100).toFixed(0);
    text += `${rate}% quotation conversion rate (${converted}/${quotations.length}). `;
  }

  // Payment behavior
  const overdue = invoices.filter(i =>
    i.DocumentStatus === 'bost_Open' &&
    i.DocDueDate &&
    new Date(i.DocDueDate) < new Date()
  ).length;

  if (overdue > 0) {
    text += `⚠️ ${overdue} overdue invoice${overdue > 1 ? 's' : ''}. `;
  } else if (invoices.length > 0) {
    text += 'Good payment history. ';
  }

  // Product preferences
  if (products.length > 0) {
    text += `Most purchased: ${products[0].ItemName} (${products[0].totalQuantity} units). `;
  }

  // Deals
  if (deals.length > 0) {
    const activeDeals = deals.filter(d => d.status === 'active' || d.status === 'in_progress').length;
    if (activeDeals > 0) {
      text += `${activeDeals} active deal${activeDeals > 1 ? 's' : ''} in pipeline. `;
    }
  }

  // Call engagement
  if (calls.length > 0) {
    text += `${calls.length} recorded interaction${calls.length > 1 ? 's' : ''}.`;
  }

  return text;
}

function generateQuickInsights(data) {
  const insights = [];
  const { salesOrders, quotations, invoices, calls, deals, products } = data;

  // Sales trend
  if (salesOrders.length >= 4) {
    const recent = salesOrders.slice(0, Math.ceil(salesOrders.length / 2));
    const older = salesOrders.slice(Math.ceil(salesOrders.length / 2));
    const recentAvg = recent.reduce((sum, o) => sum + (o.DocTotal || 0), 0) / recent.length;
    const olderAvg = older.reduce((sum, o) => sum + (o.DocTotal || 0), 0) / older.length;

    if (recentAvg > olderAvg * 1.2) {
      insights.push({ type: 'positive', text: '📈 Order values increasing' });
    } else if (recentAvg < olderAvg * 0.8) {
      insights.push({ type: 'warning', text: '📉 Order values decreasing' });
    }
  }

  // Overdue invoices
  const overdue = invoices.filter(i =>
    i.DocumentStatus === 'bost_Open' &&
    i.DocDueDate &&
    new Date(i.DocDueDate) < new Date()
  );
  if (overdue.length > 0) {
    const totalOverdue = overdue.reduce((sum, i) => sum + ((i.DocTotal || 0) - (i.PaidToDate || 0)), 0);
    insights.push({
      type: 'alert',
      text: `⚠️ ${overdue.length} overdue invoice${overdue.length > 1 ? 's' : ''} (€${totalOverdue.toFixed(2)})`
    });
  }

  // Inactivity warning
  if (salesOrders.length > 0) {
    const daysSince = Math.floor((new Date() - new Date(salesOrders[0].DocDate)) / (1000 * 60 * 60 * 24));
    if (daysSince > 90) {
      insights.push({ type: 'alert', text: '🔔 No orders in 90+ days - reach out!' });
    }
  }

  // High conversion
  if (quotations.length >= 3) {
    const converted = quotations.filter(q => q.DocumentStatus === 'bost_Close').length;
    const rate = converted / quotations.length;
    if (rate > 0.7) {
      insights.push({ type: 'positive', text: '✅ Excellent quotation conversion (>70%)' });
    } else if (rate < 0.3) {
      insights.push({ type: 'warning', text: '⚠️ Low quotation conversion (<30%)' });
    }
  }

  // Active deals
  const activeDeals = deals.filter(d => d.status === 'active' || d.status === 'in_progress');
  if (activeDeals.length > 0) {
    const totalValue = activeDeals.reduce((sum, d) => sum + (d.amount || 0), 0);
    insights.push({
      type: 'positive',
      text: `💼 ${activeDeals.length} active deal${activeDeals.length > 1 ? 's' : ''} (€${totalValue.toFixed(2)})`
    });
  }

  // Product concentration
  if (products.length > 0 && products[0].totalRevenue > 0) {
    const topProductRatio = products[0].totalRevenue / products.reduce((sum, p) => sum + p.totalRevenue, 0);
    if (topProductRatio > 0.5) {
      insights.push({
        type: 'warning',
        text: `📦 ${(topProductRatio * 100).toFixed(0)}% revenue from one product`
      });
    }
  }

  return insights;
}
module.exports = exports;
