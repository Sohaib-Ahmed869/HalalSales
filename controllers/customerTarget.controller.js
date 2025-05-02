// controllers/customerTargetController.js
const CustomerTarget = require("../models/CustomerTarget");
const User = require("../models/User");
const SalesOrder = require("../models/SalesOrder");



// Get a single customer target by ID
exports.getCustomerTargetById = async (req, res) => {
  try {
    const targetId = req.params.id;

    const target = await CustomerTarget.findById(targetId)
      .populate("salesAgent", "firstName lastName email")
      .populate("createdBy", "firstName lastName email");

    if (!target) {
      return res.status(404).json({
        success: false,
        message: "Customer target not found",
      });
    }

    // Check permissions
    if (
      req.user.role === "sales_agent" &&
      target.salesAgent._id.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to view this target",
      });
    }

    if (
      req.user.role === "sales_manager" &&
      target.salesAgent.manager &&
      target.salesAgent.manager.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to view this target",
      });
    }

    res.status(200).json({
      success: true,
      data: target,
    });
  } catch (error) {
    console.error("Error fetching customer target:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching customer target",
      error: error.message,
    });
  }
};



// Delete a customer target
exports.deleteCustomerTarget = async (req, res) => {
  try {
    const targetId = req.params.id;

    // Find target
    const target = await CustomerTarget.findById(targetId);
    if (!target) {
      return res.status(404).json({
        success: false,
        message: "Customer target not found",
      });
    }

    // Only admins can delete targets
    if (req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Only administrators can delete targets",
      });
    }

    await CustomerTarget.findByIdAndDelete(targetId);

    res.status(200).json({
      success: true,
      message: "Customer target deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting customer target:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting customer target",
      error: error.message,
    });
  }
};

// Get customer targets for a specific agent
exports.getAgentCustomerTargets = async (req, res) => {
  try {
    const agentId = req.params.agentId;

    // Check agent exists
    const agent = await User.findById(agentId);
    if (!agent || agent.role !== "sales_agent") {
      return res.status(404).json({
        success: false,
        message: "Sales agent not found",
      });
    }

    // Permission check
    if (
      req.user.role === "sales_agent" &&
      req.user._id.toString() !== agentId
    ) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to view other agents' targets",
      });
    }

    if (
      req.user.role === "sales_manager" &&
      agent.manager.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to view this agent's targets",
      });
    }

    // Filter options
    const query = { salesAgent: agentId };

    // Status filter
    if (req.query.status) {
      query.status = req.query.status;
    }

    // Get targets
    const targets = await CustomerTarget.find(query).sort({ deadline: 1 });

    res.status(200).json({
      success: true,
      count: targets.length,
      data: targets,
    });
  } catch (error) {
    console.error("Error fetching agent's customer targets:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching agent's customer targets",
      error: error.message,
    });
  }
};

// Get customer targets for a specific customer
exports.getCustomerTargetsByCustomer = async (req, res) => {
  try {
    const { cardCode } = req.params;

    // Base query
    const query = { cardCode };

    // Permission restrictions
    if (req.user.role === "sales_agent") {
      query.salesAgent = req.user._id;
    } else if (req.user.role === "sales_manager") {
      const agentIds = await User.find({ manager: req.user._id }).distinct(
        "_id"
      );
      query.salesAgent = { $in: agentIds };
    }

    // Get targets
    const targets = await CustomerTarget.find(query)
      .populate("salesAgent", "firstName lastName email")
      .sort({ deadline: 1 });

    res.status(200).json({
      success: true,
      count: targets.length,
      data: targets,
    });
  } catch (error) {
    console.error("Error fetching customer targets:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching customer targets",
      error: error.message,
    });
  }
};



// Helper function to check if a sales agent is managed by a specific user
async function isSalesAgentManagedByUser(agentId, managerId) {
  const agent = await User.findById(agentId);
  return (
    agent && agent.manager && agent.manager.toString() === managerId.toString()
  );
}

// Get dashboard summary of customer targets
exports.getCustomerTargetsDashboard = async (req, res) => {
  try {
    // Base query
    let query = {};

    // Permission-based filtering
    if (req.user.role === "sales_agent") {
      query.salesAgent = req.user._id;
    } else if (req.user.role === "sales_manager") {
      const agentIds = await User.find({ manager: req.user._id }).distinct(
        "_id"
      );
      query.salesAgent = { $in: agentIds };
    }

    // Get all relevant targets
    const allTargets = await CustomerTarget.find(query).populate(
      "salesAgent",
      "firstName lastName"
    );

    // Active targets
    const activeTargets = allTargets.filter((t) => t.status === "active");

    // Completed targets
    const completedTargets = allTargets.filter((t) => t.status === "completed");

    // Expired targets
    const expiredTargets = allTargets.filter((t) => t.status === "expired");

    // Calculate total target amount and achieved amount
    const totalTargetAmount = allTargets.reduce(
      (sum, t) => sum + t.targetAmount,
      0
    );
    const totalAchievedAmount = allTargets.reduce(
      (sum, t) => sum + t.achievedAmount,
      0
    );
    const overallAchievementRate =
      totalTargetAmount > 0
        ? (totalAchievedAmount / totalTargetAmount) * 100
        : 0;

    // Get targets close to deadline (within 7 days)
    const now = new Date();
    const sevenDaysLater = new Date(now);
    sevenDaysLater.setDate(now.getDate() + 7);

    const closeToDeadline = activeTargets.filter(
      (t) => t.deadline >= now && t.deadline <= sevenDaysLater
    );

    // Get highest achieving targets
    const highestAchieving = [...allTargets]
      .sort((a, b) => b.achievementRate - a.achievementRate)
      .slice(0, 5);

    // Get lowest achieving active targets
    const lowestAchieving = [...activeTargets]
      .sort((a, b) => a.achievementRate - b.achievementRate)
      .slice(0, 5);

    // Return dashboard data
    res.status(200).json({
      success: true,
      data: {
        summary: {
          totalTargets: allTargets.length,
          activeTargets: activeTargets.length,
          completedTargets: completedTargets.length,
          expiredTargets: expiredTargets.length,
          totalTargetAmount,
          totalAchievedAmount,
          overallAchievementRate: parseFloat(overallAchievementRate.toFixed(2)),
        },
        closeToDeadline: closeToDeadline.map((t) => ({
          id: t._id,
          customer: t.cardName,
          targetAmount: t.targetAmount,
          achievedAmount: t.achievedAmount,
          achievementRate: t.achievementRate,
          deadline: t.deadline,
          salesAgent: `${t.salesAgent.firstName} ${t.salesAgent.lastName}`,
        })),
        highestAchieving: highestAchieving.map((t) => ({
          id: t._id,
          customer: t.cardName,
          targetAmount: t.targetAmount,
          achievedAmount: t.achievedAmount,
          achievementRate: parseFloat(t.achievementRate.toFixed(2)),
          deadline: t.deadline,
          salesAgent: `${t.salesAgent.firstName} ${t.salesAgent.lastName}`,
          status: t.status,
        })),
        lowestAchieving: lowestAchieving.map((t) => ({
          id: t._id,
          customer: t.cardName,
          targetAmount: t.targetAmount,
          achievedAmount: t.achievedAmount,
          achievementRate: parseFloat(t.achievementRate.toFixed(2)),
          deadline: t.deadline,
          salesAgent: `${t.salesAgent.firstName} ${t.salesAgent.lastName}`,
        })),
      },
    });
  } catch (error) {
    console.error("Error generating dashboard:", error);
    res.status(500).json({
      success: false,
      message: "Error generating dashboard",
      error: error.message,
    });
  }
};

exports.createCustomerTarget = async (req, res) => {
  try {
    const { 
      cardCode, 
      cardName, 
      targetAmount, 
      salesAgentId, 
      notes,
      period = "monthly",
      isRecurring = true 
    } = req.body;

    // Validate required fields
    if (!cardCode || !cardName || !targetAmount || !salesAgentId) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields",
      });
    }

    // Validate sales agent exists and is a sales agent
    const salesAgent = await User.findById(salesAgentId);
    if (!salesAgent || salesAgent.role !== "sales_agent") {
      return res.status(400).json({
        success: false,
        message: "Invalid sales agent",
      });
    }

    // Permission check - only admin and sales managers can create targets
    if (req.user.role === "sales_agent") {
      return res.status(403).json({
        success: false,
        message: "Not authorized to create customer targets",
      });
    }

    // Sales managers can only create targets for their agents
    if (
      req.user.role === "sales_manager" &&
      salesAgent.manager.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to create targets for this agent",
      });
    }

    // Set up the current period based on the chosen period type
    const now = new Date();
    let currentPeriodStart, currentPeriodEnd;
    
    if (period === "monthly") {
      currentPeriodStart = new Date(now.getFullYear(), now.getMonth(), 1);
      currentPeriodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    } else if (period === "quarterly") {
      const quarter = Math.floor(now.getMonth() / 3);
      currentPeriodStart = new Date(now.getFullYear(), quarter * 3, 1);
      currentPeriodEnd = new Date(now.getFullYear(), (quarter + 1) * 3, 0);
    } else if (period === "yearly") {
      currentPeriodStart = new Date(now.getFullYear(), 0, 1);
      currentPeriodEnd = new Date(now.getFullYear(), 11, 31);
    }

    // Create new customer target with recurring settings
    const newTarget = new CustomerTarget({
      cardCode,
      cardName,
      targetAmount,
      isRecurring,
      period,
      currentPeriodStart,
      currentPeriodEnd,
      deadline: currentPeriodEnd, // For backwards compatibility
      startDate: new Date(),
      salesAgent: salesAgentId,
      createdBy: req.user._id,
      notes,
    });

    await newTarget.save();

    res.status(201).json({
      success: true,
      data: newTarget,
      message: "Customer target created successfully",
    });
  } catch (error) {
    console.error("Error creating customer target:", error);
    res.status(500).json({
      success: false,
      message: "Error creating customer target",
      error: error.message,
    });
  }
};

// Get all customer targets with filtering and pagination
exports.getAllCustomerTargets = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // Base query
    let query = {};

    // Filter by sales agent if agent ID is provided
    if (req.query.salesAgentId) {
      query.salesAgent = req.query.salesAgentId;
    }

    // Filter by customer if customer code is provided
    if (req.query.cardCode) {
      query.cardCode = req.query.cardCode;
    }

    // Filter by status
    if (req.query.status) {
      query.status = req.query.status;
    }

    // Filter by period type
    if (req.query.period) {
      query.period = req.query.period;
    }

    // Restrict to agent's own targets if user is sales agent
    if (req.user.role === "sales_agent") {
      query.salesAgent = req.user._id;
    }

    // Restrict to manager's agents if user is sales manager
    if (req.user.role === "sales_manager") {
      const agentIds = await User.find({ manager: req.user._id }).distinct(
        "_id"
      );
      query.salesAgent = { $in: agentIds };
    }

    // Get targets with pagination
    const targets = await CustomerTarget.find(query)
      .populate("salesAgent", "firstName lastName email")
      .populate("createdBy", "firstName lastName email")
      .skip(skip)
      .limit(limit)
      .sort({ currentPeriodEnd: 1 });

    // Count total
    const total = await CustomerTarget.countDocuments(query);

    res.status(200).json({
      success: true,
      count: targets.length,
      total,
      page,
      pages: Math.ceil(total / limit),
      data: targets,
    });
  } catch (error) {
    console.error("Error fetching customer targets:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching customer targets",
      error: error.message,
    });
  }
};

// Update a customer target
exports.updateCustomerTarget = async (req, res) => {
  try {
    const targetId = req.params.id;
    const { 
      targetAmount, 
      notes, 
      status, 
      period,
      isRecurring 
    } = req.body;

    // Find target
    const target = await CustomerTarget.findById(targetId);
    if (!target) {
      return res.status(404).json({
        success: false,
        message: "Customer target not found",
      });
    }

    // Check permissions
    if (req.user.role === "sales_agent") {
      return res.status(403).json({
        success: false,
        message: "Not authorized to update targets",
      });
    }

    if (
      req.user.role === "sales_manager" &&
      target.salesAgent &&
      !(await isSalesAgentManagedByUser(target.salesAgent, req.user._id))
    ) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to update this target",
      });
    }

    // Update fields
    if (targetAmount !== undefined) target.targetAmount = targetAmount;
    if (notes !== undefined) target.notes = notes;
    if (status !== undefined) target.status = status;
    
    // Update recurring settings if provided
    if (isRecurring !== undefined) target.isRecurring = isRecurring;
    
    // Update period type if provided and recalculate period dates
    if (period !== undefined && period !== target.period) {
      target.period = period;
      
      const now = new Date();
      
      // Calculate new period dates based on period type
      if (period === "monthly") {
        target.currentPeriodStart = new Date(now.getFullYear(), now.getMonth(), 1);
        target.currentPeriodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      } else if (period === "quarterly") {
        const quarter = Math.floor(now.getMonth() / 3);
        target.currentPeriodStart = new Date(now.getFullYear(), quarter * 3, 1);
        target.currentPeriodEnd = new Date(now.getFullYear(), (quarter + 1) * 3, 0);
      } else if (period === "yearly") {
        target.currentPeriodStart = new Date(now.getFullYear(), 0, 1);
        target.currentPeriodEnd = new Date(now.getFullYear(), 11, 31);
      }
      
      // Update deadline for backward compatibility
      target.deadline = target.currentPeriodEnd;
    }

    // Recalculate achievement rate if target amount changed
    if (targetAmount !== undefined) {
      target.achievementRate = (target.achievedAmount / targetAmount) * 100;
    }

    await target.save();

    res.status(200).json({
      success: true,
      data: target,
      message: "Customer target updated successfully",
    });
  } catch (error) {
    console.error("Error updating customer target:", error);
    res.status(500).json({
      success: false,
      message: "Error updating customer target",
      error: error.message,
    });
  }
};

// Get customer targets for a specific customer
exports.getCustomerTargets = async (req, res) => {
  try {
    const { cardCode } = req.params;

    // Base query
    const query = { cardCode };

    // Permission restrictions
    if (req.user.role === "sales_agent") {
      query.salesAgent = req.user._id;
    } else if (req.user.role === "sales_manager") {
      const agentIds = await User.find({ manager: req.user._id }).distinct(
        "_id"
      );
      query.salesAgent = { $in: agentIds };
    }

    // Get targets
    const targets = await CustomerTarget.find(query)
      .populate("salesAgent", "firstName lastName email")
      .sort({ currentPeriodEnd: 1 });

    res.status(200).json({
      success: true,
      count: targets.length,
      data: targets,
    });
  } catch (error) {
    console.error("Error fetching customer targets:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching customer targets",
      error: error.message,
    });
  }
};

// Helper to update customer target progress when a sales order is created
exports.updateCustomerTargetProgress = async (order) => {
  try {
    if (!order.CardCode || !order.salesAgent || !order.DocTotal) {
      console.log("Insufficient data to update customer target");
      return;
    }

    // Find active targets for this customer and sales agent
    const targets = await CustomerTarget.find({
      cardCode: order.CardCode,
      salesAgent: order.salesAgent,
      status: "active",
    });

    if (targets.length === 0) {
      console.log(`No active targets found for customer ${order.CardCode}`);
      return;
    }

    // Get current date to check which targets are in the current period
    const orderDate = order.DocDate ? new Date(order.DocDate) : new Date();
    
    // Filter for targets where the order falls within the current period
    const currentPeriodTargets = targets.filter(target => 
      orderDate >= target.currentPeriodStart && 
      orderDate <= target.currentPeriodEnd
    );
    
    if (currentPeriodTargets.length === 0) {
      console.log(`No targets found in the current period for customer ${order.CardCode}`);
      return;
    }

    // Update the most recent target if multiple exist
    const target = currentPeriodTargets.sort((a, b) => b.createdAt - a.createdAt)[0];

    // Update target with this order
    target.achievedAmount += order.DocTotal;
    target.achievementRate = (target.achievedAmount / target.targetAmount) * 100;

    // Add order to the list
    target.orders.push({
      orderId: order._id,
      docEntry: order.DocEntry,
      docTotal: order.DocTotal,
      docDate: order.DocDate,
    });

    // Check if target is completed for this period
    if (target.achievedAmount >= target.targetAmount) {
      // For recurring targets, we don't mark it as completed permanently
      if (!target.isRecurring) {
        target.status = "completed";
      }
    }

    await target.save();
    console.log(
      `Updated target for customer ${order.CardCode}, new achieved amount: ${target.achievedAmount}`
    );

    return target;
  } catch (error) {
    console.error("Error updating customer target progress:", error);
  }
};



// Function to roll over to a new period - can be scheduled to run at the start of each month
exports.rolloverTargetPeriods = async () => {
  try {
    // Get current date
    const now = new Date();
    
    // Find all active recurring targets that need to be rolled over (their period has ended)
    const targetsToRollover = await CustomerTarget.find({
      isRecurring: true,
      status: "active",
      currentPeriodEnd: { $lt: now }
    });
    
    console.log(`Rolling over ${targetsToRollover.length} targets to new period`);
    
    // Process each target
    for (const target of targetsToRollover) {
      // Use the helper method to start a new period
      target.startNewPeriod();
      await target.save();
    }
    
    return {
      success: true,
      count: targetsToRollover.length,
      message: `Successfully rolled over ${targetsToRollover.length} targets to new period`
    };
  } catch (error) {
    console.error("Error rolling over target periods:", error);
    return {
      success: false,
      error: error.message
    };
  }
};

// New endpoint to manually trigger rollover for a specific target
exports.manualRolloverTarget = async (req, res) => {
  try {
    const { targetId } = req.params;
    
    // Find the target
    const target = await CustomerTarget.findById(targetId);
    if (!target) {
      return res.status(404).json({
        success: false,
        message: "Target not found"
      });
    }
    
    // Check if it's recurring
    if (!target.isRecurring) {
      return res.status(400).json({
        success: false,
        message: "Only recurring targets can be rolled over to a new period"
      });
    }
    
    // Roll over the target
    target.startNewPeriod();
    await target.save();
    
    return res.status(200).json({
      success: true,
      message: "Target successfully rolled over to new period",
      data: target
    });
  } catch (error) {
    console.error("Error in manual target rollover:", error);
    return res.status(500).json({
      success: false,
      message: "Error rolling over target",
      error: error.message
    });
  }
};