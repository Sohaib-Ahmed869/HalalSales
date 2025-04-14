const Deal = require("../models/Deal");

// Helper function to handle errors
const handleError = (res, error) => {
  console.error("Error:", error);
  return res
    .status(500)
    .json({ success: false, message: "Server error", error: error.message });
};

// Get all deals with pagination
exports.getDeals = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const deals = await Deal.find()
      .sort({ createDate: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Deal.countDocuments();

    res.status(200).json({
      success: true,
      count: deals.length,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      data: deals,
    });
  } catch (error) {
    handleError(res, error);
  }
};

// Get a single deal by ID
exports.getDealById = async (req, res) => {
  try {
    const deal = await Deal.findById(req.params.id);

    if (!deal) {
      return res
        .status(404)
        .json({ success: false, message: "Deal not found" });
    }

    res.status(200).json({ success: true, data: deal });
  } catch (error) {
    handleError(res, error);
  }
};

// Create a new deal
exports.createDeal = async (req, res) => {
  try {
    const deal = await Deal.create(req.body);
    res.status(201).json({ success: true, data: deal });
  } catch (error) {
    handleError(res, error);
  }
};

// Update a deal
exports.updateDeal = async (req, res) => {
  try {
    const deal = await Deal.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });

    if (!deal) {
      return res
        .status(404)
        .json({ success: false, message: "Deal not found" });
    }

    res.status(200).json({ success: true, data: deal });
  } catch (error) {
    handleError(res, error);
  }
};

// Add this to your controllers/deals.controller.js file

// Get customer details and their deals
exports.getCustomerDeals = async (req, res) => {
  try {
    // Get customers with their deals
    const customers = await Deal.aggregate([
      // Group by customer email
      {
        $group: {
          _id: "$customerEmail",
          customerName: { $first: "$customerName" },
          deals: { $push: "$$ROOT" },
          totalSpent: {
            $sum: { $cond: [{ $eq: ["$isClosedWon", true] }, "$amount", 0] },
          },
          orderCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$isClosedWon", true] },
                    { $ne: ["$orderNumber", null] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          lastPurchaseDate: {
            $max: {
              $cond: [{ $eq: ["$isClosedWon", true] }, "$closeDate", null],
            },
          },
          abandonedCartsCount: {
            $sum: { $cond: [{ $eq: ["$orderNumber", null] }, 1, 0] },
          },
        },
      },
      // Filter out null emails
      {
        $match: {
          _id: { $ne: null, $ne: "" },
        },
      },
      // Sort by total spent (highest first)
      {
        $sort: { totalSpent: -1 },
      },
      // Add pagination
      {
        $skip: parseInt(req.query.skip) || 0,
      },
      {
        $limit: parseInt(req.query.limit) || 20,
      },
      {
        allowDiskUse: true,
      },
    ]);

    res.status(200).json({
      success: true,
      count: customers.length,
      data: customers,
    });
  } catch (error) {
    handleError(res, error);
  }
};

// Get details for a specific customer
exports.getCustomerDetail = async (req, res) => {
  try {
    const customerEmail = req.params.email;

    // Validate email parameter
    if (!customerEmail) {
      return res.status(400).json({
        success: false,
        message: "Customer email is required",
      });
    }

    // Find all deals for this customer
    const deals = await Deal.find({ customerEmail: customerEmail }).sort({
      createDate: -1,
    });

    if (deals.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No customer found with this email",
      });
    }

    // Calculate customer metrics
    const customerData = {
      email: customerEmail,
      name: deals[0].customerName,
      totalDeals: deals.length,
      completedPurchases: deals.filter((d) => d.isClosedWon && d.orderNumber)
        .length,
      abandonedCarts: deals.filter((d) => !d.orderNumber).length,
      totalSpent: deals.reduce(
        (sum, deal) => (deal.isClosedWon ? sum + (deal.amount || 0) : sum),
        0
      ),
      avgOrderValue:
        deals
          .filter((d) => d.isClosedWon)
          .reduce((sum, deal) => sum + (deal.amount || 0), 0) /
        (deals.filter((d) => d.isClosedWon).length || 1),
      lastPurchaseDate: deals
        .filter((d) => d.isClosedWon)
        .sort((a, b) => new Date(b.closeDate) - new Date(a.closeDate))[0]
        ?.closeDate,
      contactInfo: deals[0].contactInfo,
      deals: deals,
    };

    res.status(200).json({
      success: true,
      data: customerData,
    });
  } catch (error) {
    handleError(res, error);
  }
};

// Delete a deal
exports.deleteDeal = async (req, res) => {
  try {
    const deal = await Deal.findByIdAndDelete(req.params.id);

    if (!deal) {
      return res
        .status(404)
        .json({ success: false, message: "Deal not found" });
    }

    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    handleError(res, error);
  }
};

// ANALYTICS ENDPOINTS

// Get abandoned carts
exports.getAbandonedCarts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const daysAgo = parseInt(req.query.daysAgo) || 30; // Default to last 30 days

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysAgo);

    const query = {
      orderNumber: null,
      createDate: { $gte: startDate },
    };

    const abandonedCarts = await Deal.find(query)
      .sort({ createDate: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Deal.countDocuments(query);

    res.status(200).json({
      success: true,
      count: abandonedCarts.length,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      data: abandonedCarts,
    });
  } catch (error) {
    handleError(res, error);
  }
};

// Get abandoned cart recovery opportunities (with contact info)
exports.getAbandonedCartRecoveryOpportunities = async (req, res) => {
  try {
    const query = {
      orderNumber: null,
      $or: [
        { "contactInfo.email": { $ne: null, $ne: "" } },
        { "contactInfo.phone": { $ne: null, $ne: "" } },
        { "contactInfo.mobilePhone": { $ne: null, $ne: "" } },
        { customerEmail: { $ne: null, $ne: "" } },
      ],
    };

    const abandonedCartsWithContact = await Deal.find(query)
      .sort({ amount: -1 }) // Sort by cart value (highest first)
      .limit(100);

    res.status(200).json({
      success: true,
      count: abandonedCartsWithContact.length,
      data: abandonedCartsWithContact,
    });
  } catch (error) {
    handleError(res, error);
  }
};

// Get sales performance over time
exports.getSalesPerformance = async (req, res) => {
  try {
    const period = req.query.period || "monthly"; // daily, weekly, monthly, yearly
    const months = parseInt(req.query.months) || 12; // Default to last 12 months

    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);

    let groupBy;

    // Set up date grouping format based on period
    if (period === "daily") {
      groupBy = { $dateToString: { format: "%Y-%m-%d", date: "$closeDate" } };
    } else if (period === "weekly") {
      groupBy = {
        year: { $year: "$closeDate" },
        week: { $week: "$closeDate" },
      };
    } else if (period === "monthly") {
      groupBy = {
        year: { $year: "$closeDate" },
        month: { $month: "$closeDate" },
      };
    } else {
      groupBy = { $year: "$closeDate" };
    }

    const salesData = await Deal.aggregate([
      {
        $match: {
          closeDate: { $gte: startDate },
          isClosedWon: true,
        },
      },
      {
        $group: {
          _id: groupBy,
          totalSales: { $sum: "$amount" },
          count: { $sum: 1 },
          avgOrderValue: { $avg: "$amount" },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.status(200).json({
      success: true,
      period: period,
      data: salesData,
    });
  } catch (error) {
    handleError(res, error);
  }
};

// Get product performance
exports.getProductPerformance = async (req, res) => {
  try {
    const timeframe = req.query.timeframe || "all"; // all, month, quarter, year

    let dateFilter = {};
    const now = new Date();

    if (timeframe === "month") {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      dateFilter = { closeDate: { $gte: startOfMonth } };
    } else if (timeframe === "quarter") {
      const quarterMonth = Math.floor(now.getMonth() / 3) * 3;
      const startOfQuarter = new Date(now.getFullYear(), quarterMonth, 1);
      dateFilter = { closeDate: { $gte: startOfQuarter } };
    } else if (timeframe === "year") {
      const startOfYear = new Date(now.getFullYear(), 0, 1);
      dateFilter = { closeDate: { $gte: startOfYear } };
    }

    const productPerformance = await Deal.aggregate([
      {
        $match: {
          isClosedWon: true,
          ...dateFilter,
        },
      },
      { $unwind: "$products" },
      {
        $group: {
          _id: "$products.name",
          totalQuantity: { $sum: "$products.quantity" },
          totalRevenue: { $sum: "$products.totalPrice" },
          averagePrice: { $avg: "$products.price" },
          count: { $sum: 1 },
        },
      },
      { $sort: { totalRevenue: -1 } },
    ]);

    res.status(200).json({
      success: true,
      timeframe: timeframe,
      count: productPerformance.length,
      data: productPerformance,
    });
  } catch (error) {
    handleError(res, error);
  }
};

// Get conversion rate stats
exports.getConversionStats = async (req, res) => {
  try {
    const period = req.query.period || "all"; // all, month, quarter, year

    let dateFilter = {};
    const now = new Date();

    if (period === "month") {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      dateFilter = { createDate: { $gte: startOfMonth } };
    } else if (period === "quarter") {
      const quarterMonth = Math.floor(now.getMonth() / 3) * 3;
      const startOfQuarter = new Date(now.getFullYear(), quarterMonth, 1);
      dateFilter = { createDate: { $gte: startOfQuarter } };
    } else if (period === "year") {
      const startOfYear = new Date(now.getFullYear(), 0, 1);
      dateFilter = { createDate: { $gte: startOfYear } };
    }

    // Total deals created in period
    const totalDeals = await Deal.countDocuments(dateFilter);

    // Completed purchases
    const completedPurchases = await Deal.countDocuments({
      ...dateFilter,
      orderNumber: { $ne: null },
    });

    // Abandoned carts
    const abandonedCarts = await Deal.countDocuments({
      ...dateFilter,
      orderNumber: null,
    });

    // Average value of abandoned carts
    const avgAbandonedValue = await Deal.aggregate([
      {
        $match: {
          ...dateFilter,
          orderNumber: null,
          amount: { $ne: null, $gt: 0 },
        },
      },
      {
        $group: {
          _id: null,
          avgValue: { $avg: "$amount" },
        },
      },
    ]);

    // Calculate conversion rate
    const conversionRate =
      totalDeals > 0 ? (completedPurchases / totalDeals) * 100 : 0;

    res.status(200).json({
      success: true,
      period: period,
      data: {
        totalDeals,
        completedPurchases,
        abandonedCarts,
        conversionRate: conversionRate.toFixed(2) + "%",
        avgAbandonedCartValue:
          avgAbandonedValue.length > 0 ? avgAbandonedValue[0].avgValue : 0,
      },
    });
  } catch (error) {
    handleError(res, error);
  }
};

// Get customer insights
exports.getCustomerInsights = async (req, res) => {
  try {
    // Find customers with repeat purchases
    const repeatCustomers = await Deal.aggregate([
      {
        $match: {
          isClosedWon: true,
          customerEmail: { $ne: null, $ne: "" },
        },
      },
      {
        $group: {
          _id: "$customerEmail",
          customerName: { $first: "$customerName" },
          totalSpent: { $sum: "$amount" },
          purchaseCount: { $sum: 1 },
          lastPurchaseDate: { $max: "$closeDate" },
          avgOrderValue: { $avg: "$amount" },
        },
      },
      {
        $match: {
          purchaseCount: { $gt: 1 },
        },
      },
      {
        $sort: { purchaseCount: -1, totalSpent: -1 },
      },
      {
        $limit: 100,
      },
    ]);

    res.status(200).json({
      success: true,
      count: repeatCustomers.length,
      data: repeatCustomers,
    });
  } catch (error) {
    handleError(res, error);
  }
};

// Get abandoned cart analytics by time
exports.getAbandonedCartAnalytics = async (req, res) => {
  try {
    const timeframe = req.query.timeframe || "monthly"; // daily, weekly, monthly

    let groupBy;
    if (timeframe === "daily") {
      groupBy = { $dateToString: { format: "%Y-%m-%d", date: "$createDate" } };
    } else if (timeframe === "weekly") {
      groupBy = {
        year: { $year: "$createDate" },
        week: { $week: "$createDate" },
      };
    } else {
      groupBy = {
        year: { $year: "$createDate" },
        month: { $month: "$createDate" },
      };
    }

    const abandonedCartStats = await Deal.aggregate([
      {
        $match: {
          orderNumber: null,
          createDate: { $ne: null },
        },
      },
      {
        $group: {
          _id: groupBy,
          count: { $sum: 1 },
          totalValue: { $sum: "$amount" },
          avgValue: { $avg: "$amount" },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.status(200).json({
      success: true,
      timeframe: timeframe,
      data: abandonedCartStats,
    });
  } catch (error) {
    handleError(res, error);
  }
};

// Get top abandoned products
exports.getTopAbandonedProducts = async (req, res) => {
  try {
    const abandonedProducts = await Deal.aggregate([
      {
        $match: {
          orderNumber: null,
          "products.0": { $exists: true },
        },
      },
      { $unwind: "$products" },
      {
        $group: {
          _id: "$products.name",
          count: { $sum: 1 },
          totalQuantity: { $sum: "$products.quantity" },
          totalValue: { $sum: "$products.totalPrice" },
          avgPrice: { $avg: "$products.price" },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]);

    res.status(200).json({
      success: true,
      count: abandonedProducts.length,
      data: abandonedProducts,
    });
  } catch (error) {
    handleError(res, error);
  }
};

// Get pipeline stage analytics
exports.getPipelineAnalytics = async (req, res) => {
  try {
    const pipelineStats = await Deal.aggregate([
      {
        $group: {
          _id: {
            pipeline: "$pipeline",
            stage: "$dealStage",
          },
          count: { $sum: 1 },
          totalValue: { $sum: "$amount" },
          avgValue: { $avg: "$amount" },
        },
      },
      {
        $sort: { "_id.pipeline": 1, "_id.stage": 1 },
      },
    ]);

    res.status(200).json({
      success: true,
      data: pipelineStats,
    });
  } catch (error) {
    handleError(res, error);
  }
};

// Get deal sources analytics
exports.getDealSourcesAnalytics = async (req, res) => {
  try {
    const sourcesStats = await Deal.aggregate([
      {
        $group: {
          _id: {
            source: "$source",
            sourceDetail: "$sourceDetail",
          },
          count: { $sum: 1 },
          closedWon: {
            $sum: { $cond: [{ $eq: ["$isClosedWon", true] }, 1, 0] },
          },
          closedLost: {
            $sum: { $cond: [{ $eq: ["$isClosedLost", true] }, 1, 0] },
          },
          totalValue: { $sum: "$amount" },
          wonValue: {
            $sum: {
              $cond: [{ $eq: ["$isClosedWon", true] }, "$amount", 0],
            },
          },
        },
      },
      {
        $project: {
          _id: 1,
          count: 1,
          closedWon: 1,
          closedLost: 1,
          totalValue: 1,
          wonValue: 1,
          conversionRate: {
            $multiply: [{ $divide: ["$closedWon", "$count"] }, 100],
          },
        },
      },
      { $sort: { wonValue: -1 } },
    ]);

    res.status(200).json({
      success: true,
      count: sourcesStats.length,
      data: sourcesStats,
    });
  } catch (error) {
    handleError(res, error);
  }
};

// Export abandoned cart data
exports.exportAbandonedCarts = async (req, res) => {
  try {
    const daysAgo = parseInt(req.query.daysAgo) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysAgo);

    const abandonedCarts = await Deal.find({
      orderNumber: null,
      createDate: { $gte: startDate },
      $or: [
        { "contactInfo.email": { $ne: null } },
        { customerEmail: { $ne: null } },
      ],
    }).select(
      "customerName customerEmail contactInfo.email abandonedCartUrl amount products createDate"
    );

    res.status(200).json({
      success: true,
      count: abandonedCarts.length,
      data: abandonedCarts,
    });
  } catch (error) {
    handleError(res, error);
  }
};
