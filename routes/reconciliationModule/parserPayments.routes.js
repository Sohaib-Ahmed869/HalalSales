// routes/salarySheet.routes.js
const express = require("express");
const router = express.Router();
const multer = require("multer");
const salarySheetController = require("../../controllers/reconciliationModule/parserPayments.controller");
// Configure multer for file upload (store in memory)
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        // Accept only Excel files
        if (
            file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
            file.mimetype === "application/vnd.ms-excel"
        ) {
            cb(null, true);
        } else {
            cb(new Error("Only Excel files are allowed!"), false);
        }
    },
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB limit
    },
});

// @route   POST /api/salary-sheet/parse
// @desc    Parse salary/financial sheet and return categorized JSON
// @access  Public
router.post("/parse", upload.single("file"), salarySheetController.parseSalarySheet);

module.exports = router;