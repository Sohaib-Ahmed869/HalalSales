// controllers/dashboardController.js
const User = require("../models/User");
const CallData = require("../models/CallData");
const SalesOrder = require("../models/SalesOrder");
const mongoose = require("mongoose");

// Get all dashboard data for a sales manager in a single request
exports.getSalesManagerDashboard = async (req, res) => {
  try {
    const managerId = req.user._id;
    const { startDate, endDate } = req.query;

    // Default date range (last 30 days if not provided)
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate
      ? new Date(startDate)
      : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Get all sales agents managed by this manager
    const salesAgents = await User.find({
      role: "sales_agent",
      deactivated: false,
    }).select("-password");

    if (!salesAgents.length) {
      return res.status(200).json({
        success: true,
        data: {
          agents: [],
          teamPerformance: {
            totalTargets: 0,
            totalAchieved: 0,
            targetAchievementRate: 0,
            callsToday: 0,
            avgCallDuration: 0,
            monthlySales: [],
            topPerformers: [],
            needImprovement: [],
            salesByChannel: [],
          },
          recentCalls: [],
          salesData: [],
        },
      });
    }

    const agentIds = salesAgents.map((agent) => agent._id);

    // Get call data for all agents
    const callDataQuery = {
      startTime: { $gte: start, $lte: end },
      phone: { $in: salesAgents.map((agent) => agent.phone) },
    };

    // Get today's calls
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const callsToday = await CallData.countDocuments({
      ...callDataQuery,
      startTime: { $gte: today },
    });

    // Get average call duration
    const callDurationStats = await CallData.aggregate([
      { $match: callDataQuery },
      {
        $group: {
          _id: null,
          avgDuration: { $avg: "$inCallDuration" },
        },
      },
    ]);

    const avgCallDuration =
      callDurationStats.length > 0
        ? Math.round(callDurationStats[0].avgDuration || 0)
        : 0;

    // Get recent calls
    const recentCalls = await CallData.find(callDataQuery)
      .sort({ startTime: -1 })
      .limit(5)
      .lean();

    // Get sales orders for all agents
    const salesQuery = {
      DocDate: { $gte: start, $lte: end },
      salesAgent: { $in: agentIds },
    };

    const salesOrders = await SalesOrder.find(salesQuery)
      .sort({ DocDate: -1 })
      .lean();

    // Calculate monthly sales data
    const monthlySalesMap = {};

    salesOrders.forEach((order) => {
      const date = new Date(order.DocDate);
      const month = date.toLocaleString("default", { month: "short" });
      const year = date.getFullYear();
      const key = `${month}-${year}`;

      if (!monthlySalesMap[key]) {
        monthlySalesMap[key] = {
          month,
          year,
          sales: 0,
        };
      }

      monthlySalesMap[key].sales += order.DocTotal || 0;
    });

    const monthlySales = Object.values(monthlySalesMap)
      .sort((a, b) => {
        // Sort by year and month
        if (a.year !== b.year) return a.year - b.year;

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
      })
      .slice(-6); // Last 6 months

    // Calculate channel distribution
    const channelData = await SalesOrder.aggregate([
      { $match: salesQuery },
      {
        $group: {
          _id: "$U_Channel", // Assuming this field exists for tracking channels
          value: { $sum: 1 },
        },
      },
    ]);

    // Normalize channel data
    const salesByChannel = channelData.map((channel) => ({
      channel: channel._id || "Direct", // Default to Direct if not specified
      value: channel.value,
    }));

    // If no channel data is found, provide some default data
    if (salesByChannel.length === 0) {
      const directSalesCount = await SalesOrder.countDocuments(salesQuery);
      if (directSalesCount > 0) {
        salesByChannel.push({ channel: "Direct", value: directSalesCount });
      }
    }

    // Calculate team performance metrics
    const totalTargets = salesAgents.reduce(
      (sum, agent) => sum + (agent.target || 0),
      0
    );
    const totalAchieved = salesAgents.reduce(
      (sum, agent) => sum + (agent.targetAchieved || 0),
      0
    );
    const targetAchievementRate =
      totalTargets > 0 ? (totalAchieved / totalTargets) * 100 : 0;

    // Get top performers (by achievement rate)
    const topPerformers = [...salesAgents]
      .filter((agent) => agent.target && agent.target > 0) // Only include agents with targets
      .sort((a, b) => {
        const aRate = (a.targetAchieved || 0) / (a.target || 1);
        const bRate = (b.targetAchieved || 0) / (b.target || 1);
        return bRate - aRate;
      })
      .slice(0, 3);

    // Get agents needing improvement
    const needImprovement = [...salesAgents]
      .filter((agent) => agent.target && agent.target > 0) // Only include agents with targets
      .sort((a, b) => {
        const aRate = (a.targetAchieved || 0) / (a.target || 1);
        const bRate = (b.targetAchieved || 0) / (b.target || 1);
        return aRate - bRate;
      })
      .slice(0, 3);

    res.status(200).json({
      success: true,
      data: {
        agents: salesAgents,
        teamPerformance: {
          totalTargets,
          totalAchieved,
          targetAchievementRate,
          callsToday,
          avgCallDuration,
          monthlySales,
          topPerformers,
          needImprovement,
          salesByChannel,
        },
        recentCalls,
        salesData: monthlySales,
      },
    });
  } catch (error) {
    console.error("Error fetching dashboard data:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching dashboard data",
      error: error.message,
    });
  }
};

// Get dashboard data for a specific sales agent
exports.getSalesAgentDashboard = async (req, res) => {
  try {
    const { agentId } = req.params;
    const { startDate, endDate } = req.query;

    // Check if the agent exists and is assigned to this manager
    const agent = await User.findOne({
      _id: agentId,
      role: "sales_agent",
      deactivated: false,
    }).select("-password");

    if (!agent) {
      return res.status(404).json({
        success: false,
        message: "Sales agent not found",
      });
    }

    // Check if the current user is admin or the manager of this agent
    if (
      req.user.role !== "admin" &&
      agent.manager &&
      agent.manager.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "You don't have permission to view this agent's dashboard",
      });
    }

    // Default date range (last 30 days if not provided)
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate
      ? new Date(startDate)
      : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Get call data
    const callDataQuery = {
      startTime: { $gte: start, $lte: end },
      userID: agent._id.toString(),
    };

    // Get today's calls
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const callsToday = await CallData.countDocuments({
      ...callDataQuery,
      startTime: { $gte: today },
    });

    // Get call statistics
    const callStats = await CallData.aggregate([
      { $match: callDataQuery },
      {
        $group: {
          _id: null,
          totalCalls: { $sum: 1 },
          avgDuration: { $avg: "$inCallDuration" },
          totalDuration: { $sum: "$inCallDuration" },
          inboundCalls: {
            $sum: { $cond: [{ $eq: ["$direction", "in"] }, 1, 0] },
          },
          outboundCalls: {
            $sum: { $cond: [{ $eq: ["$direction", "out"] }, 1, 0] },
          },
          missedCalls: { $sum: { $cond: [{ $ne: ["$missed", ""] }, 1, 0] } },
        },
      },
    ]);

    const callStatistics =
      callStats.length > 0
        ? {
            totalCalls: callStats[0].totalCalls,
            avgDuration: Math.round(callStats[0].avgDuration || 0),
            totalDuration: callStats[0].totalDuration,
            inboundCalls: callStats[0].inboundCalls,
            outboundCalls: callStats[0].outboundCalls,
            missedCalls: callStats[0].missedCalls,
            callsToday,
          }
        : {
            totalCalls: 0,
            avgDuration: 0,
            totalDuration: 0,
            inboundCalls: 0,
            outboundCalls: 0,
            missedCalls: 0,
            callsToday: 0,
          };

    // Get recent calls
    const recentCalls = await CallData.find(callDataQuery)
      .sort({ startTime: -1 })
      .limit(5)
      .lean();

    // Get sales data
    const salesQuery = {
      DocDate: { $gte: start, $lte: end },
      salesAgent: agent._id,
    };

    const salesOrders = await SalesOrder.find(salesQuery)
      .sort({ DocDate: -1 })
      .lean();

    // Calculate sales statistics
    const totalSales = salesOrders.reduce(
      (sum, order) => sum + (order.DocTotal || 0),
      0
    );
    const orderCount = salesOrders.length;

    // Calculate monthly sales data
    const monthlySalesMap = {};

    salesOrders.forEach((order) => {
      const date = new Date(order.DocDate);
      const month = date.toLocaleString("default", { month: "short" });
      const year = date.getFullYear();
      const key = `${month}-${year}`;

      if (!monthlySalesMap[key]) {
        monthlySalesMap[key] = {
          month,
          year,
          sales: 0,
          orders: 0,
        };
      }

      monthlySalesMap[key].sales += order.DocTotal || 0;
      monthlySalesMap[key].orders += 1;
    });

    const monthlySales = Object.values(monthlySalesMap).sort((a, b) => {
      // Sort by year and month
      if (a.year !== b.year) return a.year - b.year;

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

    // Calculate achievement rate
    const targetAchievementRate =
      agent.target > 0 ? (agent.targetAchieved / agent.target) * 100 : 0;

    // Get target history
    const targetHistory = agent.targetHistory || [];

    res.status(200).json({
      success: true,
      data: {
        agent,
        callStatistics,
        recentCalls,
        salesStatistics: {
          totalSales,
          orderCount,
          target: agent.target || 0,
          achieved: agent.targetAchieved || 0,
          achievementRate: targetAchievementRate,
        },
        monthlySales,
        targetHistory,
        recentOrders: salesOrders.slice(0, 5), // Last 5 orders
      },
    });
  } catch (error) {
    console.error("Error fetching agent dashboard data:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching agent dashboard data",
      error: error.message,
    });
  }
};
