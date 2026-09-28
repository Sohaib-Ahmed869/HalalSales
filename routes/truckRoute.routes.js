// routes/truckRoute.routes.js
const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const controller = require("../controllers/truckRoute.controller");

router.use(auth);

// Weekly templates
router.get("/schedules", controller.getSchedules);
router.post("/schedules", controller.createSchedule);
router.put("/schedules/:id", controller.updateSchedule);
router.delete("/schedules/:id", controller.deleteSchedule);

// Per-date routes
router.post("/initialize-date", controller.initializeDate);
router.get("/date/:date", controller.getRoutesByDate);
router.get("/single/:routeId", controller.getSingleRoute);
router.get("/available-orders/:date", controller.getAvailableOrders);
router.get("/stats", controller.getStats);

router.post("/:routeId/generate", controller.generateRoute);
router.post("/:routeId/optimize", controller.optimizeRoute);
router.post("/auto-fill-all/:date", controller.autoFillAllTrucks);

router.post("/:routeId/assign-order", controller.assignOrderToTruck);
router.delete("/:routeId/orders/:docEntry", controller.removeOrderFromTruck);
router.put("/:routeId/reorder", controller.reorderOrders);
router.patch("/:routeId/status", controller.updateRouteStatus);
router.patch("/:routeId/capacity", controller.updateCapacity);

module.exports = router;
