// routes/map.routes.js
const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const controller = require("../controllers/map.controller");

router.use(auth);

router.get("/documents", controller.getDocuments);
router.get("/customer/:cardCode", controller.getCustomerDocuments);
router.get("/search-customers", controller.searchCustomers);
router.get("/geocoding/stats", controller.getGeocodingStats);
router.post("/geocoding/batch", controller.batchGeocode);
router.put("/customer/:cardCode/coordinates", controller.setCustomerCoordinates);

module.exports = router;
