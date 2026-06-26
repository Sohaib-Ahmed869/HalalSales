/**
 * Controller for the Automated Daily Invoice Email settings + manual actions.
 */
const InvoiceEmailSettings = require("../models/InvoiceEmailSettings");
const {
  runDailyInvoiceEmails,
  previewDailyInvoiceEmails,
} = require("../services/dailyInvoiceEmailService");
const {
  rescheduleInvoiceEmailCron,
  getCronStatus,
} = require("../services/dailyInvoiceEmailCron");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET /api/invoice-email-settings
exports.getSettings = async (req, res) => {
  try {
    const settings = await InvoiceEmailSettings.getSettings();
    res.status(200).json({
      success: true,
      data: { settings, cronStatus: getCronStatus() },
    });
  } catch (error) {
    console.error("Error fetching invoice email settings:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /api/invoice-email-settings
exports.updateSettings = async (req, res) => {
  try {
    const {
      enabled,
      sendTime,
      timezone,
      excludePOS,
      adminSummaryEnabled,
      adminSummaryRecipients,
    } = req.body;

    const settings = await InvoiceEmailSettings.getSettings();

    if (enabled !== undefined) settings.enabled = !!enabled;
    if (excludePOS !== undefined) settings.excludePOS = !!excludePOS;
    if (adminSummaryEnabled !== undefined)
      settings.adminSummaryEnabled = !!adminSummaryEnabled;
    if (timezone !== undefined && timezone) settings.timezone = timezone;

    if (sendTime !== undefined) {
      if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(sendTime)) {
        return res.status(400).json({
          success: false,
          message: "sendTime must be in HH:mm 24-hour format (e.g. 07:30)",
        });
      }
      settings.sendTime = sendTime;
    }

    if (adminSummaryRecipients !== undefined) {
      const list = Array.isArray(adminSummaryRecipients)
        ? adminSummaryRecipients
        : String(adminSummaryRecipients)
            .split(/[,;\s]+/)
            .filter(Boolean);
      const cleaned = list.map((e) => e.trim()).filter(Boolean);
      const invalid = cleaned.filter((e) => !EMAIL_REGEX.test(e));
      if (invalid.length) {
        return res.status(400).json({
          success: false,
          message: `Invalid admin email(s): ${invalid.join(", ")}`,
        });
      }
      settings.adminSummaryRecipients = cleaned;
    }

    await settings.save();

    // Apply the new schedule immediately (no server restart needed)
    await rescheduleInvoiceEmailCron();

    res.status(200).json({
      success: true,
      message: "Settings updated",
      data: { settings, cronStatus: getCronStatus() },
    });
  } catch (error) {
    console.error("Error updating invoice email settings:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/invoice-email-settings/preview
exports.preview = async (req, res) => {
  try {
    const preview = await previewDailyInvoiceEmails();
    res.status(200).json({ success: true, data: preview });
  } catch (error) {
    console.error("Error previewing invoice emails:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/invoice-email-settings/run-now
exports.runNow = async (req, res) => {
  try {
    const summary = await runDailyInvoiceEmails({ trigger: "manual" });
    res.status(200).json({
      success: true,
      message: `Run complete: ${summary.customersEmailed} emailed, ${summary.customersSkipped} skipped, ${summary.customersFailed} failed`,
      data: summary,
    });
  } catch (error) {
    console.error("Error running invoice emails:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
