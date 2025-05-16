const cron = require("node-cron");
const axios = require("axios");
const dotenv = require("dotenv");
const CallData = require("../models/CallData");
const mongoose = require("mongoose");

// Load environment variables
dotenv.config();

// Ringover API configuration
const RINGOVER_API_KEY = process.env.RINGOVER_API_KEY;
const RINGOVER_API_URL = "https://public-api.ringover.com/v2/calls";

// Connect to MongoDB (if not already connected in your main app)
if (!mongoose.connection.readyState) {
  mongoose
    .connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    })
    .then(() => console.log("MongoDB connected"))
    .catch((err) => console.error("MongoDB connection error:", err));
}

/**
 * Formats date to ISO string and removes milliseconds
 * @param {Date} date - Date to format
 * @returns {string} Formatted date string
 */
function formatDateForRingover(date) {
  return date.toISOString().split(".")[0] + "Z";
}

/**
 * Maps Ringover API response to CallData model format
 * @param {Object} call - Call data from Ringover API
 * @returns {Object} Formatted call data for MongoDB
 */
function mapRingoverCallToModel(call) {
  // Process tags - extract only the tag names as strings
  let tagStrings = [];
  if (call.tags && Array.isArray(call.tags)) {
    // If tags is already an array of objects, map to extract names
    tagStrings = call.tags
      .map((tag) => {
        if (typeof tag === "object" && tag.name) {
          return tag.name;
        } else if (typeof tag === "string") {
          return tag;
        }
        return "";
      })
      .filter((tag) => tag !== "");
  } else if (typeof call.tags === "string") {
    try {
      // If tags is a string representation of JSON, parse it first
      const parsedTags = JSON.parse(call.tags.replace(/'/g, '"'));
      if (Array.isArray(parsedTags)) {
        tagStrings = parsedTags
          .map((tag) => tag.name || "")
          .filter((tag) => tag !== "");
      }
    } catch (error) {
      // If parsing fails, leave tags as empty array
      console.warn(
        `Could not parse tags for call ${call.cdr_id}: ${error.message}`
      );
    }
  }

  // Based on the actual response structure you provided
  return {
    id: call.cdr_id.toString(), // Ensure it's a string
    callID: call.call_id || "",
    channelID: call.channel_id || "",
    type: call.type || "",
    direction: call.direction || "",
    lastState: call.last_state || "",
    startTime: call.start_time ? new Date(call.start_time) : null,
    answeredTime: call.answered_time ? new Date(call.answered_time) : null,
    hangupTime: call.end_time ? new Date(call.end_time) : null, // Using end_time as hangupTime
    totalDuration: call.total_duration || 0,
    inCallDuration: call.incall_duration || 0, // Note: incall_duration in response vs inCallDuration in model
    queueDuration: call.queue_duration || 0,
    holdDuration: call.hold_duration || 0,
    ringingDuration: call.ringing_duration || 0,
    afterCallDuration: call.after_call_duration || 0,
    ivrDuration: call.ivr_duration || 0,
    fromNumber: call.from_number || "",
    toNumber: call.to_number || "",
    contact: call.contact_id || "",
    userID: call.user_id || "",
    userName: call.user_name || "",
    ivrID: call.ivr_id || "",
    ivrName: call.ivr_name || "",
    scenarioName: call.scenario_name || "",
    file: call.recording_file || "",
    note: call.note || "",
    tags: tagStrings, // Use the processed tag strings
    groups: call.groups || "",
    notes: call.notes || "",
    locations: call.location || "",
    digitEntered: call.digit_entered || "",
    missed: call.is_answered ? "false" : "true", // Inverting is_answered for missed
    transcript: call.transcript || "",
    // Skip analysis fields as mentioned
  };
}

/**
 * Fetches call data from Ringover API for a specific date range
 * @param {Date} startDate - Start date for fetching calls
 * @param {Date} endDate - End date for fetching calls
 * @returns {Promise<Array>} - Array of call data
 */
async function fetchRingoverCalls(startDate, endDate) {
  const formattedStartDate = formatDateForRingover(startDate);
  const formattedEndDate = formatDateForRingover(endDate);

  console.log(
    `Fetching Ringover calls from ${formattedStartDate} to ${formattedEndDate}`
  );

  let allCalls = [];
  let hasMore = true;
  let offset = 0;
  const limit = 1000; // Maximum allowed by API

  // Paginate through all results
  while (hasMore) {
    try {
      const response = await axios({
        method: "GET",
        url: RINGOVER_API_URL,
        headers: {
          Authorization: `${RINGOVER_API_KEY}`,
          "Content-Type": "application/json",
        },
        params: {
          start_date: formattedStartDate,
          end_date: formattedEndDate,
          limit_count: limit,
          limit_offset: offset,
        },
      });

      // Use call_list instead of calls based on your response structure
      const calls = response.data?.call_list || [];
      allCalls = [...allCalls, ...calls];

      // Check if we've received all calls based on total_call_count
      const totalCalls = response.data?.total_call_count || 0;

      if (calls.length < limit || allCalls.length >= totalCalls) {
        hasMore = false;
      } else {
        offset += limit;
        // API limitation: offset cannot exceed 9000
        if (offset >= 9000) {
          console.warn(
            "Reached maximum offset (9000). Some data may be missing."
          );
          hasMore = false;
        }
      }
    } catch (error) {
      console.error(
        "Error fetching Ringover calls:",
        error.response?.data || error.message
      );
      hasMore = false;
    }
  }

  return allCalls;
}

/**
 * Main function to fetch yesterday's calls and save to MongoDB
 */
async function fetchAndSaveYesterdayCalls() {
  try {
    // Calculate yesterday's date range (full 24 hours)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const endOfYesterday = new Date(yesterday);
    endOfYesterday.setHours(23, 59, 59, 999);

    // Fetch calls from Ringover API
    const calls = await fetchRingoverCalls(yesterday, endOfYesterday);
    console.log(`Retrieved ${calls.length} calls from Ringover API`);

    // Map and save each call to MongoDB
    let savedCount = 0;
    let errorCount = 0;

    for (const call of calls) {
      try {
        const callData = mapRingoverCallToModel(call);

        // Use findOneAndUpdate with upsert to avoid duplicates
        await CallData.findOneAndUpdate({ id: callData.id }, callData, {
          upsert: true,
          new: true,
        });

        savedCount++;
      } catch (error) {
        console.error(`Error saving call ${call.cdr_id}:`, error.message);
        errorCount++;
      }
    }

    console.log(
      `Ringover data sync completed. Saved: ${savedCount}, Errors: ${errorCount}`
    );
  } catch (error) {
    console.error("Error in fetchAndSaveYesterdayCalls:", error);
  }
}

// Schedule the task to run daily at 2:00 AM
// Currently set to run every minute for testing, change to '0 2 * * *' for production
cron.schedule("0 2 * * *", async () => {
  console.log("Running scheduled Ringover data fetch task");
  await fetchAndSaveYesterdayCalls();
});

// Also expose a function to manually run the job if needed
async function manuallyRunSync(daysAgo = 1) {
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() - daysAgo);
  targetDate.setHours(0, 0, 0, 0);

  const endOfTargetDate = new Date(targetDate);
  endOfTargetDate.setHours(23, 59, 59, 999);

  console.log(
    `Manually running sync for date: ${targetDate.toISOString().split("T")[0]}`
  );

  const calls = await fetchRingoverCalls(targetDate, endOfTargetDate);
  console.log(`Retrieved ${calls.length} calls`);

  let savedCount = 0;
  let errorCount = 0;

  for (const call of calls) {
    try {
      const callData = mapRingoverCallToModel(call);

      await CallData.findOneAndUpdate({ id: callData.id }, callData, {
        upsert: true,
        new: true,
      });

      savedCount++;
    } catch (error) {
      console.error(`Error saving call ${call.cdr_id}:`, error.message);
      errorCount++;
    }
  }

  console.log(
    `Manual sync completed. Saved: ${savedCount}, Errors: ${errorCount}`
  );
  return { savedCount, errorCount };
}

// Function to sync data for a specific date range
async function syncDateRange(startDate, endDate) {
  console.log(
    `Running sync for date range: ${startDate.toISOString().split("T")[0]} to ${
      endDate.toISOString().split("T")[0]
    }`
  );

  // The API has a 15-day limit, so we need to chunk requests
  const maxDaySpan = 15;
  let currentStart = new Date(startDate);

  while (currentStart < endDate) {
    // Calculate the end of this chunk (either 15 days later or the end date)
    let chunkEnd = new Date(currentStart);
    chunkEnd.setDate(chunkEnd.getDate() + maxDaySpan);

    if (chunkEnd > endDate) {
      chunkEnd = new Date(endDate);
    }

    console.log(
      `Processing chunk: ${currentStart.toISOString().split("T")[0]} to ${
        chunkEnd.toISOString().split("T")[0]
      }`
    );

    const calls = await fetchRingoverCalls(currentStart, chunkEnd);
    console.log(`Retrieved ${calls.length} calls for this chunk`);

    let savedCount = 0;
    let errorCount = 0;

    for (const call of calls) {
      try {
        const callData = mapRingoverCallToModel(call);

        await CallData.findOneAndUpdate({ id: callData.id }, callData, {
          upsert: true,
          new: true,
        });

        savedCount++;
      } catch (error) {
        console.error(`Error saving call ${call.cdr_id}:`, error.message);
        errorCount++;
      }
    }

    console.log(
      `Chunk sync completed. Saved: ${savedCount}, Errors: ${errorCount}`
    );

    // Move to the next chunk
    currentStart = new Date(chunkEnd);
    currentStart.setDate(currentStart.getDate() + 1);
  }

  console.log(
    `Date range sync completed from ${
      startDate.toISOString().split("T")[0]
    } to ${endDate.toISOString().split("T")[0]}`
  );
}

// Initialize job
console.log("Ringover daily data fetch scheduler initialized");

module.exports = {
  fetchAndSaveYesterdayCalls,
  manuallyRunSync,
  syncDateRange,
};
