const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const callDataController = require("../controllers/callData.controller");
const { auth } = require("../middleware/auth");

// Configure multer for file upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/");
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(
      null,
      file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname)
    );
  },
});

const fileFilter = (req, file, cb) => {
  // Accept only CSV files
  if (file.mimetype === "text/csv" || file.originalname.endsWith(".csv")) {
    cb(null, true);
  } else {
    cb(new Error("Only CSV files are allowed!"), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 50 * 1024 * 1024, // Increased to 50MB limit
  },
});

// Routes
router.post("/upload", upload.single("file"), callDataController.uploadCSV);
router.get("/agent", auth, callDataController.getAgentCallData);

// Get call statistics for the current authenticated agent
router.get("/statistics", auth, callDataController.getAgentCallStatistics);
// Get call data for all agents (manager view)
router.get("/team", auth, callDataController.getTeamCallData);

// Get call statistics for all agents (manager view)
router.get("/team/statistics", auth, callDataController.getTeamCallStatistics);

// Get agent performance comparison
router.get(
  "/performance/compare",
  auth,
  callDataController.getAgentPerformanceComparison
);
router.get("/", callDataController.getAllCallData);
router.get("/:id", callDataController.getCallDataById);
router.delete("/:id", callDataController.deleteCallDataById);

// Get call data for the current authenticated agent

module.exports = router;
