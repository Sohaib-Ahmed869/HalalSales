// routes/task.routes.js
const express = require("express");
const router = express.Router();
const { auth, checkRole } = require("../middleware/auth");
const taskController = require("../controllers/task.controller");

// Get all tasks (filtered by role permissions)
router.get("/", auth, taskController.getTasks);

router.get("/agent/:agentId", auth, taskController.getAgentTasks);

// Get tasks assigned to current user
router.get("/assigned", auth, taskController.getMyTasks);

// Get tasks created by current user
router.get("/created", auth, taskController.getCreatedTasks);

// Get task by ID
router.get("/:id", auth, taskController.getTaskById);

// Create a new task
router.post("/", auth, taskController.createTask);

// Update a task
router.put("/:id", auth, taskController.updateTask);

// Request approval for a task
router.post("/:id/request-approval", auth, taskController.requestApproval);

// Approve or reject a task
router.post("/:id/approve-reject", auth, taskController.approveOrRejectTask);

// Delete a task
router.delete("/:id", auth, taskController.deleteTask);

module.exports = router;
