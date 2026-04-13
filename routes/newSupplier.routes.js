// routes/newSupplier.routes.js
const express = require("express");
const router = express.Router();
const newSupplierController = require("../controllers/newSupplier.controller");
const { auth } = require("../middleware/auth");

// Database overview (must come BEFORE /:id route)
router.get("/stats/overview", auth, newSupplierController.getStatsOverview);
router.get("/template", auth, newSupplierController.downloadTemplate);
router.get("/match", auth, newSupplierController.matchSuppliersForProducts);

// Upload Excel
router.post("/preview", auth, newSupplierController.uploadMiddleware, newSupplierController.previewExcel);
router.post("/upload", auth, newSupplierController.uploadMiddleware, newSupplierController.uploadSuppliers);

// CRUD
router.post("/", auth, newSupplierController.createSupplier);
router.get("/", auth, newSupplierController.listSuppliers);
router.get("/:id", auth, newSupplierController.getSupplier);
router.put("/:id", auth, newSupplierController.updateSupplier);
router.delete("/:id", auth, newSupplierController.deleteSupplier);

module.exports = router;
