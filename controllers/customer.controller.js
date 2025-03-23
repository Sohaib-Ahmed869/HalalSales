const Customer = require("../models/Customer");
const User = require("../models/User");

// Get all customers
exports.getCustomers = async (req, res) => {
  try {
    const { status, search, assignedTo } = req.query;
    const query = {};

    // Apply filters if provided
    if (status) query.status = status;

    // Search by name, code or email
    if (search) {
      query.$or = [
        { CardName: { $regex: search, $options: "i" } },
        { CardCode: { $regex: search, $options: "i" } },
        { Email: { $regex: search, $options: "i" } },
      ];
    }

    // Filter by assigned agent
    if (assignedTo) {
      query.assignedTo = assignedTo;
    }

    // Role-based queries
    if (req.user.role === "sales_agent") {
      // Sales agents can only see customers assigned to them
      query.assignedTo = req.user._id;
    } else if (req.user.role === "sales_manager") {
      // Sales managers can see all customers assigned to their agents
      if (!assignedTo) {
        const salesAgents = await User.find({
          role: "sales_agent",
          manager: req.user._id,
        }).select("_id");

        const agentIds = salesAgents.map((agent) => agent._id);
        query.assignedTo = { $in: agentIds };
      }
    }
    // Admins can see all customers

    const customers = await Customer.find(query).populate(
      "assignedTo",
      "firstName lastName email hubspotId"
    );

    res.json(customers);
  } catch (error) {
    console.error("Customer fetch error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Get customer by ID
exports.getCustomerById = async (req, res) => {
  try {
    const customerId = req.params.id;
    let customer;

    // Role-based permissions
    if (req.user.role === "admin") {
      // Admin can see any customer
      customer = await Customer.findById(customerId).populate(
        "assignedTo",
        "firstName lastName email hubspotId"
      );
    } else if (req.user.role === "sales_manager") {
      // Get all agents managed by this manager
      const salesAgents = await User.find({
        role: "sales_agent",
        manager: req.user._id,
      }).select("_id");

      const agentIds = salesAgents.map((agent) => agent._id);

      // Find customer assigned to one of those agents
      customer = await Customer.findOne({
        _id: customerId,
        assignedTo: { $in: agentIds },
      }).populate("assignedTo", "firstName lastName email hubspotId");
    } else {
      // Sales agent can only see assigned customers
      customer = await Customer.findOne({
        _id: customerId,
        assignedTo: req.user._id,
      }).populate("assignedTo", "firstName lastName email hubspotId");
    }

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.json(customer);
  } catch (error) {
    console.error("Customer fetch error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Create customer
exports.createCustomer = async (req, res) => {
  try {
    const {
      CardName,
      CardCode,
      Email,
      phoneNumber,
      hubspotId,
      assignedTo,
      status,
      notes,
    } = req.body;

    // Validate required fields
    if (!CardName || !CardCode || !Email) {
      return res
        .status(400)
        .json({ message: "CardName, CardCode, and Email are required" });
    }

    // Check if customer already exists
    const existingCustomer = await Customer.findOne({ CardCode });
    if (existingCustomer) {
      return res
        .status(400)
        .json({ message: "Customer with this CardCode already exists" });
    }

    // Validate assigned agent if provided
    if (assignedTo) {
      const agent = await User.findById(assignedTo);

      if (!agent || agent.role !== "sales_agent") {
        return res.status(400).json({ message: "Invalid sales agent ID" });
      }

      // Sales manager can only assign to their agents
      if (req.user.role === "sales_manager") {
        if (agent.manager.toString() !== req.user._id.toString()) {
          return res
            .status(403)
            .json({
              message: "You can only assign customers to your sales agents",
            });
        }
      }
    }

    // Create new customer
    const newCustomer = new Customer({
      CardName,
      CardCode,
      Email,
      phoneNumber,
      hubspotId,
      assignedTo,
      status: status || "active",
      notes,
    });

    await newCustomer.save();

    res.status(201).json({
      message: "Customer created successfully",
      customer: newCustomer,
    });
  } catch (error) {
    console.error("Customer creation error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Update customer
exports.updateCustomer = async (req, res) => {
  try {
    const customerId = req.params.id;
    const {
      CardName,
      CardCode,
      Email,
      phoneNumber,
      hubspotId,
      assignedTo,
      status,
      notes,
    } = req.body;

    // Find customer
    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    // Build update object
    const updateData = {};
    if (CardName) updateData.CardName = CardName;
    if (CardCode) updateData.CardCode = CardCode;
    if (Email) updateData.Email = Email;
    if (phoneNumber !== undefined) updateData.phoneNumber = phoneNumber;
    if (hubspotId !== undefined) updateData.hubspotId = hubspotId;
    if (status) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes;

    // Handle assignedTo separately with permission checks
    if (assignedTo !== undefined) {
      // Only admin and sales manager can reassign
      if (req.user.role === "sales_agent") {
        return res
          .status(403)
          .json({ message: "Sales agents cannot reassign customers" });
      }

      if (assignedTo) {
        // Verify assigned agent exists and is a sales agent
        const agent = await User.findById(assignedTo);
        if (!agent || agent.role !== "sales_agent") {
          return res.status(400).json({ message: "Invalid sales agent ID" });
        }

        // Sales manager can only assign to their agents
        if (req.user.role === "sales_manager") {
          if (agent.manager.toString() !== req.user._id.toString()) {
            return res
              .status(403)
              .json({
                message: "You can only assign customers to your sales agents",
              });
          }
        }
      }

      updateData.assignedTo = assignedTo;
    }

    // Update customer
    const updatedCustomer = await Customer.findByIdAndUpdate(
      customerId,
      updateData,
      { new: true, runValidators: true }
    ).populate("assignedTo", "firstName lastName email hubspotId");

    res.json({
      message: "Customer updated successfully",
      customer: updatedCustomer,
    });
  } catch (error) {
    console.error("Customer update error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Import customers from SAP or external source
exports.importCustomers = async (req, res) => {
  try {
    const { customers } = req.body;

    if (!customers || !Array.isArray(customers) || customers.length === 0) {
      return res
        .status(400)
        .json({ message: "Valid customers array is required" });
    }

    const results = {
      total: customers.length,
      created: 0,
      updated: 0,
      failed: 0,
      errors: [],
    };

    // Process each customer
    for (const customerData of customers) {
      try {
        // Check required fields
        if (
          !customerData.CardName ||
          !customerData.CardCode ||
          !customerData.Email
        ) {
          results.failed++;
          results.errors.push({
            CardCode: customerData.CardCode || "unknown",
            error: "Missing required fields (CardName, CardCode, or Email)",
          });
          continue;
        }

        // Check if customer exists
        const existingCustomer = await Customer.findOne({
          CardCode: customerData.CardCode,
        });

        if (existingCustomer) {
          // Update existing customer
          await Customer.updateOne(
            { CardCode: customerData.CardCode },
            {
              $set: {
                CardName: customerData.CardName,
                Email: customerData.Email,
                phoneNumber: customerData.phoneNumber,
                updatedAt: Date.now(),
              },
            }
          );
          results.updated++;
        } else {
          // Create new customer
          const newCustomer = new Customer({
            CardName: customerData.CardName,
            CardCode: customerData.CardCode,
            Email: customerData.Email,
            phoneNumber: customerData.phoneNumber,
          });

          await newCustomer.save();
          results.created++;
        }
      } catch (err) {
        results.failed++;
        results.errors.push({
          CardCode: customerData.CardCode || "unknown",
          error: err.message,
        });
      }
    }

    res.json({
      message: "Import completed",
      results,
    });
  } catch (error) {
    console.error("Customer import error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Assign/reassign customer
exports.assignCustomer = async (req, res) => {
  try {
    const { id } = req.params;
    const { assignedTo } = req.body;

    if (!assignedTo) {
      return res
        .status(400)
        .json({ message: "Sales agent ID (assignedTo) is required" });
    }

    // Check if customer exists
    const customer = await Customer.findById(id);
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    // Verify assigned agent exists and is a sales agent
    const agent = await User.findById(assignedTo);
    if (!agent || agent.role !== "sales_agent") {
      return res.status(400).json({ message: "Invalid sales agent ID" });
    }

    // Sales manager can only assign to their agents
    if (req.user.role === "sales_manager") {
      if (agent.manager.toString() !== req.user._id.toString()) {
        return res
          .status(403)
          .json({
            message: "You can only assign customers to your sales agents",
          });
      }
    }

    // Update customer
    customer.assignedTo = assignedTo;
    await customer.save();

    const updatedCustomer = await Customer.findById(id).populate(
      "assignedTo",
      "firstName lastName email hubspotId"
    );

    res.json({
      message: "Customer assigned successfully",
      customer: updatedCustomer,
    });
  } catch (error) {
    console.error("Customer assignment error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Get customers assigned to a specific sales agent
exports.getCustomersByAgent = async (req, res) => {
  try {
    const { agentId } = req.params;

    // Permission checks
    if (
      req.user.role === "sales_agent" &&
      req.user._id.toString() !== agentId
    ) {
      return res
        .status(403)
        .json({ message: "You can only view your own customers" });
    }

    if (req.user.role === "sales_manager") {
      // Check if the agent belongs to this manager
      const agent = await User.findById(agentId);
      if (
        !agent ||
        agent.role !== "sales_agent" ||
        agent.manager.toString() !== req.user._id.toString()
      ) {
        return res
          .status(403)
          .json({
            message: "You can only view customers of your sales agents",
          });
      }
    }

    // Get customers
    const customers = await Customer.find({ assignedTo: agentId }).populate(
      "assignedTo",
      "firstName lastName email hubspotId"
    );

    res.json(customers);
  } catch (error) {
    console.error("Customer fetch error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Add notes to customer
exports.addNotes = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    if (!notes) {
      return res.status(400).json({ message: "Notes are required" });
    }

    // Update customer notes
    const updatedCustomer = await Customer.findByIdAndUpdate(
      id,
      { notes },
      { new: true, runValidators: true }
    ).populate("assignedTo", "firstName lastName email hubspotId");

    if (!updatedCustomer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    res.json({
      message: "Customer notes updated",
      customer: updatedCustomer,
    });
  } catch (error) {
    console.error("Notes update error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};
