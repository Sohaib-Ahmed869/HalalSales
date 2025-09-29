// routes/contactImport.routes.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const { upload, importContactsFromCSV, validateCSVFormat, getImportStats } = require("../controllers/contactImport.controller");

// Import routes
router.post("/validate", upload.single('csvFile'), validateCSVFormat);
router.post("/import", upload.single('csvFile'), importContactsFromCSV);
router.get("/stats", getImportStats);

// Error handling for multer
router.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
                success: false,
                message: "File too large. Maximum size is 50MB."
            });
        }
    }

    if (error.message === 'Only CSV files are allowed') {
        return res.status(400).json({
            success: false,
            message: "Only CSV files are allowed. Please upload a .csv file."
        });
    }

    res.status(500).json({
        success: false,
        message: "Upload error",
        error: error.message
    });
});

module.exports = router;