// controllers/applicationUsage.controller.js
const ApplicationUsage = require("../models/applicationUsage.model");
const User = require("../models/User");
const mongoose = require("mongoose");
const fs = require("fs");
const csv = require("csv-parser");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const timeParser = require("../utils/time-parser");

/**
 * Process and save application usage data from a CSV file
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.processApplicationUsageCSV = async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please upload a CSV file",
      });
    }

    const file = req.files[0];
    const filePath = file.path;
    const batchId = uuidv4();
    const errors = [];
    let processedCount = 0;

    const stream = fs.createReadStream(filePath).pipe(
      csv({
        skipLines: 0,
        mapHeaders: ({ header }) => header.trim(), // normalize headers
      })
    );

    const records = [];

    for await (const row of stream) {
      try {
        // Normalize all values
        const r = {};
        Object.keys(row).forEach(key => {
          r[key.trim()] = typeof row[key] === 'string' ? row[key].trim() : row[key];
        });

        const dateValue = r['Date'];
        if (!dateValue) throw new Error('Missing date');

        let date;
        if (dateValue.includes('/')) {
          const parts = dateValue.split('/');
          // DD/MM/YYYY
          date = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
        } else {
          date = new Date(dateValue);
        }

        if (isNaN(date.getTime())) throw new Error(`Invalid date: ${dateValue}`);

        const email = r['Email'] || r['email'] || '';
        const name = r['User name'] || r['Name'] || '';
        const userId = r['User ID'] || email;
        const application = r['App/URL name'] || r['Application'] || '';
        const productivityRaw = r['Productivity level'] || r['Productivity'] || 'neutral';
        const productivity = productivityRaw.toLowerCase();
        const timeSpent = r['Time'] || '0:00:00';
        const timeSpentHours = timeParser.parseTimeToHours(timeSpent);

        if (!email || !application) throw new Error('Missing required fields: email or application');

        records.push({
          date,
          userId,
          name,
          email,
          userRoles: r['User Roles'] || '',
          group: r['Group'] || '',
          application,
          productivity,
          timeSpent,
          timeSpentHours,
          metadata: {
            batchId,
            uploadedAt: new Date(),
            uploadedBy: req.user ? req.user._id : 'system',
            originalFilename: file.originalname,
          },
        });
      } catch (error) {
        console.error(`Error processing row:`, error.message);
        errors.push({ row, error: error.message });
      }
    }

    fs.unlinkSync(filePath);

    if (records.length === 0) {
      return res.status(400).json({ success: false, message: 'No valid records found', errors });
    }

    const result = await ApplicationUsage.insertMany(records, { ordered: false });
    processedCount = result.length;

    res.status(200).json({
      success: true,
      message: `Successfully processed ${processedCount} application usage records`,
      batchId,
      processed: processedCount,
      errors: errors.length,
      errorDetails: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error("Error processing application usage CSV:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};

/**
 * Get application usage analytics for a specific user
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
exports.getUserApplicationAnalytics = async (req, res) => {
  try {
    const { id } = req.params;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "Both startDate and endDate are required",
      });
    }

    // Parse dates
    const start = new Date(startDate);
    const end = new Date(endDate);

    const userEmail = await User.findById(id).select("email");

    // Get user's application usage data
    const appUsageData = await ApplicationUsage.find({
      email: userEmail.email,
      date: { $gte: start, $lte: end },
    });

    // Group applications by productivity category
    const productiveApps = [];
    const unproductiveApps = [];
    const neutralApps = [];

    let totalProductiveTime = 0;
    let totalUnproductiveTime = 0;
    let totalNeutralTime = 0;

    // Process application usage data
    const appUsageMap = {};

    appUsageData.forEach((record) => {
      // Group by application
      if (!appUsageMap[record.application]) {
        appUsageMap[record.application] = {
          application: record.application,
          productivity: record.productivity,
          totalTimeHours: 0,
          usageCount: 0,
        };
      }

      appUsageMap[record.application].totalTimeHours += record.timeSpentHours;
      appUsageMap[record.application].usageCount += 1;

      // Track time by productivity category
      if (record.productivity === "productive") {
        totalProductiveTime += record.timeSpentHours;
      } else if (record.productivity === "unproductive") {
        totalUnproductiveTime += record.timeSpentHours;
      } else {
        totalNeutralTime += record.timeSpentHours;
      }
    });

    // Sort applications by time spent and categorize
    Object.values(appUsageMap).forEach((app) => {
      app.totalTimeHours = parseFloat(app.totalTimeHours.toFixed(2));

      if (app.productivity === "productive") {
        productiveApps.push(app);
      } else if (app.productivity === "unproductive") {
        unproductiveApps.push(app);
      } else {
        neutralApps.push(app);
      }
    });

    // Sort each category by time spent
    productiveApps.sort((a, b) => b.totalTimeHours - a.totalTimeHours);
    unproductiveApps.sort((a, b) => b.totalTimeHours - a.totalTimeHours);
    neutralApps.sort((a, b) => b.totalTimeHours - a.totalTimeHours);

    // Calculate total time spent
    const totalTimeHours =
      totalProductiveTime + totalUnproductiveTime + totalNeutralTime;

    // Calculate productivity percentages
    const productivityPercentage =
      totalTimeHours > 0 ? (totalProductiveTime / totalTimeHours) * 100 : 0;

    const unproductivityPercentage =
      totalTimeHours > 0 ? (totalUnproductiveTime / totalTimeHours) * 100 : 0;

    const neutralPercentage =
      totalTimeHours > 0 ? (totalNeutralTime / totalTimeHours) * 100 : 0;

    // Return the results
    res.status(200).json({
      success: true,
      userId: id,
      summary: {
        totalApplications: Object.keys(appUsageMap).length,
        totalTimeHours: parseFloat(totalTimeHours.toFixed(2)),
        productiveTimeHours: parseFloat(totalProductiveTime.toFixed(2)),
        unproductiveTimeHours: parseFloat(totalUnproductiveTime.toFixed(2)),
        neutralTimeHours: parseFloat(totalNeutralTime.toFixed(2)),
        productivityPercentage: parseFloat(productivityPercentage.toFixed(2)),
        unproductivityPercentage: parseFloat(
          unproductivityPercentage.toFixed(2)
        ),
        neutralPercentage: parseFloat(neutralPercentage.toFixed(2)),
      },
      applications: {
        productive: productiveApps.slice(0, 10), // Return top 10
        unproductive: unproductiveApps.slice(0, 10),
        neutral: neutralApps.slice(0, 10),
      },
    });
  } catch (error) {
    console.error("Error getting user application analytics:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
};
