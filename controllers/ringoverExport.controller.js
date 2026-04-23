/**
 * Ringover Export Controller
 * Handles API endpoints for Ringover contact export
 */

const { generateRingoverExport } = require("../services/ringoverExportService");

/**
 * POST /api/ringover-export/generate
 * Trigger a new Ringover contact export
 *
 * Query params:
 *   - pushToAPI: boolean (default: true) - Push to Ringover API
 *   - generateCSV: boolean (default: true) - Generate CSV files
 *   - fromDate: ISO date string (optional) - Filter customers created after this date
 *   - toDate: ISO date string (optional) - Filter customers created before this date
 */
async function generateExport(req, res) {
  try {
    const pushToAPI = req.query.pushToAPI !== "false"; // default true
    const generateCSV = req.query.generateCSV !== "false"; // default true
    const fromDate = req.query.fromDate ? new Date(req.query.fromDate) : null;
    const toDate = req.query.toDate ? new Date(req.query.toDate) : null;
    const userId = req.user?._id || null;

    console.log(
      `[RingoverController] Export: pushToAPI=${pushToAPI}, generateCSV=${generateCSV}, fromDate=${fromDate}, toDate=${toDate}`
    );

    const result = await generateRingoverExport({
      pushToAPI,
      generateCSV,
      fromDate,
      toDate,
      userId,
    });

    return res.status(200).json({
      success: true,
      message: "Ringover export completed",
      data: result,
    });
  } catch (error) {
    console.error("[RingoverController] Export error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to generate Ringover export",
      error: error.message,
    });
  }
}

/**
 * POST /api/ringover-export/daily
 * Trigger daily export for customers created today
 */
async function generateDailyExport(req, res) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    console.log(
      `[RingoverController] Daily export: ${today.toISOString()} to ${tomorrow.toISOString()}`
    );

    const result = await generateRingoverExport({
      pushToAPI: true, // Always push to API for daily exports
      generateCSV: false, // No CSV needed for daily
      fromDate: today,
      toDate: tomorrow,
      userId: req.user?._id || null,
    });

    return res.status(200).json({
      success: true,
      message: "Daily export completed",
      data: result,
    });
  } catch (error) {
    console.error("[RingoverController] Daily export error:", error);
    return res.status(500).json({
      success: false,
      message: error.message || "Failed to generate daily export",
      error: error.message,
    });
  }
}

module.exports = {
  generateExport,
  generateDailyExport,
};
