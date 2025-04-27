// controllers/orderController.js - Update to remove warehouse/stock checks
const SalesOrder = require("../models/SalesOrder");
const User = require("../models/User");
const Item = require("../models/item");
const customerTargetController = require("./customerTarget.controller");
const {
  formatOrderForSAP,
  createSalesOrderInSAP,
  getSalesOrderFromSAP,
  checkBusinessPartnerExists,
} = require("../utils/sapB1Integration");

// Add this helper function
async function updateSalesAgentStats(salesAgentId, order) {
  try {
    const agent = await User.findById(salesAgentId);
    if (!agent || agent.role !== "sales_agent") return;

    // Get current month and year
    const orderDate = order.DocDate;
    const month = orderDate.toLocaleString("default", { month: "short" });
    const year = orderDate.getFullYear();

    // Calculate order value
    const orderValue = order.DocTotal;

    // Find or create entry for current month/year in salesHistory
    let salesEntry = agent.salesHistory.find(
      (entry) => entry.month === month && entry.year === year
    );

    if (!salesEntry) {
      // Create new entry if it doesn't exist
      agent.salesHistory.push({
        month,
        year,
        orderCount: 1,
        totalValue: orderValue,
        orders: [order._id],
      });
    } else {
      // Update existing entry
      salesEntry.orderCount += 1;
      salesEntry.totalValue += orderValue;
      salesEntry.orders.push(order._id);
    }

    // Update target achievement
    let targetEntry = agent.targetHistory.find(
      (entry) => entry.month === month && entry.year === year
    );

    if (!targetEntry) {
      // Create new target entry with current target
      agent.targetHistory.push({
        month,
        year,
        target: agent.target,
        achieved: orderValue,
        achievementRate:
          agent.target > 0 ? (orderValue / agent.target) * 100 : 0,
      });
    } else {
      // Update existing target entry
      targetEntry.achieved += orderValue;
      targetEntry.achievementRate =
        targetEntry.target > 0
          ? (targetEntry.achieved / targetEntry.target) * 100
          : 0;
    }

    // Update overall targetAchieved
    agent.targetAchieved += orderValue;

    // Save changes
    await agent.save();
  } catch (error) {
    console.error("Error updating sales agent stats:", error);
  }
}

async function updateSalesAgentAchievement(salesAgentId, order) {
  const agent = await User.findById(salesAgentId);
  if (!agent) return;

  // You might want to add some logic here based on your business rules
  // For example, maybe achievements only count when orders are pushed to SAP

  // Maybe increment a counter of successfully synced orders
  agent.syncedOrderCount = (agent.syncedOrderCount || 0) + 1;

  await agent.save();
}

// Helper function to push order to SAP
async function pushOrderToSAPInternal(order) {
  try {
    // Format the order for SAP B1 - Note this is now async
    const sapOrder = await formatOrderForSAP(order);

    try {
      // First check if business partner exists in SAP
      const businessPartnerExists = await checkBusinessPartnerExists(
        order.CardCode
      );

      if (!businessPartnerExists) {
        // Update order to reflect BP doesn't exist in SAP
        order.SyncErrors = `Business partner ${order.CardCode} does not exist in SAP B1`;
        order.LastSyncAttempt = new Date();
        order.LocalStatus = "SyncFailed";
        order.SAPSyncDisabled = true; // Flag to indicate we shouldn't try to sync this order again
        await order.save();

        return {
          success: false,
          error: order.SyncErrors,
          code: "BP_NOT_FOUND",
        };
      }
    } catch (bpError) {
      // If BP check itself fails, continue with the order creation attempt
      console.warn(
        `Could not verify business partner in SAP: ${bpError.message}`
      );
    }

    // Push to SAP B1
    const sapResponse = await createSalesOrderInSAP(sapOrder);

    // Update local order with SAP DocEntry if successful
    if (sapResponse && sapResponse.DocEntry) {
      order.SAPDocEntry = sapResponse.DocEntry;
      order.DocumentStatus = "bost_Closed"; // Or any appropriate status
      order.UpdateDate = new Date();
      order.SyncedWithSAP = true;
      order.LocalStatus = "Synced";

      await order.save();

      // Update sales agent stats for synced order
      if (order.salesAgent) {
        await updateSalesAgentAchievement(order.salesAgent, order);
      }

      return {
        success: true,
        SAPDocEntry: sapResponse.DocEntry,
        sapData: sapResponse,
      };
    } else {
      throw new Error("Invalid response from SAP B1");
    }
  } catch (error) {
    // Check for specific error types
    let errorCode = "GENERAL_ERROR";

    if (
      error.message &&
      error.message.includes("Business partner") &&
      error.message.includes("does not exist")
    ) {
      errorCode = "BP_NOT_FOUND";
    } else if (error.message && error.message.includes("Invalid BP code")) {
      errorCode = "INVALID_BP_CODE";
    }

    // Update local order to mark sync failure
    order.SyncErrors = error.message;
    order.LastSyncAttempt = new Date();
    order.LocalStatus = "SyncFailed";

    // If BP doesn't exist, mark order to not attempt sync again
    if (errorCode === "BP_NOT_FOUND" || errorCode === "INVALID_BP_CODE") {
      order.SAPSyncDisabled = true;
    }

    await order.save();

    console.error("Error pushing order to SAP:", error);
    return {
      success: false,
      error: error.message || "Unknown error",
      code: errorCode,
    };
  }
}

// Create a new sales order (save to local DB and push to SAP)
exports.createOrder = async (req, res) => {
  try {
    // Validate required fields
    if (!req.body.CardCode) {
      return res.status(400).json({
        success: false,
        message: "Customer (CardCode) is required",
      });
    }

    const salesAgentId = req.user._id;

    // Validate that at least one document line exists
    if (!req.body.DocumentLines || req.body.DocumentLines.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Order must contain at least one item",
      });
    }

    // Validate items but don't check stock availability
    const itemCodes = req.body.DocumentLines.map((line) => line.ItemCode);
    const items = await Item.find({ ItemCode: { $in: itemCodes } });

    // Create a map for quick lookups
    const itemMap = {};
    items.forEach((item) => {
      itemMap[item.ItemCode] = item;
    });

    // Check if all items exist but don't check stock
    const invalidItems = [];
    for (const line of req.body.DocumentLines) {
      const item = itemMap[line.ItemCode];

      if (!item) {
        invalidItems.push({
          ItemCode: line.ItemCode,
          error: "Item not found",
        });
        continue;
      }

      // Add item description if not provided
      if (!line.ItemDescription && item.ItemName) {
        line.ItemDescription = item.ItemName;
      }
    }

    if (invalidItems.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Order contains invalid items",
        invalidItems,
      });
    }

    // Generate DocEntry (you might want to use a more sophisticated method)
    const lastOrder = await SalesOrder.findOne().sort({ DocEntry: -1 });
    const newDocEntry = lastOrder ? lastOrder.DocEntry + 1 : 1;

    // Calculate today's date for DocDate and DocDueDate
    const today = new Date();

    // Create the new order
    const newOrder = new SalesOrder({
      ...req.body,
      DocEntry: newDocEntry,
      DocNum: newDocEntry, // Consider separate numbering if needed
      DocType: req.body.DocType || "dDocument_Items",
      DocumentStatus: "bost_Open",
      CreationDate: today,
      StartDeliveryDate: req.body.StartDeliveryDate || today,
      DocDate: req.body.DocDate || today,
      DocDueDate: req.body.DocDueDate || today, // Ensure DocDueDate is set
      UpdateDate: today,
      SyncedWithSAP: false,
      LocalStatus: "Created", // Custom field to track local status
      salesAgent: salesAgentId,
    });

    // Calculate totals if not provided
    if (!newOrder.DocTotal) {
      let total = 0;
      for (const line of newOrder.DocumentLines) {
        const lineTotal = line.Quantity * line.Price;
        line.LineTotal = lineTotal;
        total += lineTotal;
      }
      newOrder.DocTotal = total;
    }

    // Save to local database
    await newOrder.save();

    // Update customer target
    const updatedTarget =
      await customerTargetController.updateCustomerTargetProgress(newOrder);

    // NEW CODE: Push to SAP automatically
    console.log("Automatically pushing new order to SAP...");
    const sapResult = await pushOrderToSAPInternal(newOrder);

    // Return response with both local creation and SAP push results
    if (sapResult.success) {
      res.status(201).json({
        success: true,
        data: newOrder,
        message: "Order created successfully and synced with SAP",
        targetUpdated: updatedTarget ? true : false,
        sapSync: {
          success: true,
          SAPDocEntry: sapResult.SAPDocEntry,
        },
      });
    } else {
      // Customize message based on error code
      let sapErrorMessage = "Failed to sync with SAP";

      if (
        sapResult.code === "BP_NOT_FOUND" ||
        sapResult.code === "INVALID_BP_CODE"
      ) {
        sapErrorMessage = `Business partner ${newOrder.CardCode} does not exist in SAP B1`;
      }

      res.status(201).json({
        success: true,
        data: newOrder,
        message:
          "Order created successfully in local database but failed to sync with SAP",
        targetUpdated: updatedTarget ? true : false,
        sapSync: {
          success: false,
          error: sapResult.error,
          message: sapErrorMessage,
          code: sapResult.code,
        },
      });
    }
  } catch (error) {
    console.error("Error creating order:", error);
    res.status(500).json({
      success: false,
      message: "Error creating order",
      error: error.message,
    });
  }
};
// Get all sales orders with pagination
exports.getAllOrders = async (req, res) => {
  try {
    console.log("Fetching all orders");
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // Base query
    let query = {};

    // Add filters if provided
    if (req.query.cardCode) {
      query.CardCode = req.query.cardCode;
    }

    if (req.query.status) {
      query.DocumentStatus = req.query.status;
    }

    if (req.query.fromDate && req.query.toDate) {
      query.DocDate = {
        $gte: new Date(req.query.fromDate),
        $lte: new Date(req.query.toDate),
      };
    }

    // Filter for current user if sales agent
    if (req.user.role === "sales_agent") {
      query.salesAgent = req.user._id;
    }

    // If sales manager, get all orders from their agents
    if (req.user.role === "sales_manager") {
      const agentIds = await User.find({ manager: req.user._id }).distinct(
        "_id"
      );
      query.salesAgent = { $in: agentIds };
    }

    const orders = await SalesOrder.find(query)
      .populate("salesAgent", "firstName lastName email")
      .skip(skip)
      .limit(limit)
      .sort({ DocDate: -1 });

    const total = await SalesOrder.countDocuments(query);

    res.status(200).json({
      success: true,
      count: orders.length,
      total,
      page,
      pages: Math.ceil(total / limit),
      data: orders,
    });
  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching orders",
      error: error.message,
    });
  }
};

// Get orders for a specific customer
exports.getOrdersByCustomer = async (req, res) => {
  try {
    

    const { cardCode } = req.params;
    const page = parseInt(req.query.page) || 1;

    // Base query
    const query = { CardCode: cardCode };


    const orders = await SalesOrder.find(query)
      .populate("salesAgent", "firstName lastName email")
      .sort({ DocDate: -1 });

    const total = await SalesOrder.countDocuments(query);

    console.log("Fetched orders for customer:", cardCode);

    console.log("Total orders:", total);

    res.status(200).json({
      success: true,
      count: orders.length,
      total,
      page,
      customerCode: cardCode,
      data: orders,
    });
  } catch (error) {
    console.log("Error fetching customer orders:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching customer orders",
      error: error.message,
    });
  }
};

// Get a single order by DocEntry
exports.getOrderByDocEntry = async (req, res) => {
  try {
    const order = await SalesOrder.findOne({
      DocEntry: req.params.docEntry,
    }).populate("salesAgent", "firstName lastName email");

    if (!order) {
      return res.status(404).json({
        success: false,
        message: `Order with DocEntry ${req.params.docEntry} not found`,
      });
    }

    // Check permissions for sales agents
    if (
      req.user.role === "sales_agent" &&
      order.salesAgent &&
      order.salesAgent._id.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to view this order",
      });
    }

    // Check permissions for sales managers
    if (req.user.role === "sales_manager" && order.salesAgent) {
      const agent = await User.findById(order.salesAgent._id);
      if (!agent || agent.manager.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "Not authorized to view this order",
        });
      }
    }

    res.status(200).json({
      success: true,
      data: order,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching order",
      error: error.message,
    });
  }
};

// Manual push order to SAP B1 (kept for backup or retry purposes)
exports.pushOrderToSAP = async (req, res) => {
  try {
    const order = await SalesOrder.findOne({ DocEntry: req.params.docEntry });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: `Order with DocEntry ${req.params.docEntry} not found`,
      });
    }

    // Check if already synced with SAP
    if (order.SyncedWithSAP && order.SAPDocEntry) {
      return res.status(400).json({
        success: false,
        message: `Order already synced with SAP B1 (SAP DocEntry: ${order.SAPDocEntry})`,
        SAPDocEntry: order.SAPDocEntry,
      });
    }

    // Check if sync was previously disabled due to BP not existing
    if (order.SAPSyncDisabled) {
      // Allow force sync if specifically requested
      if (req.query.force !== "true") {
        return res.status(400).json({
          success: false,
          message: `Cannot sync order: ${order.SyncErrors}. Add ?force=true to override.`,
          error: order.SyncErrors,
        });
      }
      // If force=true, continue with sync attempt and clear the flag
      order.SAPSyncDisabled = false;
      await order.save();
    }

    const sapResult = await pushOrderToSAPInternal(order);

    if (sapResult.success) {
      return res.status(200).json({
        success: true,
        message: "Order successfully pushed to SAP B1",
        SAPDocEntry: sapResult.SAPDocEntry,
        localDocEntry: order.DocEntry,
        sapData: sapResult.sapData,
      });
    } else {
      // Customize message based on error code
      let errorMessage = "Error pushing order to SAP B1";

      if (
        sapResult.code === "BP_NOT_FOUND" ||
        sapResult.code === "INVALID_BP_CODE"
      ) {
        errorMessage = `Business partner ${order.CardCode} does not exist in SAP B1`;
      }

      return res.status(400).json({
        success: false,
        message: errorMessage,
        error: sapResult.error,
        code: sapResult.code,
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error pushing order to SAP B1",
      error: error.message || "Unknown error",
    });
  }
};
