/**
 * Daily Invoice Email Cron
 * -------------------------------------------------------------------------
 * Schedules the daily invoice email job on THIS server (not the separate
 * cron-job server). The send time is configurable via the admin settings UI
 * and is interpreted in the configured timezone (Europe/Paris by default),
 * so the client controls exactly when emails go out on the French clock.
 *
 * Whenever the settings change, call rescheduleInvoiceEmailCron() to apply
 * the new time / enabled state without a server restart.
 */

const cron = require("node-cron");
const InvoiceEmailSettings = require("../models/InvoiceEmailSettings");
const { runDailyInvoiceEmails } = require("./dailyInvoiceEmailService");

let cronJob = null;
let isExecuting = false;
let currentExpression = null;
let currentTimezone = null;
let currentEnabled = false;

/**
 * Convert an "HH:mm" time into a daily cron expression: "m h * * *".
 */
function timeToCronExpression(sendTime) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(sendTime || "");
  if (!match) {
    console.warn(`[InvoiceEmailCron] Invalid sendTime "${sendTime}", defaulting to 07:00`);
    return "0 7 * * *";
  }
  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  return `${minute} ${hour} * * *`;
}

async function executeJob() {
  if (isExecuting) {
    console.log("[InvoiceEmailCron] Previous run still executing, skipping this trigger");
    return;
  }
  isExecuting = true;
  try {
    console.log("[InvoiceEmailCron] Triggered by schedule");
    await runDailyInvoiceEmails({ trigger: "cron" });
  } catch (err) {
    console.error("[InvoiceEmailCron] Error executing job:", err.message);
  } finally {
    isExecuting = false;
  }
}

/**
 * (Re)build the cron schedule from the current settings.
 * Safe to call repeatedly — it tears down any existing job first.
 */
async function rescheduleInvoiceEmailCron() {
  const settings = await InvoiceEmailSettings.getSettings();

  // Tear down existing job
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }

  currentEnabled = settings.enabled;
  currentTimezone = settings.timezone || "Europe/Paris";
  currentExpression = timeToCronExpression(settings.sendTime);

  if (!settings.enabled) {
    console.log("[InvoiceEmailCron] Job is disabled — not scheduling");
    return getCronStatus();
  }

  if (!cron.validate(currentExpression)) {
    console.error(`[InvoiceEmailCron] Invalid cron expression "${currentExpression}" — not scheduling`);
    return getCronStatus();
  }

  cronJob = cron.schedule(currentExpression, executeJob, {
    scheduled: true,
    timezone: currentTimezone,
  });

  console.log(
    `[InvoiceEmailCron] Scheduled at ${settings.sendTime} (${currentTimezone}) — cron "${currentExpression}"`
  );
  return getCronStatus();
}

/**
 * Initialise on server startup.
 */
async function initInvoiceEmailCron() {
  try {
    await rescheduleInvoiceEmailCron();
    console.log("[InvoiceEmailCron] Initialised");
  } catch (err) {
    console.error("[InvoiceEmailCron] Failed to initialise:", err.message);
  }
}

function stopInvoiceEmailCron() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    console.log("[InvoiceEmailCron] Stopped");
  }
}

function getCronStatus() {
  return {
    scheduled: cronJob !== null,
    enabled: currentEnabled,
    isExecuting,
    cronExpression: currentExpression,
    timezone: currentTimezone,
  };
}

module.exports = {
  initInvoiceEmailCron,
  rescheduleInvoiceEmailCron,
  stopInvoiceEmailCron,
  getCronStatus,
};
