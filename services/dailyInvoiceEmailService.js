/**
 * Daily Invoice Email Service
 * -------------------------------------------------------------------------
 * Sends the previous day's invoices to customers automatically, once per day,
 * at a configurable French-clock time. Runs ON THIS SERVER (not the separate
 * cron-job server) and is driven by the InvoiceEmailSettings singleton.
 *
 * Behaviour (configured via the admin settings UI):
 *   - Picks invoices whose DocDate falls on the PREVIOUS calendar day
 *     (in the configured timezone, French by default).
 *   - Optionally excludes POS / cash-register sales (isPOS).
 *   - Skips invoices already emailed by this job (autoEmail.sentAt) so a
 *     customer is never emailed the same invoice twice.
 *   - Groups invoices per customer and sends ONE email with a combined PDF.
 *   - Customers with no / invalid email are skipped and reported (the client
 *     noted many customers have no email stored).
 *   - Writes an EmailLog entry for every send (handled inside sendEmail).
 *   - Optionally emails a run summary to admin recipients.
 */

const Invoice = require("../models/Invoice");
const Customer = require("../models/Customer");
const EmailLog = require("../models/EmailLog");
const InvoiceEmailSettings = require("../models/InvoiceEmailSettings");
const { sendEmail } = require("../utils/emailService");
const { buildInvoicesPdfBuffer } = require("../controllers/invoicePdfController");

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POS / cash-register walk-in customer. These invoices are POS sales even
// when the isPOS flag was never set, so this CardCode is excluded when
// excludePOS is on.
const POS_CARD_CODE = "C9999";

/**
 * Compute the UTC bounds of the previous calendar day in a given timezone.
 *
 * SAP B1 DocDate values are date-only (midnight), so we match the previous
 * day's date against a [00:00:00.000, 23:59:59.999] UTC window for that date.
 * The timezone only decides WHICH calendar date "yesterday" is.
 *
 * @param {string} timezone - IANA timezone, e.g. "Europe/Paris"
 * @returns {{ dateStr: string, from: Date, to: Date }}
 */
function getPreviousDayRange(timezone = "Europe/Paris") {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  // Today's date in the target timezone (en-CA => YYYY-MM-DD)
  const parts = formatter.formatToParts(new Date());
  const y = parseInt(parts.find((p) => p.type === "year").value, 10);
  const m = parseInt(parts.find((p) => p.type === "month").value, 10);
  const d = parseInt(parts.find((p) => p.type === "day").value, 10);

  // Previous day, computed in UTC to avoid server-timezone drift
  const prev = new Date(Date.UTC(y, m - 1, d));
  prev.setUTCDate(prev.getUTCDate() - 1);

  const yyyy = prev.getUTCFullYear();
  const mm = String(prev.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(prev.getUTCDate()).padStart(2, "0");
  const dateStr = `${yyyy}-${mm}-${dd}`;

  return {
    dateStr,
    from: new Date(`${dateStr}T00:00:00.000Z`),
    to: new Date(`${dateStr}T23:59:59.999Z`),
  };
}

function formatEuro(amount, currency = "EUR") {
  const value = Number(amount || 0);
  try {
    return new Intl.NumberFormat("fr-FR", {
      style: "currency",
      currency: currency || "EUR",
    }).format(value);
  } catch (e) {
    return `${value.toFixed(2)} ${currency || "EUR"}`;
  }
}

/**
 * Find the previous day's invoices eligible for emailing, grouped by customer.
 * Returns the raw query result plus the grouped structure with resolved emails.
 */
async function collectInvoicesForPreviousDay(settings) {
  const { from, to, dateStr } = getPreviousDayRange(settings.timezone);

  const query = {
    DocDate: { $gte: from, $lte: to },
    // Never re-send an invoice this job already emailed.
    // Querying for null matches both missing fields and null values.
    "autoEmail.sentAt": null,
  };

  if (settings.excludePOS) {
    // Exclude only the POS walk-in customer (C9999); their isPOS flag is often
    // not set, so filter by CardCode. Other invoices are kept.
    query.CardCode = { $ne: POS_CARD_CODE };
  }

  const invoices = await Invoice.find(query).lean();

  // Resolve customer emails in one query
  const cardCodes = [...new Set(invoices.map((inv) => inv.CardCode).filter(Boolean))];
  const customers = await Customer.find({ CardCode: { $in: cardCodes } })
    .select("CardCode Email")
    .lean();

  const emailByCardCode = {};
  customers.forEach((c) => {
    emailByCardCode[c.CardCode] = c.Email;
  });

  // Group by customer
  const groups = {};
  invoices.forEach((inv) => {
    const cardCode = inv.CardCode || "UNKNOWN";
    if (!groups[cardCode]) {
      groups[cardCode] = {
        cardCode,
        customerName: inv.CardName,
        email: (emailByCardCode[cardCode] || "").trim(),
        invoices: [],
      };
    }
    groups[cardCode].invoices.push(inv);
  });

  return { dateStr, from, to, invoices, groups: Object.values(groups) };
}

/**
 * Preview what the next run would send (no emails are sent, nothing is marked).
 */
async function previewDailyInvoiceEmails() {
  const settings = await InvoiceEmailSettings.getSettings();
  const { dateStr, from, to, invoices, groups } = await collectInvoicesForPreviousDay(settings);

  // --- DEBUG: log basic info for the invoices in this preview ---------------
  // Helps verify whether POS invoices are leaking in. POS indicators:
  //   - isPOS flag, paymentMethod starting with "POS-"
  //   - a non-empty U_EPOSNo (SAP EPOS/POS receipt number)
  //   - CardCode C9999 (POS walk-in customer)
  const looksPOS = (inv) =>
    inv.isPOS === true ||
    (inv.paymentMethod || "").startsWith("POS-") ||
    !!(inv.U_EPOSNo && String(inv.U_EPOSNo).trim()) ||
    inv.CardCode === POS_CARD_CODE;

  const posCount = invoices.filter(looksPOS).length;
  console.log(
    `[InvoiceEmail][PREVIEW] ${dateStr}: ${invoices.length} invoice(s) collected ` +
      `(excludePOS=${settings.excludePOS}) — ${posCount} look like POS by content`
  );

  const sample = invoices.slice(0, 50);
  sample.forEach((inv) => {
    console.log(
      `[InvoiceEmail][PREVIEW]   DocNum=${inv.DocNum} ` +
        `Card=${inv.CardCode} (${inv.CardName || ""}) ` +
        `isPOS=${inv.isPOS} payMethod=${inv.paymentMethod || "-"} ` +
        `U_EPOSNo=${inv.U_EPOSNo || "-"} ` +
        `Total=${inv.DocTotal} ${inv.DocCurrency || ""}` +
        (looksPOS(inv) ? "  <-- POS?" : "")
    );
  });
  if (invoices.length > sample.length) {
    console.log(
      `[InvoiceEmail][PREVIEW]   ...and ${invoices.length - sample.length} more (logging first ${sample.length} only)`
    );
  }
  // --------------------------------------------------------------------------

  const willSend = [];
  const willSkip = [];

  for (const g of groups) {
    if (!g.email || !EMAIL_REGEX.test(g.email)) {
      willSkip.push({
        cardCode: g.cardCode,
        customerName: g.customerName,
        invoiceCount: g.invoices.length,
        reason: !g.email ? "No email address stored" : "Invalid email format",
      });
    } else {
      willSend.push({
        cardCode: g.cardCode,
        customerName: g.customerName,
        email: g.email,
        invoiceCount: g.invoices.length,
        invoiceNumbers: g.invoices.map((i) => i.DocNum),
      });
    }
  }

  return {
    dateRange: { dateStr, from, to },
    totalInvoices: invoices.length,
    totalCustomers: groups.length,
    willSend,
    willSkip,
    settings: {
      enabled: settings.enabled,
      sendTime: settings.sendTime,
      timezone: settings.timezone,
      excludePOS: settings.excludePOS,
    },
  };
}

/**
 * Run the daily invoice email job.
 *
 * @param {Object} [opts]
 * @param {"cron"|"manual"} [opts.trigger="manual"]
 * @returns {Promise<Object>} run summary
 */
async function runDailyInvoiceEmails({ trigger = "manual" } = {}) {
  const settings = await InvoiceEmailSettings.getSettings();

  const summary = {
    trigger,
    status: "success",
    dateRange: {},
    totalInvoices: 0,
    customersEmailed: 0,
    customersFailed: 0,
    customersSkipped: 0,
    sent: [],
    failed: [],
    skipped: [],
    error: null,
  };

  try {
    const { dateStr, from, to, invoices, groups } = await collectInvoicesForPreviousDay(settings);
    summary.dateRange = { dateStr, from, to };
    summary.totalInvoices = invoices.length;

    console.log(
      `[InvoiceEmail] Run (${trigger}) for ${dateStr}: ${invoices.length} invoice(s) across ${groups.length} customer(s)`
    );

    if (invoices.length === 0) {
      summary.status = "no_invoices";
      await persistLastRun(settings, summary);
      return summary;
    }

    for (const group of groups) {
      const { cardCode, customerName, email, invoices: custInvoices } = group;

      // Skip customers without a usable email (logged, not failed)
      if (!email || !EMAIL_REGEX.test(email)) {
        summary.skipped.push({
          cardCode,
          customerName,
          invoiceCount: custInvoices.length,
          reason: !email ? "No email address stored" : "Invalid email format",
        });
        continue;
      }

      try {
        const pdfBuffer = await buildInvoicesPdfBuffer(custInvoices);

        const invoiceNumbers = custInvoices.map((inv) => inv.DocNum).join(", ");
        const totalAmount = custInvoices.reduce((s, inv) => s + (inv.DocTotal || 0), 0);
        const currency = custInvoices[0].DocCurrency || "EUR";
        const single = custInvoices.length === 1;

        const subject = single
          ? `Facture #${custInvoices[0].DocNum} - ${customerName}`
          : `Factures (${custInvoices.length}) - ${customerName}`;

        const text = `
Bonjour,

Veuillez trouver ci-joint ${single ? "votre facture" : `vos ${custInvoices.length} factures`} du ${dateStr}.

${single ? "Numéro: " : "Numéros: "}${invoiceNumbers}
Montant total: ${formatEuro(totalAmount, currency)}

Cordialement,
Halal Food Service
        `.trim();

        const filename = single
          ? `Facture-${custInvoices[0].DocNum}.pdf`
          : `Factures-${cardCode}-${dateStr}.pdf`;

        await sendEmail({
          to: email,
          subject,
          text,
          attachments: [
            { filename, content: pdfBuffer, contentType: "application/pdf" },
          ],
          emailType: "invoice",
          customerCardCode: cardCode,
          sentByName: "Automated Daily Invoice Email",
          metadata: {
            automated: true,
            trigger,
            docDate: dateStr,
            invoiceIds: custInvoices.map((i) => String(i._id)),
            invoiceNumbers: custInvoices.map((i) => i.DocNum),
          },
        });

        // Mark each invoice as emailed so it is never re-sent
        const sentAt = new Date();
        await Invoice.updateMany(
          { _id: { $in: custInvoices.map((i) => i._id) } },
          { $set: { "autoEmail.sentAt": sentAt, "autoEmail.recipient": email } }
        );

        summary.sent.push({
          cardCode,
          customerName,
          email,
          invoiceCount: custInvoices.length,
          invoiceNumbers: custInvoices.map((inv) => inv.DocNum),
        });

        console.log(`[InvoiceEmail] ✅ Sent ${custInvoices.length} invoice(s) to ${email} (${cardCode})`);
      } catch (err) {
        console.error(`[InvoiceEmail] ❌ Failed for ${cardCode}:`, err.message);
        summary.failed.push({
          cardCode,
          customerName,
          email,
          invoiceCount: custInvoices.length,
          error: err.message,
        });
      }
    }

    summary.customersEmailed = summary.sent.length;
    summary.customersFailed = summary.failed.length;
    summary.customersSkipped = summary.skipped.length;

    if (summary.failed.length > 0) {
      summary.status = summary.sent.length > 0 ? "partial" : "failed";
    }

    await persistLastRun(settings, summary);
    await maybeSendAdminSummary(settings, summary);

    console.log(
      `[InvoiceEmail] Run complete: ${summary.customersEmailed} emailed, ${summary.customersFailed} failed, ${summary.customersSkipped} skipped`
    );

    return summary;
  } catch (err) {
    console.error("[InvoiceEmail] Fatal error during run:", err);
    summary.status = "failed";
    summary.error = err.message;
    try {
      await persistLastRun(settings, summary);
      await maybeSendAdminSummary(settings, summary);
    } catch (e) {
      console.error("[InvoiceEmail] Failed to persist/notify after fatal error:", e.message);
    }
    return summary;
  }
}

/**
 * Save the run result onto the settings document for display in the admin UI.
 */
async function persistLastRun(settings, summary) {
  settings.lastRun = {
    at: new Date(),
    trigger: summary.trigger,
    status: summary.status,
    dateRange: {
      from: summary.dateRange.from || null,
      to: summary.dateRange.to || null,
    },
    totalInvoices: summary.totalInvoices,
    customersEmailed: summary.customersEmailed,
    customersFailed: summary.customersFailed,
    customersSkipped: summary.customersSkipped,
    skipped: summary.skipped,
    failed: summary.failed,
    error: summary.error,
  };
  await settings.save();
}

/**
 * Email a run summary to the configured admin recipients (if enabled).
 */
async function maybeSendAdminSummary(settings, summary) {
  if (!settings.adminSummaryEnabled) return;
  const recipients = (settings.adminSummaryRecipients || []).filter((r) =>
    EMAIL_REGEX.test((r || "").trim())
  );
  if (recipients.length === 0) return;

  const dateStr = summary.dateRange.dateStr || "";

  const skippedLines = summary.skipped.length
    ? summary.skipped
        .map(
          (s) =>
            `  • ${s.customerName || s.cardCode} (${s.cardCode}) — ${s.invoiceCount} invoice(s) — ${s.reason}`
        )
        .join("\n")
    : "  (none)";

  const failedLines = summary.failed.length
    ? summary.failed
        .map(
          (f) =>
            `  • ${f.customerName || f.cardCode} (${f.cardCode}) — ${f.error}`
        )
        .join("\n")
    : "  (none)";

  const text = `
Automated Daily Invoice Email — Summary
Invoice date: ${dateStr}
Triggered: ${summary.trigger}
Status: ${summary.status}

Invoices found: ${summary.totalInvoices}
Customers emailed: ${summary.customersEmailed}
Customers failed: ${summary.customersFailed}
Customers skipped (no/invalid email): ${summary.customersSkipped}

Skipped customers (no email stored — please update their email):
${skippedLines}

Failed sends:
${failedLines}
${summary.error ? `\nFatal error: ${summary.error}\n` : ""}
— Halal Food Service automated system
  `.trim();

  try {
    await sendEmail({
      to: recipients,
      subject: `[Auto Invoices] ${dateStr} — ${summary.customersEmailed} sent, ${summary.customersSkipped} skipped, ${summary.customersFailed} failed`,
      text,
      emailType: "other",
      sentByName: "Automated Daily Invoice Email",
      metadata: { automated: true, adminSummary: true, docDate: dateStr },
    });
  } catch (err) {
    console.error("[InvoiceEmail] Failed to send admin summary:", err.message);
  }
}

module.exports = {
  runDailyInvoiceEmails,
  previewDailyInvoiceEmails,
  collectInvoicesForPreviousDay,
  getPreviousDayRange,
};
