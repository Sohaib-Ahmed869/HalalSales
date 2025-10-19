// controllers/creditNoteController.js
const CreditNote = require("../models/CreditNotes");
const Invoice = require("../models/Invoice");
const {
    createCreditNoteInSAP,
    getNextCreditNoteDocNumFromSAP,
    formatCreditNoteForSAP,
    checkBusinessPartnerExists
} = require("../utils/sapB1Integration");

// Create credit note from invoice
exports.createCreditNoteFromInvoice = async (req, res) => {
    try {
        const { invoiceDocEntry } = req.params;
        const { creditLines, comments, reason } = req.body;

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
                message: "Invoice must be synced with SAP before creating credit note"
            });
        }

        // Get next DocNum
        let newDocNum, newDocEntry;
        try {
            newDocNum = await getNextCreditNoteDocNumFromSAP();
            newDocEntry = newDocNum || (await CreditNote.findOne().sort({ DocEntry: -1 }))?.DocEntry + 1 || 1;
        } catch (error) {
            const lastCN = await CreditNote.findOne().sort({ DocEntry: -1 });
            newDocEntry = lastCN ? lastCN.DocEntry + 1 : 1;
            newDocNum = newDocEntry;
        }

        // Calculate totals
        let docTotal = 0;
        let vatSum = 0;

        const processedLines = creditLines.map((line, index) => {
            const lineTotal = line.Quantity * line.Price;
            const lineTax = lineTotal * 0.055;

            docTotal += lineTotal;
            vatSum += lineTax;

            return {
                LineNum: index,
                ItemCode: line.ItemCode,
                ItemDescription: line.ItemDescription,
                Quantity: line.Quantity,
                Price: line.Price,
                LineTotal: lineTotal,
                VatGroup: line.VatGroup,
                BaseType: 13, // Invoice
                BaseEntry: invoice.SAPDocEntry,
                BaseLine: line.BaseLine || index
            };
        });

        // Create credit note
        const creditNote = new CreditNote({
            DocEntry: newDocEntry,
            DocNum: newDocNum,
            DocType: "dDocument_Items",
            CardCode: invoice.CardCode,
            CardName: invoice.CardName,
            Address: invoice.Address,
            DocTotal: docTotal,
            DocCurrency: invoice.DocCurrency || "EUR",
            VatSum: vatSum,
            DocDate: new Date(),
            DocDueDate: new Date(),
            BaseType: 13,
            BaseEntry: invoice.SAPDocEntry,
            OriginatingDocument: invoice.DocNum,
            Comments: comments || `Credit note for Invoice #${invoice.DocNum}. Reason: ${reason || 'Not specified'}`,
            DocumentLines: processedLines,
            DocumentStatus: "bost_Open",
            SyncedWithSAP: false,
            LocalStatus: "Created",
            salesAgent: invoice.salesAgent
        });

        await creditNote.save();

        res.status(201).json({
            success: true,
            message: "Credit note created successfully",
            data: creditNote
        });

    } catch (error) {
        console.error("Error creating credit note:", error);
        res.status(500).json({
            success: false,
            message: "Error creating credit note",
            error: error.message
        });
    }
};

// Push credit note to SAP
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

        // Format and push to SAP
        const sapCreditNote = await formatCreditNoteForSAP(creditNote);
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