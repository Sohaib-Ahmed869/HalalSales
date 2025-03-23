const express = require("express");
const router = express.Router();
const {
  auth,
  checkRole,
  canManageCustomer,
  updateLastLogin,
} = require("../middleware/auth");
const customerController = require("../controllers/customer.controller");

// Get all customers (with filtering and permissions)
router.get("/", auth, updateLastLogin, customerController.getCustomers);

// Get customer by ID
router.get("/:id", auth, updateLastLogin, customerController.getCustomerById);

// Create customer
router.post(
  "/",
  auth,
  checkRole(["admin", "sales_manager"]),
  customerController.createCustomer
);

// Update customer
router.put("/:id", auth, canManageCustomer, customerController.updateCustomer);

// Import customers from SAP or external source
router.post(
  "/import",
  auth,
  checkRole(["admin"]),
  customerController.importCustomers
);

// Assign/reassign customer
router.post(
  "/:id/assign",
  auth,
  checkRole(["admin", "sales_manager"]),
  customerController.assignCustomer
);

// Get customers assigned to a specific sales agent
router.get("/agent/:agentId", auth, customerController.getCustomersByAgent);

// Add notes to customer
router.post("/:id/notes", auth, canManageCustomer, customerController.addNotes);

module.exports = router;
