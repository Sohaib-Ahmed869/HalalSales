// controllers/task.controller.js
const Task = require("../models/Task");
const Lead = require("../models/Lead");
const User = require("../models/User");

/**
 * Get all tasks with filtering options
 */
exports.getTasks = async (req, res) => {
  try {
    const { status, priority, type, leadId, assignedTo, search } = req.query;
    const query = {};

    // Apply filters
    if (status) query.status = status;
    if (priority) query.priority = priority;
    if (type) query.type = type;
    if (leadId) query.leadId = leadId;

    // Role-based access control
    if (req.user.role === "sales_agent") {
      // Sales agents can only see tasks assigned to them
      query.assignedTo = req.user._id;
    } else if (req.user.role === "sales_manager") {
      // Sales managers can see their own tasks and tasks assigned to their team
      if (assignedTo) {
        query.assignedTo = assignedTo;
      } else {
        const salesAgents = await User.find({
          role: "sales_agent",
          manager: req.user._id,
        }).select("_id");

        const agentIds = salesAgents.map((agent) => agent._id);
        agentIds.push(req.user._id); // Include the manager's own tasks
        query.assignedTo = { $in: agentIds };
      }
    } else if (req.user.role === "admin") {
      // Admin can filter by assignedTo if provided
      if (assignedTo) query.assignedTo = assignedTo;
    }

    // Search
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
      ];
    }

    // Get tasks
    const tasks = await Task.find(query)
      .populate("assignedTo", "firstName lastName email role")
      .populate("createdBy", "firstName lastName email role")
      .populate("leadId", "fullName email company")
      .sort({ dueDate: 1, priority: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: tasks,
    });
  } catch (error) {
    console.error("Error fetching tasks:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching tasks",
      error: error.message,
    });
  }
};

/**
 * Get task by ID
 */
exports.getTaskById = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id)
      .populate("assignedTo", "firstName lastName email role")
      .populate("createdBy", "firstName lastName email role")
      .populate("leadId", "fullName email company")
      .lean();

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: task,
    });
  } catch (error) {
    console.error(`Error fetching task ${req.params.id}:`, error);
    return res.status(500).json({
      success: false,
      message: "Error fetching task",
      error: error.message,
    });
  }
};

/**
 * Create a new task
 */
exports.createTask = async (req, res) => {
  try {
    const { leadId, title, description, dueDate, priority, type } = req.body;

    // Validate required fields
    if (!title || !dueDate || !leadId) {
      return res.status(400).json({
        success: false,
        message: "Title, due date, and lead ID are required",
      });
    }

    // Check if lead exists
    const lead = await Lead.findById(leadId);
    if (!lead) {
      return res.status(404).json({
        success: false,
        message: "Lead not found",
      });
    }

    // Create new task
    const task = new Task({
      leadId,
      title,
      description,
      dueDate,
      priority: priority || "medium",
      type: type || "follow-up",
      status: "pending",
      assignedTo: req.body.assignedTo || req.user._id,
      createdBy: req.user._id,
    });

    await task.save();

    // Add task to lead's tasks array
    await Lead.findByIdAndUpdate(leadId, {
      $push: { tasks: task._id },
      $set: { nextFollowUp: dueDate },
    });

    // Return the created task with populated fields
    const createdTask = await Task.findById(task._id)
      .populate("assignedTo", "firstName lastName email role")
      .populate("createdBy", "firstName lastName email role")
      .populate("leadId", "fullName email company");

    return res.status(201).json({
      success: true,
      message: "Task created successfully",
      data: createdTask,
    });
  } catch (error) {
    console.error("Error creating task:", error);
    return res.status(500).json({
      success: false,
      message: "Error creating task",
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
    const task = await Task.findById(id);

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    // Check permissions - creator can update most fields
    const isCreator = task.createdBy.toString() === req.user._id.toString();
    const isAssignee = task.assignedTo.toString() === req.user._id.toString();

    if (!isCreator && !isAssignee && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to update this task",
      });
    }

    // Assignee can only update status to "pending_approval" and add comments
    if (isAssignee && !isCreator && req.user.role !== "admin") {
      const allowedFields = ["status", "comments"];
      const requestedFields = Object.keys(updateFields);

      const hasDisallowedField = requestedFields.some(
        (field) => !allowedFields.includes(field)
      );

      if (hasDisallowedField) {
        return res.status(403).json({
          success: false,
          message: "You can only request approval or add comments to this task",
        });
      }

      // Assignee can only set status to pending_approval
      if (updateFields.status && updateFields.status !== "pending_approval") {
        return res.status(403).json({
          success: false,
          message: "You can only set the status to pending_approval",
        });
      }
    }

    // Update task
    const updatedTask = await Task.findByIdAndUpdate(
      id,
      { $set: updateFields },
      { new: true, runValidators: true }
    )
      .populate("assignedTo", "firstName lastName email role")
      .populate("createdBy", "firstName lastName email role")
      .populate("leadId", "fullName email company");

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
 * Approve or reject a task
 */
exports.approveOrRejectTask = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, comments } = req.body;

    if (!action || !["approve", "reject"].includes(action)) {
      return res.status(400).json({
        success: false,
        message: "Valid action (approve or reject) is required",
      });
    }

    // Find task
    const task = await Task.findById(id);

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    // Check that task is in pending_approval status
    if (task.status !== "pending_approval") {
      return res.status(400).json({
        success: false,
        message:
          "Only tasks in pending_approval status can be approved or rejected",
      });
    }

    // Check permissions - only creator or admin can approve/reject
    const isCreator = task.createdBy.toString() === req.user._id.toString();

    if (!isCreator && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message:
          "Only the task creator or admin can approve or reject this task",
      });
    }

    // Update task status based on action
    const newStatus = action === "approve" ? "completed" : "rejected";
    const newComments = comments
      ? `${task.comments ? task.comments + "\n\n" : ""}${req.user.firstName} ${
          req.user.lastName
        } (${action}): ${comments}`
      : task.comments;

    // Set completion date if approved
    const updateFields = {
      status: newStatus,
      comments: newComments,
    };

    if (action === "approve") {
      updateFields.completedDate = new Date();
    }

    // Update task
    const updatedTask = await Task.findByIdAndUpdate(
      id,
      { $set: updateFields },
      { new: true, runValidators: true }
    )
      .populate("assignedTo", "firstName lastName email role")
      .populate("createdBy", "firstName lastName email role")
      .populate("leadId", "fullName email company");

    res.json({
      success: true,
      message: `Task ${
        action === "approve" ? "approved" : "rejected"
      } successfully`,
      data: updatedTask,
    });
  } catch (error) {
    console.error(`Error approving/rejecting task ${req.params.id}:`, error);
    res.status(500).json({
      success: false,
      message: "Error processing task approval",
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

    // Check permissions - only creator, assignee with admin role, or admin can delete
    const isCreator = task.createdBy.toString() === req.user._id.toString();

    if (!isCreator && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to delete this task",
      });
    }

    // Remove task from lead's tasks array
    await Lead.findByIdAndUpdate(task.leadId, {
      $pull: { tasks: task._id },
    });

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

exports.getAgentTasks = async (req, res) => {
  try {
    const { agentId } = req.params;
    const { status, priority, type } = req.query;
    const query = { assignedTo: agentId };

    // Apply filters
    if (status) query.status = status;
    if (priority) query.priority = priority;
    if (type) query.type = type;

    // Get tasks
    const tasks = await Task.find(query)
      .populate("leadId", "fullName email company")
      .populate("createdBy", "firstName lastName email role")
      .sort({ dueDate: 1, priority: -1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: tasks,
    });
  } catch (error) {
    console.error("Error fetching agent tasks:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching agent tasks",
      error: error.message,
    });
  }
}


/**
 * Get assigned tasks for the current user
 */
exports.getMyTasks = async (req, res) => {
  try {
    const { status, priority, type } = req.query;
    const query = { assignedTo: req.user._id };

    // Apply filters
    if (status) query.status = status;
    if (priority) query.priority = priority;
    if (type) query.type = type;

    // Get tasks
    const tasks = await Task.find(query)
      .populate("leadId", "fullName email company")
      .populate("createdBy", "firstName lastName email role")
      .sort({ dueDate: 1, priority: -1 })
      .lean();

    // Get task counts by status for statistics
    const statusCounts = await Task.aggregate([
      { $match: { assignedTo: req.user._id } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    // Format status counts
    const counts = {
      total: tasks.length,
      pending: 0,
      pending_approval: 0,
      completed: 0,
      rejected: 0,
    };

    statusCounts.forEach((item) => {
      counts[item._id] = item.count;
    });

    return res.status(200).json({
      success: true,
      data: tasks,
      counts,
    });
  } catch (error) {
    console.error("Error fetching assigned tasks:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching assigned tasks",
      error: error.message,
    });
  }
};

/**
 * Get tasks created by the current user
 */
exports.getCreatedTasks = async (req, res) => {
  try {
    const { status, priority, type, assignedTo } = req.query;
    const query = { createdBy: req.user._id };

    // Apply filters
    if (status) query.status = status;
    if (priority) query.priority = priority;
    if (type) query.type = type;
    if (assignedTo) query.assignedTo = assignedTo;

    // Get tasks
    const tasks = await Task.find(query)
      .populate("assignedTo", "firstName lastName email role")
      .populate("leadId", "fullName email company")
      .sort({ dueDate: 1, priority: -1 })
      .lean();

    // Get task counts by status for statistics
    const statusCounts = await Task.aggregate([
      { $match: { createdBy: req.user._id } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    // Format status counts
    const counts = {
      total: tasks.length,
      pending: 0,
      pending_approval: 0,
      completed: 0,
      rejected: 0,
    };

    statusCounts.forEach((item) => {
      counts[item._id] = item.count;
    });

    return res.status(200).json({
      success: true,
      data: tasks,
      counts,
    });
  } catch (error) {
    console.error("Error fetching created tasks:", error);
    return res.status(500).json({
      success: false,
      message: "Error fetching created tasks",
      error: error.message,
    });
  }
};

/**
 * Request task approval
 */
exports.requestApproval = async (req, res) => {
  try {
    const { id } = req.params;
    const { comments } = req.body;

    // Find task
    const task = await Task.findById(id);

    if (!task) {
      return res.status(404).json({
        success: false,
        message: "Task not found",
      });
    }

    // Check that task is in pending status
    if (task.status !== "pending") {
      return res.status(400).json({
        success: false,
        message: "Only pending tasks can be submitted for approval",
      });
    }

    // Check permissions - only assignee can request approval
    const isAssignee = task.assignedTo.toString() === req.user._id.toString();

    if (!isAssignee) {
      return res.status(403).json({
        success: false,
        message: "Only the assigned user can request approval for this task",
      });
    }

    // Update task status and add comments
    const newComments = comments
      ? `${task.comments ? task.comments + "\n\n" : ""}${req.user.firstName} ${
          req.user.lastName
        } (requested approval): ${comments}`
      : task.comments;

    // Update task
    const updatedTask = await Task.findByIdAndUpdate(
      id,
      {
        $set: {
          status: "pending_approval",
          comments: newComments,
        },
      },
      { new: true, runValidators: true }
    )
      .populate("assignedTo", "firstName lastName email role")
      .populate("createdBy", "firstName lastName email role")
      .populate("leadId", "fullName email company");

    res.json({
      success: true,
      message: "Task submitted for approval",
      data: updatedTask,
    });
  } catch (error) {
    console.error(
      `Error requesting approval for task ${req.params.id}:`,
      error
    );
    res.status(500).json({
      success: false,
      message: "Error requesting task approval",
      error: error.message,
    });
  }
};
