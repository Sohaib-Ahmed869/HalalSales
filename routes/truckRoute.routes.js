// routes/truckRoute.routes.js
const express = require('express');
const router = express.Router();
const {
    getTruckSchedules,
    createOrUpdateSchedule,
    deleteSchedule,
    getRoutesByDate,
    initializeTrucksForDate,
    getAvailableOrders,
    getRouteStatistics,
    assignOrderToTruck,
    removeOrderFromTruck,
    reorderOrders,
    updateRouteStatus,
    debugRoutes,
    optimizeRoute,
    generateTruckRoute,
} = require('../controllers/truckRoute.controller');

router.get("/debug", debugRoutes);
// Truck Schedules (Templates) - Define weekly delivery schedules
router.get('/schedules', getTruckSchedules);
router.post('/schedules', createOrUpdateSchedule);
router.delete('/schedules/:id', deleteSchedule);

// Truck Routes (Actual Deliveries) - Manage daily truck routes
router.get('/date/:date', getRoutesByDate);
router.post('/initialize-date', initializeTrucksForDate);
router.get('/available-orders/:date', getAvailableOrders);
router.get('/stats', getRouteStatistics);

// Order Assignment - Assign orders to trucks
router.post('/:routeId/assign-order', assignOrderToTruck);
router.delete('/:routeId/orders/:orderDocEntry', removeOrderFromTruck);
router.put('/:routeId/reorder', reorderOrders);

// Route Management - Update route status
router.patch('/:routeId/status', updateRouteStatus);
router.post('/:routeId/optimize', optimizeRoute);
router.post('/:routeId/generate', generateTruckRoute);


module.exports = router;