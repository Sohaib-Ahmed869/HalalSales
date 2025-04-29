// routes/task.routes.js
const express = require("express");
const router = express.Router();
const { auth } = require("../middleware/auth");
const taskController = require("../controllers/task.controller");

// Get all tasks for the current agent
router.get("/agent", auth, taskController.getAgentTasks);

// Get task statistics for the current agent
router.get("/statistics", auth, taskController.getTaskStatistics);

// Get overdue tasks for the current agent
router.get("/overdue", auth, taskController.getOverdueTasks);

// Get tasks due today for the current agent
router.get("/today", auth, taskController.getTodaysTasks);

// Create a standalone task
router.post("/", auth, taskController.createTask);

// Get all tasks for a lead
router.get("/lead/:leadId", auth, taskController.getLeadTasks);

// Add a task to a lead
router.post("/lead/:leadId", auth, taskController.addTask);

// Update a task
router.put("/:id", auth, taskController.updateTask);

// Complete a task
router.post("/:id/complete", auth, taskController.completeTask);

// Delete a task
router.delete("/:id", auth, taskController.deleteTask);

module.exports = router;
