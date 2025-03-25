const fs = require("fs");
const path = require("path");
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
};

module.exports = callDataController;
