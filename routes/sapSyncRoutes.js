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

// Pull outstanding balances down from SAP (?dryRun=true to preview)
router.post("/sync-balances", sapSyncController.syncCustomerBalances);

// Refresh one customer's balance from SAP
router.post("/sync-balance/:cardCode", sapSyncController.syncCustomerBalance);

module.exports = router;