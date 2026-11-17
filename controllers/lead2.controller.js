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
        // One lead per owner: any of the owner's Uber Eats brands finds the lead.
        { "brands.title": { $regex: search, $options: "i" } },
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
        // One lead per owner: any of the owner's Uber Eats brands finds the lead.
        { "brands.title": { $regex: search, $options: "i" } },
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
        { "brands.title": s },
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

    const before = await Lead.findById(id).select("assignedTo").lean();
    const reassigned = String(before?.assignedTo || "") !== String(assignedTo);
    const lead = await Lead.findByIdAndUpdate(
      id,
      {
        assignedTo,
        ...(reassigned ? { assignedAt: new Date() } : {}),
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

    // In-app notification + WhatsApp to the agent (not awaited: never slows the click).
    if (reassigned) {
      require("../services/leadFollowUp").onAssigned(lead, assignedTo, { byUserId: req.user?._id });
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

    const changing = await Lead.find({ _id: { $in: leadIds }, assignedTo: { $ne: assignedTo } })
      .select("_id fullName company sourceType aiHandoff.reasonLabel")
      .lean();
    const result = await Lead.updateMany(
      { _id: { $in: leadIds } },
      {
        assignedTo,
        updatedAt: new Date(),
      }
    );
    if (changing.length) {
      await Lead.updateMany({ _id: { $in: changing.map((l) => l._id) } }, { assignedAt: new Date() });
      require("../services/leadFollowUp").onAssigned(changing, assignedTo, { byUserId: req.user?._id });
    }

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
// reached the point where a person must take over: they want to order, asked
// for a call, have a complaint (credit note, refund, delivery, quality), are
// negotiating price, or engaged and then went quiet. This lands it on the
// leads screen as an "ai_generated" lead linked to the customer's SAP
// account, with a follow-up task and a notification for the account's agent
// (admins/managers when nobody owns the account) — so it is worked, not lost
// in the inbox — and it is never converted into a duplicate.
//
// `outcome: "closed"` records a closure instead (business closed, wrong
// number): a dead lead with the reason, so the account is filtered out of
// future lists, and the customer's businessStatus flagged for a person to
// check. No task, no notification.
//
// A complaint also reaches a manager (notifyAiHandoff), and its task title
// starts with "Complaint:" so it stands out in the task inbox.
//
// Idempotent per conversation: a second hand-off on the same thread (or the
// same open customer) updates the lead instead of creating another.
const AI_PRIORITY_TAGS = { high: "hot", medium: "warm", low: "cold" };

const systemSenderFor = async (fallbackId) => {
  if (process.env.SYSTEM_USER_ID) return process.env.SYSTEM_USER_ID;
  const admin = await User.findOne({ role: "admin", deactivated: { $ne: true } }).select("_id").lean();
  return admin?._id || fallbackId;
};

const activeManagerIds = async () =>
  (await User.find({ role: { $in: ["admin", "sales_manager"] }, deactivated: { $ne: true } }).select("_id").lean()).map((u) => u._id);

// Who else hears about a complaint: the agent's manager and everyone in
// AI_COMPLAINT_NOTIFY (comma-separated emails or user ids); all admins and
// sales managers when neither is set.
const complaintWatchers = async (agentId) => {
  const ids = [];
  if (agentId) {
    const agent = await User.findById(agentId).select("manager").lean();
    if (agent?.manager) ids.push(agent.manager);
  }
  const listed = String(process.env.AI_COMPLAINT_NOTIFY || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (listed.length) {
    const mongoose = require("mongoose");
    const users = await User.find({
      deactivated: { $ne: true },
      $or: [
        { _id: { $in: listed.filter((s) => mongoose.isValidObjectId(s)) } },
        { email: { $in: listed.filter((s) => s.includes("@")).map((s) => s.toLowerCase()) } },
      ],
    })
      .select("_id")
      .lean();
    ids.push(...users.map((u) => u._id));
  }
  return ids.length ? ids : activeManagerIds();
};

const notifyAiHandoff = async (lead, task, { reasonLabel, priority, name, complaint = false }) => {
  try {
    const NotificationService = require("../utils/notificationService");
    const recipients = lead.assignedTo ? [lead.assignedTo] : await activeManagerIds();
    // A complaint also reaches a manager, never only the agent.
    const watchers = complaint
      ? (await complaintWatchers(lead.assignedTo)).filter((id) => !recipients.some((r) => String(r) === String(id)))
      : [];
    if (!recipients.length && !watchers.length) return;
    const sender = await systemSenderFor(recipients[0] || watchers[0]);
    const urgent = priority === "high" || complaint ? "🔴 " : "";
    const send = (recipient, title, message) =>
      NotificationService.createNotification({
        recipient,
        sender,
        type: "lead_assigned",
        title,
        message,
        relatedLead: lead._id,
        relatedTask: task?._id || null,
        allowSelfNotify: true,
      });
    for (const recipient of recipients) {
      await send(
        recipient,
        `${urgent}${complaint ? "Complaint" : "AI lead"}: ${name}`,
        `${reasonLabel}${lead.assignedTo ? "" : " — nobody owns this account, please assign it."}`
      );
    }
    for (const recipient of [...new Set(watchers.map(String))]) {
      await send(recipient, `🔴 Complaint: ${name}`, `${reasonLabel}${lead.assignedTo ? " — the account's agent has it as a task." : " — nobody owns this account, please assign it."}`);
    }
  } catch (err) {
    console.warn("[ai-handoff] notification failed:", err.message);
  }
};

// The open AI lead for this account or conversation (never a converted or dead one).
const findOpenAiLead = ({ sapCardCode, threadId }) => {
  const or = [...(sapCardCode ? [{ sapCardCode }] : []), ...(threadId ? [{ "aiHandoff.threadId": String(threadId) }] : [])];
  return or.length ? Lead.findOne({ sourceType: "ai_generated", status: { $nin: ["converted", "dead"] }, $or: or }) : null;
};

// A new (unsaved) AI lead on an existing SAP account.
const newAiLead = (customer, { name, email, phoneNumber, sapCardCode, status = "qualified", notes }) =>
  new Lead({
    fullName: name || customer?.CardName || sapCardCode,
    company: customer?.CardName || name,
    email: (email || customer?.Email || "").toLowerCase() || undefined,
    phoneNumber: phoneNumber || customer?.phoneNumber,
    status,
    sourceType: "ai_generated",
    assignedTo: customer?.assignedTo || undefined,
    notes,
  });

// What an AI closure says about the business itself.
const BUSINESS_STATUS_FOR = { business_closed: "closed", business_sold: "sold", wrong_number: "wrong_number" };

exports.upsertAiHandoffLead = async (req, res) => {
  try {
    const {
      cardCode,
      name,
      phoneNumber,
      email,
      outcome = "handoff",
      reason,
      reasonLabel,
      priority = "medium",
      intent,
      complaintTopic,
      products,
      silent,
      salesStage,
      campaignId,
      campaignName,
      priceSheet,
      account,
      summary,
      conversation,
      threadId,
      handedOffAt,
    } = req.body || {};

    if (!name && !cardCode) {
      return res.status(400).json({ success: false, message: "name or cardCode is required" });
    }
    const isClosure = outcome === "closed";

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
          author: m.author ? String(m.author).slice(0, 20) : undefined,
        }))
      : [];

    const stamp = at.toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
    const noteEntry =
      `[${stamp}] ${isClosure ? "AI agent closed the conversation" : "AI agent hand-off"} — ${reasonLabel || reason || "needs a person"}` +
      (summary ? `\n${summary}` : "");

    let lead = await findOpenAiLead({ sapCardCode, threadId });
    const created = !lead;

    if (!lead) {
      lead = newAiLead(customer, { name, email, phoneNumber, sapCardCode, status: isClosure ? "dead" : "qualified", notes: noteEntry });
    } else {
      lead.notes = lead.notes ? `${noteEntry}\n\n${lead.notes}` : noteEntry;
      if (isClosure) lead.status = "dead";
      if (!lead.assignedTo && customer?.assignedTo) lead.assignedTo = customer.assignedTo;
    }
    // Nobody owns the account: the agent with the fewest open AI leads gets it.
    const leadFollowUp = require("../services/leadFollowUp");
    if (!isClosure && !lead.assignedTo) {
      const agent = await leadFollowUp.pickAgentForAiLead();
      if (agent) lead.assignedTo = agent._id;
    }
    const newlyAssigned = Boolean(lead.assignedTo) && (lead.isNew || lead.isModified("assignedTo"));
    if (newlyAssigned) lead.assignedAt = new Date();

    lead.sapCardCode = sapCardCode;
    if (customer?._id) lead.existingCustomer = customer._id;
    if (!isClosure) {
      const tags = new Set([...(lead.tags || [])].filter((t) => !["hot", "warm", "cold"].includes(t)));
      tags.add(AI_PRIORITY_TAGS[priority] || "warm");
      if (reason === "complaint") tags.add("priority");
      lead.tags = [...tags];
    }
    lead.aiHandoff = {
      reason,
      reasonLabel,
      outcome: isClosure ? "closed" : "handoff",
      priority: isClosure ? "low" : priority,
      intent,
      complaintTopic,
      products: Array.isArray(products) ? products.slice(0, 10).map(String) : [],
      silent: Boolean(silent),
      salesStage,
      campaignId,
      campaignName,
      priceSheet: Array.isArray(priceSheet) ? priceSheet.slice(0, 15) : [],
      account: account || undefined,
      threadId: threadId ? String(threadId) : lead.aiHandoff?.threadId,
      summary,
      conversation: convo,
      handedOffAt: at,
      taskId: lead.aiHandoff?.taskId,
    };
    if (!isClosure) {
      // Pull the follow-up forward to now; never push an earlier one back.
      lead.nextFollowUp = lead.nextFollowUp && lead.nextFollowUp < at ? lead.nextFollowUp : at;
    }

    await lead.save();

    // Business closed / wrong number: flag the account (a warning on the
    // customer page — the shop may have been sold and the number changed).
    if (isClosure && customer?._id && BUSINESS_STATUS_FOR[reason]) {
      const lastSaid = [...convo].reverse().find((m) => m.direction === "inbound")?.text;
      await Customer.updateOne(
        { _id: customer._id },
        {
          $set: {
            businessStatus: BUSINESS_STATUS_FOR[reason],
            businessStatusReason: String(summary || lastSaid || reasonLabel || reason).slice(0, 1000),
            businessStatusAt: at,
            businessStatusBy: "ai",
          },
        }
      );
    }

    // A task for whoever owns the account: complaints and orders are due now,
    // the rest within the working day.
    const complaint = reason === "complaint" || outcome === "complaint";
    let task = null;
    if (!isClosure && lead.assignedTo) {
      const existing = lead.aiHandoff.taskId
        ? await Task.findOne({ _id: lead.aiHandoff.taskId, status: { $in: ["pending", "pending_approval"] } })
        : null;
      const due = priority === "high" ? at : new Date(at.getTime() + 4 * 3600 * 1000);
      const title = (
        complaint
          ? `Complaint: ${complaintTopic ? `${String(complaintTopic).replace(/_/g, " ")} — ` : ""}${lead.company || lead.fullName}`
          : `AI lead — ${reasonLabel || reason}: ${lead.company || lead.fullName}`
      ).slice(0, 200);
      const description = summary || reasonLabel || "";
      if (existing) {
        existing.title = title;
        existing.description = description;
        existing.priority = priority;
        existing.dueDate = due;
        await existing.save();
        task = existing;
      } else {
        task = await Task.create({
          title,
          description,
          leadId: lead._id,
          priority,
          type: ["callback", "warm_no_reply", "negotiation_no_reply", "missed_window"].includes(reason) ? "call" : "follow-up",
          dueDate: due,
          assignedTo: lead.assignedTo,
          createdBy: await systemSenderFor(lead.assignedTo),
          relatedCustomer: customer?._id,
        });
        lead.tasks = [...(lead.tasks || []), task._id];
        lead.aiHandoff.taskId = task._id;
        await lead.save();
      }
    }

    if (!isClosure) {
      await notifyAiHandoff(lead, task, {
        reasonLabel: reasonLabel || reason || "Needs a person",
        priority,
        name: lead.company || lead.fullName,
        complaint,
      });
      // WhatsApp the agent: on a new assignment, and on every urgent hand-off.
      if (lead.assignedTo && (newlyAssigned || priority === "high")) {
        await leadFollowUp.onAssigned(lead, lead.assignedTo, { inApp: false, reasonLabel: reasonLabel || reason });
      }
    }

    res.status(created ? 201 : 200).json({
      success: true,
      data: {
        leadId: lead._id,
        created,
        status: lead.status,
        sapCardCode: lead.sapCardCode,
        existingCustomer: Boolean(customer),
        assignedTo: lead.assignedTo || null,
        taskId: task?._id || null,
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

// A manager puts an outreach account in an agent's hands from the AI Outreach
// batch table — replied or not ("good customer, have someone call them"):
// the account's open AI lead (or a new one) goes to the agent with the note,
// a call task due now, and a notification + WhatsApp. Called by
// aiOutreach.controller; throws errors carrying `status`.
exports.assignAiAccount = async ({ cardCode, threadId, agentId, note, user }) => {
  const fail = (message, status) => Object.assign(new Error(message), { status });
  const customer = await Customer.findOne({ CardCode: cardCode }).select("_id CardCode CardName assignedTo Email phoneNumber").lean();
  if (!customer) throw fail("Customer not found", 404);
  const agent = await User.findOne({ _id: agentId, role: { $in: ["sales_agent", "sales_manager"] }, deactivated: { $ne: true } })
    .select("_id firstName lastName")
    .lean();
  if (!agent) throw fail("Choose an active sales agent or manager", 400);

  const at = new Date();
  const byName = `${user?.firstName || ""} ${user?.lastName || ""}`.trim() || user?.email || "a manager";
  const agentName = `${agent.firstName || ""} ${agent.lastName || ""}`.trim();
  const cleanNote = String(note || "").trim().slice(0, 2000);
  const noteEntry =
    `[${at.toLocaleString("fr-FR", { timeZone: "Europe/Paris" })}] Assigned to ${agentName} by ${byName} from AI Outreach` +
    (cleanNote ? `\n${cleanNote}` : "");

  let lead = await findOpenAiLead({ sapCardCode: customer.CardCode, threadId });
  const created = !lead;
  if (!lead) {
    lead = newAiLead(customer, { sapCardCode: customer.CardCode, notes: noteEntry });
    lead.aiHandoff = {
      reason: "manual_assign",
      reasonLabel: "Assigned from AI Outreach",
      outcome: "handoff",
      priority: "medium",
      threadId: threadId ? String(threadId) : undefined,
      summary: cleanNote || undefined,
      handedOffAt: at,
    };
  } else {
    lead.notes = lead.notes ? `${noteEntry}\n\n${lead.notes}` : noteEntry;
    if (threadId && !lead.aiHandoff?.threadId) lead.set("aiHandoff.threadId", String(threadId));
  }
  const reassigned = String(lead.assignedTo || "") !== String(agent._id);
  lead.assignedTo = agent._id;
  if (reassigned || lead.isNew) lead.assignedAt = at;
  lead.sapCardCode = customer.CardCode;
  lead.existingCustomer = customer._id;
  lead.nextFollowUp = at;
  await lead.save();

  // The open hand-off task follows the lead to the new agent; otherwise a new call task.
  const title = `AI Outreach — call back: ${lead.company || lead.fullName}`.slice(0, 200);
  const description = cleanNote || `Assigned by ${byName} from AI Outreach.`;
  let task = lead.aiHandoff?.taskId
    ? await Task.findOne({ _id: lead.aiHandoff.taskId, status: { $in: ["pending", "pending_approval"] } })
    : null;
  if (task) {
    task.assignedTo = agent._id;
    task.dueDate = at;
    task.description = [task.description, cleanNote && `Note from ${byName}: ${cleanNote}`].filter(Boolean).join("\n\n");
    await task.save();
  } else {
    task = await Task.create({
      title,
      description,
      leadId: lead._id,
      priority: "medium",
      type: "call",
      dueDate: at,
      assignedTo: agent._id,
      createdBy: user?._id || (await systemSenderFor(agent._id)),
      relatedCustomer: customer._id,
    });
    lead.tasks = [...(lead.tasks || []), task._id];
    lead.aiHandoff.taskId = task._id;
    await lead.save();
  }

  const reasonLabel = cleanNote ? `From ${byName}: ${cleanNote}` : `Assigned to you by ${byName} from AI Outreach`;
  await notifyAiHandoff(lead, task, { reasonLabel, priority: "medium", name: lead.company || lead.fullName });
  const leadFollowUp = require("../services/leadFollowUp");
  await leadFollowUp.onAssigned(lead, agent._id, { inApp: false, reasonLabel });

  return { leadId: lead._id, created, taskId: task._id, assignedTo: agent._id, assignedToName: agentName };
};

// Uber Eats stores HalalSales already knows — for hfs-intelligence, so the
// catalogue campaign never emails an existing customer or lead. Uses the same
// matching as the Uber Eats Scraper page (utils/prospectContext), plus every
// customer and lead email. Service key.
exports.getAiProspectExclusions = async (req, res) => {
  try {
    const { existingUeMatches } = require("../utils/prospectContext");
    const { ueCollections } = require("../utils/ubereatsDb");
    const matched = [...(await existingUeMatches()).keys()];
    let assigned = [];
    try {
      const c = await ueCollections();
      assigned = await c.restaurants.distinct("uuid", { "assignment.agentId": { $exists: true } });
    } catch (err) {
      console.warn("[ai-prospect-exclusions] Uber Eats stores unavailable:", err.message);
    }
    const [customerEmails, leadEmails] = await Promise.all([
      Customer.distinct("Email", { Email: { $nin: [null, ""] } }),
      Lead.distinct("email", { email: { $nin: [null, ""] } }),
    ]);
    const emails = [...new Set([...customerEmails, ...leadEmails].map((e) => String(e).trim().toLowerCase()).filter((e) => e.includes("@")))];
    res.json({ success: true, data: { uuids: [...new Set([...matched, ...assigned])], emails } });
  } catch (error) {
    console.error("Error computing AI prospect exclusions:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// A prospect (an Uber Eats restaurant) answered the AI's catalogue email:
// a lead for the agent who covers their postcode (the Uber Eats Scraper's
// "Assign postal codes"), linked to the store(s) exactly like the scraper's
// own assign — so the page shows them as taken and never duplicates the lead
// — with the conversation, a task and a notification. Service key.
exports.upsertAiProspectLead = async (req, res) => {
  try {
    const {
      name, email, phoneNumber, uberEatsUuids = [], brands = [], categories = [], postalCode, address,
      registrationNumber, channel, reason, reasonLabel, priority = "medium", intent, products,
      campaignId, campaignName, summary, conversation, threadId, handedOffAt,
    } = req.body || {};
    if (!name && !email) return res.status(400).json({ success: false, message: "name or email is required" });

    const { ueCollections } = require("../utils/ubereatsDb");
    let c = null;
    let stores = [];
    try {
      c = await ueCollections();
      stores = uberEatsUuids.length
        ? await c.restaurants
            .find(
              { uuid: { $in: uberEatsUuids } },
              { projection: { uuid: 1, title: 1, url: 1, assignment: 1, menuItemCount: 1, legal: 1, phoneNumber: 1, email: 1, postalCode: 1, location: 1, registrationNumber: 1 } }
            )
            .toArray()
        : [];
    } catch (err) {
      console.warn("[ai-prospect-handoff] Uber Eats stores unavailable:", err.message);
    }
    // One lead per owner (services/ubereats/owners.js): a lead the owner already has for another
    // of their brands is the one to update.
    let ownerUuids = [...uberEatsUuids];
    let ownerKey = null;
    if (c && uberEatsUuids.length) {
      try {
        const { ownerIndex, groupOfStore } = require("../services/ubereats/owners");
        const index = await ownerIndex(c);
        const groups = uberEatsUuids.map((u) => groupOfStore(index, u));
        ownerUuids = [...new Set(groups.flatMap((g) => g.uuids))];
        ownerKey = groups.map((g) => g.key).find((k) => !k.startsWith("uuid:")) || null;
      } catch (err) {
        console.warn("[ai-prospect-handoff] owner groups unavailable:", err.message);
      }
    }

    // Who follows it up: whoever already has the store, else the agent whose
    // postal codes cover it.
    let agentId = stores.find((s) => s.assignment?.agentId)?.assignment.agentId || null;
    if (!agentId && postalCode) {
      const agent = await User.findOne({
        role: { $in: ["sales_agent", "sales_manager"] },
        deactivated: { $ne: true },
        assignedPostalCodes: String(postalCode),
      })
        .sort({ role: -1, firstName: 1 }) // sales_agent before sales_manager
        .select("_id")
        .lean();
      agentId = agent?._id || null;
    }
    const leadFollowUp = require("../services/leadFollowUp");
    if (!agentId) agentId = (await leadFollowUp.pickAgentForAiLead())?._id || null;

    const at = handedOffAt ? new Date(handedOffAt) : new Date();
    const convo = Array.isArray(conversation)
      ? conversation.slice(-30).map((m) => ({
          direction: m.direction === "inbound" ? "inbound" : "outbound",
          text: String(m.text || "").slice(0, 2000),
          at: m.at ? new Date(m.at) : undefined,
          author: m.author ? String(m.author).slice(0, 20) : undefined,
        }))
      : [];
    const stamp = at.toLocaleString("fr-FR", { timeZone: "Europe/Paris" });
    const noteEntry = `[${stamp}] AI catalogue reply (${channel || "email"}) — ${reasonLabel || reason || "replied"}${summary ? `\n${summary}` : ""}`;

    let lead = await Lead.findOne({
      status: { $nin: ["converted", "dead"] },
      $or: [
        ...(ownerUuids.length ? [{ relatedUberEatsUuid: { $in: ownerUuids } }, { "brands.uuid": { $in: ownerUuids } }] : []),
        ...(ownerKey ? [{ ownerKey }] : []),
        ...(threadId ? [{ "aiHandoff.threadId": String(threadId) }] : []),
      ],
    });
    const created = !lead;
    const first = stores[0] || {};
    const brandList = brands.length ? brands : [name];
    if (!lead) {
      lead = new Lead({
        fullName: name || brandList[0],
        company: brandList[0],
        email: (email || "").toLowerCase() || undefined,
        phoneNumber: phoneNumber || undefined,
        status: "qualified",
        sourceType: "ai_generated",
        assignedTo: agentId || undefined,
        relatedUberEatsUuid: uberEatsUuids[0],
        ownerKey: ownerKey || undefined,
        brands: stores.map((s) => require("../services/ubereats/owners").brandOf(s, at)),
        restaurantData: {
          name: brandList[0],
          postalCode: postalCode || "",
          menuItemsCount: first.menuItemCount || 0,
          contactInfo: { email: email || "", phone: phoneNumber || "", address: address || "" },
          url: first.url,
          registrationNumber: registrationNumber || undefined,
          registry: first.legal?.registry || undefined,
        },
        notes: noteEntry,
      });
    } else {
      lead.notes = lead.notes ? `${noteEntry}\n\n${lead.notes}` : noteEntry;
      if (!lead.assignedTo && agentId) lead.assignedTo = agentId;
      if (lead.sourceType !== "ai_generated" && lead.status === "new") lead.status = "qualified";
    }
    const tags = new Set([...(lead.tags || [])].filter((t) => !["hot", "warm", "cold"].includes(t)));
    tags.add(AI_PRIORITY_TAGS[priority] || "warm");
    lead.tags = [...tags];
    lead.aiHandoff = {
      reason,
      reasonLabel,
      outcome: "handoff",
      priority,
      intent,
      products: Array.isArray(products) ? products.slice(0, 10).map(String) : [],
      silent: false,
      salesStage: "prospect_replied",
      campaignId,
      campaignName,
      threadId: threadId ? String(threadId) : lead.aiHandoff?.threadId,
      summary: [summary, brandList.length > 1 ? `Brands: ${brandList.join(", ")}` : "", categories.length ? `Cuisine: ${categories.join(", ")}` : ""]
        .filter(Boolean)
        .join("\n"),
      conversation: convo,
      handedOffAt: at,
      taskId: lead.aiHandoff?.taskId,
    };
    lead.nextFollowUp = lead.nextFollowUp && lead.nextFollowUp < at ? lead.nextFollowUp : at;
    const newlyAssigned = Boolean(lead.assignedTo) && (lead.isNew || lead.isModified("assignedTo"));
    if (newlyAssigned) lead.assignedAt = at;
    await lead.save();
    // The owner's lead found through another brand: list these stores on it too.
    if (c && !created && stores.length) {
      await require("../services/ubereats/ownerLeads").addBrands(c, lead, stores, { ownerKey: ownerKey || undefined, at });
    }

    // Mark the store(s) as taken on the Uber Eats Scraper page, as its own assign does,
    // with the agent of the lead (an owner's existing lead keeps its agent).
    if (lead.assignedTo) agentId = lead.assignedTo;
    if (c && agentId) {
      const agent = await User.findById(agentId).select("firstName lastName email").lean();
      const agentName = `${agent?.firstName || ""} ${agent?.lastName || ""}`.trim() || agent?.email || "Agent";
      await c.restaurants.updateMany(
        { uuid: { $in: uberEatsUuids }, "assignment.agentId": { $exists: false } },
        { $set: { assignment: { agentId, agentName, assignedByName: "AI catalogue reply", assignedAt: at, priority, leadId: lead._id } } }
      );
      try {
        require("../utils/prospectContext").invalidate?.();
      } catch {
        /* cache refreshes on its own */
      }
    }

    let task = null;
    if (lead.assignedTo) {
      const existing = lead.aiHandoff.taskId
        ? await Task.findOne({ _id: lead.aiHandoff.taskId, status: { $in: ["pending", "pending_approval"] } })
        : null;
      const due = priority === "high" ? at : new Date(at.getTime() + 4 * 3600 * 1000);
      const title = `AI catalogue reply — ${reasonLabel || reason}: ${brandList[0]}`.slice(0, 200);
      if (existing) {
        Object.assign(existing, { title, description: lead.aiHandoff.summary, priority, dueDate: due });
        await existing.save();
        task = existing;
      } else {
        task = await Task.create({
          title,
          description: lead.aiHandoff.summary,
          leadId: lead._id,
          priority,
          type: "call",
          dueDate: due,
          assignedTo: lead.assignedTo,
          createdBy: await systemSenderFor(lead.assignedTo),
        });
        lead.tasks = [...(lead.tasks || []), task._id];
        lead.aiHandoff.taskId = task._id;
        await lead.save();
      }
    }

    await notifyAiHandoff(lead, task, {
      reasonLabel: `${reasonLabel || "Replied to the catalogue"}${postalCode ? ` (${postalCode})` : ""}`,
      priority,
      name: brandList[0],
    });
    if (lead.assignedTo && (newlyAssigned || priority === "high")) {
      await leadFollowUp.onAssigned(lead, lead.assignedTo, {
        inApp: false,
        reasonLabel: `${reasonLabel || "Replied to the catalogue"}${postalCode ? ` (${postalCode})` : ""}`,
      });
    }

    let assignedToName = null;
    if (lead.assignedTo) {
      const u = await User.findById(lead.assignedTo).select("firstName lastName").lean();
      assignedToName = `${u?.firstName || ""} ${u?.lastName || ""}`.trim() || null;
    }
    res.status(created ? 201 : 200).json({
      success: true,
      data: { leadId: lead._id, created, assignedTo: lead.assignedTo || null, assignedToName, taskId: task?._id || null },
    });
  } catch (error) {
    console.error("Error upserting AI prospect lead:", error);
    res.status(500).json({ success: false, message: "Error creating AI prospect lead", error: error.message });
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
      .select("fullName company phoneNumber sapCardCode existingCustomer aiHandoff sourceType brands.phone")
      .lean();
    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found" });
    }

    // One lead per owner: a brand of the owner may have been messaged on its own number.
    const phones = [lead.phoneNumber, ...(lead.brands || []).map((b) => b.phone)];
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


// ── Lead follow-up (services/leadFollowUp.js) ───────────────────────

// Log a call / message on a lead. A call nobody answered needs the next
// follow-up time; a conversation needs a note of what was said.
exports.logLeadContact = async (req, res) => {
  const leadFollowUp = require("../services/leadFollowUp");
  try {
    const query = { _id: req.params.id };
    if (req.user.role === "sales_agent") query.assignedTo = req.user._id;
    const lead = await Lead.findOne(query);
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found or not yours" });
    await leadFollowUp.logContact(lead, req.user, req.body || {});
    const populated = await Lead.findById(lead._id).populate("assignedTo", "firstName lastName email").populate("tasks");
    res.json({ success: true, message: "Logged", data: populated });
  } catch (error) {
    if (error instanceof leadFollowUp.LogError) return res.status(400).json({ success: false, message: error.message });
    console.error("Error logging lead contact:", error);
    res.status(500).json({ success: false, message: "Error logging the call", error: error.message });
  }
};

// End-of-day follow-up report: ?date=YYYY-MM-DD (Paris day, default today).
// Agents see only their own row.
exports.getLeadDailyReport = async (req, res) => {
  try {
    const { dailyReport } = require("../services/leadFollowUp");
    const report = await dailyReport(req.query.date);
    if (req.user.role === "sales_agent") report.agents = report.agents.filter((a) => a.agentId === String(req.user._id));
    res.json({ success: true, data: report });
  } catch (error) {
    console.error("Error building lead report:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Email the report now (managers), e.g. to check it before the evening run.
exports.sendLeadDailyReport = async (req, res) => {
  try {
    const { sendDailyReport } = require("../services/leadFollowUp");
    const r = await sendDailyReport(req.body?.date || req.query.date);
    res.json({ success: true, data: { sent: r.sent, reason: r.reason, to: r.to } });
  } catch (error) {
    console.error("Error sending lead report:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// Give every open AI lead nobody owns to an agent (same rule as new ones).
// ?dryRun=true lists who would get what without changing anything.
exports.autoAssignAiLeads = async (req, res) => {
  try {
    const leadFollowUp = require("../services/leadFollowUp");
    const dryRun = String(req.query.dryRun ?? req.body?.dryRun) === "true";
    const leads = await Lead.find({
      sourceType: "ai_generated",
      status: { $nin: ["converted", "dead"] },
      $or: [{ assignedTo: { $exists: false } }, { assignedTo: null }],
    }).sort({ createdAt: 1 });
    const pool = await leadFollowUp.agentPool();
    const planned = new Map(); // dry run: spread as the real run would
    const out = [];
    for (const lead of leads) {
      let agent;
      if (dryRun) {
        agent = pool.map((u) => ({ u, n: planned.get(String(u._id)) || 0 })).sort((a, b) => a.n - b.n)[0]?.u;
        if (agent) planned.set(String(agent._id), (planned.get(String(agent._id)) || 0) + 1);
      } else {
        agent = await leadFollowUp.pickAgentForAiLead();
      }
      if (!agent) break;
      out.push({ leadId: lead._id, lead: lead.company || lead.fullName, agentId: agent._id, agent: `${agent.firstName || ""} ${agent.lastName || ""}`.trim() });
      if (dryRun) continue;
      lead.assignedTo = agent._id;
      lead.assignedAt = new Date();
      await lead.save();
      if (lead.aiHandoff?.taskId) await Task.updateOne({ _id: lead.aiHandoff.taskId }, { assignedTo: agent._id }).catch(() => {});
      await leadFollowUp.onAssigned(lead, agent._id, { byUserId: req.user?._id });
    }
    res.json({ success: true, dryRun, count: out.length, data: out });
  } catch (error) {
    console.error("Error auto-assigning AI leads:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
