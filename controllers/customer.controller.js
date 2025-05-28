// controllers/customer.controller.js
const Customer = require("../models/Customer");
const User = require("../models/User");
const csv = require("csv-parser");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const CallData = require("../models/CallData");
const SalesOrder = require("../models/SalesOrder");
const Invoice = require("../models/Invoice");
const Quotation = require("../models/Quotation");
const Deal = require("../models/Deal");
const Cart = require("../models/Cart");

// Process customer data from text format
const processCustomerData = (text) => {
  const lines = text.split("\n");
  const customers = [];

  // Skip the header line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) {
      // Match pattern: index CardCode CardName Email
      const match = line.match(/^\d+\s+(C\d+)\s+(.*?)(?:\s+(\S+@\S+\.\S+))?$/);

      if (match) {
        const [, CardCode, CardName, Email] = match;

        customers.push({
          CardCode,
          CardName: CardName.trim(),
          Email: Email || "",
          status: "active",
        });
      }
    }
  }

  return customers;
};

// Process XLSX file
const processXLSXFile = (filePath) => {
  try {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);

    console.log("Excel data extracted:", data.length, "records");

    // Map the data to our customer format
    return data
      .map((row) => {
        return {
          CardCode: row["BP Code"] || row["CardCode"] || "",
          CardName: row["BP Name"] || row["CardName"] || "",
          Email: row["E-Mail"] || row["Email"] || "",
          status: "active",
        };
      })
      .filter((customer) => customer.CardCode && customer.CardName); // Filter out invalid entries
  } catch (error) {
    console.error("Error processing XLSX file:", error);
    throw new Error(`Failed to process XLSX file: ${error.message}`);
  }
};

// Controller function for checking and adding new customers
exports.checkAndAddNewCustomers = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a file",
      });
    }

    // Ensure uploads directory exists
    const uploadsDir = path.join(process.cwd(), "uploads");
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    console.log("File upload path:", req.file.path);
    console.log("File exists check:", fs.existsSync(req.file.path));

    // Process Excel file
    let customersData = [];
    try {
      const workbook = XLSX.readFile(req.file.path);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const data = XLSX.utils.sheet_to_json(worksheet);

      console.log(`Extracted ${data.length} rows from Excel file`);

      // Map data to our customer format
      customersData = data
        .map((row) => {
          return {
            CardCode: row["BP Code"] || "",
            CardName: row["BP Name"] || row["BP Code"],
            Email: row["E-Mail 1"] || "",
            phoneNumber: row["Telephone 1"] || "",
            outstandingBalance: parseFloat(row["Account Balance"] || 0),
            address: {
              street: row["Bill-to Street"] || "",
              zipCode: row["Bill-to Postcode"] || "",
              city: row["Bill-to City"] || "",
              country: "France",
            },
            status: "active",
          };
        })
        .filter((customer) => customer.CardCode); // Filter out entries without CardCode
    } catch (error) {
      console.error("Error processing Excel file:", error);
      throw new Error(`Failed to process Excel file: ${error.message}`);
    }

    // Get all existing CardCodes in one query for efficient comparison
    const existingCardCodes = await Customer.distinct("CardCode");
    const existingCardCodesSet = new Set(existingCardCodes);

    // Filter out only new customers
    const newCustomers = customersData.filter(
      (customer) => !existingCardCodesSet.has(customer.CardCode)
    );

    console.log(
      `Found ${newCustomers.length} new customers out of ${customersData.length} total`
    );

    // If no new customers, return early
    if (newCustomers.length === 0) {
      // Clean up the uploaded file
      try {
        if (fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
      } catch (unlinkError) {
        console.error("Error deleting file after processing:", unlinkError);
      }

      return res.status(200).json({
        success: true,
        message: "No new customers found to add",
        totalProcessed: customersData.length,
        newCustomers: 0,
      });
    }

    // Insert all new customers in one operation
    const result = await Customer.insertMany(newCustomers);

    // Clean up the uploaded file
    try {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (unlinkError) {
      console.error("Error deleting file after processing:", unlinkError);
    }

    res.status(200).json({
      success: true,
      message: `Added ${newCustomers.length} new customers`,
      totalProcessed: customersData.length,
      newCustomers: newCustomers.length,
      newCustomerDetails: newCustomers.map((c) => ({
        CardCode: c.CardCode,
        CardName: c.CardName,
      })),
    });
  } catch (error) {
    console.error("Error in check and add new customers:", error);

    // Clean up file if it exists
    try {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (unlinkError) {
      console.error("Error cleaning up file:", unlinkError);
    }

    res.status(500).json({
      success: false,
      message: "Error processing customers",
      error: error.message,
    });
  }
};

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

    // // Filter by assigned agent
    // if (assignedTo) {
    //   query.assignedTo = assignedTo;
    // }

    // // Role-based queries
    // if (req.user && req.user.role === "sales_agent") {
    //   // Sales agents can only see customers assigned to them
    //   query.assignedTo = req.user._id;
    // }
    // // Admins can see all customers

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

// Get all customers
exports.getSAPCustomers = async (req, res) => {
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

    // // Filter by assigned agent
    // if (assignedTo) {
    //   query.assignedTo = assignedTo;
    // }

    // // Role-based queries
    // if (req.user && req.user.role === "sales_agent") {
    //   // Sales agents can only see customers assigned to them
    //   query.assignedTo = req.user._id;
    // }
    // // Admins can see all customers

    const customers = await Customer.find({
      ...query,
      status: "active",
    }).populate("assignedTo", "firstName lastName email hubspotId");

    //only get the customers with CardCode starting with C
    const sapCustomers = customers.filter((customer) =>
      customer.CardCode.startsWith("C")
    );
    res.json(sapCustomers);
  } catch (error) {
    console.error("Customer fetch error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Function to unassign a sales agent from a customer
exports.unassignCustomer = async (req, res) => {
  try {
    const { id } = req.params;

    // Check if customer exists
    const customer = await Customer.findById(id);
    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    // Verify user has permission (admins and sales managers)
    if (
      req.user &&
      req.user.role !== "admin" &&
      req.user.role !== "sales_manager"
    ) {
      return res.status(403).json({
        message:
          "Unauthorized: Only admins and sales managers can unassign customers",
      });
    }

    // Remove assignedTo field
    customer.assignedTo = undefined;
    await customer.save();

    const updatedCustomer = await Customer.findById(id).populate(
      "assignedTo",
      "firstName lastName email hubspotId"
    );

    res.json({
      message: "Customer unassigned successfully",
      customer: updatedCustomer,
    });
  } catch (error) {
    console.error("Customer unassignment error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Function to bulk unassign customers
exports.bulkUnassignCustomers = async (req, res) => {
  try {
    const { customerIds } = req.body;

    // Validate input
    if (
      !customerIds ||
      !Array.isArray(customerIds) ||
      customerIds.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid array of customer IDs",
      });
    }

    // Verify user has permission (admins and sales managers)
    if (
      req.user &&
      req.user.role !== "admin" &&
      req.user.role !== "sales_manager"
    ) {
      return res.status(403).json({
        success: false,
        message:
          "Unauthorized: Only admins and sales managers can unassign customers",
      });
    }

    // Perform bulk update
    const result = await Customer.updateMany(
      { _id: { $in: customerIds } },
      { $unset: { assignedTo: "" } }
    );

    res.json({
      success: true,
      message: "Customers unassigned successfully",
      count: result.modifiedCount,
      totalRequested: customerIds.length,
    });
  } catch (error) {
    console.error("Bulk customer unassignment error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// Get customer by ID
exports.getCustomerById = async (req, res) => {
  try {
    const customerId = req.params.id;
    let customer;

    // Role-based permissions
    if (req.user && req.user.role === "admin") {
      // Admin can see any customer
      customer = await Customer.findById(customerId).populate(
        "assignedTo",
        "firstName lastName email hubspotId"
      );
    } else if (req.user && req.user.role === "sales_manager") {
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
      if (req.user && req.user.role === "sales_agent") {
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
      req.user &&
      req.user.role === "sales_agent" &&
      req.user._id.toString() !== agentId
    ) {
      return res
        .status(403)
        .json({ message: "You can only view your own customers" });
    }

    if (req.user && req.user.role === "sales_manager") {
      // Check if the agent belongs to this manager
      const agent = await User.findById(agentId);
      if (
        !agent ||
        agent.role !== "sales_agent" ||
        agent.manager.toString() !== req.user._id.toString()
      ) {
        return res.status(403).json({
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

// Upload customers from file (supports text and Excel)
exports.uploadCustomers = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a file",
      });
    }

    // Ensure uploads directory exists
    const uploadsDir = path.join(process.cwd(), "uploads");
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
      console.log("Created uploads directory at", uploadsDir);
    }

    console.log("File upload path:", req.file.path);
    console.log("File exists check:", fs.existsSync(req.file.path));

    let customers = [];
    const fileExt = path.extname(req.file.originalname).toLowerCase();

    // Process file based on extension
    if (fileExt === ".xlsx" || fileExt === ".xls") {
      // Process Excel file
      customers = processXLSXFile(req.file.path);
      console.log(`Processed ${customers.length} customers from Excel file`);
    } else {
      // Process text file
      try {
        const fileContent = fs.readFileSync(req.file.path, "utf8");
        customers = processCustomerData(fileContent);
        console.log(`Processed ${customers.length} customers from text file`);
      } catch (readError) {
        console.error("Error reading file:", readError);
        throw new Error(`Could not read file: ${readError.message}`);
      }
    }

    if (customers.length === 0) {
      // Clean up file
      try {
        if (fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
      } catch (unlinkError) {
        console.error("Error deleting file:", unlinkError);
      }

      return res.status(400).json({
        success: false,
        message: "No valid customer data found in the file",
      });
    }

    // Use bulk operation for efficiency
    const operations = customers.map((customer) => ({
      updateOne: {
        filter: { CardCode: customer.CardCode },
        update: { $set: customer },
        upsert: true,
      },
    }));

    const result = await Customer.bulkWrite(operations);

    // Clean up the uploaded file
    try {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (unlinkError) {
      console.error("Error deleting file after processing:", unlinkError);
    }

    res.status(200).json({
      success: true,
      message: `Processed ${customers.length} customers`,
      result: {
        matched: result.matchedCount,
        modified: result.modifiedCount,
        upserted: result.upsertedCount,
      },
    });
  } catch (error) {
    console.error("Upload error:", error);

    // Clean up file if it exists
    try {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (unlinkError) {
      console.error("Error cleaning up file:", unlinkError);
    }

    res.status(500).json({
      success: false,
      message: "Error uploading customers",
      error: error.message,
    });
  }
};

// Alternative CSV upload method
exports.uploadCustomersCSV = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a CSV file",
      });
    }

    // Ensure uploads directory exists
    const uploadsDir = path.join(process.cwd(), "uploads");
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const customers = [];

    fs.createReadStream(req.file.path)
      .pipe(csv())
      .on("data", (row) => {
        customers.push({
          CardCode: row.CardCode || row["BP Code"],
          CardName: row.CardName || row["BP Name"],
          Email: row.Email || row["E-Mail"] || "",
          status: "active",
        });
      })
      .on("end", async () => {
        // Process customers
        const operations = customers.map((customer) => ({
          updateOne: {
            filter: { CardCode: customer.CardCode },
            update: { $set: customer },
            upsert: true,
          },
        }));

        const result = await Customer.bulkWrite(operations);

        // Clean up the uploaded file
        try {
          if (fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
          }
        } catch (unlinkError) {
          console.error("Error cleaning up CSV file:", unlinkError);
        }

        res.status(200).json({
          success: true,
          message: `Processed ${customers.length} customers from CSV`,
          result: {
            matched: result.matchedCount,
            modified: result.modifiedCount,
            upserted: result.upsertedCount,
          },
        });
      })
      .on("error", (error) => {
        throw error;
      });
  } catch (error) {
    console.error("CSV upload error:", error);

    // Clean up file if it exists
    try {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (unlinkError) {
      console.error("Error cleaning up CSV file:", unlinkError);
    }

    res.status(500).json({
      success: false,
      message: "Error uploading customers from CSV",
      error: error.message,
    });
  }
};

exports.getCustomersPaginated = async (req, res) => {
  try {
    // Extract pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    //check user role
    if (req.user && req.user.role === "sales_agent") {
      // Sales agents can only see customers assigned to them
      req.query.assignedTo = req.user._id;
    }

    // Extract filtering parameters
    const { status, search, assignedTo, type, sortBy, sortOrder } = req.query;
    const query = {};

    // Apply filters if provided
    if (status) query.status = status;

    if (assignedTo === "unassigned") {
      query.assignedTo = { $exists: false }; // This properly targets documents where assignedTo field doesn't exist
    } else if (assignedTo !== "all" && assignedTo) {
      query.assignedTo = assignedTo; // Keep the existing filter for specific agents
    }

    // Search by name, code or email
    if (search) {
      query.$or = [
        { CardName: { $regex: search, $options: "i" } },
        { CardCode: { $regex: search, $options: "i" } },
        { Email: { $regex: search, $options: "i" } },
      ];
    }

    // Get all matching customers without pagination for sorting by metrics
    let customers = await Customer.find({ ...query })
      .select(
        "CardCode CardName Email phoneNumber status assignedTo TotalSales LastPurchaseDate"
      )
      .populate("assignedTo", "firstName lastName email")
      .lean();

    // Extract customer codes and emails for efficient batch processing
    const customerCodes = customers.map((c) => c.CardCode);
    const customerEmails = customers.filter((c) => c.Email).map((c) => c.Email);

    // Batch query for all metrics in parallel for better performance
    const [
      invoiceCounts,
      orderCounts,
      abandonedCarts,
      totalTurnover,
      salesOrderTotal,
      latestInvoiceDates,
      quotationCounts,
    ] = await Promise.all([
      // Get invoice counts for all customers at once
      Invoice.aggregate([
        { $match: { CardCode: { $in: customerCodes } } },
        { $group: { _id: "$CardCode", count: { $sum: 1 } } },
      ]),

      // Get order counts for all customers at once
      SalesOrder.aggregate([
        { $match: { CardCode: { $in: customerCodes } } },
        { $group: { _id: "$CardCode", count: { $sum: 1 } } },
      ]),

      // Get abandoned cart counts for all customers at once
      // Get abandoned cart counts for all customers at once
      Cart.aggregate([
        {
          $match: {
            $or: [
              { customerEmail: { $in: customerEmails } },
              { "contactInfo.email": { $in: customerEmails } },
            ],
            status: "abandoned",
            isAbandoned: true,
          },
        },
        {
          $group: {
            _id: {
              $cond: [
                { $ifNull: ["$customerEmail", false] },
                "$customerEmail",
                "$contactInfo.email",
              ],
            },
            count: { $sum: 1 },
          },
        },
      ]),

      // Get total turnover (sum of invoice amounts) for all customers
      Invoice.aggregate([
        { $match: { CardCode: { $in: customerCodes } } },
        { $group: { _id: "$CardCode", totalAmount: { $sum: "$DocTotal" } } },
      ]),

      // Get total sales order amount for all customers
      SalesOrder.aggregate([
        { $match: { CardCode: { $in: customerCodes } } },
        { $group: { _id: "$CardCode", totalAmount: { $sum: "$DocTotal" } } },
      ]),

      // Get latest invoice date for each customer
      Invoice.aggregate([
        { $match: { CardCode: { $in: customerCodes } } },
        { $sort: { DocDate: -1 } },
        {
          $group: {
            _id: "$CardCode",
            latestInvoiceDate: { $first: "$DocDate" },
          },
        },
      ]),

      Quotation.aggregate([
        { $match: { CardCode: { $in: customerCodes } } },
        { $group: { _id: "$CardCode", count: { $sum: 1 } } },
      ]),
    ]);

    // Create lookup maps for O(1) access
    const invoiceMap = {};
    invoiceCounts.forEach((item) => {
      invoiceMap[item._id] = item.count;
    });

    const orderMap = {};
    orderCounts.forEach((item) => {
      orderMap[item._id] = item.count;
    });

    const cartMap = {};
    abandonedCarts.forEach((item) => {
      cartMap[item._id] = item.count;
    });

    // Create turnover map
    const turnoverMap = {};
    totalTurnover.forEach((item) => {
      turnoverMap[item._id] = item.totalAmount;
    });

    // Create sales order total map
    const salesOrderMap = {};
    salesOrderTotal.forEach((item) => {
      salesOrderMap[item._id] = item.totalAmount;
    });

    // Create latest invoice date map
    const latestInvoiceDateMap = {};
    latestInvoiceDates.forEach((item) => {
      latestInvoiceDateMap[item._id] = item.latestInvoiceDate;
    });

    const quotationMap = {};
    quotationCounts.forEach((item) => {
      quotationMap[item._id] = item.count;
    });

    // Enhance customers with metrics
    const enhancedCustomers = customers.map((customer) => {
      return {
        ...customer,
        metrics: {
          invoiceCount: invoiceMap[customer.CardCode] || 0,
          orderCount: orderMap[customer.CardCode] || 0,
          abandonedCartCount: customer.Email ? cartMap[customer.Email] || 0 : 0,
          sapTurnover: turnoverMap[customer.CardCode] || 0,
          salesOrderTotal: salesOrderMap[customer.CardCode] || 0,
          latestInvoiceDate: latestInvoiceDateMap[customer.CardCode] || null,
          quotationCount: quotationMap[customer.CardCode] || 0,
        },
      };
    });

    // Apply sorting based on metrics
    if (sortBy) {
      const sortDirection = sortOrder === "desc" ? -1 : 1;

      enhancedCustomers.sort((a, b) => {
        let aValue, bValue;

        switch (sortBy) {
          case "invoiceCount":
            aValue = a.metrics.invoiceCount;
            bValue = b.metrics.invoiceCount;
            break;
          case "orderCount":
            aValue = a.metrics.orderCount;
            bValue = b.metrics.orderCount;
            break;
          case "abandonedCartCount":
            aValue = a.metrics.abandonedCartCount;
            bValue = b.metrics.abandonedCartCount;
            break;
          case "sapTurnover":
            aValue = a.metrics.sapTurnover;
            bValue = b.metrics.sapTurnover;
            break;
          case "salesOrderTotal":
            aValue = a.metrics.salesOrderTotal;
            bValue = b.metrics.salesOrderTotal;
            break;

          case "latestInvoiceDate":
            aValue = a.metrics.latestInvoiceDate
              ? new Date(a.metrics.latestInvoiceDate).getTime()
              : 0;
            bValue = b.metrics.latestInvoiceDate
              ? new Date(b.metrics.latestInvoiceDate).getTime()
              : 0;
            break;
          case "quotationCount":
            aValue = a.metrics.quotationCount;
            bValue = b.metrics.quotationCount;
            break;
          case "CardName":
            return sortDirection * a.CardName.localeCompare(b.CardName);
          default:
            return 0;
        }

        return sortDirection * (aValue - bValue);
      });
    } else {
      // Default sorting by CardName
      enhancedCustomers.sort((a, b) => a.CardName.localeCompare(b.CardName));
    }

    // Get the total count AFTER all filters and sorting have been applied
    const totalCount = enhancedCustomers.length;

    // Apply pagination after sorting
    const paginatedCustomers = enhancedCustomers.slice(skip, skip + limit);

    return res.status(200).json({
      success: true,
      customers: paginatedCustomers,
      pagination: {
        total: totalCount,
        page,
        pages: Math.ceil(totalCount / limit),
        limit,
      },
    });
  } catch (error) {
    console.error("Customer fetch error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

exports.getCustomersPaginated2 = async (req, res) => {
  try {
    // Extract pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    // Extract filtering parameters
    const { status, search, assignedTo, type, sortBy, sortOrder } = req.query;
    const query = {};

    // Apply filters if provided
    if (status) query.status = status;

    if (assignedTo) query.assignedTo = assignedTo;

    // Search by name, code or email
    if (search) {
      query.$or = [
        { CardName: { $regex: search, $options: "i" } },
        { CardCode: { $regex: search, $options: "i" } },
        { Email: { $regex: search, $options: "i" } },
      ];
    }

    // Count total matching documents (for pagination)
    const totalCount = await Customer.countDocuments(query);

    // Get all matching customers without pagination for sorting by metrics
    let customers = await Customer.find({ ...query, status: "active" })
      .select(
        "CardCode CardName Email phoneNumber status assignedTo TotalSales LastPurchaseDate"
      )
      .populate("assignedTo", "firstName lastName email")
      .lean();

    // Extract customer codes and emails for efficient batch processing
    const customerCodes = customers.map((c) => c.CardCode);
    const customerEmails = customers.filter((c) => c.Email).map((c) => c.Email);

    // Batch query for all metrics in parallel for better performance
    const [invoiceCounts, orderCounts, abandonedCarts] = await Promise.all([
      // Get invoice counts for all customers at once
      Invoice.aggregate([
        { $match: { CardCode: { $in: customerCodes } } },
        { $group: { _id: "$CardCode", count: { $sum: 1 } } },
      ]),

      // Get order counts for all customers at once
      SalesOrder.aggregate([
        { $match: { CardCode: { $in: customerCodes } } },
        { $group: { _id: "$CardCode", count: { $sum: 1 } } },
      ]),

      // Get abandoned cart counts for all customers at once
      // Get abandoned cart counts for all customers at once
      Cart.aggregate([
        {
          $match: {
            $or: [
              { customerEmail: { $in: customerEmails } },
              { "contactInfo.email": { $in: customerEmails } },
            ],
            status: "abandoned",
            isAbandoned: true,
          },
        },
        {
          $group: {
            _id: {
              $cond: [
                { $ifNull: ["$customerEmail", false] },
                "$customerEmail",
                "$contactInfo.email",
              ],
            },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);

    // Create lookup maps for O(1) access
    const invoiceMap = {};
    invoiceCounts.forEach((item) => {
      invoiceMap[item._id] = item.count;
    });

    const orderMap = {};
    orderCounts.forEach((item) => {
      orderMap[item._id] = item.count;
    });

    const cartMap = {};
    abandonedCarts.forEach((item) => {
      cartMap[item._id] = item.count;
    });

    // Enhance customers with metrics
    const enhancedCustomers = customers.map((customer) => {
      return {
        ...customer,
        metrics: {
          invoiceCount: invoiceMap[customer.CardCode] || 0,
          orderCount: orderMap[customer.CardCode] || 0,
          abandonedCartCount: customer.Email ? cartMap[customer.Email] || 0 : 0,
        },
      };
    });

    // Apply sorting based on metrics
    if (sortBy) {
      const sortDirection = sortOrder === "desc" ? -1 : 1;

      enhancedCustomers.sort((a, b) => {
        let aValue, bValue;

        switch (sortBy) {
          case "invoiceCount":
            aValue = a.metrics.invoiceCount;
            bValue = b.metrics.invoiceCount;
            break;
          case "orderCount":
            aValue = a.metrics.orderCount;
            bValue = b.metrics.orderCount;
            break;
          case "abandonedCartCount":
            aValue = a.metrics.abandonedCartCount;
            bValue = b.metrics.abandonedCartCount;
            break;
          case "CardName":
            return sortDirection * a.CardName.localeCompare(b.CardName);
          default:
            return 0;
        }

        return sortDirection * (aValue - bValue);
      });
    } else {
      // Default sorting by CardName
      enhancedCustomers.sort((a, b) => a.CardName.localeCompare(b.CardName));
    }

    // Apply pagination after sorting
    const paginatedCustomers = enhancedCustomers.slice(skip, skip + limit);

    return res.status(200).json({
      success: true,
      customers: paginatedCustomers,
      pagination: {
        total: totalCount,
        page,
        pages: Math.ceil(totalCount / limit),
        limit,
      },
    });
  } catch (error) {
    console.error("Customer fetch error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// Process HubSpot export Excel file
const processHubspotExport = (filePath) => {
  try {
    const workbook = XLSX.readFile(filePath, {
      cellDates: true, // Handle dates properly
      dateNF: "yyyy/mm/dd", // Date format
    });

    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet, { raw: false });

    console.log("Excel data extracted:", data.length, "records");

    // Map the data to our customer format
    return data
      .map((row) => {
        // Parse the date field if it exists
        let createDate = null;
        if (row["Create Date"]) {
          // Handle different date formats
          try {
            createDate = new Date(row["Create Date"]);
            if (isNaN(createDate.getTime())) {
              // Try alternative date format (DD/MM/YYYY)
              const parts = row["Create Date"].split("/");
              if (parts.length === 3) {
                // Convert to MM/DD/YYYY format for JS Date
                createDate = new Date(`${parts[1]}/${parts[0]}/${parts[2]}`);
              }
            }
          } catch (error) {
            console.warn("Could not parse date:", row["Create Date"]);
          }
        }

        let lastActivityDate = null;
        if (row["Last Activity Date"]) {
          try {
            lastActivityDate = new Date(row["Last Activity Date"]);
          } catch (error) {
            console.warn(
              "Could not parse activity date:",
              row["Last Activity Date"]
            );
          }
        }

        // Handle additional emails if present
        const additionalEmails = row["Additional email addresses"]
          ? row["Additional email addresses"]
              .split(/[,;]/)
              .map((email) => email.trim())
              .filter(Boolean)
          : [];

        // Marketing status mapping
        let marketingStatus = "marketing-contact";
        if (row["Marketing contact status"]) {
          if (
            row["Marketing contact status"]
              .toLowerCase()
              .includes("non-marketing")
          ) {
            marketingStatus = "non-marketing-contact";
          } else if (
            row["Marketing contact status"]
              .toLowerCase()
              .includes("unsubscribe")
          ) {
            marketingStatus = "unsubscribed";
          }
        }

        // Generate a CardName from first/last or full row
        let firstName = row["First Name"] || "";
        let lastName = row["Last Name"] || "";

        let phoneNumber = row["Phone Number"]
          ? String(row["Phone Number"]).replace(/[^\d+]/g, "")
          : "";

        // Handle special cases with "New RingOver Contact" or phone numbers
        if (
          firstName.includes("New RingOver Contact") ||
          firstName.includes("Ringover contact") ||
          firstName.match(/^\+?\d+/) || // Starts with + or digits
          firstName.includes("+")
        ) {
          firstName = "";
        }

        if (
          lastName.includes("New RingOver Contact") ||
          lastName.includes("Ringover contact") ||
          lastName.match(/^\+?\d+/)
        ) {
          // Starts with + or digits
          lastName = "";
        }

        // For CardName, combine name fields or use phone if that's all we have
        let cardName = "";
        if (firstName || lastName) {
          cardName = `${firstName} ${lastName}`.trim();
        } else if (phoneNumber) {
          // Use phone number as a name if nothing else available
          cardName = `Contact ${phoneNumber}`;
        } else if (row["Email"]) {
          // Use email as a name if nothing else available
          cardName = row["Email"];
        } else {
          // Fallback
          cardName = "Unnamed Contact";
        }

        // Sanitize CardName - don't keep "New RingOver Contact" as a name
        if (
          cardName.includes("New RingOver Contact") ||
          cardName.includes("Ringover contact")
        ) {
          if (phoneNumber) {
            cardName = `Contact ${phoneNumber}`;
          } else if (row["Email"]) {
            cardName = row["Email"];
          } else {
            cardName = "Unnamed Contact";
          }
        }

        // Check if phone number is in firstName or lastName for Ringover contacts
        if (
          (!phoneNumber || phoneNumber === "") &&
          firstName.match(/\d{10,}/)
        ) {
          // Extract phone number from firstName
          const match = firstName.match(/(\+?\d{10,})/);
          if (match) {
            phoneNumber = match[1].replace(/[^\d+]/g, "");
            firstName = firstName.replace(match[1], "").trim();
          }
        }

        return {
          // Basic info - required fields
          CardName: cardName,
          firstName: firstName,
          lastName: lastName,
          Email: row["Email"] || "",
          phoneNumber: phoneNumber,

          // External IDs
          hubspotId: row["Record ID"] ? String(row["Record ID"]) : undefined,

          // Classification
          customerType: "non-sap",
          status: row["Lead Status"] ? "lead" : "prospect",
          marketingStatus: marketingStatus,

          // Associated company
          company: row["Associated Company"] || "",
          companyId: row["Primary Associated Company ID"] || "",

          // Contact ownership
          contactOwnerName: row["Contact owner"] || "",

          createdAt: createDate || new Date(),

          // Additional info
          additionalEmails: additionalEmails,
        };
      })
      .filter((customer) => {
        // Filter out records with no usable contact information
        return (
          customer.Email ||
          customer.phoneNumber ||
          (customer.firstName && customer.lastName)
        );
      });
  } catch (error) {
    console.error("Error processing Excel file:", error);
    throw new Error(`Failed to process Excel file: ${error.message}`);
  }
};
const generateUniqueCardCode = (contact, index, usedCodes) => {
  // Start with NC prefix (Non-SAP Customer)
  let baseCode = "NC-";

  // Create a code based on available identifiers
  if (contact.hubspotId) {
    // Convert scientific notation to regular string without decimals
    if (String(contact.hubspotId).includes("E+")) {
      const parts = String(contact.hubspotId).split("E+");
      const base = parseFloat(parts[0]);
      const exponent = parseInt(parts[1]);

      // Convert to full number string
      const fullNumber = Math.round(base * Math.pow(10, exponent)).toString();
      baseCode += "HS-" + fullNumber.substring(0, 8); // Use first 8 digits of HubSpot ID
    } else {
      // Use the first 8 chars of ID
      baseCode += "HS-" + String(contact.hubspotId).substring(0, 8);
    }
  } else if (contact.Email) {
    // Use email prefix
    const emailPrefix = contact.Email.split("@")[0];
    baseCode += "EM-" + emailPrefix.substring(0, 8);
  } else if (contact.phoneNumber) {
    // Use last 8 digits of phone
    baseCode +=
      "PH-" +
      contact.phoneNumber.substring(
        Math.max(0, contact.phoneNumber.length - 8)
      );
  } else {
    // Fallback to timestamp + index
    baseCode += "TMP-" + Date.now().toString().substring(8) + "-" + index;
  }

  // Ensure uniqueness by adding suffixes if needed
  let finalCode = baseCode;
  let counter = 1;

  while (usedCodes.has(finalCode)) {
    finalCode = `${baseCode}-${counter}`;
    counter++;
  }

  // Add to used codes set
  usedCodes.add(finalCode);

  return finalCode;
};
// Import contacts from HubSpot export
exports.importHubspotContacts = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a file",
      });
    }

    // Ensure uploads directory exists
    const uploadsDir = path.join(process.cwd(), "uploads");
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    console.log("File upload path:", req.file.path);

    // Process the Excel file
    const rawContacts = processHubspotExport(req.file.path);

    if (rawContacts.length === 0) {
      // Clean up file
      try {
        if (fs.existsSync(req.file.path)) {
          fs.unlinkSync(req.file.path);
        }
      } catch (unlinkError) {
        console.error("Error deleting file:", unlinkError);
      }

      return res.status(400).json({
        success: false,
        message: "No valid contact data found in the file",
      });
    }

    // Match contact owners to actual users in the system
    const agentMapping = {};

    // Get all sales agents
    const salesAgents = await User.find({ role: "sales_agent" });

    // Create agent name to ID mapping for faster lookups
    salesAgents.forEach((agent) => {
      const fullName = `${agent.firstName} ${agent.lastName}`.toLowerCase();
      agentMapping[fullName] = agent._id;
      agentMapping[agent.firstName.toLowerCase()] = agent._id;
      agentMapping[agent.lastName.toLowerCase()] = agent._id;
    });

    // Set to track used CardCodes to ensure uniqueness
    const usedCodes = new Set();

    // Check existing CardCodes in the database to avoid conflicts
    const existingCodes = await Customer.find({ CardCode: /^NC-/ }).select(
      "CardCode"
    );
    existingCodes.forEach((customer) => {
      usedCodes.add(customer.CardCode);
    });

    // Process all contacts and generate unique CardCodes
    const processedContacts = rawContacts.map((contact, index) => {
      // Generate unique CardCode
      const cardCode = generateUniqueCardCode(contact, index, usedCodes);

      // Assign the CardCode to the contact
      contact.CardCode = cardCode;

      // Assign agent if possible
      if (contact.contactOwnerName) {
        const ownerName = contact.contactOwnerName.toLowerCase();

        if (agentMapping[ownerName]) {
          contact.assignedTo = agentMapping[ownerName];
        }
      }

      return contact;
    });

    // Prepare operations for bulk import/update
    const operations = processedContacts.map((contact) => {
      // First try to find by HubSpot ID or email/phone
      let filter = {};

      if (contact.hubspotId) {
        filter.hubspotId = contact.hubspotId;
      } else if (contact.Email && contact.Email.length > 0) {
        filter.Email = contact.Email;
      } else if (contact.phoneNumber && contact.phoneNumber.length > 0) {
        filter.phoneNumber = contact.phoneNumber;
      } else {
        // No identifiable fields, create a new record
        return { insertOne: { document: contact } };
      }

      return {
        updateOne: {
          filter: filter,
          update: { $set: contact },
          upsert: true,
        },
      };
    });

    const result = await Customer.bulkWrite(operations);

    // Clean up the uploaded file
    try {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (unlinkError) {
      console.error("Error deleting file after processing:", unlinkError);
    }

    res.status(200).json({
      success: true,
      message: `Processed ${processedContacts.length} contacts`,
      result: {
        matched: result.matchedCount,
        inserted: result.insertedCount,
        modified: result.modifiedCount,
        upserted: result.upsertedCount,
      },
    });
  } catch (error) {
    console.error("Import error:", error);

    // Clean up file if it exists
    try {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (unlinkError) {
      console.error("Error cleaning up file:", unlinkError);
    }

    res.status(500).json({
      success: false,
      message: "Error importing contacts",
      error: error.message,
    });
  }
};

exports.updateCustomerPhones = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a file containing customer phone numbers",
      });
    }

    // Ensure uploads directory exists
    const uploadsDir = path.join(process.cwd(), "uploads");
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    console.log("File upload path:", req.file.path);
    console.log("File exists check:", fs.existsSync(req.file.path));

    let phoneData = [];
    const fileExt = path.extname(req.file.originalname).toLowerCase();

    // Process file based on extension
    if (fileExt === ".xlsx" || fileExt === ".xls") {
      // Process Excel file
      try {
        const workbook = XLSX.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(worksheet);

        console.log(`Extracted ${data.length} rows from Excel file`);

        // Map data to our phone format
        phoneData = data.map((row) => {
          // Extract phone numbers from different possible column names
          let phone1 = row["Telephone 1"] || row["Phone"] || "";
          let phone2 = row["Telephone 2"] || "";

          // Convert to string if they're numbers
          phone1 = phone1 !== undefined ? phone1.toString() : "";
          phone2 = phone2 !== undefined ? phone2.toString() : "";

          return {
            CardCode: row["BP Code"] || row["CardCode"] || "",
            phoneNumber: phone1.trim(),
            alternativePhone: phone2.trim(),
          };
        });
      } catch (error) {
        console.error("Error processing Excel file:", error);
        throw new Error(`Failed to process Excel file: ${error.message}`);
      }
    } else if (fileExt === ".csv") {
      // Process CSV file
      try {
        phoneData = await new Promise((resolve, reject) => {
          const results = [];
          fs.createReadStream(req.file.path)
            .pipe(csv())
            .on("data", (row) => {
              // Extract phone numbers from different possible column names
              let phone1 = row["Telephone 1"] || row["Phone"] || "";
              let phone2 = row["Telephone 2"] || "";

              // Convert to string
              phone1 = phone1 !== undefined ? phone1.toString() : "";
              phone2 = phone2 !== undefined ? phone2.toString() : "";

              results.push({
                CardCode: row["BP Code"] || row["CardCode"] || "",
                phoneNumber: phone1.trim(),
                alternativePhone: phone2.trim(),
              });
            })
            .on("end", () => {
              console.log(`Processed ${results.length} rows from CSV`);
              resolve(results);
            })
            .on("error", (error) => {
              reject(error);
            });
        });
      } catch (error) {
        console.error("Error processing CSV file:", error);
        throw new Error(`Failed to process CSV file: ${error.message}`);
      }
    } else {
      // Process text file with specific format
      try {
        const fileContent = fs.readFileSync(req.file.path, "utf8");
        const lines = fileContent.split("\n");

        console.log(`Processing ${lines.length} lines from text file`);

        // Process each line (skip header)
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;

          // Extract line index, CardCode, and CardName first
          // The pattern looks for: number C#### NAME/TEXT followed by possible phone numbers
          const basicMatch = line.match(/^\s*(\d+)\s+(C\d+)\s+(.*)/);

          if (basicMatch) {
            const [fullMatch, lineIndex, cardCode, remaining] = basicMatch;

            // Get all content after the CardCode
            const afterCardCode = line.substring(
              line.indexOf(cardCode) + cardCode.length
            );

            // Define various phone patterns with better pattern recognition
            // We'll use capturing groups to preserve the formatting
            const phonePattern =
              /(\d{2}[\s\.]{1}\d{2}[\s\.]{1}\d{2}[\s\.]{1}\d{2}[\s\.]{1}\d{2}|\d{2}[\s\.]{1}\d{2}[\s\.]{1}\d{2}[\s\.]{1}\d{2}|\d{10}|\d{9}|\d{8})/g;

            // Find all phone-like patterns in the text
            const phoneMatches = [...afterCardCode.matchAll(phonePattern)];
            const phones = phoneMatches.map((match) => match[0]);

            // Add to results if phone numbers found
            if (phones.length > 0) {
              phoneData.push({
                CardCode: cardCode.trim(),
                phoneNumber: phones[0] || "",
                alternativePhone: phones[1] || "",
              });
            }
          }
        }

        console.log(
          `Extracted ${phoneData.length} customer records with phones`
        );
      } catch (error) {
        console.error("Error processing text file:", error);
        throw new Error(`Failed to process text file: ${error.message}`);
      }
    }

    // Filter out entries without CardCode or phone numbers
    phoneData = phoneData.filter(
      (item) => item.CardCode && (item.phoneNumber || item.alternativePhone)
    );

    // Clean and format phone numbers properly, preserving spaces and formatting
    const cleanedPhoneData = phoneData.map((item) => {
      let phoneNum = item.phoneNumber;
      let altPhone = item.alternativePhone;

      // Function to clean and format phone numbers
      const formatPhoneNumber = (phone) => {
        if (!phone) return "";

        // Remove any non-phone content after the number (like "MILOUD" or "ancien")
        // This regex captures the phone part and ignores trailing text
        const phoneMatch = phone.match(
          /^((?:\+?\d+[\s\.\-]?)+)(?:\s+[a-zA-Z].*)?$/
        );
        let formattedPhone = phoneMatch ? phoneMatch[1].trim() : phone.trim();

        // If it's a plain 10-digit number, format it as XX XX XX XX XX
        if (/^\d{10}$/.test(formattedPhone)) {
          formattedPhone = formattedPhone.replace(
            /(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/,
            "$1 $2 $3 $4 $5"
          );
        }

        return formattedPhone;
      };

      return {
        CardCode: item.CardCode,
        phoneNumber: formatPhoneNumber(phoneNum),
        alternativePhone: formatPhoneNumber(altPhone),
      };
    });

    console.log(`Prepared ${cleanedPhoneData.length} phone records for update`);

    // Update database
    const updateResults = {
      total: cleanedPhoneData.length,
      updated: 0,
      notFound: 0,
      errors: [],
    };

    for (const item of cleanedPhoneData) {
      try {
        // Find customer by CardCode
        const customer = await Customer.findOne({ CardCode: item.CardCode });

        if (customer) {
          // Update primary phone number
          if (item.phoneNumber) {
            customer.phoneNumber = item.phoneNumber;
          }

          // Store alternative phone in additionalPhones array if it exists
          if (item.alternativePhone) {
            // Initialize additionalPhones if it doesn't exist
            if (!customer.additionalPhones) {
              customer.additionalPhones = [];
            }

            // Only add if not already present
            if (!customer.additionalPhones.includes(item.alternativePhone)) {
              customer.additionalPhones.push(item.alternativePhone);
            }
          }

          await customer.save();
          updateResults.updated++;
        } else {
          updateResults.notFound++;
        }
      } catch (error) {
        console.error(`Error updating customer ${item.CardCode}:`, error);
        updateResults.errors.push({
          CardCode: item.CardCode,
          error: error.message,
        });
      }
    }

    // Clean up the uploaded file
    try {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (unlinkError) {
      console.error("Error deleting file after processing:", unlinkError);
    }

    res.status(200).json({
      success: true,
      message: `Phone number update complete`,
      results: updateResults,
    });
  } catch (error) {
    console.error("Phone update error:", error);

    // Clean up file if it exists
    try {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (unlinkError) {
      console.error("Error cleaning up file:", unlinkError);
    }

    res.status(500).json({
      success: false,
      message: "Error updating customer phone numbers",
      error: error.message,
    });
  }
};

exports.updateCustomerAddresses = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a file containing customer addresses",
      });
    }

    // Ensure uploads directory exists
    const uploadsDir = path.join(process.cwd(), "uploads");
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    console.log("File upload path:", req.file.path);
    console.log("File exists check:", fs.existsSync(req.file.path));

    let addressData = [];
    const fileExt = path.extname(req.file.originalname).toLowerCase();

    // Process file based on extension
    if (fileExt === ".xlsx" || fileExt === ".xls") {
      // Process Excel file
      try {
        const workbook = XLSX.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(worksheet);

        console.log(`Extracted ${data.length} rows from Excel file`);

        // Map data to our address format
        addressData = data.map((row) => {
          return {
            CardCode: row["BP Code"] || row["CardCode"] || "",
            street: row["Bill-to Street"] || row["Street"] || "",
            zipCode:
              row["Bill-to Zip Code"] || row["Zip Code"] || row["ZIP"] || "",
            city: row["Bill-to City"] || "",
            BP_Name: row["BP Name"] || row["CardName"] || "",
          };
        });
      } catch (error) {
        console.error("Error processing Excel file:", error);
        throw new Error(`Failed to process Excel file: ${error.message}`);
      }
    } else if (fileExt === ".csv") {
      // Process CSV file
      try {
        addressData = await new Promise((resolve, reject) => {
          const results = [];
          fs.createReadStream(req.file.path)
            .pipe(csv())
            .on("data", (row) => {
              results.push({
                CardCode: row["BP Code"] || row["CardCode"] || "",
                street: row["Bill-to Street"] || row["Street"] || "",
                zipCode:
                  row["Bill-to Zip Code"] ||
                  row["Zip Code"] ||
                  row["ZIP"] ||
                  "",
                city: row["Bill-to City"] || "",
                BP_Name: row["BP Name"] || row["CardName"] || "",
              });
            })
            .on("end", () => {
              console.log(`Processed ${results.length} rows from CSV`);
              resolve(results);
            })
            .on("error", (error) => {
              reject(error);
            });
        });
      } catch (error) {
        console.error("Error processing CSV file:", error);
        throw new Error(`Failed to process CSV file: ${error.message}`);
      }
    } else {
      // Process text file with specific format (like your example)
      try {
        const fileContent = fs.readFileSync(req.file.path, "utf8");
        const lines = fileContent.split("\n");

        console.log(`Processing ${lines.length} lines from text file`);

        // Process each line (skip header if present)
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;

          // Match text format: index BP_Code BP_Name Street ZipCode
          // This regex captures the line structure with flexible spacing
          const match = line.match(
            /^\s*(\d+)\s+(C\d+)\s+(.+?)\s+(\d+.*?)(?:\s+(\d{5}))?\s*$/
          );

          if (match) {
            // If there are 5 matches, then we have index, BP_Code, BP_Name, Street, ZipCode
            const [, index, cardCode, name, street, zipCode] = match;

            // Extract city from the address if available
            const streetParts = street.split(",");
            let addressStreet = street;
            let city = "";

            // If there's a comma, assume the part after the comma is the city
            if (streetParts.length > 1) {
              addressStreet = streetParts[0].trim();
              city = streetParts[1].trim();
            }

            addressData.push({
              CardCode: cardCode.trim(),
              BP_Name: name.trim(),
              street: addressStreet,
              zipCode: zipCode || "",
              city: city,
            });
          } else {
            // Try alternative format without index at the beginning
            const altMatch = line.match(
              /^(C\d+)\s+(.+?)\s+(\d+.*?)(?:\s+(\d{5}))?\s*$/
            );

            if (altMatch) {
              const [, cardCode, name, street, zipCode] = altMatch;

              // Process same as above
              const streetParts = street.split(",");
              let addressStreet = street;
              let city = "";

              if (streetParts.length > 1) {
                addressStreet = streetParts[0].trim();
                city = streetParts[1].trim();
              }

              addressData.push({
                CardCode: cardCode.trim(),
                BP_Name: name.trim(),
                street: addressStreet,
                zipCode: zipCode || "",
                city: city,
              });
            }
          }
        }

        console.log(
          `Extracted ${addressData.length} customer records with addresses`
        );
      } catch (error) {
        console.error("Error processing text file:", error);
        throw new Error(`Failed to process text file: ${error.message}`);
      }
    }

    // Filter out entries without CardCode or address
    addressData = addressData.filter((item) => item.CardCode && item.street);

    // Clean and process address data
    const cleanedAddressData = addressData.map((item) => {
      // Extract city from zipCode if not already set
      let city = item.city || "";
      let zipCode = item.zipCode || "";

      // French postal codes are typically 5 digits
      if (!city && zipCode.length === 5) {
        // You could add a lookup table here for French postal codes to cities
        // For now, we'll just use the data as is
      }

      // Clean street address - remove any excess whitespace
      let street = item.street ? item.street.trim() : "";

      return {
        CardCode: item.CardCode,
        address: {
          street: street,
          zipCode: zipCode,
          city: city,
          country: "France", // Default for your dataset
        },
      };
    });

    console.log(
      `Prepared ${cleanedAddressData.length} address records for update`
    );

    // Update database
    const updateResults = {
      total: cleanedAddressData.length,
      updated: 0,
      notFound: 0,
      errors: [],
    };

    for (const item of cleanedAddressData) {
      try {
        // Find customer by CardCode
        const customer = await Customer.findOne({ CardCode: item.CardCode });

        if (customer) {
          // Update address fields
          customer.address = item.address;

          await customer.save();
          updateResults.updated++;
        } else {
          updateResults.notFound++;
        }
      } catch (error) {
        console.error(`Error updating customer ${item.CardCode}:`, error);
        updateResults.errors.push({
          CardCode: item.CardCode,
          error: error.message,
        });
      }
    }

    // Clean up the uploaded file
    try {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (unlinkError) {
      console.error("Error deleting file after processing:", unlinkError);
    }

    res.status(200).json({
      success: true,
      message: `Address update complete`,
      results: updateResults,
    });
  } catch (error) {
    console.error("Address update error:", error);

    // Clean up file if it exists
    try {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (unlinkError) {
      console.error("Error cleaning up file:", unlinkError);
    }

    res.status(500).json({
      success: false,
      message: "Error updating customer addresses",
      error: error.message,
    });
  }
};

exports.updateCustomerOutstandingBalance = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message:
          "Please upload a file containing customer outstanding balances",
      });
    }

    // Ensure uploads directory exists
    const uploadsDir = path.join(process.cwd(), "uploads");
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    console.log("File upload path:", req.file.path);
    console.log("File exists check:", fs.existsSync(req.file.path));

    let balanceData = [];
    const fileExt = path.extname(req.file.originalname).toLowerCase();

    // Process file based on extension (same as before)
    if (fileExt === ".xlsx" || fileExt === ".xls") {
      // Process Excel file
      try {
        const workbook = XLSX.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(worksheet);

        console.log(`Extracted ${data.length} rows from Excel file`);

        balanceData = data.map((row) => {
          return {
            CardCode: row["BP Code"] || row["CardCode"] || "",
            outstandingBalance: parseFloat(
              row["Account Balance"] || row["Balance"] || 0
            ),
            BP_Name: row["BP Name"] || row["CardName"] || "",
          };
        });
      } catch (error) {
        console.error("Error processing Excel file:", error);
        throw new Error(`Failed to process Excel file: ${error.message}`);
      }
    } else if (fileExt === ".csv") {
      // Process CSV file
      try {
        balanceData = await new Promise((resolve, reject) => {
          const results = [];
          fs.createReadStream(req.file.path)
            .pipe(csv())
            .on("data", (row) => {
              results.push({
                CardCode: row["BP Code"] || row["CardCode"] || "",
                outstandingBalance: parseFloat(
                  row["Account Balance"] || row["Balance"] || 0
                ),
                BP_Name: row["BP Name"] || row["CardName"] || "",
              });
            })
            .on("end", () => {
              console.log(`Processed ${results.length} rows from CSV`);
              resolve(results);
            })
            .on("error", (error) => {
              reject(error);
            });
        });
      } catch (error) {
        console.error("Error processing CSV file:", error);
        throw new Error(`Failed to process CSV file: ${error.message}`);
      }
    } else {
      // Process text file with specific format
      try {
        const fileContent = fs.readFileSync(req.file.path, "utf8");
        const lines = fileContent.split("\n");

        console.log(`Processing ${lines.length} lines from text file`);

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;

          if (
            line.includes("BP Code") &&
            line.includes("BP Name") &&
            line.includes("Account Balance")
          ) {
            continue;
          }

          const match = line.match(
            /^\s*(\d+)\s+(C\d+)\s+(.+?)\s+(-?\d+(\.\d+)?)\s*$/
          );

          if (match) {
            const [, index, cardCode, name, balance] = match;
            balanceData.push({
              CardCode: cardCode.trim(),
              BP_Name: name.trim(),
              outstandingBalance: parseFloat(balance),
            });
          } else {
            const altMatch = line.match(
              /^(C\d+)\s+(.+?)\s+(-?\d+(\.\d+)?)\s*$/
            );

            if (altMatch) {
              const [, cardCode, name, balance] = altMatch;
              balanceData.push({
                CardCode: cardCode.trim(),
                BP_Name: name.trim(),
                outstandingBalance: parseFloat(balance),
              });
            }
          }
        }

        console.log(
          `Extracted ${balanceData.length} customer records with balances`
        );
      } catch (error) {
        console.error("Error processing text file:", error);
        throw new Error(`Failed to process text file: ${error.message}`);
      }
    }

    // Filter out entries without CardCode
    balanceData = balanceData.filter((item) => item.CardCode);

    // Ensure balance values are numbers and not NaN
    const cleanedBalanceData = balanceData.map((item) => {
      return {
        CardCode: item.CardCode,
        outstandingBalance: isNaN(item.outstandingBalance)
          ? 0
          : item.outstandingBalance,
      };
    });

    console.log(
      `Prepared ${cleanedBalanceData.length} balance records for update`
    );

    // OPTIMIZED BATCH UPDATE SECTION
    const updateResults = {
      total: cleanedBalanceData.length,
      updated: 0,
      notFound: 0,
      errors: [],
    };

    if (cleanedBalanceData.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid balance data found in the uploaded file",
      });
    }

    try {
      // Extract all CardCodes for bulk query
      const cardCodes = cleanedBalanceData.map((item) => item.CardCode);

      // Find all existing customers in one query
      const existingCustomers = await Customer.find({
        CardCode: { $in: cardCodes },
      }).select("CardCode");

      const existingCardCodes = new Set(
        existingCustomers.map((c) => c.CardCode)
      );

      // Prepare bulk operations
      const bulkOperations = [];

      for (const item of cleanedBalanceData) {
        if (existingCardCodes.has(item.CardCode)) {
          bulkOperations.push({
            updateOne: {
              filter: { CardCode: item.CardCode },
              update: { $set: { outstandingBalance: item.outstandingBalance } },
            },
          });
          updateResults.updated++;
        } else {
          updateResults.notFound++;
        }
      }

      // Execute bulk update if we have operations
      if (bulkOperations.length > 0) {
        console.log(
          `Executing bulk update for ${bulkOperations.length} customers`
        );

        const bulkResult = await Customer.bulkWrite(bulkOperations, {
          ordered: false, // Continue even if some operations fail
        });

        console.log("Bulk update result:", {
          matchedCount: bulkResult.matchedCount,
          modifiedCount: bulkResult.modifiedCount,
          upsertedCount: bulkResult.upsertedCount,
        });

        // Update our results based on actual bulk operation results
        updateResults.updated = bulkResult.modifiedCount;

        // Handle any bulk write errors
        if (bulkResult.writeErrors && bulkResult.writeErrors.length > 0) {
          updateResults.errors = bulkResult.writeErrors.map((err) => ({
            CardCode: err.op?.filter?.CardCode || "Unknown",
            error: err.errmsg,
          }));
        }
      }

      console.log("Update completed:", updateResults);
    } catch (error) {
      console.error("Bulk update error:", error);
      updateResults.errors.push({
        CardCode: "Bulk Operation",
        error: error.message,
      });
    }

    // Clean up the uploaded file
    try {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (unlinkError) {
      console.error("Error deleting file after processing:", unlinkError);
    }

    res.status(200).json({
      success: true,
      message: `Outstanding balance update complete`,
      results: updateResults,
    });
  } catch (error) {
    console.error("Balance update error:", error);

    // Clean up file if it exists
    try {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (unlinkError) {
      console.error("Error cleaning up file:", unlinkError);
    }

    res.status(500).json({
      success: false,
      message: "Error updating customer outstanding balances",
      error: error.message,
    });
  }
};
exports.getCustomerCallData = async (req, res) => {
  try {
    const customerId = req.params.id;

    // First, find the customer to get their phone numbers
    const customer = await Customer.findOne({ CardCode: customerId });

    if (!customer) {
      return res.status(404).json({ message: "Customer not found" });
    }

    // Collect and clean all phone numbers
    let phoneNumbers = [
      customer.phoneNumber,
      ...(customer.additionalPhoneNumbers || []),
    ]
      .filter((p) => p && typeof p === "string" && p.length >= 6) // Filter out invalid entries
      .map((p) => p.replace(/[\s+.-]/g, "")); // Clean format

    // If no valid numbers, return empty response
    if (phoneNumbers.length === 0) {
      return res.status(200).json({
        success: true,
        data: [],
        statistics: {
          totalCalls: 0,
          inboundCalls: 0,
          outboundCalls: 0,
          missedCalls: 0,
          answerRate: 0,
          avgDuration: 0,
        },
        pagination: {
          total: 0,
          page: 1,
          limit: 10,
          pages: 0,
        },
      });
    }

    // Get pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    // Create exact match filter for any of the phone numbers
    const filter = {
      $and: [
        { fromNumber: { $nin: [null, "", ".", "N/A", "Unknown"] } },
        { toNumber: { $nin: [null, "", ".", "N/A", "Unknown"] } },
        {
          $or: phoneNumbers.flatMap((number) => [
            { fromNumber: number },
            { toNumber: number },
          ]),
        },
      ],
    };

    // Date range filter
    if (req.query.startDate && req.query.endDate) {
      filter.$and.push({
        startTime: {
          $gte: new Date(req.query.startDate),
          $lte: new Date(req.query.endDate),
        },
      });
    }

    // Direction filter
    if (req.query.direction && req.query.direction !== "all") {
      filter.$and.push({ direction: req.query.direction });
    }

    // Call status filter
    if (req.query.status === "missed") {
      filter.$and.push({ missed: { $ne: "" } });
    } else if (req.query.status === "answered") {
      filter.$and.push({ missed: "" });
    }

    // Get paginated call data
    const callData = await CallData.find(filter)
      .select(
        "id callID direction fromNumber toNumber startTime inCallDuration totalDuration lastState missed userName transcript analysis qualityScore structuredAnalysis analysisTimestamp file"
      )
      .sort({ startTime: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // Count total documents
    const total = await CallData.countDocuments(filter);

    // Aggregate call statistics
    const statistics = await CallData.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalCalls: { $sum: 1 },
          inboundCalls: {
            $sum: { $cond: [{ $eq: ["$direction", "in"] }, 1, 0] },
          },
          outboundCalls: {
            $sum: { $cond: [{ $eq: ["$direction", "out"] }, 1, 0] },
          },
          missedCalls: { $sum: { $cond: [{ $ne: ["$missed", ""] }, 1, 0] } },
          totalDuration: { $sum: "$totalDuration" },
          avgDuration: { $avg: "$inCallDuration" },
          totalInCallDuration: { $sum: "$inCallDuration" },
        },
      },
    ]);

    const stats = statistics[0] || {
      totalCalls: 0,
      inboundCalls: 0,
      outboundCalls: 0,
      missedCalls: 0,
      totalDuration: 0,
      avgDuration: 0,
      totalInCallDuration: 0,
    };

    stats.answerRate =
      stats.totalCalls > 0
        ? (
            ((stats.totalCalls - stats.missedCalls) / stats.totalCalls) *
            100
          ).toFixed(1)
        : 0;

    return res.status(200).json({
      success: true,
      data: callData,
      statistics: stats,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Error fetching customer call data:", error);
    return res.status(500).json({
      error: "Error fetching customer call data",
      details: error.message,
    });
  }
};

// Merge customers with the same email address
exports.mergeCustomersWithSameEmail = async (req, res) => {
  try {
    // Get all customers with non-empty emails
    const customersWithEmail = await Customer.find({
      Email: { $ne: null, $ne: "" },
    }).sort({ createdAt: 1 });

    // Group customers by email address
    const emailGroups = {};
    customersWithEmail.forEach((customer) => {
      const email = customer.Email.toLowerCase().trim();
      if (!emailGroups[email]) {
        emailGroups[email] = [];
      }
      emailGroups[email].push(customer);
    });

    const mergeResults = {
      totalEmailGroups: 0,
      totalMerges: 0,
      skippedSingleCustomers: 0,
      skippedMoreThanTwoCustomers: 0,
      mergedPairs: [],
    };

    // Process each email group
    for (const [email, customers] of Object.entries(emailGroups)) {
      mergeResults.totalEmailGroups++;

      // Skip if only one customer with this email
      if (customers.length === 1) {
        mergeResults.skippedSingleCustomers++;
        continue;
      }

      // Find SAP and non-SAP customers
      const sapCustomers = customers.filter((c) => c.CardCode.startsWith("C"));
      const nonSapCustomers = customers.filter((c) =>
        c.CardCode.startsWith("NC")
      );

      // If we have both SAP and non-SAP customers, merge them
      if (sapCustomers.length > 0 && nonSapCustomers.length > 0) {
        // Take the first customer from each group for merging
        const sapCustomer = sapCustomers[0];
        const nonSapCustomer = nonSapCustomers[0];

        // Merge the customers
        const primaryCustomer = sapCustomer; // SAP customer is the primary
        const secondaryCustomer = nonSapCustomer;

        // Create a merged customer object
        const mergedData = {
          // Keep SAP data from the primary customer
          CardName: primaryCustomer.CardName,
          CardCode: primaryCustomer.CardCode,
          Email: primaryCustomer.Email,

          // Prefer data from the SAP customer but fall back to non-SAP data
          firstName: primaryCustomer.firstName || secondaryCustomer.firstName,
          lastName: primaryCustomer.lastName || secondaryCustomer.lastName,
          phoneNumber:
            primaryCustomer.phoneNumber || secondaryCustomer.phoneNumber,

          // Keep external IDs
          hubspotId: secondaryCustomer.hubspotId || primaryCustomer.hubspotId,

          // Keep assignedTo from either customer
          assignedTo:
            primaryCustomer.assignedTo || secondaryCustomer.assignedTo,

          // Keep additional data
          notes: primaryCustomer.notes || secondaryCustomer.notes,

          // Combine additional emails
          additionalEmails: [
            ...(primaryCustomer.additionalEmails || []),
            ...(secondaryCustomer.additionalEmails || []),
            // Add the secondary customer's email if different from primary
            ...(primaryCustomer.Email !== secondaryCustomer.Email
              ? [secondaryCustomer.Email]
              : []),
          ].filter((email, index, self) => self.indexOf(email) === index), // Remove duplicates

          // Prefer SAP customer's address
          address: primaryCustomer.address || secondaryCustomer.address,

          // Use SAP customer's balance
          outstandingBalance: primaryCustomer.outstandingBalance,

          // Set the customer type to SAP
          customerType: "sap",

          // Keep the active status if either customer is active
          status:
            primaryCustomer.status === "active" ||
            secondaryCustomer.status === "active"
              ? "active"
              : primaryCustomer.status,

          // Update timestamp
          updatedAt: new Date(),
        };

        // Update the primary customer with the merged data
        await Customer.findByIdAndUpdate(primaryCustomer._id, mergedData);

        // Optionally: Mark the secondary customer as merged or delete it
        // Here we'll keep it but mark it as inactive and add a note
        await Customer.findByIdAndUpdate(secondaryCustomer._id, {
          status: "inactive",
          notes: `Merged with ${primaryCustomer.CardCode} (${
            primaryCustomer.CardName
          }) on ${new Date().toISOString()}. ${secondaryCustomer.notes || ""}`,
          mergedInto: primaryCustomer._id,
        });

        mergeResults.totalMerges++;
        mergeResults.mergedPairs.push({
          primaryCustomer: {
            _id: primaryCustomer._id,
            CardCode: primaryCustomer.CardCode,
            CardName: primaryCustomer.CardName,
            Email: primaryCustomer.Email,
          },
          secondaryCustomer: {
            _id: secondaryCustomer._id,
            CardCode: secondaryCustomer.CardCode,
            CardName: secondaryCustomer.CardName,
            Email: secondaryCustomer.Email,
          },
        });
      } else if (customers.length > 2) {
        // If we have more than 2 customers but not a SAP + non-SAP pair
        mergeResults.skippedMoreThanTwoCustomers++;
      }
    }

    return res.status(200).json({
      success: true,
      message: "Customer merge operation completed",
      results: mergeResults,
    });
  } catch (error) {
    console.error("Error merging customers:", error);
    return res.status(500).json({
      success: false,
      message: "Error merging customers",
      error: error.message,
    });
  }
};

// Delete non-SAP customers that have been previously merged
exports.deleteMergedNonSapCustomers = async (req, res) => {
  try {
    // Find all non-SAP customers (NC prefix) that have been marked as inactive due to merging
    const mergedCustomers = await Customer.find({
      CardCode: { $regex: "^NC" },
      status: "inactive",
      notes: { $regex: "Merged with C" }, // Look for the merge note pattern
    });

    if (mergedCustomers.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No merged non-SAP customers found to delete",
        count: 0,
      });
    }

    // Get the IDs of customers to delete
    const customerIdsToDelete = mergedCustomers.map((customer) => customer._id);

    // Optional: Log which customers will be deleted
    console.log(
      `Deleting ${customerIdsToDelete.length} merged non-SAP customers`
    );

    // Delete all these customers in one operation
    const deleteResult = await Customer.deleteMany({
      _id: { $in: customerIdsToDelete },
    });

    return res.status(200).json({
      success: true,
      message: "Successfully deleted merged non-SAP customers",
      count: deleteResult.deletedCount,
      details: mergedCustomers.map((c) => ({
        _id: c._id,
        CardCode: c.CardCode,
        CardName: c.CardName,
        Email: c.Email,
        mergedWith: c.notes.match(/Merged with (C\d+)/)?.[1] || "Unknown",
      })),
    });
  } catch (error) {
    console.error("Error deleting merged customers:", error);
    return res.status(500).json({
      success: false,
      message: "Error deleting merged customers",
      error: error.message,
    });
  }
};
exports.updateMissingEmails = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Please upload a file containing customer email data",
      });
    }

    // Ensure uploads directory exists
    const uploadsDir = path.join(process.cwd(), "uploads");
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    console.log("File upload path:", req.file.path);
    console.log("File exists check:", fs.existsSync(req.file.path));

    let emailData = [];
    const fileExt = path.extname(req.file.originalname).toLowerCase();

    // Process file based on extension
    if (fileExt === ".xlsx" || fileExt === ".xls") {
      // Process Excel file
      try {
        const workbook = XLSX.readFile(req.file.path);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(worksheet);

        console.log(`Extracted ${data.length} rows from Excel file`);

        // Map data to our email format
        emailData = data.map((row) => {
          return {
            CardCode: row["BP Code"] || row["CardCode"] || "",
            Email: row["E-Mail"] || row["Email"] || "",
            BP_Name: row["BP Name"] || row["CardName"] || "",
          };
        });
      } catch (error) {
        console.error("Error processing Excel file:", error);
        throw new Error(`Failed to process Excel file: ${error.message}`);
      }
    } else if (fileExt === ".csv") {
      // Process CSV file
      try {
        emailData = await new Promise((resolve, reject) => {
          const results = [];
          fs.createReadStream(req.file.path)
            .pipe(csv())
            .on("data", (row) => {
              results.push({
                CardCode: row["BP Code"] || row["CardCode"] || "",
                Email: row["E-Mail"] || row["Email"] || "",
                BP_Name: row["BP Name"] || row["CardName"] || "",
              });
            })
            .on("end", () => {
              console.log(`Processed ${results.length} rows from CSV`);
              resolve(results);
            })
            .on("error", (error) => {
              reject(error);
            });
        });
      } catch (error) {
        console.error("Error processing CSV file:", error);
        throw new Error(`Failed to process CSV file: ${error.message}`);
      }
    } else {
      // Process text file with specific format
      try {
        const fileContent = fs.readFileSync(req.file.path, "utf8");
        const lines = fileContent.split("\n");

        console.log(`Processing ${lines.length} lines from text file`);

        // Skip header row if it exists
        let startLine = 0;
        if (
          lines[0].includes("BP Code") ||
          lines[0].includes("BP Name") ||
          lines[0].includes("E-Mail")
        ) {
          startLine = 1;
        }

        // Process each line
        for (let i = startLine; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;

          // Match pattern for text: [index] BP_Code BP_Name Email
          const match = line.match(
            /^(?:\d+\s+)?(C\d+)\s+(.*?)(?:\s+(\S+@\S+\.\S+))?$/
          );

          if (match) {
            const [, CardCode, BP_Name, Email] = match;

            emailData.push({
              CardCode: CardCode.trim(),
              BP_Name: BP_Name.trim(),
              Email: Email || "",
            });
          }
        }

        console.log(
          `Extracted ${emailData.length} customer records with emails`
        );
      } catch (error) {
        console.error("Error processing text file:", error);
        throw new Error(`Failed to process text file: ${error.message}`);
      }
    }

    // Filter out entries without CardCode or Email
    emailData = emailData.filter((item) => item.CardCode && item.Email);

    console.log(`Prepared ${emailData.length} email records for update`);

    // Update database - only for customers with missing emails
    const updateResults = {
      total: emailData.length,
      updated: 0,
      skipped: 0,
      notFound: 0,
      errors: [],
    };

    for (const item of emailData) {
      try {
        // Find customer by CardCode
        const customer = await Customer.findOne({ CardCode: item.CardCode });

        if (customer) {
          // Only update if the customer doesn't have an email
          if (!customer.Email || customer.Email.trim() === "") {
            customer.Email = item.Email;
            await customer.save();
            updateResults.updated++;
          } else {
            // Skip update if customer already has an email
            updateResults.skipped++;
          }
        } else {
          updateResults.notFound++;
        }
      } catch (error) {
        console.error(`Error updating customer ${item.CardCode}:`, error);
        updateResults.errors.push({
          CardCode: item.CardCode,
          error: error.message,
        });
      }
    }

    // Clean up the uploaded file
    try {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (unlinkError) {
      console.error("Error deleting file after processing:", unlinkError);
    }

    res.status(200).json({
      success: true,
      message: `Email update complete`,
      results: updateResults,
    });
  } catch (error) {
    console.error("Email update error:", error);

    // Clean up file if it exists
    try {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
    } catch (unlinkError) {
      console.error("Error cleaning up file:", unlinkError);
    }

    res.status(500).json({
      success: false,
      message: "Error updating customer emails",
      error: error.message,
    });
  }
};

exports.bulkAssignCustomers = async (req, res) => {
  try {
    const { customerIds, agentId } = req.body;

    // Validate input
    if (
      !customerIds ||
      !Array.isArray(customerIds) ||
      customerIds.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid array of customer IDs",
      });
    }

    if (!agentId) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid agent ID",
      });
    }

    // Verify user has permission (admins and sales managers)
    if (
      req.user &&
      req.user.role !== "admin" &&
      req.user.role !== "sales_manager"
    ) {
      return res.status(403).json({
        success: false,
        message:
          "Unauthorized: Only admins and sales managers can reassign customers",
      });
    }

    // Verify the agent exists and is a sales agent
    const agent = await User.findById(agentId);
    if (!agent || agent.role !== "sales_agent") {
      return res.status(400).json({
        success: false,
        message: "Invalid sales agent ID",
      });
    }

    // Perform bulk update to assign all customers to the specified agent
    const result = await Customer.updateMany(
      { _id: { $in: customerIds } },
      { $set: { assignedTo: agentId } }
    );

    res.json({
      success: true,
      message: "Customers assigned successfully",
      count: result.modifiedCount,
      totalRequested: customerIds.length,
    });
  } catch (error) {
    console.error("Bulk customer assignment error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};
