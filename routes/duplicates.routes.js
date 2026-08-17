// routes/duplicates.routes.js
const express = require("express");
const router = express.Router();
const { auth, checkRole } = require("../middleware/auth");
const duplicatesController = require("../controllers/duplicates.controller");

// Anyone signed in can see that an account has siblings — that context is
// useful on the customer screen and the map.
const canView = [auth];
// Confirming or dismissing a link changes shared data, so it is restricted.
const canReview = [auth, checkRole(["admin", "sales_manager"])];

// --- review queue -----------------------------------------------------------
router.get("/", canView, duplicatesController.getDuplicateGroups);
router.get("/export", canView, duplicatesController.exportDuplicates);
router.get("/hubs", canView, duplicatesController.getHubs);

// --- confirmed links --------------------------------------------------------
router.get("/groups", canView, duplicatesController.getConfirmedGroups);
router.get("/for-customer/:id", canView, duplicatesController.getGroupForCustomer);

router.post("/link", canReview, duplicatesController.linkGroup);
router.post("/ignore", canReview, duplicatesController.ignoreGroup);
router.post("/hub", canReview, duplicatesController.markAsHub);

router.put("/groups/:id", canReview, duplicatesController.updateGroup);
router.delete("/groups/:id", canReview, duplicatesController.deleteGroup);

module.exports = router;
