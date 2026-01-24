// routes/truckRouteV2.routes.js
const express = require('express');
const router = express.Router();
const controller = require('../controllers/truckRouteV2.controller');

// ==========================================
// SCHEDULES (Templates)
// ==========================================
router.get('/schedules', controller.getSchedules);
router.post('/schedules', controller.upsertSchedule);
router.delete('/schedules/:id', controller.deleteSchedule);

// ==========================================
// ROUTES (Daily Operations)
// ==========================================
router.get('/routes/:date', controller.getRoutesForDate);
router.post('/initialize', controller.initializeTrucks);

// ==========================================
// ORDERS
// ==========================================
router.get('/available-orders/:date', controller.getAvailableOrders);
router.post('/routes/:routeId/assign', controller.assignOrder);
router.delete('/routes/:routeId/orders/:orderDocNum', controller.removeOrder);
router.post('/routes/:routeId/auto-fill', controller.autoFillTruck);

module.exports = router;