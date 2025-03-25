// controllers/orderController.js
const SalesOrder = require("../models/SalesOrder");
const User = require("../models/User");
const Item = require("../models/item");
const {
  formatOrderForSAP,
  createSalesOrderInSAP,
  getSalesOrderFromSAP,
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


// Create a new sales order (save to local DB)
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

    // Validate items and check stock availability
    const itemCodes = req.body.DocumentLines.map((line) => line.ItemCode);
    const items = await Item.find({ ItemCode: { $in: itemCodes } });

    // Create a map for quick lookups
    const itemMap = {};
    items.forEach((item) => {
      itemMap[item.ItemCode] = item;
    });

    // Check if all items exist and have enough stock
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

      // Find warehouse specific stock
      let warehouseStock = 0;
      if (line.WarehouseCode && item.ItemWarehouseInfoCollection) {
        const warehouse = item.ItemWarehouseInfoCollection.find(
          (wh) => wh.WarehouseCode === line.WarehouseCode
        );
        if (warehouse) {
          warehouseStock = warehouse.InStock;
        }
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

    // Create the new order
    const newOrder = new SalesOrder({
      ...req.body,
      DocEntry: newDocEntry,
      DocNum: newDocEntry, // Consider separate numbering if needed
      DocType: req.body.DocType || "dDocument_Items",
      DocumentStatus: "bost_Open",
      CreationDate: new Date(),
      StartDeliveryDate: req.body.StartDeliveryDate || new Date(),
      DocDate: req.body.DocDate || new Date(),
      UpdateDate: new Date(),
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

    await updateSalesAgentStats(salesAgentId, newOrder);

    res.status(201).json({
      success: true,
      data: newOrder,
      message: "Order created successfully in local database",
    });
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

    const orders = await SalesOrder.find(query)
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
    res.status(500).json({
      success: false,
      message: "Error fetching orders",
      error: error.message,
    });
  }
};

// Get a single order by DocEntry
exports.getOrderByDocEntry = async (req, res) => {
  try {
    const order = await SalesOrder.findOne({ DocEntry: req.params.docEntry });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: `Order with DocEntry ${req.params.docEntry} not found`,
      });
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

// Push order to SAP B1
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

    // Format the order for SAP B1
    const sapOrder = formatOrderForSAP(order);

    try {
      // Push to SAP B1
      const sapResponse = await createSalesOrderInSAP(sapOrder);

      // Update local order with SAP DocEntry
      if (sapResponse && sapResponse.DocEntry) {
        order.SAPDocEntry = sapResponse.DocEntry;
        order.DocumentStatus = "bost_Closed"; // Or any appropriate status
        order.UpdateDate = new Date();
        order.SyncedWithSAP = true;
        order.LocalStatus = "Synced";

        await order.save();

        return res.status(200).json({
          success: true,
          message: "Order successfully pushed to SAP B1",
          SAPDocEntry: sapResponse.DocEntry,
          localDocEntry: order.DocEntry,
          sapData: sapResponse,
        });
      } else {
        throw new Error("Invalid response from SAP B1");
      }
    } catch (error) {
      // Update local order to mark sync failure
      order.SyncErrors = error.message;
      order.LastSyncAttempt = new Date();
      order.LocalStatus = "SyncFailed";
      await order.save();

      throw error;
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error pushing order to SAP B1",
      error: error.message || "Unknown error",
    });
  }
};
