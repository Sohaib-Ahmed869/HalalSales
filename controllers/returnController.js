// controllers/returnController.js - FIXED VERSION
const Return = require("../models/Return");
const DeliveryNote = require("../models/DeliveryNote");
const {
    createReturnInSAP,
    getNextReturnDocNumFromSAP,
    formatReturnForSAP,
    checkBusinessPartnerExists
} = require("../utils/sapB1Integration");

// ✅ FIXED: Create return with proper base document references
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


        // ✅ CRITICAL FIX: Use the actual SAP DocEntry for base reference
        const sapDNDocEntry = deliveryNote.SAPDocEntry || deliveryNote.DocEntry;
        console.log(`Using SAP DN DocEntry: ${sapDNDocEntry} for return (DN DocNum: ${deliveryNote.DocNum})`);

        // Calculate totals
        let docTotal = 0;
        let vatSum = 0;

        // ✅ CRITICAL FIX: Include base document references to link and close DN
        const processedLines = returnLines.map((line, index) => {
            const lineTotal = line.Price > 0 ? line.Quantity * line.Price : 0;
            const lineTax = lineTotal > 0
                ? (line.VatGroup === 'C3' ? lineTotal * 0.055 :
                    line.VatGroup === 'C4' ? lineTotal * 0.20 : 0)
                : 0;

            docTotal += lineTotal;
            docTotal += lineTax;
            vatSum += lineTax;

            // Find the original DN line to get BaseLine
            const originalLine = deliveryNote.DocumentLines.find(
                dnLine => dnLine.ItemCode === line.ItemCode
            );

            return {
                ItemCode: line.ItemCode,
                ItemDescription: line.ItemDescription,
                Quantity: line.Quantity,
                UnitPrice: line.Price,
                LineNum: index,

                // ✅ CRITICAL: Use SAPDocEntry instead of DocEntry
                BaseType: 15,
                BaseEntry: sapDNDocEntry, // *** FIXED: Use SAP's DocEntry ***
                BaseLine: line.BaseLine
            };
        });

        console.log("Creating return with base DN references:", {
            BaseEntry: sapDNDocEntry, // *** UPDATED LOG ***
            BaseType: 15,
            DNDocNum: deliveryNote.DocNum,
            DNLocalDocEntry: deliveryNote.DocEntry,
            DNSAPDocEntry: deliveryNote.SAPDocEntry,
            Lines: processedLines.length
        });
        // **STEP 1: Create in SAP first**
        try {
            console.log(processedLines);
            const returnDataForSAP = {
                CardCode: deliveryNote.CardCode,
                DocDate: new Date(),
                DocDueDate: new Date(),
                Comments: comments || `Return for DN #${deliveryNote.DocNum}. Reason: ${reason || 'Not specified'}`,
                DocumentLines: processedLines.map(line => ({
                    ItemCode: line.ItemCode,
                    ItemDescription: line.ItemDescription,
                    Quantity: line.Quantity,
                    UnitPrice: line.UnitPrice,
                    LineNum: line.LineNum,

                    // ✅ CRITICAL: Use the correct SAP DocEntry
                    BaseType: 15, // Delivery Note
                    BaseEntry: sapDNDocEntry, // *** FIXED ***
                    BaseLine: line.BaseLine
                }))
            };

            console.log("Return data for SAP:", JSON.stringify(returnDataForSAP, null, 2));

            const sapResponse = await createReturnInSAP(returnDataForSAP);
            if (!sapResponse || !sapResponse.DocEntry) {
                throw new Error("Invalid response from SAP - no DocEntry received");
            }

            console.log("✅ Return created in SAP:", {
                DocEntry: sapResponse.DocEntry,
                DocNum: sapResponse.DocNum
            });



            // **STEP 2: Save to local DB with SAP-assigned DocEntry/DocNum**
            const returnDoc = new Return({
                DocEntry: sapResponse.DocEntry,
                DocNum: sapResponse.DocNum,
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

                // ✅ Base document references - use SAP DocEntry
                BaseType: 15, // Delivery Note
                BaseEntry: sapDNDocEntry, // *** FIXED ***
                OriginatingDocument: deliveryNote.DocNum,

                Comments: returnDataForSAP.Comments,
                DocumentLines: processedLines.map((line, index) => ({
                    LineNum: index,
                    ItemCode: line.ItemCode,
                    ItemDescription: line.ItemDescription,
                    Quantity: line.Quantity,
                    Price: line.UnitPrice ? line.UnitPrice : 0,
                    LineTotal: line.Quantity * (line.UnitPrice ? line.UnitPrice : 0),
                    VatGroup: returnLines[index].VatGroup,

                    // ✅ Base references in local DB too - use SAP DocEntry
                    BaseType: 15,
                    BaseEntry: sapDNDocEntry, // *** FIXED ***
                    BaseLine: line.BaseLine
                })),

                DocumentStatus: "bost_Close",
                SyncedWithSAP: true,
                LocalStatus: "Synced",
                salesAgent: deliveryNote.salesAgent
            });

            console.log("Saving return document locally:", {
                DocEntry: sapResponse.DocEntry,
                DocNum: sapResponse.DocNum,
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

                // ✅ Base document references - use SAP DocEntry
                BaseType: 15, // Delivery Note
                BaseEntry: sapDNDocEntry, // *** FIXED ***
                OriginatingDocument: deliveryNote.DocNum,

                Comments: returnDataForSAP.Comments,
                DocumentLines: processedLines.map((line, index) => ({
                    LineNum: index,
                    ItemCode: line.ItemCode,
                    ItemDescription: line.ItemDescription,
                    Quantity: line.Quantity,
                    Price: line.UnitPrice ? line.UnitPrice : 0,
                    LineTotal: line.Quantity * (line.UnitPrice ? line.UnitPrice : 0),
                    VatGroup: returnLines[index].VatGroup,

                    // ✅ Base references in local DB too - use SAP DocEntry
                    BaseType: 15,
                    BaseEntry: sapDNDocEntry, // *** FIXED ***
                    BaseLine: line.BaseLine
                })),

                DocumentStatus: "bost_Close",
                SyncedWithSAP: true,
                LocalStatus: "Synced",
                salesAgent: deliveryNote.salesAgent
            });

            console.log("Return document saved locally:", returnDoc);

            await returnDoc.save();

            // **STEP 3: Update delivery note to mark it has returns**
            deliveryNote.hasReturns = true;
            deliveryNote.returnDocEntries = deliveryNote.returnDocEntries || [];
            deliveryNote.returnDocEntries.push(sapResponse.DocEntry);
            deliveryNote.totalReturnedAmount = (deliveryNote.totalReturnedAmount || 0) + docTotal;
            await deliveryNote.save();

            // **STEP 4: Check if DN should be closed (full return)**
            const totalDNAmount = deliveryNote.DocTotal;
            const totalReturned = deliveryNote.totalReturnedAmount;

            if (Math.abs(totalDNAmount - totalReturned) < 0.01) {
                console.log(`✅ Full return detected - DN #${deliveryNote.DocNum} should be closed in SAP`);
                // SAP will automatically close the DN due to base document references
            } else {
                console.log(`ℹ️ Partial return - DN #${deliveryNote.DocNum} remains open`);
            }

            console.log(`✅ Return ${sapResponse.DocNum} linked to DN ${deliveryNote.DocNum}`);

            res.status(201).json({
                success: true,
                message: "Return created and synced to SAP successfully",
                data: returnDoc,
                syncedToSAP: true,
                linkedToDeliveryNote: deliveryNote.DocNum,
                isFullReturn: Math.abs(totalDNAmount - totalReturned) < 0.01
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

// Push return to SAP (for unsynced returns)
exports.pushReturnToSAP = async (req, res) => {
    try {
        const { docEntry } = req.params;

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

        // Format and push to SAP with base references
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
                LineNum: index,

                // ✅ Include base references
                BaseType: line.BaseType || 15,
                BaseEntry: line.BaseEntry || returnDoc.BaseEntry,
                BaseLine: line.BaseLine !== undefined ? line.BaseLine : index
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