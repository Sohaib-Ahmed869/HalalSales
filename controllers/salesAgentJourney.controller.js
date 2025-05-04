// controllers/salesAgentJourney.controller.js
const User = require("../models/User");
const Customer = require("../models/Customer");
const SalesOrder = require("../models/SalesOrder");
const CallData = require("../models/CallData");
const DeskTime = require("../models/desktime.model");
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

      // Get permission-based access check
      const canAccess =
        req.user._id.toString() === agentId || // Agent viewing their own data
        (req.user.role === "sales_manager" &&
          agent.manager &&
          agent.manager._id.toString() === req.user._id.toString()) || // Manager viewing their agent
        req.user.role === "admin"; // Admin can view any agent

      if (!canAccess) {
        return res.status(403).json({
          success: false,
          message: "Not authorized to view this agent's data",
        });
      }

      // Get all metrics in parallel for better performance
      const [customers, salesOrders, callData, desktimeData, targetProgress] =
        await Promise.all([
          // Get assigned customers
          Customer.find({ assignedTo: agentId }).lean(),

          // Get sales orders for this agent
          SalesOrder.find({
            salesAgent: agentId,
            DocDate: { $gte: start, $lte: end },
          })
            .sort({ DocDate: -1 })
            .lean(),

          // Get call data
          CallData.find({
            startTime: { $gte: start, $lte: end },
            userName: `${agent.firstName} ${agent.lastName}`,
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

      // Calculate summary metrics
      const summary = {
        // Customer metrics
        totalCustomers: customers.length,
        activeCustomers: customers.filter((c) => c.status === "active").length,

        // Sales metrics
        totalOrders: salesOrders.length,
        totalSales: salesOrders.reduce(
          (sum, order) => sum + (order.DocTotal || 0),
          0
        ),
        averageOrderValue:
          salesOrders.length > 0
            ? salesOrders.reduce(
                (sum, order) => sum + (order.DocTotal || 0),
                0
              ) / salesOrders.length
            : 0,

        // Call metrics
        totalCalls: callData.length,
        inboundCalls: callData.filter((call) => call.direction === "in").length,
        outboundCalls: callData.filter((call) => call.direction === "out")
          .length,
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
   * Get all customers assigned to a sales agent
   */
  getAgentCustomers: async (req, res) => {
    try {
      const { agentId } = req.params;
      const { page = 1, limit = 10, search, status } = req.query;

      // Validate sales agent
      const agent = await User.findById(agentId);
      if (!agent || agent.role !== "sales_agent") {
        return res.status(404).json({
          success: false,
          message: "Sales agent not found",
        });
      }

      // Build query
      const query = { assignedTo: agentId };

      // Add search filter if provided
      if (search) {
        query.$or = [
          { CardName: new RegExp(search, "i") },
          { CardCode: new RegExp(search, "i") },
          { Email: new RegExp(search, "i") },
        ];
      }

      // Add status filter if provided
      if (status) {
        query.status = status;
      }

      // Pagination
      const skip = (parseInt(page) - 1) * parseInt(limit);

      // Execute query
      const customers = await Customer.find(query)
        .skip(skip)
        .limit(parseInt(limit))
        .sort({ CardName: 1 });

      // Get total count
      const total = await Customer.countDocuments(query);

      return res.status(200).json({
        success: true,
        count: customers.length,
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit)),
        data: customers,
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
        userName: `${agent.firstName} ${agent.lastName}`,
      };

      // Add direction filter if provided
      if (direction && direction !== "all") {
        query.direction = direction;
      }

      // Add status filter if provided
      if (status === "missed") {
        query.missed = { $ne: "" };
      } else if (status === "answered") {
        query.missed = "";
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
        salesAgent: agentId,
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

      // Pagination
      const skip = (parseInt(page) - 1) * parseInt(limit);

      // Execute query
      const orders = await SalesOrder.find(query)
        .skip(skip)
        .limit(parseInt(limit))
        .sort({ [sortBy]: parseInt(sortDirection) });

      // Get total count
      const total = await SalesOrder.countDocuments(query);

      // Calculate order statistics
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

      return res.status(200).json({
        success: true,
        count: orders.length,
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit)),
        stats: {
          totalOrders: total,
          totalAmount: totalSales.length > 0 ? totalSales[0].totalAmount : 0,
          averageOrderValue:
            totalSales.length > 0 ? totalSales[0].avgAmount : 0,
          syncedOrders,
          failedOrders,
        },
        data: orders,
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
      const salesData = await SalesOrder.find({
        DocDate: { $gte: start, $lte: end },
        salesAgent: agentId,
      });

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
};

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
    const targetEntry = agent.targetHistory.find(
      (entry) => entry.year === currentYear && entry.month === currentMonth
    );

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
    const [salesOrders, callData, productivityData] = await Promise.all([
      // Sales orders
      SalesOrder.find({
        salesAgent: agentId,
        DocDate: { $gte: startDate, $lte: endDate },
      }).lean(),

      // Call data
      CallData.find({
        startTime: { $gte: startDate, $lte: endDate },
        userName: `${agent.firstName} ${agent.lastName}`,
      }).lean(),

      // Productivity data
      DeskTime.find({
        email: agent.email,
        date: { $gte: startDate, $lte: endDate },
      }).lean(),
    ]);

    // Process sales orders
    salesOrders.forEach((order) => {
      const date = new Date(order.DocDate);
      const dayKey = getDayKey(date);
      const weekKey = getWeekKey(date);

      if (dailyData[dayKey]) {
        dailyData[dayKey].sales += order.DocTotal || 0;
        dailyData[dayKey].orders += 1;
      }

      if (weeklyData[weekKey]) {
        weeklyData[weekKey].sales += order.DocTotal || 0;
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
        dailyData[dayKey].productivity = record.productivityPercentage || 0;
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
    // Get top customers by sales amount
    const topByRevenue = await SalesOrder.aggregate([
      {
        $match: {
          salesAgent: mongoose.Types.ObjectId(agentId),
          DocDate: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: "$CardCode",
          totalSpent: { $sum: "$DocTotal" },
          orderCount: { $sum: 1 },
          lastOrderDate: { $max: "$DocDate" },
          customerName: { $first: "$CardName" },
        },
      },
      { $sort: { totalSpent: -1 } },
      { $limit: 5 },
    ]);

    // Get top customers by order frequency
    const topByFrequency = await SalesOrder.aggregate([
      {
        $match: {
          salesAgent: mongoose.Types.ObjectId(agentId),
          DocDate: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: "$CardCode",
          totalSpent: { $sum: "$DocTotal" },
          orderCount: { $sum: 1 },
          lastOrderDate: { $max: "$DocDate" },
          customerName: { $first: "$CardName" },
        },
      },
      { $sort: { orderCount: -1 } },
      { $limit: 5 },
    ]);

    // Get most recent customer orders
    const recentOrders = await SalesOrder.aggregate([
      {
        $match: {
          salesAgent: mongoose.Types.ObjectId(agentId),
          DocDate: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: "$CardCode",
          totalSpent: { $sum: "$DocTotal" },
          orderCount: { $sum: 1 },
          lastOrderDate: { $max: "$DocDate" },
          customerName: { $first: "$CardName" },
        },
      },
      { $sort: { lastOrderDate: -1 } },
      { $limit: 5 },
    ]);

    return {
      topByRevenue: topByRevenue.map((c) => ({
        cardCode: c._id,
        cardName: c.customerName || c._id,
        totalSpent: parseFloat(c.totalSpent.toFixed(2)),
        orderCount: c.orderCount,
        lastOrderDate: c.lastOrderDate,
      })),
      topByFrequency: topByFrequency.map((c) => ({
        cardCode: c._id,
        cardName: c.customerName || c._id,
        totalSpent: parseFloat(c.totalSpent.toFixed(2)),
        orderCount: c.orderCount,
        lastOrderDate: c.lastOrderDate,
      })),
      recentCustomers: recentOrders.map((c) => ({
        cardCode: c._id,
        cardName: c.customerName || c._id,
        totalSpent: parseFloat(c.totalSpent.toFixed(2)),
        orderCount: c.orderCount,
        lastOrderDate: c.lastOrderDate,
      })),
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
    // Get recent sales orders
    const recentOrders = await SalesOrder.find({
      salesAgent: agentId,
      DocDate: { $gte: startDate, $lte: endDate },
    })
      .sort({ DocDate: -1 })
      .limit(10)
      .lean();

    // Get recent calls
    const recentCalls = await CallData.find({
      startTime: { $gte: startDate, $lte: endDate },
      userName: `${agent.firstName} ${agent.lastName}`,
    })
      .sort({ startTime: -1 })
      .limit(10)
      .lean();

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

      ...recentCalls.map((call) => ({
        type: "call",
        date: call.startTime,
        title: `${call.direction === "in" ? "Received" : "Made"} a call ${
          call.missed ? "(Missed)" : ""
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
