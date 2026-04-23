/**
 * Ringover Contact Export Service
 * Exports customer contacts in Ringover CSV format with custom field mapping
 *
 * Field Mapping:
 * - LastName: Customer Full Name (CardName)
 * - FirstName: Customer Agent Name (Assigned User's firstName)
 * - Company: Customer Company/Business (company field)
 * - Phone1: Primary phone number (phoneNumber - E164 format)
 * - Phone2: Secondary phone number (additionalPhoneNumbers[0] - E164 format)
 */

const { uploadBufferWithKey } = require("./whatsappS3Upload");
const Customer = require("../models/Customer");
const User = require("../models/User");
const RingoverExport = require("../models/RingoverExport");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");

const CONTACTS_PER_FILE = 5000;
const RINGOVER_EXPORT_PATH = "ringover-exports";
const RINGOVER_API_BASE = "https://api.ringover.com/v2";
const RINGOVER_API_KEY = process.env.RINGOVER_API_KEY;

/**
 * Normalize phone number to E164 format
 * @param {string} phone - Phone number to normalize
 * @returns {string|null} E164 formatted phone or null if invalid
 */
function normalizeToE164(phone) {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (!digits || digits.length < 7) return null;
  return "+" + digits;
}

/**
 * Generate CSV row with proper escaping for Ringover
 * @param {string} lastName - Customer full name
 * @param {string} firstName - Agent first name
 * @param {string} company - Customer company
 * @param {string} phone1 - Primary phone (E164)
 * @param {string} phone2 - Secondary phone (E164) or empty
 * @returns {string} CSV row
 */
function generateCSVRow(lastName, firstName, company, phone1, phone2 = "") {
  const escape = (val) => {
    const str = String(val || "").trim();
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  return [
    escape(lastName),
    escape(firstName),
    escape(company),
    escape(phone1),
    escape(phone2),
  ].join(",");
}

/**
 * Get agent name from customer assignment
 * @param {ObjectId|string} assignedTo - User reference ID
 * @param {Map} userCache - Cache of fetched users
 * @returns {Promise<string>} Agent first name or "N/A"
 */
async function getAgentName(assignedTo, userCache) {
  if (!assignedTo) return "N/A";

  const userId = String(assignedTo);

  if (userCache.has(userId)) {
    return userCache.get(userId);
  }

  try {
    const user = await User.findById(userId).select("firstName").lean();
    const name = user ? user.firstName : "N/A";
    userCache.set(userId, name);
    return name;
  } catch (error) {
    console.error(`Error fetching user ${userId}:`, error.message);
    userCache.set(userId, "N/A");
    return "N/A";
  }
}

/**
 * Build contacts array from database with validation
 * @param {Object} options
 * @param {Date} options.fromDate - Only include customers created after this date
 * @param {Date} options.toDate - Only include customers created before this date
 * @returns {Promise<Array>} Array of valid contacts
 */
async function buildContactsArray(options = {}) {
  const { fromDate = null, toDate = null } = options;
  const contacts = [];
  const userCache = new Map();

  try {
    // Build query filter
    const filter = {
      $or: [
        { phoneNumber: { $exists: true, $ne: null, $ne: "" } },
        { additionalPhoneNumbers: { $exists: true, $ne: null, $not: { $size: 0 } } },
      ],
      status: { $in: ["active", "prospect", "pending"] },
    };

    // Add date filter if provided
    if (fromDate || toDate) {
      filter.createdAt = {};
      if (fromDate) filter.createdAt.$gte = fromDate;
      if (toDate) filter.createdAt.$lt = toDate;
    }

    const customers = await Customer.find(filter)
      .select(
        "CardName company phoneNumber additionalPhoneNumbers assignedTo firstName lastName createdAt"
      )
      .lean()
      .limit(100000);

    for (const customer of customers) {
      const lastName = customer.CardName || customer.firstName || "Unknown";
      const firstName = await getAgentName(customer.assignedTo, userCache);
      const company = customer.company || "N/A";

      const phone1 = normalizeToE164(customer.phoneNumber);
      const phone2 = customer.additionalPhoneNumbers?.[0]
        ? normalizeToE164(customer.additionalPhoneNumbers[0])
        : null;

      if (!phone1) continue;
      if (lastName === "Unknown" && firstName === "N/A") continue;

      contacts.push({
        lastName,
        firstName,
        company,
        phone1,
        phone2: phone2 || "",
        customerId: customer._id,
        phone: phone1,
      });
    }

    console.log(
      `[Ringover Export] Built ${contacts.length} valid contacts`
    );
    return contacts;
  } catch (error) {
    console.error("Error building contacts array:", error);
    throw new Error(`Failed to build contacts: ${error.message}`);
  }
}

/**
 * Generate CSV buffer with UTF-8 BOM
 * @param {Array} contacts - Array of contact objects
 * @returns {Buffer} CSV buffer with BOM
 */
function generateCSVBuffer(contacts) {
  const csvLines = [];
  csvLines.push(
    generateCSVRow("Lastname", "firstname", "company", "phone1", "phone2")
  );

  for (const contact of contacts) {
    csvLines.push(
      generateCSVRow(
        contact.lastName,
        contact.firstName,
        contact.company,
        contact.phone1,
        contact.phone2
      )
    );
  }

  const csvText = csvLines.join("\n");
  const buffer = Buffer.concat([
    Buffer.from("\uFEFF"),
    Buffer.from(csvText, "utf8"),
  ]);

  return buffer;
}

/**
 * Push contacts directly to Ringover API
 * @param {Array} contacts - Contacts to push
 * @returns {Promise<Object>} Result with success/error info
 */
async function pushToRingoverAPI(contacts) {
  if (!RINGOVER_API_KEY) {
    const error = "RINGOVER_API_KEY not configured in environment";
    console.error(`[Ringover API] ${error}`);
    return {
      success: false,
      pushed: 0,
      skipped: 0,
      errors: [error],
    };
  }

  if (!contacts || contacts.length === 0) {
    return { success: true, pushed: 0, skipped: 0, errors: [] };
  }

  const errors = [];
  let pushed = 0;
  let skipped = 0;

  try {
    // Ringover API endpoint for bulk import
    const endpoint = `${RINGOVER_API_BASE}/contacts/import`;

    // Transform contacts to Ringover format
    const ringoverContacts = contacts.map((contact) => ({
      lastname: contact.lastName,
      firstname: contact.firstName,
      company: contact.company,
      phone: contact.phone1,
      phone2: contact.phone2 || undefined,
      source: "HalalSales_Auto",
      created_date: new Date().toISOString(),
    }));

    console.log(
      `[Ringover API] Pushing ${ringoverContacts.length} contacts to Ringover: ${endpoint}`
    );

    const response = await axios.post(
      endpoint,
      {
        contacts: ringoverContacts,
      },
      {
        headers: {
          Authorization: `Bearer ${RINGOVER_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 30000,
      }
    );

    if (response.data && response.data.success) {
      pushed = response.data.imported || ringoverContacts.length;
      skipped = response.data.skipped || 0;
      console.log(
        `[Ringover API] ✅ Success: ${pushed} pushed, ${skipped} skipped`
      );
    } else {
      throw new Error(
        `Ringover API returned: ${response.data?.message || "Unknown error"}`
      );
    }

    return { success: true, pushed, skipped, errors };
  } catch (error) {
    const status = error.response?.status;
    const data = error.response?.data;
    const errorMsg = data?.message || error.message;

    console.error(`[Ringover API] ❌ Error (${status}): ${errorMsg}`);

    if (status === 401) {
      console.error(
        "[Ringover API] ⚠️  Authentication failed. Verify RINGOVER_API_KEY in .env"
      );
    } else if (status === 404) {
      console.error(
        "[Ringover API] ⚠️  Endpoint not found. Check API documentation for correct endpoint"
      );
    }

    errors.push(`Ringover API error: ${errorMsg}`);
    return { success: false, pushed, skipped, errors };
  }
}

/**
 * Split contacts into multiple files if needed
 * @param {Array} contacts - All contacts
 * @returns {Array<Object>} Array of {fileName, contacts, index}
 */
function splitContactsIntoFiles(contacts) {
  const files = [];
  const totalFiles = Math.ceil(contacts.length / CONTACTS_PER_FILE);

  for (let i = 0; i < totalFiles; i++) {
    const startIdx = i * CONTACTS_PER_FILE;
    const endIdx = Math.min(startIdx + CONTACTS_PER_FILE, contacts.length);
    const fileContacts = contacts.slice(startIdx, endIdx);

    const timestamp = new Date().toISOString().split("T")[0];
    const fileIndex = totalFiles > 1 ? `_${i + 1}` : "";
    const fileName = `ringover_export_${timestamp}${fileIndex}.csv`;

    files.push({
      fileName,
      contacts: fileContacts,
      index: i + 1,
      totalFiles,
      recordCount: fileContacts.length,
    });
  }

  return files;
}

/**
 * Upload export file to S3
 * @param {Buffer} csvBuffer - CSV file buffer
 * @param {string} fileName - File name
 * @param {string} exportBatchId - Batch ID for grouping
 * @returns {Promise<Object>} Upload result with S3 key and URL
 */
async function uploadExportToS3(csvBuffer, fileName, exportBatchId) {
  const s3Key = `${RINGOVER_EXPORT_PATH}/${exportBatchId}/${fileName}`;

  try {
    const url = await uploadBufferWithKey({
      key: s3Key,
      buffer: csvBuffer,
      contentType: "text/csv",
    });

    return {
      s3Key,
      s3Url: url,
      fileName,
      fileSize: csvBuffer.length,
    };
  } catch (error) {
    console.error(`Error uploading ${fileName} to S3:`, error);
    throw new Error(`Failed to upload export to S3: ${error.message}`);
  }
}

/**
 * Main export function - generates and pushes Ringover exports
 * @param {Object} options
 * @param {boolean} options.pushToAPI - Push to Ringover API (default: true)
 * @param {boolean} options.generateCSV - Generate CSV files (default: true)
 * @param {Date} options.fromDate - Filter customers created after this date
 * @param {Date} options.toDate - Filter customers created before this date
 * @param {string} options.userId - User ID triggering the export (optional)
 * @returns {Promise<Object>} Export result
 */
async function generateRingoverExport(options = {}) {
  const {
    pushToAPI = true,
    generateCSV = true,
    fromDate = null,
    toDate = null,
    userId = null,
  } = options;

  const exportBatchId = uuidv4();
  const exportStartTime = new Date();

  try {
    console.log(
      `[Ringover Export] Starting batch: ${exportBatchId}, pushToAPI: ${pushToAPI}, generateCSV: ${generateCSV}`
    );

    const result = {
      batchId: exportBatchId,
      timestamp: exportStartTime,
      files: [],
      apiResult: null,
      summary: {
        totalContacts: 0,
        totalPushed: 0,
        totalSkipped: 0,
        fileCount: 0,
      },
      errors: [],
    };

    // Build contacts from database
    console.log("[Ringover Export] Building contacts from database");
    const contacts = await buildContactsArray({ fromDate, toDate });
    result.summary.totalContacts = contacts.length;

    if (contacts.length === 0) {
      console.log("[Ringover Export] No valid contacts found");
      result.summary.executionTimeMs = new Date() - exportStartTime;
      return result;
    }

    // Push to Ringover API if requested
    if (pushToAPI) {
      console.log("[Ringover Export] Pushing to Ringover API");
      const apiResult = await pushToRingoverAPI(contacts);
      result.apiResult = apiResult;
      result.summary.totalPushed = apiResult.pushed;
      result.summary.totalSkipped = apiResult.skipped;
      if (!apiResult.success && apiResult.errors.length > 0) {
        result.errors.push(...apiResult.errors);
      }
    }

    // Generate CSV files if requested
    if (generateCSV) {
      console.log("[Ringover Export] Generating CSV files");
      const exportFiles = splitContactsIntoFiles(contacts);

      for (const fileSpec of exportFiles) {
        try {
          const csvBuffer = generateCSVBuffer(fileSpec.contacts);
          const upload = await uploadExportToS3(
            csvBuffer,
            fileSpec.fileName,
            exportBatchId
          );

          result.files.push({
            ...upload,
            fileIndex: fileSpec.index,
            totalFiles: fileSpec.totalFiles,
            recordCount: fileSpec.recordCount,
          });

          result.summary.fileCount += 1;
          console.log(
            `[Ringover Export] File ${fileSpec.index}/${fileSpec.totalFiles} uploaded: ${fileSpec.recordCount} records`
          );
        } catch (error) {
          const msg = `Error processing file ${fileSpec.index}: ${error.message}`;
          console.error(msg);
          result.errors.push(msg);
        }
      }
    }

    result.summary.executionTimeMs = new Date() - exportStartTime;

    console.log(
      `[Ringover Export] Batch complete: ${result.summary.totalPushed} pushed, ${result.summary.fileCount} files, ${result.summary.executionTimeMs}ms`
    );

    // Persist export metadata to database
    try {
      const exportRecord = new RingoverExport({
        batchId: result.batchId,
        exportedBy: userId,
        exportedAt: result.timestamp,
        files: result.files,
        summary: result.summary,
        apiResult: result.apiResult,
        errors: result.errors,
        status:
          result.errors.length === 0
            ? "success"
            : result.summary.totalPushed > 0 || result.files.length > 0
            ? "partial"
            : "failed",
      });
      await exportRecord.save();
      console.log(`[Ringover Export] Metadata saved: ${result.batchId}`);
    } catch (dbError) {
      console.error(`[Ringover Export] Error saving metadata:`, dbError);
    }

    return result;
  } catch (error) {
    console.error(`[Ringover Export] Fatal error in batch ${exportBatchId}:`, error);
    throw new Error(`Ringover export failed: ${error.message}`);
  }
}

module.exports = {
  generateRingoverExport,
  buildContactsArray,
  pushToRingoverAPI,
  generateCSVBuffer,
  normalizeToE164,
  splitContactsIntoFiles,
};
