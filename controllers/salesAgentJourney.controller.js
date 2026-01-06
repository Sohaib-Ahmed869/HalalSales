// controllers/salesAgentJourney.controller.js
const User = require("../models/User");
const Customer = require("../models/Customer");
const SalesOrder = require("../models/SalesOrder");
const CallData = require("../models/CallData");
const Invoice = require("../models/Invoice");
const Quotation = require("../models/Quotation");
const DeskTime = require("../models/desktime.model");
const CustomerTarget = require("../models/CustomerTarget");
const mongoose = require("mongoose");

/**
 * Comprehensive controller to fetch all data related to a sales agent's journey
 * Provides a holistic view of their customers, calls, sales, and productivity
 */
const salesAgentJourneyController = {
  /**
   * Get complete sales agent dashboard with all metrics
   */
  getDashboard: async (req, res) => {
    try {
      const { agentId } = req.params;
      const { startDate, endDate } = req.query;

      // Set default date range if not provided (last 30 days)
      const end = endDate ? new Date(endDate) : new Date();
      const start = startDate
        ? new Date(startDate)
        : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

      // Find the sales agent
      const agent = await User.findById(agentId)
        .populate("manager", "firstName lastName email")
        .lean();

      if (!agent || agent.role !== "sales_agent") {
        return res.status(404).json({
          success: false,
          message: "Sales agent not found",
        });
      }

      const customers = await Customer.find({ assignedTo: agentId }).lean();
      let customerCodes = customers.map((c) => c.CardCode);
      console.log(`📊 Found ${customers.length} customers for agent ${agentId}`);

      //only keep active customers for client average calculation where cardcode starts with C
      customerCodes = customers
        .filter((c) => c.status === "active" && /^C\d+/i.test(c.CardCode))
        .map((c) => c.CardCode);

      console.log(start, end);
      let customerTargets = await CustomerTarget.find({
        salesAgent: agentId,
        cardCode: { $in: customerCodes },
      }).lean();

      //for one customer, keep one customer target (latest)
      const uniqueTargetsMap = {};
      customerTargets.forEach((target) => {
        if (
          !uniqueTargetsMap[target.cardCode] ||
          new Date(target.startDate) > new Date(uniqueTargetsMap[target.cardCode].startDate)
        ) {
          uniqueTargetsMap[target.cardCode] = target;
        }
      });

      customerTargets = Object.values(uniqueTargetsMap);



      const totalClientAverages = customerTargets.reduce((sum, target) => {
        return sum + (target.clientExistingAverage || 0);
      }, 0);

      // Get all metrics in parallel for better performance
      const [callData, desktimeData, targetProgress] = await Promise.all([
        // Get call data
        CallData.find({
          startTime: { $gte: start, $lte: end },
          $or: [{ fromNumber: agent.phone }, { toNumber: agent.phone }],
        })
          .sort({ startTime: -1 })
          .lean(),

        // Get productivity data
        DeskTime.find({
          email: agent.email,
          date: { $gte: start, $lte: end },
        })
          .sort({ date: -1 })
          .lean(),

        // Calculate current period target achievement
        getAgentCurrentTargetProgress(agent),
      ]);

      const [invoices, salesOrders, creditNotes] = await Promise.all([
        // Get invoices for assigned customers
        customerCodes.length > 0
          ? Invoice.find({
            CardCode: { $in: customerCodes },
            DocDate: { $gte: start, $lte: end },
          }).lean()
          : [],

        // Get sales orders for assigned customers
        customerCodes.length > 0
          ? SalesOrder.find({
            CardCode: { $in: customerCodes },
            DocDate: { $gte: start, $lte: end },
          }).lean()
          : [],

        // Get credit notes for assigned customers
        customerCodes.length > 0
          ? require("../models/CreditNotes").find({
            CardCode: { $in: customerCodes },
            DocDate: { $gte: start, $lte: end },
          }).lean()
          : [],
      ]);

      const totalSales = invoices.reduce(
        (sum, invoice) => sum + (invoice.DocTotal || 0),
        0
      );

      // ✅ STEP 1: Calculate invoice total WITHOUT VAT (simple method)
      const invoiceTotal = invoices.reduce((sum, invoice) => {
        // Use VatSum directly from SAP (most reliable)
        const docTotal = invoice.DocTotal || 0;
        const vatSum = invoice.VatSum || 0;
        return sum + (docTotal - vatSum);
      }, 0);

      // ✅ STEP 2: Calculate credit note total WITHOUT VAT (simple method)
      const creditNoteTotal = creditNotes.reduce((sum, creditNote) => {
        // Use VatSum directly from SAP (most reliable)
        const docTotal = creditNote.DocTotal || 0;
        const vatSum = creditNote.VatSum || 0;
        return sum + (docTotal - vatSum);
      }, 0);

      // ✅ STEP 3: Calculate NET total sales (invoices - credit notes)
      const netTotalSales = invoiceTotal - creditNoteTotal;

      // ✅ STEP 4: Calculate commission eligible sales
      const commissionEligibleSales = netTotalSales - totalClientAverages;

      // 🔍 DEBUG LOGGING (remove after fixing)
      console.log("💰 Sales Calculation:");
      console.log("  Invoices:", invoices.length, "| Total (excl VAT):", invoiceTotal.toFixed(2));
      console.log("  Credit Notes:", creditNotes.length, "| Total (excl VAT):", creditNoteTotal.toFixed(2));
      console.log("  Net Sales:", netTotalSales.toFixed(2));
      console.log("  Client Averages:", totalClientAverages.toFixed(2));
      console.log("  Commission Eligible:", commissionEligibleSales.toFixed(2));
      // Calculate attendance metrics (4+ hours = half day, 7+ hours = full day)
      let totalWorkingDays = 0;
      let totalFullDays = 0;
      let totalHalfDays = 0;
      let totalAbsentDays = 0;

      // Get working days in the date range (Monday to Friday)
      const current = new Date(start);
      while (current <= end) {
        const dayOfWeek = current.getDay();
        if (dayOfWeek >= 1 && dayOfWeek <= 5) {
          totalWorkingDays++;

          // Find corresponding desktime record
          const dayKey = current.toISOString().split("T")[0];
          const desktimeRecord = desktimeData.find(
            (record) => record.date.toISOString().split("T")[0] === dayKey
          );

          const hoursWorked = desktimeRecord
            ? desktimeRecord.totalDeskTimeHours || 0
            : 0;

          if (hoursWorked >= 7) {
            totalFullDays++;
          } else if (hoursWorked >= 4) {
            totalHalfDays++;
          } else {
            totalAbsentDays++;
          }
        }
        current.setDate(current.getDate() + 1);
      }

      // Calculate summary metrics using the same invoice data
      // Calculate summary metrics using invoices without VAT
      const summary = {
        // Customer metrics
        totalCustomers: customers.length,
        activeCustomers: customers.filter((c) => c.status === "active").length,

        // Sales metrics - Use net totals (without VAT) consistently
        totalOrders: invoices.length,
        totalSales: netTotalSales, // This is already calculated without VAT above

        // FIXED: Calculate average order value without VAT
        averageOrderValue: invoices.length > 0 ? netTotalSales / invoices.length : 0,

        totalClientAverages: parseFloat(totalClientAverages.toFixed(2)),
        commissionEligibleSales: parseFloat(commissionEligibleSales.toFixed(2)),

        // Sales Orders metrics (separate from invoices)
        totalSalesOrders: salesOrders.length,
        totalSalesOrderAmount: salesOrders.reduce(
          (sum, order) => sum + (order.DocTotal || 0),
          0
        ),

        // Call metrics
        totalCalls: callData.length,
        inboundCalls: callData.filter((call) => call.direction === "in").length,
        outboundCalls: callData.filter((call) => call.direction === "out").length,
        missedCalls: callData.filter((call) => call.missed).length,
        totalCallDuration: callData.reduce(
          (sum, call) => sum + (call.inCallDuration || 0),
          0
        ),
        averageCallDuration:
          callData.length > 0
            ? callData.reduce(
              (sum, call) => sum + (call.inCallDuration || 0),
              0
            ) / callData.length
            : 0,

        // Productivity metrics
        totalDeskTime: desktimeData.reduce(
          (sum, record) => sum + (record.totalDeskTimeHours || 0),
          0
        ),
        totalProductiveTime: desktimeData.reduce(
          (sum, record) => sum + (record.productiveTimeHours || 0),
          0
        ),
        averageProductivity:
          desktimeData.length > 0
            ? (desktimeData.reduce(
              (sum, record) => sum + (record.productiveTimeHours || 0),
              0
            ) /
              desktimeData.reduce(
                (sum, record) => sum + (record.totalDeskTimeHours || 0),
                0
              )) *
            100
            : 0,

        // Attendance metrics
        totalWorkingDays,
        totalFullDays,
        totalHalfDays,
        totalAbsentDays,
        attendanceRate:
          totalWorkingDays > 0
            ? ((totalFullDays + totalHalfDays) / totalWorkingDays) * 100
            : 0,
        fullDayRate:
          totalWorkingDays > 0 ? (totalFullDays / totalWorkingDays) * 100 : 0,
        averageHoursPerDay:
          totalWorkingDays > 0
            ? desktimeData.reduce(
              (sum, record) => sum + (record.totalDeskTimeHours || 0),
              0
            ) / totalWorkingDays
            : 0,

        // Target metrics
        currentTarget: agent.target || 0,
        targetAchieved: targetProgress.achieved || 0,
        targetProgress: targetProgress.progressPercent || 0,
        remainingTarget: (agent.target || 0) - (targetProgress.achieved || 0),
      };


      // Format numbers for consistency
      Object.keys(summary).forEach((key) => {
        if (typeof summary[key] === "number") {
          summary[key] = parseFloat(summary[key].toFixed(2));
        }
      });

      // Calculate time-based trends (daily/weekly data)
      const trends = await calculateAgentTrends(agentId, agent, start, end);

      // Get top performing customers
      const topCustomers = await getTopCustomers(agentId, start, end);

      // Get recent sales activities
      const recentActivities = await getRecentActivities(
        agentId,
        agent,
        start,
        end
      );

      return res.status(200).json({
        success: true,
        agent: {
          id: agent._id,
          name: `${agent.firstName} ${agent.lastName}`,
          email: agent.email,
          phone: agent.phone,
          target: agent.target,
          manager: agent.manager
            ? `${agent.manager.firstName} ${agent.manager.lastName}`
            : null,
        },
        summary,
        trends,
        topCustomers,
        recentActivities,
        dateRange: {
          start,
          end,
        },
      });
    } catch (error) {
      console.error("Error fetching sales agent dashboard:", error);
      return res.status(500).json({
        success: false,
        message: "Error fetching sales agent dashboard",
        error: error.message,
      });
    }
  },

  /**
 * Get all quotations for a sales agent
 */
  getAgentQuotations: async (req, res) => {
    try {
      const { agentId } = req.params;
      const {
        page = 1,
        limit = 10,
        startDate,
        endDate,
        status,
        customerCode,
        sortBy = "DocDate",
        sortDirection = -1,
        export: isExport = false,
      } = req.query;

      // Validate sales agent
      const agent = await User.findById(agentId);
      if (!agent || agent.role !== "sales_agent") {
        return res.status(404).json({
          success: false,
          message: "Sales agent not found",
        });
      }

      // Set default date range if not provided (last 30 days)
      const end = endDate ? new Date(endDate) : new Date();
      const start = startDate
        ? new Date(startDate)
        : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

      // Get customers assigned to this agent first
      const customers = await Customer.find({ assignedTo: agentId }).lean();
      const customerCodes = customers.map((c) => c.CardCode);

      if (customerCodes.length === 0) {
        return res.status(200).json({
          success: true,
          count: 0,
          total: 0,
          page: parseInt(page),
          pages: 0,
          stats: {
            totalQuotations: 0,
            totalAmount: 0,
            averageQuotationValue: 0,
            conversionRate: 0,
            convertedQuotations: 0,
          },
          data: [],
        });
      }

      // Build query using customer codes
      const query = {
        CardCode: { $in: customerCodes },
        DocDate: { $gte: start, $lte: end },
      };

      // Add additional filters
      if (status) {
        query.DocumentStatus = status;
      }

      if (customerCode) {
        query.CardCode = customerCode;
      }

      let quotations;
      let total;

      // Handle export vs pagination
      if (isExport === "true" || isExport === true) {
        quotations = await Quotation.find(query).sort({
          [sortBy]: parseInt(sortDirection),
        });
        total = quotations.length;
      } else {
        const skip = (parseInt(page) - 1) * parseInt(limit);
        quotations = await Quotation.find(query)
          .skip(skip)
          .limit(parseInt(limit))
          .sort({ [sortBy]: parseInt(sortDirection) });
        total = await Quotation.countDocuments(query);
      }

      // Calculate quotation statistics
      const allQuotationsForStats = await Quotation.find(query);

      const totalAmount = allQuotationsForStats.reduce(
        (sum, quotation) => sum + (quotation.DocTotal || 0),
        0
      );

      const avgAmount =
        allQuotationsForStats.length > 0
          ? totalAmount / allQuotationsForStats.length
          : 0;

      // Calculate conversion rate (quotations that became orders)
      const convertedQuotations = await Invoice.countDocuments({
        CardCode: { $in: customerCodes },
        DocDate: { $gte: start, $lte: end },
        BaseType: 23, // SAP object type for quotations
      });

      const conversionRate =
        allQuotationsForStats.length > 0
          ? (convertedQuotations / allQuotationsForStats.length) * 100
          : 0;

      const stats = {
        totalQuotations: allQuotationsForStats.length,
        totalAmount: parseFloat(totalAmount.toFixed(2)),
        averageQuotationValue: parseFloat(avgAmount.toFixed(2)),
        conversionRate: parseFloat(conversionRate.toFixed(2)),
        convertedQuotations,
      };

      return res.status(200).json({
        success: true,
        count: quotations.length,
        total: isExport ? quotations.length : total,
        page: isExport ? 1 : parseInt(page),
        pages: isExport ? 1 : Math.ceil(total / parseInt(limit)),
        stats: stats,
        data: quotations,
        isExport: isExport === "true" || isExport === true,
      });
    } catch (error) {
      console.error("Error fetching agent quotations:", error);
      return res.status(500).json({
        success: false,
        message: "Error fetching agent quotations",
        error: error.message,
      });
    }
  },

  /**
 * Get all customers assigned to a sales agent with metrics
 * 🎯 UPDATED: Properly handles export with SAP customers only and all-time last invoice dates
 */
  getAgentCustomers: async (req, res) => {
    try {
      const { agentId } = req.params;
      const {
        page = 1,
        limit = 10,
        search,
        status,
        startDate,
        endDate,
        sortBy = "CardName",
        sortOrder = "asc",
        export: isExport = false, // Export parameter
      } = req.query;

      // Validate sales agent
      const agent = await User.findById(agentId);
      if (!agent || agent.role !== "sales_agent") {
        return res.status(404).json({
          success: false,
          message: "Sales agent not found",
        });
      }

      // Build query for customers assigned to this agent
      const query = { assignedTo: agentId };

      // 🎯 CRITICAL: For export, only include SAP customers (CardCode starts with 'C' followed by digits)
      if (isExport === "true" || isExport === true) {
        query.CardCode = { $regex: /^C\d+/, $options: "i" }; // Only SAP customers like C12345
        console.log("🎯 Export mode: Filtering for SAP customers only (CardCode pattern: C####)");
      }

      // Add search filter if provided
      if (search) {
        query.$or = [
          { CardName: new RegExp(search, "i") },
          { CardCode: new RegExp(search, "i") },
        ];
      }

      // Add status filter if provided
      if (status) {
        console.log('Status', status)
        query.status = status;
      }

      // Get all matching customers
      const allCustomers = await Customer.find(query)
        .select("CardCode CardName status assignedTo")
        .populate("assignedTo", "firstName lastName email")
        .lean();

      console.log(`📊 Found ${allCustomers.length} customers for agent ${agentId}`);

      if (allCustomers.length === 0) {
        return res.status(200).json({
          success: true,
          customers: [],
          pagination: {
            total: 0,
            page: parseInt(page),
            pages: 0,
            limit: parseInt(limit),
          },
          isExport: isExport === "true" || isExport === true,
        });
      }

      // Extract customer codes for metrics queries
      const customerCodes = allCustomers.map((c) => c.CardCode);

      // Get customer targets to fetch client averages
      const customerTargets = await CustomerTarget.find({
        salesAgent: agentId,
        cardCode: { $in: customerCodes },
      }).lean();

      // Create a map of client averages by customer code
      const clientAveragesMap = {};
      customerTargets.forEach((target) => {
        clientAveragesMap[target.cardCode] = target.clientExistingAverage || 0;
      });

      // 🎯 KEY CHANGE: Set up date filter ONLY for invoices/orders counts and totals
      // But NOT for latest invoice dates when exporting
      let dateFilter = {};
      let hasDateFilter = false;
      if (startDate && endDate) {
        hasDateFilter = true;
        dateFilter = {
          DocDate: {
            $gte: new Date(startDate),
            $lte: new Date(endDate),
          },
        };
        console.log(`📅 Date filter applied: ${startDate} to ${endDate}`);
      }

      // Get metrics for all customers in parallel
      const [
        invoiceCounts,
        invoiceTotals,
        creditNoteTotals,
        orderCounts,
        orderTotals,
        quotationCounts,
        latestInvoiceDates, // 🎯 This will fetch ALL-TIME last invoice dates for export
      ] = await Promise.all([
        // Invoice counts (filtered by date)
        Invoice.aggregate([
          {
            $match: {
              CardCode: { $in: customerCodes },
              ...dateFilter,
            },
          },
          { $group: { _id: "$CardCode", count: { $sum: 1 } } },
        ]),

        // Invoice totals (SAP Turnover - filtered by date, without VAT)
        Invoice.aggregate([
          {
            $match: {
              CardCode: { $in: customerCodes },
              ...dateFilter,
            },
          },
          {
            $group: {
              _id: "$CardCode",
              totalAmount: { $sum: { $subtract: ["$DocTotal", { $ifNull: ["$VatSum", 0] }] } },
            },
          },
        ]),

        // Credit notes aggregation (filtered by date, without VAT)
        require("../models/CreditNotes").aggregate([
          {
            $match: {
              CardCode: { $in: customerCodes },
              ...dateFilter,
            },
          },
          {
            $group: {
              _id: "$CardCode",
              totalAmount: { $sum: { $subtract: ["$DocTotal", { $ifNull: ["$VatSum", 0] }] } },
            },
          },
        ]),

        // Sales Order counts (filtered by date)
        SalesOrder.aggregate([
          {
            $match: {
              CardCode: { $in: customerCodes },
              ...dateFilter,
            },
          },
          { $group: { _id: "$CardCode", count: { $sum: 1 } } },
        ]),

        // Sales Order totals (filtered by date)
        SalesOrder.aggregate([
          {
            $match: {
              CardCode: { $in: customerCodes },
              ...dateFilter,
            },
          },
          { $group: { _id: "$CardCode", totalAmount: { $sum: "$DocTotal" } } },
        ]),

        // Quotation counts (filtered by date)
        Quotation.aggregate([
          {
            $match: {
              CardCode: { $in: customerCodes },
              ...dateFilter,
            },
          },
          { $group: { _id: "$CardCode", count: { $sum: 1 } } },
        ]),

        // 🎯 CRITICAL FIX: Latest invoice dates
        // For EXPORT: Get all-time last invoice (no date filter)
        // For REGULAR VIEW: Use date filter to show last invoice in period
        Invoice.aggregate([
          {
            $match: {
              CardCode: { $in: customerCodes },
              // 🎯 Remove date filter when exporting to get all-time last invoice
              ...(isExport === "true" || isExport === true ? {} : dateFilter),
            },
          },
          { $sort: { DocDate: -1 } },
          {
            $group: {
              _id: "$CardCode",
              latestInvoiceDate: { $first: "$DocDate" },
            },
          },
        ]),
      ]);

      console.log(`✅ Aggregations complete. Latest invoice dates found: ${latestInvoiceDates.length}`);

      // Create lookup maps for O(1) access
      const invoiceCountMap = {};
      invoiceCounts.forEach((item) => {
        invoiceCountMap[item._id] = item.count;
      });

      const invoiceTotalMap = {};
      invoiceTotals.forEach((item) => {
        invoiceTotalMap[item._id] = item.totalAmount;
      });

      const creditNoteTotalMap = {};
      creditNoteTotals.forEach((item) => {
        creditNoteTotalMap[item._id] = item.totalAmount;
      });

      const orderCountMap = {};
      orderCounts.forEach((item) => {
        orderCountMap[item._id] = item.count;
      });

      const orderTotalMap = {};
      orderTotals.forEach((item) => {
        orderTotalMap[item._id] = item.totalAmount;
      });

      const quotationCountMap = {};
      quotationCounts.forEach((item) => {
        quotationCountMap[item._id] = item.count;
      });

      const latestInvoiceDateMap = {};
      latestInvoiceDates.forEach((item) => {
        latestInvoiceDateMap[item._id] = item.latestInvoiceDate;
      });

      // Enhance customers with metrics
      const enhancedCustomers = allCustomers.map((customer) => {
        const invoiceTotal = invoiceTotalMap[customer.CardCode] || 0;
        const creditNoteTotal = creditNoteTotalMap[customer.CardCode] || 0;
        const netSapTurnover = invoiceTotal - creditNoteTotal; // Net amount after subtracting credit notes

        return {
          ...customer,
          metrics: {
            invoiceCount: invoiceCountMap[customer.CardCode] || 0,
            sapTurnover: netSapTurnover, // Net amount after subtracting credit notes
            clientAverage: clientAveragesMap[customer.CardCode] || 0,
            orderCount: orderCountMap[customer.CardCode] || 0,
            orderTotal: orderTotalMap[customer.CardCode] || 0,
            quotationCount: quotationCountMap[customer.CardCode] || 0,
            latestInvoiceDate: latestInvoiceDateMap[customer.CardCode] || null,
          },
        };
      });

      // Apply sorting based on sortBy parameter
      enhancedCustomers.sort((a, b) => {
        let aValue, bValue;
        const sortDirection = sortOrder === "desc" ? -1 : 1;

        switch (sortBy) {
          case "sapTurnover":
            aValue = a.metrics.sapTurnover;
            bValue = b.metrics.sapTurnover;
            break;
          case "clientAverage":
            aValue = a.metrics.clientAverage;
            bValue = b.metrics.clientAverage;
            break;
          case "invoiceCount":
            aValue = a.metrics.invoiceCount;
            bValue = b.metrics.invoiceCount;
            break;
          case "orderCount":
            aValue = a.metrics.orderCount;
            bValue = b.metrics.orderCount;
            break;
          case "quotationCount":
            aValue = a.metrics.quotationCount;
            bValue = b.metrics.quotationCount;
            break;
          case "latestInvoiceDate":
            aValue = a.metrics.latestInvoiceDate
              ? new Date(a.metrics.latestInvoiceDate).getTime()
              : 0;
            bValue = b.metrics.latestInvoiceDate
              ? new Date(b.metrics.latestInvoiceDate).getTime()
              : 0;
            break;
          case "CardName":
          default:
            return sortDirection * a.CardName.localeCompare(b.CardName);
        }

        return sortDirection * (aValue - bValue);
      });

      let paginatedCustomers;
      let total;

      // Handle export vs pagination
      if (isExport === "true" || isExport === true) {
        // For export: Return all SAP customers
        paginatedCustomers = enhancedCustomers;
        total = enhancedCustomers.length;
        console.log(`📤 Exporting ${total} SAP customers`);
      } else {
        // For regular display: Apply pagination
        const skip = (parseInt(page) - 1) * parseInt(limit);
        paginatedCustomers = enhancedCustomers.slice(
          skip,
          skip + parseInt(limit)
        );
        total = enhancedCustomers.length;
      }

      return res.status(200).json({
        success: true,
        customers: paginatedCustomers,
        pagination: {
          total,
          page: isExport ? 1 : parseInt(page),
          pages: isExport ? 1 : Math.ceil(total / parseInt(limit)),
          limit: parseInt(limit),
        },
        dateRange: startDate && endDate ? { startDate, endDate } : null,
        isExport: isExport === "true" || isExport === true,
        sapCustomersOnly: isExport === "true" || isExport === true, // Indicator flag
      });
    } catch (error) {
      console.error("Error fetching agent customers:", error);
      return res.status(500).json({
        success: false,
        message: "Error fetching agent customers",
        error: error.message,
      });
    }
  },
  /**
   * Get all calls made/received by a sales agent
   */
  getAgentCalls: async (req, res) => {
    try {
      const { agentId } = req.params;
      const {
        page = 1,
        limit = 10,
        startDate,
        endDate,
        direction,
        status,
      } = req.query;

      // Validate sales agent
      const agent = await User.findById(agentId);
      if (!agent || agent.role !== "sales_agent") {
        return res.status(404).json({
          success: false,
          message: "Sales agent not found",
        });
      }

      // Set default date range if not provided (last 30 days)
      const end = endDate ? new Date(endDate) : new Date();
      const start = startDate
        ? new Date(startDate)
        : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

      // Build query
      const query = {
        startTime: { $gte: start, $lte: end },
        $or: [
          { userName: `${agent.firstName} ${agent.lastName}` },
          { userName: agent.email },
          ...(agent.phone
            ? [{ fromNumber: agent.phone }, { toNumber: agent.phone }]
            : []),
        ],
      };
      // Add direction filter if provided
      if (direction && direction !== "all") {
        query.direction = direction;
      }

      // Add status filter if provided
      if (status === "missed") {
        query.$or.push(
          { missed: "Y" },
          { missed: "true" },
          { missed: true },
          { missed: "1" },
          { missed: { $ne: "" } }
        );
      } else if (status === "answered") {
        query.missed = { $in: ["", "N", "false", false, "0", null] };
      }
      // Pagination
      const skip = (parseInt(page) - 1) * parseInt(limit);

      // Execute query
      const calls = await CallData.find(query)
        .skip(skip)
        .limit(parseInt(limit))
        .sort({ startTime: -1 });

      // Get total count
      const total = await CallData.countDocuments(query);

      // Calculate call statistics
      const inboundCalls = await CallData.countDocuments({
        ...query,
        direction: "in",
      });

      const outboundCalls = await CallData.countDocuments({
        ...query,
        direction: "out",
      });

      const missedCalls = await CallData.countDocuments({
        ...query,
        missed: { $ne: "" },
      });

      // Calculate average duration
      const durationStats = await CallData.aggregate([
        { $match: query },
        {
          $group: {
            _id: null,
            totalDuration: { $sum: "$inCallDuration" },
            avgDuration: { $avg: "$inCallDuration" },
          },
        },
      ]);

      const averageDuration =
        durationStats.length > 0 ? durationStats[0].avgDuration : 0;

      return res.status(200).json({
        success: true,
        count: calls.length,
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit)),
        stats: {
          totalCalls: total,
          inboundCalls,
          outboundCalls,
          missedCalls,
          averageDuration,
          answerRate: total > 0 ? ((total - missedCalls) / total) * 100 : 0,
        },
        data: calls,
      });
    } catch (error) {
      console.error("Error fetching agent calls:", error);
      return res.status(500).json({
        success: false,
        message: "Error fetching agent calls",
        error: error.message,
      });
    }
  },

  /**
   * Get all sales orders for a sales agent
   */
  getAgentSalesOrders: async (req, res) => {
    try {
      const { agentId } = req.params;
      const {
        page = 1,
        limit = 10,
        startDate,
        endDate,
        status,
        customerCode,
        sortBy = "DocDate",
        sortDirection = -1,
        export: isExport = false, // Add export parameter
      } = req.query;

      // Validate sales agent
      const agent = await User.findById(agentId);
      if (!agent || agent.role !== "sales_agent") {
        return res.status(404).json({
          success: false,
          message: "Sales agent not found",
        });
      }

      // Set default date range if not provided (last 30 days)
      const end = endDate ? new Date(endDate) : new Date();
      const start = startDate
        ? new Date(startDate)
        : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

      const customers = await Customer.find({ assignedTo: agentId }).lean();
      const customerCodes = customers.map((c) => c.CardCode);

      if (customerCodes.length === 0) {
        return res.status(200).json({
          success: true,
          count: 0,
          total: 0,
          page: parseInt(page),
          pages: 0,
          stats: {
            totalOrders: 0,
            totalAmount: 0,
            averageOrderValue: 0,
            syncedOrders: 0,
            failedOrders: 0,
          },
          data: [],
        });
      }

      // Build query using assigned customer codes
      const query = {
        CardCode: { $in: customerCodes },
        DocDate: { $gte: start, $lte: end },
      };

      // Add status filter if provided
      if (status) {
        query.DocumentStatus = status;
      }

      // Add customer filter if provided
      if (customerCode) {
        query.CardCode = customerCode;
      }

      let orders;
      let total;

      // 🎯 KEY CHANGE: Handle export vs pagination differently
      if (isExport === "true" || isExport === true) {
        // For export: Get ALL orders without pagination
        orders = await SalesOrder.find(query).sort({
          [sortBy]: parseInt(sortDirection),
        });
        total = orders.length;
      } else {
        // For regular display: Use pagination
        const skip = (parseInt(page) - 1) * parseInt(limit);

        orders = await SalesOrder.find(query)
          .skip(skip)
          .limit(parseInt(limit))
          .sort({ [sortBy]: parseInt(sortDirection) });

        // Get total count for pagination
        total = await SalesOrder.countDocuments(query);
      }

      // Calculate order statistics (always use all orders for stats)
      const totalSales = await SalesOrder.aggregate([
        { $match: query },
        {
          $group: {
            _id: null,
            totalAmount: { $sum: "$DocTotal" },
            avgAmount: { $avg: "$DocTotal" },
          },
        },
      ]);

      const syncedOrders = await SalesOrder.countDocuments({
        ...query,
        SyncedWithSAP: true,
      });

      const failedOrders = await SalesOrder.countDocuments({
        ...query,
        LocalStatus: "SyncFailed",
      });

      const totalOrdersCount = await SalesOrder.countDocuments(query);

      return res.status(200).json({
        success: true,
        count: orders.length,
        total: isExport ? orders.length : total,
        page: isExport ? 1 : parseInt(page),
        pages: isExport ? 1 : Math.ceil(total / parseInt(limit)),
        stats: {
          totalOrders: totalOrdersCount,
          totalAmount: totalSales.length > 0 ? totalSales[0].totalAmount : 0,
          averageOrderValue:
            totalSales.length > 0 ? totalSales[0].avgAmount : 0,
          syncedOrders,
          failedOrders,
        },
        data: orders,
        isExport: isExport === "true" || isExport === true,
      });
    } catch (error) {
      console.error("Error fetching agent sales orders:", error);
      return res.status(500).json({
        success: false,
        message: "Error fetching agent sales orders",
        error: error.message,
      });
    }
  },

  /**
   * Get productivity data for a sales agent
   */
  getAgentProductivity: async (req, res) => {
    try {
      const { agentId } = req.params;
      const { startDate, endDate, groupBy = "day" } = req.query;

      // Validate sales agent
      const agent = await User.findById(agentId);
      if (!agent || agent.role !== "sales_agent") {
        return res.status(404).json({
          success: false,
          message: "Sales agent not found",
        });
      }

      const customers = await Customer.find({ assignedTo: agentId }).lean();
      const customerCodes = customers.map((c) => c.CardCode);

      // Set default date range if not provided (last 30 days)
      const end = endDate ? new Date(endDate) : new Date();
      const start = startDate
        ? new Date(startDate)
        : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

      // Query DeskTime records for this agent
      const desktimeRecords = await DeskTime.find({
        date: { $gte: start, $lte: end },
        email: agent.email,
      }).sort({ date: 1 });

      // Get sales data for the same period
      const salesData =
        customerCodes.length > 0
          ? await Invoice.find({
            CardCode: { $in: customerCodes },
            DocDate: { $gte: start, $lte: end },
          })
          : [];

      // Group data by day, week, or month
      const groupedData = {};
      let totalProductiveHours = 0;
      let totalDeskHours = 0;

      // Process DeskTime records
      desktimeRecords.forEach((record) => {
        const date = record.date;
        let key;

        // Get grouping key based on groupBy parameter
        switch (groupBy) {
          case "week":
            const weekStartDate = new Date(date);
            weekStartDate.setDate(date.getDate() - date.getDay());
            key = weekStartDate.toISOString().split("T")[0];
            break;
          case "month":
            key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(
              2,
              "0"
            )}`;
            break;
          case "day":
          default:
            key = date.toISOString().split("T")[0];
            break;
        }

        // Initialize group if not exists
        if (!groupedData[key]) {
          groupedData[key] = {
            period: key,
            days: 0,
            productiveHours: 0,
            deskHours: 0,
            productivity: 0,
            salesAmount: 0,
            orderCount: 0,
          };
        }

        // Update group data
        groupedData[key].days += 1;
        groupedData[key].productiveHours += record.productiveTimeHours || 0;
        groupedData[key].deskHours += record.totalDeskTimeHours || 0;

        // Update totals
        totalProductiveHours += record.productiveTimeHours || 0;
        totalDeskHours += record.totalDeskTimeHours || 0;
      });

      // Add sales data to the groups
      salesData.forEach((sale) => {
        const saleDate = new Date(sale.DocDate);
        let key;

        switch (groupBy) {
          case "week":
            const weekStartDate = new Date(saleDate);
            weekStartDate.setDate(saleDate.getDate() - saleDate.getDay());
            key = weekStartDate.toISOString().split("T")[0];
            break;
          case "month":
            key = `${saleDate.getFullYear()}-${String(
              saleDate.getMonth() + 1
            ).padStart(2, "0")}`;
            break;
          case "day":
          default:
            key = saleDate.toISOString().split("T")[0];
            break;
        }

        // Update group if exists
        if (groupedData[key]) {
          groupedData[key].salesAmount += sale.DocTotal || 0;
          groupedData[key].orderCount += 1;
        } else {
          // Create group if we have sales but no DeskTime record
          groupedData[key] = {
            period: key,
            days: 0,
            productiveHours: 0,
            deskHours: 0,
            productivity: 0,
            salesAmount: sale.DocTotal || 0,
            orderCount: 1,
          };
        }
      });

      // Calculate productivity percentages and format numbers
      Object.values(groupedData).forEach((data) => {
        data.productivity =
          data.deskHours > 0
            ? (data.productiveHours / data.deskHours) * 100
            : 0;

        // Format numbers to 2 decimal places
        data.productiveHours = parseFloat(data.productiveHours.toFixed(2));
        data.deskHours = parseFloat(data.deskHours.toFixed(2));
        data.productivity = parseFloat(data.productivity.toFixed(2));
        data.salesAmount = parseFloat(data.salesAmount.toFixed(2));
      });

      // Sort by period
      const timelineData = Object.values(groupedData).sort((a, b) =>
        a.period.localeCompare(b.period)
      );

      // Calculate overall stats
      const overallProductivity =
        totalDeskHours > 0 ? (totalProductiveHours / totalDeskHours) * 100 : 0;

      const totalSales = salesData.reduce(
        (sum, sale) => sum + (sale.DocTotal || 0),
        0
      );

      // Calculate productivity to sales ratio
      const productivityToSalesRatio =
        totalProductiveHours > 0 ? totalSales / totalProductiveHours : 0;

      const summary = {
        totalDays: desktimeRecords.length,
        totalProductiveHours: parseFloat(totalProductiveHours.toFixed(2)),
        totalDeskHours: parseFloat(totalDeskHours.toFixed(2)),
        averageProductivity: parseFloat(overallProductivity.toFixed(2)),
        totalSales: parseFloat(totalSales.toFixed(2)),
        totalOrders: salesData.length,
        salesPerProductiveHour: parseFloat(productivityToSalesRatio.toFixed(2)),
      };

      return res.status(200).json({
        success: true,
        summary,
        timelineData,
      });
    } catch (error) {
      console.error("Error fetching agent productivity:", error);
      return res.status(500).json({
        success: false,
        message: "Error fetching agent productivity",
        error: error.message,
      });
    }
  },

  /**
   * Get performance and target achievement data for a sales agent
   */
  getAgentPerformance: async (req, res) => {
    try {
      const { agentId } = req.params;
      const { year, month } = req.query;

      // Validate sales agent
      const agent = await User.findById(agentId);
      if (!agent || agent.role !== "sales_agent") {
        return res.status(404).json({
          success: false,
          message: "Sales agent not found",
        });
      }

      // Default to current year and month if not specified
      const currentDate = new Date();
      const targetYear = year ? parseInt(year) : currentDate.getFullYear();
      const targetMonth = month
        ? month
        : currentDate.toLocaleString("default", { month: "short" });

      // Find target for the specified period
      const targetEntry = agent.targetHistory.find(
        (entry) => entry.year === targetYear && entry.month === targetMonth
      );

      // Find sales history for the specified period
      const salesEntry = agent.salesHistory.find(
        (entry) => entry.year === targetYear && entry.month === targetMonth
      );

      // Get yearly performance
      const yearlyPerformance = agent.targetHistory
        .filter((entry) => entry.year === targetYear)
        .sort((a, b) => {
          const months = [
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "May",
            "Jun",
            "Jul",
            "Aug",
            "Sep",
            "Oct",
            "Nov",
            "Dec",
          ];
          return months.indexOf(a.month) - months.indexOf(b.month);
        });

      // Get current period target progress
      const currentTargetProgress = await getAgentCurrentTargetProgress(agent);

      return res.status(200).json({
        success: true,
        agent: {
          id: agent._id,
          name: `${agent.firstName} ${agent.lastName}`,
          email: agent.email,
          target: agent.target || 0,
          targetAchieved: agent.targetAchieved || 0,
          overallProgress:
            agent.target > 0 ? (agent.targetAchieved / agent.target) * 100 : 0,
        },
        currentPeriod: {
          year: targetYear,
          month: targetMonth,
          target: targetEntry?.target || 0,
          achieved: targetEntry?.achieved || 0,
          achievementRate: targetEntry?.achievementRate || 0,
          orderCount: salesEntry?.orderCount || 0,
        },
        currentTarget: currentTargetProgress,
        yearlyPerformance: yearlyPerformance.map((entry) => ({
          month: entry.month,
          target: entry.target,
          achieved: entry.achieved,
          achievementRate: entry.achievementRate,
        })),
      });
    } catch (error) {
      console.error("Error fetching agent performance:", error);
      return res.status(500).json({
        success: false,
        message: "Error fetching agent performance",
        error: error.message,
      });
    }
  },

  /**
   * Get customer journey metrics for customers assigned to a sales agent
   */
  getAgentCustomerJourneys: async (req, res) => {
    try {
      const { agentId } = req.params;
      const { limit = 5, metric = "totalSpent" } = req.query;

      // Validate sales agent
      const agent = await User.findById(agentId);
      if (!agent || agent.role !== "sales_agent") {
        return res.status(404).json({
          success: false,
          message: "Sales agent not found",
        });
      }

      // Get customers assigned to this agent
      const customers = await Customer.find({ assignedTo: agentId }).lean();
      const customerIds = customers.map((c) => c.CardCode);

      if (customerIds.length === 0) {
        return res.status(200).json({
          success: true,
          message: "No customers assigned to this agent",
          data: [],
        });
      }

      // Get top customers based on selected metric
      let topCustomers = [];

      if (metric === "totalSpent" || metric === "invoiceCount") {
        // For spend or order count metrics, get from orders
        const aggregationField = metric === "totalSpent" ? "$DocTotal" : 1;

        const result = await Invoice.aggregate([
          {
            $match: {
              CardCode: { $in: customerCodes },
            },
          },
          {
            $group: {
              _id: "$CardCode",
              totalSpent: { $sum: "$DocTotal" },
              invoiceCount: { $sum: 1 },
              lastOrderDate: { $max: "$DocDate" },
            },
          },
          {
            $sort:
              metric === "totalSpent"
                ? { totalSpent: -1 }
                : { invoiceCount: -1 },
          },
          { $limit: parseInt(limit) },
        ]);

        // Match with customer details
        const customerMap = {};
        customers.forEach((c) => {
          customerMap[c.CardCode] = c;
        });

        topCustomers = result.map((r) => ({
          cardCode: r._id,
          cardName: customerMap[r._id]?.CardName || r._id,
          totalSpent: r.totalSpent,
          invoiceCount: r.invoiceCount,
          lastOrderDate: r.lastOrderDate,
          email: customerMap[r._id]?.Email,
          phone: customerMap[r._id]?.Phone1,
        }));
      } else if (metric === "recentActivity") {
        // For recent activity, sort by last order date
        const result = await SalesOrder.aggregate([
          {
            $match: {
              CardCode: { $in: customerIds },
              salesAgent: mongoose.Types.ObjectId(agentId),
            },
          },
          {
            $group: {
              _id: "$CardCode",
              totalSpent: { $sum: "$DocTotal" },
              invoiceCount: { $sum: 1 },
              lastOrderDate: { $max: "$DocDate" },
            },
          },
          { $sort: { lastOrderDate: -1 } },
          { $limit: parseInt(limit) },
        ]);

        // Match with customer details
        const customerMap = {};
        customers.forEach((c) => {
          customerMap[c.CardCode] = c;
        });

        topCustomers = result.map((r) => ({
          cardCode: r._id,
          cardName: customerMap[r._id]?.CardName || r._id,
          totalSpent: r.totalSpent,
          invoiceCount: r.invoiceCount,
          lastOrderDate: r.lastOrderDate,
          email: customerMap[r._id]?.Email,
          phone: customerMap[r._id]?.Phone1,
        }));
      } else if (metric === "paymentBehavior") {
        // For payment behavior, we need more complex analysis
        // This would need to be implemented with your specific payment tracking logic
        // Placeholder implementation:
        const result = await SalesOrder.aggregate([
          {
            $match: {
              CardCode: { $in: customerIds },
              salesAgent: mongoose.Types.ObjectId(agentId),
            },
          },
          {
            $group: {
              _id: "$CardCode",
              totalSpent: { $sum: "$DocTotal" },
              invoiceCount: { $sum: 1 },
            },
          },
          { $sort: { totalSpent: -1 } },
          { $limit: parseInt(limit) },
        ]);

        // Match with customer details
        const customerMap = {};
        customers.forEach((c) => {
          customerMap[c.CardCode] = c;
        });

        topCustomers = result.map((r) => ({
          cardCode: r._id,
          cardName: customerMap[r._id]?.CardName || r._id,
          totalSpent: r.totalSpent,
          invoiceCount: r.invoiceCount,
          // Placeholder payment metrics
          onTimePaymentRate: Math.random() * 100, // Replace with actual calculation
          averagePaymentDays: Math.floor(Math.random() * 30), // Replace with actual calculation
        }));
      }

      return res.status(200).json({
        success: true,
        metric,
        data: topCustomers,
      });
    } catch (error) {
      console.error("Error fetching agent customer journeys:", error);
      return res.status(500).json({
        success: false,
        message: "Error fetching agent customer journeys",
        error: error.message,
      });
    }
  },
  /**
   * Get all invoices for a sales agent
   */
  // Updated getAgentInvoices method with debugging and fixes

  getAgentInvoices: async (req, res) => {
    try {
      const { agentId } = req.params;
      const {
        page = 1,
        limit = 10,
        startDate,
        endDate,
        status,
        customerCode,
        sortBy = "DocDate",
        sortDirection = -1,
        export: isExport = false, // Add export parameter
      } = req.query;

      // Validate sales agent
      const agent = await User.findById(agentId);
      if (!agent || agent.role !== "sales_agent") {
        return res.status(404).json({
          success: false,
          message: "Sales agent not found",
        });
      }

      // Set default date range if not provided (last 30 days)
      const end = endDate ? new Date(endDate) : new Date();
      const start = startDate
        ? new Date(startDate)
        : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

      // Get customers assigned to this agent first
      const customers = await Customer.find({ assignedTo: agentId }).lean();
      const customerCodes = customers.map((c) => c.CardCode);

      if (customerCodes.length === 0) {
        return res.status(200).json({
          success: true,
          count: 0,
          total: 0,
          page: parseInt(page),
          pages: 0,
          stats: {
            totalInvoices: 0,
            totalAmount: 0,
            averageInvoiceValue: 0,
            verifiedInvoices: 0,
            verificationRate: 0,
            paymentMethods: [],
          },
          data: [],
        });
      }

      // Build query using customer codes
      const query = {
        CardCode: { $in: customerCodes },
        DocDate: { $gte: start, $lte: end },
      };

      // Add additional filters
      if (status) {
        query.DocumentStatus = status;
      }

      if (customerCode) {
        query.CardCode = customerCode;
      }

      let invoices;
      let total;

      // 🎯 KEY CHANGE: Handle export vs pagination differently
      if (isExport === "true" || isExport === true) {
        // For export: Get ALL invoices without pagination
        invoices = await Invoice.find(query).sort({
          [sortBy]: parseInt(sortDirection),
        });
        total = invoices.length;
      } else {
        // For regular display: Use pagination
        const skip = (parseInt(page) - 1) * parseInt(limit);

        invoices = await Invoice.find(query)
          .skip(skip)
          .limit(parseInt(limit))
          .sort({ [sortBy]: parseInt(sortDirection) });

        // Get total count for pagination
        total = await Invoice.countDocuments(query);
      }

      // Calculate invoice statistics (always use all invoices for stats)
      const allInvoicesForStats = await Invoice.find(query);

      let totalAmount = 0;
      let totalAmountNoVat = 0;
      let totalVerified = 0;

      allInvoicesForStats.forEach((inv) => {
        totalAmount += inv.DocTotal || 0;
        totalAmountNoVat += (inv.DocTotal || 0) - (inv.VatSum || 0);
        if (inv.verified) totalVerified++;
      });

      const avgAmount =
        allInvoicesForStats.length > 0
          ? totalAmount / allInvoicesForStats.length
          : 0;
      const avgAmountNoVat =
        allInvoicesForStats.length > 0
          ? totalAmountNoVat / allInvoicesForStats.length
          : 0;

      // Group by payment method
      const paymentMethods = {};
      allInvoicesForStats.forEach((inv) => {
        const method = inv.paymentMethod || "Unknown";
        if (!paymentMethods[method]) {
          paymentMethods[method] = { count: 0, total: 0 };
        }
        paymentMethods[method].count++;
        paymentMethods[method].total += inv.DocTotal || 0;
      });

      const paymentMethodStats = Object.keys(paymentMethods)
        .map((method) => ({
          _id: method,
          count: paymentMethods[method].count,
          total: paymentMethods[method].total,
        }))
        .sort((a, b) => b.count - a.count);

      const stats = {
        totalInvoices: allInvoicesForStats.length,
        totalAmount: parseFloat(totalAmount.toFixed(2)),
        totalAmountNoVat: parseFloat(totalAmountNoVat.toFixed(2)),
        averageInvoiceValue: parseFloat(avgAmount.toFixed(2)),
        averageInvoiceValueNoVat: parseFloat(avgAmountNoVat.toFixed(2)),
        verifiedInvoices: totalVerified,
        verificationRate:
          allInvoicesForStats.length > 0
            ? parseFloat(
              ((totalVerified / allInvoicesForStats.length) * 100).toFixed(2)
            )
            : 0,
        paymentMethods: paymentMethodStats,
      };

      return res.status(200).json({
        success: true,
        count: invoices.length,
        total: isExport ? invoices.length : total,
        page: isExport ? 1 : parseInt(page),
        pages: isExport ? 1 : Math.ceil(total / parseInt(limit)),
        stats: stats,
        data: invoices,
        isExport: isExport === "true" || isExport === true,
      });
    } catch (error) {
      console.error("Error fetching agent invoices:", error);
      return res.status(500).json({
        success: false,
        message: "Error fetching agent invoices",
        error: error.message,
      });
    }
  },
  /**
   * Get combined orders and invoices analytics
   */
  getOrdersInvoicesAnalytics: async (req, res) => {
    try {
      const { agentId } = req.params;
      const { startDate, endDate } = req.query;

      // Validate sales agent
      const agent = await User.findById(agentId);
      if (!agent || agent.role !== "sales_agent") {
        return res.status(404).json({
          success: false,
          message: "Sales agent not found",
        });
      }

      // Set default date range if not provided (last 30 days)
      const end = endDate ? new Date(endDate) : new Date();
      const start = startDate
        ? new Date(startDate)
        : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

      // Get customers once with minimal fields
      const customers = await Customer.find({ assignedTo: agentId })
        .select('CardCode CardName')
        .lean();

      const customerCodes = customers.map((c) => c.CardCode);

      if (customerCodes.length === 0) {
        return res.status(200).json({
          success: true,
          summary: {
            quotations: { count: 0, total: 0, average: 0, min: 0, max: 0 },
            orders: { count: 0, total: 0, average: 0, min: 0, max: 0 },
            invoices: {
              count: 0,
              total: 0,
              totalNoVat: 0,
              average: 0,
              averageNoVat: 0,
              min: 0,
              max: 0,
            },
            creditNotes: {
              count: 0,
              total: 0,
              totalNoVat: 0,
              average: 0,
              averageNoVat: 0,
            },
            netSales: 0, // invoices - credit notes (without VAT)
            conversion: { rate: 0, totalQuotations: 0, convertedQuotations: 0 },
          },
          topCustomers: [],
          monthlyData: [],
          dateRange: { start, end },
        });
      }

      // Base query for reuse
      const baseQuery = {
        CardCode: { $in: customerCodes },
        DocDate: { $gte: start, $lte: end },
      };

      // Run aggregations in parallel
      const [quotationStats, orderStats, invoiceStats, creditNoteStats, monthlyQuotations, monthlyOrders, monthlyInvoices] = await Promise.all([
        // Quotations summary
        Quotation.aggregate([
          { $match: baseQuery },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              total: { $sum: "$DocTotal" },
              average: { $avg: "$DocTotal" },
              min: { $min: "$DocTotal" },
              max: { $max: "$DocTotal" },
            },
          },
        ]),

        // Orders summary (Sales Orders - keep with VAT for comparison)
        SalesOrder.aggregate([
          { $match: baseQuery },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              total: { $sum: "$DocTotal" },
              average: { $avg: "$DocTotal" },
              min: { $min: "$DocTotal" },
              max: { $max: "$DocTotal" },
            },
          },
        ]),

        // Invoices summary (without VAT for net calculation)
        Invoice.aggregate([
          { $match: baseQuery },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              total: { $sum: "$DocTotal" },
              totalNoVat: { $sum: { $subtract: ["$DocTotal", { $ifNull: ["$VatSum", 0] }] } },
              average: { $avg: "$DocTotal" },
              min: { $min: "$DocTotal" },
              max: { $max: "$DocTotal" },
            },
          },
        ]),

        // Credit Notes summary (without VAT)
        require("../models/CreditNotes").aggregate([
          { $match: baseQuery },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              total: { $sum: "$DocTotal" },
              totalNoVat: { $sum: { $subtract: ["$DocTotal", { $ifNull: ["$VatSum", 0] }] } },
              average: { $avg: "$DocTotal" },
            },
          },
        ]),

        // Monthly quotations
        Quotation.aggregate([
          { $match: baseQuery },
          {
            $group: {
              _id: {
                year: { $year: "$DocDate" },
                month: { $month: "$DocDate" },
              },
              count: { $sum: 1 },
              total: { $sum: "$DocTotal" },
            },
          },
          { $sort: { "_id.year": 1, "_id.month": 1 } },
        ]),

        // Monthly orders
        SalesOrder.aggregate([
          { $match: baseQuery },
          {
            $group: {
              _id: {
                year: { $year: "$DocDate" },
                month: { $month: "$DocDate" },
              },
              count: { $sum: 1 },
              total: { $sum: "$DocTotal" },
            },
          },
          { $sort: { "_id.year": 1, "_id.month": 1 } },
        ]),

        // Monthly invoices (without VAT)
        Invoice.aggregate([
          { $match: baseQuery },
          {
            $group: {
              _id: {
                year: { $year: "$DocDate" },
                month: { $month: "$DocDate" },
              },
              count: { $sum: 1 },
              total: { $sum: "$DocTotal" },
              totalNoVat: { $sum: { $subtract: ["$DocTotal", { $ifNull: ["$VatSum", 0] }] } },
            },
          },
          { $sort: { "_id.year": 1, "_id.month": 1 } },
        ]),
      ]);

      // Process monthly data
      const monthlyMap = {};

      // Add all months from all data sources
      [...monthlyQuotations, ...monthlyOrders, ...monthlyInvoices].forEach((item) => {
        const key = `${item._id.year}-${item._id.month}`;
        if (!monthlyMap[key]) {
          monthlyMap[key] = {
            date: `${new Date(0, item._id.month - 1).toLocaleString('default', { month: 'short' })} ${item._id.year}`,
            year: item._id.year,
            month: item._id.month,
            quotations: { count: 0, total: 0 },
            orders: { count: 0, total: 0 },
            invoices: { count: 0, total: 0, totalNoVat: 0 },
          };
        }
      });

      // Fill in the data
      monthlyQuotations.forEach((item) => {
        const key = `${item._id.year}-${item._id.month}`;
        if (monthlyMap[key]) {
          monthlyMap[key].quotations = { count: item.count, total: item.total };
        }
      });

      monthlyOrders.forEach((item) => {
        const key = `${item._id.year}-${item._id.month}`;
        if (monthlyMap[key]) {
          monthlyMap[key].orders = { count: item.count, total: item.total };
        }
      });

      monthlyInvoices.forEach((item) => {
        const key = `${item._id.year}-${item._id.month}`;
        if (monthlyMap[key]) {
          monthlyMap[key].invoices = {
            count: item.count,
            total: item.total,
            totalNoVat: item.totalNoVat
          };
        }
      });

      const monthlyData = Object.values(monthlyMap).sort((a, b) => {
        if (a.year !== b.year) return a.year - b.year;
        return a.month - b.month;
      });

      // Calculate net sales (invoices - credit notes, both without VAT)
      const invoiceNoVatTotal = invoiceStats.length > 0 ? invoiceStats[0].totalNoVat : 0;
      const creditNoteNoVatTotal = creditNoteStats.length > 0 ? creditNoteStats[0].totalNoVat : 0;
      const netSales = invoiceNoVatTotal - creditNoteNoVatTotal;

      // Simple conversion calculation (quotations to orders)
      const totalQuotations = quotationStats.length > 0 ? quotationStats[0].count : 0;
      const totalOrders = orderStats.length > 0 ? orderStats[0].count : 0;

      return res.status(200).json({
        success: true,
        summary: {
          quotations: {
            count: totalQuotations,
            total: quotationStats.length > 0 ? quotationStats[0].total : 0,
            average: quotationStats.length > 0 ? quotationStats[0].average : 0,
            min: quotationStats.length > 0 ? quotationStats[0].min : 0,
            max: quotationStats.length > 0 ? quotationStats[0].max : 0,
          },
          orders: {
            count: totalOrders,
            total: orderStats.length > 0 ? orderStats[0].total : 0,
            average: orderStats.length > 0 ? orderStats[0].average : 0,
            min: orderStats.length > 0 ? orderStats[0].min : 0,
            max: orderStats.length > 0 ? orderStats[0].max : 0,
          },
          invoices: {
            count: invoiceStats.length > 0 ? invoiceStats[0].count : 0,
            total: invoiceStats.length > 0 ? invoiceStats[0].total : 0,
            totalNoVat: invoiceNoVatTotal,
            average: invoiceStats.length > 0 ? invoiceStats[0].average : 0,
            averageNoVat: invoiceStats.length > 0 ? (invoiceNoVatTotal / invoiceStats[0].count) : 0,
            min: invoiceStats.length > 0 ? invoiceStats[0].min : 0,
            max: invoiceStats.length > 0 ? invoiceStats[0].max : 0,
          },
          creditNotes: {
            count: creditNoteStats.length > 0 ? creditNoteStats[0].count : 0,
            total: creditNoteStats.length > 0 ? creditNoteStats[0].total : 0,
            totalNoVat: creditNoteNoVatTotal,
            average: creditNoteStats.length > 0 ? creditNoteStats[0].average : 0,
            averageNoVat: creditNoteStats.length > 0 ? (creditNoteNoVatTotal / creditNoteStats[0].count) : 0,
          },
          netSales: parseFloat(netSales.toFixed(2)),
          conversion: {
            rate: totalQuotations > 0 ? parseFloat(((totalOrders / totalQuotations) * 100).toFixed(2)) : 0,
            totalQuotations,
            convertedQuotations: totalOrders,
          },
        },
        monthlyData,
        dateRange: { start, end },
      });
    } catch (error) {
      console.error("Error fetching orders and invoices analytics:", error);
      return res.status(500).json({
        success: false,
        message: "Error fetching orders and invoices analytics",
        error: error.message,
      });
    }
  },

  // Add this new method to salesAgentJourneyController object
  getAgentAttendance: async (req, res) => {
    try {
      const { agentId } = req.params;
      const { startDate, endDate } = req.query;

      // Validate sales agent
      const agent = await User.findById(agentId);
      if (!agent || agent.role !== "sales_agent") {
        return res.status(404).json({
          success: false,
          message: "Sales agent not found",
        });
      }

      // Set default date range if not provided (last 30 days)
      const end = endDate ? new Date(endDate) : new Date();
      const start = startDate
        ? new Date(startDate)
        : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

      // Get productivity data
      const desktimeRecords = await DeskTime.find({
        email: agent.email,
        date: { $gte: start, $lte: end },
      }).sort({ date: 1 });

      // Calculate attendance metrics
      let totalWorkingDays = 0;
      let totalHalfDays = 0;
      let totalFullDays = 0;
      let totalAbsentDays = 0;
      let totalHoursWorked = 0;

      const attendanceDetails = [];

      // Get all working days (Monday to Friday) in the date range
      const workingDays = [];
      const current = new Date(start);
      while (current <= end) {
        const dayOfWeek = current.getDay(); // 0 = Sunday, 1 = Monday, ..., 5 = Friday
        if (dayOfWeek >= 1 && dayOfWeek <= 5) {
          // Monday to Friday
          workingDays.push(new Date(current));
          totalWorkingDays++;
        }
        current.setDate(current.getDate() + 1);
      }

      // Create a map of desktime records by date
      const desktimeMap = {};
      desktimeRecords.forEach((record) => {
        const dateKey = record.date.toISOString().split("T")[0];
        desktimeMap[dateKey] = record;
      });

      // Process each working day
      workingDays.forEach((workingDay) => {
        const dateKey = workingDay.toISOString().split("T")[0];
        const desktimeRecord = desktimeMap[dateKey];

        const hoursWorked = desktimeRecord
          ? desktimeRecord.totalDeskTimeHours || 0
          : 0;
        totalHoursWorked += hoursWorked;

        let attendanceStatus = "absent";
        let attendanceType = "Absent";

        if (hoursWorked >= 7) {
          attendanceStatus = "full_day";
          attendanceType = "Full Day";
          totalFullDays++;
        } else if (hoursWorked >= 4) {
          attendanceStatus = "half_day";
          attendanceType = "Half Day";
          totalHalfDays++;
        } else {
          totalAbsentDays++;
        }

        attendanceDetails.push({
          date: dateKey,
          dayName: workingDay.toLocaleDateString("en-US", { weekday: "long" }),
          hoursWorked: parseFloat(hoursWorked.toFixed(2)),
          productiveHours: desktimeRecord
            ? desktimeRecord.productiveTimeHours || 0
            : 0,
          attendanceStatus,
          attendanceType,
          productivityRate:
            desktimeRecord && hoursWorked > 0
              ? ((desktimeRecord.productiveTimeHours || 0) / hoursWorked) * 100
              : 0,
        });
      });

      // Calculate attendance rates
      const attendanceRate =
        totalWorkingDays > 0
          ? ((totalFullDays + totalHalfDays) / totalWorkingDays) * 100
          : 0;

      const fullDayRate =
        totalWorkingDays > 0 ? (totalFullDays / totalWorkingDays) * 100 : 0;

      const averageHoursPerDay =
        totalWorkingDays > 0 ? totalHoursWorked / totalWorkingDays : 0;

      return res.status(200).json({
        success: true,
        agent: {
          id: agent._id,
          name: `${agent.firstName} ${agent.lastName}`,
          email: agent.email,
        },
        summary: {
          totalWorkingDays,
          totalFullDays,
          totalHalfDays,
          totalAbsentDays,
          totalHoursWorked: parseFloat(totalHoursWorked.toFixed(2)),
          attendanceRate: parseFloat(attendanceRate.toFixed(2)),
          fullDayRate: parseFloat(fullDayRate.toFixed(2)),
          averageHoursPerDay: parseFloat(averageHoursPerDay.toFixed(2)),
        },
        attendanceDetails: attendanceDetails.sort((a, b) =>
          b.date.localeCompare(a.date)
        ),
        dateRange: { start, end },
      });
    } catch (error) {
      console.error("Error fetching agent attendance:", error);
      return res.status(500).json({
        success: false,
        message: "Error fetching agent attendance",
        error: error.message,
      });
    }
  },
};

function processMonthlyData(orderData, invoiceData, startDate, endDate) {
  // Create a map of months
  const monthlyMap = {};

  // Fill in all months in the date range
  const start = new Date(startDate);
  const end = new Date(endDate);

  let current = new Date(start);
  current.setDate(1); // Start at the beginning of the month

  while (current <= end) {
    const year = current.getFullYear();
    const month = current.getMonth() + 1; // JavaScript months are 0-based

    const key = `${year}-${month}`;
    const monthName = current.toLocaleString("default", { month: "short" });

    monthlyMap[key] = {
      date: `${monthName} ${year}`,
      year,
      month,
      orders: {
        count: 0,
        total: 0,
      },
      invoices: {
        count: 0,
        total: 0,
      },
    };

    // Move to next month
    current.setMonth(current.getMonth() + 1);
  }

  // Fill in order data
  orderData.forEach((item) => {
    const key = `${item._id.year}-${item._id.month}`;
    if (monthlyMap[key]) {
      monthlyMap[key].orders.count = item.count;
      monthlyMap[key].orders.total = item.total;
    }
  });

  // Fill in invoice data
  invoiceData.forEach((item) => {
    const key = `${item._id.year}-${item._id.month}`;
    if (monthlyMap[key]) {
      monthlyMap[key].invoices.count = item.count;
      monthlyMap[key].invoices.total = item.total;
    }
  });

  // Convert to array and sort by date
  return Object.values(monthlyMap).sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });
}

/**
 * Helper function to get agent's current period target progress
 */
async function getAgentCurrentTargetProgress(agent) {
  try {
    // Get current month and year
    const now = new Date();
    const currentMonth = now.toLocaleString("default", { month: "short" });
    const currentYear = now.getFullYear();

    // Find target entry for current period
    const targetEntry = agent.targetHistory
      ? agent.targetHistory.find(
        (entry) => entry.year === currentYear && entry.month === currentMonth
      )
      : null;

    if (!targetEntry) {
      return {
        period: `${currentMonth} ${currentYear}`,
        target: agent.target || 0,
        achieved: 0,
        progressPercent: 0,
        remainingAmount: agent.target || 0,
        daysInMonth: new Date(currentYear, now.getMonth() + 1, 0).getDate(),
        daysPassed: now.getDate(),
        daysRemaining:
          new Date(currentYear, now.getMonth() + 1, 0).getDate() -
          now.getDate(),
        expectedProgress:
          (now.getDate() /
            new Date(currentYear, now.getMonth() + 1, 0).getDate()) *
          100,
      };
    }

    // Calculate days information
    const daysInMonth = new Date(currentYear, now.getMonth() + 1, 0).getDate();
    const daysPassed = now.getDate();
    const daysRemaining = daysInMonth - daysPassed;

    // Calculate expected progress based on days passed
    const expectedProgress = (daysPassed / daysInMonth) * 100;

    return {
      period: `${currentMonth} ${currentYear}`,
      target: targetEntry.target,
      achieved: targetEntry.achieved,
      progressPercent: targetEntry.achievementRate,
      remainingAmount: targetEntry.target - targetEntry.achieved,
      daysInMonth,
      daysPassed,
      daysRemaining,
      expectedProgress,
      isAhead: targetEntry.achievementRate > expectedProgress,
      isBehind: targetEntry.achievementRate < expectedProgress,
    };
  } catch (error) {
    console.error("Error calculating agent target progress:", error);
    return {
      period: "Current Month",
      target: agent.target || 0,
      achieved: 0,
      progressPercent: 0,
      remainingAmount: agent.target || 0,
    };
  }
}

/**
 * Calculate time-based trends for an agent
 */
async function calculateAgentTrends(agentId, agent, startDate, endDate) {
  try {
    // Date processing helpers
    const getDayKey = (date) => date.toISOString().split("T")[0];
    const getWeekKey = (date) => {
      const d = new Date(date);
      d.setDate(d.getDate() - d.getDay()); // Start of week (Sunday)
      return d.toISOString().split("T")[0];
    };

    // Initialize data structure
    const dailyData = {};
    const weeklyData = {};

    // Create date range for all days
    const dayMS = 24 * 60 * 60 * 1000;
    for (
      let d = new Date(startDate);
      d <= endDate;
      d = new Date(d.getTime() + dayMS)
    ) {
      const dayKey = getDayKey(d);
      const weekKey = getWeekKey(d);

      dailyData[dayKey] = {
        date: dayKey,
        sales: 0,
        orders: 0,
        calls: 0,
        productivity: 0,
        deskHours: 0,
      };

      if (!weeklyData[weekKey]) {
        weeklyData[weekKey] = {
          week: weekKey,
          sales: 0,
          orders: 0,
          calls: 0,
          productivity: 0,
          deskHours: 0,
          productiveHours: 0,
          days: 0,
        };
      }
    }

    // Fetch data for trends
    const [assignedCustomers, callData, productivityData] = await Promise.all([
      // Get assigned customers
      Customer.find({ assignedTo: agentId }).lean(),

      // Get call data - Updated with better agent matching
      CallData.find({
        startTime: { $gte: startDate, $lte: endDate },
        $or: [
          { userName: `${agent.firstName} ${agent.lastName}` },
          { userName: agent.email },
          ...(agent.phone
            ? [{ fromNumber: agent.phone }, { toNumber: agent.phone }]
            : []),
        ],
      }).lean(),

      // Get productivity data
      DeskTime.find({
        email: agent.email,
        date: { $gte: startDate, $lte: endDate },
      }).lean(),
    ]);

    const customerCodes = assignedCustomers.map((c) => c.CardCode);

    // *** UPDATED: Use customer-based invoice fetching logic ***
    const invoices =
      customerCodes.length > 0
        ? await Invoice.find({
          CardCode: { $in: customerCodes },
          DocDate: { $gte: startDate, $lte: endDate },
        }).lean()
        : [];

    // Process invoices
    invoices.forEach((invoice) => {
      const date = new Date(invoice.DocDate);
      const dayKey = getDayKey(date);
      const weekKey = getWeekKey(date);

      if (dailyData[dayKey]) {
        dailyData[dayKey].sales += invoice.DocTotal || 0;
        dailyData[dayKey].orders += 1;
      }

      if (weeklyData[weekKey]) {
        weeklyData[weekKey].sales += invoice.DocTotal || 0;
        weeklyData[weekKey].orders += 1;
      }
    });

    // Process call data
    callData.forEach((call) => {
      const date = new Date(call.startTime);
      const dayKey = getDayKey(date);
      const weekKey = getWeekKey(date);

      if (dailyData[dayKey]) {
        dailyData[dayKey].calls += 1;
      }

      if (weeklyData[weekKey]) {
        weeklyData[weekKey].calls += 1;
      }
    });

    // Process productivity data
    productivityData.forEach((record) => {
      const date = record.date;
      const dayKey = getDayKey(date);
      const weekKey = getWeekKey(date);

      if (dailyData[dayKey]) {
        dailyData[dayKey].deskHours = record.totalDeskTimeHours || 0;
        dailyData[dayKey].productivity = record.productivityRatio || 0;
      }

      if (weeklyData[weekKey]) {
        weeklyData[weekKey].deskHours += record.totalDeskTimeHours || 0;
        weeklyData[weekKey].productiveHours += record.productiveTimeHours || 0;
        weeklyData[weekKey].days += 1;
      }
    });

    // Calculate weekly productivity percentage
    Object.values(weeklyData).forEach((week) => {
      if (week.deskHours > 0) {
        week.productivity = (week.productiveHours / week.deskHours) * 100;
      }

      // Format numbers for consistency
      week.productivity = parseFloat(week.productivity.toFixed(2));
      week.sales = parseFloat(week.sales.toFixed(2));
      week.deskHours = parseFloat(week.deskHours.toFixed(2));
      week.productiveHours = parseFloat(week.productiveHours.toFixed(2));
    });

    // Convert to arrays and sort by date
    const dailyTrends = Object.values(dailyData).sort((a, b) =>
      a.date.localeCompare(b.date)
    );

    const weeklyTrends = Object.values(weeklyData).sort((a, b) =>
      a.week.localeCompare(b.week)
    );

    return {
      daily: dailyTrends,
      weekly: weeklyTrends,
    };
  } catch (error) {
    console.error("Error calculating agent trends:", error);
    return {
      daily: [],
      weekly: [],
    };
  }
}

/**
 * Get top performing customers for an agent
 */
async function getTopCustomers(agentId, startDate, endDate) {
  try {
    // Get customers assigned to this agent
    const assignedCustomers = await Customer.find({
      assignedTo: agentId,
    }).lean();
    const customerCodes = assignedCustomers.map((c) => c.CardCode);

    if (customerCodes.length === 0) {
      return {
        topByRevenue: [],
        topByFrequency: [],
        recentCustomers: [],
      };
    }

    // Get invoice totals (without VAT) and credit note totals (without VAT) for each customer
    const [invoiceData, creditNoteData] = await Promise.all([
      // Invoice aggregation (without VAT)
      Invoice.aggregate([
        {
          $match: {
            CardCode: { $in: customerCodes },
            DocDate: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: "$CardCode",
            invoiceTotal: { $sum: { $subtract: ["$DocTotal", { $ifNull: ["$VatSum", 0] }] } },
            invoiceCount: { $sum: 1 },
            lastInvoiceDate: { $max: "$DocDate" },
            customerName: { $first: "$CardName" },
          },
        },
      ]),

      // Credit notes aggregation (without VAT)
      require("../models/CreditNotes").aggregate([
        {
          $match: {
            CardCode: { $in: customerCodes },
            DocDate: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: "$CardCode",
            creditNoteTotal: { $sum: { $subtract: ["$DocTotal", { $ifNull: ["$VatSum", 0] }] } },
          },
        },
      ]),
    ]);

    // Create maps for quick lookup
    const invoiceMap = {};
    invoiceData.forEach((item) => {
      invoiceMap[item._id] = item;
    });

    const creditNoteMap = {};
    creditNoteData.forEach((item) => {
      creditNoteMap[item._id] = item.creditNoteTotal;
    });

    // Calculate net totals (invoices - credit notes) for each customer
    const customerNetTotals = invoiceData.map((customer) => {
      const invoiceTotal = customer.invoiceTotal || 0;
      const creditNoteTotal = creditNoteMap[customer._id] || 0;
      const netTotal = invoiceTotal - creditNoteTotal;

      return {
        cardCode: customer._id,
        cardName: customer.customerName || customer._id,
        totalSpent: parseFloat(netTotal.toFixed(2)),
        orderCount: customer.invoiceCount,
        lastOrderDate: customer.lastInvoiceDate,
      };
    });

    // Sort by different criteria
    const topByRevenue = [...customerNetTotals]
      .sort((a, b) => b.totalSpent - a.totalSpent)
      .slice(0, 5);

    const topByFrequency = [...customerNetTotals]
      .sort((a, b) => b.orderCount - a.orderCount)
      .slice(0, 5);

    const recentCustomers = [...customerNetTotals]
      .sort((a, b) => {
        if (!a.lastOrderDate) return 1;
        if (!b.lastOrderDate) return -1;
        return new Date(b.lastOrderDate) - new Date(a.lastOrderDate);
      })
      .slice(0, 5);

    return {
      topByRevenue,
      topByFrequency,
      recentCustomers,
    };
  } catch (error) {
    console.error("Error getting top customers:", error);
    return {
      topByRevenue: [],
      topByFrequency: [],
      recentCustomers: [],
    };
  }
}
/**
 * Get recent sales activities for an agent
 */
async function getRecentActivities(agentId, agent, startDate, endDate) {
  try {
    // Get assigned customers first
    const assignedCustomers = await Customer.find({
      assignedTo: agentId,
    }).lean();
    const customerCodes = assignedCustomers.map((c) => c.CardCode);

    // Get recent sales orders and invoices for assigned customers
    const [recentOrders, recentInvoices, recentCalls] = await Promise.all([
      // Recent sales orders for assigned customers
      customerCodes.length > 0
        ? SalesOrder.find({
          CardCode: { $in: customerCodes },
          DocDate: { $gte: startDate, $lte: endDate },
        })
          .sort({ DocDate: -1 })
          .limit(5)
          .lean()
        : [],

      // Recent invoices for assigned customers
      customerCodes.length > 0
        ? Invoice.find({
          CardCode: { $in: customerCodes },
          DocDate: { $gte: startDate, $lte: endDate },
        })
          .sort({ DocDate: -1 })
          .limit(5)
          .lean()
        : [],

      // Recent calls with updated agent matching
      CallData.find({
        startTime: { $gte: startDate, $lte: endDate },
        $or: [
          { userName: `${agent.firstName} ${agent.lastName}` },
          { userName: agent.email },
          ...(agent.phone
            ? [{ fromNumber: agent.phone }, { toNumber: agent.phone }]
            : []),
        ],
      })
        .sort({ startTime: -1 })
        .limit(5)
        .lean(),
    ]);

    // Combine and sort activities
    const activities = [
      ...recentOrders.map((order) => ({
        type: "order",
        date: order.DocDate,
        title: `Created sales order #${order.DocNum}`,
        customer: order.CardName,
        customerCode: order.CardCode,
        amount: order.DocTotal,
        status: order.DocumentStatus,
        details: {
          docEntry: order.DocEntry,
          docTotal: order.DocTotal,
          syncStatus: order.SyncedWithSAP ? "Synced with SAP" : "Not synced",
        },
      })),

      ...recentInvoices.map((invoice) => ({
        type: "invoice",
        date: invoice.DocDate,
        title: `Generated invoice #${invoice.DocNum}`,
        customer: invoice.CardName,
        customerCode: invoice.CardCode,
        amount: invoice.DocTotal,
        status: invoice.DocumentStatus,
        details: {
          docEntry: invoice.DocEntry,
          docTotal: invoice.DocTotal,
          verified: invoice.verified,
          paymentMethod: invoice.paymentMethod,
        },
      })),

      ...recentCalls.map((call) => ({
        type: "call",
        date: call.startTime,
        title: `${call.direction === "in" ? "Received" : "Made"} a call ${call.missed === "Y" ||
          call.missed === "true" ||
          call.missed === true ||
          call.missed === "1"
          ? "(Missed)"
          : ""
          }`,
        contact: call.contact || call.fromNumber || call.toNumber,
        duration: call.inCallDuration,
        direction: call.direction,
        details: {
          callID: call.callID,
          missed: call.missed,
          fromNumber: call.fromNumber,
          toNumber: call.toNumber,
          note: call.note,
        },
      })),
    ];

    // Sort by date (newest first)
    activities.sort((a, b) => new Date(b.date) - new Date(a.date));

    return activities.slice(0, 20); // Return max 20 activities
  } catch (error) {
    console.error("Error getting recent activities:", error);
    return [];
  }
}

module.exports = salesAgentJourneyController;
