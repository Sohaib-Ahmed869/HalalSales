// controllers/task.controller.js
const Task = require("../models/Task");
const Lead = require("../models/Lead");
const User = require("../models/User");
const Quotation = require("../models/Quotation");
const {
  uploadToS3,
  generateSignedUrl,
  deleteFileFromS3,
  bucketName,
} = require("../utils/s3Upload");
const upload = uploadToS3.single("attachment");
const util = require("util");
const uploadAsync = util.promisify(upload);

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
    // Process file upload if present
    let attachment = null;

    if (req.file) {
      attachment = {
        fileName: req.file.originalname,
        fileSize: req.file.size,
        fileType: req.file.mimetype,
        s3Key: req.file.key,
        s3Url: req.file.location,
        uploadedAt: new Date(),
      };
    }

    const { leadId, title, description, dueDate, priority, type } = req.body;

    console.log("Creating task with data:", req.body);

    // Validate required fields
    if (!title || !dueDate) {
      return res.status(400).json({
        success: false,
        message: "Title and due date are required",
      });
    }

    // Only check if lead exists if leadId is provided
    if (leadId) {
      // Check if lead exists
      const lead = await Lead.findById(leadId);
      if (!lead) {
        return res.status(404).json({
          success: false,
          message: "Lead not found",
        });
      }
    }

    // Create new task
    const task = new Task({
      leadId: leadId ? leadId : null,
      title,
      description,
      dueDate,
      priority: priority || "medium",
      type: type || "follow-up",
      status: "pending",
      assignedTo: req.body.assignedTo || req.user._id,
      createdBy: req.user._id,
      attachment: attachment, // Add the attachment if it exists
    });

    await task.save();

    // Add task to lead's tasks array if leadId is provided
    if (leadId) {
      await Lead.findByIdAndUpdate(leadId, {
        $push: { tasks: task._id },
        $set: { nextFollowUp: dueDate },
      });
    }

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

    // Check permissions - different role-based access control
    const isCreator = task.createdBy.toString() === req.user._id.toString();
    const isAssignee = task.assignedTo.toString() === req.user._id.toString();
    const isAdmin = req.user.role === "admin";
    const isManager = req.user.role === "sales_manager";

    // Admins and managers have full edit access
    if (isAdmin || isManager) {
      // Allow all updates from admins/managers

      // If task is being reassigned, add a note to the comments
      if (
        updateFields.assignedTo &&
        updateFields.assignedTo !== task.assignedTo.toString()
      ) {
        const assignedToUser = await User.findById(updateFields.assignedTo);
        const assigneeNote = `${req.user.firstName} ${req.user.lastName} reassigned this task to ${assignedToUser.firstName} ${assignedToUser.lastName}.`;
        updateFields.comments = task.comments
          ? `${task.comments}\n\n${assigneeNote}`
          : assigneeNote;
      }

      // If dueDate is being changed, add a note to the comments
      if (
        updateFields.dueDate &&
        updateFields.dueDate !== task.dueDate.toISOString().split("T")[0]
      ) {
        const dateNote = `${req.user.firstName} ${
          req.user.lastName
        } changed the due date from ${
          task.dueDate.toISOString().split("T")[0]
        } to ${updateFields.dueDate}.`;
        updateFields.comments = updateFields.comments
          ? `${updateFields.comments}\n\n${dateNote}`
          : task.comments
          ? `${task.comments}\n\n${dateNote}`
          : dateNote;
      }
    }
    // Creator can update most fields
    else if (isCreator) {
      // Creators can update basic fields but not status if pending_approval
      if (task.status === "pending_approval" && updateFields.status) {
        return res.status(403).json({
          success: false,
          message: "Cannot update status of task pending approval",
        });
      }
    }
    // Assignee can only update status to "pending_approval" and add comments
    else if (isAssignee) {
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
    // None of the above roles - no permission
    else {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to update this task",
      });
    }

    // Add activity log entry for the update
    if (!updateFields.activityLog) {
      updateFields.activityLog = task.activityLog || [];
    }

    // Capture what changed in the activity
    const changes = [];
    if (
      updateFields.assignedTo &&
      updateFields.assignedTo !== task.assignedTo.toString()
    ) {
      changes.push("reassigned");
    }
    if (
      updateFields.dueDate &&
      updateFields.dueDate !== task.dueDate.toISOString().split("T")[0]
    ) {
      changes.push("due date changed");
    }
    if (updateFields.priority && updateFields.priority !== task.priority) {
      changes.push("priority changed");
    }

    const activityDescription = changes.length
      ? `Updated task: ${changes.join(", ")}`
      : "Updated task";

    updateFields.activityLog.push({
      user: req.user._id,
      type: "update",
      description: activityDescription,
      timestamp: new Date(),
    });

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
};

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

// Upload task attachment
exports.uploadAttachment = async (req, res) => {
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
    const isCreator = task.createdBy.toString() === req.user._id.toString();
    const isAssignee = task.assignedTo.toString() === req.user._id.toString();

    if (!isCreator && !isAssignee && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "You do not have permission to add attachments to this task",
      });
    }

    // Handle file upload
    await uploadAsync(req, res);

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "No file uploaded",
      });
    }

    // Update task with attachment details
    const attachment = {
      fileName: req.file.originalname,
      fileSize: req.file.size,
      fileType: req.file.mimetype,
      s3Key: req.file.key,
      s3Url: req.file.location, // S3 URL from multer-s3
      uploadedAt: new Date(),
    };

    const updatedTask = await Task.findByIdAndUpdate(
      id,
      { $set: { attachment } },
      { new: true, runValidators: true }
    )
      .populate("assignedTo", "firstName lastName email role")
      .populate("createdBy", "firstName lastName email role")
      .populate("leadId", "fullName email company");

    return res.status(200).json({
      success: true,
      message: "Attachment uploaded successfully",
      data: updatedTask,
    });
  } catch (error) {
    console.error(
      `Error uploading attachment for task ${req.params.id}:`,
      error
    );
    return res.status(500).json({
      success: false,
      message: error.message || "Error uploading attachment",
      error: error.message,
    });
  }
};

// Get a pre-signed URL for downloading an attachment
exports.getAttachmentUrl = async (req, res) => {
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

    if (!task.attachment || !task.attachment.s3Key) {
      return res.status(404).json({
        success: false,
        message: "No attachment found for this task",
      });
    }

    // Instead of generating a signed URL, return the direct S3 URL
    return res.status(200).json({
      success: true,
      data: {
        fileName: task.attachment.fileName,
        fileType: task.attachment.fileType,
        url: task.attachment.s3Url, // Use the stored S3 URL directly
      },
    });
  } catch (error) {
    console.error(
      `Error getting attachment URL for task ${req.params.id}:`,
      error
    );
    return res.status(500).json({
      success: false,
      message: "Error getting attachment URL",
      error: error.message,
    });
  }
};
// Delete task attachment
exports.deleteAttachment = async (req, res) => {
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

    if (!task.attachment || !task.attachment.s3Key) {
      return res.status(404).json({
        success: false,
        message: "No attachment found for this task",
      });
    }

    // Check permissions
    const isCreator = task.createdBy.toString() === req.user._id.toString();
    const isAdmin = req.user.role === "admin";

    if (!isCreator && !isAdmin) {
      return res.status(403).json({
        success: false,
        message: "Only the creator or an admin can delete attachments",
      });
    }

    // Delete from S3
    await deleteFileFromS3(task.attachment.s3Key);

    // Update task to remove attachment
    const updatedTask = await Task.findByIdAndUpdate(
      id,
      { $unset: { attachment: "" } },
      { new: true, runValidators: true }
    )
      .populate("assignedTo", "firstName lastName email role")
      .populate("createdBy", "firstName lastName email role")
      .populate("leadId", "fullName email company");

    return res.status(200).json({
      success: true,
      message: "Attachment deleted successfully",
      data: updatedTask,
    });
  } catch (error) {
    console.error(
      `Error deleting attachment for task ${req.params.id}:`,
      error
    );
    return res.status(500).json({
      success: false,
      message: "Error deleting attachment",
      error: error.message,
    });
  }
};

exports.approveQuotation = async (req, res) => {
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

    // Check that this is a quotation approval task
    if (!task.relatedQuotation) {
      return res.status(400).json({
        success: false,
        message: "This is not a quotation approval task",
      });
    }

    // Check permissions - only admin can approve/reject
    if (req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "Only admins can approve or reject quotations",
      });
    }

    // Find the related quotation
    const quotation = await Quotation.findOne({
      DocEntry: task.relatedQuotation,
    });

    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: "Related quotation not found",
      });
    }

    // Update task status and add comments
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
      .populate("createdBy", "firstName lastName email role");

    // Update quotation approval status
    quotation.approvalStatus = action === "approve" ? "approved" : "rejected";
    await quotation.save();

    res.json({
      success: true,
      message: `Quotation ${
        action === "approve" ? "approved" : "rejected"
      } successfully`,
      data: updatedTask,
      quotation: {
        DocEntry: quotation.DocEntry,
        approvalStatus: quotation.approvalStatus,
      },
    });
  } catch (error) {
    console.error(
      `Error approving/rejecting quotation task ${req.params.id}:`,
      error
    );
    res.status(500).json({
      success: false,
      message: "Error processing quotation approval",
      error: error.message,
    });
  }
};
