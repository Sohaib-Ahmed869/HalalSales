// utils/time-parser.js - Utility for parsing DeskTime time formats
/**
 * Parse time string to hours
 * Handles formats like "2h 30m", "45m", "3h", etc.
 *
 * @param {string} timeStr - Time string to parse
 * @returns {number} - Time in hours (decimal)
 */
function parseTimeToHours(timeStr) {
  if (!timeStr) return 0;

  // Convert string to lowercase and trim whitespace
  timeStr = timeStr.toLowerCase().trim();

  let hours = 0;

  // Match hours pattern (e.g., "2h" in "2h 30m")
  const hoursMatch = timeStr.match(/(\d+)\s*h/);
  if (hoursMatch && hoursMatch[1]) {
    hours += parseInt(hoursMatch[1], 10);
  }

  // Match minutes pattern (e.g., "30m" in "2h 30m")
  const minutesMatch = timeStr.match(/(\d+)\s*m/);
  if (minutesMatch && minutesMatch[1]) {
    hours += parseInt(minutesMatch[1], 10) / 60;
  }

  return hours;
}

/**
 * Parse time range string to start and end Date objects
 * Handles formats like "9:00 AM - 5:30 PM"
 *
 * @param {string} timeRangeStr - Time range string to parse
 * @param {Date} baseDate - Base date to use (defaults to today)
 * @returns {Object} - Object with start and end properties as Date objects
 */
function parseTimeRange(timeRangeStr, baseDate = new Date()) {
  if (!timeRangeStr) {
    return { start: null, end: null };
  }

  const parts = timeRangeStr.split("-").map((part) => part.trim());
  if (parts.length !== 2) {
    return { start: null, end: null };
  }

  const startTime = parts[0];
  const endTime = parts[1];

  const startDate = new Date(baseDate);
  const endDate = new Date(baseDate);

  // Parse start time
  const startParts = parseSingleTime(startTime);
  if (startParts) {
    startDate.setHours(startParts.hours);
    startDate.setMinutes(startParts.minutes);
    startDate.setSeconds(0);
    startDate.setMilliseconds(0);
  } else {
    startDate = null;
  }

  // Parse end time
  const endParts = parseSingleTime(endTime);
  if (endParts) {
    endDate.setHours(endParts.hours);
    endDate.setMinutes(endParts.minutes);
    endDate.setSeconds(0);
    endDate.setMilliseconds(0);
  } else {
    endDate = null;
  }

  return { start: startDate, end: endDate };
}

/**
 * Parse a single time string like "9:00 AM" to hours and minutes
 *
 * @param {string} timeStr - Time string to parse
 * @returns {Object|null} - Object with hours and minutes properties or null if invalid
 */
function parseSingleTime(timeStr) {
  // Handle 12-hour format with AM/PM
  const twelveHourMatch = timeStr.match(/(\d+):?(\d*)?\s*(am|pm)/i);
  if (twelveHourMatch) {
    let hours = parseInt(twelveHourMatch[1], 10);
    const minutes = twelveHourMatch[2] ? parseInt(twelveHourMatch[2], 10) : 0;
    const period = twelveHourMatch[3].toLowerCase();

    // Adjust hours for PM
    if (period === "pm" && hours < 12) {
      hours += 12;
    }
    // Adjust 12 AM to 0 hours
    if (period === "am" && hours === 12) {
      hours = 0;
    }

    return { hours, minutes };
  }

  // Handle 24-hour format
  const twentyFourHourMatch = timeStr.match(/(\d+):(\d+)/);
  if (twentyFourHourMatch) {
    const hours = parseInt(twentyFourHourMatch[1], 10);
    const minutes = parseInt(twentyFourHourMatch[2], 10);
    return { hours, minutes };
  }

  return null;
}

/**
 * Calculate time difference in hours between two time strings
 *
 * @param {string} startTimeStr - Start time string
 * @param {string} endTimeStr - End time string
 * @param {Date} baseDate - Base date to use (defaults to today)
 * @returns {number} - Difference in hours (decimal)
 */
function calculateTimeDifference(
  startTimeStr,
  endTimeStr,
  baseDate = new Date()
) {
  const start = parseSingleTime(startTimeStr);
  const end = parseSingleTime(endTimeStr);

  if (!start || !end) return 0;

  const startDate = new Date(baseDate);
  startDate.setHours(start.hours, start.minutes, 0, 0);

  const endDate = new Date(baseDate);
  endDate.setHours(end.hours, end.minutes, 0, 0);

  // Handle end time being on the next day
  if (endDate < startDate) {
    endDate.setDate(endDate.getDate() + 1);
  }

  // Calculate difference in milliseconds and convert to hours
  const diffMs = endDate - startDate;
  return diffMs / (1000 * 60 * 60);
}

module.exports = {
  parseTimeToHours,
  parseTimeRange,
  parseSingleTime,
  calculateTimeDifference,
};
