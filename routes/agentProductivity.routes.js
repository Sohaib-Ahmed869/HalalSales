// routes/agentProductivity.routes.js
const express = require("express");
const router = express.Router();
const agentProductivityController = require("../controllers/agentProductivity.controller");
const { auth, checkRole } = require("../middleware/auth");

// Admins see every agent, sales managers their team, an agent only themself
// (scoping enforced in the controller).
router.use(auth);
router.use(checkRole(["admin", "sales_manager", "sales_agent"]));

// GET /api/agent-productivity?fromDate=2026-11-09&toDate=2026-11-15[&salesAgent=<id>]
// Per agent: totals for the range and one row per day — DeskTime, orders,
// invoiced sales, calls, leads called, follow-ups, ratios per productive hour.
router.get("/", agentProductivityController.getAgentProductivity);

module.exports = router;
