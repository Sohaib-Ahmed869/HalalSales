// routes/ubereats.routes.js
// Uber Eats scraper page. Reads/writes the scraper app's own database (see utils/ubereatsDb.js).
const express = require("express");
const router = express.Router();
const { auth, checkRole } = require("../middleware/auth");
const controller = require("../controllers/ubereats.controller");

// Who can queue scrapes and change the postal-code list: the roles that see the page in the sidebar,
// plus sales managers. Anyone logged in can read.
const canManage = checkRole(["admin", "sales_manager", "logistics"]);

router.use(auth);
router.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

router.get("/status", controller.getStatus);
router.get("/dashboard", controller.getDashboard);

router.get("/postal-codes", controller.listPostalCodes);
router.post("/postal-codes", canManage, controller.addPostalCodes);
router.patch("/postal-codes/:code", canManage, controller.updatePostalCode);
router.post("/postal-codes/:code/scrape", canManage, controller.scrapePostalCode);
router.post("/postal-codes/:code/reset-location", canManage, controller.resetPostalCodeLocation);
router.delete("/postal-codes/:code", canManage, controller.deletePostalCode);

router.get("/jobs", controller.listJobs);
router.post("/jobs", canManage, controller.createJob);
router.get("/jobs/:id", controller.getJob);
router.post("/jobs/:id/cancel", canManage, controller.cancelJob);
router.post("/jobs/:id/pause", canManage, controller.pauseJob);
router.post("/jobs/:id/continue", canManage, controller.continueJob);
router.post("/jobs/:id/retry", canManage, controller.retryJob);

// Assign to an agent (creates the lead on the Leads page), admins and sales managers.
router.get("/agents", controller.listAgents);
router.post("/restaurants/assign", checkRole(["admin", "sales_manager"]), controller.assignRestaurants);
router.post("/restaurants/unassign", checkRole(["admin", "sales_manager"]), controller.unassignRestaurants);
// Agents' postal codes (User.assignedPostalCodes, shared with the old Postal Scraping page) and
// auto-assign: each agent gets N free stores located in their codes, as leads.
router.get("/agent-postal-codes", controller.listAgentPostalCodes);
router.put("/agent-postal-codes/:agentId", checkRole(["admin", "sales_manager"]), controller.setAgentPostalCodes);
router.post("/restaurants/auto-assign", checkRole(["admin", "sales_manager"]), controller.autoAssignRestaurants);

router.get("/restaurants", controller.listRestaurants);
router.get("/restaurants/filters", controller.getRestaurantFilters);
router.get("/restaurants/export", controller.exportRestaurants);
router.get("/restaurants/addresses", controller.listAddressGroups);
router.get("/restaurants/:uuid", controller.getRestaurant);

router.get("/changes", controller.listChanges);

module.exports = router;
