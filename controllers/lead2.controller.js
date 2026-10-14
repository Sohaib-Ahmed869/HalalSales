// controllers/lead.controller.js
const Lead = require("../models/Lead");
const Customer = require("../models/Customer");
const User = require("../models/User");
const Task = require("../models/Task");
const WhatsAppMessage = require("../models/WhatsAppMessage");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

// Get all leads with filtering
exports.getLeads = async (req, res) => {
  try {
    const {
      status,
      tags,
      assignedTo,
      search,
      followUpStartDate,
      followUpEndDate,
      sourceType, // NEW: Filter by source type
    } = req.query;

    const query = {};

    // Apply filters
    if (status) query.status = status;
    if (tags) {
      const tagArray = Array.isArray(tags) ? tags : [tags];
      query.tags = { $in: tagArray };
    }

    // NEW: Filter by source type
    if (sourceType) {
      query.sourceType = sourceType;
    }

    // Role-based filtering
    if (req.user.role === "sales_agent") {
      query.assignedTo = req.user._id;
    } else if (assignedTo) {
      if (assignedTo === "unassigned") {
        query.assignedTo = { $exists: false };
      } else {
        query.assignedTo = assignedTo;
      }
    }

    // Search functionality
    if (search) {
      query.$or = [
        { fullName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { company: { $regex: search, $options: "i" } },
        { phoneNumber: { $regex: search, $options: "i" } },
        { notes: { $regex: search, $options: "i" } },
        { 'restaurantData.name': { $regex: search, $options: "i" } }, // NEW: Search restaurant name
        { 'restaurantData.postalCode': { $regex: search, $options: "i" } }, // NEW: Search postal code
        { sapCardCode: { $regex: search, $options: "i" } },
      ];
    }

    // Follow-up date range filter
    if (followUpStartDate || followUpEndDate) {
      query.nextFollowUp = {};
      if (followUpStartDate) {
        query.nextFollowUp.$gte = new Date(followUpStartDate);
      }
      if (followUpEndDate) {
        const endOfDay = new Date(followUpEndDate);
        endOfDay.setHours(23, 59, 59, 999);
        query.nextFollowUp.$lte = endOfDay;
      }
    }

    const leads = await Lead.find(query)
      .populate("assignedTo", "firstName lastName email")
      .populate("tasks")
      .populate("relatedRestaurant") // NEW: Populate restaurant data
      .populate("relatedRestaurantAssignment") // NEW: Populate assignment data
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: leads,
    });
  } catch (error) {
    console.error("Error fetching leads:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching leads",
      error: error.message,
    });
  }
};

// Get paginated leads
exports.getLeadsPaginated = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const {
      status,
      tags,
      assignedTo,
      search,
      sortBy,
      sortOrder,
      followUpStartDate,
      followUpEndDate,
      sourceType, // NEW: Filter by source type
    } = req.query;

    const query = {};

    // Apply filters
    if (status) query.status = status;
    if (tags) {
      const tagArray = Array.isArray(tags) ? tags : [tags];
      query.tags = { $in: tagArray };
    }

    // NEW: Filter by source type
    if (sourceType) {
      query.sourceType = sourceType;
    }

    if (req.user.role === "sales_agent") {
      query.assignedTo = req.user._id;
    } else if (assignedTo) {
      if (assignedTo === "unassigned") {
        query.assignedTo = { $exists: false };
      } else {
        query.assignedTo = assignedTo;
      }
    }

    if (search) {
      query.$or = [
        { fullName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { company: { $regex: search, $options: "i" } },
        { phoneNumber: { $regex: search, $options: "i" } },
        { notes: { $regex: search, $options: "i" } },
        { 'restaurantData.name': { $regex: search, $options: "i" } }, // NEW: Search restaurant name
        { 'restaurantData.postalCode': { $regex: search, $options: "i" } }, // NEW: Search postal code
        { sapCardCode: { $regex: search, $options: "i" } },
      ];
    }

    // Follow-up date range filter
    if (followUpStartDate || followUpEndDate) {
      query.nextFollowUp = {};
      if (followUpStartDate) {
        query.nextFollowUp.$gte = new Date(followUpStartDate);
      }
      if (followUpEndDate) {
        const endOfDay = new Date(followUpEndDate);
        endOfDay.setHours(23, 59, 59, 999);
        query.nextFollowUp.$lte = endOfDay;
      }
    }

    // Sorting
    const sortOptions = {};
    if (sortBy) {
      sortOptions[sortBy] = sortOrder === "desc" ? -1 : 1;
    } else {
      sortOptions.createdAt = -1;
    }

    const total = await Lead.countDocuments(query);
    const leads = await Lead.find(query)
      .populate("assignedTo", "firstName lastName email")
      .populate("tasks")
      .populate("relatedRestaurant") // NEW: Populate restaurant data
      .populate("relatedRestaurantAssignment") // NEW: Populate assignment data
      .sort(sortOptions)
      .skip(skip)
      .limit(limit);

    res.json({
      success: true,
      data: leads,
      pagination: {
        total,
        page,
        pages: Math.ceil(total / limit),
        limit,
      },
    });
  } catch (error) {
    console.error("Error fetching paginated leads:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching leads",
      error: error.message,
    });
  }
};

// Get lead statistics
// Accepts the same filters as the list endpoint (status, assignedTo, search,
// followUpStartDate, followUpEndDate, tag, sourceType) so the KPI cards at
// the top of the leads dashboard update with the filters below.
exports.getLeadStats = async (req, res) => {
  try {
    const mongoose = require("mongoose");
    const query = {};

    // Role-based filtering
    if (req.user.role === "sales_agent") {
      query.assignedTo = req.user._id;
    }

    // Optional filters from the UI
    if (req.query.status) query.status = req.query.status;
    if (req.query.assignedTo) {
      if (req.query.assignedTo === "unassigned") {
        query.assignedTo = { $exists: false };
      } else if (mongoose.Types.ObjectId.isValid(req.query.assignedTo)) {
        query.assignedTo = new mongoose.Types.ObjectId(req.query.assignedTo);
      }
    }
    if (req.query.tag) query.tags = req.query.tag;
    if (req.query.sourceType) query.sourceType = req.query.sourceType;
    if (req.query.followUpStartDate || req.query.followUpEndDate) {
      query.nextFollowUp = {};
      if (req.query.followUpStartDate)
        query.nextFollowUp.$gte = new Date(req.query.followUpStartDate);
      if (req.query.followUpEndDate)
        query.nextFollowUp.$lte = new Date(req.query.followUpEndDate);
    }
    if (req.query.fromDate || req.query.toDate) {
      query.createdAt = {};
      if (req.query.fromDate)
        query.createdAt.$gte = new Date(req.query.fromDate + "T00:00:00.000Z");
      if (req.query.toDate)
        query.createdAt.$lte = new Date(req.query.toDate + "T23:59:59.999Z");
    }
    if (req.query.search) {
      const s = { $regex: req.query.search, $options: "i" };
      query.$or = [
        { fullName: s },
        { email: s },
        { phoneNumber: s },
        { company: s },
      ];
    }

    const stats = await Lead.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          totalLeads: { $sum: 1 },
          newLeads: { $sum: { $cond: [{ $eq: ["$status", "new"] }, 1, 0] } },
          qualifiedLeads: {
            $sum: { $cond: [{ $eq: ["$status", "qualified"] }, 1, 0] },
          },
          convertedLeads: {
            $sum: { $cond: [{ $eq: ["$status", "converted"] }, 1, 0] },
          },
          deadLeads: { $sum: { $cond: [{ $eq: ["$status", "dead"] }, 1, 0] } },
          lostLeads: { $sum: { $cond: [{ $eq: ["$status", "lost"] }, 1, 0] } },
          unassignedLeads: {
            $sum: { $cond: [{ $not: ["$assignedTo"] }, 1, 0] },
          },
          restaurantLeads: {
            $sum: { $cond: [{ $eq: ["$sourceType", "restaurant_scraping"] }, 1, 0] },
          },
          aiGeneratedLeads: {
            $sum: { $cond: [{ $eq: ["$sourceType", "ai_generated"] }, 1, 0] },
          },
          // Time-to-first-contact proxy: time between createdAt and updatedAt
          // (Lead docs are updated when an agent touches them — status change,
          // notes, etc., so this approximates time to first contact.)
          avgUpdateLagDays: {
            $avg: {
              $divide: [
                { $subtract: ["$updatedAt", "$createdAt"] },
                1000 * 60 * 60 * 24,
              ],
            },
          },
        },
      },
      {
        $project: {
          _id: 0,
          totalLeads: 1,
          newLeads: 1,
          qualifiedLeads: 1,
          convertedLeads: 1,
          deadLeads: 1,
          lostLeads: 1,
          unassignedLeads: 1,
          restaurantLeads: 1,
          aiGeneratedLeads: 1,
          avgUpdateLagDays: { $round: ["$avgUpdateLagDays", 1] },
          conversionRate: {
            $cond: [
              { $gt: ["$totalLeads", 0] },
              { $round: [{ $multiply: [{ $divide: ["$convertedLeads", "$totalLeads"] }, 100] }, 1] },
              0,
            ],
          },
        },
      },
    ]);

    const tagStats = await Lead.aggregate([
      { $match: query },
      { $unwind: { path: "$tags", preserveNullAndEmptyArrays: true } },
      { $group: { _id: "$tags", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    const statusStats = await Lead.aggregate([
      { $match: query },
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    res.json({
      success: true,
      data: {
        overview: stats[0] || {
          totalLeads: 0,
          newLeads: 0,
          qualifiedLeads: 0,
          convertedLeads: 0,
          deadLeads: 0,
          unassignedLeads: 0,
          avgUpdateLagDays: 0,
          conversionRate: 0,
        },
        tagBreakdown: tagStats,
        statusBreakdown: statusStats,
      },
    });
  } catch (error) {
    console.error("Error fetching lead stats:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching lead statistics",
      error: error.message,
    });
  }
};

// Get lead by ID
exports.getLeadById = async (req, res) => {
  try {
    const { id } = req.params;

    let query = { _id: id };

    // Role-based access control
    if (req.user.role === "sales_agent") {
      query.assignedTo = req.user._id;
    }

    const lead = await Lead.findOne(query)
      .populate("assignedTo", "firstName lastName email")
      .populate("tasks")
      .populate("relatedRestaurant") // NEW
      .populate("relatedRestaurantAssignment"); // NEW

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    res.json({
      success: true,
      data: lead,
    });
  } catch (error) {
    console.error("Error fetching lead:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching lead",
      error: error.message,
    });
  }
};

// Create new lead
exports.createLead = async (req, res) => {
  try {
    const leadData = {
      ...req.body,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    console.log("Creating lead with data:", leadData);

    // Auto-assign to sales agent if they create the lead
    if (req.user.role === "sales_agent") {
      leadData.assignedTo = req.user._id;
    }

    //if made by admin or manager see which agent assigned
    if (req.user.role === "admin" || req.user.role === "manager") {
      if (leadData.assignedTo) {
        const agent = await User.findById(leadData.assignedTo);
        if (!agent || agent.role !== "sales_agent") {
          return res.status(400).json({
            success: false,
            message: "Invalid sales agent ID in assignedTo field",
          });
        }
      }
    }

    // Check for duplicate email if provided
    if (leadData.email) {
      const existingLead = await Lead.findOne({
        email: leadData.email.toLowerCase(),
      });

      if (existingLead) {
        return res.status(400).json({
          success: false,
          message: "A lead with this email already exists",
        });
      }

      // Check if email exists in customers
      const existingCustomer = await Customer.findOne({
        Email: leadData.email.toLowerCase(),
      });

      if (existingCustomer) {
        return res.status(400).json({
          success: false,
          message: "This email already belongs to an existing customer",
        });
      }
    }

    const lead = new Lead(leadData);
    await lead.save();

    const populatedLead = await Lead.findById(lead._id)
      .populate("assignedTo", "firstName lastName email")
      .populate("tasks");

    res.status(201).json({
      success: true,
      message: "Lead created successfully",
      data: populatedLead,
    });
  } catch (error) {
    console.error("Error creating lead:", error);
    res.status(500).json({
      success: false,
      message: "Error creating lead",
      error: error.message,
    });
  }
};

// Update lead
exports.updateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const updateData = {
      ...req.body,
      updatedAt: new Date(),
    };

    let query = { _id: id };

    // Role-based access control
    if (req.user.role === "sales_agent") {
      query.assignedTo = req.user._id;
    }

    const lead = await Lead.findOneAndUpdate(query, updateData, {
      new: true,
      runValidators: true,
    })
      .populate("assignedTo", "firstName lastName email")
      .populate("tasks");

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found or not authorized to update",
      });
    }

    res.json({
      success: true,
      message: "Lead updated successfully",
      data: lead,
    });
  } catch (error) {
    console.error("Error updating lead:", error);
    res.status(500).json({
      success: false,
      message: "Error updating lead",
      error: error.message,
    });
  }
};

// Delete lead
exports.deleteLead = async (req, res) => {
  try {
    const { id } = req.params;

    const lead = await Lead.findByIdAndDelete(id);

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    // Also delete associated tasks if any
    if (lead.tasks && lead.tasks.length > 0) {
      await Task.deleteMany({ _id: { $in: lead.tasks } });
    }

    res.json({
      success: true,
      message: "Lead deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting lead:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting lead",
      error: error.message,
    });
  }
};

// Assign lead to agent
exports.assignLead = async (req, res) => {
  try {
    const { id } = req.params;
    const { assignedTo } = req.body;

    // Verify agent exists and is a sales agent
    const agent = await User.findById(assignedTo);
    if (!agent || agent.role !== "sales_agent") {
      return res.status(400).json({
        success: false,
        message: "Invalid sales agent ID",
      });
    }

    const lead = await Lead.findByIdAndUpdate(
      id,
      {
        assignedTo,
        updatedAt: new Date(),
      },
      { new: true }
    )
      .populate("assignedTo", "firstName lastName email")
      .populate("tasks");

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    res.json({
      success: true,
      message: "Lead assigned successfully",
      data: lead,
    });
  } catch (error) {
    console.error("Error assigning lead:", error);
    res.status(500).json({
      success: false,
      message: "Error assigning lead",
      error: error.message,
    });
  }
};



// Bulk assign leads
exports.bulkAssignLeads = async (req, res) => {
  try {
    const { leadIds, assignedTo } = req.body;

    if (!leadIds || !Array.isArray(leadIds) || leadIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid array of lead IDs",
      });
    }

    // Verify agent exists and is a sales agent
    const agent = await User.findById(assignedTo);
    if (!agent || agent.role !== "sales_agent") {
      return res.status(400).json({
        success: false,
        message: "Invalid sales agent ID",
      });
    }

    const result = await Lead.updateMany(
      { _id: { $in: leadIds } },
      {
        assignedTo,
        updatedAt: new Date(),
      }
    );

    res.json({
      success: true,
      message: "Leads assigned successfully",
      count: result.modifiedCount,
      totalRequested: leadIds.length,
    });
  } catch (error) {
    console.error("Error bulk assigning leads:", error);
    res.status(500).json({
      success: false,
      message: "Error bulk assigning leads",
      error: error.message,
    });
  }
};

// Unassign lead
exports.unassignLead = async (req, res) => {
  try {
    const { id } = req.params;

    const lead = await Lead.findByIdAndUpdate(
      id,
      {
        $unset: { assignedTo: "" },
        updatedAt: new Date(),
      },
      { new: true }
    ).populate("tasks");

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    res.json({
      success: true,
      message: "Lead unassigned successfully",
      data: lead,
    });
  } catch (error) {
    console.error("Error unassigning lead:", error);
    res.status(500).json({
      success: false,
      message: "Error unassigning lead",
      error: error.message,
    });
  }
};

// Update lead status
exports.updateLeadStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    let query = { _id: id };

    if (req.user.role === "sales_agent") {
      query.assignedTo = req.user._id;
    }

    const lead = await Lead.findOneAndUpdate(
      query,
      { status, updatedAt: new Date() },
      { new: true }
    )
      .populate("assignedTo", "firstName lastName email")
      .populate("tasks");

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found or not authorized to update",
      });
    }

    res.json({
      success: true,
      message: "Lead status updated successfully",
      data: lead,
    });
  } catch (error) {
    console.error("Error updating lead status:", error);
    res.status(500).json({
      success: false,
      message: "Error updating lead status",
      error: error.message,
    });
  }
};

// Update lead tags
exports.updateLeadTags = async (req, res) => {
  try {
    const { id } = req.params;
    const { tags } = req.body;

    let query = { _id: id };

    if (req.user.role === "sales_agent") {
      query.assignedTo = req.user._id;
    }

    const lead = await Lead.findOneAndUpdate(
      query,
      { tags, updatedAt: new Date() },
      { new: true }
    )
      .populate("assignedTo", "firstName lastName email")
      .populate("tasks");

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found or not authorized to update",
      });
    }

    res.json({
      success: true,
      message: "Lead tags updated successfully",
      data: lead,
    });
  } catch (error) {
    console.error("Error updating lead tags:", error);
    res.status(500).json({
      success: false,
      message: "Error updating lead tags",
      error: error.message,
    });
  }
};

// Convert lead to customer
exports.convertLeadToCustomer = async (req, res) => {
  try {
    const { id } = req.params;

    let query = { _id: id };

    if (req.user.role === "sales_agent") {
      query.assignedTo = req.user._id;
    }

    const lead = await Lead.findOne(query);

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found or not authorized to convert",
      });
    }

    if (lead.status === "converted") {
      return res.status(400).json({
        success: false,
        message: "Lead has already been converted",
      });
    }

    // An existing SAP customer brought back as a lead must not be converted:
    // that would create a second account for the same business.
    if (lead.sapCardCode || lead.existingCustomer) {
      return res.status(400).json({
        success: false,
        code: "EXISTING_CUSTOMER",
        message: `This lead is already an existing customer (${lead.sapCardCode || "linked account"}). Open the customer instead of converting.`,
        existingCustomer: { CardCode: lead.sapCardCode },
      });
    }

    // Check if customer with this email already exists
    if (lead.email) {
      const existingCustomer = await Customer.findOne({
        Email: lead.email.toLowerCase(),
      });

      if (existingCustomer) {
        return res.status(400).json({
          success: false,
          message: "Customer with this email already exists",
          existingCustomer: {
            CardCode: existingCustomer.CardCode,
            CardName: existingCustomer.CardName,
          },
        });
      }
    }

    // Assign a temporary placeholder CardCode. The real, unique SAP CardCode is
    // allocated atomically during the SAP push below (collision-safe), so a
    // failed push never leaves a fake C-code on an unsynced customer.
    const newCardCode = `TEMP-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    // Parse fullName into firstName and lastName
    const nameParts = lead.fullName.trim().split(" ");
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";

    // Create customer from lead data
    const customerData = {
      CardCode: newCardCode,
      CardName: lead.fullName,
      Email: lead.email || "",
      firstName: firstName,
      lastName: lastName,
      phoneNumber: lead.phoneNumber || "",
      company: lead.company || "",
      assignedTo: lead.assignedTo,
      customerType: "non-sap", // Will be updated to "sap" after successful sync
      status: "active",
      notes: `Converted from lead on ${new Date().toISOString()}. ${lead.notes || ""
        }`,
      createdAt: new Date(),
      updatedAt: new Date(),
      SyncedWithSAP: false,
      LocalStatus: "Created",
    };

    // Create the customer
    const customer = new Customer(customerData);
    await customer.save();

    // Push customer to SAP automatically (same as in customer creation)
    console.log("Automatically pushing converted customer to SAP...");
    let sapSyncResult = null;

    try {
      // Import the SAP integration function
      const {
        createCustomerInSAPWithUniqueCode,
      } = require("../utils/sapB1CustomerIntegration");

      // Allocate a unique CardCode and create in SAP atomically (collision-safe).
      const sapResponse = await createCustomerInSAPWithUniqueCode(customer);

      // Update local customer with SAP CardCode if successful
      if (sapResponse && sapResponse.CardCode) {
        customer.CardCode = sapResponse.CardCode;
        customer.customerType = "sap";
        customer.SyncedWithSAP = true;
        customer.LocalStatus = "Synced";
        customer.updatedAt = new Date();

        await customer.save();

        sapSyncResult = {
          success: true,
          CardCode: sapResponse.CardCode,
          sapData: sapResponse,
        };
      } else {
        throw new Error("Invalid response from SAP B1");
      }
    } catch (sapError) {
      // Update local customer to mark sync failure
      customer.SyncErrors = sapError.message;
      customer.LastSyncAttempt = new Date();
      customer.LocalStatus = "SyncFailed";
      await customer.save();

      console.error("Error pushing converted customer to SAP:", sapError);
      sapSyncResult = {
        success: false,
        error: sapError.message || "Unknown SAP sync error",
      };
    }

    // Update the lead as converted
    lead.status = "converted";
    lead.updatedAt = new Date();
    await lead.save();

    // Populate the customer data for response
    const populatedCustomer = await Customer.findById(customer._id).populate(
      "assignedTo",
      "firstName lastName email"
    );

    // Return response with both conversion and SAP sync results
    const responseMessage = sapSyncResult?.success
      ? "Lead converted to customer successfully and synced with SAP"
      : "Lead converted to customer successfully but failed to sync with SAP";

    res.json({
      success: true,
      message: responseMessage,
      data: {
        customer: populatedCustomer,
        lead: lead,
        sapSync: sapSyncResult,
      },
    });
  } catch (error) {
    console.error("Error converting lead to customer:", error);
    res.status(500).json({
      success: false,
      message: "Error converting lead to customer",
      error: error.message,
    });
  }
};

// Preview lead conversion
exports.previewLeadConversion = async (req, res) => {
  try {
    const { id } = req.params;

    let query = { _id: id };

    if (req.user.role === "sales_agent") {
      query.assignedTo = req.user._id;
    }

    const lead = await Lead.findOne(query).populate(
      "assignedTo",
      "firstName lastName email"
    );

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found or not authorized to preview",
      });
    }

    if (lead.status === "converted") {
      return res.status(400).json({
        success: false,
        message: "Lead has already been converted",
      });
    }

    if (lead.sapCardCode || lead.existingCustomer) {
      return res.status(400).json({
        success: false,
        code: "EXISTING_CUSTOMER",
        message: `This lead is already an existing customer (${lead.sapCardCode || "linked account"}). Open the customer instead of converting.`,
        existingCustomer: { CardCode: lead.sapCardCode },
      });
    }

    // Check for existing customer with same email
    let existingCustomer = null;
    if (lead.email) {
      existingCustomer = await Customer.findOne({
        Email: lead.email.toLowerCase(),
      });
    }

    // Generate preview CardCode
    console.log("Getting preview CardCode from SAP...");
    let previewCardCode;

    try {
      const {
        generateNextCardCode,
      } = require("../utils/sapB1CustomerIntegration");

      previewCardCode = await generateNextCardCode();
    } catch (error) {
      console.error(
        "Error getting preview CardCode from SAP, using fallback:",
        error
      );
      // Fallback to NC- prefix if SAP is unavailable
      const lastCustomer = await Customer.findOne({
        CardCode: /^NC-/,
      }).sort({ CardCode: -1 });

      let nextNumber = 1;
      if (lastCustomer && lastCustomer.CardCode) {
        const match = lastCustomer.CardCode.match(/NC-(\d+)/);
        if (match) {
          nextNumber = parseInt(match[1]) + 1;
        }
      }

      previewCardCode = `NC-${nextNumber.toString().padStart(6, "0")}`;
    }

    // Parse fullName
    const nameParts = lead.fullName.trim().split(" ");
    const firstName = nameParts[0] || "";
    const lastName = nameParts.slice(1).join(" ") || "";

    const conversionPreview = {
      lead: lead,
      proposedCustomer: {
        CardCode: previewCardCode,
        CardName: lead.fullName,
        Email: lead.email || "",
        firstName: firstName,
        lastName: lastName,
        phoneNumber: lead.phoneNumber || "",
        company: lead.company || "",
        assignedTo: lead.assignedTo,
        customerType: "non-sap",
        status: "active",
      },
      warnings: [],
      canConvert: true,
    };

    if (existingCustomer) {
      conversionPreview.warnings.push({
        type: "duplicate_email",
        message: "Customer with this email already exists",
        existingCustomer: {
          CardCode: existingCustomer.CardCode,
          CardName: existingCustomer.CardName,
        },
      });
      conversionPreview.canConvert = false;
    }

    if (!lead.fullName || lead.fullName.trim() === "") {
      conversionPreview.warnings.push({
        type: "missing_name",
        message: "Lead is missing full name",
      });
      conversionPreview.canConvert = false;
    }

    res.json({
      success: true,
      data: conversionPreview,
    });
  } catch (error) {
    console.error("Error previewing lead conversion:", error);
    res.status(500).json({
      success: false,
      message: "Error previewing lead conversion",
      error: error.message,
    });
  }
};

// Add note to lead
exports.addLeadNote = async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;

    if (!note || !note.trim()) {
      return res.status(400).json({
        success: false,
        message: "Note content is required",
      });
    }

    let query = { _id: id };

    if (req.user.role === "sales_agent") {
      query.assignedTo = req.user._id;
    }

    const lead = await Lead.findOne(query);

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found or not authorized to update",
      });
    }

    // Append note with timestamp and user info
    const noteWithMetadata = `${new Date().toISOString()} - ${req.user.firstName
      } ${req.user.lastName}: ${note.trim()}`;
    const updatedNotes = lead.notes
      ? `${lead.notes}\n\n${noteWithMetadata}`
      : noteWithMetadata;

    lead.notes = updatedNotes;
    lead.updatedAt = new Date();
    await lead.save();

    const populatedLead = await Lead.findById(lead._id)
      .populate("assignedTo", "firstName lastName email")
      .populate("tasks");

    res.json({
      success: true,
      message: "Note added successfully",
      data: populatedLead,
    });
  } catch (error) {
    console.error("Error adding lead note:", error);
    res.status(500).json({
      success: false,
      message: "Error adding note to lead",
      error: error.message,
    });
  }
};

// Set next follow-up date
exports.setNextFollowUp = async (req, res) => {
  try {
    const { id } = req.params;
    const { nextFollowUp } = req.body;

    if (!nextFollowUp) {
      return res.status(400).json({
        success: false,
        message: "Next follow-up date is required",
      });
    }

    let query = { _id: id };

    if (req.user.role === "sales_agent") {
      query.assignedTo = req.user._id;
    }

    const lead = await Lead.findOne(query);

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found or not authorized to update",
      });
    }

    // Update lead with follow-up date
    lead.nextFollowUp = new Date(nextFollowUp);
    lead.updatedAt = new Date();
    await lead.save();

    // Create a follow-up task if lead is assigned to someone
    let createdTask = null;
    if (lead.assignedTo) {
      const Task = require("../models/Task");
      const NotificationService = require("../utils/notificationService");

      const followUpTask = new Task({
        leadId: lead._id,
        title: `Follow up with ${lead.fullName}`,
        description: `Follow up with lead: ${lead.fullName}${lead.company ? ` from ${lead.company}` : ''}${lead.email ? ` (${lead.email})` : ''}`,
        dueDate: new Date(nextFollowUp),
        priority: "medium",
        type: "follow-up",
        status: "pending",
        assignedTo: lead.assignedTo,
        createdBy: req.user._id,
      });

      await followUpTask.save();

      // Add task to lead's tasks array
      await Lead.findByIdAndUpdate(lead._id, {
        $push: { tasks: followUpTask._id }
      });

      // Create notification if task is assigned to someone other than creator
      if (followUpTask.assignedTo.toString() !== req.user._id.toString()) {
        await NotificationService.createTaskAssignedNotification(
          followUpTask,
          req.user._id
        );
      }

      createdTask = await Task.findById(followUpTask._id)
        .populate("assignedTo", "firstName lastName email role")
        .populate("createdBy", "firstName lastName email role")
        .populate("leadId", "fullName email company");
    }

    // Get updated lead
    const updatedLead = await Lead.findById(lead._id)
      .populate("assignedTo", "firstName lastName email")
      .populate("tasks");

    res.json({
      success: true,
      message: createdTask
        ? "Follow-up date set and task created successfully"
        : "Follow-up date set successfully",
      data: {
        lead: updatedLead,
        task: createdTask
      },
    });
  } catch (error) {
    console.error("Error setting follow-up date:", error);
    res.status(500).json({
      success: false,
      message: "Error setting follow-up date",
      error: error.message,
    });
  }
};

// Get unassigned leads
exports.getUnassignedLeads = async (req, res) => {
  try {
    const leads = await Lead.find({
      assignedTo: { $exists: false },
    })
      .populate("tasks")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: leads,
    });
  } catch (error) {
    console.error("Error fetching unassigned leads:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching unassigned leads",
      error: error.message,
    });
  }
};

// Import leads from file
exports.importLeads = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a file",
      });
    }

    console.log("Processing leads import file:", req.file.path);
    const startTime = Date.now();

    let leadsData = [];
    const fileExt = path.extname(req.file.originalname).toLowerCase();

    // Process file based on extension
    if (fileExt === ".xlsx" || fileExt === ".xls") {
      const workbook = XLSX.readFile(req.file.path);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(worksheet);

      leadsData = data.map((row) => ({
        fullName:
          row["Full Name"] ||
          row["fullName"] ||
          `${row["First Name"] || ""} ${row["Last Name"] || ""}`.trim(),
        email: (row["Email"] || row["email"] || "").toLowerCase(),
        phoneNumber: row["Phone"] || row["phoneNumber"] || "",
        company: row["Company"] || row["company"] || "",
        status: row["Status"] || row["status"] || "new",
        notes: row["Notes"] || row["notes"] || "",
        tags: row["Tags"]
          ? row["Tags"].split(",").map((tag) => tag.trim())
          : [],
      }));
    } else if (fileExt === ".csv") {
      leadsData = await new Promise((resolve, reject) => {
        const results = [];
        fs.createReadStream(req.file.path)
          .pipe(csv())
          .on("data", (row) => {
            results.push({
              fullName:
                row["Full Name"] ||
                row["fullName"] ||
                `${row["First Name"] || ""} ${row["Last Name"] || ""}`.trim(),
              email: (row["Email"] || row["email"] || "").toLowerCase(),
              phoneNumber: row["Phone"] || row["phoneNumber"] || "",
              company: row["Company"] || row["company"] || "",
              status: row["Status"] || row["status"] || "new",
              notes: row["Notes"] || row["notes"] || "",
              tags: row["Tags"]
                ? row["Tags"].split(",").map((tag) => tag.trim())
                : [],
            });
          })
          .on("end", () => resolve(results))
          .on("error", reject);
      });
    }

    // Filter valid leads
    const validLeads = leadsData.filter(
      (lead) => lead.fullName && lead.fullName.trim() !== ""
    );

    if (validLeads.length === 0) {

      return res.status(400).json({
        success: false,
        message: "No valid lead data found in the file",
      });
    }

    // Check for duplicates by email (if email exists)
    const leadsWithEmail = validLeads.filter(
      (lead) => lead.email && lead.email.trim() !== ""
    );
    const emails = leadsWithEmail.map((lead) => lead.email);

    let existingLeads = [];
    let existingCustomers = [];

    if (emails.length > 0) {
      existingLeads = await Lead.find({
        email: { $in: emails },
      }).lean();

      existingCustomers = await Customer.find({
        Email: { $in: emails },
      }).lean();
    }

    const existingEmails = new Set(existingLeads.map((lead) => lead.email));
    const existingCustomerEmails = new Set(
      existingCustomers.map((customer) => customer.Email)
    );

    // Filter out duplicates (only for leads with email)
    const newLeads = validLeads.filter((lead) => {
      if (!lead.email || lead.email.trim() === "") {
        return true; // Allow leads without email
      }
      return (
        !existingEmails.has(lead.email) &&
        !existingCustomerEmails.has(lead.email)
      );
    });

    // Insert new leads
    const results = {
      total: validLeads.length,
      imported: 0,
      duplicateLeads: 0,
      duplicateCustomers: 0,
      errors: [],
    };

    if (newLeads.length > 0) {
      const insertedLeads = await Lead.insertMany(newLeads);
      results.imported = insertedLeads.length;
    }

    results.duplicateLeads = existingEmails.size;
    results.duplicateCustomers = existingCustomerEmails.size;

    // Clean up file
    try {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (unlinkError) {
      console.error("Error deleting file:", unlinkError);
    }

    const totalTime = Date.now() - startTime;

    res.json({
      success: true,
      message: `Lead import completed in ${totalTime}ms`,
      results: {
        ...results,
        processingTimeMs: totalTime,
      },
    });
  } catch (error) {
    console.error("Error importing leads:", error);

    // Clean up file
    try {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (unlinkError) {
      console.error("Error cleaning up file:", unlinkError);
    }

    res.status(500).json({
      success: false,
      message: "Error importing leads",
      error: error.message,
    });
  }
};

// Export leads
exports.exportLeads = async (req, res) => {
  try {
    const { format = "csv", ...filters } = req.body;

    const query = {};

    // Role-based filtering
    if (req.user.role === "sales_agent") {
      query.assignedTo = req.user._id;
    }

    const leads = await Lead.find(query)
      .populate("assignedTo", "firstName lastName email")
      .lean();

    // Format data for export
    const exportData = leads.map((lead) => ({
      "Full Name": lead.fullName,
      Email: lead.email || "",
      Phone: lead.phoneNumber || "",
      Company: lead.company || "",
      Status: lead.status,
      Tags: lead.tags ? lead.tags.join(", ") : "",
      "Assigned To": lead.assignedTo
        ? `${lead.assignedTo.firstName} ${lead.assignedTo.lastName}`
        : "",
      "Created Date": lead.createdAt,
      "Next Follow Up": lead.nextFollowUp,
      Notes: lead.notes || "",
    }));

    res.json({
      success: true,
      data: exportData,
      count: exportData.length,
    });
  } catch (error) {
    console.error("Error exporting leads:", error);
    res.status(500).json({
      success: false,
      message: "Error exporting leads",
      error: error.message,
    });
  }
};

// Get leads by status
exports.getLeadsByStatus = async (req, res) => {
  try {
    const { status } = req.params;
    const query = { status };

    if (req.user.role === "sales_agent") {
      query.assignedTo = req.user._id;
    }

    const leads = await Lead.find(query)
      .populate("assignedTo", "firstName lastName email")
      .populate("tasks")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: leads,
    });
  } catch (error) {
    console.error("Error fetching leads by status:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching leads by status",
      error: error.message,
    });
  }
};

// Get leads by tag
exports.getLeadsByTag = async (req, res) => {
  try {
    const { tag } = req.params;
    const query = { tags: { $in: [tag] } };

    if (req.user.role === "sales_agent") {
      query.assignedTo = req.user._id;
    }

    const leads = await Lead.find(query)
      .populate("assignedTo", "firstName lastName email")
      .populate("tasks")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: leads,
    });
  } catch (error) {
    console.error("Error fetching leads by tag:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching leads by tag",
      error: error.message,
    });
  }
};

// Get leads by agent
exports.getLeadsByAgent = async (req, res) => {
  try {
    const { agentId } = req.params;

    // Permission check
    if (
      req.user.role === "sales_agent" &&
      req.user._id.toString() !== agentId
    ) {
      return res.status(403).json({
        success: false,
        message: "You can only view your own leads",
      });
    }

    const leads = await Lead.find({
      assignedTo: agentId,
    })
      .populate("assignedTo", "firstName lastName email")
      .populate("tasks")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: leads,
    });
  } catch (error) {
    console.error("Error fetching leads by agent:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching leads by agent",
      error: error.message,
    });
  }
};

// Search leads
exports.searchLeads = async (req, res) => {
  try {
    const { searchTerm, filters = {} } = req.body;

    const query = {};

    // Role-based filtering
    if (req.user.role === "sales_agent") {
      query.assignedTo = req.user._id;
    }

    // Apply additional filters
    if (filters.status) query.status = filters.status;
    if (filters.tags) {
      const tagArray = Array.isArray(filters.tags)
        ? filters.tags
        : [filters.tags];
      query.tags = { $in: tagArray };
    }

    // Text search
    if (searchTerm) {
      query.$or = [
        { fullName: { $regex: searchTerm, $options: "i" } },
        { email: { $regex: searchTerm, $options: "i" } },
        { company: { $regex: searchTerm, $options: "i" } },
        { phoneNumber: { $regex: searchTerm, $options: "i" } },
        { notes: { $regex: searchTerm, $options: "i" } },
      ];
    }

    const leads = await Lead.find(query)
      .populate("assignedTo", "firstName lastName email")
      .populate("tasks")
      .sort({ createdAt: -1 });

    res.json({
      success: true,
      data: leads,
    });
  } catch (error) {
    console.error("Error searching leads:", error);
    res.status(500).json({
      success: false,
      message: "Error searching leads",
      error: error.message,
    });
  }
};

// Get lead funnel analytics
exports.getLeadFunnelAnalytics = async (req, res) => {
  try {
    const query = {};

    if (req.user.role === "sales_agent") {
      query.assignedTo = req.user._id;
    }

    const funnelData = await Lead.aggregate([
      { $match: query },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
    ]);

    const conversionRates = await Lead.aggregate([
      { $match: query },
      {
        $group: {
          _id: null,
          totalLeads: { $sum: 1 },
          convertedLeads: {
            $sum: { $cond: [{ $eq: ["$status", "converted"] }, 1, 0] },
          },
          qualifiedLeads: {
            $sum: { $cond: [{ $eq: ["$status", "qualified"] }, 1, 0] },
          },
          contactedLeads: {
            $sum: { $cond: [{ $eq: ["$status", "contacted"] }, 1, 0] },
          },
        },
      },
    ]);

    const rates = conversionRates[0] || {};
    const analyticsData = {
      funnel: funnelData,
      conversionRates: {
        newToContacted: rates.totalLeads
          ? ((rates.contactedLeads / rates.totalLeads) * 100).toFixed(2)
          : 0,
        contactedToQualified: rates.contactedLeads
          ? ((rates.qualifiedLeads / rates.contactedLeads) * 100).toFixed(2)
          : 0,
        qualifiedToConverted: rates.qualifiedLeads
          ? ((rates.convertedLeads / rates.qualifiedLeads) * 100).toFixed(2)
          : 0,
        overallConversion: rates.totalLeads
          ? ((rates.convertedLeads / rates.totalLeads) * 100).toFixed(2)
          : 0,
      },
      totals: rates,
    };

    res.json({
      success: true,
      data: analyticsData,
    });
  } catch (error) {
    console.error("Error fetching funnel analytics:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching funnel analytics",
      error: error.message,
    });
  }
};

// Get lead tag analytics
exports.getLeadTagAnalytics = async (req, res) => {
  try {
    const query = {};

    if (req.user.role === "sales_agent") {
      query.assignedTo = req.user._id;
    }

    const tagData = await Lead.aggregate([
      { $match: query },
      { $unwind: { path: "$tags", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: "$tags",
          count: { $sum: 1 },
          converted: {
            $sum: { $cond: [{ $eq: ["$status", "converted"] }, 1, 0] },
          },
        },
      },
      {
        $addFields: {
          conversionRate: {
            $multiply: [{ $divide: ["$converted", "$count"] }, 100],
          },
        },
      },
      { $sort: { count: -1 } },
    ]);

    res.json({
      success: true,
      data: tagData,
    });
  } catch (error) {
    console.error("Error fetching tag analytics:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching tag analytics",
      error: error.message,
    });
  }
};

// Get agent lead analytics
exports.getAgentLeadAnalytics = async (req, res) => {
  try {
    const { agentId } = req.params;

    // Permission check
    if (
      req.user.role === "sales_agent" &&
      req.user._id.toString() !== agentId
    ) {
      return res.status(403).json({
        success: false,
        message: "You can only view your own analytics",
      });
    }

    const agentStats = await Lead.aggregate([
      { $match: { assignedTo: mongoose.Types.ObjectId(agentId) } },
      {
        $group: {
          _id: null,
          totalLeads: { $sum: 1 },
          convertedLeads: {
            $sum: { $cond: [{ $eq: ["$status", "converted"] }, 1, 0] },
          },
          qualifiedLeads: {
            $sum: { $cond: [{ $eq: ["$status", "qualified"] }, 1, 0] },
          },
          contactedLeads: {
            $sum: { $cond: [{ $eq: ["$status", "contacted"] }, 1, 0] },
          },
        },
      },
    ]);

    const statusBreakdown = await Lead.aggregate([
      { $match: { assignedTo: mongoose.Types.ObjectId(agentId) } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    const tagBreakdown = await Lead.aggregate([
      { $match: { assignedTo: mongoose.Types.ObjectId(agentId) } },
      { $unwind: { path: "$tags", preserveNullAndEmptyArrays: true } },
      { $group: { _id: "$tags", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    res.json({
      success: true,
      data: {
        overview: agentStats[0] || {
          totalLeads: 0,
          convertedLeads: 0,
          qualifiedLeads: 0,
          contactedLeads: 0,
        },
        statusBreakdown: statusBreakdown,
        tagBreakdown: tagBreakdown,
      },
    });
  } catch (error) {
    console.error("Error fetching agent analytics:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching agent analytics",
      error: error.message,
    });
  }
};

// Check for duplicate leads
exports.checkDuplicateLeads = async (req, res) => {
  try {
    // Find duplicates by email (only for leads that have email)
    const duplicatesByEmail = await Lead.aggregate([
      { $match: { email: { $exists: true, $ne: null, $ne: "" } } },
      {
        $group: {
          _id: "$email",
          leads: { $push: "$ROOT" },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
    ]);

    // Find duplicates by full name (potential duplicates)
    const duplicatesByName = await Lead.aggregate([
      { $match: { fullName: { $exists: true, $ne: null, $ne: "" } } },
      {
        $group: {
          _id: "$fullName",
          leads: { $push: "$ROOT" },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } },
    ]);

    res.json({
      success: true,
      data: {
        duplicatesByEmail: duplicatesByEmail,
        duplicatesByName: duplicatesByName,
      },
      summary: {
        emailDuplicates: duplicatesByEmail.length,
        nameDuplicates: duplicatesByName.length,
      },
    });
  } catch (error) {
    console.error("Error checking duplicate leads:", error);
    res.status(500).json({
      success: false,
      message: "Error checking duplicate leads",
      error: error.message,
    });
  }
};

// Merge duplicate leads
exports.mergeDuplicateLeads = async (req, res) => {
  try {
    const { primaryLeadId, duplicateLeadIds } = req.body;

    if (
      !primaryLeadId ||
      !duplicateLeadIds ||
      !Array.isArray(duplicateLeadIds)
    ) {
      return res.status(400).json({
        success: false,
        message: "Primary lead ID and array of duplicate lead IDs are required",
      });
    }

    const primaryLead = await Lead.findById(primaryLeadId);
    if (!primaryLead) {
      return res.status(404).json({
        success: false,
        message: "Primary lead not found",
      });
    }

    const duplicateLeads = await Lead.find({
      _id: { $in: duplicateLeadIds },
    });

    // Merge data from duplicates into primary lead
    let mergedNotes = primaryLead.notes || "";
    let mergedTags = [...(primaryLead.tags || [])];
    let mergedTasks = [...(primaryLead.tasks || [])];

    duplicateLeads.forEach((duplicate) => {
      // Merge notes
      if (duplicate.notes) {
        mergedNotes += `\n\n--- Merged from duplicate lead ${duplicate._id} ---\n${duplicate.notes}`;
      }

      // Merge tags
      if (duplicate.tags) {
        mergedTags = [...new Set([...mergedTags, ...duplicate.tags])];
      }

      // Merge tasks
      if (duplicate.tasks) {
        mergedTasks = [...new Set([...mergedTasks, ...duplicate.tasks])];
      }

      // Use email from duplicate if primary doesn't have one
      if (!primaryLead.email && duplicate.email) {
        primaryLead.email = duplicate.email;
      }

      // Use phone from duplicate if primary doesn't have one
      if (!primaryLead.phoneNumber && duplicate.phoneNumber) {
        primaryLead.phoneNumber = duplicate.phoneNumber;
      }

      // Use company from duplicate if primary doesn't have one
      if (!primaryLead.company && duplicate.company) {
        primaryLead.company = duplicate.company;
      }
    });

    // Update primary lead with merged data
    primaryLead.notes = mergedNotes;
    primaryLead.tags = mergedTags;
    primaryLead.tasks = mergedTasks;
    primaryLead.updatedAt = new Date();

    await primaryLead.save();

    // Delete duplicate leads
    await Lead.deleteMany({ _id: { $in: duplicateLeadIds } });

    const updatedPrimaryLead = await Lead.findById(primaryLeadId)
      .populate("assignedTo", "firstName lastName email")
      .populate("tasks");

    res.json({
      success: true,
      message: "Leads merged successfully",
      data: {
        primaryLead: updatedPrimaryLead,
        mergedCount: duplicateLeads.length,
      },
    });
  } catch (error) {
    console.error("Error merging duplicate leads:", error);
    res.status(500).json({
      success: false,
      message: "Error merging duplicate leads",
      error: error.message,
    });
  }
};

// AI WhatsApp agent hand-off (called by hfs-intelligence with a service key).
//
// The agent reopened a conversation with an existing customer and it has
// reached the point where a person must take over (they want to order, or are
// negotiating price). This lands it on the leads screen as an "ai_generated"
// lead linked to the customer's SAP account, so it is followed up and tracked
// rather than lost in the inbox — and it is never converted into a duplicate.
//
// Idempotent per conversation: a second hand-off on the same thread (or the
// same open customer) updates the lead instead of creating another.
exports.upsertAiHandoffLead = async (req, res) => {
  try {
    const {
      cardCode,
      name,
      phoneNumber,
      email,
      reason,
      reasonLabel,
      summary,
      conversation,
      threadId,
      handedOffAt,
    } = req.body || {};

    if (!name && !cardCode) {
      return res.status(400).json({ success: false, message: "name or cardCode is required" });
    }

    // Resolve the existing account: by CardCode first, then by phone.
    let customer = null;
    if (cardCode) {
      customer = await Customer.findOne({ CardCode: cardCode })
        .select("_id CardCode CardName assignedTo Email phoneNumber")
        .lean();
    }
    if (!customer && phoneNumber) {
      const digits = String(phoneNumber).replace(/\D/g, "");
      const variants = [phoneNumber, digits, `+${digits}`];
      if (digits.startsWith("33")) variants.push(`0${digits.slice(2)}`);
      customer = await Customer.findOne({
        $or: [
          { phoneNumber: { $in: variants } },
          { additionalPhoneNumbers: { $in: variants } },
        ],
      })
        .select("_id CardCode CardName assignedTo Email phoneNumber")
        .lean();
    }

    const sapCardCode = customer?.CardCode || cardCode || undefined;
    const at = handedOffAt ? new Date(handedOffAt) : new Date();
    const convo = Array.isArray(conversation)
      ? conversation.slice(-30).map((m) => ({
          direction: m.direction === "inbound" ? "inbound" : "outbound",
          text: String(m.text || "").slice(0, 2000),
          at: m.at ? new Date(m.at) : undefined,
        }))
      : [];

    const stamp = at.toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
    const noteEntry =
      `[${stamp}] AI agent hand-off — ${reasonLabel || reason || "needs a person"}` +
      (summary ? `\n${summary}` : "");

    const openQuery = {
      sourceType: "ai_generated",
      status: { $nin: ["converted", "dead"] },
      $or: [
        ...(sapCardCode ? [{ sapCardCode }] : []),
        ...(threadId ? [{ "aiHandoff.threadId": String(threadId) }] : []),
      ],
    };
    let lead = openQuery.$or.length ? await Lead.findOne(openQuery) : null;
    const created = !lead;

    if (!lead) {
      lead = new Lead({
        fullName: name || customer?.CardName || sapCardCode,
        company: customer?.CardName || name,
        email: (email || customer?.Email || "").toLowerCase() || undefined,
        phoneNumber: phoneNumber || customer?.phoneNumber,
        status: "qualified",
        sourceType: "ai_generated",
        assignedTo: customer?.assignedTo || undefined,
        notes: noteEntry,
      });
    } else {
      lead.notes = lead.notes ? `${noteEntry}\n\n${lead.notes}` : noteEntry;
    }

    lead.sapCardCode = sapCardCode;
    if (customer?._id) lead.existingCustomer = customer._id;
    lead.tags = [...new Set([...(lead.tags || []), reason === "ready_to_order" ? "hot" : "warm"])];
    lead.aiHandoff = {
      reason,
      reasonLabel,
      threadId: threadId ? String(threadId) : lead.aiHandoff?.threadId,
      summary,
      conversation: convo,
      handedOffAt: at,
    };
    lead.nextFollowUp = lead.nextFollowUp || at;

    await lead.save();

    res.status(created ? 201 : 200).json({
      success: true,
      data: {
        leadId: lead._id,
        created,
        sapCardCode: lead.sapCardCode,
        existingCustomer: Boolean(customer),
        assignedTo: lead.assignedTo || null,
      },
    });
  } catch (error) {
    console.error("Error upserting AI hand-off lead:", error);
    res.status(500).json({
      success: false,
      message: "Error creating AI hand-off lead",
      error: error.message,
    });
  }
};

// WhatsApp chat history for a lead — mainly the AI-generated ones, so whoever
// picks the lead up sees the whole conversation the agent had, plus anything
// said since (the AI agent mirrors every message it sends into WhatsAppMessage,
// and inbound/human messages land there via the webhook). Read live, so it is
// never a stale copy. Falls back to the snapshot sent with the hand-off when
// the phone number matches no conversation.
const conversationIdsFor = (phones) => {
  const ids = new Set();
  for (const raw of phones) {
    if (!raw) continue;
    let d = String(raw).replace(/\D/g, "");
    if (d.startsWith("00")) d = d.slice(2);
    if (d.length === 10 && d.startsWith("0")) d = `33${d.slice(1)}`;
    else if (d.length === 9) d = `33${d}`;
    if (d.length < 8) continue;
    ids.add(`+${d}`);
    ids.add(d);
  }
  return [...ids];
};

const chatText = (m) => {
  const c = m.content || {};
  if (c.text) return typeof c.text === "string" ? c.text : c.text.body || "";
  if (m.metadata?.renderedText) return m.metadata.renderedText;
  if (c.template) return `[Template: ${c.template.name}]`;
  if (c.caption) return c.caption;
  if (c.filename) return `[${m.messageType}: ${c.filename}]`;
  return m.messageType && m.messageType !== "text" ? `[${m.messageType}]` : "";
};

exports.getLeadChatHistory = async (req, res) => {
  try {
    const query = { _id: req.params.id };
    if (req.user.role === "sales_agent") query.assignedTo = req.user._id;

    const lead = await Lead.findOne(query)
      .select("fullName company phoneNumber sapCardCode existingCustomer aiHandoff sourceType")
      .lean();
    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found" });
    }

    const phones = [lead.phoneNumber];
    if (lead.existingCustomer || lead.sapCardCode) {
      const customer = await Customer.findOne(
        lead.existingCustomer ? { _id: lead.existingCustomer } : { CardCode: lead.sapCardCode }
      )
        .select("phoneNumber additionalPhoneNumbers")
        .lean();
      if (customer) phones.push(customer.phoneNumber, ...(customer.additionalPhoneNumbers || []));
    }
    const conversationIds = conversationIdsFor(phones);
    const limit = Math.min(parseInt(req.query.limit, 10) || 300, 1000);

    const rows = conversationIds.length
      ? await WhatsAppMessage.find({ conversationId: { $in: conversationIds } })
          .sort({ timestamp: -1 })
          .limit(limit)
          .populate("salesAgent", "firstName lastName")
          .lean()
      : [];

    let source = "whatsapp";
    let messages = rows.reverse().map((m) => ({
      id: m._id,
      direction: m.direction,
      text: chatText(m),
      at: m.timestamp || m.createdAt,
      messageType: m.messageType,
      mediaUrl: m.content?.mediaUrl,
      status: m.status,
      by:
        m.direction === "inbound"
          ? "customer"
          : m.metadata?.aiAgent
          ? "ai"
          : m.salesAgent
          ? `${m.salesAgent.firstName || ""} ${m.salesAgent.lastName || ""}`.trim() || "agent"
          : "agent",
      sandbox: Boolean(m.metadata?.sandbox),
    }));

    if (!messages.length && lead.aiHandoff?.conversation?.length) {
      source = "handoff_snapshot";
      messages = lead.aiHandoff.conversation.map((m, i) => ({
        id: `snapshot-${i}`,
        direction: m.direction,
        text: m.text,
        at: m.at,
        by: m.direction === "inbound" ? "customer" : "ai",
      }));
    }

    res.json({
      success: true,
      data: {
        source,
        conversationIds,
        handoff: lead.aiHandoff
          ? {
              reason: lead.aiHandoff.reason,
              reasonLabel: lead.aiHandoff.reasonLabel,
              summary: lead.aiHandoff.summary,
              handedOffAt: lead.aiHandoff.handedOffAt,
            }
          : null,
        messages,
        truncated: rows.length === limit,
      },
    });
  } catch (error) {
    console.error("Error fetching lead chat history:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching chat history",
      error: error.message,
    });
  }
};
