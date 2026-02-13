const express = require("express");
const router = express.Router();
const sapSyncController = require("../controllers/sapSyncController");

// Protect these routes with authentication middleware if needed
// const { protect, authorize } = require("../middleware/auth");

// Get sync status
router.get("/status", sapSyncController.getSyncStatus);

// Sync all customers with SAP (assigns new CardCodes and syncs)
router.post("/sync-all", sapSyncController.syncAllCustomersWithSAP);

// Sync a single customer
router.post("/sync-customer/:customerId", sapSyncController.syncSingleCustomer);

module.exports = router;