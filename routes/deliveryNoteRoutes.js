// routes/deliveryNoteRoutes.js
const express = require("express");
const router = express.Router();
const deliveryNoteController = require("../controllers/deliveryNoteController");
const { auth } = require("../middleware/auth");

// Live sync and status sync routes
router.get("/live-sync", deliveryNoteController.liveSyncDeliveryNotesWithSAP);
router.post("/sync-statuses-from-sap", deliveryNoteController.syncDeliveryNoteStatusesFromSAP);
router.post("/sync-statuses", auth, deliveryNoteController.syncDeliveryNoteStatusesFromSAP);

// Get all delivery notes
router.get("/", auth, deliveryNoteController.getAllDeliveryNotes);

// Get single delivery note
router.get("/:docEntry", auth, deliveryNoteController.getDeliveryNoteByDocEntry);

// Get delivery note with returns
router.get("/:docEntry/with-returns", auth, deliveryNoteController.getDeliveryNoteWithReturns);

// Create delivery note from order
router.post("/from-order/:docEntry", auth, deliveryNoteController.createDeliveryNoteFromOrder);

// Bulk create delivery notes from multiple orders
router.post("/bulk-create-from-orders", auth, deliveryNoteController.bulkCreateDeliveryNotesFromOrders);

// Bulk push delivery notes to SAP
router.post("/bulk-push-to-sap", auth, deliveryNoteController.bulkPushDeliveryNotesToSAP);

module.exports = router;