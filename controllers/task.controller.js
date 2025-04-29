// controllers/task.controller.js
const Task = require("../models/Task");
const Lead = require("../models/Lead");
const User = require("../models/User");

/**
 * Get all tasks for a lead
 */
exports.getLeadTasks = async (req, res) => {
  try {
    const { leadId } = req.params;
    const { status } = req.query;

    // Find lead
    const lead = await Lead.findById(leadId);

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    // Check permissions
    if (
      req.user.role === "sales_agent" &&
      lead.assignedTo.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to view tasks for this lead",
      });
    }

    // Build query
    const query = {
      leadId: lead._id,
    };

    // Filter by status if provided
    if (status) {
      query.status = status;
    }

    // Get tasks
    const tasks = await Task.find(query)
      .populate("assignedTo", "firstName lastName email")
      .sort({ dueDate: 1 });

    res.status(200).json({
      success: true,
      data: tasks,
    });
  } catch (error) {
    console.error(`Error fetching tasks for lead ${req.params.leadId}:`, error);
    res.status(500).json({
      success: false,
      message: "Error fetching tasks",
      error: error.message,
    });
  }
};

/**
 * Add a task to a lead
 */
exports.addTask = async (req, res) => {
  try {
    const { leadId } = req.params;
    const { title, description, type, priority, dueDate } = req.body;

    // Validate required fields
    if (!title || !dueDate) {
      return res.status(400).json({
        success: false,
        message: "Title and due date are required",
      });
    }

    // Find lead
    const lead = await Lead.findById(leadId);

    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    // Check permissions
    if (
      req.user.role === "sales_agent" &&
      lead.assignedTo.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to add tasks for this lead",
      });
    }

    // Create the task
    const task = new Task({
      title,
      description,
      type: type || "follow-up",
      priority: priority || "medium",
      dueDate: new Date(dueDate),
      assignedTo: lead.assignedTo,
      leadId: lead._id,
    });

    await task.save();

    // Add the task to the lead's tasks
    lead.tasks.push(task._id);

    // Update nextFollowUp if the new task is due before the current nextFollowUp
    // or if nextFollowUp is not set
    if (!lead.nextFollowUp || new Date(dueDate) < new Date(lead.nextFollowUp)) {
      lead.nextFollowUp = new Date(dueDate);
    }

    await lead.save();

    // Return the task with populated fields
    const createdTask = await Task.findById(task._id).populate(
      "assignedTo",
      "firstName lastName email"
    );

    res.status(201).json({
      success: true,
      message: "Task added successfully",
      data: createdTask,
    });
  } catch (error) {
    console.error(`Error adding task for lead ${req.params.leadId}:`, error);
    res.status(500).json({
      success: false,
      message: "Error adding task",
      error: error.message,
    });
  }
};

/**
 * Update a task
 */
exports.updateTask = async (req, res) => {
  try {
    const { id } = req.params;
    const updateFields = { ...req.body };

    // Find task
    const task = await Task.findById(id).populate("leadId");

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    // Check permissions - only assigned agent, their manager, or admin can update
    if (
      req.user.role === "sales_agent" &&
      task.assignedTo.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to update this task",
      });
    } else if (req.user.role === "sales_manager") {
      const isOwnTask = task.assignedTo.toString() === req.user._id.toString();

      if (!isOwnTask) {
        const agent = await User.findById(task.assignedTo);
        const isTeamMember =
          agent &&
          agent.manager &&
          agent.manager.toString() === req.user._id.toString();

        if (!isTeamMember) {
          return res.status(403).json({
            success: false,
            message: "You do not have permission to update this task",
          });
        }
      }
    }

    // Handle status change
    if (updateFields.status === "completed" && task.status !== "completed") {
      updateFields.completedDate = Date.now();
    }

    // Update task
    const updatedTask = await Task.findByIdAndUpdate(
      id,
      { $set: updateFields },
      { new: true, runValidators: true }
    )
      .populate("assignedTo", "firstName lastName email")
      .populate("leadId", "fullName email");

    // If dueDate is updated and this is the lead's next follow-up, update lead's nextFollowUp
    if (updateFields.dueDate && task.leadId) {
      const lead = await Lead.findById(task.leadId);

      // If this was the next follow-up task for the lead
      if (
        lead.nextFollowUp &&
        new Date(lead.nextFollowUp).getTime() ===
          new Date(task.dueDate).getTime()
      ) {
        // Find next earliest pending task
        const nextEarliestTask = await Task.findOne({
          leadId: lead._id,
          _id: { $ne: task._id }, // Exclude current task
          status: "pending",
          dueDate: { $gte: new Date() },
        }).sort({ dueDate: 1 });

        if (nextEarliestTask) {
          lead.nextFollowUp = nextEarliestTask.dueDate;
        } else {
          // No other pending tasks
          lead.nextFollowUp = null;
        }

        await lead.save();
      }
    }

    res.json({
      success: true,
      message: "Task updated successfully",
      data: updatedTask,
    });
  } catch (error) {
    console.error(`Error updating task ${req.params.id}:`, error);
    res.status(500).json({
      success: false,
      message: "Error updating task",
      error: error.message,
    });
  }
};

/**
 * Complete a task
 */
exports.completeTask = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    // Find task
    const task = await Task.findById(id);

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    // Check permissions
    if (
      req.user.role === "sales_agent" &&
      task.assignedTo.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to complete this task",
      });
    }

    // Complete the task
    task.status = "completed";
    task.completedDate = Date.now();

    if (notes) {
      task.description = task.description
        ? `${task.description}\n\nCompletion Notes: ${notes}`
        : `Completion Notes: ${notes}`;
    }

    await task.save();

    // If this was the lead's next follow-up task, update nextFollowUp
    const lead = await Lead.findById(task.leadId);

    if (
      lead &&
      lead.nextFollowUp &&
      new Date(lead.nextFollowUp).getTime() === new Date(task.dueDate).getTime()
    ) {
      // Find next earliest pending task
      const nextEarliestTask = await Task.findOne({
        leadId: lead._id,
        _id: { $ne: task._id }, // Exclude current task
        status: "pending",
      }).sort({ dueDate: 1 });

      if (nextEarliestTask) {
        lead.nextFollowUp = nextEarliestTask.dueDate;
      } else {
        // No other pending tasks
        lead.nextFollowUp = null;
      }

      await lead.save();
    }

    // Return completed task
    const completedTask = await Task.findById(id).populate(
      "assignedTo",
      "firstName lastName email"
    );

    res.json({
      success: true,
      message: "Task completed successfully",
      data: completedTask,
    });
  } catch (error) {
    console.error(`Error completing task ${req.params.id}:`, error);
    res.status(500).json({
      success: false,
      message: "Error completing task",
      error: error.message,
    });
  }
};

/**
 * Delete a task
 */
exports.deleteTask = async (req, res) => {
  try {
    const { id } = req.params;

    // Find task
    const task = await Task.findById(id);

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    // Check permissions
    if (req.user.role === "sales_agent") {
      // Sales agents can only delete their own tasks
      if (task.assignedTo.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "You do not have permission to delete this task",
        });
      }
    } else if (req.user.role === "sales_manager") {
      // Managers can delete their own tasks or tasks assigned to their team
      const isOwnTask = task.assignedTo.toString() === req.user._id.toString();

      if (!isOwnTask) {
        const agent = await User.findById(task.assignedTo);
        const isTeamMember =
          agent &&
          agent.manager &&
          agent.manager.toString() === req.user._id.toString();

        if (!isTeamMember) {
          return res.status(403).json({
            success: false,
            message: "You do not have permission to delete this task",
          });
        }
      }
    }

    // Remove task from lead's tasks array
    await Lead.updateOne({ _id: task.leadId }, { $pull: { tasks: task._id } });

    // If this was the lead's next follow-up task, update nextFollowUp
    const lead = await Lead.findById(task.leadId);

    if (
      lead &&
      lead.nextFollowUp &&
      new Date(lead.nextFollowUp).getTime() === new Date(task.dueDate).getTime()
    ) {
      // Find next earliest pending task
      const nextEarliestTask = await Task.findOne({
        leadId: lead._id,
        _id: { $ne: task._id }, // Exclude current task
        status: "pending",
      }).sort({ dueDate: 1 });

      if (nextEarliestTask) {
        lead.nextFollowUp = nextEarliestTask.dueDate;
      } else {
        // No other pending tasks
        lead.nextFollowUp = null;
      }

      await lead.save();
    }

    // Delete the task
    await Task.findByIdAndDelete(id);

    res.json({
      success: true,
      message: "Task deleted successfully",
    });
  } catch (error) {
    console.error(`Error deleting task ${req.params.id}:`, error);
    res.status(500).json({
      success: false,
      message: "Error deleting task",
      error: error.message,
    });
  }
};

// Add these methods to your task.controller.js file

/**
 * Get all tasks for the current agent
 */
exports.getAgentTasks = async (req, res) => {
  try {
    const agentId = req.user._id;
    const { status, startDate, endDate, type } = req.query;

    // Build query
    const query = {
      assignedTo: agentId,
    };

    // Filter by status if provided
    if (status) {
      query.status = status;
    }

    // Filter by type if provided
    if (type) {
      query.type = type;
    }

    // Filter by date range if provided
    if (startDate && endDate) {
      query.dueDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    } else if (startDate) {
      query.dueDate = { $gte: new Date(startDate) };
    } else if (endDate) {
      query.dueDate = { $lte: new Date(endDate) };
    }

    // Get tasks
    const tasks = await Task.find(query)
      .populate("leadId", "fullName email phoneNumber company status tags")
      .sort({ dueDate: 1 });

    res.status(200).json({
      success: true,
      data: tasks,
    });
  } catch (error) {
    console.error(`Error fetching tasks for agent ${req.user._id}:`, error);
    res.status(500).json({
      success: false,
      message: "Error fetching tasks",
      error: error.message,
    });
  }
};

/**
 * Create a standalone task (not tied to a specific lead)
 */
exports.createTask = async (req, res) => {
  try {
    const { title, description, type, priority, dueDate, leadId } = req.body;

    // Validate required fields
    if (!title || !dueDate) {
      return res.status(400).json({
        success: false,
        message: "Title and due date are required",
      });
    }

    // Create task data
    const taskData = {
      title,
      description,
      type: type || "follow-up",
      priority: priority || "medium",
      dueDate: new Date(dueDate),
      assignedTo: req.user._id,
      status: "pending",
    };

    // If leadId is provided, validate and link to lead
    if (leadId) {
      const lead = await Lead.findById(leadId);

      if (!lead) {
        return res.status(404).json({
          success: false,
          message: "Lead not found",
        });
      }

      // Check if agent is assigned to this lead
      if (
        req.user.role === "sales_agent" &&
        lead.assignedTo.toString() !== req.user._id.toString()
      ) {
        return res.status(403).json({
          success: false,
          message: "You are not assigned to this lead",
        });
      }

      taskData.leadId = lead._id;

      // Add task to lead's tasks
      lead.tasks.push(taskData._id);

      // Update nextFollowUp if needed
      if (
        !lead.nextFollowUp ||
        new Date(dueDate) < new Date(lead.nextFollowUp)
      ) {
        lead.nextFollowUp = new Date(dueDate);
      }

      await lead.save();
    }

    // Create and save the task
    const task = new Task(taskData);
    await task.save();

    // Return created task
    const createdTask = await Task.findById(task._id)
      .populate("assignedTo", "firstName lastName email")
      .populate("leadId", "fullName email phoneNumber company status");

    res.status(201).json({
      success: true,
      message: "Task created successfully",
      data: createdTask,
    });
  } catch (error) {
    console.error(`Error creating task:`, error);
    res.status(500).json({
      success: false,
      message: "Error creating task",
      error: error.message,
    });
  }
};

/**
 * Get task statistics for the current agent
 */
exports.getTaskStatistics = async (req, res) => {
  try {
    const agentId = req.user._id;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const oneWeekLater = new Date(today);
    oneWeekLater.setDate(oneWeekLater.getDate() + 7);

    // Build aggregation for task counts
    const stats = await Task.aggregate([
      { $match: { assignedTo: agentId } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          completed: {
            $sum: {
              $cond: [{ $eq: ["$status", "completed"] }, 1, 0],
            },
          },
          pending: {
            $sum: {
              $cond: [{ $eq: ["$status", "pending"] }, 1, 0],
            },
          },
          overdue: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$status", "pending"] },
                    { $lt: ["$dueDate", today] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          dueToday: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$status", "pending"] },
                    { $gte: ["$dueDate", today] },
                    { $lt: ["$dueDate", tomorrow] },
                  ],
                },
                1,
                0,
              ],
            },
          },
          dueThisWeek: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$status", "pending"] },
                    { $gte: ["$dueDate", today] },
                    { $lt: ["$dueDate", oneWeekLater] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);

    // Get tasks by priority
    const priorityStats = await Task.aggregate([
      {
        $match: {
          assignedTo: agentId,
          status: "pending",
        },
      },
      {
        $group: {
          _id: "$priority",
          count: { $sum: 1 },
        },
      },
    ]);

    // Format priority stats
    const priorityCounts = {
      high: 0,
      medium: 0,
      low: 0,
    };

    priorityStats.forEach((item) => {
      priorityCounts[item._id] = item.count;
    });

    // Final statistics
    const statistics = {
      total: stats.length > 0 ? stats[0].total : 0,
      completed: stats.length > 0 ? stats[0].completed : 0,
      pending: stats.length > 0 ? stats[0].pending : 0,
      overdue: stats.length > 0 ? stats[0].overdue : 0,
      dueToday: stats.length > 0 ? stats[0].dueToday : 0,
      dueThisWeek: stats.length > 0 ? stats[0].dueThisWeek : 0,
      priority: priorityCounts,
    };

    res.status(200).json({
      success: true,
      data: statistics,
    });
  } catch (error) {
    console.error(`Error fetching task statistics:`, error);
    res.status(500).json({
      success: false,
      message: "Error fetching task statistics",
      error: error.message,
    });
  }
};

/**
 * Get all overdue tasks for the current agent
 */
exports.getOverdueTasks = async (req, res) => {
  try {
    const agentId = req.user._id;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Build query
    const query = {
      assignedTo: agentId,
      status: "pending",
      dueDate: { $lt: today },
    };

    // Get tasks
    const tasks = await Task.find(query)
      .populate("leadId", "fullName email phoneNumber company status tags")
      .sort({ dueDate: 1 });

    res.status(200).json({
      success: true,
      data: tasks,
    });
  } catch (error) {
    console.error(`Error fetching overdue tasks:`, error);
    res.status(500).json({
      success: false,
      message: "Error fetching overdue tasks",
      error: error.message,
    });
  }
};

/**
 * Get all tasks due today for the current agent
 */
exports.getTodaysTasks = async (req, res) => {
  try {
    const agentId = req.user._id;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Build query
    const query = {
      assignedTo: agentId,
      status: "pending",
      dueDate: {
        $gte: today,
        $lt: tomorrow,
      },
    };

    // Get tasks
    const tasks = await Task.find(query)
      .populate("leadId", "fullName email phoneNumber company status tags")
      .sort({ dueDate: 1 });

    res.status(200).json({
      success: true,
      data: tasks,
    });
  } catch (error) {
    console.error(`Error fetching today's tasks:`, error);
    res.status(500).json({
      success: false,
      message: "Error fetching today's tasks",
      error: error.message,
    });
  }
};
