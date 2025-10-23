// controllers/orderController.js - Update to remove warehouse/stock checks
const SalesOrder = require("../models/SalesOrder");
const User = require("../models/User");
const Item = require("../models/item");
const customerTargetController = require("./customerTarget.controller");
const {
  formatOrderForSAP,
  createSalesOrderInSAP,
  getSalesOrderFromSAP,
  checkBusinessPartnerExists,
} = require("../utils/sapB1Integration");
const XLSX = require("xlsx");

// Add these to orderController.js

const nodemailer = require("nodemailer");
const axios = require("axios");
require("dotenv").config();

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: true,
  auth: {
    user: process.env.SMTP_USER,
    email: process.env.SMTP_EMAIL,
    pass: process.env.SMTP_PASSWORD,
  },
});

// Generate payment link for sales order
exports.generatePaymentLinkForOrder = async (req, res) => {
  try {
    const { docNum } = req.params;
    const { email } = req.body;

    const order = await SalesOrder.findOne({ DocNum: docNum });
    if (!order) {
      return res.status(404).json({
        success: false,
        error: "Sales order not found",
      });
    }

    const customer_account_info = [
      {
        unique_account_identifier: order.CardCode,
      },
    ];

    const customer_account_info_2 =
      '{"payment_history_simple":' +
      JSON.stringify(customer_account_info) +
      "}";

    const account_info = Buffer.from(customer_account_info_2).toString(
      "base64"
    );

    const paymentLinkRequest = {
      reference: `SO-${order.DocNum}`,
      amount: {
        value: Math.round(order.DocTotal * 100),
        currency: order.DocCurrency || "EUR",
      },
      description: `Payment for Sales Order #${order.DocNum}`,
      countryCode: "FR",

      merchantAccount: process.env.ADYEN_MERCHANT_ACCOUNT,
      shopperReference: order.CardCode,
      additionalData: {
        "openinvoicedata.merchantData": account_info,
      },
      allowedPaymentMethods: ["klarna_b2b"],
      company: {
        name: order.CardName,
      },
      shopperEmail: email,
      lineItems: order.DocumentLines.map((line) => ({
        id: line.LineNum,
        quantity: line.Quantity,
        amountIncludingTax: Math.round(line.PriceAfterVAT * 100),
        amountExcludingTax: Math.round(line.Price * 100),
        taxAmount: Math.round((line.PriceAfterVAT - line.Price) * 100),
        taxPercentage: Math.round(
          (line.PriceAfterVAT / line.Price - 1) * 10000
        ),
        description: line.ItemDescription,
      })),
    };

    const response = await axios.post(
      `${process.env.ADYEN_API_BASE_URL}/paymentLinks`,
      paymentLinkRequest,
      {
        headers: {
          "X-API-KEY": process.env.ADYEN_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    const paymentLink = response.data.url;
    const paymentId = response.data.id;
    const expiryDate = new Date(response.data.expiresAt).toISOString();

    order.Payment_id = paymentId;
    order.Link_sent = true;

    // Create line items table for email
    const lineItemsHtml = order.DocumentLines.map(
      (line) => `
      <tr>
        <td style="border: 1px solid #ddd; padding: 8px;">${line.ItemCode}</td>
        <td style="border: 1px solid #ddd; padding: 8px;">${line.ItemDescription
        }</td>
        <td style="border: 1px solid #ddd; padding: 8px;">${line.Quantity}</td>
        <td style="border: 1px solid #ddd; padding: 8px;">€${line.Price.toFixed(
          2
        )}</td>
        <td style="border: 1px solid #ddd; padding: 8px;">€${line.LineTotal.toFixed(
          2
        )}</td>
      </tr>
    `
    ).join("");

    const emailHtml = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #333;">Demande de Paiement pour la Commande n°${order.DocNum
      }</h2>
      <p>Chère ${order.CardName},</p>
      <p>Veuillez trouver ci-dessous le lien de paiement pour votre commande :</p>
      
      <div style="margin: 20px 0; padding: 15px; background-color: #f8f9fa; border-radius: 5px;">
        <a href="${paymentLink}" style="display: inline-block; padding: 12px 24px; background-color: #007bff; color: white; text-decoration: none; border-radius: 4px; font-weight: bold;">
          Cliquez ici pour effectuer votre paiement
        </a>
      </div>
      
      <p><strong>Le lien de paiement expirera le ${expiryDate.split("T")[0]
      }.</strong></p>
      
      <h3 style="color: #333;">Détails de la commande :</h3>
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <thead>
          <tr style="background-color: #f8f9fa;">
            <th style="border: 1px solid #ddd; padding: 12px; text-align: left;">Code Article</th>
            <th style="border: 1px solid #ddd; padding: 12px; text-align: left;">Description</th>
            <th style="border: 1px solid #ddd; padding: 12px; text-align: left;">Quantité</th>
            <th style="border: 1px solid #ddd; padding: 12px; text-align: left;">Prix Unitaire</th>
            <th style="border: 1px solid #ddd; padding: 12px; text-align: left;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${lineItemsHtml}
        </tbody>
        <tfoot>
          <tr style="font-weight: bold; background-color: #f8f9fa;">
            <td colspan="4" style="border: 1px solid #ddd; padding: 12px; text-align: right;">Total de la commande :</td>
            <td style="border: 1px solid #ddd; padding: 12px;">€${order.DocTotal.toFixed(
        2
      )}</td>
          </tr>
        </tfoot>
      </table>
      
      <p>Si vous avez des questions concernant cette commande, n'hésitez pas à nous contacter.</p>
      <p>Cordialement,<br>L'équipe Halal Food Service</p>
    </div>
    `;

    await transporter.sendMail({
      from: process.env.SMTP_EMAIL,
      to: email,
      subject: `Payment Link for Sales Order #${order.DocNum}`,
      html: emailHtml,
    });

    await order.save();

    res.status(200).json({
      success: true,
      message: "Payment link generated and sent successfully",
      paymentLink,
    });
  } catch (error) {
    console.error("Error in generatePaymentLinkForOrder:", error);
    res.status(500).json({
      success: false,
      error: "Failed to generate payment link",
      details: error.message,
    });
  }
};

// Get payment update for sales order
exports.getUpdateOnPaymentLinkForOrder = async (req, res) => {
  try {
    const { docNum } = req.params;
    const order = await SalesOrder.findOne({ DocNum: docNum });

    if (!order) {
      return res.status(404).json({
        success: false,
        error: "Sales order not found",
      });
    }

    if (!order.Payment_id) {
      return res.status(400).json({
        success: false,
        error: "No payment link found for this order",
      });
    }

    const response = await axios.get(
      `${process.env.ADYEN_API_BASE_URL}/paymentLinks/${order.Payment_id}`,
      {
        headers: {
          "X-API-KEY": process.env.ADYEN_API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    const paymentStatus = response.data.status;
    order.payment_status = paymentStatus;
    await order.save();

    res.status(200).json({
      success: true,
      message: "Payment status updated successfully",
      paymentStatus,
      paymentData: response.data,
    });
  } catch (error) {
    console.error("Error in getUpdateOnPaymentLinkForOrder:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update payment status",
      details: error.message,
    });
  }
};
// Update the bulkImportSalesOrders function to mark imported orders properly

exports.bulkImportSalesOrders = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Excel file is required",
      });
    }

    const startTime = Date.now();
    console.log("Starting Sales Orders Excel import...");

    // Parse Excel file
    const workbook = XLSX.read(req.file.buffer, {
      cellDates: true,
      cellNF: true,
      cellStyles: true,
    });

    // Get the first worksheet
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    // Convert to JSON with headers
    const excelRows = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: "",
      blankrows: false,
    });

    if (excelRows.length < 2) {
      return res.status(400).json({
        success: false,
        message: "Excel file must contain headers and data rows",
      });
    }

    // Extract headers and data
    const headers = excelRows[0];
    const dataRows = excelRows.slice(1);

    // Convert to objects using headers
    const processedRows = dataRows.map((row) => {
      const obj = {};
      headers.forEach((header, index) => {
        obj[header] = row[index] || "";
      });
      return obj;
    });

    console.log(`Parsed ${processedRows.length} rows from Excel`);

    // Group Excel rows by Internal Number to create order documents
    const orderGroups = {};

    processedRows.forEach((row) => {
      const docId = row["Internal Number"];
      if (!docId) return;

      if (!orderGroups[docId]) {
        orderGroups[docId] = {
          mainData: row,
          lines: [],
        };
      }

      // Add line item if it has valid data
      if (row["Item No."] && row["Item/Service Description"]) {
        orderGroups[docId].lines.push({
          LineNum: row["Row Number"] || 0,
          ItemCode: row["Item No."],
          ItemDescription: row["Item/Service Description"],
          Quantity: row["Quantity"] || 0,
          Price: row["Price after Discount"] || 0,
          PriceAfterVAT: row["Gross Price after Discount"] || 0,
          Currency: row["Price Currency"] || "EUR",
          LineTotal: row["Row Total"] || 0,
          UnitPrice: row["Unit Price"] || 0,
          VatGroup: null,
        });
      }
    });

    const totalOrders = Object.keys(orderGroups).length;
    console.log(`Grouped into ${totalOrders} sales orders`);

    // Get existing DocEntry values in bulk
    const docEntries = Object.keys(orderGroups).map((id) => parseInt(id));
    const existingOrders = await SalesOrder.find(
      { DocEntry: { $in: docEntries } },
      { DocEntry: 1 }
    ).lean();

    const existingDocEntries = new Set(
      existingOrders.map((order) => order.DocEntry)
    );
    console.log(`Found ${existingDocEntries.size} existing sales orders`);

    // Prepare new orders for bulk insert
    const newOrders = [];

    Object.entries(orderGroups).forEach(([docId, group]) => {
      const docEntry = parseInt(docId);

      // Skip if order already exists
      if (existingDocEntries.has(docEntry)) {
        return;
      }

      const row = group.mainData;

      // Parse dates - handle Excel date formats
      const parseDate = (dateValue) => {
        if (!dateValue) return null;

        // If it's already a Date object (from Excel)
        if (dateValue instanceof Date) {
          return dateValue;
        }

        // If it's a string, try to parse it
        if (typeof dateValue === "string") {
          const parts = dateValue.split("/");
          if (parts.length === 3) {
            return new Date(
              `20${parts[2]}-${parts[1].padStart(2, "0")}-${parts[0].padStart(
                2,
                "0"
              )}`
            );
          }
          return new Date(dateValue);
        }

        // If it's a number (Excel serial date)
        if (typeof dateValue === "number") {
          return XLSX.SSF.parse_date_code(dateValue);
        }

        return new Date(dateValue);
      };

      // Determine order status
      const docTotal = parseFloat(row["Document Total"]) || 0;
      const paidToDate = parseFloat(row["Paid to Date"]) || 0;
      const isCancelled = row["Cancelled"] === "Y";
      const orderStatus = row["OrderStatus"] || (isCancelled ? "C" : "O");

      // Create sales order document
      const salesOrder = {
        // Required fields
        DocEntry: docEntry,
        DocNum: parseInt(row["Document Number"]) || docEntry,

        // Customer info
        CardCode: row["Customer/Supplier No."] || "",
        CardName: row["Customer/Supplier Name"] || "",

        // Financial data
        DocTotal: docTotal,
        PaidToDate: paidToDate,
        DocCurrency: row["Price Currency"] || "EUR",

        // Dates
        DocDate: parseDate(row["Posting Date"]),
        CreationDate: parseDate(row["Posting Date"]),

        // Address
        Address: row["Ship-to Description"] || "",

        // Document status and cancellation
        DocumentStatus: orderStatus,
        Cancelled: isCancelled ? "Y" : "N",

        // Additional computed fields
        VatSum: parseFloat(row["Total Tax - Row"]) || 0,

        // Document lines
        DocumentLines: group.lines,

        // *** IMPORTANT: Mark as already synced with SAP and imported ***
        SyncedWithSAP: true, // These orders came FROM SAP
        LocalStatus: "Synced", // Custom status to indicate origin
        SAPDocEntry: docEntry, // Use DocEntry as SAP reference

        // *** CRITICAL: No salesAgent - indicates SAP origin ***
        // salesAgent: null (this is implicit - don't set it)

        // Timestamps
        CreationDate: parseDate(row["Posting Date"]) || new Date(),
        UpdateDate: new Date(),

        // Add import metadata
        ImportDate: new Date(),
        ImportSource: "SAP_B1_Bulk_Import",
        U_Notes: row["Comments"] || "",
      };

      newOrders.push(salesOrder);
    });

    console.log(
      `Prepared ${newOrders.length} new sales orders for import (marked as SAP origin)`
    );

    // Bulk insert new orders
    let insertedCount = 0;
    let insertedDocNums = [];
    if (newOrders.length > 0) {
      try {
        const result = await SalesOrder.insertMany(newOrders, {
          ordered: false, // Continue even if some fail
          lean: true,
        });
        insertedCount = result.length;
        insertedDocNums = result.map((order) => order.DocNum);
        console.log(
          `Successfully inserted ${insertedCount} SAP-origin sales orders`
        );
      } catch (error) {
        // Handle partial success in bulk insert
        if (error.writeErrors) {
          insertedCount = newOrders.length - error.writeErrors.length;
          // Get DocNums of successfully inserted orders
          const failedIndices = new Set(
            error.writeErrors.map((err) => err.index)
          );
          insertedDocNums = newOrders
            .filter((_, index) => !failedIndices.has(index))
            .map((order) => order.DocNum);
          console.log(
            `Partial success: ${insertedCount} inserted, ${error.writeErrors.length} failed`
          );
        } else {
          throw error;
        }
      }
    }

    const endTime = Date.now();
    const processingTime = ((endTime - startTime) / 1000).toFixed(2);

    return res.status(200).json({
      success: true,
      message:
        "Sales Orders Excel import completed - orders marked as SAP origin",
      data: {
        totalRowsProcessed: processedRows.length,
        totalOrdersInExcel: totalOrders,
        existingOrders: existingDocEntries.size,
        newOrdersInserted: insertedCount,
        skippedOrders: totalOrders - insertedCount,
        processingTimeSeconds: processingTime,
        insertedOrderDocNums: insertedDocNums,
        note: "Imported orders are marked as SAP origin and will not be synced back to SAP",
      },
    });
  } catch (error) {
    console.error("Error in sales orders bulk import:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to import Sales Orders Excel file",
      error: error.message,
    });
  }
};
// Add this helper function
async function updateSalesAgentStats(salesAgentId, order) {
  try {
    const agent = await User.findById(salesAgentId);
    if (!agent || agent.role !== "sales_agent") return;

    // Get current month and year
    const orderDate = order.DocDate;
    const month = orderDate.toLocaleString("default", { month: "short" });
    const year = orderDate.getFullYear();

    // Calculate order value
    const orderValue = order.DocTotal;

    // Find or create entry for current month/year in salesHistory
    let salesEntry = agent.salesHistory.find(
      (entry) => entry.month === month && entry.year === year
    );

    if (!salesEntry) {
      // Create new entry if it doesn't exist
      agent.salesHistory.push({
        month,
        year,
        orderCount: 1,
        totalValue: orderValue,
        orders: [order._id],
      });
    } else {
      // Update existing entry
      salesEntry.orderCount += 1;
      salesEntry.totalValue += orderValue;
      salesEntry.orders.push(order._id);
    }

    // Update target achievement
    let targetEntry = agent.targetHistory.find(
      (entry) => entry.month === month && entry.year === year
    );

    if (!targetEntry) {
      // Create new target entry with current target
      agent.targetHistory.push({
        month,
        year,
        target: agent.target,
        achieved: orderValue,
        achievementRate:
          agent.target > 0 ? (orderValue / agent.target) * 100 : 0,
      });
    } else {
      // Update existing target entry
      targetEntry.achieved += orderValue;
      targetEntry.achievementRate =
        targetEntry.target > 0
          ? (targetEntry.achieved / targetEntry.target) * 100
          : 0;
    }

    // Update overall targetAchieved
    agent.targetAchieved += orderValue;

    // Save changes
    await agent.save();
  } catch (error) {
    console.error("Error updating sales agent stats:", error);
  }
}

async function updateSalesAgentAchievement(salesAgentId, order) {
  const agent = await User.findById(salesAgentId);
  if (!agent) return;

  // You might want to add some logic here based on your business rules
  // For example, maybe achievements only count when orders are pushed to SAP

  // Maybe increment a counter of successfully synced orders
  agent.syncedOrderCount = (agent.syncedOrderCount || 0) + 1;

  await agent.save();
}

// Helper function to push order to SAP
// Replace the existing pushOrderToSAPInternal function

async function pushOrderToSAPInternal(order) {
  try {
    // Format the order for SAP B1 - Note this is now async
    const sapOrder = await formatOrderForSAP(order);

    try {
      // First check if business partner exists in SAP
      const businessPartnerExists = await checkBusinessPartnerExists(
        order.CardCode
      );

      if (!businessPartnerExists) {
        // Update order to reflect BP doesn't exist in SAP
        order.SyncErrors = `Business partner ${order.CardCode} does not exist in SAP B1`;
        order.LastSyncAttempt = new Date();
        order.LocalStatus = "SyncFailed";
        order.SAPSyncDisabled = true; // Flag to indicate we shouldn't try to sync this order again
        await order.save();

        return {
          success: false,
          error: order.SyncErrors,
          code: "BP_NOT_FOUND",
        };
      }
    } catch (bpError) {
      // If BP check itself fails, continue with the order creation attempt
      console.warn(
        `Could not verify business partner in SAP: ${bpError.message}`
      );
    }

    // Push to SAP B1
    const sapResponse = await createSalesOrderInSAP(sapOrder);

    // Update local order with SAP DocEntry AND DocNum if successful
    if (sapResponse && sapResponse.DocEntry) {
      order.SAPDocEntry = sapResponse.DocEntry;

      // *** IMPORTANT: Update local DocNum to match SAP's DocNum ***
      if (sapResponse.DocNum) {
        console.log(
          `Updating local DocNum from ${order.DocNum} to ${sapResponse.DocNum} to match SAP`
        );
        order.DocNum = sapResponse.DocNum;
      }

      order.DocumentStatus = "bost_Open"; // Or any appropriate status
      order.UpdateDate = new Date();
      order.SyncedWithSAP = true;
      order.LocalStatus = "Synced";
      order.SyncErrors = null; // Clear any previous errors
      order.LastSyncAttempt = new Date();

      await order.save();

      // Update sales agent stats for synced order
      if (order.salesAgent) {
        await updateSalesAgentAchievement(order.salesAgent, order);
      }

      return {
        success: true,
        SAPDocEntry: sapResponse.DocEntry,
        SAPDocNum: sapResponse.DocNum,
        sapData: sapResponse,
      };
    } else {
      throw new Error("Invalid response from SAP B1");
    }
  } catch (error) {
    // Check for specific error types
    let errorCode = "GENERAL_ERROR";

    if (
      error.message &&
      error.message.includes("Business partner") &&
      error.message.includes("does not exist")
    ) {
      errorCode = "BP_NOT_FOUND";
    } else if (error.message && error.message.includes("Invalid BP code")) {
      errorCode = "INVALID_BP_CODE";
    }

    // Update local order to mark sync failure
    order.SyncErrors = error.message;
    order.LastSyncAttempt = new Date();
    order.LocalStatus = "SyncFailed";

    // If BP doesn't exist, mark order to not attempt sync again
    if (errorCode === "BP_NOT_FOUND" || errorCode === "INVALID_BP_CODE") {
      order.SAPSyncDisabled = true;
    }

    await order.save();

    console.error("Error pushing order to SAP:", error);
    return {
      success: false,
      error: error.message || "Unknown error",
      code: errorCode,
    };
  }
}

// Create a new sales order (save to local DB and push to SAP)
// Update the createOrder function - replace the DocEntry generation part

exports.createOrder = async (req, res) => {
  try {
    // Validate required fields
    if (!req.body.CardCode) {
      return res.status(400).json({
        success: false,
        message: "Customer (CardCode) is required",
      });
    }

    console.log("Request body PriceList:", req.body.PriceList);

    const salesAgentId = req.user._id;

    // Validate that at least one document line exists
    if (!req.body.DocumentLines || req.body.DocumentLines.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Order must contain at least one item",
      });
    }

    // Validate items but don't check stock availability
    const itemCodes = req.body.DocumentLines.map((line) => line.ItemCode);
    const items = await Item.find({ ItemCode: { $in: itemCodes } });

    // Create a map for quick lookups
    const itemMap = {};
    items.forEach((item) => {
      itemMap[item.ItemCode] = item;
    });

    // Check if all items exist but don't check stock
    const invalidItems = [];
    for (const line of req.body.DocumentLines) {
      const item = itemMap[line.ItemCode];

      if (!item) {
        invalidItems.push({
          ItemCode: line.ItemCode,
          error: "Item not found",
        });
        continue;
      }

      // Add item description if not provided
      if (!line.ItemDescription && item.ItemName) {
        line.ItemDescription = item.ItemName;
      }
    }

    if (invalidItems.length > 0) {
      return res.status(400).json({
        success: false,
        message: "Order contains invalid items",
        invalidItems,
      });
    }

    // *** UPDATED DOCNUM GENERATION ***
    // Try to get the next DocNum from SAP first
    let newDocNum;
    let newDocEntry;

    try {
      // Import the new function
      const { getNextDocNumFromSAP } = require("../utils/sapB1Integration");
      newDocNum = await getNextDocNumFromSAP();

      if (newDocNum) {
        console.log(`Using SAP-aligned DocNum: ${newDocNum}`);
        newDocEntry = newDocNum; // Use the same number for both
      } else {
        throw new Error("Could not get DocNum from SAP");
      }
    } catch (sapError) {
      console.warn(
        "Could not get DocNum from SAP, falling back to local generation:",
        sapError.message
      );

      // Fallback to local DocEntry generation
      const lastOrder = await SalesOrder.findOne().sort({ DocEntry: -1 });
      newDocEntry = lastOrder ? lastOrder.DocEntry + 1 : 1;
      newDocNum = newDocEntry;

      console.log(`Using local DocNum: ${newDocNum}`);
    }

    // Process document lines
    const orderPriceList = req.body.PriceList || "2";
    const processedDocumentLines = req.body.DocumentLines.map((line) => ({
      ...line,
      PriceList: line.PriceList
        ? parseInt(line.PriceList, 10)
        : parseInt(orderPriceList, 10),
      LineTotal: (line.Quantity || 0) * (line.Price || 0),
    }));

    // Replace the original DocumentLines with processed ones
    req.body.DocumentLines = processedDocumentLines;

    // Calculate today's date for DocDate and DocDueDate
    const today = new Date();

    const salesAgentName =
      "The order was put up by " +
      req.user.firstName +
      " " +
      req.user.lastName +
      ". ";

    // Create the new order with SAP-aligned DocNum
    const newOrder = new SalesOrder({
      ...req.body,
      PriceList: req.body.PriceList,
      DocEntry: newDocEntry,
      DocNum: newDocNum, // Now aligned with SAP
      DocType: req.body.DocType || "dDocument_Items",
      DocumentStatus: "bost_Open",
      CreationDate: today,
      StartDeliveryDate: req.body.StartDeliveryDate || today,
      DocDate: req.body.DocDate || today,
      DocDueDate: req.body.DocDueDate || today,
      UpdateDate: today,
      SyncedWithSAP: false,
      LocalStatus: "Created",
      salesAgent: salesAgentId,
      U_Notes: salesAgentName,
    });

    console.log("Creating new order with SAP-aligned DocNum:", {
      DocEntry: newOrder.DocEntry,
      DocNum: newOrder.DocNum,
      CardCode: newOrder.CardCode,
    });

    // Calculate totals if not provided
    if (!newOrder.DocTotal) {
      let total = 0;
      for (const line of newOrder.DocumentLines) {
        const lineTotal = line.Quantity * line.Price;
        line.LineTotal = lineTotal;
        total += lineTotal;
      }
      newOrder.DocTotal = total;
    }

    // Save to local database
    await newOrder.save();

    // Update sales agent stats
    if (salesAgentId) {
      await updateSalesAgentStats(salesAgentId, newOrder);
    }

    // Push to SAP automatically
    console.log("Automatically pushing new order to SAP...");
    const sapResult = await pushOrderToSAPInternal(newOrder);

    // Return response with both local creation and SAP push results
    if (sapResult.success) {
      res.status(201).json({
        success: true,
        data: newOrder,
        message: "Order created successfully and synced with SAP",
        sapSync: {
          success: true,
          SAPDocEntry: sapResult.SAPDocEntry,
        },
      });
    } else {
      // Customize message based on error code
      let sapErrorMessage = "Failed to sync with SAP";

      if (
        sapResult.code === "BP_NOT_FOUND" ||
        sapResult.code === "INVALID_BP_CODE"
      ) {
        sapErrorMessage = `Business partner ${newOrder.CardCode} does not exist in SAP B1`;
      }

      res.status(201).json({
        success: true,
        data: newOrder,
        message:
          "Order created successfully in local database but failed to sync with SAP",
        sapSync: {
          success: false,
          error: sapResult.error,
          message: sapErrorMessage,
          code: sapResult.code,
        },
      });
    }
  } catch (error) {
    console.error("Error creating order:", error);
    res.status(500).json({
      success: false,
      message: "Error creating order",
      error: error.message,
    });
  }
};

// Add this filter option to your getAllOrders function
// Add this to the existing filters section:
exports.getAllOrders = async (req, res) => {
  try {
    console.log("Fetching all orders with enhanced filtering");
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;
    const sortBy = req.query.sortBy || "DocDate";
    const sortOrder = req.query.sortOrder === "asc" ? 1 : -1;

    // Base query
    let query = {};

    // Search filter
    if (req.query.search) {
      const searchRegex = { $regex: req.query.search, $options: "i" };
      query.$or = [
        { DocNum: searchRegex },
        { CardCode: searchRegex },
        { CardName: searchRegex },
        { Address: searchRegex },
      ];
    }

    // Customer code filter
    if (req.query.cardCode) {
      query.CardCode = { $regex: req.query.cardCode, $options: "i" };
    }

    // Status filter
    if (req.query.status) {
      query.DocumentStatus = req.query.status;
    }

    // Sync status filter
    if (req.query.syncStatus) {
      switch (req.query.syncStatus) {
        case "synced":
          query.SyncedWithSAP = true;
          break;
        case "unsynced":
          query.SyncedWithSAP = false;
          break;
        case "failed":
          query.LocalStatus = "SyncFailed";
          break;
      }
    }

    // Order origin filter
    if (req.query.orderOrigin) {
      switch (req.query.orderOrigin) {
        case "system":
          query.salesAgent = { $exists: true, $ne: null };
          break;
        case "sap":
          query.salesAgent = { $exists: false };
          break;
        case "sap_null":
          query.$or = [
            { salesAgent: { $exists: false } },
            { salesAgent: null },
          ];
          break;
      }
    }

    // Delivery date filter - checks both StartDeliveryDate and RequriedDate
    if (req.query.deliveryDateFrom && req.query.deliveryDateTo) {
      const fromDate = new Date(req.query.deliveryDateFrom);
      const toDate = new Date(req.query.deliveryDateTo);

      query.$or = query.$or || [];
      query.$or.push(
        { StartDeliveryDate: { $gte: fromDate, $lte: toDate } },
        { RequriedDate: { $gte: fromDate, $lte: toDate } }
      );
    } else if (req.query.deliveryDateFrom) {
      const fromDate = new Date(req.query.deliveryDateFrom);

      query.$or = query.$or || [];
      query.$or.push(
        { StartDeliveryDate: { $gte: fromDate } },
        { RequriedDate: { $gte: fromDate } }
      );
    } else if (req.query.deliveryDateTo) {
      const toDate = new Date(req.query.deliveryDateTo);

      query.$or = query.$or || [];
      query.$or.push(
        { StartDeliveryDate: { $lte: toDate } },
        { RequriedDate: { $lte: toDate } }
      );
    }

    // Date range filter
    if (req.query.fromDate && req.query.toDate) {
      query.DocDate = {
        $gte: new Date(req.query.fromDate),
        $lte: new Date(req.query.toDate),
      };
    } else if (req.query.fromDate) {
      query.DocDate = { $gte: new Date(req.query.fromDate) };
    } else if (req.query.toDate) {
      query.DocDate = { $lte: new Date(req.query.toDate) };
    }

    // Sales agent filter
    if (req.query.salesAgent) {
      query.salesAgent = req.query.salesAgent;
    }

    console.log("Query:", JSON.stringify(query, null, 2));

    // *** ENHANCED SORTING LOGIC ***
    let sortObj = {};

    // Special handling for delivery date sorting
    if (sortBy === "StartDeliveryDate" || sortBy === "deliveryDate") {
      // We need to use aggregation to handle the coalesce logic
      const orders = await SalesOrder.aggregate([
        { $match: query },
        {
          $addFields: {
            // Create a computed field that uses StartDeliveryDate if it exists, otherwise RequriedDate
            effectiveDeliveryDate: {
              $ifNull: ["$StartDeliveryDate", "$RequriedDate"]
            }
          }
        },
        { $sort: { effectiveDeliveryDate: sortOrder } },
        { $skip: skip },
        { $limit: limit },
        {
          $lookup: {
            from: "users",
            localField: "salesAgent",
            foreignField: "_id",
            as: "salesAgent"
          }
        },
        {
          $unwind: {
            path: "$salesAgent",
            preserveNullAndEmptyArrays: true
          }
        },
        {
          $project: {
            "salesAgent.password": 0,
            "salesAgent.resetPasswordToken": 0,
            "salesAgent.resetPasswordExpire": 0
          }
        }
      ]);

      const total = await SalesOrder.countDocuments(query);

      console.log(`Found ${orders.length} orders out of ${total} total (sorted by delivery date)`);

      return res.status(200).json({
        success: true,
        count: orders.length,
        total,
        page,
        pages: Math.ceil(total / limit),
        data: orders,
      });
    } else {
      // Standard sorting for other fields
      sortObj[sortBy] = sortOrder;

      console.log("Sort:", sortObj);

      const orders = await SalesOrder.find(query)
        .populate("salesAgent", "firstName lastName email")
        .skip(skip)
        .limit(limit)
        .sort(sortObj);

      const total = await SalesOrder.countDocuments(query);

      console.log(`Found ${orders.length} orders out of ${total} total`);

      res.status(200).json({
        success: true,
        count: orders.length,
        total,
        page,
        pages: Math.ceil(total / limit),
        data: orders,
      });
    }
  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching orders",
      error: error.message,
    });
  }
};

// Get orders for a specific customer
exports.getOrdersByCustomer = async (req, res) => {
  try {
    const { cardCode } = req.params;
    const page = parseInt(req.query.page) || 1;

    // Base query
    const query = { CardCode: cardCode };

    const orders = await SalesOrder.find(query)
      .populate("salesAgent", "firstName lastName email")
      .sort({ DocDate: -1 });

    const total = await SalesOrder.countDocuments(query);

    console.log("Fetched orders for customer:", cardCode);

    console.log("Total orders:", total);

    res.status(200).json({
      success: true,
      count: orders.length,
      total,
      page,
      customerCode: cardCode,
      data: orders,
    });
  } catch (error) {
    console.log("Error fetching customer orders:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching customer orders",
      error: error.message,
    });
  }
};

// Get a single order by DocEntry
exports.getOrderByDocEntry = async (req, res) => {
  try {
    const order = await SalesOrder.findOne({
      DocEntry: req.params.docEntry,
    }).populate("salesAgent", "firstName lastName email");

    if (!order) {
      return res.status(404).json({
        success: false,
        message: `Order with DocEntry ${req.params.docEntry} not found`,
      });
    }

    // Check permissions for sales agents
    if (
      req.user.role === "sales_agent" &&
      order.salesAgent &&
      order.salesAgent._id.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to view this order",
      });
    }

    // Check permissions for sales managers
    if (req.user.role === "sales_manager" && order.salesAgent) {
      const agent = await User.findById(order.salesAgent._id);
      if (!agent || agent.manager.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "Not authorized to view this order",
        });
      }
    }

    res.status(200).json({
      success: true,
      data: order,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching order",
      error: error.message,
    });
  }
};

// Live sync orders with SAP - NOW USES STATUS SYNC
exports.liveSyncOrdersWithSAP = async (req, res) => {
  try {
    console.log("\n" + "=".repeat(60));
    console.log("STARTING LIVE SYNC: ORDERS (Using Status Sync)");
    console.log("=".repeat(60));

    // Simply call the status sync function
    return await exports.syncOrderStatusesFromSAP(req, res);
  } catch (error) {
    console.error("Error in live sync:", error);
    res.status(500).json({
      success: false,
      message: "Error during live sync",
      error: error.message,
    });
  }
};

// Manual push order to SAP B1 (kept for backup or retry purposes)
exports.pushOrderToSAP = async (req, res) => {
  try {
    const order = await SalesOrder.findOne({ DocEntry: req.params.docEntry });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: `Order with DocEntry ${req.params.docEntry} not found`,
      });
    }

    // Check if already synced with SAP
    if (order.SyncedWithSAP && order.SAPDocEntry) {
      return res.status(400).json({
        success: false,
        message: `Order already synced with SAP B1 (SAP DocEntry: ${order.SAPDocEntry})`,
        SAPDocEntry: order.SAPDocEntry,
      });
    }

    // Check if sync was previously disabled due to BP not existing
    if (order.SAPSyncDisabled) {
      // Allow force sync if specifically requested
      if (req.query.force !== "true") {
        return res.status(400).json({
          success: false,
          message: `Cannot sync order: ${order.SyncErrors}. Add ?force=true to override.`,
          error: order.SyncErrors,
        });
      }
      // If force=true, continue with sync attempt and clear the flag
      order.SAPSyncDisabled = false;
      await order.save();
    }

    const sapResult = await pushOrderToSAPInternal(order);

    if (sapResult.success) {
      return res.status(200).json({
        success: true,
        message: "Order successfully pushed to SAP B1",
        SAPDocEntry: sapResult.SAPDocEntry,
        localDocEntry: order.DocEntry,
        sapData: sapResult.sapData,
      });
    } else {
      // Customize message based on error code
      let errorMessage = "Error pushing order to SAP B1";

      if (
        sapResult.code === "BP_NOT_FOUND" ||
        sapResult.code === "INVALID_BP_CODE"
      ) {
        errorMessage = `Business partner ${order.CardCode} does not exist in SAP B1`;
      }

      return res.status(400).json({
        success: false,
        message: errorMessage,
        error: sapResult.error,
        code: sapResult.code,
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error pushing order to SAP B1",
      error: error.message || "Unknown error",
    });
  }
};

exports.pushUnsyncedOrdersToSAP = async (req, res) => {
  try {
    console.log("Starting bulk SAP sync for unsynced orders...");

    // Find all orders that are not synced with SAP, not disabled, AND have a sales agent
    // Orders with sales agents were created in our system
    // Orders without sales agents came from SAP bulk import and shouldn't be pushed back
    const unsyncedOrders = await SalesOrder.find({
      SyncedWithSAP: false,
      SAPSyncDisabled: { $ne: true },
      salesAgent: { $exists: true, $ne: null }, // Only orders with sales agents
    }).populate("salesAgent", "firstName lastName email");

    if (unsyncedOrders.length === 0) {
      return res.status(200).json({
        success: true,
        message: "No unsynced orders found that were created in the system",
        data: {
          totalOrders: 0,
          successful: 0,
          failed: 0,
          results: [],
        },
      });
    }

    console.log(
      `Found ${unsyncedOrders.length} unsynced orders created in the system`
    );

    const results = [];
    let successCount = 0;
    let failureCount = 0;

    // Process each order
    for (const order of unsyncedOrders) {
      try {
        console.log(
          `Processing order DocEntry: ${order.DocEntry} (Created by: ${order.salesAgent
            ? order.salesAgent.firstName + " " + order.salesAgent.lastName
            : "System"
          })`
        );

        const sapResult = await pushOrderToSAPInternal(order);

        if (sapResult.success) {
          successCount++;
          results.push({
            DocEntry: order.DocEntry,
            DocNum: order.DocNum,
            CardCode: order.CardCode,
            CardName: order.CardName,
            success: true,
            SAPDocEntry: sapResult.SAPDocEntry,
            message: "Successfully synced to SAP",
          });

          console.log(
            `✅ Order ${order.DocEntry} synced successfully - SAP DocEntry: ${sapResult.SAPDocEntry}`
          );
        } else {
          failureCount++;
          results.push({
            DocEntry: order.DocEntry,
            DocNum: order.DocNum,
            CardCode: order.CardCode,
            CardName: order.CardName,
            success: false,
            error: sapResult.error,
            errorCode: sapResult.code,
            message:
              sapResult.code === "BP_NOT_FOUND"
                ? `Business partner ${order.CardCode} does not exist in SAP`
                : "Failed to sync to SAP",
          });

          console.log(
            `❌ Order ${order.DocEntry} failed to sync: ${sapResult.error}`
          );
        }
      } catch (error) {
        failureCount++;
        results.push({
          DocEntry: order.DocEntry,
          DocNum: order.DocNum,
          CardCode: order.CardCode,
          CardName: order.CardName,
          success: false,
          error: error.message,
          message: "Unexpected error during sync",
        });

        console.error(`❌ Order ${order.DocEntry} encountered error:`, error);
      }
    }

    // Prepare summary
    const summary = {
      totalOrders: unsyncedOrders.length,
      successful: successCount,
      failed: failureCount,
      successRate:
        ((successCount / unsyncedOrders.length) * 100).toFixed(2) + "%",
    };

    console.log(
      `Bulk SAP sync completed: ${successCount} successful, ${failureCount} failed`
    );

    return res.status(200).json({
      success: true,
      message: `Bulk SAP sync completed: ${successCount} successful, ${failureCount} failed`,
      data: {
        summary,
        results,
      },
    });
  } catch (error) {
    console.error("Error in bulk SAP sync:", error);
    return res.status(500).json({
      success: false,
      message: "Error during bulk SAP sync",
      error: error.message,
    });
  }
};

// Get order statistics
exports.getOrderStats = async (req, res) => {
  try {
    const { fromDate, toDate, salesAgent } = req.query;

    // Build match query
    let matchQuery = {};

    // Date filter
    if (fromDate || toDate) {
      matchQuery.DocDate = {};
      if (fromDate) matchQuery.DocDate.$gte = new Date(fromDate);
      if (toDate) matchQuery.DocDate.$lte = new Date(toDate);
    }

    // Sales agent filter
    if (salesAgent) {
      matchQuery.salesAgent = new mongoose.Types.ObjectId(salesAgent);
    }

    // Filter for current user if sales agent
    if (req.user && req.user.role === "sales_agent") {
      matchQuery.salesAgent = req.user._id;
    }

    // If sales manager, get all orders from their agents
    if (req.user && req.user.role === "sales_manager") {
      const agentIds = await User.find({ manager: req.user._id }).distinct(
        "_id"
      );
      matchQuery.salesAgent = { $in: agentIds };
    }

    const stats = await SalesOrder.aggregate([
      { $match: matchQuery },
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          totalValue: { $sum: "$DocTotal" },
          syncedOrders: {
            $sum: { $cond: [{ $eq: ["$SyncedWithSAP", true] }, 1, 0] },
          },
          pendingSync: {
            $sum: { $cond: [{ $eq: ["$SyncedWithSAP", false] }, 1, 0] },
          },
          failedSync: {
            $sum: { $cond: [{ $eq: ["$LocalStatus", "SyncFailed"] }, 1, 0] },
          },
          paidOrders: {
            $sum: { $cond: [{ $eq: ["$payment_status", "completed"] }, 1, 0] },
          },
          pendingPayment: {
            $sum: { $cond: [{ $ne: ["$Payment_id", null] }, 1, 0] },
          },
        },
      },
    ]);

    const result = stats[0] || {
      totalOrders: 0,
      totalValue: 0,
      syncedOrders: 0,
      pendingSync: 0,
      failedSync: 0,
      paidOrders: 0,
      pendingPayment: 0,
    };

    res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Error fetching order stats:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching order statistics",
      error: error.message,
    });
  }
};

// Search orders
exports.searchOrders = async (req, res) => {
  try {
    const { searchTerm, filters = {} } = req.body;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // Build search query
    let query = {};

    // Text search
    if (searchTerm) {
      query.$or = [
        { DocNum: { $regex: searchTerm, $options: "i" } },
        { CardCode: { $regex: searchTerm, $options: "i" } },
        { CardName: { $regex: searchTerm, $options: "i" } },
        { Address: { $regex: searchTerm, $options: "i" } },
      ];
    }

    // Apply filters
    Object.keys(filters).forEach((key) => {
      if (filters[key] !== null && filters[key] !== "") {
        query[key] = filters[key];
      }
    });

    // Role-based filtering
    if (req.user.role === "sales_agent") {
      query.salesAgent = req.user._id;
    }

    if (req.user.role === "sales_manager") {
      const agentIds = await User.find({ manager: req.user._id }).distinct(
        "_id"
      );
      query.salesAgent = { $in: agentIds };
    }

    const orders = await SalesOrder.find(query)
      .populate("salesAgent", "firstName lastName email")
      .skip(skip)
      .limit(limit)
      .sort({ DocDate: -1 });

    const total = await SalesOrder.countDocuments(query);

    res.status(200).json({
      success: true,
      count: orders.length,
      total,
      page,
      pages: Math.ceil(total / limit),
      data: orders,
    });
  } catch (error) {
    console.error("Error searching orders:", error);
    res.status(500).json({
      success: false,
      message: "Error searching orders",
      error: error.message,
    });
  }
};

// Export orders
exports.exportOrders = async (req, res) => {
  try {
    const filters = req.body;

    // Build query based on filters
    let query = {};

    if (filters.fromDate && filters.toDate) {
      query.DocDate = {
        $gte: new Date(filters.fromDate),
        $lte: new Date(filters.toDate),
      };
    }

    if (filters.salesAgent) {
      query.salesAgent = filters.salesAgent;
    }

    if (filters.cardCode) {
      query.CardCode = { $regex: filters.cardCode, $options: "i" };
    }

    if (filters.syncStatus) {
      if (filters.syncStatus === "synced") {
        query.SyncedWithSAP = true;
      } else if (filters.syncStatus === "unsynced") {
        query.SyncedWithSAP = false;
      } else if (filters.syncStatus === "failed") {
        query.LocalStatus = "SyncFailed";
      }
    }

    // Role-based filtering
    if (req.user.role === "sales_agent") {
      query.salesAgent = req.user._id;
    }

    if (req.user.role === "sales_manager") {
      const agentIds = await User.find({ manager: req.user._id }).distinct(
        "_id"
      );
      query.salesAgent = { $in: agentIds };
    }

    const orders = await SalesOrder.find(query)
      .populate("salesAgent", "firstName lastName email")
      .sort({ DocDate: -1 });

    // Convert to CSV format
    const csvHeaders = [
      "Doc Number",
      "Customer Code",
      "Customer Name",
      "Sales Agent",
      "Order Date",
      "Total Amount",
      "Currency",
      "Status",
      "SAP Synced",
      "SAP Doc Entry",
      "Payment Status",
      "Address",
    ];

    const csvRows = orders.map((order) => [
      order.DocNum,
      order.CardCode,
      order.CardName,
      order.salesAgent
        ? `${order.salesAgent.firstName} ${order.salesAgent.lastName}`
        : "",
      order.DocDate ? order.DocDate.toISOString().split("T")[0] : "",
      order.DocTotal,
      order.DocCurrency || "EUR",
      order.DocumentStatus,
      order.SyncedWithSAP ? "Yes" : "No",
      order.SAPDocEntry || "",
      order.payment_status || "",
      order.Address || "",
    ]);

    // Create CSV content
    const csvContent = [csvHeaders, ...csvRows]
      .map((row) => row.map((field) => `"${field}"`).join(","))
      .join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=sales-orders.csv"
    );
    res.send(csvContent);
  } catch (error) {
    console.error("Error exporting orders:", error);
    res.status(500).json({
      success: false,
      message: "Error exporting orders",
      error: error.message,
    });
  }
};

// Update order status
exports.updateOrderStatus = async (req, res) => {
  try {
    const { docEntry } = req.params;
    const { status } = req.body;

    const order = await SalesOrder.findOneAndUpdate(
      { DocEntry: docEntry },
      {
        DocumentStatus: status,
        UpdateDate: new Date(),
      },
      { new: true }
    ).populate("salesAgent", "firstName lastName email");

    if (!order) {
      return res.status(404).json({
        success: false,
        message: `Order with DocEntry ${docEntry} not found`,
      });
    }

    res.status(200).json({
      success: true,
      message: "Order status updated successfully",
      data: order,
    });
  } catch (error) {
    console.error("Error updating order status:", error);
    res.status(500).json({
      success: false,
      message: "Error updating order status",
      error: error.message,
    });
  }
};

// Cancel order
exports.cancelOrder = async (req, res) => {
  try {
    const { docEntry } = req.params;
    const { reason } = req.body;

    const order = await SalesOrder.findOneAndUpdate(
      { DocEntry: docEntry },
      {
        Cancelled: "Y",
        DocumentStatus: "bost_Cancelled",
        UpdateDate: new Date(),
        CancellationReason: reason || "Cancelled by user",
      },
      { new: true }
    ).populate("salesAgent", "firstName lastName email");

    if (!order) {
      return res.status(404).json({
        success: false,
        message: `Order with DocEntry ${docEntry} not found`,
      });
    }

    res.status(200).json({
      success: true,
      message: "Order cancelled successfully",
      data: order,
    });
  } catch (error) {
    console.error("Error cancelling order:", error);
    res.status(500).json({
      success: false,
      message: "Error cancelling order",
      error: error.message,
    });
  }
};

// Get SAP order status
exports.getSAPOrderStatus = async (req, res) => {
  try {
    const { docEntry } = req.params;

    const order = await SalesOrder.findOne({ DocEntry: docEntry });
    if (!order) {
      return res.status(404).json({
        success: false,
        message: `Order with DocEntry ${docEntry} not found`,
      });
    }

    if (!order.SAPDocEntry) {
      return res.status(400).json({
        success: false,
        message: "Order is not synced with SAP",
      });
    }

    try {
      // Get order status from SAP
      const sapOrder = await getSalesOrderFromSAP(order.SAPDocEntry);

      // Update local order with SAP status
      order.DocumentStatus = sapOrder.DocumentStatus;
      order.UpdateDate = new Date();
      await order.save();

      res.status(200).json({
        success: true,
        message: "SAP order status retrieved successfully",
        data: {
          localOrder: order,
          sapOrder: sapOrder,
        },
      });
    } catch (sapError) {
      res.status(500).json({
        success: false,
        message: "Error retrieving order from SAP",
        error: sapError.message,
      });
    }
  } catch (error) {
    console.error("Error getting SAP order status:", error);
    res.status(500).json({
      success: false,
      message: "Error getting SAP order status",
      error: error.message,
    });
  }
};

// Duplicate order
exports.duplicateOrder = async (req, res) => {
  try {
    const { docEntry } = req.params;

    const originalOrder = await SalesOrder.findOne({ DocEntry: docEntry });
    if (!originalOrder) {
      return res.status(404).json({
        success: false,
        message: `Order with DocEntry ${docEntry} not found`,
      });
    }

    // Generate new DocEntry
    const lastOrder = await SalesOrder.findOne().sort({ DocEntry: -1 });
    const newDocEntry = lastOrder ? lastOrder.DocEntry + 1 : 1;

    // Create duplicate order
    const duplicateData = {
      ...originalOrder.toObject(),
      _id: undefined, // Remove the original _id
      DocEntry: newDocEntry,
      DocNum: newDocEntry,
      DocDate: new Date(),
      CreationDate: new Date(),
      UpdateDate: new Date(),
      SyncedWithSAP: false,
      SAPDocEntry: null,
      LocalStatus: "Created",
      Payment_id: null,
      payment_status: null,
      Link_sent: false,
      U_Notes: `Duplicated from order #${originalOrder.DocNum}. ${originalOrder.U_Notes || ""
        }`,
    };

    const newOrder = new SalesOrder(duplicateData);
    await newOrder.save();

    const populatedOrder = await SalesOrder.findById(newOrder._id).populate(
      "salesAgent",
      "firstName lastName email"
    );

    res.status(201).json({
      success: true,
      message: "Order duplicated successfully",
      data: populatedOrder,
    });
  } catch (error) {
    console.error("Error duplicating order:", error);
    res.status(500).json({
      success: false,
      message: "Error duplicating order",
      error: error.message,
    });
  }
};

// Update an existing sales order
exports.updateOrder = async (req, res) => {
  try {
    const { docEntry } = req.params;

    console.log(`Updating order with DocEntry: ${docEntry}`);

    // Find the existing order
    const existingOrder = await SalesOrder.findOne({ DocNum: docEntry });

    if (!existingOrder) {
      return res.status(404).json({
        success: false,
        message: `Order with DocEntry ${docEntry} not found`,
      });
    }

    // Check permissions for sales agents
    if (
      req.user.role === "sales_agent" &&
      existingOrder.salesAgent &&
      existingOrder.salesAgent.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to update this order",
      });
    }

    // Check permissions for sales managers
    if (req.user.role === "sales_manager" && existingOrder.salesAgent) {
      const agent = await User.findById(existingOrder.salesAgent);
      if (!agent || agent.manager.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "Not authorized to update this order",
        });
      }
    }

    // Validate items if DocumentLines are being updated
    if (req.body.DocumentLines && req.body.DocumentLines.length > 0) {
      const itemCodes = req.body.DocumentLines.map((line) => line.ItemCode);
      const items = await Item.find({ ItemCode: { $in: itemCodes } });

      const itemMap = {};
      items.forEach((item) => {
        itemMap[item.ItemCode] = item;
      });

      const invalidItems = [];
      for (const line of req.body.DocumentLines) {
        const item = itemMap[line.ItemCode];

        if (!item) {
          invalidItems.push({
            ItemCode: line.ItemCode,
            error: "Item not found",
          });
          continue;
        }

        // Add item description if not provided
        if (!line.ItemDescription && item.ItemName) {
          line.ItemDescription = item.ItemName;
        }
      }

      if (invalidItems.length > 0) {
        return res.status(400).json({
          success: false,
          message: "Order contains invalid items",
          invalidItems,
        });
      }

      // Process document lines
      const orderPriceList = req.body.PriceList || existingOrder.PriceList || "2";
      req.body.DocumentLines = req.body.DocumentLines.map((line) => ({
        ...line,
        PriceList: line.PriceList
          ? parseInt(line.PriceList, 10)
          : parseInt(orderPriceList, 10),
        LineTotal: (line.Quantity || 0) * (line.Price || 0),
      }));

      // Recalculate totals
      let total = 0;
      for (const line of req.body.DocumentLines) {
        const lineTotal = line.Quantity * line.Price;
        line.LineTotal = lineTotal;
        total += lineTotal;
      }
      req.body.DocTotal = total;
    }

    // Update local order
    const updateData = {
      ...req.body,
      UpdateDate: new Date(),
      //  LocalStatus: existingOrder.SyncedWithSAP ? "Modified" : existingOrder.LocalStatus,
    };

    // Don't allow changing these critical fields
    delete updateData.DocEntry;
    delete updateData.DocNum;
    delete updateData.SAPDocEntry;
    delete updateData.SyncedWithSAP;
    delete updateData.salesAgent;
    delete updateData.CreationDate;

    // Update the order in database
    Object.assign(existingOrder, updateData);
    await existingOrder.save();

    console.log("Order updated in local database");

    // If the order was previously synced with SAP, update it in SAP as well
    if (existingOrder.DocNum) {
      console.log("Order is synced with SAP, updating SAP order...", existingOrder.DocNum);

      try {
        const currentSAPOrder = await getSalesOrderFromSAP(existingOrder.DocNum);
        console.log("Current SAP order customer:", currentSAPOrder.CardCode);
        console.log("Local DB order customer:", existingOrder.CardCode);

        if (currentSAPOrder.CardCode !== existingOrder.CardCode) {
          console.warn("⚠️ Customer mismatch between SAP and local DB!");
          console.warn(`SAP: ${currentSAPOrder.CardCode}, Local: ${existingOrder.CardCode}`);

          // Option 1: Reject the update
          return res.status(400).json({
            success: false,
            message: `Cannot update order: Customer mismatch. SAP has ${currentSAPOrder.CardCode}, but local DB has ${existingOrder.CardCode}. Customer cannot be changed after order creation.`,
            sapCustomer: currentSAPOrder.CardCode,
            localCustomer: existingOrder.CardCode
          });
        }

        // ✅ USE THE NEW UPDATE-SPECIFIC FORMAT FUNCTION
        const { formatOrderForSAPUpdate } = require("../utils/sapB1Integration");
        const sapUpdateData = await formatOrderForSAPUpdate(existingOrder);

        console.log("Clean SAP update data:", JSON.stringify(sapUpdateData, null, 2));

        // Update in SAP
        const { updateSalesOrderInSAP } = require("../utils/sapB1Integration");
        await updateSalesOrderInSAP(existingOrder.DocNum, sapUpdateData);

        existingOrder.LocalStatus = "Synced";
        existingOrder.SyncErrors = null;
        await existingOrder.save();

        console.log("Order updated successfully in SAP");

        return res.status(200).json({
          success: true,
          message: "Order updated successfully in both database and SAP",
          data: existingOrder,
          sapSync: {
            success: true,
            message: "Successfully synced to SAP",
          },
        });
      } catch (sapError) {
        console.error("Failed to update order in SAP:", sapError);

        existingOrder.LocalStatus = "SyncFailed";
        existingOrder.SyncErrors = sapError.message;
        existingOrder.LastSyncAttempt = new Date();
        await existingOrder.save();

        return res.status(200).json({
          success: true,
          message: "Order updated in database but failed to sync with SAP",
          data: existingOrder,
          sapSync: {
            success: false,
            error: sapError.message,
          },
        });
      }
    } else {
      // Order was never synced to SAP
      return res.status(200).json({
        success: true,
        message: "Order updated successfully in database",
        data: existingOrder,
        sapSync: {
          success: false,
          message: "Order not synced with SAP",
        },
      });
    }
  } catch (error) {
    console.error("Error updating order:", error);
    res.status(500).json({
      success: false,
      message: "Error updating order",
      error: error.message,
    });
  }
};

const dotenv = require("dotenv");

// Load environment variables
dotenv.config();

// SAP B1 Service Layer Configuration
const SAP_CONFIG = {
  serviceLayerUrl: process.env.SAP_SERVICE_LAYER_URL,
  companyDB: process.env.COMPANY_DB,
  username: process.env.USER_NAME,
  password: process.env.PASSWORD,
};

// Update order notes
exports.updateOrderNotes = async (req, res) => {
  try {
    const { docNum } = req.params;
    const { notes } = req.body;

    console.log(`Updating notes for order ${docNum}`);

    const order = await SalesOrder.findOne({ DocNum: docNum });

    if (!order) {
      return res.status(404).json({
        success: false,
        message: `Order with DocNum ${docNum} not found`,
      });
    }

    // Update the U_Notes field
    order.U_Notes = notes || "";
    order.UpdateDate = new Date();

    await order.save();

    console.log(`✅ Notes updated successfully for order ${docNum}`);

    res.status(200).json({
      success: true,
      message: "Order notes updated successfully",
      data: {
        DocNum: order.DocNum,
        U_Notes: order.U_Notes,
      },
    });
  } catch (error) {
    console.error("Error updating order notes:", error);
    res.status(500).json({
      success: false,
      message: "Error updating order notes",
      error: error.message,
    });
  }
};

exports.syncOrderStatusesFromSAP = async (req, res) => {
  try {
    console.log("\n" + "=".repeat(60));
    console.log("STARTING ORDER STATUS SYNC FROM SAP");
    console.log("=".repeat(60));

    const { loginToSAP } = require("../utils/sapB1Integration");

    // Login to SAP
    const sessionId = await loginToSAP();
    const headers = {
      "Content-Type": "application/json",
      Cookie: `B1SESSION=${sessionId}`,
    };

    let openOrdersInSAP = [];
    let totalFetched = 0;

    // Fetch all OPEN orders from SAP with full details
    let nextLink = `${SAP_CONFIG.serviceLayerUrl}/Orders?$filter=DocumentStatus eq 'bost_Open'&$orderby=DocNum`;

    console.log("Fetching open orders from SAP...");

    while (nextLink) {
      try {
        console.log(`Fetching batch from SAP...`);
        const response = await axios.get(nextLink, { headers });

        const currentBatch = response.data.value;
        console.log(`Fetched ${currentBatch.length} orders in this batch`);

        // Store full order details
        openOrdersInSAP.push(...currentBatch);
        totalFetched += currentBatch.length;

        console.log(`Total open orders fetched so far: ${totalFetched}`);

        // Get next link for pagination
        nextLink = response.data["odata.nextLink"];

        if (nextLink && nextLink.startsWith("Orders")) {
          nextLink = `${SAP_CONFIG.serviceLayerUrl}/${nextLink}`;
        }

        // Small delay to avoid overwhelming SAP
        if (nextLink) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }

      } catch (error) {
        console.error("Error fetching batch from SAP:", error.message);
        if (error.response) {
          console.error("SAP Error details:", error.response.data);
        }
        break;
      }
    }

    console.log(`\nTotal open orders in SAP: ${openOrdersInSAP.length}`);

    const sapOpenDocNums = openOrdersInSAP.map(order => order.DocNum);
    console.log("Sample open DocNums in SAP:", sapOpenDocNums.slice(0, 20), "...");

    // *** STEP 1: REMOVE DUPLICATES SILENTLY ***
    console.log("\n🔍 Checking for duplicate orders in local DB...");

    // Find all orders (not just open ones) grouped by DocNum
    const allOrders = await SalesOrder.find({}).select("_id DocNum DocumentStatus CreationDate");

    // Group by DocNum to find duplicates
    const docNumGroups = {};
    allOrders.forEach(order => {
      if (!docNumGroups[order.DocNum]) {
        docNumGroups[order.DocNum] = [];
      }
      docNumGroups[order.DocNum].push(order);
    });

    // Find DocNums that have duplicates
    const duplicateDocNums = Object.keys(docNumGroups).filter(
      docNum => docNumGroups[docNum].length > 1
    );

    let duplicatesRemoved = 0;

    if (duplicateDocNums.length > 0) {
      console.log(`Found ${duplicateDocNums.length} DocNums with duplicates`);

      for (const docNum of duplicateDocNums) {
        const duplicates = docNumGroups[docNum];
        console.log(`DocNum ${docNum} has ${duplicates.length} copies`);

        // Sort by CreationDate (keep the oldest/first one)
        duplicates.sort((a, b) => new Date(a.CreationDate) - new Date(b.CreationDate));

        // Keep the first one, delete the rest
        const toKeep = duplicates[0];
        const toDelete = duplicates.slice(1);

        console.log(`  Keeping order ${toKeep._id} (created: ${toKeep.CreationDate})`);

        for (const duplicate of toDelete) {
          try {
            await SalesOrder.findByIdAndDelete(duplicate._id);
            duplicatesRemoved++;
            console.log(`  ✅ Deleted duplicate ${duplicate._id}`);
          } catch (deleteError) {
            console.error(`  ❌ Failed to delete duplicate ${duplicate._id}:`, deleteError.message);
          }
        }
      }

      console.log(`\n✨ Removed ${duplicatesRemoved} duplicate orders`);
    } else {
      console.log("✅ No duplicates found");
    }

    // *** STEP 2: CONTINUE WITH NORMAL SYNC ***
    // Now find all orders in local DB that are marked as Open (after duplicate removal)
    const localOpenOrders = await SalesOrder.find({
      DocumentStatus: { $in: ["bost_Open", "O"] },
    }).select("DocNum DocumentStatus CardCode CardName DocTotal VatSum DocumentLines U_Notes");

    console.log(`\nTotal open orders in local DB (after duplicate removal): ${localOpenOrders.length}`);

    const localOpenDocNums = localOpenOrders.map(order => order.DocNum);

    // Create a map of SAP orders by DocNum for quick lookup
    const sapOrdersMap = {};
    openOrdersInSAP.forEach(order => {
      sapOrdersMap[order.DocNum] = order;
    });

    // Find orders that are open locally but NOT in SAP's open list
    const ordersToClose = localOpenOrders.filter(
      order => !sapOpenDocNums.includes(order.DocNum)
    );

    // Find orders that are open in SAP but NOT in local DB
    const missingOrderDocNums = sapOpenDocNums.filter(
      docNum => !localOpenDocNums.includes(docNum)
    );

    console.log(`\nOrders to close: ${ordersToClose.length}`);
    console.log(`Missing orders to create: ${missingOrderDocNums.length}`);

    const results = {
      totalOpenInSAP: openOrdersInSAP.length,
      totalOpenInLocalDB: localOpenOrders.length,
      ordersClosed: 0,
      ordersCreated: 0,
      ordersUpdated: 0,
      duplicatesRemoved: duplicatesRemoved,
      errors: [],
      closedOrders: [],
      createdOrders: [],
      updatedOrders: [],
    };

    // *** STEP 3: CHECK FOR UPDATES IN EXISTING OPEN ORDERS ***
    console.log("\n🔄 Checking for updates in existing open orders...");

    for (const localOrder of localOpenOrders) {
      // Skip orders that will be closed
      if (ordersToClose.some(order => order.DocNum === localOrder.DocNum)) {
        continue;
      }

      const sapOrder = sapOrdersMap[localOrder.DocNum];

      if (!sapOrder) {
        continue;
      }

      try {
        // Compare totals to detect changes
        const localTotal = parseFloat(localOrder.DocTotal) || 0;
        const sapTotal = parseFloat(sapOrder.DocTotal) || 0;
        const localVat = parseFloat(localOrder.VatSum) || 0;
        const sapVat = parseFloat(sapOrder.VatSum) || 0;

        // Allow for small floating point differences (0.01)
        const totalDifference = Math.abs(localTotal - sapTotal);
        const vatDifference = Math.abs(localVat - sapVat);

        let hasChanges = totalDifference > 0.01 || vatDifference > 0.01;
        let changeDetails = [];

        if (totalDifference > 0.01) {
          changeDetails.push(`Total changed: ${localTotal} → ${sapTotal}`);
        }
        if (vatDifference > 0.01) {
          changeDetails.push(`VAT changed: ${localVat} → ${sapVat}`);
        }

        // **CHECK FOR CHANGES IN DOCUMENT LINES**
        if (sapOrder.DocumentLines && sapOrder.DocumentLines.length > 0) {
          const localLines = localOrder.DocumentLines || [];
          const sapLines = sapOrder.DocumentLines;

          // Check if number of lines changed
          if (localLines.length !== sapLines.length) {
            hasChanges = true;
            changeDetails.push(`Line count changed: ${localLines.length} → ${sapLines.length}`);
          } else {
            // Compare each line for changes
            for (let i = 0; i < sapLines.length; i++) {
              const sapLine = sapLines[i];

              // Find matching local line by LineNum, or fall back to index
              const localLine = localLines.find(l => l.LineNum === sapLine.LineNum) || localLines[i];

              if (!localLine) {
                hasChanges = true;
                changeDetails.push(`New line added: ${sapLine.ItemCode}`);
                continue;
              }

              // 1. Check ItemCode change (CRITICAL - product substitution)
              if (localLine.ItemCode !== sapLine.ItemCode) {
                hasChanges = true;
                changeDetails.push(`Line ${sapLine.LineNum || i}: Item changed from ${localLine.ItemCode} to ${sapLine.ItemCode}`);
              }

              // 2. Check Quantity change
              const localQty = parseFloat(localLine.Quantity) || 0;
              const sapQty = parseFloat(sapLine.Quantity) || 0;
              if (Math.abs(localQty - sapQty) > 0.001) {
                hasChanges = true;
                changeDetails.push(`Line ${sapLine.LineNum || i} (${sapLine.ItemCode}): Qty ${localQty} → ${sapQty}`);
              }

              // 3. Check Price change
              const localPrice = parseFloat(localLine.Price) || 0;
              const sapPrice = parseFloat(sapLine.Price || sapLine.UnitPrice) || 0;
              if (Math.abs(localPrice - sapPrice) > 0.01) {
                hasChanges = true;
                changeDetails.push(`Line ${sapLine.LineNum || i} (${sapLine.ItemCode}): Price ${localPrice} → ${sapPrice}`);
              }

              // Check if discount changed
              const localDiscount = parseFloat(localLine.DiscountPercent) || 0;
              const sapDiscount = parseFloat(sapLine.DiscountPercent) || 0;
              if (Math.abs(localDiscount - sapDiscount) > 0.01) {
                hasChanges = true;
                changeDetails.push(`Line ${sapLine.LineNum || i}: Discount changed: ${localDiscount}% → ${sapDiscount}%`);
              }

              // 4. Check LineTotal change (CRITICAL - catches calculation differences)
              const localLineTotal = parseFloat(localLine.LineTotal) || 0;
              const sapLineTotal = parseFloat(sapLine.LineTotal) || 0;
              if (Math.abs(localLineTotal - sapLineTotal) > 0.01) {
                hasChanges = true;
                changeDetails.push(`Line ${sapLine.LineNum || i} (${sapLine.ItemCode}): Total ${localLineTotal} → ${sapLineTotal}`);
              }

              // 5. Check VatGroup change (affects tax calculations)
              if (localLine.VatGroup !== sapLine.VatGroup) {
                hasChanges = true;
                changeDetails.push(`Line ${sapLine.LineNum || i} (${sapLine.ItemCode}): VAT ${localLine.VatGroup} → ${sapLine.VatGroup}`);
              }

              // 6. Check WarehouseCode change (affects inventory location)
              if (localLine.WarehouseCode !== sapLine.WarehouseCode) {
                hasChanges = true;
                changeDetails.push(`Line ${sapLine.LineNum || i} (${sapLine.ItemCode}): Warehouse ${localLine.WarehouseCode} → ${sapLine.WarehouseCode}`);
              }
            }
          }
        }

        if (hasChanges) {
          console.log(`📝 Order ${localOrder.DocNum} has been modified in SAP`);
          console.log(`   Changes detected:`);
          changeDetails.forEach(detail => console.log(`   - ${detail}`));

          // Update the order with SAP data
          localOrder.DocTotal = sapOrder.DocTotal;
          localOrder.VatSum = sapOrder.VatSum;
          localOrder.DocCurrency = sapOrder.DocCurrency || localOrder.DocCurrency;
          localOrder.DiscountPercent = sapOrder.DiscountPercent || localOrder.DiscountPercent;
          localOrder.Address = sapOrder.Address || localOrder.Address;
          localOrder.Address2 = sapOrder.Address2 || localOrder.Address2;
          localOrder.DocDate = sapOrder.DocDate || localOrder.DocDate;
          localOrder.DocDueDate = sapOrder.DocDueDate || localOrder.DocDueDate;
          localOrder.StartDeliveryDate = sapOrder.StartDeliveryDate || localOrder.StartDeliveryDate;
          localOrder.RequriedDate = sapOrder.RequriedDate || localOrder.RequriedDate;
          localOrder.U_Notes = sapOrder.Comments || localOrder.U_Notes;

          // Update document lines if they exist in SAP
          // Update document lines if they exist in SAP
          if (sapOrder.DocumentLines && sapOrder.DocumentLines.length > 0) {
            localOrder.DocumentLines = sapOrder.DocumentLines.map((line, index) => {
              const originalPrice = line.Price || line.UnitPrice || 0;
              const discountPercent = parseFloat(line.DiscountPercent) || 0;

              // Calculate effective price after discount
              // If discount is 100%, price becomes 0
              const effectivePrice = discountPercent >= 100 ? 0 : originalPrice * (1 - discountPercent / 100);

              return {
                LineNum: line.LineNum || index,
                ItemCode: line.ItemCode,
                ItemDescription: line.ItemDescription,
                Quantity: line.Quantity,
                Price: effectivePrice,  // Store the effective price after discount
                OriginalPrice: originalPrice,  // Store original price for reference
                DiscountPercent: discountPercent,
                PriceAfterVAT: line.PriceAfterVAT,
                Currency: line.Currency || sapOrder.DocCurrency,
                LineTotal: line.LineTotal,
                VatGroup: line.VatGroup,
                PriceList: line.PriceList || sapOrder.PriceList,
                WarehouseCode: line.WarehouseCode,
              };
            });
          }

          localOrder.UpdateDate = new Date();
          localOrder.LocalStatus = "Synced";

          await localOrder.save();

          results.ordersUpdated++;
          results.updatedOrders.push({
            DocNum: localOrder.DocNum,
            CardCode: localOrder.CardCode,
            CardName: localOrder.CardName,
            oldTotal: localTotal,
            newTotal: sapTotal,
            difference: totalDifference,
            changes: changeDetails,
          });

          console.log(`✅ Order ${localOrder.DocNum} updated successfully`);
        }

      } catch (error) {
        console.error(`❌ Error updating order ${localOrder.DocNum}:`, error.message);
        results.errors.push({
          DocNum: localOrder.DocNum,
          action: "update",
          error: error.message,
        });
      }
    }

    // *** STEP 4: CLOSE ORDERS ***
    for (const order of ordersToClose) {
      try {
        console.log(`Closing order DocNum: ${order.DocNum} (${order.CardCode})`);

        order.DocumentStatus = "bost_Close";
        order.UpdateDate = new Date();
        order.LocalStatus = "Synced";
        order.U_Notes = (order.U_Notes || "") + ` [Auto-closed via status sync on ${new Date().toISOString()}]`;

        await order.save();

        results.ordersClosed++;
        results.closedOrders.push({
          DocNum: order.DocNum,
          CardCode: order.CardCode,
          CardName: order.CardName,
        });

        console.log(`✅ Order ${order.DocNum} closed successfully`);

      } catch (error) {
        console.error(`❌ Error closing order ${order.DocNum}:`, error.message);
        results.errors.push({
          DocNum: order.DocNum,
          action: "close",
          error: error.message,
        });
      }
    }

    // *** STEP 5: CREATE MISSING ORDERS ***
    for (const docNum of missingOrderDocNums) {
      try {
        // Find the full order details from our SAP data
        const sapOrder = openOrdersInSAP.find(order => order.DocNum === docNum);

        if (!sapOrder) {
          console.log(`⚠️ Could not find details for DocNum ${docNum}`);
          continue;
        }

        console.log(`Creating missing order DocNum: ${sapOrder.DocNum} (${sapOrder.CardCode})`);

        // Create the order in local DB
        const newOrder = new SalesOrder({
          DocEntry: sapOrder.DocEntry,
          DocNum: sapOrder.DocNum,
          DocType: sapOrder.DocObjectCode || "dDocument_Items",
          CardCode: sapOrder.CardCode,
          CardName: sapOrder.CardName,
          Address: sapOrder.Address,
          Address2: sapOrder.Address2,
          DocDate: sapOrder.DocDate,
          DocDueDate: sapOrder.DocDueDate,
          TaxDate: sapOrder.TaxDate,
          CreationDate: sapOrder.CreationDate || new Date(),
          UpdateDate: new Date(),
          DocTotal: sapOrder.DocTotal,
          DocCurrency: sapOrder.DocCurrency || "EUR",
          VatSum: sapOrder.VatSum,
          DiscountPercent: sapOrder.DiscountPercent,
          PriceList: sapOrder.PriceList,
          StartDeliveryDate: sapOrder.StartDeliveryDate || sapOrder.DocDate,
          RequriedDate: sapOrder.RequriedDate || sapOrder.DocDate,
          DocumentLines: sapOrder.DocumentLines?.map((line, index) => {
            const originalPrice = line.Price || line.UnitPrice || 0;
            const discountPercent = parseFloat(line.DiscountPercent) || 0;

            // Calculate effective price after discount
            // If discount is 100%, price becomes 0
            const effectivePrice = discountPercent >= 100 ? 0 : originalPrice * (1 - discountPercent / 100);

            return {
              LineNum: line.LineNum || index,
              ItemCode: line.ItemCode,
              ItemDescription: line.ItemDescription,
              Quantity: line.Quantity,
              Price: effectivePrice,  // Store the effective price after discount
              OriginalPrice: originalPrice,  // Store original price for reference
              DiscountPercent: discountPercent,
              PriceAfterVAT: line.PriceAfterVAT,
              Currency: line.Currency || sapOrder.DocCurrency,
              LineTotal: line.LineTotal,
              VatGroup: line.VatGroup,
              PriceList: line.PriceList || sapOrder.PriceList,
              WarehouseCode: line.WarehouseCode,
            };
          }) || [],
          DocumentStatus: sapOrder.DocumentStatus || "bost_Open",
          Cancelled: sapOrder.Cancelled || "N",
          SyncedWithSAP: true,
          SAPDocEntry: sapOrder.DocEntry,
          LocalStatus: "Synced",
          ImportDate: new Date(),
          ImportSource: "Status_Sync",
          Comments: sapOrder.Comments || "",
          U_Notes: sapOrder.Comments || "",
        });

        await newOrder.save();

        results.ordersCreated++;
        results.createdOrders.push({
          DocNum: sapOrder.DocNum,
          CardCode: sapOrder.CardCode,
          CardName: sapOrder.CardName,
          DocTotal: sapOrder.DocTotal,
        });

        console.log(`✅ Order ${sapOrder.DocNum} created successfully`);

      } catch (error) {
        console.error(`❌ Error creating order ${docNum}:`, error.message);
        results.errors.push({
          DocNum: docNum,
          action: "create",
          error: error.message,
        });
      }
    }

    const finalLocalOpenCount = localOpenOrders.length - results.ordersClosed + results.ordersCreated;

    console.log("\n" + "=".repeat(60));
    console.log("ORDER STATUS SYNC COMPLETED");
    console.log(`Duplicates removed: ${duplicatesRemoved}`);
    console.log(`Open orders in SAP: ${results.totalOpenInSAP}`);
    console.log(`Open orders in Local DB (before): ${results.totalOpenInLocalDB}`);
    console.log(`Orders closed: ${results.ordersClosed}`);
    console.log(`Orders created: ${results.ordersCreated}`);
    console.log(`Orders updated: ${results.ordersUpdated}`);
    console.log(`Open orders in Local DB (after): ${finalLocalOpenCount}`);
    console.log(`Errors: ${results.errors.length}`);
    console.log("=".repeat(60) + "\n");

    res.status(200).json({
      success: true,
      message: `Order status sync completed. ${results.ordersClosed} closed, ${results.ordersCreated} created, ${results.ordersUpdated} updated.`,
      data: {
        ...results,
        finalLocalOpenCount,
        matched: finalLocalOpenCount === results.totalOpenInSAP,
      },
    });

  } catch (error) {
    console.error("Error in syncOrderStatusesFromSAP:", error);
    res.status(500).json({
      success: false,
      message: "Error syncing order statuses from SAP",
      error: error.message,
    });
  }
};

// Update notes for all open orders from SAP
exports.updateNotesForOpenOrders = async (req, res) => {
  try {
    console.log("\n" + "=".repeat(60));
    console.log("UPDATING NOTES FOR ALL OPEN ORDERS FROM SAP");
    console.log("=".repeat(60));

    const { loginToSAP } = require("../utils/sapB1Integration");
    const axios = require("axios");

    // Login to SAP
    const sessionId = await loginToSAP();
    const headers = {
      "Content-Type": "application/json",
      Cookie: `B1SESSION=${sessionId}`,
    };

    let openOrdersInSAP = [];
    let totalFetched = 0;

    // Fetch all OPEN orders from SAP with full details
    let nextLink = `${SAP_CONFIG.serviceLayerUrl}/Orders?$filter=DocumentStatus eq 'bost_Open'&$orderby=DocNum`;

    console.log("Fetching open orders from SAP...");

    while (nextLink) {
      try {
        console.log(`Fetching batch from SAP...`);
        const response = await axios.get(nextLink, { headers });

        const currentBatch = response.data.value;
        console.log(`Fetched ${currentBatch.length} orders in this batch`);

        openOrdersInSAP.push(...currentBatch);
        totalFetched += currentBatch.length;

        console.log(`Total open orders fetched so far: ${totalFetched}`);

        nextLink = response.data["odata.nextLink"];

        if (nextLink && nextLink.startsWith("Orders")) {
          nextLink = `${SAP_CONFIG.serviceLayerUrl}/${nextLink}`;
        }

        if (nextLink) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }

      } catch (error) {
        console.error("Error fetching batch from SAP:", error.message);
        if (error.response) {
          console.error("SAP Error details:", error.response.data);
        }
        break;
      }
    }

    console.log(`\nTotal open orders fetched from SAP: ${openOrdersInSAP.length}`);

    // Find all open orders in local DB
    const localOpenOrders = await SalesOrder.find({
      DocumentStatus: { $in: ["bost_Open", "O"] },
    }).select("DocNum U_Notes");

    console.log(`Total open orders in local DB: ${localOpenOrders.length}`);

    const results = {
      totalInSAP: openOrdersInSAP.length,
      totalInLocal: localOpenOrders.length,
      updated: 0,
      notFoundInSAP: 0,
      noRemarks: 0,
      alreadyUpToDate: 0,
      errors: [],
      updatedOrders: [],
    };

    // Create a map of SAP orders by DocNum for quick lookup
    const sapOrdersMap = {};
    openOrdersInSAP.forEach(order => {
      sapOrdersMap[order.DocNum] = order;
    });

    // Update each local open order
    for (const localOrder of localOpenOrders) {
      try {
        const sapOrder = sapOrdersMap[localOrder.DocNum];

        if (!sapOrder) {
          console.log(`⚠️ Order ${localOrder.DocNum} not found in SAP open orders`);
          results.notFoundInSAP++;
          continue;
        }

        // Get remarks from SAP (try multiple possible field names)
        // Get comments from SAP
        const remarks = sapOrder.Comments || "";
        if (!remarks || remarks.trim() === "") {
          console.log(`ℹ️ Order ${localOrder.DocNum} has no remarks in SAP`);
          results.noRemarks++;
          continue;
        }

        // Check if already up to date
        if (localOrder.U_Notes === remarks) {
          console.log(`✓ Order ${localOrder.DocNum} already has correct notes`);
          results.alreadyUpToDate++;
          continue;
        }

        // Update the notes
        const oldNotes = localOrder.U_Notes || "(empty)";
        localOrder.U_Notes = remarks;
        localOrder.UpdateDate = new Date();

        await localOrder.save();

        results.updated++;
        results.updatedOrders.push({
          DocNum: localOrder.DocNum,
          oldNotes: oldNotes.substring(0, 50),
          newNotes: remarks.substring(0, 50),
        });

        console.log(`✅ Updated Order ${localOrder.DocNum}`);
        console.log(`   Old: ${oldNotes.substring(0, 60)}...`);
        console.log(`   New: ${remarks.substring(0, 60)}...`);

      } catch (error) {
        console.error(`❌ Error updating order ${localOrder.DocNum}:`, error.message);
        results.errors.push({
          DocNum: localOrder.DocNum,
          error: error.message,
        });
      }
    }

    console.log("\n" + "=".repeat(60));
    console.log("NOTES UPDATE COMPLETED");
    console.log(`Total orders in SAP: ${results.totalInSAP}`);
    console.log(`Total orders in Local DB: ${results.totalInLocal}`);
    console.log(`Updated: ${results.updated}`);
    console.log(`Already up to date: ${results.alreadyUpToDate}`);
    console.log(`No remarks in SAP: ${results.noRemarks}`);
    console.log(`Not found in SAP: ${results.notFoundInSAP}`);
    console.log(`Errors: ${results.errors.length}`);
    console.log("=".repeat(60) + "\n");

    res.status(200).json({
      success: true,
      message: `Notes update completed. ${results.updated} orders updated.`,
      data: results,
    });

  } catch (error) {
    console.error("Error updating notes from SAP:", error);
    res.status(500).json({
      success: false,
      message: "Error updating notes from SAP",
      error: error.message,
    });
  }
};