// routes/truckRoute.routes.js
const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const controller = require("../controllers/truckRoute.controller");

router.use(auth);

// This data changes on every Initialize/Generate/Optimize/Auto-Fill/manual
// edit — never let a browser or intermediate proxy cache a GET response and
// serve stale routes/stats after an action that just changed them.
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// Weekly templates
router.get("/schedules", controller.getSchedules);
router.post("/schedules", controller.createSchedule);
router.put("/schedules/:id", controller.updateSchedule);
router.delete("/schedules/:id", controller.deleteSchedule);

// Per-date routes
router.post("/initialize-date", controller.initializeDate);
router.get("/date/:date", controller.getRoutesByDate);
router.get("/single/:routeId", controller.getSingleRoute);
router.get("/geometry/:routeId", controller.getRouteGeometry);
router.get("/available-orders/:date", controller.getAvailableOrders);
router.get("/stats", controller.getStats);

router.post("/:routeId/generate", controller.generateRoute);
router.post("/:routeId/optimize", controller.optimizeRoute);
router.post("/auto-fill-all/:date", controller.autoFillAllTrucks);

router.post("/:routeId/assign-order", controller.assignOrderToTruck);
router.delete("/:routeId/orders/:docEntry", controller.removeOrderFromTruck);
router.patch("/:routeId/orders/:docEntry/status", controller.updateStopStatus);
router.put("/:routeId/reorder", controller.reorderOrders);
router.put("/:routeId/departure", controller.setDepartureTime);
router.patch("/:routeId/status", controller.updateRouteStatus);
router.patch("/:routeId/capacity", controller.updateCapacity);

module.exports = router;
