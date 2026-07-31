// utils/notificationService.js
const Notification = require("../models/Notification");

class NotificationService {
  static async createNotification({
    recipient,
    sender,
    type,
    title,
    message,
    relatedTask = null,
    relatedLead = null,
    relatedRFQ = null,
    allowSelfNotify = false,
  }) {
    try {
      // Don't create notification if sender and recipient are the same — UNLESS this is a
      // system-triggered notification (e.g., AI agent flagging an RFQ for admin review) where
      // the admin receives the notification even though they're recorded as the nominal sender.
      if (
        !allowSelfNotify &&
        sender && recipient && sender.toString() === recipient.toString()
      ) {
        return null;
      }

      const notification = new Notification({
        recipient,
        sender,
        type,
        title,
        message,
        relatedTask,
        relatedLead,
        relatedRFQ,
      });

      await notification.save();
      await this.pushUnreadCount(recipient);
      return notification;
    } catch (error) {
      console.error("Error creating notification:", error);
      throw error;
    }
  }

  /**
   * Push a recipient's current unread count over the socket. This is what lets
   * the frontend badge drop its 30s poll — delivery is best-effort, and the
   * client keeps a slow fallback poll for reconnects.
   */
  static async pushUnreadCount(userId) {
    if (!userId) return;
    try {
      const { emitUnreadCount } = require("../socket");
      const count = await this.getUnreadCount(userId);
      emitUnreadCount(userId, count);
    } catch (error) {
      console.warn("[NotificationService] pushUnreadCount failed:", error.message);
    }
  }

  /**
   * Notify all admins when an RFQ needs human attention (AI recommended acceptance,
   * negotiation stalled, or similar). The AI bot is the sender — use a system sender ID.
   */
  static async notifyAdminsAboutRFQ({ rfq, vendor, type, title, message, systemSenderId }) {
    try {
      const User = require("../models/User");
      const admins = await User.find({
        role: { $in: ["admin", "sales_manager"] },
      }).select("_id").lean();

      if (!admins.length) {
        console.warn("[NotificationService] notifyAdminsAboutRFQ: no admins / sales_managers to notify");
        return [];
      }

      const notifications = await Promise.all(
        admins.map(admin =>
          this.createNotification({
            recipient: admin._id,
            sender: systemSenderId || admin._id, // fall back to self so it still saves when no system user exists
            type,
            title,
            message,
            relatedRFQ: rfq._id,
            allowSelfNotify: true, // bypass the self-notify guard — this is a system-triggered alert, not a user-to-user ping
          })
        )
      );
      const saved = notifications.filter(Boolean);
      console.log(`[NotificationService] notifyAdminsAboutRFQ: created ${saved.length}/${admins.length} notifications (type=${type}, rfq=${rfq.rfqNumber})`);

      // Flagging an RFQ for review is what raises the sidebar attention badge —
      // push the new count instead of making every admin poll for it.
      const { pushPendingAttentionCount } = require("./rfqAttention");
      await pushPendingAttentionCount();

      return saved;
    } catch (error) {
      console.error("Error notifying admins about RFQ:", error);
    }
  }

  static async createTaskAssignedNotification(task, assignedBy) {
    const title = "New Task Assigned";
    const message = `You have been assigned a new task: "${task.title}"`;

    return this.createNotification({
      recipient: task.assignedTo,
      sender: assignedBy,
      type: "task_assigned",
      title,
      message,
      relatedTask: task._id,
      relatedLead: task.leadId,
    });
  }

  static async createTaskUpdatedNotification(
    task,
    updatedBy,
    previousAssignee = null
  ) {
    // If task was reassigned, notify both old and new assignee
    const notifications = [];

    if (
      previousAssignee &&
      previousAssignee.toString() !== task.assignedTo.toString()
    ) {
      // Notify previous assignee
      notifications.push(
        this.createNotification({
          recipient: previousAssignee,
          sender: updatedBy,
          type: "task_updated",
          title: "Task Reassigned",
          message: `Task "${task.title}" has been reassigned to someone else`,
          relatedTask: task._id,
        })
      );

      // Notify new assignee
      notifications.push(
        this.createNotification({
          recipient: task.assignedTo,
          sender: updatedBy,
          type: "task_assigned",
          title: "New Task Assigned",
          message: `You have been assigned a task: "${task.title}"`,
          relatedTask: task._id,
        })
      );
    } else {
      // Regular update notification
      notifications.push(
        this.createNotification({
          recipient: task.assignedTo,
          sender: updatedBy,
          type: "task_updated",
          title: "Task Updated",
          message: `Task "${task.title}" has been updated`,
          relatedTask: task._id,
        })
      );
    }

    return Promise.all(notifications);
  }

  static async createTaskStatusNotification(task, updatedBy, newStatus) {
    let title, message, type;

    switch (newStatus) {
      case "completed":
        title = "Task Completed";
        message = `Task "${task.title}" has been completed`;
        type = "task_completed";
        break;
      case "pending_approval":
        title = "Task Awaiting Approval";
        message = `Task "${task.title}" is awaiting your approval`;
        type = "task_updated";
        break;
      case "approved":
        title = "Task Approved";
        message = `Your task "${task.title}" has been approved`;
        type = "task_approved";
        break;
      case "rejected":
        title = "Task Rejected";
        message = `Your task "${task.title}" has been rejected`;
        type = "task_rejected";
        break;
      default:
        title = "Task Status Changed";
        message = `Task "${task.title}" status changed to ${newStatus}`;
        type = "task_updated";
    }

    // Notify task creator if status changed by assignee
    if (newStatus === "pending_approval") {
      return this.createNotification({
        recipient: task.createdBy,
        sender: updatedBy,
        type,
        title,
        message,
        relatedTask: task._id,
      });
    }

    // Notify assignee for other status changes
    return this.createNotification({
      recipient: task.assignedTo,
      sender: updatedBy,
      type,
      title,
      message,
      relatedTask: task._id,
    });
  }

  static async markAsRead(notificationId, userId) {
    const updated = await Notification.findOneAndUpdate(
      { _id: notificationId, recipient: userId },
      { isRead: true },
      { new: true }
    );
    await this.pushUnreadCount(userId);
    return updated;
  }

  static async markAllAsRead(userId) {
    const result = await Notification.updateMany(
      { recipient: userId, isRead: false },
      { isRead: true }
    );
    await this.pushUnreadCount(userId);
    return result;
  }

  static async getUserNotifications(userId, limit = 20, skip = 0) {
    return Notification.find({ recipient: userId })
      .populate("sender", "firstName lastName")
      .populate("relatedTask", "title")
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip(skip)
      .lean();
  }

  static async getUnreadCount(userId) {
    return Notification.countDocuments({ recipient: userId, isRead: false });
  }
}

module.exports = NotificationService;
