// routes/tracking.routes.js
const express = require("express");
const router = express.Router();
const { auth, checkRole } = require("../middleware/auth");
const controller = require("../controllers/tracking.controller");

// Traccar Client can't send a Bearer token: the device id is its credential.
// Registered before router.use(auth). Accepts GET (classic) and POST (newer).
router.get("/osmand", controller.ingest);
router.post("/osmand", controller.ingest);

router.use(auth);
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.get("/devices", controller.listDevices);
router.get("/trail/:truckNumber", controller.getTrail);
router.post("/devices", checkRole(["admin", "sales_manager"]), controller.createDevice);
router.delete("/devices/:id", checkRole(["admin", "sales_manager"]), controller.deleteDevice);

module.exports = router;
