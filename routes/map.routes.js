// routes/map.routes.js
const express = require("express");
const router = express.Router();
const mapController = require("../controllers/map.controller");


// Get documents by date range for map display
// GET /api/map/documents?startDate=2024-01-01&endDate=2024-12-31&type=all|invoice|order|quotation
router.get("/documents", mapController.getDocumentsByDateRange);

// Get documents for a specific customer
// GET /api/map/customer/:cardCode?type=all|invoice|order|quotation&startDate=X&endDate=Y
router.get("/customer/:cardCode", mapController.getCustomerDocumentsForMap);

// Search customers for map selection (autocomplete)
// GET /api/map/search-customers?search=term
router.get("/search-customers", mapController.searchCustomersForMap);
// Get customers geocoded outside France
router.get("/geocoding/outside-france", mapController.getCustomersOutsideFrance);

// Verify/fix single customer location
router.post("/customer/:cardCode/verify-location", mapController.verifyAndFixCustomerLocation);

// Batch fix all customers outside France using Google
router.post("/geocoding/fix-outside-france", mapController.fixCustomersOutsideFrance);

router.get("/geocoding/review-outside", mapController.getCustomersForManualReview);

// Bulk update coordinates after your review
router.post("/geocoding/bulk-update", mapController.bulkUpdateCoordinates);

// Accept Google suggestion for single customer
router.post("/customer/:cardCode/accept-google", mapController.acceptGoogleSuggestion);
// Geocoding management routes (admin only)
router.get("/geocoding/stats", mapController.getGeocodingStats);
router.post("/geocoding/batch", mapController.batchGeocodeCustomers);
router.put("/customer/:cardCode/coordinates", mapController.setCustomerCoordinates);


module.exports = router;