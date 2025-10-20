const Invoice = require("../models/Invoice");
const DeliveryNote = require("../models/DeliveryNote");
const Customer = require('../models/Customer');
const {
  createInvoiceInSAP,
  getInvoiceFromSAP,
  checkBusinessPartnerExists,
  getNextInvoiceDocNumFromSAP,
  getNextInvoiceDocEntryFromSAP,
} = require("../utils/sapB1Integration");
const { sendInvoiceEmailToCustomer } = require('./invoicePdfController');
const mongoose = require("mongoose");
const XLSX = require("xlsx");

// Helper function to push invoice to SAP with retry logic
async function pushInvoiceToSAPWithRetry(invoice, maxRetries = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Attempt ${attempt}/${maxRetries} - Pushing invoice ${invoice.DocNum} to SAP...`);

      // Check if business partner exists first
      const bpExists = await checkBusinessPartnerExists(invoice.CardCode);

      if (!bpExists) {
        invoice.SyncErrors = `Business partner ${invoice.CardCode} does not exist in SAP B1`;
        invoice.LastSyncAttempt = new Date();
        invoice.LocalStatus = "SyncFailed";
        invoice.SAPSyncDisabled = true;
        await invoice.save();

        return {
          success: false,
          error: invoice.SyncErrors,
          code: "BP_NOT_FOUND",
        };
      }

      // Format for SAP
      const sapInvoice = await formatInvoiceForSAP(invoice);

      // Push to SAP
      const sapResponse = await createInvoiceInSAP(sapInvoice);

      if (sapResponse && sapResponse.DocEntry) {
        // Update local invoice with SAP details
        invoice.SAPDocEntry = sapResponse.DocEntry;

        if (sapResponse.DocNum) {
          console.log(`Updating local DocNum from ${invoice.DocNum} to ${sapResponse.DocNum}`);
          invoice.DocNum = sapResponse.DocNum;
        }

        invoice.DocumentStatus = "bost_Close";
        invoice.UpdateDate = new Date();
        invoice.SyncedWithSAP = true;
        invoice.LocalStatus = "Synced";
        invoice.SyncErrors = null;
        invoice.LastSyncAttempt = new Date();

        await invoice.save();

        console.log(`✅ Successfully pushed invoice ${invoice.DocNum} to SAP (DocEntry: ${sapResponse.DocEntry})`);

        return {
          success: true,
          SAPDocEntry: sapResponse.DocEntry,
          SAPDocNum: sapResponse.DocNum,
          sapData: sapResponse,
          attempts: attempt,
        };
      } else {
        throw new Error("Invalid response from SAP B1");
      }

    } catch (error) {
      lastError = error;
      console.error(`❌ Attempt ${attempt}/${maxRetries} failed:`, error.message);

      if (attempt === maxRetries) {
        let errorCode = "GENERAL_ERROR";

        if (error.message && error.message.includes("Business partner")) {
          errorCode = "BP_NOT_FOUND";
        }

        invoice.SyncErrors = error.message;
        invoice.LastSyncAttempt = new Date();
        invoice.LocalStatus = "SyncFailed";

        if (errorCode === "BP_NOT_FOUND") {
          invoice.SAPSyncDisabled = true;
        }

        await invoice.save();
      } else {
        const waitTime = Math.pow(2, attempt) * 1000;
        console.log(`Waiting ${waitTime / 1000}s before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }

  return {
    success: false,
    error: lastError?.message || "Unknown error after all retries",
    attempts: maxRetries,
  };
}

// Helper function to format invoice for SAP
async function formatInvoiceForSAP(invoice) {
  // Use the centralized formatting function from SAP integration
  const { formatInvoiceForSAP: sapFormatter } = require("../utils/sapB1Integration");
  return await sapFormatter(invoice);
}
// Create invoice from delivery note
exports.createInvoiceFromDeliveryNote = async (req, res) => {
  try {
    const { docEntry } = req.params;

    const deliveryNote = await DeliveryNote.findOne({ DocEntry: docEntry });

    if (!deliveryNote) {
      return res.status(404).json({
        success: false,
        message: `Delivery note with DocEntry ${docEntry} not found`,
      });
    }

    // ✅ FIX: Determine the correct SAP BaseEntry for invoice
    let sapBaseEntry;
    let isFromSAPOrder = false;

    // Check if DN has salesAgent to determine origin
    if (!deliveryNote.salesAgent) {
      isFromSAPOrder = true;
      // Use DocEntry as the SAP reference
      sapBaseEntry = deliveryNote.DocEntry;
      console.log(`📦 DN from SAP order. Using DocEntry ${sapBaseEntry} as BaseEntry`);
    } else {
      // System-created DN - check if synced
      if (!deliveryNote.SyncedWithSAP || !deliveryNote.SAPDocEntry) {
        return res.status(400).json({
          success: false,
          message: `Delivery note ${deliveryNote.DocNum} is not synced with SAP. Cannot create invoice.`,
          data: {
            deliveryNoteDocNum: deliveryNote.DocNum,
            synced: deliveryNote.SyncedWithSAP,
            sapDocEntry: deliveryNote.SAPDocEntry
          }
        });
      }
      sapBaseEntry = deliveryNote.SAPDocEntry;
      console.log(`🆕 System-created DN. Using SAPDocEntry ${sapBaseEntry} as BaseEntry`);
    }

    // Check if invoice already exists
    const existingInvoice = await Invoice.findOne({
      $or: [
        { BaseEntry: sapBaseEntry },
        { OriginatingDeliveryNote: deliveryNote.DocNum }
      ]
    });

    if (existingInvoice) {
      return res.status(400).json({
        success: false,
        message: "Invoice already exists for this delivery note",
        data: existingInvoice,
      });
    }

    // Get next DocNum
    let newDocNum, newDocEntry;
    try {
      const { getNextInvoiceDocNumFromSAP, getNextInvoiceDocEntryFromSAP } = require("../utils/sapB1Integration");
      newDocNum = await getNextInvoiceDocNumFromSAP();
      newDocEntry = await getNextInvoiceDocEntryFromSAP();
      console.log(`Using SAP-aligned Invoice DocNum: ${newDocNum}`);
    } catch (sapError) {
      const lastInvoice = await Invoice.findOne().sort({ CreatedAt: -1 });
      newDocEntry = lastInvoice ? lastInvoice.DocEntry + 1 : 1;
      newDocNum = newDocEntry;
      console.log(`Using local Invoice DocNum: ${newDocNum}`);
    }

    // ✅ Create invoice with CORRECT base references
    const invoice = new Invoice({
      DocEntry: newDocEntry,
      DocNum: newDocNum,
      DocType: "dDocument_Items",

      // Copy from delivery note
      CardCode: deliveryNote.CardCode,
      CardName: deliveryNote.CardName,
      Address: deliveryNote.Address,
      Address2: deliveryNote.Address2,

      // Financial info
      DocTotal: deliveryNote.DocTotal,
      DocCurrency: deliveryNote.DocCurrency,
      VatSum: deliveryNote.VatSum,

      // Dates
      DocDate: new Date(),
      DocDueDate: new Date(),
      CreationDate: new Date(),
      UpdateDate: new Date(),

      // ✅ CRITICAL: Use CORRECT SAP reference
      BaseType: 15, // Delivery Note
      BaseEntry: sapBaseEntry, // *** CORRECTED ***
      OriginatingDeliveryNote: deliveryNote.DocNum,

      // ✅ Document lines with proper base references
      DocumentLines: deliveryNote.DocumentLines.map((line, index) => ({
        LineNum: index,
        ItemCode: line.ItemCode,
        ItemDescription: line.ItemDescription,
        Quantity: line.Quantity,
        Price: line.Price || line.UnitPrice,
        PriceAfterVAT: line.PriceAfterVAT,
        Currency: line.Currency || deliveryNote.DocCurrency,
        LineTotal: line.LineTotal,
        VatGroup: line.VatGroup,

        // ✅ Base references for each line
        BaseType: 15, // Delivery Note
        BaseEntry: sapBaseEntry, // *** CORRECTED ***
        BaseLine: line.LineNum,
      })),

      // Status
      DocumentStatus: "bost_Open",
      SyncedWithSAP: false,
      LocalStatus: "Created",

      // Copy sales agent if exists
      salesAgent: deliveryNote.salesAgent,

      // Comments with metadata
      Comments: isFromSAPOrder
        ? `Invoice for DN #${deliveryNote.DocNum} (from SAP order, DN Entry: ${sapBaseEntry})`
        : `Invoice for delivery note #${deliveryNote.DocNum}`,
      U_Notes: deliveryNote.U_Notes || "",

      // Custom tracking fields
      tag: "External Delivery",
      isDelivery: true,
      isPOS: false,
    });

    await invoice.save();

    console.log(`✅ Created invoice ${newDocNum} with BaseEntry ${sapBaseEntry} (From SAP: ${isFromSAPOrder})`);

    res.status(201).json({
      success: true,
      message: "Invoice created successfully",
      data: invoice,
      debug: {
        isFromSAPOrder,
        sapBaseEntry,
        dnDocNum: deliveryNote.DocNum,
        dnDocEntry: deliveryNote.DocEntry
      }
    });

  } catch (error) {
    console.error("Error creating invoice:", error);
    res.status(500).json({
      success: false,
      message: "Error creating invoice",
      error: error.message,
    });
  }
};

// Create credit note from invoice
exports.createCreditNoteFromInvoice = async (req, res) => {
  try {
    const { docEntry } = req.params;
    const { lines, reason } = req.body;

    console.log("\n" + "=".repeat(60));
    console.log("CREATE CREDIT NOTE REQUEST");
    console.log("=".repeat(60));
    console.log("Invoice DocEntry:", docEntry);
    console.log("Lines:", JSON.stringify(lines, null, 2));
    console.log("Reason:", reason);
    console.log("=".repeat(60) + "\n");

    // Validate input
    if (!lines || !Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please provide items to credit"
      });
    }

    if (!reason || !reason.trim()) {
      return res.status(400).json({
        success: false,
        message: "Please provide a reason for the credit note"
      });
    }

    // Find invoice
    const invoice = await Invoice.findOne({ DocNum: docEntry });
    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found"
      });
    }

    // Check if invoice is synced with SAP
    if (!invoice.SyncedWithSAP || !invoice.SAPDocEntry) {
      return res.status(400).json({
        success: false,
        message: "Invoice must be synced with SAP before creating credit note",
        debug: {
          invoiceNum: invoice.DocNum,
          synced: invoice.SyncedWithSAP,
          sapDocEntry: invoice.SAPDocEntry
        }
      });
    }

    console.log("Invoice details:", {
      DocNum: invoice.DocNum,
      DocEntry: invoice.DocEntry,
      SAPDocEntry: invoice.SAPDocEntry,
      CardCode: invoice.CardCode,
      DocumentLines: invoice.DocumentLines.length
    });

    // Format credit note for SAP
    const { formatCreditNoteForSAP } = require("../utils/sapB1Integration");

    const creditNoteData = await formatCreditNoteForSAP({
      CardCode: invoice.CardCode,
      CardName: invoice.CardName,
      DocDate: new Date(),
      DocDueDate: new Date(),
      DocCurrency: invoice.DocCurrency || "EUR",
      Comments: `Credit note for invoice #${invoice.DocNum}: ${reason}`,
      U_Notes: reason,
      DocumentLines: lines.map((line) => {
        // Find the original invoice line
        const originalLine = invoice.DocumentLines.find(
          invLine => invLine.ItemCode === line.ItemCode
        );

        if (!originalLine) {
          console.warn(`Warning: Original line not found for item ${line.ItemCode}`);
        }

        return {
          ItemCode: line.ItemCode,
          ItemDescription: line.ItemDescription,
          Quantity: Number(line.Quantity),
          Price: Number(line.Price),
          BaseType: 13, // 13 = Invoice
          BaseEntry: invoice.SAPDocEntry, // Use SAP DocEntry
          BaseLine: originalLine ? originalLine.LineNum : 0
        };
      })
    });

    // Create in SAP
    const { createCreditNoteInSAP } = require("../utils/sapB1Integration");

    let sapResponse;
    try {
      sapResponse = await createCreditNoteInSAP(creditNoteData);
    } catch (sapError) {
      console.error("\n" + "=".repeat(60));
      console.error("SAP CREDIT NOTE CREATION FAILED");
      console.error("=".repeat(60));
      console.error("Error:", sapError.message);
      console.error("=".repeat(60) + "\n");

      return res.status(500).json({
        success: false,
        message: "Failed to create credit note in SAP",
        error: sapError.message,
        sentData: creditNoteData
      });
    }

    if (!sapResponse || !sapResponse.DocEntry) {
      throw new Error("Invalid response from SAP - no DocEntry received");
    }

    console.log("\n" + "=".repeat(60));
    console.log("SAP CREDIT NOTE CREATED SUCCESSFULLY");
    console.log("=".repeat(60));
    console.log("DocEntry:", sapResponse.DocEntry);
    console.log("DocNum:", sapResponse.DocNum);
    console.log("=".repeat(60) + "\n");

    // Calculate totals
    const creditTotal = lines.reduce((sum, line) =>
      sum + (line.Quantity * line.Price), 0
    );
    const creditVat = creditTotal * 0.055; // Assuming 5.5% VAT

    // Save credit note in local DB
    const CreditNote = require("../models/CreditNotes");
    const creditNote = new CreditNote({
      DocEntry: sapResponse.DocEntry,
      DocNum: sapResponse.DocNum,
      SAPDocEntry: sapResponse.DocEntry,
      CardCode: invoice.CardCode,
      CardName: invoice.CardName,
      DocDate: new Date(),
      DocDueDate: new Date(),
      DocCurrency: invoice.DocCurrency || "EUR",
      Comments: creditNoteData.Comments,
      U_Notes: reason,
      BaseType: 13, // From Invoice
      BaseEntry: invoice.SAPDocEntry,
      OriginatingDocument: invoice.DocNum.toString(),
      DocumentLines: lines.map((line, index) => ({
        LineNum: index,
        ItemCode: line.ItemCode,
        ItemDescription: line.ItemDescription,
        Quantity: line.Quantity,
        Price: line.Price,
        LineTotal: line.Quantity * line.Price,
        BaseType: 13,
        BaseEntry: invoice.SAPDocEntry,
        BaseLine: invoice.DocumentLines.find(
          invLine => invLine.ItemCode === line.ItemCode
        )?.LineNum || 0
      })),
      DocTotal: creditTotal,
      VatSum: creditVat,
      SyncedWithSAP: true,
      LocalStatus: "Synced",
      salesAgent: invoice.salesAgent,
      Cancelled: "N",
      DocumentStatus: "bost_Close",
      CreationDate: new Date(),
      UpdateDate: new Date()
    });

    await creditNote.save();

    // Update invoice with credit note reference
    invoice.hasCreditNotes = true;
    invoice.creditNoteDocEntries = invoice.creditNoteDocEntries || [];
    invoice.creditNoteDocEntries.push(sapResponse.DocEntry);
    invoice.totalCreditAmount = (invoice.totalCreditAmount || 0) + creditTotal;

    // Update remaining balance
    invoice.remainingBalance = (invoice.DocTotal || 0) -
      (invoice.totalCreditAmount || 0) -
      (invoice.totalPaidAmount || 0);

    // Update payment status
    if (invoice.remainingBalance <= 0) {
      invoice.paymentStatus = 'Fully Paid';
      invoice.DocumentStatus = 'bost_Close';
    } else if ((invoice.totalPaidAmount || 0) > 0 || (invoice.totalCreditAmount || 0) > 0) {
      invoice.paymentStatus = 'Partially Paid';
    }

    await invoice.save();

    res.status(201).json({
      success: true,
      message: "Credit note created successfully",
      data: {
        creditNote: {
          DocEntry: creditNote.DocEntry,
          DocNum: creditNote.DocNum,
          SAPDocEntry: creditNote.SAPDocEntry,
          DocTotal: creditNote.DocTotal
        },
        invoice: {
          DocEntry: invoice.DocEntry,
          DocNum: invoice.DocNum,
          remainingBalance: invoice.remainingBalance,
          paymentStatus: invoice.paymentStatus,
          totalCreditAmount: invoice.totalCreditAmount
        }
      }
    });

  } catch (error) {
    console.error("\n" + "=".repeat(60));
    console.error("ERROR IN CREATE CREDIT NOTE");
    console.error("=".repeat(60));
    console.error(error);
    console.error("=".repeat(60) + "\n");

    res.status(500).json({
      success: false,
      message: "Error creating credit note",
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};

// Get credit notes for invoice
exports.getCreditNotesForInvoice = async (req, res) => {
  try {
    const { docEntry } = req.params;

    const invoice = await Invoice.findOne({ DocEntry: docEntry });
    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found"
      });
    }

    if (!invoice.hasCreditNotes || !invoice.creditNoteDocEntries || invoice.creditNoteDocEntries.length === 0) {
      return res.json({
        success: true,
        data: []
      });
    }

    const CreditNote = require("../models/CreditNote");
    const creditNotes = await CreditNote.find({
      DocEntry: { $in: invoice.creditNoteDocEntries }
    }).sort({ DocDate: -1 });

    res.json({
      success: true,
      data: creditNotes
    });

  } catch (error) {
    console.error("Error fetching credit notes:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching credit notes",
      error: error.message
    });
  }
};

// Record payment for invoice
exports.recordPaymentForInvoice = async (req, res) => {
  try {
    const { docEntry } = req.params;
    const { amount, paymentMethod, paymentDate, reference, remarks } = req.body;

    // Validate input
    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Please provide a valid payment amount"
      });
    }

    if (!paymentMethod) {
      return res.status(400).json({
        success: false,
        message: "Please provide payment method"
      });
    }

    // Find invoice
    const invoice = await Invoice.findOne({ DocEntry: docEntry });
    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found"
      });
    }

    // Check if invoice is synced with SAP
    if (!invoice.SyncedWithSAP || !invoice.SAPDocEntry) {
      return res.status(400).json({
        success: false,
        message: "Invoice must be synced with SAP before recording payment"
      });
    }

    // Format payment for SAP
    const paymentData = {
      CardCode: invoice.CardCode,
      DocDate: paymentDate || new Date(),
      DocCurrency: invoice.DocCurrency || "EUR",
      CashSum: paymentMethod === 'Cash' ? amount : 0,
      TransferSum: paymentMethod === 'Transfer' ? amount : 0,
      TransferDate: paymentMethod === 'Transfer' ? (paymentDate || new Date()) : null,
      TransferReference: reference || "",
      Remarks: remarks || `Payment for invoice #${invoice.DocNum}`,
      PaymentInvoices: [{
        LineNum: 0,
        DocEntry: invoice.SAPDocEntry,
        SumApplied: amount,
        InvoiceType: 'it_Invoice'
      }]
    };

    // Create payment in SAP
    const { createIncomingPaymentInSAP } = require("../utils/sapB1Integration");
    const sapResponse = await createIncomingPaymentInSAP(paymentData);

    if (!sapResponse || !sapResponse.DocEntry) {
      throw new Error("Failed to create payment in SAP");
    }

    // Save payment in local DB
    const Payment = require("../models/payment");
    const payment = new Payment({
      DocEntry: sapResponse.DocEntry,
      DocNum: sapResponse.DocNum,
      CardCode: invoice.CardCode,
      CardName: invoice.CardName,
      DocDate: paymentDate || new Date(),
      DocCurrency: invoice.DocCurrency || "EUR",
      CashSum: paymentData.CashSum,
      TransferSum: paymentData.TransferSum,
      TransferDate: paymentData.TransferDate,
      TransferReference: paymentData.TransferReference,
      Remarks: paymentData.Remarks,
      PaymentInvoices: [{
        LineNum: 0,
        DocEntry: invoice.SAPDocEntry,
        SumApplied: amount,
        InvoiceType: 'it_Invoice'
      }],
      verified: true,
      dateStored: new Date()
    });

    await payment.save();

    // Update invoice with payment reference
    invoice.hasPayments = true;
    invoice.paymentDocEntries = invoice.paymentDocEntries || [];
    invoice.paymentDocEntries.push(sapResponse.DocEntry);
    invoice.totalPaidAmount = (invoice.totalPaidAmount || 0) + amount;

    // Update remaining balance
    invoice.remainingBalance = (invoice.DocTotal || 0) -
      (invoice.totalCreditAmount || 0) -
      (invoice.totalPaidAmount || 0);

    // Update payment status
    if (invoice.remainingBalance <= 0) {
      invoice.paymentStatus = 'Fully Paid';
    } else if (invoice.totalPaidAmount > 0 || (invoice.totalCreditAmount || 0) > 0) {
      invoice.paymentStatus = 'Partially Paid';
    } else {
      invoice.paymentStatus = 'Unpaid';
    }

    // Close invoice if fully paid
    if (invoice.paymentStatus === 'Fully Paid') {
      invoice.DocumentStatus = 'bost_Close';
    }

    await invoice.save();

    res.status(201).json({
      success: true,
      message: "Payment recorded successfully",
      data: {
        payment: {
          DocEntry: payment.DocEntry,
          DocNum: payment.DocNum,
          amount: amount
        },
        invoice: {
          remainingBalance: invoice.remainingBalance,
          paymentStatus: invoice.paymentStatus,
          totalPaidAmount: invoice.totalPaidAmount
        }
      }
    });

  } catch (error) {
    console.error("Error recording payment:", error);
    res.status(500).json({
      success: false,
      message: "Error recording payment",
      error: error.message
    });
  }
};

// Get payments for invoice
exports.getPaymentsForInvoice = async (req, res) => {
  try {
    const { docEntry } = req.params;

    const invoice = await Invoice.findOne({ DocEntry: docEntry });
    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found"
      });
    }

    if (!invoice.hasPayments || !invoice.paymentDocEntries || invoice.paymentDocEntries.length === 0) {
      return res.json({
        success: true,
        data: []
      });
    }

    const Payment = require("../models/Payment");
    const payments = await Payment.find({
      DocEntry: { $in: invoice.paymentDocEntries }
    }).sort({ DocDate: -1 });

    res.json({
      success: true,
      data: payments
    });

  } catch (error) {
    console.error("Error fetching payments:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching payments",
      error: error.message
    });
  }
};

// controllers/invoiceController.js
// Replace the bulkCreateInvoicesFromDeliveryNotes function

// controllers/invoiceController.js
exports.bulkCreateInvoicesFromDeliveryNotes = async (req, res) => {
  try {
    const { deliveryNoteDocNums, autoSync = false } = req.body;

    console.log('Request to bulk create invoices from delivery notes:', deliveryNoteDocNums);

    if (!deliveryNoteDocNums || !Array.isArray(deliveryNoteDocNums) || deliveryNoteDocNums.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please provide delivery note DocNums array",
      });
    }

    console.log(`Creating invoices for ${deliveryNoteDocNums.length} delivery notes...`);

    const results = {
      successful: [],
      failed: [],
      totalProcessed: 0,
      emailResults: {
        sent: [],
        failed: [],
        skipped: []
      }
    };

    // ✅ FIX: Get NEXT DocNum from SAP ONCE before the loop
    let nextDocNum;
    try {
      const { getNextInvoiceDocNumFromSAP } = require("../utils/sapB1Integration");
      nextDocNum = await getNextInvoiceDocNumFromSAP();
      console.log(`✅ Starting DocNum sequence from SAP: ${nextDocNum}`);
    } catch (sapError) {
      console.warn("Could not get DocNum from SAP, using local fallback");
      const lastInvoice = await Invoice.findOne().sort({ DocNum: -1 });
      nextDocNum = lastInvoice ? lastInvoice.DocNum + 1 : 1;
      console.log(`✅ Starting DocNum sequence (local): ${nextDocNum}`);
    }

    // Process each delivery note
    for (const docNum of deliveryNoteDocNums) {
      try {
        results.totalProcessed++;

        const deliveryNote = await DeliveryNote.findOne({ DocNum: docNum });

        if (!deliveryNote) {
          results.failed.push({
            docNum,
            error: "Delivery note not found",
          });
          continue;
        }

        // ✅ FIX: Determine the correct SAP BaseEntry for invoice
        let sapBaseEntry;
        let isFromSAPOrder = false;

        // Check if DN has salesAgent to determine origin
        if (!deliveryNote.salesAgent) {
          isFromSAPOrder = true;
          // Use DocEntry as the SAP reference (it's already the SAP DocEntry)
          sapBaseEntry = deliveryNote.DocEntry;
          console.log(`📦 DN ${docNum} from SAP order. Using DocEntry ${sapBaseEntry} as BaseEntry`);
        } else {
          // System-created DN - check if synced
          if (!deliveryNote.SyncedWithSAP || !deliveryNote.SAPDocEntry) {
            results.failed.push({
              docNum,
              error: "Delivery note not synced with SAP",
              synced: deliveryNote.SyncedWithSAP,
              sapDocEntry: deliveryNote.SAPDocEntry
            });
            continue;
          }
          sapBaseEntry = deliveryNote.SAPDocEntry;
          console.log(`🆕 DN ${docNum} system-created. Using SAPDocEntry ${sapBaseEntry} as BaseEntry`);
        }

        // Check if invoice already exists - use the correct sapBaseEntry
        const existingInvoice = await Invoice.findOne({
          $or: [
            { BaseEntry: sapBaseEntry },
            { OriginatingDeliveryNote: deliveryNote.DocNum }
          ]
        });

        if (existingInvoice) {
          results.failed.push({
            docNum,
            error: "Invoice already exists",
            existingDocNum: existingInvoice.DocNum,
          });
          continue;
        }

        // Get returns for this delivery note if any
        let returnedQuantities = {};
        if (deliveryNote.hasReturns && deliveryNote.returnDocEntries && deliveryNote.returnDocEntries.length > 0) {
          const Return = require("../models/Return");
          const returns = await Return.find({
            DocEntry: { $in: deliveryNote.returnDocEntries }
          });

          returns.forEach(returnDoc => {
            if (returnDoc.DocumentLines && Array.isArray(returnDoc.DocumentLines)) {
              returnDoc.DocumentLines.forEach(line => {
                const key = line.ItemCode;
                returnedQuantities[key] = (returnedQuantities[key] || 0) + line.Quantity;
              });
            }
          });

          console.log(`📦 Delivery Note ${docNum} has returns. Returned quantities:`, returnedQuantities);
        }

        // Process document lines - subtract returned quantities
        const invoiceLines = [];
        let hasValidLines = false;
        let invoiceTotal = 0;
        let invoiceVatSum = 0;

        deliveryNote.DocumentLines.forEach((line, index) => {
          const deliveredQty = line.Quantity || 0;
          const returnedQty = returnedQuantities[line.ItemCode] || 0;
          const netQty = deliveredQty - returnedQty;

          if (netQty > 0) {
            hasValidLines = true;
            const linePrice = line.Price || line.UnitPrice || 0;
            const lineTotal = netQty * linePrice;
            const lineVat = lineTotal * 0.055;

            invoiceTotal += lineTotal;
            invoiceVatSum += lineVat;

            invoiceLines.push({
              LineNum: invoiceLines.length,
              ItemCode: line.ItemCode,
              ItemDescription: line.ItemDescription,
              Quantity: netQty,
              Price: linePrice,
              PriceAfterVAT: line.PriceAfterVAT,
              Currency: line.Currency || deliveryNote.DocCurrency,
              LineTotal: lineTotal,
              VatGroup: line.VatGroup,

              // ✅ Base references to delivery note
              BaseType: 15, // Delivery Note
              BaseEntry: deliveryNote.SAPDocEntry,
              BaseLine: line.LineNum,
            });
          } else if (netQty < 0) {
            console.warn(`⚠️ Item ${line.ItemCode} has more returns (${returnedQty}) than delivered (${deliveredQty})`);
          }
        });

        if (!hasValidLines) {
          results.failed.push({
            docNum,
            error: "All items have been returned - no items left to invoice",
            hasReturns: true,
            returnedQuantities
          });
          continue;
        }

        try {
          // ✅ FIX: Use the incrementing DocNum instead of fetching from SAP each time
          const currentDocNum = nextDocNum;
          const currentDocEntry = nextDocNum; // Use same value

          console.log(`📝 Creating invoice ${currentDocNum} for DN ${docNum}`);

          // Create invoice data for SAP
          const invoiceDataForSAP = {
            CardCode: deliveryNote.CardCode,
            DocDate: new Date().toISOString().split('T')[0],
            DocDueDate: new Date().toISOString().split('T')[0],
            DocCurrency: deliveryNote.DocCurrency || "EUR",

            DocumentLines: invoiceLines.map((line, index) => ({
              ItemCode: line.ItemCode,
              ItemDescription: line.ItemDescription,
              Quantity: line.Quantity,
              UnitPrice: line.Price,
              LineNum: index,

              BaseType: 15, // Delivery Note
              BaseEntry: sapBaseEntry,
              BaseLine: line.BaseLine,
            })),

            Comments: deliveryNote.hasReturns
              ? `Invoice for delivery note #${deliveryNote.DocNum} (with returns deducted)`
              : `Invoice for delivery note #${deliveryNote.DocNum}`,
            U_Notes: deliveryNote.U_Notes || "",
            U_SourceDeliveryNote: deliveryNote.DocNum.toString(),
          };

          console.log(`Creating invoice in SAP for DN ${docNum} with base references...`);

          const { createInvoiceInSAP } = require("../utils/sapB1Integration");
          const sapResponse = await createInvoiceInSAP(invoiceDataForSAP);

          if (!sapResponse || !sapResponse.DocEntry) {
            throw new Error("Invalid response from SAP - no DocEntry received");
          }

          // ✅ FIX: Increment for next invoice
          nextDocNum++;
          console.log(`✅ Next invoice will use DocNum: ${nextDocNum}`);

          // Save to local DB
          const invoice = new Invoice({
            DocEntry: sapResponse.DocEntry,
            DocNum: sapResponse.DocNum,
            SAPDocEntry: sapResponse.DocEntry,
            DocType: "dDocument_Items",
            CardCode: deliveryNote.CardCode,
            CardName: deliveryNote.CardName,
            Address: deliveryNote.Address,
            Address2: deliveryNote.Address2,
            DocTotal: invoiceTotal,
            DocCurrency: deliveryNote.DocCurrency,
            VatSum: invoiceVatSum,
            DocDate: new Date(),
            DocDueDate: new Date(),
            CreationDate: new Date(),
            UpdateDate: new Date(),

            BaseType: 15, // Delivery Note
            BaseEntry: sapBaseEntry,
            OriginatingDeliveryNote: deliveryNote.DocNum,

            DocumentLines: invoiceLines,
            DocumentStatus: "bost_Close",
            SyncedWithSAP: true,
            LocalStatus: "Synced",
            salesAgent: deliveryNote.salesAgent,
            Comments: invoiceDataForSAP.Comments,
            U_Notes: deliveryNote.U_Notes || "",
            tag: "External Delivery",
            isDelivery: true,
            isPOS: false,
          });

          await invoice.save();

          results.successful.push({
            docEntry: sapResponse.DocEntry,
            docNum: sapResponse.DocNum,
            deliveryNoteDocNum: deliveryNote.DocNum,
            cardCode: deliveryNote.CardCode,
            hasReturns: deliveryNote.hasReturns,
            linesAfterReturns: invoiceLines.length,
            totalAfterReturns: invoiceTotal,
            syncedToSAP: true,
            sapDeliveryNoteDocEntry: sapBaseEntry, 
          });

          console.log(`✅ Created invoice ${sapResponse.DocNum} for DN ${deliveryNote.DocNum}`);

          // **AUTO EMAIL FUNCTIONALITY**
          try {
            const Customer = require("../models/Customer");
            const customer = await Customer.findOne({ CardCode: deliveryNote.CardCode });

            if (customer && customer.Email) {
              console.log(`📧 Sending invoice email to ${customer.Email}...`);

              const { sendInvoiceEmailToCustomer } = require('./invoicePdfController');
              const emailResult = await sendInvoiceEmailToCustomer(invoice._id, {
                recipientEmail: customer.Email,
                subject: `Facture #${sapResponse.DocNum} - ${deliveryNote.CardName}`,
                message: `Bonjour,

Veuillez trouver ci-joint votre facture #${sapResponse.DocNum}.

Montant total: ${new Intl.NumberFormat("fr-FR", {
                  style: "currency",
                  currency: invoice.DocCurrency || "EUR",
                }).format(invoiceTotal)}
Date: ${new Date(invoice.DocDate).toLocaleDateString("fr-FR")}
Date d'échéance: ${new Date(invoice.DocDueDate).toLocaleDateString("fr-FR")}

Cordialement,
Halal Food Service`
              });

              if (emailResult.success) {
                results.emailResults.sent.push({
                  invoiceDocNum: sapResponse.DocNum,
                  cardCode: deliveryNote.CardCode,
                  email: customer.Email
                });
                console.log(`✅ Invoice email sent to ${customer.Email}`);
              } else {
                results.emailResults.failed.push({
                  invoiceDocNum: sapResponse.DocNum,
                  cardCode: deliveryNote.CardCode,
                  email: customer.Email,
                  error: emailResult.error
                });
                console.error(`❌ Failed to send invoice email: ${emailResult.error}`);
              }
            } else {
              results.emailResults.skipped.push({
                invoiceDocNum: sapResponse.DocNum,
                cardCode: deliveryNote.CardCode,
                reason: customer ? "No email address" : "Customer not found"
              });
            }
          } catch (emailError) {
            console.error(`❌ Error sending invoice email:`, emailError);
            results.emailResults.failed.push({
              invoiceDocNum: sapResponse.DocNum,
              cardCode: deliveryNote.CardCode,
              error: emailError.message
            });
          }

        } catch (sapError) {
          console.error(`❌ Error creating invoice in SAP for DN ${docNum}:`, sapError);
          results.failed.push({
            docNum,
            error: `SAP creation failed: ${sapError.message}`,
            hasReturns: deliveryNote.hasReturns
          });
        }

      } catch (error) {
        console.error(`❌ Error processing delivery note ${docNum}:`, error);
        results.failed.push({
          docNum,
          error: error.message,
        });
      }
    }

    res.status(200).json({
      success: true,
      message: `Created and synced ${results.successful.length} invoices. Sent ${results.emailResults.sent.length} emails.`,
      data: results,
      allSyncedToSAP: true,
    });

  } catch (error) {
    console.error("Error in bulk invoice creation:", error);
    res.status(500).json({
      success: false,
      message: "Error creating invoices",
      error: error.message,
    });
  }
};
// Update bulkPushInvoicesToSAP in controllers/invoiceController.js

exports.bulkPushInvoicesToSAP = async (req, res) => {
  try {
    const { invoiceDocEntries } = req.body;

    if (!invoiceDocEntries || !Array.isArray(invoiceDocEntries) ||
      invoiceDocEntries.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please provide invoiceDocEntries array",
      });
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`Checking sync status for ${invoiceDocEntries.length} invoices`);
    console.log(`${"=".repeat(60)}\n`);

    const results = {
      successful: [],
      failed: [],
      alreadySynced: [],
      totalProcessed: 0,
      startTime: new Date(),
    };

    for (const docEntry of invoiceDocEntries) {
      try {
        results.totalProcessed++;

        const invoice = await Invoice.findOne({ DocEntry: docEntry })
          .populate("salesAgent", "firstName lastName email");

        if (!invoice) {
          results.failed.push({
            docEntry,
            error: "Invoice not found",
          });
          continue;
        }

        // Check if already synced
        if (invoice.SyncedWithSAP && invoice.SAPDocEntry) {
          console.log(`✅ Invoice ${invoice.DocNum} already synced (SAP DocEntry: ${invoice.SAPDocEntry})`);
          results.alreadySynced.push({
            docEntry: invoice.DocEntry,
            docNum: invoice.DocNum,
            sapDocEntry: invoice.SAPDocEntry,
          });
          continue;
        }

        // This invoice needs syncing
        const sapResult = await pushInvoiceToSAPWithRetry(invoice, 3);

        if (sapResult.success) {
          results.successful.push({
            docEntry: invoice.DocEntry,
            docNum: invoice.DocNum,
            sapDocEntry: sapResult.SAPDocEntry,
            sapDocNum: sapResult.SAPDocNum,
            cardCode: invoice.CardCode,
            attempts: sapResult.attempts,
          });
        } else {
          results.failed.push({
            docEntry: invoice.DocEntry,
            docNum: invoice.DocNum,
            error: sapResult.error,
            attempts: sapResult.attempts,
          });
        }

      } catch (error) {
        results.failed.push({
          docEntry,
          error: error.message,
        });
      }
    }

    results.endTime = new Date();
    results.duration = ((results.endTime - results.startTime) / 1000).toFixed(2);

    console.log(`\n${"=".repeat(60)}`);
    console.log(`Sync Summary:`);
    console.log(`Already Synced: ${results.alreadySynced.length}`);
    console.log(`Newly Synced: ${results.successful.length}`);
    console.log(`Failed: ${results.failed.length}`);
    console.log(`${"=".repeat(60)}\n`);

    res.status(200).json({
      success: true,
      message: `Processed ${results.totalProcessed} invoices`,
      data: results,
    });

  } catch (error) {
    console.error("Error in bulk SAP push:", error);
    res.status(500).json({
      success: false,
      message: "Error pushing invoices to SAP",
      error: error.message,
    });
  }
};
// Get all invoices with filters (enhanced version)
exports.getAllInvoices = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    let query = {};

    // Apply filters
    if (req.query.cardCode) {
      query.CardCode = { $regex: req.query.cardCode, $options: "i" };
    }

    if (req.query.status) {
      query.DocumentStatus = req.query.status;
    }

    if (req.query.syncStatus) {
      if (req.query.syncStatus === "synced") {
        query.SyncedWithSAP = true;
      } else if (req.query.syncStatus === "unsynced") {
        query.SyncedWithSAP = false;
      } else if (req.query.syncStatus === "failed") {
        query.LocalStatus = "SyncFailed";
      }
    }

    if (req.query.fromDate && req.query.toDate) {
      query.DocDate = {
        $gte: new Date(req.query.fromDate),
        $lte: new Date(req.query.toDate),
      };
    }

    const invoices = await Invoice.find(query)
      .populate("salesAgent", "firstName lastName email")
      .skip(skip)
      .limit(limit)
      .sort({ DocDate: -1 });

    const total = await Invoice.countDocuments(query);

    res.status(200).json({
      success: true,
      count: invoices.length,
      total,
      page,
      pages: Math.ceil(total / limit),
      data: invoices,
    });

  } catch (error) {
    console.error("Error fetching invoices:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching invoices",
      error: error.message,
    });
  }
};

// Get single invoice by DocEntry
exports.getInvoiceByDocEntry = async (req, res) => {
  try {
    const invoice = await Invoice.findOne({
      DocEntry: req.params.docEntry
    }).populate("salesAgent", "firstName lastName email");

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: `Invoice with DocEntry ${req.params.docEntry} not found`,
      });
    }

    res.status(200).json({
      success: true,
      data: invoice,
    });

  } catch (error) {
    console.error("Error fetching invoice:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching invoice",
      error: error.message,
    });
  }
};
exports.bulkImportInvoices = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "Excel file is required",
      });
    }

    const startTime = Date.now();
    console.log("Starting Excel import...");

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

    // Group Excel rows by Document Internal ID to create invoice documents
    const invoiceGroups = {};

    processedRows.forEach((row) => {
      const docId = row["Document Internal ID"];
      if (!docId) return;

      if (!invoiceGroups[docId]) {
        invoiceGroups[docId] = {
          mainData: row,
          lines: [],
        };
      }

      // Add line item if it has valid data
      if (row["Item No."] && row["Item/Service Description"]) {
        invoiceGroups[docId].lines.push({
          LineNum: row["Row Number"] || 0,
          ItemCode: row["Item No."],
          ItemDescription: row["Item/Service Description"],
          Quantity: row["Quantity"] || 0,
          Price: row["Unit Price"] || 0,
          PriceAfterVAT: row["Gross Price after Discount"] || 0,
          Currency: row["Price Currency"] || "EUR",
          LineTotal: row["Row Total"] || 0,
          VatGroup: null,
        });
      }
    });

    const totalInvoices = Object.keys(invoiceGroups).length;
    console.log(`Grouped into ${totalInvoices} invoices`);

    // Get existing DocEntry values in bulk
    const docEntries = Object.keys(invoiceGroups).map((id) => parseInt(id));
    const existingInvoices = await Invoice.find(
      { DocEntry: { $in: docEntries } },
      { DocEntry: 1 }
    ).lean();

    const existingDocEntries = new Set(
      existingInvoices.map((inv) => inv.DocEntry)
    );
    console.log(`Found ${existingDocEntries.size} existing invoices`);

    // Prepare new invoices for bulk insert
    const newInvoices = [];

    Object.entries(invoiceGroups).forEach(([docId, group]) => {
      const docEntry = parseInt(docId);

      // Skip if invoice already exists
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

      // Determine payment status
      const docTotal = parseFloat(row["Document Total"]) || 0;
      const paidToDate = parseFloat(row["Paid to Date"]) || 0;
      const isPaid = Math.abs(docTotal - paidToDate) < 0.01;

      // Create invoice document
      const invoice = {
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

        // Custom fields for tracking
        verified: isPaid,
        dateStored: new Date(),
        tag: "External Delivery", // Default assumption
        paymentMethod: isPaid ? "POS-Cash" : "Unknown",
        isPOS: false,
        isDelivery: true,

        // Document lines
        DocumentLines: group.lines,

        // Additional computed fields
        VatSum: parseFloat(row["Total Tax"]) || 0,
        Cancelled: "N",
        DocumentStatus: isPaid ? "C" : "O",
      };

      newInvoices.push(invoice);
    });

    console.log(`Prepared ${newInvoices.length} new invoices for import`);

    // Bulk insert new invoices
    let insertedCount = 0;
    let insertedDocNums = [];
    if (newInvoices.length > 0) {
      try {
        const result = await Invoice.insertMany(newInvoices, {
          ordered: false, // Continue even if some fail
          lean: true,
        });
        insertedCount = result.length;
        insertedDocNums = result.map((invoice) => invoice.DocNum);
        console.log(`Successfully inserted ${insertedCount} invoices`);
      } catch (error) {
        // Handle partial success in bulk insert
        if (error.writeErrors) {
          insertedCount = newInvoices.length - error.writeErrors.length;
          // Get DocNums of successfully inserted invoices
          const failedIndices = new Set(
            error.writeErrors.map((err) => err.index)
          );
          insertedDocNums = newInvoices
            .filter((_, index) => !failedIndices.has(index))
            .map((invoice) => invoice.DocNum);
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
      message: "Excel import completed",
      data: {
        totalRowsProcessed: processedRows.length,
        totalInvoicesInExcel: totalInvoices,
        existingInvoices: existingDocEntries.size,
        newInvoicesInserted: insertedCount,
        skippedInvoices: totalInvoices - insertedCount,
        processingTimeSeconds: processingTime,
        insertedInvoiceDocNums: insertedDocNums,
      },
    });
  } catch (error) {
    console.error("Error in bulk import:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to import Excel file",
      error: error.message,
    });
  }
};

/**
 * Get invoices for a specific customer with pagination, sorting, and filtering
 */
exports.getInvoicesByCustomer = async (req, res) => {
  try {
    const {
      customerId, // CardCode of the customer
      page = 1, // Current page
      limit = 10, // Items per page
      sortBy = "DocDate", // Sort field
      sortOrder = -1, // Sort order (1: ascending, -1: descending)
      startDate, // Filter by date range
      endDate,
      paymentMethod, // Filter by payment method
      isPaid, // Filter by payment status
      minAmount, // Filter by amount range
      maxAmount,
      isVerified, // Filter by verification status
      search, // Search in invoice number, comments, etc.
    } = req.query;

    // Validate customer ID
    if (!customerId) {
      return res
        .status(400)
        .json({ success: false, message: "Customer ID is required" });
    }

    // Build filter object
    const filter = { CardCode: customerId };

    // Add date range filter if provided
    if (startDate && endDate) {
      filter.DocDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    }

    // Add payment method filter if provided
    if (paymentMethod) {
      filter.paymentMethod = paymentMethod;
    }

    // Add verification status filter if provided
    if (isVerified !== undefined) {
      filter.verified = isVerified === "true";
    }

    // Add amount range filter if provided
    if (minAmount || maxAmount) {
      filter.DocTotal = {};
      if (minAmount) filter.DocTotal.$gte = Number(minAmount);
      if (maxAmount) filter.DocTotal.$lte = Number(maxAmount);
    }

    // Add payment status filter if provided
    if (isPaid !== undefined) {
      // Assuming paid status is determined by PaidToDate being equal to DocTotal
      if (isPaid === "true") {
        filter.$expr = { $eq: ["$PaidToDate", "$DocTotal"] };
      } else {
        filter.$expr = { $lt: ["$PaidToDate", "$DocTotal"] };
      }
    }

    // Add search filter if provided
    if (search) {
      const searchRegex = new RegExp(search, "i");
      filter.$or = [
        { DocNum: isNaN(search) ? searchRegex : Number(search) },
        { NumAtCard: searchRegex },
        { Comments: searchRegex },
        { Reference1: searchRegex },
        { Reference2: searchRegex },
      ];
    }

    // Calculate pagination values
    const skip = (Number(page) - 1) * Number(limit);

    // Define sort options
    const sort = {};
    sort[sortBy] = Number(sortOrder);

    // Execute query with pagination
    const invoices = await Invoice.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(Number(limit))
      .lean();

    // Get total count for pagination
    const totalCount = await Invoice.countDocuments(filter);

    // Calculate KPIs
    const kpis = await calculateCustomerKPIs(customerId);

    return res.status(200).json({
      success: true,
      data: {
        invoices,
        pagination: {
          totalCount,
          totalPages: Math.ceil(totalCount / Number(limit)),
          currentPage: Number(page),
          pageSize: Number(limit),
          hasNext: Number(page) < Math.ceil(totalCount / Number(limit)),
          hasPrevious: Number(page) > 1,
        },
        kpis,
      },
    });
  } catch (error) {
    console.error("Error fetching invoices by customer:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch invoices",
      error: error.message,
    });
  }
};

/**
 * Calculate various KPIs for a specific customer
 */
const calculateCustomerKPIs = async (customerId) => {
  try {
    // Aggregation pipeline to calculate KPIs
    const pipeline = [
      { $match: { CardCode: customerId } },
      {
        $facet: {
          // Total invoices and amount
          totalStats: [
            {
              $group: {
                _id: null,
                invoiceCount: { $sum: 1 },
                totalAmount: { $sum: "$DocTotal" },
                totalPaid: { $sum: "$PaidToDate" },
                averageAmount: { $avg: "$DocTotal" },
                maxAmount: { $max: "$DocTotal" },
                minAmount: { $min: "$DocTotal" },
              },
            },
          ],

          // Unpaid invoices
          unpaidStats: [
            {
              $match: {
                $expr: { $lt: ["$PaidToDate", "$DocTotal"] },
              },
            },
            {
              $group: {
                _id: null,
                unpaidCount: { $sum: 1 },
                unpaidAmount: {
                  $sum: { $subtract: ["$DocTotal", "$PaidToDate"] },
                },
              },
            },
          ],

          // Monthly trends (last 6 months)
          monthlyTrends: [
            {
              $match: {
                CreationDate: {
                  $gte: new Date(
                    new Date().setMonth(new Date().getMonth() - 6)
                  ),
                },
              },
            },
            {
              $group: {
                _id: {
                  year: { $year: "$CreationDate" },
                  month: { $month: "$CreationDate" },
                },
                invoiceCount: { $sum: 1 },
                totalAmount: { $sum: "$DocTotal" },
              },
            },
            { $sort: { "_id.year": 1, "_id.month": 1 } },
          ],

          // Payment method distribution
          paymentMethods: [
            {
              $group: {
                _id: "$paymentMethod",
                count: { $sum: 1 },
                amount: { $sum: "$DocTotal" },
              },
            },
          ],

          // POS vs Delivery distribution
          channelDistribution: [
            {
              $group: {
                _id: {
                  isPOS: "$isPOS",
                  isDelivery: "$isDelivery",
                },
                count: { $sum: 1 },
                amount: { $sum: "$DocTotal" },
              },
            },
          ],

          // Items purchased (top 5)
          topItems: [
            { $unwind: "$DocumentLines" },
            {
              $group: {
                _id: "$DocumentLines.ItemCode",
                itemName: { $first: "$DocumentLines.ItemDescription" },
                quantity: { $sum: "$DocumentLines.Quantity" },
                revenue: {
                  $sum: {
                    $multiply: [
                      "$DocumentLines.Price",
                      "$DocumentLines.Quantity",
                    ],
                  },
                },
                occurrences: { $sum: 1 },
              },
            },
            { $sort: { revenue: -1 } },
            { $limit: 5 },
          ],
        },
      },
    ];

    const results = await Invoice.aggregate(pipeline).allowDiskUse(true);
    // Format the results
    const kpiResult = {
      // Default values in case no data is found
      totalInvoices: 0,
      totalAmount: 0,
      totalPaid: 0,
      totalUnpaid: 0,
      unpaidInvoices: 0,
      averageInvoiceAmount: 0,
      paymentMethodDistribution: [],
      channelDistribution: {
        pos: { count: 0, amount: 0 },
        delivery: { count: 0, amount: 0 },
        other: { count: 0, amount: 0 },
      },
      monthlyTrends: [],
      topItems: [],
    };

    // Extract and format total stats
    if (results[0].totalStats.length > 0) {
      const stats = results[0].totalStats[0];
      kpiResult.totalInvoices = stats.invoiceCount;
      kpiResult.totalAmount = stats.totalAmount;
      kpiResult.totalPaid = stats.totalPaid;
      kpiResult.averageInvoiceAmount = stats.averageAmount;
      kpiResult.highestInvoice = stats.maxAmount;
      kpiResult.lowestInvoice = stats.minAmount;
    }

    // Extract and format unpaid stats
    if (results[0].unpaidStats.length > 0) {
      const unpaid = results[0].unpaidStats[0];
      kpiResult.unpaidInvoices = unpaid.unpaidCount;
      kpiResult.totalUnpaid = unpaid.unpaidAmount;
    }

    // Format payment method distribution
    kpiResult.paymentMethodDistribution = results[0].paymentMethods.map(
      (item) => ({
        method: item._id || "Unknown",
        count: item.count,
        amount: item.amount,
        percentage: kpiResult.totalInvoices
          ? ((item.count / kpiResult.totalInvoices) * 100).toFixed(2)
          : 0,
      })
    );

    // Format channel distribution
    results[0].channelDistribution.forEach((item) => {
      if (item._id.isPOS) {
        kpiResult.channelDistribution.pos.count = item.count;
        kpiResult.channelDistribution.pos.amount = item.amount;
      } else if (item._id.isDelivery) {
        kpiResult.channelDistribution.delivery.count = item.count;
        kpiResult.channelDistribution.delivery.amount = item.amount;
      } else {
        kpiResult.channelDistribution.other.count = item.count;
        kpiResult.channelDistribution.other.amount = item.amount;
      }
    });

    // Format monthly trends
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    kpiResult.monthlyTrends = results[0].monthlyTrends.map((item) => ({
      month: months[item._id.month - 1],
      year: item._id.year,
      count: item.invoiceCount,
      amount: item.totalAmount,
    }));

    // Format top items
    kpiResult.topItems = results[0].topItems.map((item) => ({
      itemCode: item._id,
      itemName: item.itemName,
      quantity: item.quantity,
      revenue: item.revenue,
      occurrences: item.occurrences,
    }));

    // Calculate payment status KPIs
    kpiResult.paymentStatus = {
      paid: kpiResult.totalInvoices - kpiResult.unpaidInvoices,
      unpaid: kpiResult.unpaidInvoices,
      paidPercentage: kpiResult.totalInvoices
        ? (
          ((kpiResult.totalInvoices - kpiResult.unpaidInvoices) /
            kpiResult.totalInvoices) *
          100
        ).toFixed(2)
        : 0,
      unpaidPercentage: kpiResult.totalInvoices
        ? ((kpiResult.unpaidInvoices / kpiResult.totalInvoices) * 100).toFixed(
          2
        )
        : 0,
      collectionRate: kpiResult.totalAmount
        ? ((kpiResult.totalPaid / kpiResult.totalAmount) * 100).toFixed(2)
        : 0,
    };

    return kpiResult;
  } catch (error) {
    console.error("Error calculating customer KPIs:", error);
    return {
      error: "Failed to calculate KPIs",
      details: error.message,
    };
  }
};

/**
 * Get customer summary with KPIs for all customers
 */
exports.getCustomersSummary = async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      sortBy = "totalAmount",
      sortOrder = -1,
      search,
      minInvoices,
      minAmount,
    } = req.query;

    // Pipeline to aggregate customer data
    const pipeline = [
      // Group by customer
      {
        $group: {
          _id: "$CardCode",
          customerName: { $first: "$CardName" },
          totalInvoices: { $sum: 1 },
          totalAmount: { $sum: "$DocTotal" },
          totalPaid: { $sum: "$PaidToDate" },
          lastInvoiceDate: { $max: "$CreationDate" },
          firstInvoiceDate: { $min: "$CreationDate" },
          posCount: {
            $sum: { $cond: [{ $eq: ["$isPOS", true] }, 1, 0] },
          },
          deliveryCount: {
            $sum: { $cond: [{ $eq: ["$isDelivery", true] }, 1, 0] },
          },
        },
      },

      // Add derived fields
      {
        $addFields: {
          totalUnpaid: { $subtract: ["$totalAmount", "$totalPaid"] },
          posPercentage: {
            $multiply: [{ $divide: ["$posCount", "$totalInvoices"] }, 100],
          },
          deliveryPercentage: {
            $multiply: [{ $divide: ["$deliveryCount", "$totalInvoices"] }, 100],
          },
          averageInvoiceValue: { $divide: ["$totalAmount", "$totalInvoices"] },
          daysSinceLastInvoice: {
            $divide: [
              { $subtract: [new Date(), "$lastInvoiceDate"] },
              1000 * 60 * 60 * 24,
            ],
          },
          customerTenure: {
            $divide: [
              { $subtract: [new Date(), "$firstInvoiceDate"] },
              1000 * 60 * 60 * 24,
            ],
          },
        },
      },
    ];

    // Add search filter if provided
    if (search) {
      pipeline.push({
        $match: {
          $or: [
            { _id: new RegExp(search, "i") },
            { customerName: new RegExp(search, "i") },
          ],
        },
      });
    }

    // Add min invoices filter if provided
    if (minInvoices) {
      pipeline.push({
        $match: { totalInvoices: { $gte: parseInt(minInvoices) } },
      });
    }

    // Add min amount filter if provided
    if (minAmount) {
      pipeline.push({
        $match: { totalAmount: { $gte: parseFloat(minAmount) } },
      });
    }

    // Count total results for pagination before applying skip and limit
    const countPipeline = [...pipeline];
    countPipeline.push({ $count: "total" });

    // Add sorting
    pipeline.push({ $sort: { [sortBy]: parseInt(sortOrder) } });

    // Add pagination
    pipeline.push(
      { $skip: (parseInt(page) - 1) * parseInt(limit) },
      { $limit: parseInt(limit) }
    );

    // Execute both queries
    const [customers, countResult] = await Promise.all([
      Invoice.aggregate(pipeline).allowDiskUse(true),
      Invoice.aggregate(countPipeline).allowDiskUse(true),
    ]);
    const totalCount = countResult.length > 0 ? countResult[0].total : 0;

    return res.status(200).json({
      success: true,
      data: {
        customers,
        pagination: {
          totalCount,
          totalPages: Math.ceil(totalCount / parseInt(limit)),
          currentPage: parseInt(page),
          pageSize: parseInt(limit),
          hasNext: parseInt(page) < Math.ceil(totalCount / parseInt(limit)),
          hasPrevious: parseInt(page) > 1,
        },
      },
    });
  } catch (error) {
    console.error("Error fetching customers summary:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch customers summary",
      error: error.message,
    });
  }
};

/**
 * Get global KPIs for all invoices
 */
exports.getGlobalKPIs = async (req, res) => {
  try {
    // Extract date range parameters from the request
    const { startDate, endDate } = req.query;

    // Create a date filter that will be applied to all relevant pipelines
    const dateFilter = {};
    if (startDate && endDate) {
      dateFilter.CreationDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
      console.log("Date filter applied:", dateFilter);
    }

    // Initialize result object
    const kpiResult = {
      totalInvoices: 0,
      totalAmount: 0,
      totalPaid: 0,
      totalUnpaid: 0,
      averageInvoiceAmount: 0,
      uniqueCustomerCount: 0,
      averageRevenuePerCustomer: 0,
      collectionRate: 0,
      paymentMethodDistribution: [],
      channelDistribution: {
        pos: { count: 0, amount: 0 },
        delivery: { count: 0, amount: 0 },
        other: { count: 0, amount: 0 },
      },
      monthlyTrends: [],
      topCustomers: [],
      topProducts: [],
    };

    // 1. Total statistics - more efficient without $addToSet for all customers
    const totalStatsPipeline = [
      { $match: dateFilter },
      {
        $group: {
          _id: null,
          totalInvoices: { $sum: 1 },
          totalAmount: { $sum: "$DocTotal" },
          totalPaid: { $sum: "$PaidToDate" },
          averageAmount: { $avg: "$DocTotal" },
        },
      },
    ];

    // 2. Count unique customers separately with a more efficient approach
    const uniqueCustomersPipeline = [
      { $match: dateFilter },
      { $group: { _id: "$CardCode" } },
      { $count: "uniqueCustomerCount" },
    ];

    // 3. Channel distribution
    const channelStatsPipeline = [
      { $match: dateFilter },
      {
        $group: {
          _id: {
            isPOS: "$isPOS",
            isDelivery: "$isDelivery",
          },
          count: { $sum: 1 },
          amount: { $sum: "$DocTotal" },
        },
      },
    ];

    // 4. Monthly trends (using date filter instead of hardcoded 12 months)
    const monthlyTrendsPipeline = [
      { $match: dateFilter },
      {
        $group: {
          _id: {
            year: { $year: "$CreationDate" },
            month: { $month: "$CreationDate" },
          },
          invoiceCount: { $sum: 1 },
          totalAmount: { $sum: "$DocTotal" },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1 } },
    ];

    // 5. Payment method distribution
    const paymentMethodsPipeline = [
      { $match: dateFilter },
      {
        $group: {
          _id: "$paymentMethod",
          count: { $sum: 1 },
          amount: { $sum: "$DocTotal" },
        },
      },
    ];

    // 6. Top customers by revenue
    const topCustomersPipeline = [
      { $match: dateFilter },
      {
        $group: {
          _id: "$CardCode",
          customerName: { $first: "$CardName" },
          invoiceCount: { $sum: 1 },
          totalAmount: { $sum: "$DocTotal" },
        },
      },
      { $sort: { totalAmount: -1 } },
      { $limit: 50 },
    ];

    // 7. Top products by revenue - process in smaller chunks
    const topProductsPipeline = [
      { $match: dateFilter },
      { $unwind: "$DocumentLines" },
      {
        $group: {
          _id: "$DocumentLines.ItemCode",
          itemName: { $first: "$DocumentLines.ItemDescription" },
          quantity: { $sum: "$DocumentLines.Quantity" },
          revenue: {
            $sum: {
              $multiply: ["$DocumentLines.Price", "$DocumentLines.Quantity"],
            },
          },
          occurrences: { $sum: 1 },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 50 },
    ];

    // Execute all queries in parallel for better performance
    const [
      totalStatsResults,
      uniqueCustomersResults,
      channelStatsResults,
      monthlyTrendsResults,
      paymentMethodsResults,
      topCustomersResults,
      topProductsResults,
    ] = await Promise.all([
      Invoice.aggregate(totalStatsPipeline).allowDiskUse(true),
      Invoice.aggregate(uniqueCustomersPipeline).allowDiskUse(true),
      Invoice.aggregate(channelStatsPipeline).allowDiskUse(true),
      Invoice.aggregate(monthlyTrendsPipeline).allowDiskUse(true),
      Invoice.aggregate(paymentMethodsPipeline).allowDiskUse(true),
      Invoice.aggregate(topCustomersPipeline).allowDiskUse(true),
      Invoice.aggregate(topProductsPipeline).allowDiskUse(true),
    ]);

    // Extract and format total stats
    if (totalStatsResults.length > 0) {
      const stats = totalStatsResults[0];
      kpiResult.totalInvoices = stats.totalInvoices;
      kpiResult.totalAmount = stats.totalAmount;
      kpiResult.totalPaid = stats.totalPaid;
      kpiResult.totalUnpaid = stats.totalAmount - stats.totalPaid;
      kpiResult.averageInvoiceAmount = stats.averageAmount;

      // Get unique customer count
      kpiResult.uniqueCustomerCount =
        uniqueCustomersResults.length > 0
          ? uniqueCustomersResults[0].uniqueCustomerCount
          : 0;

      // Calculate derived metrics
      kpiResult.averageRevenuePerCustomer = kpiResult.uniqueCustomerCount
        ? kpiResult.totalAmount / kpiResult.uniqueCustomerCount
        : 0;

      kpiResult.collectionRate = kpiResult.totalAmount
        ? ((kpiResult.totalPaid / kpiResult.totalAmount) * 100).toFixed(2)
        : 0;
    }

    // Format payment method distribution
    kpiResult.paymentMethodDistribution = paymentMethodsResults.map((item) => ({
      method: item._id || "Unknown",
      count: item.count,
      amount: item.amount,
      percentage: kpiResult.totalInvoices
        ? ((item.count / kpiResult.totalInvoices) * 100).toFixed(2)
        : 0,
    }));

    // Format channel distribution
    channelStatsResults.forEach((item) => {
      if (item._id.isPOS) {
        kpiResult.channelDistribution.pos.count = item.count;
        kpiResult.channelDistribution.pos.amount = item.amount;
      } else if (item._id.isDelivery) {
        kpiResult.channelDistribution.delivery.count = item.count;
        kpiResult.channelDistribution.delivery.amount = item.amount;
      } else {
        kpiResult.channelDistribution.other.count = item.count;
        kpiResult.channelDistribution.other.amount = item.amount;
      }
    });

    // Format monthly trends
    const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];

    kpiResult.monthlyTrends = monthlyTrendsResults.map((item) => {
      // Calculate monthly unique customers separately if needed for high precision
      return {
        month: months[item._id.month - 1],
        year: item._id.year,
        count: item.invoiceCount,
        amount: item.totalAmount,
        customers: 0, // Will be updated below if necessary
        averageInvoiceValue: item.invoiceCount
          ? (item.totalAmount / item.invoiceCount).toFixed(2)
          : 0,
      };
    });

    // For monthly unique customers, we'll simplify this part to improve performance
    // We'll calculate a rough estimate based on the overall unique customer count
    // This avoids making too many separate aggregation queries
    if (monthlyTrendsResults.length > 0 && kpiResult.uniqueCustomerCount > 0) {
      const avgCustomersPerMonth = Math.round(
        kpiResult.uniqueCustomerCount / monthlyTrendsResults.length
      );
      kpiResult.monthlyTrends.forEach((item) => {
        // Assign a relative value based on invoice count compared to overall average
        const relativeActivity =
          item.count / (kpiResult.totalInvoices / monthlyTrendsResults.length);
        item.customers = Math.max(
          1,
          Math.round(avgCustomersPerMonth * relativeActivity)
        );
      });
    }

    // Format top customers
    kpiResult.topCustomers = topCustomersResults.map((item) => ({
      customerCode: item._id,
      customerName: item.customerName,
      invoiceCount: item.invoiceCount,
      totalAmount: item.totalAmount,
      averageInvoiceValue:
        item.invoiceCount > 0
          ? (item.totalAmount / item.invoiceCount).toFixed(2)
          : "0.00",
    }));

    // Format top products
    kpiResult.topProducts = topProductsResults.map((item) => ({
      itemCode: item._id,
      itemName: item.itemName,
      quantity: item.quantity,
      revenue: item.revenue,
      occurrences: item.occurrences,
      averagePrice:
        item.quantity > 0 ? (item.revenue / item.quantity).toFixed(2) : "0.00",
    }));

    return res.status(200).json({
      success: true,
      data: kpiResult,
    });
  } catch (error) {
    console.error("Error calculating global KPIs:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to calculate global KPIs",
      error: error.message,
    });
  }
};

/**
 * Handle customer-specific invoice search with various filters
 */
exports.searchInvoices = async (req, res) => {
  try {
    const {
      customerId,
      search,
      startDate,
      endDate,
      minAmount,
      maxAmount,
      paymentMethod,
      isPaid,
      isVerified,
      page = 1,
      limit = 10,
      sortBy = "DocDate",
      sortOrder = -1,
    } = req.query;

    // Build filter object
    const filter = {};

    // Add customer filter if provided
    if (customerId) {
      filter.CardCode = customerId;
    }

    // Add search filter if provided
    if (search) {
      const searchRegex = new RegExp(search, "i");
      filter.$or = [
        { DocNum: isNaN(search) ? searchRegex : Number(search) },
        { CardName: searchRegex },
        { NumAtCard: searchRegex },
        { Comments: searchRegex },
        { Reference1: searchRegex },
        { Reference2: searchRegex },
      ];
    }

    // Add date range filter if provided
    if (startDate && endDate) {
      filter.DocDate = {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      };
    }

    // Add amount range filter if provided
    if (minAmount || maxAmount) {
      filter.DocTotal = {};
      if (minAmount) filter.DocTotal.$gte = Number(minAmount);
      if (maxAmount) filter.DocTotal.$lte = Number(maxAmount);
    }

    // Add payment method filter if provided
    if (paymentMethod) {
      filter.paymentMethod = paymentMethod;
    }

    // Add verification status filter if provided
    if (isVerified !== undefined) {
      filter.verified = isVerified === "true";
    }

    // Add payment status filter if provided
    if (isPaid !== undefined) {
      if (isPaid === "true") {
        filter.$expr = { $eq: ["$PaidToDate", "$DocTotal"] };
      } else {
        filter.$expr = { $lt: ["$PaidToDate", "$DocTotal"] };
      }
    }

    // Calculate pagination values
    const skip = (Number(page) - 1) * Number(limit);

    // Define sort options
    const sort = {};
    sort[sortBy] = Number(sortOrder);

    // Execute query with pagination
    const invoices = await Invoice.find(filter)
      .sort(sort)
      .skip(skip)
      .limit(Number(limit))
      .lean();

    // Get total count for pagination
    const totalCount = await Invoice.countDocuments(filter);

    return res.status(200).json({
      success: true,
      data: {
        invoices,
        pagination: {
          totalCount,
          totalPages: Math.ceil(totalCount / Number(limit)),
          currentPage: Number(page),
          pageSize: Number(limit),
          hasNext: Number(page) < Math.ceil(totalCount / Number(limit)),
          hasPrevious: Number(page) > 1,
        },
      },
    });
  } catch (error) {
    console.error("Error searching invoices:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to search invoices",
      error: error.message,
    });
  }
};

exports.getInvoices = async (req, res) => {
  try {
    const invoices = await Invoice.find().lean().limit(10);
    return res.status(200).json({
      success: true,
      data: invoices,
    });
  } catch (error) {
    console.error("Error fetching invoices:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch invoices",
      error: error.message,
    });
  }
};

module.exports = exports;
