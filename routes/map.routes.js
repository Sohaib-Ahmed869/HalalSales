// routes/map.routes.js
const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const controller = require("../controllers/map.controller");
const tiles = require("../controllers/mapTiles.controller");

// Map tile images: public URL checked with a short-lived "tiles" token
// (an <img> request can't send the Authorization header).
router.get("/tiles/:z/:x/:y", tiles.getTile);

router.use(auth);

router.get("/tiles/config", tiles.getTileConfig);
router.get("/tiles/attribution", tiles.getAttribution);

router.get("/documents", controller.getDocuments);
router.get("/customer/:cardCode", controller.getCustomerDocuments);
router.get("/search-customers", controller.searchCustomers);
router.get("/geocoding/stats", controller.getGeocodingStats);
router.post("/geocoding/batch", controller.batchGeocode);
router.put("/customer/:cardCode/coordinates", controller.setCustomerCoordinates);

module.exports = router;
