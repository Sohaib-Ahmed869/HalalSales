// controllers/jobLog.controller.js
const JobLog = require("../models/jobLog.model");
const Customer = require("../models/Customer");
const Invoice = require("../models/Invoice");
const Payment = require("../models/payment");
const CreditNote = require("../models/CreditNotes");
const Return = require("../models/Return");
const PurchaseOrder = require("../models/Purchase");
const Cart = require("../models/Cart");
const CallData = require("../models/CallData");

const jobLogController = {
  // Get all job logs with pagination and filtering
  getAllJobs: async (req, res) => {
    try {
      const {
        page = 1,
        limit = 10,
        status,
        jobType,
        triggeredBy,
        startDate,
        endDate,
        sortBy = "startTime",
        sortOrder = "desc",
      } = req.query;

      // Build filter object
      const filter = {};

      if (status) filter.status = status;
      if (jobType) filter.jobType = jobType;
      if (triggeredBy) filter.triggeredBy = triggeredBy;

      // Date range filter
      if (startDate || endDate) {
        filter.startTime = {};
        if (startDate) filter.startTime.$gte = new Date(startDate);
        if (endDate) filter.startTime.$lte = new Date(endDate);
      }

      // Sort options
      const sortOptions = {};
      sortOptions[sortBy] = sortOrder === "desc" ? -1 : 1;

      // Execute query with pagination
      const jobs = await JobLog.find(filter)
        .sort(sortOptions)
        .limit(limit * 1)
        .skip((page - 1) * limit)
        .select("-logs.metadata") // Exclude metadata for performance
        .lean();

      // Get total count for pagination
      const total = await JobLog.countDocuments(filter);

      res.json({
        success: true,
        data: jobs,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(total / limit),
          totalItems: total,
          itemsPerPage: parseInt(limit),
        },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Error fetching job logs",
        error: error.message,
      });
    }
  },

  // Get a specific job by ID
  getJobById: async (req, res) => {
    try {
      const { jobId } = req.params;

      const job = await JobLog.findOne({ jobId }).lean();

      if (!job) {
        return res.status(404).json({
          success: false,
          message: "Job not found",
        });
      }

      res.json({
        success: true,
        data: job,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Error fetching job",
        error: error.message,
      });
    }
  },

  // Get job statistics
  getJobStats: async (req, res) => {
    try {
      const { days = 7 } = req.query;

      const stats = await JobLog.getJobStats(parseInt(days));

      // Get additional stats
      const totalJobs = await JobLog.countDocuments();
      const runningJobs = await JobLog.countDocuments({ status: "RUNNING" });

      // Recent activity (last 24 hours)
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const recentActivity = await JobLog.countDocuments({
        startTime: { $gte: yesterday },
      });

      res.json({
        success: true,
        data: {
          statusStats: stats,
          totalJobs,
          runningJobs,
          recentActivity,
        },
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Error fetching job statistics",
        error: error.message,
      });
    }
  },

  // Get job types summary
  getJobTypesSummary: async (req, res) => {
    try {
      const { days = 30 } = req.query;
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - parseInt(days));

      const summary = await JobLog.aggregate([
        { $match: { startTime: { $gte: startDate } } },
        {
          $group: {
            _id: "$jobType",
            total: { $sum: 1 },
            completed: {
              $sum: { $cond: [{ $eq: ["$status", "COMPLETED"] }, 1, 0] },
            },
            failed: {
              $sum: { $cond: [{ $eq: ["$status", "FAILED"] }, 1, 0] },
            },
            running: {
              $sum: { $cond: [{ $eq: ["$status", "RUNNING"] }, 1, 0] },
            },
            partialSuccess: {
              $sum: { $cond: [{ $eq: ["$status", "PARTIAL_SUCCESS"] }, 1, 0] },
            },
            avgDuration: { $avg: "$duration" },
            lastRun: { $max: "$startTime" },
          },
        },
        { $sort: { total: -1 } },
      ]);

      res.json({
        success: true,
        data: summary,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Error fetching job types summary",
        error: error.message,
      });
    }
  },

  // Get recent errors
  getRecentErrors: async (req, res) => {
    try {
      const { limit = 20 } = req.query;

      const jobsWithErrors = await JobLog.find({
        $or: [{ "errors.0": { $exists: true } }, { status: "FAILED" }],
      })
        .sort({ startTime: -1 })
        .limit(parseInt(limit))
        .select("jobId jobType status startTime errors logs")
        .lean();

      // Extract and format errors
      const errors = [];
      jobsWithErrors.forEach((job) => {
        // Add errors from errors array
        job.errors.forEach((error) => {
          errors.push({
            jobId: job.jobId,
            jobType: job.jobType,
            jobStatus: job.status,
            jobStartTime: job.startTime,
            docEntry: error.DocEntry,
            error: error.error,
            errorType: error.type,
            timestamp: error.timestamp,
          });
        });

        // Add errors from logs
        job.logs
          .filter((log) => log.level === "ERROR")
          .forEach((log) => {
            errors.push({
              jobId: job.jobId,
              jobType: job.jobType,
              jobStatus: job.status,
              jobStartTime: job.startTime,
              error: log.message,
              timestamp: log.timestamp,
              metadata: log.metadata,
            });
          });
      });

      // Sort by timestamp and limit
      errors.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      const limitedErrors = errors.slice(0, parseInt(limit));

      res.json({
        success: true,
        data: limitedErrors,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Error fetching recent errors",
        error: error.message,
      });
    }
  },

  // Get data completion stats - NEW ENDPOINT
  getDataCompletionStats: async (req, res) => {
    try {
      // Get current date ranges
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      // Model configurations with their respective models and display names
      const modelConfigs = [
        { model: Customer, name: "Customers", collection: "customers" },
        { model: Invoice, name: "Invoices", collection: "invoices" },
        { model: Payment, name: "Payments", collection: "payments" },
        { model: CreditNote, name: "Credit Notes", collection: "creditnotes" },
        { model: Return, name: "Returns", collection: "returns" },
        { model: PurchaseOrder, name: "Purchase Orders", collection: "purchaseorders" },
        { model: Cart, name: "Abandoned Carts (AC)", collection: "carts" },
        { model: CallData, name: "Call Records", collection: "calldata" }
      ];

      const completionStats = await Promise.all(
        modelConfigs.map(async (config) => {
          try {
            // Get total count
            const totalInDatabase = await config.model.countDocuments();

            // Get current month count
            let currentMonthQuery = {};
            if (config.collection === 'carts') {
              currentMonthQuery = { createDate: { $gte: startOfMonth } };
            } else if (config.collection === 'calldata') {
              currentMonthQuery = { startTime: { $gte: startOfMonth } };
            } else {
              // Assuming most models have createdAt or similar timestamp field
              currentMonthQuery = {
                $or: [
                  { createdAt: { $gte: startOfMonth } },
                  { createDate: { $gte: startOfMonth } },
                  { startTime: { $gte: startOfMonth } }
                ]
              };
            }

            const currentMonth = await config.model.countDocuments(currentMonthQuery);

            // Get last 24 hours count
            let last24HoursQuery = {};
            if (config.collection === 'carts') {
              last24HoursQuery = { createDate: { $gte: last24Hours } };
            } else if (config.collection === 'calldata') {
              last24HoursQuery = { startTime: { $gte: last24Hours } };
            } else {
              last24HoursQuery = {
                $or: [
                  { createdAt: { $gte: last24Hours } },
                  { createDate: { $gte: last24Hours } },
                  { startTime: { $gte: last24Hours } }
                ]
              };
            }

            const last24HoursCount = await config.model.countDocuments(last24HoursQuery);

            // Get latest sync job for this model type
            const syncJobTypes = {
              'customers': ['SCHEDULED_SYNC', 'MANUAL_SYNC', 'CUSTOMER_SYNC'],
              'invoices': ['INVOICE_SYNC', 'SCHEDULED_SYNC'],
              'payments': ['PAYMENT_SYNC', 'SCHEDULED_SYNC'],
              'creditnotes': ['CREDITNOTE_SYNC', 'SCHEDULED_SYNC'],
              'returns': ['RETURN_SYNC', 'SCHEDULED_SYNC'],
              'purchaseorders': ['PURCHASE_SYNC', 'SCHEDULED_SYNC'],
              'carts': ['CART_SYNC', 'SCHEDULED_SYNC', 'AC_SYNC'],
              'calldata': ['CALL_SYNC', 'SCHEDULED_SYNC', 'CALL_RECORDS_SYNC']
            };

            const jobTypes = syncJobTypes[config.collection] || ['SCHEDULED_SYNC'];

            const lastSyncJob = await JobLog.findOne({
              jobType: { $in: jobTypes }
            }).sort({ startTime: -1 }).lean();

            // Calculate growth percentage (comparing current month to previous month)
            const startOfPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const endOfPrevMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

            let prevMonthQuery = {};
            if (config.collection === 'carts') {
              prevMonthQuery = {
                createDate: {
                  $gte: startOfPrevMonth,
                  $lte: endOfPrevMonth
                }
              };
            } else if (config.collection === 'calldata') {
              prevMonthQuery = {
                startTime: {
                  $gte: startOfPrevMonth,
                  $lte: endOfPrevMonth
                }
              };
            } else {
              prevMonthQuery = {
                $or: [
                  {
                    createdAt: {
                      $gte: startOfPrevMonth,
                      $lte: endOfPrevMonth
                    }
                  },
                  {
                    createDate: {
                      $gte: startOfPrevMonth,
                      $lte: endOfPrevMonth
                    }
                  },
                  {
                    startTime: {
                      $gte: startOfPrevMonth,
                      $lte: endOfPrevMonth
                    }
                  }
                ]
              };
            }

            const prevMonth = await config.model.countDocuments(prevMonthQuery);

            let growth = "+0.0%";
            if (prevMonth > 0) {
              const growthPercent = ((currentMonth - prevMonth) / prevMonth) * 100;
              growth = growthPercent >= 0 ? `+${growthPercent.toFixed(1)}%` : `${growthPercent.toFixed(1)}%`;
            } else if (currentMonth > 0) {
              growth = "+100.0%";
            }

            // Count recent errors for this model type
            const errorCount = lastSyncJob ?
              Math.max(
                (lastSyncJob.errors && lastSyncJob.errors.length) || 0,
                (lastSyncJob.logs && lastSyncJob.logs.filter(log => log.level === 'ERROR').length) || 0,
                (lastSyncJob.stats && lastSyncJob.stats.errors) || 0
              ) : 0;

            return {
              modelName: config.name,
              collection: config.collection,
              totalInDatabase,
              currentMonth,
              last24Hours: last24HoursCount,
              lastSyncTime: lastSyncJob ? lastSyncJob.startTime : new Date(),
              syncStatus: lastSyncJob ? lastSyncJob.status : 'UNKNOWN',
              errorCount,
              growth
            };

          } catch (modelError) {
            console.error(`Error fetching stats for ${config.name}:`, modelError);
            return {
              modelName: config.name,
              collection: config.collection,
              totalInDatabase: 0,
              currentMonth: 0,
              last24Hours: 0,
              lastSyncTime: new Date(),
              syncStatus: 'ERROR',
              errorCount: 1,
              growth: "0.0%"
            };
          }
        })
      );

      res.json({
        success: true,
        data: completionStats,
      });
    } catch (error) {
      console.error('Error fetching data completion stats:', error);
      res.status(500).json({
        success: false,
        message: "Error fetching data completion statistics",
        error: error.message,
      });
    }
  },

  // Delete old job logs
  deleteOldJobs: async (req, res) => {
    try {
      const { days = 30 } = req.query;
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - parseInt(days));

      const result = await JobLog.deleteMany({
        startTime: { $lt: cutoffDate },
        status: { $ne: "RUNNING" }, // Don't delete running jobs
      });

      res.json({
        success: true,
        message: `Deleted ${result.deletedCount} old job logs`,
        deletedCount: result.deletedCount,
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: "Error deleting old job logs",
        error: error.message,
      });
    }
  },
};

module.exports = jobLogController;