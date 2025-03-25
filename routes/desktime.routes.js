// routes/salesPerformance.routes.js
const express = require("express");
const router = express.Router();
const salesPerformanceController = require("../controllers/desktime.controller");
const { auth, checkRole, updateLastLogin } = require("../middleware/auth");

// Route for getting all DeskTime records for a specific sales agent
// @route   GET /api/performance/agent/:id
// @access  Private (Admin, Sales Manager, or Self)
router.get(
  "/agent/:id",
  auth,
  updateLastLogin,
  (req, res, next) => {
    // Allow admin and sales_manager to access any agent's data
    if (req.user.role === "admin" || req.user.role === "sales_manager") {
      return next();
    }

    // Allow sales agents to access only their own data
    if (req.params.id === req.user._id.toString()) {
      return next();
    }

    // Deny access to others
    return res.status(403).json({
      success: false,
      message: "Access denied. You can only view your own performance data.",
    });
  },
  salesPerformanceController.getSalesAgentRecords
);

// Route for getting DeskTime records for a specific sales agent in a date range
// @route   GET /api/performance/agent/:id/time
// @access  Private (Admin, Sales Manager, or Self)
router.get(
  "/agent/:id/time",
  auth,
  updateLastLogin,
  (req, res, next) => {
    // Allow admin and sales_manager to access any agent's data
    if (req.user.role === "admin" || req.user.role === "sales_manager") {
      return next();
    }

    // Allow sales agents to access only their own data
    if (req.params.id === req.user._id.toString()) {
      return next();
    }

    // Deny access to others
    return res.status(403).json({
      success: false,
      message: "Access denied. You can only view your own performance data.",
    });
  },
  salesPerformanceController.getSalesAgentTimeRecords
);

// Route for getting overall team performance metrics
// @route   GET /api/performance/overall
// @access  Private (Admin, Sales Manager)
router.get(
  "/overall",
  auth,
  updateLastLogin,
  checkRole(["admin", "sales_manager"]),
  salesPerformanceController.getOverallPerformance
);

// Route for getting detailed performance for a specific sales agent
// @route   GET /api/performance/agent/:id/performance
// @access  Private (Admin, Sales Manager, or Self)
router.get(
  "/agent/:id/performance",
  auth,
  updateLastLogin,
  (req, res, next) => {
    // Allow admin and sales_manager to access any agent's data
    if (req.user.role === "admin" || req.user.role === "sales_manager") {
      return next();
    }

    // Allow sales agents to access only their own data
    if (req.params.id === req.user._id.toString()) {
      return next();
    }

    // Deny access to others
    return res.status(403).json({
      success: false,
      message: "Access denied. You can only view your own performance data.",
    });
  },
  salesPerformanceController.getSalesAgentPerformance
);

module.exports = router;
