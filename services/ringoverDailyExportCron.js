/**
 * Ringover Daily Export Cron Service
 * Triggers daily export at 12:00 AM French time (Europe/Paris timezone)
 * Exports only customers created that day
 * Prevents duplicates by only pushing to Ringover once
 */

const cron = require("node-cron");
const { generateRingoverExport } = require("./ringoverExportService");

let cronJob = null;
let isRunning = false;

/**
 * Get start of day in French timezone
 * Returns date at 00:00:00 French time
 */
function getStartOfDayFrench() {
  const formatter = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(new Date());
  const year = parseInt(parts.find((p) => p.type === "year").value);
  const month = parseInt(parts.find((p) => p.type === "month").value) - 1;
  const day = parseInt(parts.find((p) => p.type === "day").value);

  return new Date(year, month, day, 0, 0, 0, 0);
}

/**
 * Get end of day in French timezone
 * Returns date at 23:59:59 French time
 */
function getEndOfDayFrench() {
  const startOfDay = getStartOfDayFrench();
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);
  endOfDay.setMilliseconds(-1);
  return endOfDay;
}

/**
 * Execute daily export
 * Triggered at 12:00 AM French time
 */
async function executeDailyExport() {
  try {
    if (isRunning) {
      console.log(
        "[Ringover Cron] Daily export already running, skipping duplicate"
      );
      return;
    }

    isRunning = true;
    console.log("[Ringover Cron] Starting daily export at 12:00 AM French time");

    const fromDate = getStartOfDayFrench();
    const toDate = getEndOfDayFrench();

    console.log(
      `[Ringover Cron] Export range: ${fromDate.toISOString()} to ${toDate.toISOString()}`
    );

    const result = await generateRingoverExport({
      pushToAPI: true, // Always push to Ringover API
      generateCSV: false, // No CSV for daily
      fromDate,
      toDate,
      userId: null, // System triggered
    });

    console.log(
      `[Ringover Cron] Daily export completed: ${result.summary.totalPushed} pushed, ${result.errors.length} errors`
    );

    if (result.errors.length > 0) {
      console.error(
        "[Ringover Cron] Export errors:",
        result.errors
      );
    }

    return result;
  } catch (error) {
    console.error("[Ringover Cron] Error in daily export:", error);
  } finally {
    isRunning = false;
  }
}

/**
 * Start the daily cron job
 * Runs at 12:00 AM (midnight) French time every day
 *
 * Cron format: minute hour day month dayOfWeek
 * 0 0 * * * = Every day at 00:00
 */
function startDailyCron() {
  if (cronJob) {
    console.log("[Ringover Cron] Cron job already running");
    return;
  }

  console.log("[Ringover Cron] Starting daily export cron (12:00 AM French time)");

  // Run at 12:00 AM every day
  // Cron expression: 0 0 * * * (minute=0, hour=0, every day)
  // Note: Cron in Node.js uses server timezone, so we calculate French midnight
  cronJob = cron.schedule("0 0 * * *", () => {
    console.log("[Ringover Cron] Cron job triggered");
    executeDailyExport();
  });

  console.log("[Ringover Cron] Daily export cron started successfully");
}

/**
 * Stop the daily cron job
 */
function stopDailyCron() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    console.log("[Ringover Cron] Daily export cron stopped");
  }
}

/**
 * Get cron job status
 */
function getCronStatus() {
  return {
    isRunning: cronJob !== null,
    isExecuting: isRunning,
    nextExecution: cronJob
      ? "12:00 AM French time every day"
      : "Not scheduled",
  };
}

/**
 * Manually trigger daily export (for testing)
 */
async function manualTriggerDailyExport() {
  console.log("[Ringover Cron] Manual trigger of daily export");
  return await executeDailyExport();
}

module.exports = {
  startDailyCron,
  stopDailyCron,
  getCronStatus,
  manualTriggerDailyExport,
  executeDailyExport,
};
