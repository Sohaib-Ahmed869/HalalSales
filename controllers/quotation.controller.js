// controllers/quotation.controller.js
const Quotation = require("../models/Quotation");
const SalesOrder = require("../models/SalesOrder");
const Task = require("../models/Task");
const User = require("../models/User");
const Item = require("../models/item");
const customerTargetController = require("./customerTarget.controller");
const {
  formatOrderForSAP,
  createSalesOrderInSAP,
  checkBusinessPartnerExists,
} = require("../utils/sapB1Integration");
const Customer = require("../models/Customer");

// Helper function to update sales agent stats
async function updateSalesAgentAchievement(salesAgentId, order) {
  const agent = await User.findById(salesAgentId);
  if (!agent) return;

  // Increment a counter of successfully synced orders
  agent.syncedOrderCount = (agent.syncedOrderCount || 0) + 1;
  await agent.save();
}

// Helper function to push converted order to SAP
async function pushOrderToSAPInternal(order) {
  try {
    // Format the order for SAP B1
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
        order.SAPSyncDisabled = true;
        await order.save();

        return {
          success: false,
          error: order.SyncErrors,
          code: "BP_NOT_FOUND",
        };
      }
    } catch (bpError) {
      console.warn(
        `Could not verify business partner in SAP: ${bpError.message}`
      );
    }

    // Push to SAP B1
    const sapResponse = await createSalesOrderInSAP(sapOrder);

    // Update local order with SAP DocEntry if successful
    if (sapResponse && sapResponse.DocEntry) {
      order.SAPDocEntry = sapResponse.DocEntry;
      order.DocumentStatus = "bost_Closed";
      order.UpdateDate = new Date();
      order.SyncedWithSAP = true;
      order.LocalStatus = "Synced";

      await order.save();

      // Update sales agent stats for synced order
      if (order.salesAgent) {
        await updateSalesAgentAchievement(order.salesAgent, order);
      }

      return {
        success: true,
        SAPDocEntry: sapResponse.DocEntry,
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

// Create a new quotation (saved to local DB only)
exports.createQuotation = async (req, res) => {
  try {
    // Validate required fields
    if (!req.body.CardCode) {
      return res.status(400).json({
        success: false,
        message: "Customer (CardCode) is required",
      });
    }

    const salesAgentId = req.user._id;

    // Validate that at least one document line exists
    if (!req.body.DocumentLines || req.body.DocumentLines.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Quotation must contain at least one item",
      });
    }

    // Validate items without checking stock availability
    const itemCodes = req.body.DocumentLines.map((line) => line.ItemCode);
    const items = await Item.find({ ItemCode: { $in: itemCodes } });
    const adminUsers = await User.find({ role: "admin" }).select("_id");

    // Create a map for quick lookups
    const itemMap = {};
    items.forEach((item) => {
      itemMap[item.ItemCode] = item;
    });

    // Check if all items exist
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
        message: "Quotation contains invalid items",
        invalidItems,
      });
    }

    // Generate DocEntry
    const lastQuotation = await Quotation.findOne().sort({ DocEntry: -1 });
    const newDocEntry = lastQuotation ? lastQuotation.DocEntry + 1 : 1;

    // Calculate today's date
    const today = new Date();

    // Create the new quotation
    const newQuotation = new Quotation({
      ...req.body,
      DocEntry: newDocEntry,
      DocNum: newDocEntry,
      DocType: req.body.DocType || "dDocument_Items",
      DocumentStatus: "bost_Open",
      CreationDate: today,
      DocDate: req.body.DocDate || today,
      DocDueDate: req.body.DocDueDate || today,
      UpdateDate: today,
      SyncedWithSAP: false,
      LocalStatus: "Created",
      salesAgent: salesAgentId,
      IsActive: true, // Mark as active by default
    });

    // Calculate totals if not provided
    if (!newQuotation.DocTotal) {
      let total = 0;
      for (const line of newQuotation.DocumentLines) {
        const lineTotal = line.Quantity * line.Price;
        line.LineTotal = lineTotal;
        total += lineTotal;
      }
      newQuotation.DocTotal = total;
    }

    if (adminUsers.length > 0) {
      // Assign to the first admin (or you could implement round-robin assignment)
      const adminId = adminUsers[0]._id;

      // Create new task for quotation approval
      const task = new Task({
        title: `Approve Quotation #${newQuotation.DocNum}`,
        description: `Review and approve quotation #${
          newQuotation.DocNum
        } for ${newQuotation.CardName} (${
          newQuotation.CardCode
        }) - Total: $${newQuotation.DocTotal.toFixed(2)}`,
        dueDate: new Date(new Date().setDate(new Date().getDate() + 1)), // Due tomorrow
        priority: "medium",
        type: "approval",
        status: "pending",
        assignedTo: adminId,
        createdBy: salesAgentId,
        relatedQuotation: newQuotation.DocEntry,
      });

      await task.save();

      // Link the task to the quotation
      newQuotation.approvalTask = task._id;
      newQuotation.approvalStatus = "pending";
      await newQuotation.save();
    }

    res.status(201).json({
      success: true,
      data: newQuotation,
      message: "Quotation created successfully",
    });
  } catch (error) {
    console.error("Error creating quotation:", error);
    res.status(500).json({
      success: false,
      message: "Error creating quotation",
      error: error.message,
    });
  }
};

// Get all quotations with pagination
exports.getAllQuotations = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // Base query - only show active quotations by default
    let query = { IsActive: true };

    // Add option to show inactive quotations if requested
    if (req.query.showInactive === "true") {
      query = {};
    }

    // Add filters if provided
    if (req.query.cardCode) {
      query.CardCode = req.query.cardCode;
    }

    if (req.query.status) {
      query.DocumentStatus = req.query.status;
    }

    if (req.query.fromDate && req.query.toDate) {
      query.DocDate = {
        $gte: new Date(req.query.fromDate),
        $lte: new Date(req.query.toDate),
      };
    }

    // Filter for current user if sales agent
    if (req.user.role === "sales_agent") {
      query.salesAgent = req.user._id;
    }

    // If sales manager, get all quotations from their agents
    if (req.user.role === "sales_manager") {
      const agentIds = await User.find({ manager: req.user._id }).distinct(
        "_id"
      );
      query.salesAgent = { $in: agentIds };
    }

    const quotations = await Quotation.find(query)
      .populate("salesAgent", "firstName lastName email")
      .skip(skip)
      .limit(limit)
      .sort({ DocDate: -1 });

    const total = await Quotation.countDocuments(query);

    res.status(200).json({
      success: true,
      count: quotations.length,
      total,
      page,
      pages: Math.ceil(total / limit),
      data: quotations,
    });
  } catch (error) {
    console.error("Error fetching quotations:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching quotations",
      error: error.message,
    });
  }
};

// Get quotations for a specific customer
exports.getQuotationsByCustomer = async (req, res) => {
  try {
    const { cardCode } = req.params;
    console.log("Fetching quotations for customer:", cardCode);
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    // Base query - only show active quotations by default
    const query = { CardCode: cardCode };

    // Add option to show inactive quotations if requested
    if (req.query.showInactive === "true") {
      delete query.IsActive;
    }

    // If sales manager, get all quotations from their agents
    if (req.user.role === "sales_manager") {
      const agentIds = await User.find({ manager: req.user._id }).distinct(
        "_id"
      );
      query.salesAgent = { $in: agentIds };
    }

    const quotations = await Quotation.find(query)
      .populate("salesAgent", "firstName lastName email")
      .skip(skip)
      .limit(limit)
      .sort({ DocDate: -1 });

    const total = await Quotation.countDocuments(query);

    res.status(200).json({
      success: true,
      count: quotations.length,
      total,
      page,
      pages: Math.ceil(total / limit),
      customerCode: cardCode,
      data: quotations,
    });
  } catch (error) {
    console.log("Error fetching customer quotations:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching customer quotations",
      error: error.message,
    });
  }
};

// Get a single quotation by DocEntry
exports.getQuotationByDocEntry = async (req, res) => {
  try {
    const quotation = await Quotation.findOne({
      DocEntry: req.params.docEntry,
    }).populate("salesAgent", "firstName lastName email");

    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: `Quotation with DocEntry ${req.params.docEntry} not found`,
      });
    }

    // Check permissions for sales agents
    if (
      req.user.role === "sales_agent" &&
      quotation.salesAgent &&
      quotation.salesAgent._id.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to view this quotation",
      });
    }

    // Check permissions for sales managers
    if (req.user.role === "sales_manager" && quotation.salesAgent) {
      const agent = await User.findById(quotation.salesAgent._id);
      if (!agent || agent.manager.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: "Not authorized to view this quotation",
        });
      }
    }

    res.status(200).json({
      success: true,
      data: quotation,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching quotation",
      error: error.message,
    });
  }
};



// Convert quotation to sales order
exports.convertToOrder = async (req, res) => {
  try {
    // Find the quotation
    const quotation = await Quotation.findOne({
      DocEntry: req.params.docEntry,
      IsActive: true,
    });

    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: `Active quotation with DocEntry ${req.params.docEntry} not found`,
      });
    }

    if (quotation.approvalStatus !== "approved") {
      return res.status(403).json({
        success: false,
        message:
          "Quotation must be approved by an admin before conversion to order",
      });
    }

    // Check permissions for sales agents
    if (
      req.user.role === "sales_agent" &&
      quotation.salesAgent &&
      quotation.salesAgent.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to convert this quotation",
      });
    }

    // Generate DocEntry for the new order
    const lastOrder = await SalesOrder.findOne().sort({ DocEntry: -1 });
    const newDocEntry = lastOrder ? lastOrder.DocEntry + 1 : 1;

    // Create the sales order from the quotation data
    const newOrder = new SalesOrder({
      // Copy all fields from quotation except specific fields that need to be fresh
      ...quotation.toObject(),
      DocEntry: newDocEntry,
      DocNum: newDocEntry,
      CreationDate: new Date(),
      UpdateDate: new Date(),
      DocDate: req.body.DocDate || new Date(),
      DocDueDate: req.body.DocDueDate || new Date(),
      SyncedWithSAP: false,
      LocalStatus: "Created",
      // Override with any additional data from the request body
      ...req.body,
      // Ensure we keep the original references
      salesAgent: quotation.salesAgent,
      // Reference to original quotation
      OriginatingQuotation: quotation.DocEntry,
    });

    // Save the new order
    await newOrder.save();

    // Update customer target
    const updatedTarget =
      await customerTargetController.updateCustomerTargetProgress(newOrder);

    // Mark quotation as inactive (converted)
    quotation.IsActive = false;
    quotation.ConvertedToOrderDocEntry = newOrder.DocEntry;
    quotation.ConvertedDate = new Date();
    await quotation.save();

    // Push to SAP
    console.log("Pushing converted order to SAP...");
    const sapResult = await pushOrderToSAPInternal(newOrder);

    // Return response
    if (sapResult.success) {
      res.status(201).json({
        success: true,
        data: newOrder,
        originalQuotation: {
          DocEntry: quotation.DocEntry,
          status: "Converted",
        },
        message:
          "Quotation successfully converted to order and synced with SAP",
        targetUpdated: updatedTarget ? true : false,
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
        originalQuotation: {
          DocEntry: quotation.DocEntry,
          status: "Converted",
        },
        message: "Quotation converted to order but failed to sync with SAP",
        targetUpdated: updatedTarget ? true : false,
        sapSync: {
          success: false,
          error: sapResult.error,
          message: sapErrorMessage,
          code: sapResult.code,
        },
      });
    }
  } catch (error) {
    console.error("Error converting quotation to order:", error);
    res.status(500).json({
      success: false,
      message: "Error converting quotation to order",
      error: error.message,
    });
  }
};

// Update quotation
exports.updateQuotation = async (req, res) => {
  try {
    const quotation = await Quotation.findOne({
      DocEntry: req.params.docEntry,
      IsActive: true,
    });

    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: `Active quotation with DocEntry ${req.params.docEntry} not found`,
      });
    }

    // Check permissions for sales agents
    if (
      req.user.role === "sales_agent" &&
      quotation.salesAgent &&
      quotation.salesAgent.toString() !== req.user._id.toString()
    ) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to update this quotation",
      });
    }

    // Fields that cannot be updated
    const protectedFields = [
      "DocEntry",
      "DocNum",
      "CreationDate",
      "salesAgent",
      "IsActive",
      "ConvertedToOrderDocEntry",
      "ConvertedDate",
    ];

    // Remove protected fields from the update
    protectedFields.forEach((field) => {
      if (req.body[field] !== undefined) {
        delete req.body[field];
      }
    });

    // Update allowed fields
    Object.keys(req.body).forEach((key) => {
      quotation[key] = req.body[key];
    });

    // Update the UpdateDate
    quotation.UpdateDate = new Date();

    // Recalculate totals if DocumentLines are updated
    if (req.body.DocumentLines) {
      let total = 0;
      for (const line of quotation.DocumentLines) {
        const lineTotal = line.Quantity * line.Price;
        line.LineTotal = lineTotal;
        total += lineTotal;
      }
      quotation.DocTotal = total;
    }

    await quotation.save();

    res.status(200).json({
      success: true,
      data: quotation,
      message: "Quotation updated successfully",
    });
  } catch (error) {
    console.error("Error updating quotation:", error);
    res.status(500).json({
      success: false,
      message: "Error updating quotation",
      error: error.message,
    });
  }
};

// Cancel/deactivate quotation
exports.cancelQuotation = async (req, res) => {
  try {
    const quotation = await Quotation.findOne({
      DocEntry: req.params.docEntry,
      IsActive: true,
    });

    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: `Active quotation with DocEntry ${req.params.docEntry} not found`,
      });
    }

    // Deactivate the quotation
    quotation.IsActive = false;
    quotation.CancelReason = req.body.reason || "Cancelled by user";
    quotation.CancelDate = new Date();
    quotation.DocumentStatus = "bost_Close"; // Or another appropriate status

    await quotation.save();

    res.status(200).json({
      success: true,
      data: {
        DocEntry: quotation.DocEntry,
        status: "Cancelled",
        reason: quotation.CancelReason,
      },
      message: "Quotation cancelled successfully",
    });
  } catch (error) {
    console.error("Error cancelling quotation:", error);
    res.status(500).json({
      success: false,
      message: "Error cancelling quotation",
      error: error.message,
    });
  }
};

// Duplicate quotation
exports.duplicateQuotation = async (req, res) => {
  try {
    const quotation = await Quotation.findOne({
      DocEntry: req.params.docEntry,
    });

    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: `Quotation with DocEntry ${req.params.docEntry} not found`,
      });
    }

    // Generate new DocEntry
    const lastQuotation = await Quotation.findOne().sort({ DocEntry: -1 });
    const newDocEntry = lastQuotation ? lastQuotation.DocEntry + 1 : 1;

    const quotationObject = quotation.toObject();
    delete quotationObject._id;

    // Create new quotation based on the original
    const duplicatedQuotation = new Quotation({
      ...quotationObject,
      DocEntry: newDocEntry,
      DocNum: newDocEntry,
      CreationDate: new Date(),
      UpdateDate: new Date(),
      DocDate: new Date(),
      DocDueDate: new Date(),
      IsActive: true,
      // Keep the same sales agent
      salesAgent: quotation.salesAgent,
      // Reference to the original
      DuplicatedFrom: quotation.DocEntry,
    });

    // Remove any converted/cancelled statuses from the original
    delete duplicatedQuotation.ConvertedToOrderDocEntry;
    delete duplicatedQuotation.ConvertedDate;
    delete duplicatedQuotation.CancelReason;
    delete duplicatedQuotation.CancelDate;

    await duplicatedQuotation.save();

    res.status(201).json({
      success: true,
      data: duplicatedQuotation,
      originalQuotation: {
        DocEntry: quotation.DocEntry,
      },
      message: "Quotation duplicated successfully",
    });
  } catch (error) {
    console.error("Error duplicating quotation:", error);
    res.status(500).json({
      success: false,
      message: "Error duplicating quotation",
      error: error.message,
    });
  }
};

// Add to controllers/quotation.controller.js

exports.sendQuotationByEmail = async (req, res) => {
  try {
    console.log("Received request to send quotation by email", req.body);
    const quotationId = req.params.docEntry;
    const emailData = req.body;

    if (!emailData || !emailData.to) {
      return res.status(400).json({
        success: false,
        message: "Recipient email address is required",
      });
    }

    console.log(
      `Processing quotation ${quotationId} for email to ${emailData.to}`
    );

    // Find the quotation
    const quotation = await Quotation.findOne({
      DocEntry: quotationId,
    }).populate("salesAgent", "firstName lastName email");

    if (!quotation) {
      return res.status(404).json({
        success: false,
        message: `Quotation with ID ${quotationId} not found`,
      });
    }

    // Find the customer
    const customer = await Customer.findOne({
      CardCode: quotation.CardCode,
    });

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: `Customer with CardCode ${quotation.CardCode} not found`,
      });
    }
    const customerForTemplate = {
      CardName: customer.CardName || "Customer",
      // Directly flatten address fields to avoid nested property access issues
      street: customer.address?.street || customer.Address || "",
      city: customer.address?.city || customer.City || "",
      zipCode: customer.address?.zipCode || customer.ZipCode || "",
      Country: customer.Country || "",
      Phone: customer.Phone || customer.Telephone || "",
    };

    console.log("Prepared customer template data:", customerForTemplate);
    console.log("Here is the customer", customer);

    // Generate PDF
    console.log("Generating PDF...");
    let pdfBuffer;
    try {
      const pdfGenerator = require("../utils/pdfGenerator");
      pdfBuffer = await pdfGenerator.generateQuotationPDF(
        quotation,
        customerForTemplate
      );
      // Log PDF details
      console.log(`PDF generated successfully: ${pdfBuffer.length} bytes`);
    } catch (pdfError) {
      console.error("Error generating PDF:", pdfError);
      return res.status(500).json({
        success: false,
        message: `Error generating PDF: ${pdfError.message}`,
      });
    }

    // Send email with attachment
    console.log("Sending email with PDF attachment...");
    try {
      const emailService = require("../utils/emailService");

      // Format the email for better deliverability
      const emailText =
        emailData.message ||
        `Cher client,\n\nVeuillez trouver ci-joint votre devis #${quotation.DocNum}.\n\nCordialement,\nL'équipe Halal Food Service`;

      const emailHtml = emailText.replace(/\n/g, "<br>");

      const info = await emailService.sendEmail({
        to: emailData.to,
        cc: emailData.cc || "",
        subject: emailData.subject || `Devis HFS #${quotation.DocNum}`,
        text: emailText,
        html: emailHtml,
        attachments: [
          {
            filename: `Devis_HFS_${quotation.DocNum}.pdf`,
            content: pdfBuffer,
            contentType: "application/pdf",
            encoding: "binary",
          },
        ],
      });

      // Record email sent
      quotation.emailSentTo = quotation.emailSentTo || [];
      quotation.emailSentTo.push({
        email: emailData.to,
        sentBy: req.user._id,
        sentDate: new Date(),
        messageId: info.messageId,
      });

      await quotation.save();

      return res.status(200).json({
        success: true,
        message: "Email sent successfully",
        messageId: info.messageId,
      });
    } catch (emailError) {
      console.error("Error sending email:", emailError);
      return res.status(500).json({
        success: false,
        message: `Error sending email: ${emailError.message}`,
      });
    }
  } catch (error) {
    console.error("Error in sendQuotationByEmail:", error);
    return res.status(500).json({
      success: false,
      message: `An unexpected error occurred: ${error.message}`,
    });
  }
};
// Helper functions

// Generate PDF from quotation data (implementation depends on your PDF library)
async function generateQuotationPDF(quotation) {
  try {
    // This is a placeholder - you would use a PDF library like PDFKit, Puppeteer, or html-pdf
    // To convert your quotation HTML template to PDF

    // Example with puppeteer (you would need to install it):
    // const puppeteer = require('puppeteer');
    // const browser = await puppeteer.launch();
    // const page = await browser.newPage();
    // await page.setContent(quotationHTMLTemplate(quotation));
    // const pdfBuffer = await page.pdf({ format: 'A4' });
    // await browser.close();
    // return pdfBuffer;

    // Placeholder implementation
    const pdfBuffer = Buffer.from("PDF content would be here");
    return pdfBuffer;
  } catch (error) {
    console.error("Error generating PDF:", error);
    throw new Error("Failed to generate quotation PDF");
  }
}

// Updated sendEmailWithAttachment function with full implementation
async function sendEmailWithAttachment({ to, cc, subject, text, attachments }) {
  try {
    const nodemailer = require("nodemailer");
    const config = require("../config/config");

    // Create reusable transporter using SMTP configuration
    const transporter = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.port === 465, // true for 465, false for other ports
      auth: {
        user: config.email.user,
        pass: config.email.password,
      },
      // Optional: Configure for SSL verification if needed
      tls: {
        rejectUnauthorized: false, // Only set to false if required for self-signed certificates
      },
    });

    // Prepare email options
    const mailOptions = {
      from: `"${config.email.senderName}" <${config.email.user}>`,
      to: to,
      subject: subject,
      text: text,
    };

    // Add CC if provided
    if (cc && cc.trim() !== "") {
      mailOptions.cc = cc;
    }

    // Add HTML version of the message for better formatting
    if (text) {
      // Convert plain text to HTML
      mailOptions.html = text.replace(/\n/g, "<br>");
    }

    // Add attachments if provided
    if (attachments && Array.isArray(attachments) && attachments.length > 0) {
      mailOptions.attachments = attachments;
    }

    // Log that we're about to send an email (for debugging)
    console.log(`Sending email to ${to}${cc ? " with CC to " + cc : ""}`);

    // Verify connection configuration before sending
    transporter.verify(function (error, success) {
      if (error) {
        console.error("SMTP verification error:", error);
      } else {
        console.log("SMTP server is ready to take our messages");
      }
    });

    // Send mail with defined transport object
    const info = await transporter.sendMail(mailOptions);

    // Log success
    console.log(
      `Email sent successfully to ${to}. Message ID: ${info.messageId}`
    );

    // If SMTP server provides delivery status, log it
    if (info.accepted && info.accepted.length > 0) {
      console.log(
        `Email accepted by SMTP server for: ${info.accepted.join(", ")}`
      );
    }

    if (info.rejected && info.rejected.length > 0) {
      console.warn(
        `Email rejected by SMTP server for: ${info.rejected.join(", ")}`
      );
    }

    return info;
  } catch (error) {
    console.error("Error sending email:", error);

    // Provide more detailed error information
    let errorMessage = "Failed to send email";

    if (error.code === "ECONNREFUSED") {
      errorMessage =
        "Could not connect to email server. Please check SMTP configuration.";
    } else if (error.code === "EAUTH") {
      errorMessage =
        "Email authentication failed. Please check username and password.";
    } else if (error.responseCode) {
      errorMessage = `SMTP Error: ${error.responseCode} - ${
        error.response || error.message
      }`;
    } else if (error.message) {
      errorMessage = error.message;
    }

    throw new Error(errorMessage);
  }
}

async function logEmailActivity(userId, quotationDocEntry, recipient) {
  try {
    // If you have an EmailLog model, you can use it here
    const EmailLog = require("../models/EmailLog");

    await EmailLog.create({
      user: userId,
      quotationDocEntry,
      recipient,
      timestamp: new Date(),
      type: "quotation_email",
    });

    console.log(
      `Email log created for quotation ${quotationDocEntry} sent to ${recipient}`
    );
  } catch (error) {
    console.error("Error logging email activity:", error);
    // Don't throw here as this is a non-critical operation
  }
}
module.exports = exports;
