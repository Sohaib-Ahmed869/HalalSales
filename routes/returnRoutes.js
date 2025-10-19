// routes/returnRoutes.js
const express = require("express");
const router = express.Router();
const returnController = require("../controllers/returnController");
const { auth } = require("../middleware/auth");

router.get("/", auth, returnController.getAllReturns);
router.post("/from-delivery-note/:deliveryNoteDocEntry", auth, returnController.createReturnFromDeliveryNote);
router.post("/:docEntry/push-to-sap", auth, returnController.pushReturnToSAP);

module.exports = router;