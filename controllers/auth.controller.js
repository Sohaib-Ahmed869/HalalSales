const bcrypt = require("bcryptjs");
const multer = require("multer");
const csv = require("csv-parser");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const XLSX = require("xlsx");

const User = require("../models/User");

// Environment variables
const JWT_SECRET = process.env.JWT_SECRET || "your_secret_key";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "24h";
// Set up multer for file upload
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max file size
  fileFilter: (req, file, cb) => {
    // Accept only Excel files
    if (
      file.mimetype ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.mimetype === "application/vnd.ms-excel" ||
      file.originalname.endsWith(".xlsx") ||
      file.originalname.endsWith(".xls")
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only Excel files (.xlsx, .xls) are allowed"));
    }
  },
}).single("file");

// Login controller
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }

    // Find user by email
    const user = await User.findOne({ email, deactivated: false });
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Check password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // Update last login
    user.lastLogin = Date.now();
    await user.save();

    // Create token
    const token = jwt.sign({ userId: user._id, role: user.role }, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN,
    });

    // Return user data without password
    const userData = user.toObject();
    delete userData.password;

    res.json({
      message: "Login successful",
      token,
      user: userData,
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.registerAdmin = async (req, res) => {
  try {
    const { firstName, lastName, email, password, role } = req.body;

    // Validation
    if (!firstName || !lastName || !email || !password || !role) {
      return res
        .status(400)
        .json({ message: "All required fields must be provided" });
    }

    // Check if email already exists
    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ message: "Email already in use" });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create new user
    const newUser = new User({
      firstName,
      lastName,
      email,
      password: hashedPassword,
      role,
    });

    // Save user
    await newUser.save();

    // Return user data without password
    const userData = newUser.toObject();

    res.status(201).json({
      message: "User registered successfully",
      user: userData,
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Register user controller
exports.register = async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      email,
      password,
      role,
      hubspotId,
      target,
      managerId,
    } = req.body;

    // Validation
    if (!firstName || !lastName || !email || !password || !role) {
      return res
        .status(400)
        .json({ message: "All required fields must be provided" });
    }

    // Check if email already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "Email already in use" });
    }

    // Role-based permission checks
    const currentUserRole = req.user.role;

    // Admin can create sales_manager and sales_agent
    if (currentUserRole === "admin") {
      if (role !== "sales_manager" && role !== "sales_agent") {
        return res.status(403).json({
          message: "Admin can only create sales manager or sales agent",
        });
      }
    }
    // Sales manager can only create sales_agent
    else if (currentUserRole === "sales_manager") {
      if (role !== "sales_agent") {
        return res
          .status(403)
          .json({ message: "Sales manager can only create sales agent" });
      }
    }
    // Sales agent cannot create users
    else {
      return res
        .status(403)
        .json({ message: "You don't have permission to register new users" });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create new user
    const newUser = new User({
      firstName,
      lastName,
      email,
      password: hashedPassword,
      role,
      createdBy: req.user._id,
    });

    // Add role-specific fields
    if (role === "sales_agent") {
      if (hubspotId) newUser.hubspotId = hubspotId;
      if (target) newUser.target = target;

      // Set manager
      if (currentUserRole === "admin" && managerId) {
        // Admin specified a manager
        const manager = await User.findById(managerId);
        if (!manager || manager.role !== "sales_manager") {
          return res.status(400).json({ message: "Invalid manager ID" });
        }
        newUser.manager = managerId;
      } else if (currentUserRole === "sales_manager") {
        // Sales manager is creating - they are the manager
        newUser.manager = req.user._id;
      } else {
        return res
          .status(400)
          .json({ message: "Manager ID is required for sales agent" });
      }
    }

    // Save user
    await newUser.save();

    // Return user data without password
    const userData = newUser.toObject();
    delete userData.password;

    res.status(201).json({
      message: "User registered successfully",
      user: userData,
    });
  } catch (error) {
    console.error("Registration error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Get current user profile
exports.getProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select("-password")
      .populate("createdBy", "firstName lastName email")
      .populate("manager", "firstName lastName email");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(user);
  } catch (error) {
    console.error("Profile fetch error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Update current user profile
exports.updateProfile = async (req, res) => {
  try {
    const { firstName, lastName, email } = req.body;
    const updatedFields = {};

    if (firstName) updatedFields.firstName = firstName;
    if (lastName) updatedFields.lastName = lastName;
    if (email) updatedFields.email = email;

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updatedFields },
      { new: true, runValidators: true }
    ).select("-password");

    res.json({
      message: "Profile updated successfully",
      user,
    });
  } catch (error) {
    console.error("Profile update error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Change password
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res
        .status(400)
        .json({ message: "Current and new passwords are required" });
    }

    const user = await User.findById(req.user._id);

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Current password is incorrect" });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // Update password
    user.password = hashedPassword;
    await user.save();

    res.json({ message: "Password updated successfully" });
  } catch (error) {
    console.error("Password change error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Get users by role
exports.getUsers = async (req, res) => {
  try {
    const { role } = req.query;
    console.log(role);
    const query = {};

    // Filter by role if provided
    if (role) {
      query.role = role;
    }

    // Sales manager can only see their sales agents
    if (req.user.role === "sales_manager") {
      query.role = "sales_agent"; // Sales managers can only see sales agents
    }

    const users = await User.find(query)
      .select("-password")
      .populate("createdBy", "firstName lastName email")
      .populate("manager", "firstName lastName email");

    res.json(users);
  } catch (error) {
    console.error("User fetch error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Get user by ID
exports.getUserById = async (req, res) => {
  try {
    const { id } = req.params;
    let user;

    // Check permissions
    if (req.user.role === "admin") {
      // Admin can see any user
      user = await User.findById(id)
        .select("-password")
        .populate("createdBy", "firstName lastName email")
        .populate("manager", "firstName lastName email");
    } else if (req.user.role === "sales_manager") {
      // Sales manager can only see their sales agents
      user = await User.findOne({
        _id: id,
        role: "sales_agent",
        createdBy: req.user._id,
      })
        .select("-password")
        .populate("createdBy", "firstName lastName email")
        .populate("manager", "firstName lastName email");
    } else {
      // Sales agents can only see themselves
      if (id !== req.user._id.toString()) {
        return res.status(403).json({ message: "Access denied" });
      }

      user = await User.findById(id)
        .select("-password")
        .populate("createdBy", "firstName lastName email")
        .populate("manager", "firstName lastName email");
    }

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(user);
  } catch (error) {
    console.error("User fetch error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Update user
exports.updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      firstName,
      lastName,
      email,
      hubspotId,
      target,
      deactivated,
      managerId,
    } = req.body;

    // Check if user exists
    const userToUpdate = await User.findById(id);
    if (!userToUpdate) {
      return res.status(404).json({ message: "User not found" });
    }

    // Permission check
    if (req.user.role === "admin") {
      // Admin can update any user
    } else if (req.user.role === "sales_manager") {
      // Sales manager can only update their sales agents
    } else {
      // Sales agents cannot update other users
      return res.status(403).json({ message: "Access denied" });
    }

    // Build update object
    const updatedFields = {};
    if (firstName) updatedFields.firstName = firstName;
    if (lastName) updatedFields.lastName = lastName;
    if (email) updatedFields.email = email;
    if (deactivated !== undefined) updatedFields.deactivated = deactivated;

    // Role-specific updates
    if (userToUpdate.role === "sales_agent") {
      if (hubspotId !== undefined) updatedFields.hubspotId = hubspotId;
      if (target !== undefined) updatedFields.target = target;

      // Manager update (admin only)
      if (req.user.role === "admin" && managerId !== undefined) {
        const manager = await User.findById(managerId);
        if (!manager || manager.role !== "sales_manager") {
          return res.status(400).json({ message: "Invalid manager ID" });
        }
        updatedFields.manager = managerId;
      }
    }

    // Update user
    const updatedUser = await User.findByIdAndUpdate(
      id,
      { $set: updatedFields },
      { new: true, runValidators: true }
    )
      .select("-password")
      .populate("createdBy", "firstName lastName email")
      .populate("manager", "firstName lastName email");

    console.log(updatedUser);
    res.json({
      message: "User updated successfully",
      user: updatedUser,
    });
  } catch (error) {
    console.error("User update error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// Reset user password
exports.resetPassword = async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;

    if (!newPassword) {
      return res.status(400).json({ message: "New password is required" });
    }

    // Check if user exists
    const userToUpdate = await User.findById(id);
    if (!userToUpdate) {
      return res.status(404).json({ message: "User not found" });
    }

    // Permission check
    if (req.user.role === "admin") {
      // Admin can reset any user's password
    } else if (req.user.role === "sales_manager") {
      // Sales manager can only reset their sales agents' passwords
      if (
        userToUpdate.role !== "sales_agent" ||
        userToUpdate.createdBy.toString() !== req.user._id.toString()
      ) {
        return res.status(403).json({
          message: "You can only reset passwords for sales agents you created",
        });
      }
    } else {
      // Sales agents cannot reset other users' passwords
      return res.status(403).json({ message: "Access denied" });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // Update password
    userToUpdate.password = hashedPassword;
    await userToUpdate.save();

    res.json({ message: "Password reset successfully" });
  } catch (error) {
    console.error("Password reset error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.importSalesAgents = async (req, res) => {
  // Use multer to handle file upload
  upload(req, res, async (err) => {
    try {
      if (err) {
        return res.status(400).json({ message: err.message });
      }

      if (!req.file) {
        return res.status(400).json({ message: "Please upload an Excel file" });
      }

      // Role-based permission check
      const currentUserRole = req.user.role;
      if (currentUserRole !== "admin" && currentUserRole !== "sales_manager") {
        return res.status(403).json({
          message: "Only admins and sales managers can import sales agents",
        });
      }

      // Initialize results tracking
      const results = {
        total: 0,
        success: 0,
        failed: 0,
        errors: [],
      };

      // Read the Excel file
      const workbook = XLSX.readFile(req.file.path, {
        cellDates: true, // Properly parse date values
      });

      // Get the first sheet
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];

      // Convert to JSON
      const jsonData = XLSX.utils.sheet_to_json(worksheet, {
        raw: false, // Convert all cells to strings
        defval: "", // Default to empty string for empty cells
      });

      results.total = jsonData.length;
      const agents = [];

      // Process each row
      for (const row of jsonData) {
        // Normalize field names (handle variations in column names)
        const agent = {
          firstName:
            row["First Name"] ||
            row["FirstName"] ||
            row["First_Name"] ||
            row["first_name"] ||
            row["firstname"],
          lastName:
            row["Last Name"] ||
            row["LastName"] ||
            row["Last_Name"] ||
            row["last_name"] ||
            row["lastname"],
          email: row["Email"] || row["email"],
          hubspotId:
            row["User ID"] ||
            row["UserID"] ||
            row["User_ID"] ||
            row["user_id"] ||
            row["userid"] ||
            row["HubSpot ID"] ||
            row["hubspot_id"] ||
            row["hubspotId"],
        };

        // Skip rows without required fields
        if (!agent.firstName || !agent.lastName || !agent.email) {
          results.failed++;
          results.errors.push(
            `Missing required fields for row: ${JSON.stringify(row)}`
          );
          continue;
        }

        try {
          // Check if user already exists
          const existingUser = await User.findOne({ email: agent.email });
          if (existingUser) {
            results.failed++;
            results.errors.push(
              `User with email ${agent.email} already exists`
            );
            continue;
          }

          // Generate a random password (8 characters)
          const tempPassword = Math.random().toString(36).slice(-8);

          // Hash password
          const salt = await bcrypt.genSalt(10);
          const hashedPassword = await bcrypt.hash(tempPassword, salt);

          // Create new user object
          const newUser = new User({
            firstName: agent.firstName,
            lastName: agent.lastName,
            email: agent.email.trim().toLowerCase(),
            password: hashedPassword,
            role: "sales_agent",
            createdBy: req.user._id,
            hubspotId: agent.hubspotId || undefined,
            target: 0, // Default target
          });

          // Set manager based on current user role
          if (currentUserRole === "sales_manager") {
            // If sales manager is creating, they are the manager
            newUser.manager = req.user._id;
          } else if (currentUserRole === "admin") {
            // For admin, we would ideally have a manager ID in the Excel
            // For now, we'll just set it to the admin (can be updated later)
            newUser.manager = req.user._id;
          }

          // Save user
          await newUser.save();

          // Add password to agent for the response
          agent.tempPassword = tempPassword;
          agents.push(agent);
          results.success++;
        } catch (error) {
          results.failed++;
          results.errors.push(
            `Error creating ${agent.email}: ${error.message}`
          );
        }
      }

      // Clean up the uploaded file
      fs.unlinkSync(req.file.path);

      // Return results
      res.json({
        message: "Import completed",
        results: {
          total: results.total,
          success: results.success,
          failed: results.failed,
        },
        agents: agents.map((a) => ({
          firstName: a.firstName,
          lastName: a.lastName,
          email: a.email,
          tempPassword: a.tempPassword,
        })),
        errors: results.errors,
      });
    } catch (error) {
      console.error("Import error:", error);

      // Clean up the uploaded file if it exists
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }

      res.status(500).json({ message: "Server error", error: error.message });
    }
  });
};

exports.setTarget = async (req, res) => {
  try {
    const { target } = req.body;

    const { id } = req.params;

    // Check if user exists
    const userToUpdate = await User.findById(id);
    if (!userToUpdate) {
      return res.status(404).json({ message: "User not found" });
    }

    // Permission check
    if (req.user.role === "admin") {
      // Admin can update any user
    } else if (req.user.role === "sales_manager") {
      // Sales manager can only update their sales agents
    } else {
      // Sales agents cannot update other users
      return res.status(403).json({ message: "Access denied" });
    }

    // Build update object
    const updatedFields = {};
    if (target) updatedFields.target = target;

    // Update user
    const updated = await User.findByIdAndUpdate(
      id,
      { $set: updatedFields },
      { new: true, runValidators: true }
    )
      .select("-password")
      .populate("createdBy", "firstName lastName email")
      .populate("manager", "firstName lastName email");

    res.json({
      message: "User updated successfully",
      user: updated,
    });
  } catch (error) {
    console.error("User update error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};
