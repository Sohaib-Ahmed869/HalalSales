// controllers/creditNoteController.js - FIXED VERSION
const CreditNote = require("../models/CreditNotes");
const Invoice = require("../models/Invoice");
const {
    createCreditNoteInSAP,
    getNextCreditNoteDocNumFromSAP,
    formatCreditNoteForSAP,
    checkBusinessPartnerExists
} = require("../utils/sapB1Integration");

// ✅ FIXED: Create credit note with proper base document references
exports.createCreditNoteFromInvoice = async (req, res) => {
    try {
        const { invoiceDocEntry } = req.params;
        const { creditLines, comments, reason } = req.body;

        console.log("\n" + "=".repeat(60));
        console.log("CREATE CREDIT NOTE REQUEST");
        console.log("=".repeat(60));
        console.log("Invoice DocEntry:", invoiceDocEntry);
        console.log("Lines:", JSON.stringify(creditLines, null, 2));
        console.log("Reason:", reason);
        console.log("=".repeat(60) + "\n");

        // Validate input
        if (!creditLines || !Array.isArray(creditLines) || creditLines.length === 0) {
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
        const invoice = await Invoice.findOne({ DocEntry: invoiceDocEntry });
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

        // Calculate totals
        let docTotal = 0;
        let vatSum = 0;

        // ✅ CRITICAL FIX: Build lines with proper base references
        const processedLines = creditLines.map((line, index) => {
            // Find the original invoice line
            const originalLine = invoice.DocumentLines.find(
                invLine => invLine.ItemCode === line.ItemCode
            );

            if (!originalLine) {
                console.warn(`Warning: Original line not found for item ${line.ItemCode}`);
            }

            const lineTotal = line.Quantity * line.Price;
            const lineTax = lineTotal * 0.055;

            docTotal += lineTotal;
            vatSum += lineTax;

            return {
                LineNum: index,
                ItemCode: line.ItemCode,
                ItemDescription: line.ItemDescription,
                Quantity: Number(line.Quantity),
                Price: Number(line.Price),
                LineTotal: lineTotal,
                VatGroup: line.VatGroup,

                // ✅ CRITICAL: Base document references
                // BaseType 13 = Invoice (AR Invoice)
                BaseType: 13,
                BaseEntry: invoice.SAPDocEntry, // SAP's DocEntry for the invoice
                BaseLine: originalLine ? originalLine.LineNum : index
            };
        });

        console.log("Credit note lines with base references:", {
            BaseEntry: invoice.SAPDocEntry,
            BaseType: 13,
            InvoiceDocNum: invoice.DocNum,
            Lines: processedLines.length
        });

        // **STEP 1: Create in SAP first**
        try {
            const creditNoteDataForSAP = {
                CardCode: invoice.CardCode,
                DocDate: new Date().toISOString().split('T')[0],
                DocDueDate: new Date().toISOString().split('T')[0],
                DocCurrency: invoice.DocCurrency || "EUR",
                Comments: comments || `Credit note for invoice #${invoice.DocNum}: ${reason}`,
                U_Notes: reason,
                DocumentLines: processedLines.map(line => ({
                    ItemCode: line.ItemCode,
                    ItemDescription: line.ItemDescription,
                    Quantity: line.Quantity,
                    Price: line.Price, // SAP uses "Price" for credit notes
                    LineNum: line.LineNum,

                    // ✅ CRITICAL: Base document references for SAP
                    BaseType: 13, // Invoice
                    BaseEntry: invoice.SAPDocEntry,
                    BaseLine: line.BaseLine
                }))
            };

            console.log("Credit note data for SAP:", JSON.stringify(creditNoteDataForSAP, null, 2));

            const sapResponse = await createCreditNoteInSAP(creditNoteDataForSAP);

            if (!sapResponse || !sapResponse.DocEntry) {
                throw new Error("Invalid response from SAP - no DocEntry received");
            }

            console.log("✅ Credit note created in SAP:", {
                DocEntry: sapResponse.DocEntry,
                DocNum: sapResponse.DocNum
            });

            // **STEP 2: Save to local DB**
            const creditNote = new CreditNote({
                DocEntry: sapResponse.DocEntry,
                DocNum: sapResponse.DocNum,
                SAPDocEntry: sapResponse.DocEntry,
                DocType: "dDocument_Items",
                CardCode: invoice.CardCode,
                CardName: invoice.CardName,
                Address: invoice.Address,
                DocTotal: docTotal,
                DocCurrency: invoice.DocCurrency || "EUR",
                VatSum: vatSum,
                DocDate: new Date(),
                DocDueDate: new Date(),

                // ✅ Base document references
                BaseType: 13, // Invoice
                BaseEntry: invoice.SAPDocEntry,
                OriginatingDocument: invoice.DocNum.toString(),

                Comments: creditNoteDataForSAP.Comments,
                U_Notes: reason,
                DocumentLines: processedLines,

                DocumentStatus: "bost_Close",
                SyncedWithSAP: true,
                LocalStatus: "Synced",
                salesAgent: invoice.salesAgent,
                Cancelled: "N",
                CreationDate: new Date(),
                UpdateDate: new Date()
            });

            await creditNote.save();

            // **STEP 3: Update invoice with credit note reference**
            invoice.hasCreditNotes = true;
            invoice.creditNoteDocEntries = invoice.creditNoteDocEntries || [];
            invoice.creditNoteDocEntries.push(sapResponse.DocEntry);
            invoice.totalCreditAmount = (invoice.totalCreditAmount || 0) + docTotal;

            // Update remaining balance
            invoice.remainingBalance = (invoice.DocTotal || 0) -
                (invoice.totalCreditAmount || 0) -
                (invoice.totalPaidAmount || 0);

            // Update payment status
            if (invoice.remainingBalance <= 0) {
                invoice.paymentStatus = 'Fully Paid';
                invoice.DocumentStatus = 'bost_Close';
                console.log(`✅ Full credit - Invoice #${invoice.DocNum} closed`);
            } else if ((invoice.totalPaidAmount || 0) > 0 || (invoice.totalCreditAmount || 0) > 0) {
                invoice.paymentStatus = 'Partially Paid';
                console.log(`ℹ️ Partial credit - Invoice #${invoice.DocNum} remains open`);
            }

            await invoice.save();

            console.log(`✅ Credit note ${sapResponse.DocNum} linked to Invoice ${invoice.DocNum}`);

            res.status(201).json({
                success: true,
                message: "Credit note created and synced to SAP successfully",
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
                },
                syncedToSAP: true,
                linkedToInvoice: invoice.DocNum,
                isFullCredit: invoice.remainingBalance <= 0
            });

        } catch (sapError) {
            console.error("\n" + "=".repeat(60));
            console.error("SAP CREDIT NOTE CREATION FAILED");
            console.error("=".repeat(60));
            console.error("Error:", sapError.message);
            console.error("=".repeat(60) + "\n");

            return res.status(500).json({
                success: false,
                message: "Failed to create credit note in SAP",
                error: sapError.message
            });
        }

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

// Push credit note to SAP (for unsynced credit notes)
exports.pushCreditNoteToSAP = async (req, res) => {
    try {
        const { docEntry } = req.params;

        const creditNote = await CreditNote.findOne({ DocEntry: docEntry });
        if (!creditNote) {
            return res.status(404).json({
                success: false,
                message: "Credit note not found"
            });
        }

        if (creditNote.SyncedWithSAP) {
            return res.status(400).json({
                success: false,
                message: "Credit note already synced with SAP"
            });
        }

        // Check business partner
        const bpExists = await checkBusinessPartnerExists(creditNote.CardCode);
        if (!bpExists) {
            creditNote.SyncErrors = `Business partner ${creditNote.CardCode} not found in SAP`;
            creditNote.LocalStatus = "SyncFailed";
            creditNote.SAPSyncDisabled = true;
            await creditNote.save();

            return res.status(400).json({
                success: false,
                message: creditNote.SyncErrors
            });
        }

        // Format with base references
        const sapCreditNote = {
            CardCode: creditNote.CardCode,
            DocDate: creditNote.DocDate ? new Date(creditNote.DocDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
            DocDueDate: creditNote.DocDueDate ? new Date(creditNote.DocDueDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
            DocCurrency: creditNote.DocCurrency || "EUR",
            Comments: creditNote.Comments,
            U_Notes: creditNote.U_Notes,
            DocumentLines: creditNote.DocumentLines.map((line, index) => ({
                ItemCode: line.ItemCode,
                ItemDescription: line.ItemDescription,
                Quantity: line.Quantity,
                Price: line.Price,
                LineNum: index,

                // ✅ Include base references
                BaseType: line.BaseType || 13,
                BaseEntry: line.BaseEntry || creditNote.BaseEntry,
                BaseLine: line.BaseLine !== undefined ? line.BaseLine : index
            }))
        };

        const sapResponse = await createCreditNoteInSAP(sapCreditNote);

        // Update local document
        creditNote.SAPDocEntry = sapResponse.DocEntry;
        if (sapResponse.DocNum) {
            creditNote.DocNum = sapResponse.DocNum;
        }
        creditNote.DocumentStatus = "bost_Close";
        creditNote.SyncedWithSAP = true;
        creditNote.LocalStatus = "Synced";
        creditNote.SyncErrors = null;
        creditNote.LastSyncAttempt = new Date();
        await creditNote.save();

        res.status(200).json({
            success: true,
            message: "Credit note synced to SAP successfully",
            data: {
                DocEntry: creditNote.DocEntry,
                SAPDocEntry: sapResponse.DocEntry,
                SAPDocNum: sapResponse.DocNum
            }
        });

    } catch (error) {
        console.error("Error pushing credit note to SAP:", error);
        res.status(500).json({
            success: false,
            message: "Error syncing credit note to SAP",
            error: error.message
        });
    }
};

// Get all credit notes
exports.getAllCreditNotes = async (req, res) => {
    try {
        const { page = 1, limit = 20, cardCode, syncStatus } = req.query;
        const skip = (page - 1) * limit;

        const query = {};
        if (cardCode) query.CardCode = { $regex: cardCode, $options: 'i' };
        if (syncStatus === 'synced') query.SyncedWithSAP = true;
        if (syncStatus === 'unsynced') query.SyncedWithSAP = false;

        const [creditNotes, total] = await Promise.all([
            CreditNote.find(query)
                .populate('salesAgent', 'firstName lastName')
                .sort({ DocDate: -1 })
                .skip(skip)
                .limit(parseInt(limit)),
            CreditNote.countDocuments(query)
        ]);

        res.status(200).json({
            success: true,
            data: creditNotes,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
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

module.exports = exports;