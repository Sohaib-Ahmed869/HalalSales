// controllers/returnController.js
const Return = require("../models/Return");
const DeliveryNote = require("../models/DeliveryNote");
const {
    createReturnInSAP,
    getNextReturnDocNumFromSAP,
    formatReturnForSAP,
    checkBusinessPartnerExists
} = require("../utils/sapB1Integration");

// controllers/returnController.js - Update createReturnFromDeliveryNote

// controllers/returnController.js
// Replace the entire createReturnFromDeliveryNote function

exports.createReturnFromDeliveryNote = async (req, res) => {
    try {
        const { deliveryNoteDocEntry } = req.params;
        const { returnLines, comments, reason } = req.body;

        // Find delivery note
        const deliveryNote = await DeliveryNote.findOne({ DocEntry: deliveryNoteDocEntry });
        if (!deliveryNote) {
            return res.status(404).json({
                success: false,
                message: "Delivery note not found"
            });
        }

        // Check if DN is synced with SAP
        if (!deliveryNote.SyncedWithSAP || !deliveryNote.SAPDocEntry) {
            return res.status(400).json({
                success: false,
                message: "Delivery note must be synced with SAP before creating return"
            });
        }

        // Calculate totals
        let docTotal = 0;
        let vatSum = 0;

        const processedLines = returnLines.map((line, index) => {
            const lineTotal = line.Quantity * line.Price;
            const lineTax = lineTotal * 0.055;

            docTotal += lineTotal;
            vatSum += lineTax;

            return {
                ItemCode: line.ItemCode,
                ItemDescription: line.ItemDescription,
                Quantity: line.Quantity,
                UnitPrice: line.Price,
                LineNum: index,
                // ✅ CRITICAL: Do NOT include BaseType, BaseEntry, BaseLine for returns
                // SAP Returns don't support base document references from delivery notes
            };
        });

        // **STEP 1: Create in SAP first**
        try {
            const { createReturnInSAP } = require("../utils/sapB1Integration");

            const returnDataForSAP = {
                CardCode: deliveryNote.CardCode,
                DocDate: new Date(),
                DocDueDate: new Date(),
                Comments: comments || `Return for DN #${deliveryNote.DocNum}. Reason: ${reason || 'Not specified'}`,
                DocumentLines: processedLines
            };

            console.log("Creating return in SAP...");
            const sapResponse = await createReturnInSAP(returnDataForSAP);

            if (!sapResponse || !sapResponse.DocEntry) {
                throw new Error("Invalid response from SAP - no DocEntry received");
            }

            // **STEP 2: Save to local DB with SAP-assigned DocEntry/DocNum**
            const Return = require("../models/Return");
            const returnDoc = new Return({
                DocEntry: sapResponse.DocEntry,  // ✅ Use SAP DocEntry
                DocNum: sapResponse.DocNum,      // ✅ Use SAP DocNum
                SAPDocEntry: sapResponse.DocEntry,
                DocType: "dDocument_Items",
                CardCode: deliveryNote.CardCode,
                CardName: deliveryNote.CardName,
                Address: deliveryNote.Address,
                DocTotal: docTotal,
                DocCurrency: deliveryNote.DocCurrency || "EUR",
                VatSum: vatSum,
                DocDate: new Date(),
                DocDueDate: new Date(),
                BaseEntry: deliveryNote.SAPDocEntry,
                OriginatingDocument: deliveryNote.DocNum,
                Comments: returnDataForSAP.Comments,
                DocumentLines: processedLines.map((line, index) => ({
                    LineNum: index,
                    ItemCode: line.ItemCode,
                    ItemDescription: line.ItemDescription,
                    Quantity: line.Quantity,
                    Price: line.UnitPrice,
                    LineTotal: line.Quantity * line.UnitPrice,
                    VatGroup: returnLines[index].VatGroup
                })),
                DocumentStatus: "bost_Close",    // Already synced
                SyncedWithSAP: true,             // ✅ Already synced
                LocalStatus: "Synced",           // ✅ Already synced
                salesAgent: deliveryNote.salesAgent
            });

            await returnDoc.save();

            // **STEP 3: Update delivery note to mark it has returns**
            deliveryNote.hasReturns = true;
            deliveryNote.returnDocEntries = deliveryNote.returnDocEntries || [];
            deliveryNote.returnDocEntries.push(sapResponse.DocEntry);
            deliveryNote.totalReturnedAmount = (deliveryNote.totalReturnedAmount || 0) + docTotal;
            await deliveryNote.save();

            console.log(`✅ Return created successfully: DocEntry ${sapResponse.DocEntry}, DocNum ${sapResponse.DocNum}`);
            console.log(`✅ Delivery note ${deliveryNote.DocNum} marked with return`);

            res.status(201).json({
                success: true,
                message: "Return created and synced to SAP successfully",
                data: returnDoc,
                syncedToSAP: true
            });

        } catch (sapError) {
            console.error("Error creating return in SAP:", sapError);
            return res.status(500).json({
                success: false,
                message: "Failed to create return in SAP",
                error: sapError.message
            });
        }

    } catch (error) {
        console.error("Error creating return:", error);
        res.status(500).json({
            success: false,
            message: "Error creating return",
            error: error.message
        });
    }
};

// controllers/returnController.js
// Replace pushReturnToSAP function

exports.pushReturnToSAP = async (req, res) => {
    try {
        const { docEntry } = req.params;

        const Return = require("../models/Return");
        const returnDoc = await Return.findOne({ DocEntry: docEntry });

        if (!returnDoc) {
            return res.status(404).json({
                success: false,
                message: "Return not found"
            });
        }

        if (returnDoc.SyncedWithSAP) {
            return res.status(400).json({
                success: false,
                message: "Return already synced with SAP",
                data: {
                    DocEntry: returnDoc.DocEntry,
                    SAPDocEntry: returnDoc.SAPDocEntry
                }
            });
        }

        // Check business partner
        const { checkBusinessPartnerExists, createReturnInSAP } = require("../utils/sapB1Integration");
        const bpExists = await checkBusinessPartnerExists(returnDoc.CardCode);

        if (!bpExists) {
            returnDoc.SyncErrors = `Business partner ${returnDoc.CardCode} not found in SAP`;
            returnDoc.LocalStatus = "SyncFailed";
            returnDoc.SAPSyncDisabled = true;
            await returnDoc.save();

            return res.status(400).json({
                success: false,
                message: returnDoc.SyncErrors
            });
        }

        // Format and push to SAP
        const returnDataForSAP = {
            CardCode: returnDoc.CardCode,
            DocDate: returnDoc.DocDate || new Date(),
            DocDueDate: returnDoc.DocDueDate || new Date(),
            Comments: returnDoc.Comments,
            DocumentLines: returnDoc.DocumentLines.map((line, index) => ({
                ItemCode: line.ItemCode,
                ItemDescription: line.ItemDescription,
                Quantity: line.Quantity,
                UnitPrice: line.Price,
                LineNum: index
                // ✅ No BaseType, BaseEntry, BaseLine
            }))
        };

        const sapResponse = await createReturnInSAP(returnDataForSAP);

        // Update local document
        returnDoc.SAPDocEntry = sapResponse.DocEntry;
        if (sapResponse.DocNum) {
            returnDoc.DocNum = sapResponse.DocNum;
        }
        returnDoc.DocumentStatus = "bost_Close";
        returnDoc.SyncedWithSAP = true;
        returnDoc.LocalStatus = "Synced";
        returnDoc.SyncErrors = null;
        returnDoc.LastSyncAttempt = new Date();
        await returnDoc.save();

        res.status(200).json({
            success: true,
            message: "Return synced to SAP successfully",
            data: {
                DocEntry: returnDoc.DocEntry,
                SAPDocEntry: sapResponse.DocEntry,
                SAPDocNum: sapResponse.DocNum
            }
        });

    } catch (error) {
        console.error("Error pushing return to SAP:", error);
        res.status(500).json({
            success: false,
            message: "Error syncing return to SAP",
            error: error.message
        });
    }
};

// Get all returns
exports.getAllReturns = async (req, res) => {
    try {
        const { page = 1, limit = 20, cardCode, syncStatus } = req.query;
        const skip = (page - 1) * limit;

        const query = {};
        if (cardCode) query.CardCode = { $regex: cardCode, $options: 'i' };
        if (syncStatus === 'synced') query.SyncedWithSAP = true;
        if (syncStatus === 'unsynced') query.SyncedWithSAP = false;

        const [returns, total] = await Promise.all([
            Return.find(query)
                .populate('salesAgent', 'firstName lastName')
                .sort({ DocDate: -1 })
                .skip(skip)
                .limit(parseInt(limit)),
            Return.countDocuments(query)
        ]);

        res.status(200).json({
            success: true,
            data: returns,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error("Error fetching returns:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching returns",
            error: error.message
        });
    }
};

module.exports = exports;