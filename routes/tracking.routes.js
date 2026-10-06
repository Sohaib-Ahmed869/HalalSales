// routes/tracking.routes.js
const express = require("express");
const router = express.Router();
const { auth, checkRole } = require("../middleware/auth");
const controller = require("../controllers/tracking.controller");

router.use(auth);
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.get("/devices", controller.listDevices);
router.get("/trail/:truckNumber", controller.getTrail);
router.get("/geotab/vehicles", controller.listGeotabVehicles);
router.get("/fleet", controller.getFleet);
router.get("/adherence", controller.getAdherence);
router.post("/devices", checkRole(["admin", "sales_manager"]), controller.assignDevice);
router.delete("/devices/:id", checkRole(["admin", "sales_manager"]), controller.deleteDevice);

module.exports = router;
