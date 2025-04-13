// routes/customerTargetRoutes.js
const express = require("express");
const router = express.Router();
const customerTargetController = require("../controllers/customerTarget.controller");
const { auth, checkRole, updateLastLogin } = require("../middleware/auth");

// Create a new customer target - Admin and Sales Manager only
router.post(
  "/",
  auth,
  checkRole(["admin", "sales_manager"]),
  customerTargetController.createCustomerTarget
);

// Get all customer targets with filtering and pagination
router.get("/", auth, customerTargetController.getAllCustomerTargets);

// Get a single customer target by ID
router.get("/:id", auth, customerTargetController.getCustomerTargetById);

// Update a customer target - Admin and Sales Manager only
router.put(
  "/:id",
  auth,
  checkRole(["admin", "sales_manager"]),
  customerTargetController.updateCustomerTarget
);

// Delete a customer target - Admin only
router.delete(
  "/:id",
  auth,
  checkRole(["admin"]),
  customerTargetController.deleteCustomerTarget
);

// Get customer targets for a specific agent
router.get(
  "/agent/:agentId",
  auth,
  customerTargetController.getAgentCustomerTargets
);

// Get customer targets for a specific customer
router.get(
  "/customer/:cardCode",
  auth,
  customerTargetController.getCustomerTargetsByCustomer
);

// Get dashboard summary of customer targets
router.get(
  "/dashboard/summary",
  auth,
  customerTargetController.getCustomerTargetsDashboard
);

module.exports = router;
