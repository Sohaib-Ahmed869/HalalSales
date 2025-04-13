const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { parse } = require("csv-parse");
const CallData = require("../models/CallData");

// Helper function to parse CSV data
const parseCSV = (filePath) => {
  return new Promise((resolve, reject) => {
    const results = [];

    fs.createReadStream(filePath)
      .pipe(
        parse({
          delimiter: ";",
          columns: true,
          skip_empty_lines: true,
          trim: true,
        })
      )
      .on("data", (data) => {
        results.push(data);
      })
      .on("error", (error) => {
        reject(error);
      })
      .on("end", () => {
        resolve(results);
      });
  });
};

// Process and transform raw CSV data to match our model
const transformData = (rawData) => {
  return rawData.map((record) => {
    // Parse tags from string format "[\"Tag1\",\"Tag2\"]" to array
    let tags = [];
    if (record.Tags) {
      try {
        const tagsString = record.Tags.replace(/^\[|\]$/g, "").trim();
        tags = tagsString
          ? tagsString
              .split(",")
              .map((tag) => tag.replace(/^"|"$/g, "").trim())
              .filter((tag) => tag)
          : [];
      } catch (e) {
        console.error("Error parsing tags:", e);
      }
    }

    return {
      id: record.id,
      callID: record.CallID,
      channelID: record.ChannelID,
      type: record.type,
      direction: record.direction,
      lastState: record.LastState,
      startTime: record.StartTime ? new Date(record.StartTime) : null,
      answeredTime: record.AnsweredTime ? new Date(record.AnsweredTime) : null,
      hangupTime: record.HangupTime ? new Date(record.HangupTime) : null,
      totalDuration: parseFloat(record.TotalDuration) || 0,
      inCallDuration: parseFloat(record.InCallDuration) || 0,
      queueDuration: parseFloat(record.QueueDuration) || 0,
      holdDuration: parseFloat(record.HoldDuration) || 0,
      ringingDuration: parseFloat(record.RingingDuration) || 0,
      afterCallDuration: parseFloat(record.AfterCallDuration) || 0,
      ivrDuration: parseFloat(record.IVRDuration) || 0,
      fromNumber: record.FromNumber,
      toNumber: record.ToNumber,
      contact: record.contact,
      userID: record.UserID,
      userName: record.UserName,
      ivrID: record.IVRID,
      ivrName: record.IVRName,
      scenarioName: record.ScenarioName,
      file: record.File,
      note: record.Note,
      tags: tags,
      groups: record.Groups,
      notes: record.Notes,
      locations: record.Locations,
      digitEntered: record.DigitEntered,
      missed: record.Missed,
    };
  });
};

// Controller methods
const callDataController = {
  // Upload and process CSV file
  uploadCSV: async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const filePath = req.file.path;

      // Parse the CSV file
      const rawData = await parseCSV(filePath);

      // Transform data to match our model
      const transformedData = transformData(rawData);

      // Save data to database
      const savedData = await CallData.insertMany(transformedData, {
        ordered: false, // Continue processing even if some documents fail
      });

      // Clean up - remove the temporary file
      fs.unlinkSync(filePath);

      return res.status(200).json({
        message: "CSV data processed successfully",
        recordsProcessed: rawData.length,
        recordsSaved: savedData.length,
      });
    } catch (error) {
      console.error("Error processing CSV:", error);

      // If the file exists but there was an error processing it, clean up
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }

      return res.status(500).json({
        error: "Error processing CSV file",
        details: error.message,
      });
    }
  },

  // Get all call data
  getAllCallData: async (req, res) => {
    try {
      const callData = await CallData.find();
      return res.status(200).json(callData);
    } catch (error) {
      console.error("Error fetching call data:", error);
      return res.status(500).json({
        error: "Error fetching call data",
        details: error.message,
      });
    }
  },

  // Get call data by ID
  getCallDataById: async (req, res) => {
    try {
      const { id } = req.params;
      const callData = await CallData.findOne({ id });

      if (!callData) {
        return res.status(404).json({ error: "Call data not found" });
      }

      return res.status(200).json(callData);
    } catch (error) {
      console.error("Error fetching call data by ID:", error);
      return res.status(500).json({
        error: "Error fetching call data",
        details: error.message,
      });
    }
  },

  // Delete call data by ID
  deleteCallDataById: async (req, res) => {
    try {
      const { id } = req.params;
      const result = await CallData.findOneAndDelete({ id });

      if (!result) {
        return res.status(404).json({ error: "Call data not found" });
      }

      return res
        .status(200)
        .json({ message: "Call data deleted successfully" });
    } catch (error) {
      console.error("Error deleting call data:", error);
      return res.status(500).json({
        error: "Error deleting call data",
        details: error.message,
      });
    }
  },

  getAgentCallData: async (req, res) => {
    try {
      const { phone } = req.user; // Assuming you have auth middleware that adds user to req
      if (!phone) {
        return res.status(200).json({
          data: [],
          pagination: {
            total: 0,
            page: 1,
            limit: 10,
            pages: 0,
          },
        });
      }
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const skip = (page - 1) * limit;

      // Build filter object based on query params
      const filter = { fromNumber: phone };

      if (req.query.startDate && req.query.endDate) {
        filter.startTime = {
          $gte: new Date(req.query.startDate),
          $lte: new Date(req.query.endDate),
        };
      }

      if (req.query.direction) {
        filter.direction = req.query.direction;
      }

      if (req.query.type) {
        filter.type = req.query.type;
      }

      if (req.query.search) {
        const searchRegex = new RegExp(req.query.search, "i");
        filter.$or = [
          { fromNumber: searchRegex },
          { toNumber: searchRegex },
          { contact: searchRegex },
        ];
      }

      // Execute query with pagination
      const callData = await CallData.find(filter)
        .sort({ startTime: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

      const total = await CallData.countDocuments(filter);

      return res.status(200).json({
        data: callData,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      console.error("Error fetching agent call data:", error);
      return res.status(500).json({
        error: "Error fetching agent call data",
        details: error.message,
      });
    }
  },

  // Get call statistics for a specific agent
  getAgentCallStatistics: async (req, res) => {
    try {
      console.log("Fetching call statistics for agent:", req.user);
      const { phone } = req.user; // From auth middleware
      const { startDate, endDate } = req.query;

      if (!phone) {
        return res.status(200).json({
          summary: {
            totalCalls: 0,
            inboundCalls: 0,
            outboundCalls: 0,
            missedCalls: 0,
            answerRate: 0,
            averageDuration: 0,
            totalTalkTime: 0,
            totalHoldTime: 0,
          },
          dailyTrend: [],
        });
      }

      // Set default date range if not provided (last 30 days)
      const endDateTime = endDate ? new Date(endDate) : new Date();
      const startDateTime = startDate
        ? new Date(startDate)
        : new Date(endDateTime.getTime() - 30 * 24 * 60 * 60 * 1000);

      // Filter for date range and agent ID
      const filter = {
        fromNumber: phone,
        startTime: {
          $gte: startDateTime,
          $lte: endDateTime,
        },
      };

      // Total calls statistics
      const totalCalls = await CallData.countDocuments(filter);
      const inboundCalls = await CallData.countDocuments({
        ...filter,
        direction: "in",
      });
      const outboundCalls = await CallData.countDocuments({
        ...filter,
        direction: "out",
      });
      const missedCalls = await CallData.countDocuments({
        ...filter,
        missed: { $ne: "" },
      });

      // Duration statistics
      const durationStats = await CallData.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalDuration: { $sum: "$totalDuration" },
            avgDuration: { $avg: "$inCallDuration" },
            maxDuration: { $max: "$inCallDuration" },
            totalInCallDuration: { $sum: "$inCallDuration" },
            avgHoldDuration: { $avg: "$holdDuration" },
            totalHoldDuration: { $sum: "$holdDuration" },
          },
        },
      ]);

      // Daily call trend
      const dailyTrend = await CallData.aggregate([
        { $match: filter },
        {
          $project: {
            date: { $dateToString: { format: "%Y-%m-%d", date: "$startTime" } },
            duration: "$inCallDuration",
            direction: 1,
          },
        },
        {
          $group: {
            _id: { date: "$date", direction: "$direction" },
            count: { $sum: 1 },
            totalDuration: { $sum: "$duration" },
          },
        },
        { $sort: { "_id.date": 1 } },
      ]);

      // Format daily trend data
      const formattedDailyTrend = dailyTrend.reduce((acc, curr) => {
        const { date, direction } = curr._id;
        if (!acc[date]) {
          acc[date] = { date, inbound: 0, outbound: 0, totalDuration: 0 };
        }

        if (direction === "in") {
          acc[date].inbound = curr.count;
        } else if (direction === "out") {
          acc[date].outbound = curr.count;
        }

        acc[date].totalDuration += curr.totalDuration || 0;
        return acc;
      }, {});

      // Convert to array and fill missing dates
      const trendArray = Object.values(formattedDailyTrend);

      return res.status(200).json({
        summary: {
          totalCalls,
          inboundCalls,
          outboundCalls,
          missedCalls,
          answerRate:
            totalCalls > 0
              ? (((totalCalls - missedCalls) / totalCalls) * 100).toFixed(1)
              : 0,
          averageDuration:
            durationStats.length > 0 ? durationStats[0].avgDuration || 0 : 0,
          totalTalkTime:
            durationStats.length > 0
              ? durationStats[0].totalInCallDuration || 0
              : 0,
          totalHoldTime:
            durationStats.length > 0
              ? durationStats[0].totalHoldDuration || 0
              : 0,
        },
        dailyTrend: trendArray,
      });
    } catch (error) {
      console.error("Error fetching call statistics:", error);
      return res.status(500).json({
        error: "Error fetching call statistics",
        details: error.message,
      });
    }
  },

  // Get call data for all agents (manager view) with pagination and filtering
  getTeamCallData: async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const skip = (page - 1) * limit;

      // Build filter object based on query params
      const filter = {};

      if (req.query.agentId) {
        filter.userID = req.query.agentId;
      }

      if (req.query.startDate && req.query.endDate) {
        filter.startTime = {
          $gte: new Date(req.query.startDate),
          $lte: new Date(req.query.endDate),
        };
      }

      if (req.query.direction) {
        filter.direction = req.query.direction;
      }

      if (req.query.type) {
        filter.type = req.query.type;
      }

      if (req.query.status) {
        if (req.query.status === "missed") {
          filter.missed = { $ne: "" };
        } else if (req.query.status === "answered") {
          filter.missed = "";
        }
      }

      if (req.query.search) {
        const searchRegex = new RegExp(req.query.search, "i");
        filter.$or = [
          { fromNumber: searchRegex },
          { toNumber: searchRegex },
          { contact: searchRegex },
          { userName: searchRegex },
        ];
      }

      // Execute query with pagination
      const callData = await CallData.find(filter)
        .sort({ startTime: -1 })
        .skip(skip)
        .limit(limit)
        .lean();

      const total = await CallData.countDocuments(filter);

      return res.status(200).json({
        data: callData,
        pagination: {
          total,
          page,
          limit,
          pages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      console.error("Error fetching team call data:", error);
      return res.status(500).json({
        error: "Error fetching team call data",
        details: error.message,
      });
    }
  },

  // Get team call statistics grouped by different dimensions (for manager view)
  getTeamCallStatistics: async (req, res) => {
    try {
      const { startDate, endDate, groupBy = "agent" } = req.query;

      // Set default date range if not provided (last 30 days)
      const endDateTime = endDate ? new Date(endDate) : new Date();
      const startDateTime = startDate
        ? new Date(startDate)
        : new Date(endDateTime.getTime() - 30 * 24 * 60 * 60 * 1000);

      // Filter for date range
      const filter = {
        startTime: {
          $gte: startDateTime,
          $lte: endDateTime,
        },
      };

      // Overall statistics
      const totalCalls = await CallData.countDocuments(filter);
      const inboundCalls = await CallData.countDocuments({
        ...filter,
        direction: "in",
      });
      const outboundCalls = await CallData.countDocuments({
        ...filter,
        direction: "out",
      });
      const missedCalls = await CallData.countDocuments({
        ...filter,
        missed: { $ne: "" },
      });

      // Duration statistics
      const durationStats = await CallData.aggregate([
        { $match: filter },
        {
          $group: {
            _id: null,
            totalDuration: { $sum: "$totalDuration" },
            avgDuration: { $avg: "$inCallDuration" },
            maxDuration: { $max: "$inCallDuration" },
            totalInCallDuration: { $sum: "$inCallDuration" },
            avgHoldDuration: { $avg: "$holdDuration" },
            totalHoldDuration: { $sum: "$holdDuration" },
          },
        },
      ]);

      // Group data based on requested dimension
      let groupField;
      if (groupBy === "agent") {
        groupField = { agent: "$userName" };
      } else if (groupBy === "day") {
        groupField = {
          date: { $dateToString: { format: "%Y-%m-%d", date: "$startTime" } },
        };
      } else if (groupBy === "week") {
        groupField = {
          week: { $dateToString: { format: "%G-W%V", date: "$startTime" } },
        };
      } else if (groupBy === "month") {
        groupField = {
          month: { $dateToString: { format: "%Y-%m", date: "$startTime" } },
        };
      } else {
        groupField = { agent: "$userName" }; // Default to agent
      }

      // Aggregated statistics by group
      const groupedStats = await CallData.aggregate([
        { $match: filter },
        {
          $group: {
            _id: groupField,
            totalCalls: { $sum: 1 },
            inboundCalls: {
              $sum: { $cond: [{ $eq: ["$direction", "in"] }, 1, 0] },
            },
            outboundCalls: {
              $sum: { $cond: [{ $eq: ["$direction", "out"] }, 1, 0] },
            },
            missedCalls: {
              $sum: { $cond: [{ $eq: ["$missed", "true"] }, 1, 0] },
            },
            totalDuration: { $sum: "$totalDuration" },
            inCallDuration: { $sum: "$inCallDuration" },
            avgCallDuration: { $avg: "$inCallDuration" },
          },
        },
        { $sort: { totalCalls: -1 } },
      ]);

      // Format the response
      const formattedGroupedStats = groupedStats.map((group) => {
        const groupKey = Object.keys(group._id)[0];
        const groupValue = group._id[groupKey];

        return {
          [groupKey]: groupValue,
          totalCalls: group.totalCalls,
          inboundCalls: group.inboundCalls,
          outboundCalls: group.outboundCalls,
          missedCalls: group.missedCalls,
          answerRate:
            group.totalCalls > 0
              ? (
                  ((group.totalCalls - group.missedCalls) / group.totalCalls) *
                  100
                ).toFixed(1)
              : 0,
          avgCallDuration: group.avgCallDuration || 0,
          totalTalkTime: group.inCallDuration || 0,
        };
      });

      return res.status(200).json({
        summary: {
          totalCalls,
          inboundCalls,
          outboundCalls,
          missedCalls,
          answerRate:
            totalCalls > 0
              ? (((totalCalls - missedCalls) / totalCalls) * 100).toFixed(1)
              : 0,
          averageDuration:
            durationStats.length > 0 ? durationStats[0].avgDuration || 0 : 0,
          totalTalkTime:
            durationStats.length > 0
              ? durationStats[0].totalInCallDuration || 0
              : 0,
          totalHoldTime:
            durationStats.length > 0
              ? durationStats[0].totalHoldDuration || 0
              : 0,
        },
        groupedStats: formattedGroupedStats,
      });
    } catch (error) {
      console.error("Error fetching team call statistics:", error);
      return res.status(500).json({
        error: "Error fetching team call statistics",
        details: error.message,
      });
    }
  },

  // Get agent performance comparison for managers
  getAgentPerformanceComparison: async (req, res) => {
    try {
      const { startDate, endDate } = req.query;

      // Set default date range if not provided (last 30 days)
      const endDateTime = endDate ? new Date(endDate) : new Date();
      const startDateTime = startDate
        ? new Date(startDate)
        : new Date(endDateTime.getTime() - 30 * 24 * 60 * 60 * 1000);

      // Filter for date range
      const filter = {
        startTime: {
          $gte: startDateTime,
          $lte: endDateTime,
        },
      };

      // Get all agents with their call stats
      const agentStats = await CallData.aggregate([
        { $match: filter },
        {
          $group: {
            _id: { userID: "$userID", userName: "$userName" },
            totalCalls: { $sum: 1 },
            answeredCalls: {
              $sum: { $cond: [{ $eq: ["$missed", "true"] }, 0, 1] },
            },
            totalDuration: { $sum: "$totalDuration" },
            inCallDuration: { $sum: "$inCallDuration" },
            avgCallDuration: { $avg: "$inCallDuration" },
            maxCallDuration: { $max: "$inCallDuration" },
            inboundCalls: {
              $sum: { $cond: [{ $eq: ["$direction", "in"] }, 1, 0] },
            },
            outboundCalls: {
              $sum: { $cond: [{ $eq: ["$direction", "out"] }, 1, 0] },
            },
          },
        },
        {
          $project: {
            _id: 0,
            userID: "$_id.userID",
            userName: "$_id.userName",
            totalCalls: 1,
            answeredCalls: 1,
            missedCalls: { $subtract: ["$totalCalls", "$answeredCalls"] },
            answerRate: {
              $multiply: [
                { $divide: ["$answeredCalls", { $max: ["$totalCalls", 1] }] },
                100,
              ],
            },
            totalDuration: 1,
            inCallDuration: 1,
            avgCallDuration: 1,
            maxCallDuration: 1,
            inboundCalls: 1,
            outboundCalls: 1,
          },
        },
        { $sort: { totalCalls: -1 } },
      ]);

      // For each agent, calculate daily trend
      const agentDailyTrends = await Promise.all(
        agentStats.map(async (agent) => {
          const dailyTrend = await CallData.aggregate([
            {
              $match: {
                ...filter,
                userID: agent.userID,
              },
            },
            {
              $project: {
                date: {
                  $dateToString: { format: "%Y-%m-%d", date: "$startTime" },
                },
                direction: 1,
                missed: 1,
                inCallDuration: 1,
              },
            },
            {
              $group: {
                _id: { date: "$date" },
                calls: { $sum: 1 },
                answeredCalls: {
                  $sum: { $cond: [{ $eq: ["$missed", "true"] }, 0, 1] },
                },
                inCallDuration: { $sum: "$inCallDuration" },
              },
            },
            { $sort: { "_id.date": 1 } },
          ]);

          return {
            ...agent,
            dailyTrend: dailyTrend.map((day) => ({
              date: day._id.date,
              calls: day.calls,
              answeredCalls: day.answeredCalls,
              missedCalls: day.calls - day.answeredCalls,
              inCallDuration: day.inCallDuration,
            })),
          };
        })
      );

      return res.status(200).json({
        agents: agentDailyTrends,
        dateRange: {
          startDate: startDateTime,
          endDate: endDateTime,
        },
      });
    } catch (error) {
      console.error("Error fetching agent performance comparison:", error);
      return res.status(500).json({
        error: "Error fetching agent performance comparison",
        details: error.message,
      });
    }
  },
  analyzeCall: async (req, res) => {
    try {
      const { callID, audioUrl } = req.body;

      // Validate required parameters
      if (!callID) {
        return res.status(400).json({ error: "Missing callID parameter" });
      }

      if (!audioUrl) {
        return res.status(400).json({ error: "Missing audioUrl parameter" });
      }

      // Find the call in the database
      const callData = await CallData.findOne({ callID });
      if (!callData) {
        return res.status(404).json({ error: "Call not found" });
      }

      // Create axios request to the Flask API
      const axios = require("axios");
      try {
        // Send request to the Flask API
        const response = await axios.post(
          "http://127.0.0.1:5001/analyze-call",
          {
            audio_url: audioUrl,
            call_id: callID,
          }
        );

        // Get the analysis result
        const analysisResult = response.data;

        // Update the call data with analysis results
        callData.transcript = analysisResult.transcript;
        callData.analysis = analysisResult.analysis;
        callData.qualityScore = analysisResult.qualityScore;
        callData.analysisTimestamp = new Date();

        if (analysisResult.structuredAnalysis) {
          // Handle the structuredAnalysis safely, ensuring proper data types
          // Convert arrays to strings if needed
          const structuredAnalysis = {
            ...analysisResult.structuredAnalysis,
          };

          // Process speaker identification data - handle arrays
          if (structuredAnalysis.speakerIdentification) {
            // This will accept arrays or convert them to strings as needed
            structuredAnalysis.speakerIdentification = {
              ...structuredAnalysis.speakerIdentification,
              // Store arrays as-is without type conversion
              agentLines: structuredAnalysis.speakerIdentification.agentLines,
              clientLines: structuredAnalysis.speakerIdentification.clientLines,
            };
          }

          callData.structuredAnalysis = structuredAnalysis;
        }
        // Save the updated call data
        await callData.save();

        // Return the analysis results to the client
        return res.status(200).json(analysisResult);
      } catch (apiError) {
        console.error("Error calling analysis API:", apiError.message);

        // Get detailed error if available in the response
        const errorDetails = apiError.response?.data || {
          error: apiError.message,
        };

        return res.status(500).json({
          error: "Error during call analysis",
          details: errorDetails,
          callID,
        });
      }
    } catch (error) {
      console.error("Error analyzing call:", error);
      return res.status(500).json({
        error: "Error analyzing call",
        details: error.message,
      });
    }
  },
};

module.exports = callDataController;
