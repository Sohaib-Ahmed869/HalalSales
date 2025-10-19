// controllers/deliveryNoteController.js
const DeliveryNote = require("../models/DeliveryNote");
const SalesOrder = require("../models/SalesOrder");
const User = require("../models/User");
const {
    createDeliveryNoteInSAP,
    getDeliveryNoteFromSAP,
    checkBusinessPartnerExists,
} = require("../utils/sapB1Integration");

// Helper function to format delivery note for SAP
async function formatDeliveryNoteForSAP(deliveryNote) {
    const today = new Date();

    const sapDeliveryNote = {
        CardCode: deliveryNote.CardCode,
        DocDate: deliveryNote.DocDate || today,
        DocDueDate: deliveryNote.DocDueDate || today,
        Comments: deliveryNote.Comments || "",
        U_Notes: deliveryNote.U_Notes || "",
        PriceList: deliveryNote.PriceList ? parseInt(deliveryNote.PriceList, 10) : 2,
        DocumentLines: [],
    };

    // Process document lines
    if (deliveryNote.DocumentLines && Array.isArray(deliveryNote.DocumentLines)) {
        sapDeliveryNote.DocumentLines = deliveryNote.DocumentLines.map((line, index) => {
            const sapLine = {
                ItemCode: line.ItemCode,
                Quantity: Number(line.Quantity || 0),
                UnitPrice: Number(line.Price || line.UnitPrice || 0),
                ItemDescription: line.ItemDescription || "",
                PriceList: line.PriceList
                    ? parseInt(line.PriceList, 10)
                    : deliveryNote.PriceList
                        ? parseInt(deliveryNote.PriceList, 10)
                        : 2,
                LineNum: index,
            };

            // ✅ CRITICAL: Include base document references if available
            if (line.BaseType && line.BaseEntry) {
                sapLine.BaseType = Number(line.BaseType);
                sapLine.BaseEntry = Number(line.BaseEntry);
                sapLine.BaseLine = Number(line.BaseLine !== undefined ? line.BaseLine : index);
            }

            return sapLine;
        });
    }

    // Add reference to local DocNum
    if (deliveryNote.DocNum) {
        sapDeliveryNote.U_LocalDocNum = deliveryNote.DocNum.toString();
    }

    // Add reference to source order
    if (deliveryNote.OriginatingOrder) {
        sapDeliveryNote.U_SourceOrderNum = deliveryNote.OriginatingOrder.toString();
    }

    console.log("SAP Delivery Note formatted:", {
        CardCode: sapDeliveryNote.CardCode,
        DocumentLines: sapDeliveryNote.DocumentLines.length,
        HasBaseReferences: sapDeliveryNote.DocumentLines.some(l => l.BaseType === 17)
    });

    return sapDeliveryNote;
}

// Helper function to push delivery note to SAP with retry logic
async function pushDeliveryNoteToSAPWithRetry(deliveryNote, maxRetries = 3) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`Attempt ${attempt}/${maxRetries} - Pushing delivery note ${deliveryNote.DocNum} to SAP...`);

            // Check if business partner exists first
            const bpExists = await checkBusinessPartnerExists(deliveryNote.CardCode);

            if (!bpExists) {
                deliveryNote.SyncErrors = `Business partner ${deliveryNote.CardCode} does not exist in SAP B1`;
                deliveryNote.LastSyncAttempt = new Date();
                deliveryNote.LocalStatus = "SyncFailed";
                deliveryNote.SAPSyncDisabled = true;
                await deliveryNote.save();

                return {
                    success: false,
                    error: deliveryNote.SyncErrors,
                    code: "BP_NOT_FOUND",
                };
            }

            // Format for SAP
            const sapDeliveryNote = await formatDeliveryNoteForSAP(deliveryNote);

            // Push to SAP
            const sapResponse = await createDeliveryNoteInSAP(sapDeliveryNote);

            if (sapResponse && sapResponse.DocEntry) {
                // Update local delivery note with SAP details
                deliveryNote.SAPDocEntry = sapResponse.DocEntry;

                if (sapResponse.DocNum) {
                    console.log(`Updating local DocNum from ${deliveryNote.DocNum} to ${sapResponse.DocNum}`);
                    deliveryNote.DocNum = sapResponse.DocNum;
                }

                deliveryNote.DocumentStatus = "bost_Close";
                deliveryNote.UpdateDate = new Date();
                deliveryNote.SyncedWithSAP = true;
                deliveryNote.LocalStatus = "Synced";
                deliveryNote.SyncErrors = null;
                deliveryNote.LastSyncAttempt = new Date();

                await deliveryNote.save();

                console.log(`✅ Successfully pushed delivery note ${deliveryNote.DocNum} to SAP (DocEntry: ${sapResponse.DocEntry})`);

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

            // If it's the last attempt, update the delivery note with error
            if (attempt === maxRetries) {
                let errorCode = "GENERAL_ERROR";

                if (error.message && error.message.includes("Business partner")) {
                    errorCode = "BP_NOT_FOUND";
                }

                deliveryNote.SyncErrors = error.message;
                deliveryNote.LastSyncAttempt = new Date();
                deliveryNote.LocalStatus = "SyncFailed";

                if (errorCode === "BP_NOT_FOUND") {
                    deliveryNote.SAPSyncDisabled = true;
                }

                await deliveryNote.save();
            } else {
                // Wait before retry (exponential backoff)
                const waitTime = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
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

// Create delivery note from sales order
exports.createDeliveryNoteFromOrder = async (req, res) => {
    try {
        const { docEntry } = req.params;

        // Find the sales order
        const salesOrder = await SalesOrder.findOne({ DocEntry: docEntry });

        if (!salesOrder) {
            return res.status(404).json({
                success: false,
                message: `Sales order with DocEntry ${docEntry} not found`,
            });
        }

        // Check if delivery note already exists for this order
        const existingDeliveryNote = await DeliveryNote.findOne({
            BaseEntry: salesOrder.SAPDocEntry // Check by SAP DocEntry
        });

        if (existingDeliveryNote) {
            return res.status(400).json({
                success: false,
                message: "Delivery note already exists for this order",
                data: existingDeliveryNote,
            });
        }

        // *** CRITICAL: Check if sales order is synced with SAP ***
        if (!salesOrder.SyncedWithSAP || !salesOrder.SAPDocEntry) {
            return res.status(400).json({
                success: false,
                message: `Sales order ${salesOrder.DocNum} is not synced with SAP. Cannot create delivery note.`,
                data: {
                    orderDocNum: salesOrder.DocNum,
                    orderSynced: salesOrder.SyncedWithSAP,
                    orderSAPDocEntry: salesOrder.SAPDocEntry
                }
            });
        }

        // Get next DocNum from SAP
        let newDocNum;
        let newDocEntry;

        try {
            const { getNextDeliveryNoteDocNumFromSAP } = require("../utils/sapB1Integration");
            newDocNum = await getNextDeliveryNoteDocNumFromSAP();

            if (newDocNum) {
                console.log(`Using SAP-aligned Delivery Note DocNum: ${newDocNum}`);
                newDocEntry = newDocNum;
            } else {
                throw new Error("Could not get DocNum from SAP");
            }
        } catch (sapError) {
            console.warn("Could not get Delivery Note DocNum from SAP, falling back to local generation:", sapError.message);
            const lastDeliveryNote = await DeliveryNote.findOne().sort({ DocEntry: -1 });
            newDocEntry = lastDeliveryNote ? lastDeliveryNote.DocEntry + 1 : 1;
            newDocNum = newDocEntry;
            console.log(`Using local Delivery Note DocNum: ${newDocNum}`);
        }

        // Create delivery note from order with proper base references
        const deliveryNote = new DeliveryNote({
            DocEntry: newDocEntry,
            DocNum: newDocNum,
            DocType: "dDocument_Items",

            // Copy from sales order
            CardCode: salesOrder.CardCode,
            CardName: salesOrder.CardName,
            Address: salesOrder.Address,
            Address2: salesOrder.Address2,

            // Financial info
            DocTotal: salesOrder.DocTotal,
            DocCurrency: salesOrder.DocCurrency,
            VatSum: salesOrder.VatSum,
            DiscountPercent: salesOrder.DiscountPercent,
            PriceList: salesOrder.PriceList,

            // Dates
            DocDate: new Date(),
            DocDueDate: new Date(),
            TaxDate: new Date(),
            CreationDate: new Date(),
            UpdateDate: new Date(),

            // ✅ CRITICAL: Reference to source order - USE SAP DOCENTRY
            BaseType: 17, // Sales Order
            BaseEntry: salesOrder.SAPDocEntry, // *** USE SAP DOCENTRY ***
            OriginatingOrder: salesOrder.DocNum, // Keep local DocNum for reference

            // ✅ CRITICAL: Document lines with proper base references
            DocumentLines: salesOrder.DocumentLines.map((line, index) => ({
                LineNum: index,
                ItemCode: line.ItemCode,
                ItemDescription: line.ItemDescription,
                Quantity: line.Quantity,
                Price: line.Price || line.UnitPrice,
                UnitPrice: line.Price || line.UnitPrice,
                PriceAfterVAT: line.PriceAfterVAT,
                Currency: line.Currency || salesOrder.DocCurrency,
                LineTotal: line.LineTotal,
                VatGroup: line.VatGroup,
                PriceList: line.PriceList || salesOrder.PriceList,

                // ✅ Base document references for each line
                BaseType: 17, // Sales Order
                BaseEntry: salesOrder.SAPDocEntry, // *** USE SAP DOCENTRY ***
                BaseLine: line.LineNum,

                ShipDate: new Date(),
                ActualDeliveryDate: new Date(),
            })),

            // Status
            DocumentStatus: "bost_Open",
            SyncedWithSAP: false,
            LocalStatus: "Created",

            // Copy sales agent if exists
            salesAgent: salesOrder.salesAgent,

            // Comments
            Comments: `Delivery note for order #${salesOrder.DocNum}`,
            U_Notes: salesOrder.U_Notes || "",
        });

        await deliveryNote.save();

        console.log(`✅ Created delivery note ${newDocNum} with base order DocEntry ${salesOrder.SAPDocEntry}`);

        res.status(201).json({
            success: true,
            message: "Delivery note created successfully",
            data: deliveryNote,
        });

    } catch (error) {
        console.error("Error creating delivery note:", error);
        res.status(500).json({
            success: false,
            message: "Error creating delivery note",
            error: error.message,
        });
    }
};

// Bulk create delivery notes from multiple orders
exports.bulkCreateDeliveryNotesFromOrders = async (req, res) => {
    try {
        const { orderDocNums, autoSync = false, orderNotes = {} } = req.body;

        console.log('Request to bulk create delivery notes from orders:', orderDocNums);

        if (!orderDocNums || !Array.isArray(orderDocNums) || orderDocNums.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Please provide order DocEntries array",
            });
        }

        console.log(`Creating delivery notes for ${orderDocNums.length} orders...`);

        const results = {
            successful: [],
            failed: [],
            totalProcessed: 0,
        };

        // **TRACK THE HIGHEST DOCENTRY IN THIS BATCH**
        let currentMaxDocEntry = null;

        // Get the absolute latest DocEntry from DB once before the loop
        try {
            const lastDeliveryNote = await DeliveryNote.findOne().sort({ DocEntry: -1 });
            currentMaxDocEntry = lastDeliveryNote ? lastDeliveryNote.DocEntry : 0;
            console.log(`Starting bulk creation from DocEntry: ${currentMaxDocEntry + 1}`);
        } catch (error) {
            console.error("Error getting last DocEntry:", error);
            currentMaxDocEntry = 0;
        }

        // Process each order
        for (const docEntry of orderDocNums) {
            try {
                results.totalProcessed++;

                // Find sales order
                const salesOrder = await SalesOrder.findOne({ DocNum: docEntry });

                if (!salesOrder) {
                    results.failed.push({
                        docEntry,
                        error: "Sales order not found",
                    });
                    continue;
                }

               

                // Check if delivery note already exists
                const existingDeliveryNote = await DeliveryNote.findOne({
                    BaseEntry: salesOrder.SAPDocEntry ? salesOrder.SAPDocEntry : salesOrder.DocEntry
                });

                if (existingDeliveryNote) {
                    results.failed.push({
                        docEntry,
                        orderNum: salesOrder.DocNum,
                        error: "Delivery note already exists",
                        existingDocNum: existingDeliveryNote.DocNum,
                    });
                    continue;
                }

                // **INCREMENT FOR EACH NEW DELIVERY NOTE IN THIS BATCH**
                currentMaxDocEntry++;
                const newDocNum = currentMaxDocEntry;
                const newDocEntry = currentMaxDocEntry;

                console.log(`Creating DN with DocEntry: ${newDocEntry} for order ${salesOrder.DocNum}`);

                // Get custom note for this order
                const customNote = orderNotes[docEntry] || "";
                const deliveryNoteComments = customNote
                    ? `Delivery note for order #${salesOrder.DocNum}\n\n${customNote}`
                    : `Delivery note for order #${salesOrder.DocNum}`;

                // Update sales order with custom note if provided
                if (customNote) {
                    salesOrder.U_Notes = (salesOrder.U_Notes || "") + "\n\n" + customNote;
                    await salesOrder.save();
                }

                // Create delivery note with proper base references
                const deliveryNote = new DeliveryNote({
                    DocEntry: newDocEntry,
                    DocNum: newDocNum,
                    DocType: "dDocument_Items",
                    CardCode: salesOrder.CardCode,
                    CardName: salesOrder.CardName,
                    Address: salesOrder.Address,
                    Address2: salesOrder.Address2,
                    DocTotal: salesOrder.DocTotal,
                    DocCurrency: salesOrder.DocCurrency,
                    VatSum: salesOrder.VatSum,
                    DiscountPercent: salesOrder.DiscountPercent,
                    PriceList: salesOrder.PriceList,
                    DocDate: new Date(),
                    DocDueDate: new Date(),
                    TaxDate: new Date(),
                    CreationDate: new Date(),
                    UpdateDate: new Date(),

                    // ✅ Base references
                    BaseType: 17,
                    BaseEntry: salesOrder.SAPDocEntry, // *** SAP DOCENTRY ***
                    OriginatingOrder: salesOrder.DocNum,

                    // ✅ Lines with base references
                    DocumentLines: salesOrder.DocumentLines.map((line, index) => ({
                        LineNum: index,
                        ItemCode: line.ItemCode,
                        ItemDescription: line.ItemDescription,
                        Quantity: line.Quantity,
                        Price: line.Price || line.UnitPrice,
                        UnitPrice: line.Price || line.UnitPrice,
                        PriceAfterVAT: line.PriceAfterVAT,
                        Currency: line.Currency || salesOrder.DocCurrency,
                        LineTotal: line.LineTotal,
                        VatGroup: line.VatGroup,
                        PriceList: line.PriceList || salesOrder.PriceList,

                        // ✅ Base references
                        BaseType: 17,
                        BaseEntry: salesOrder.SAPDocEntry, // *** SAP DOCENTRY ***
                        BaseLine: line.LineNum,

                        ShipDate: new Date(),
                        ActualDeliveryDate: new Date(),
                    })),

                    DocumentStatus: "bost_Open",
                    SyncedWithSAP: false,
                    LocalStatus: "Created",
                    salesAgent: salesOrder.salesAgent,
                    Comments: deliveryNoteComments,
                    U_Notes: customNote || salesOrder.U_Notes || "",
                });

                await deliveryNote.save();

                results.successful.push({
                    docEntry: newDocEntry,
                    docNum: newDocNum,
                    orderDocEntry: salesOrder.DocEntry,
                    orderNum: salesOrder.DocNum,
                    cardCode: salesOrder.CardCode,
                    sapOrderDocEntry: salesOrder.SAPDocEntry, // For reference
                });

                console.log(`✅ Created delivery note ${newDocNum} for order ${salesOrder.DocNum} (mapped to SAP order ${salesOrder.SAPDocEntry})`);

            } catch (error) {
                console.error(`❌ Error processing order ${docEntry}:`, error);
                results.failed.push({
                    docEntry,
                    error: error.message,
                });
            }
        }

        // If autoSync is enabled, start background sync
        if (autoSync && results.successful.length > 0) {
            const deliveryNoteIds = results.successful.map(r => r.docEntry);

            setImmediate(async () => {
                try {
                    console.log("Starting background SAP sync for delivery notes...");
                    await exports.bulkPushDeliveryNotesToSAP({
                        body: { deliveryNoteDocEntries: deliveryNoteIds }
                    }, {
                        status: () => ({ json: () => { } })
                    });
                } catch (error) {
                    console.error("Background sync error:", error);
                }
            });
        }

        res.status(200).json({
            success: true,
            message: `Created ${results.successful.length} delivery notes`,
            data: results,
            autoSyncStarted: autoSync && results.successful.length > 0,
        });

    } catch (error) {
        console.error("Error in bulk delivery note creation:", error);
        res.status(500).json({
            success: false,
            message: "Error creating delivery notes",
            error: error.message,
        });
    }
};

// Bulk push delivery notes to SAP
exports.bulkPushDeliveryNotesToSAP = async (req, res) => {
    try {
        const { deliveryNoteDocEntries } = req.body;

        if (!deliveryNoteDocEntries || !Array.isArray(deliveryNoteDocEntries) ||
            deliveryNoteDocEntries.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Please provide deliveryNoteDocEntries array",
            });
        }

        console.log(`\n${"=".repeat(60)}`);
        console.log(`Starting bulk SAP push for ${deliveryNoteDocEntries.length} delivery notes`);
        console.log(`${"=".repeat(60)}\n`);

        const results = {
            successful: [],
            failed: [],
            totalProcessed: 0,
            startTime: new Date(),
        };

        // Process each delivery note with retry logic
        for (const docEntry of deliveryNoteDocEntries) {
            try {
                results.totalProcessed++;

                console.log(`\n[${results.totalProcessed}/${deliveryNoteDocEntries.length}] Processing delivery note ${docEntry}...`);

                const deliveryNote = await DeliveryNote.findOne({ DocEntry: docEntry })
                    .populate("salesAgent", "firstName lastName email");

                if (!deliveryNote) {
                    console.error(`❌ Delivery note ${docEntry} not found`);
                    results.failed.push({
                        docEntry,
                        error: "Delivery note not found",
                    });
                    continue;
                }

                // Check if already synced
                if (deliveryNote.SyncedWithSAP && deliveryNote.SAPDocEntry) {
                    console.log(`⚠️ Delivery note ${docEntry} already synced (SAP DocEntry: ${deliveryNote.SAPDocEntry})`);
                    results.failed.push({
                        docEntry,
                        docNum: deliveryNote.DocNum,
                        error: "Already synced with SAP",
                        sapDocEntry: deliveryNote.SAPDocEntry,
                    });
                    continue;
                }

                // Check if sync is disabled
                if (deliveryNote.SAPSyncDisabled) {
                    console.log(`⚠️ SAP sync disabled for delivery note ${docEntry}: ${deliveryNote.SyncErrors}`);
                    results.failed.push({
                        docEntry,
                        docNum: deliveryNote.DocNum,
                        error: deliveryNote.SyncErrors || "SAP sync disabled",
                    });
                    continue;
                }

                // Push to SAP with retry logic
                const sapResult = await pushDeliveryNoteToSAPWithRetry(deliveryNote, 3);

                if (sapResult.success) {
                    results.successful.push({
                        docEntry: deliveryNote.DocEntry,
                        docNum: deliveryNote.DocNum,
                        sapDocEntry: sapResult.SAPDocEntry,
                        sapDocNum: sapResult.SAPDocNum,
                        cardCode: deliveryNote.CardCode,
                        cardName: deliveryNote.CardName,
                        attempts: sapResult.attempts,
                    });

                    console.log(`✅ Successfully synced delivery note ${deliveryNote.DocNum} (Attempts: ${sapResult.attempts})`);
                } else {
                    results.failed.push({
                        docEntry: deliveryNote.DocEntry,
                        docNum: deliveryNote.DocNum,
                        cardCode: deliveryNote.CardCode,
                        error: sapResult.error,
                        attempts: sapResult.attempts,
                    });

                    console.error(`❌ Failed to sync delivery note ${deliveryNote.DocNum} after ${sapResult.attempts} attempts`);
                }

                // Small delay between pushes to avoid overwhelming SAP
                if (results.totalProcessed < deliveryNoteDocEntries.length) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }

            } catch (error) {
                console.error(`❌ Unexpected error processing delivery note ${docEntry}:`, error);
                results.failed.push({
                    docEntry,
                    error: error.message,
                });
            }
        }

        results.endTime = new Date();
        results.duration = ((results.endTime - results.startTime) / 1000).toFixed(2);

        console.log(`\n${"=".repeat(60)}`);
        console.log(`Bulk SAP Push Summary:`);
        console.log(`Total Processed: ${results.totalProcessed}`);
        console.log(`Successful: ${results.successful.length}`);
        console.log(`Failed: ${results.failed.length}`);
        console.log(`Duration: ${results.duration}s`);
        console.log(`${"=".repeat(60)}\n`);

        res.status(200).json({
            success: true,
            message: `Processed ${results.totalProcessed} delivery notes: ${results.successful.length} successful, ${results.failed.length} failed`,
            data: results,
        });

    } catch (error) {
        console.error("Error in bulk SAP push:", error);
        res.status(500).json({
            success: false,
            message: "Error pushing delivery notes to SAP",
            error: error.message,
        });
    }
};

exports.getAllDeliveryNotes = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        let query = {};

        // Apply filters
        if (req.query.cardCode) {
            query.CardCode = { $regex: req.query.cardCode, $options: "i" };
        }


        query.DocumentStatus = 'bost_Open';


        if (req.query.syncStatus) {
            if (req.query.syncStatus === "synced") {
                query.SyncedWithSAP = true;
            } else if (req.query.syncStatus === "unsynced") {
                query.SyncedWithSAP = false;
            } else if (req.query.syncStatus === "failed") {
                query.LocalStatus = "SyncFailed";
            }
        }

        // **NEW: Filter for returns**
        if (req.query.excludeReturns === "true") {
            query.hasReturns = { $ne: true };
        }

        if (req.query.fromDate && req.query.toDate) {
            query.DocDate = {
                $gte: new Date(req.query.fromDate),
                $lte: new Date(req.query.toDate),
            };
        }

        const deliveryNotes = await DeliveryNote.find(query)
            .populate("salesAgent", "firstName lastName email")
            .skip(skip)
            .limit(limit)
            .sort({ DocDate: -1 });

        const total = await DeliveryNote.countDocuments(query);

        res.status(200).json({
            success: true,
            count: deliveryNotes.length,
            total,
            page,
            pages: Math.ceil(total / limit),
            data: deliveryNotes,
        });

    } catch (error) {
        console.error("Error fetching delivery notes:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching delivery notes",
            error: error.message,
        });
    }
};
// Add this new function to controllers/deliveryNoteController.js

exports.getDeliveryNoteWithReturns = async (req, res) => {
    try {
        const { docEntry } = req.params;

        const deliveryNote = await DeliveryNote.findOne({ DocEntry: docEntry })
            .populate("salesAgent", "firstName lastName email")
            .lean();

        if (!deliveryNote) {
            return res.status(404).json({
                success: false,
                message: "Delivery note not found"
            });
        }

        // If no returns, return as-is
        if (!deliveryNote.hasReturns || !deliveryNote.returnDocEntries || deliveryNote.returnDocEntries.length === 0) {
            return res.status(200).json({
                success: true,
                data: {
                    deliveryNote,
                    returns: [],
                    netLines: deliveryNote.DocumentLines.map(line => ({
                        ...line,
                        deliveredQty: line.Quantity,
                        returnedQty: 0,
                        netQty: line.Quantity,
                        netTotal: line.Quantity * (line.Price || line.UnitPrice || 0)
                    })),
                    netDocTotal: deliveryNote.DocTotal,
                    totalReturnedAmount: 0
                }
            });
        }

        // Fetch all returns
        const Return = require("../models/Return");
        const returns = await Return.find({
            DocEntry: { $in: deliveryNote.returnDocEntries }
        }).lean();

        // Calculate returned quantities per item
        const returnedQuantities = {};
        let totalReturnAmount = 0;

        returns.forEach(returnDoc => {
            if (returnDoc.DocumentLines) {
                returnDoc.DocumentLines.forEach(line => {
                    const key = line.ItemCode;
                    returnedQuantities[key] = (returnedQuantities[key] || 0) + line.Quantity;
                    totalReturnAmount += (line.Quantity * line.Price);
                });
            }
        });

        // Calculate net lines
        const netLines = deliveryNote.DocumentLines.map(line => {
            const deliveredQty = line.Quantity || 0;
            const returnedQty = returnedQuantities[line.ItemCode] || 0;
            const netQty = deliveredQty - returnedQty;
            const netTotal = netQty * (line.Price || line.UnitPrice || 0);

            return {
                ...line,
                deliveredQty,
                returnedQty,
                netQty,
                netTotal
            };
        });

        const netDocTotal = deliveryNote.DocTotal - totalReturnAmount;

        res.status(200).json({
            success: true,
            data: {
                deliveryNote,
                returns,
                netLines,
                netDocTotal,
                totalReturnedAmount: totalReturnAmount,
                netVatSum: netDocTotal * 0.055
            }
        });

    } catch (error) {
        console.error("Error fetching delivery note with returns:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching delivery note details",
            error: error.message
        });
    }
};
// Get single delivery note
exports.getDeliveryNoteByDocEntry = async (req, res) => {
    try {
        const deliveryNote = await DeliveryNote.findOne({
            DocEntry: req.params.docEntry
        }).populate("salesAgent", "firstName lastName email");

        if (!deliveryNote) {
            return res.status(404).json({
                success: false,
                message: `Delivery note with DocEntry ${req.params.docEntry} not found`,
            });
        }

        res.status(200).json({
            success: true,
            data: deliveryNote,
        });

    } catch (error) {
        console.error("Error fetching delivery note:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching delivery note",
            error: error.message,
        });
    }
};

// Add to utils/sapB1Integration.js - Add these functions

// Create a delivery note in SAP B1
exports.createDeliveryNoteInSAP = async (deliveryNoteData) => {
    try {
        if (!ENABLE_SAP_SYNC) {
            console.log("SAP sync is disabled. Skipping delivery note creation in SAP.");
            return {
                simulated: true,
                message: "SAP sync is disabled",
                DocEntry: Math.floor(Math.random() * 10000),
                DocNum: Math.floor(Math.random() * 10000),
            };
        }

        const sessionId = await getSessionId();

        console.log("Creating delivery note in SAP B1...");
        console.log("Delivery note data being sent:", JSON.stringify(deliveryNoteData, null, 2));

        const response = await axios.post(
            `${SAP_CONFIG.serviceLayerUrl}/DeliveryNotes`,
            deliveryNoteData,
            {
                headers: {
                    "Content-Type": "application/json",
                    Cookie: `B1SESSION=${sessionId}`,
                },
            }
        );

        console.log("Delivery note created successfully in SAP B1");
        console.log("SAP Response:", {
            DocEntry: response.data.DocEntry,
            DocNum: response.data.DocNum,
            CardCode: response.data.CardCode,
        });

        return response.data;
    } catch (error) {
        console.error("Error creating delivery note in SAP B1:", error.message);
        if (error.response) {
            console.error("SAP Error details:", error.response.data);

            if (
                error.response.data &&
                error.response.data.error &&
                error.response.data.error.message
            ) {
                console.error(
                    "Error field details:",
                    error.response.data.error.message.value
                );
            }
        }

        // If unauthorized, try to login again and retry once
        if (error.response && error.response.status === 401) {
            console.log("Session expired, attempting to login again...");
            sessionId = null;
            await getSessionId();
            return exports.createDeliveryNoteInSAP(deliveryNoteData);
        }

        throw new Error(`SAP Error: ${error.message}`);
    }
};

// Live sync delivery notes with SAP - NOW USES STATUS SYNC
exports.liveSyncDeliveryNotesWithSAP = async (req, res) => {
    try {
        console.log("\n" + "=".repeat(60));
        console.log("STARTING LIVE SYNC: DELIVERY NOTES (Using Status Sync)");
        console.log("=".repeat(60));

        // Simply call the status sync function
        return await exports.syncDeliveryNoteStatusesFromSAP(req, res);
    } catch (error) {
        console.error("Error in live sync:", error);
        res.status(500).json({
            success: false,
            message: "Error during live sync",
            error: error.message,
        });
    }
};

// Get a delivery note from SAP B1 by DocEntry
exports.getDeliveryNoteFromSAP = async (docEntry) => {
    try {
        const sessionId = await getSessionId();

        console.log(`Fetching delivery note ${docEntry} from SAP B1...`);

        const response = await axios.get(
            `${SAP_CONFIG.serviceLayerUrl}/DeliveryNotes(${docEntry})`,
            {
                headers: {
                    "Content-Type": "application/json",
                    Cookie: `B1SESSION=${sessionId}`,
                },
            }
        );

        console.log("Delivery note fetched successfully from SAP B1");
        return response.data;
    } catch (error) {
        console.error("Error fetching delivery note from SAP B1:", error.message);

        // If unauthorized, try to login again and retry once
        if (error.response && error.response.status === 401) {
            console.log("Session expired, attempting to login again...");
            sessionId = null;
            await getSessionId();
            return exports.getDeliveryNoteFromSAP(docEntry);
        }

        throw new Error(`SAP Error: ${error.message}`);
    }
};

// Sync delivery note statuses from SAP - Sync statuses based on open DNs in SAP
// Sync delivery note statuses from SAP - Sync statuses based on open DNs in SAP
exports.syncDeliveryNoteStatusesFromSAP = async (req, res) => {
    try {
        console.log("\n" + "=".repeat(60));
        console.log("STARTING DELIVERY NOTE STATUS SYNC FROM SAP");
        console.log("=".repeat(60));

        const { loginToSAP } = require("../utils/sapB1Integration");
        const axios = require("axios");
        const dotenv = require("dotenv");
        dotenv.config();

        const SAP_CONFIG = {
            serviceLayerUrl: process.env.SAP_SERVICE_LAYER_URL,
            companyDB: process.env.COMPANY_DB,
            username: process.env.USER_NAME,
            password: process.env.PASSWORD,
        };

        // Login to SAP
        const sessionId = await loginToSAP();
        const headers = {
            "Content-Type": "application/json",
            Cookie: `B1SESSION=${sessionId}`,
        };

        // *** FETCH ONLY OPEN DELIVERY NOTES FROM SAP ***
        let openDNsInSAP = [];
        let totalFetched = 0;

        // Fetch OPEN delivery notes from SAP
        let nextLink = `${SAP_CONFIG.serviceLayerUrl}/DeliveryNotes?$filter=DocumentStatus eq 'bost_Open'&$orderby=DocNum`;

        console.log("Fetching open delivery notes from SAP...");

        while (nextLink) {
            try {
                console.log(`Fetching batch from SAP...`);
                const response = await axios.get(nextLink, { headers });

                const currentBatch = response.data.value;
                console.log(`Fetched ${currentBatch.length} delivery notes in this batch`);

                // Store full delivery note details
                openDNsInSAP.push(...currentBatch);
                totalFetched += currentBatch.length;

                console.log(`Total open delivery notes fetched so far: ${totalFetched}`);

                // Get next link for pagination
                nextLink = response.data["odata.nextLink"];

                if (nextLink && nextLink.startsWith("DeliveryNotes")) {
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

        console.log(`\nTotal OPEN delivery notes in SAP: ${openDNsInSAP.length}`);

        const sapOpenDocNums = openDNsInSAP.map(dn => dn.DocNum);
        console.log("Sample open DocNums in SAP:", sapOpenDocNums.slice(0, 20), "...");

        // Find ALL delivery notes in local DB BEFORE any changes
        const allLocalDNs = await DeliveryNote.find({})
            .select("DocNum DocumentStatus CardCode CardName BaseEntry OriginatingOrder DocTotal DocCurrency");

        console.log(`\nTotal delivery notes in local DB: ${allLocalDNs.length}`);

        // Separate local DNs by status BEFORE any changes
        const localOpenDNs = allLocalDNs.filter(dn =>
            dn.DocumentStatus === 'bost_Open' || dn.DocumentStatus === 'O'
        );
        const localClosedDNs = allLocalDNs.filter(dn =>
            dn.DocumentStatus === 'bost_Close' || dn.DocumentStatus === 'C'
        );

        console.log(`Open locally (BEFORE): ${localOpenDNs.length}`);
        console.log(`Closed locally (BEFORE): ${localClosedDNs.length}`);

        const localOpenDocNums = localOpenDNs.map(dn => dn.DocNum);
        const allLocalDocNums = allLocalDNs.map(dn => dn.DocNum);

        // Store INITIAL counts
        const initialOpenCount = localOpenDNs.length;
        const initialClosedCount = localClosedDNs.length;

        const results = {
            totalOpenInSAP: openDNsInSAP.length,
            totalInLocalDB: allLocalDNs.length,
            openInLocal: initialOpenCount,
            closedInLocal: initialClosedCount,
            dnsClosed: 0,
            dnsOpened: 0,
            dnsCreated: 0,
            errors: [],
            closedDNs: [],
            openedDNs: [],
            createdDNs: [],
        };

        // *** 1. CLOSE DNs that are OPEN locally but NOT in SAP's open list ***
        const dnsToClose = localOpenDNs.filter(dn => !sapOpenDocNums.includes(dn.DocNum));

        console.log(`\n🔍 FULL DEBUG:`);
        console.log(`Total SAP DocNums: ${sapOpenDocNums.length}`);
        console.log(`Total Local DocNums: ${localOpenDocNums.length}`);
        console.log(`ALL SAP DocNums:`, sapOpenDocNums.sort((a, b) => a - b));
        console.log(`ALL Local DocNums:`, localOpenDocNums.sort((a, b) => a - b));

        // Find the difference
        const localNotInSAP = localOpenDocNums.filter(docNum => !sapOpenDocNums.includes(docNum));
        console.log(`\n❌ Local DocNums NOT in SAP (should be 3):`, localNotInSAP);

        // Check if those 3 are actually in SAP
        localNotInSAP.forEach(docNum => {
            const inSAP = sapOpenDocNums.includes(docNum);
            console.log(`DocNum ${docNum}: In SAP? ${inSAP}`);
        });
        // Check which local DNs are NOT in SAP
        const notInSAP = localOpenDocNums.filter(docNum => !sapOpenDocNums.includes(docNum));
        console.log(`\n🔍 Local DocNums NOT in SAP open list (${notInSAP.length}):`, notInSAP);

        // Check if it's a type mismatch issue
        const sapSet = new Set(sapOpenDocNums.map(n => String(n)));
        const localNotInSAPStrings = localOpenDocNums.filter(docNum => !sapSet.has(String(docNum)));
        console.log(`\n🔍 Using String comparison (${localNotInSAPStrings.length}):`, localNotInSAPStrings);

        console.log(`\nDelivery notes to CLOSE (open locally, NOT in SAP open list): ${dnsToClose.length}`);
        if (dnsToClose.length > 0) {
            console.log(`DocNums to close:`, dnsToClose.map(dn => dn.DocNum));
        }

        for (const dn of dnsToClose) {
            try {
                console.log(`Closing delivery note DocNum: ${dn.DocNum} (${dn.CardCode})`);

                dn.DocumentStatus = "bost_Close";
                dn.UpdateDate = new Date();
                dn.LocalStatus = "Synced";
                dn.U_Notes = (dn.U_Notes || "") + ` [Auto-closed via status sync on ${new Date().toISOString()}]`;

                await dn.save();

                results.dnsClosed++;
                results.closedDNs.push({
                    DocNum: dn.DocNum,
                    CardCode: dn.CardCode,
                    CardName: dn.CardName,
                });

                console.log(`✅ Delivery note ${dn.DocNum} closed successfully`);

            } catch (error) {
                console.error(`❌ Error closing delivery note ${dn.DocNum}:`, error.message);
                results.errors.push({
                    DocNum: dn.DocNum,
                    action: "close",
                    error: error.message,
                });
            }
        }

        // *** 2. OPEN DNs that are CLOSED locally but in SAP's open list ***
        const dnsToOpen = localClosedDNs.filter(dn => sapOpenDocNums.includes(dn.DocNum));

        console.log(`\nDelivery notes to OPEN (closed locally, IN SAP open list): ${dnsToOpen.length}`);
        if (dnsToOpen.length > 0) {
            console.log(`DocNums to open:`, dnsToOpen.map(dn => dn.DocNum));
        }

        for (const dn of dnsToOpen) {
            try {
                console.log(`Opening delivery note DocNum: ${dn.DocNum} (${dn.CardCode})`);

                dn.DocumentStatus = "bost_Open";
                dn.UpdateDate = new Date();
                dn.LocalStatus = "Synced";
                dn.U_Notes = (dn.U_Notes || "") + ` [Auto-opened via status sync on ${new Date().toISOString()}]`;

                await dn.save();

                results.dnsOpened++;
                results.openedDNs.push({
                    DocNum: dn.DocNum,
                    CardCode: dn.CardCode,
                    CardName: dn.CardName,
                });

                console.log(`✅ Delivery note ${dn.DocNum} opened successfully`);

            } catch (error) {
                console.error(`❌ Error opening delivery note ${dn.DocNum}:`, error.message);
                results.errors.push({
                    DocNum: dn.DocNum,
                    action: "open",
                    error: error.message,
                });
            }
        }

        // *** 3. CREATE DNs that are in SAP's open list but NOT locally ***
        const missingDNDocNums = sapOpenDocNums.filter(docNum => !allLocalDocNums.includes(docNum));

        console.log(`\nMissing delivery notes to CREATE: ${missingDNDocNums.length}`);
        if (missingDNDocNums.length > 0) {
            console.log(`DocNums to create:`, missingDNDocNums);
        }

        for (const docNum of missingDNDocNums) {
            try {
                // Find the full delivery note details from our SAP data
                const sapDN = openDNsInSAP.find(dn => dn.DocNum === docNum);

                if (!sapDN) {
                    console.log(`⚠️ Could not find details for DocNum ${docNum}`);
                    continue;
                }

                console.log(`Creating missing delivery note DocNum: ${sapDN.DocNum} (${sapDN.CardCode})`);

                // Create the delivery note in local DB
                const newDN = new DeliveryNote({
                    DocEntry: sapDN.DocEntry,
                    DocNum: sapDN.DocNum,
                    DocType: sapDN.DocObjectCode || "dDocument_Items",
                    CardCode: sapDN.CardCode,
                    CardName: sapDN.CardName,
                    Address: sapDN.Address,
                    Address2: sapDN.Address2,
                    DocDate: sapDN.DocDate,
                    DocDueDate: sapDN.DocDueDate,
                    TaxDate: sapDN.TaxDate,
                    CreationDate: sapDN.CreationDate || new Date(),
                    UpdateDate: new Date(),
                    DocTotal: sapDN.DocTotal,
                    DocCurrency: sapDN.DocCurrency || "EUR",
                    VatSum: sapDN.VatSum,
                    DiscountPercent: sapDN.DiscountPercent,
                    PriceList: sapDN.PriceList,

                    // Base references
                    BaseType: sapDN.BaseType,
                    BaseEntry: sapDN.BaseEntry,
                    OriginatingOrder: sapDN.U_SourceOrderNum || null,

                    // Document lines with base references
                    DocumentLines: sapDN.DocumentLines?.map((line, index) => ({
                        LineNum: line.LineNum || index,
                        ItemCode: line.ItemCode,
                        ItemDescription: line.ItemDescription,
                        Quantity: line.Quantity,
                        Price: line.Price || line.UnitPrice,
                        UnitPrice: line.Price || line.UnitPrice,
                        PriceAfterVAT: line.PriceAfterVAT,
                        Currency: line.Currency || sapDN.DocCurrency,
                        LineTotal: line.LineTotal,
                        VatGroup: line.VatGroup,
                        PriceList: line.PriceList || sapDN.PriceList,

                        // Base references for lines
                        BaseType: line.BaseType,
                        BaseEntry: line.BaseEntry,
                        BaseLine: line.BaseLine,

                        ShipDate: line.ShipDate,
                        ActualDeliveryDate: line.ActualDeliveryDate,
                    })) || [],

                    DocumentStatus: "bost_Open",
                    Cancelled: sapDN.Cancelled || "N",
                    SyncedWithSAP: true,
                    SAPDocEntry: sapDN.DocEntry,
                    LocalStatus: "Synced",
                    ImportDate: new Date(),
                    ImportSource: "Status_Sync",
                    Comments: sapDN.Comments || "",
                    U_Notes: "Imported via Status Sync from SAP B1 - Missing Open Delivery Note",
                });

                await newDN.save();

                results.dnsCreated++;
                results.createdDNs.push({
                    DocNum: sapDN.DocNum,
                    CardCode: sapDN.CardCode,
                    CardName: sapDN.CardName,
                    DocTotal: sapDN.DocTotal,
                });

                console.log(`✅ Delivery note ${sapDN.DocNum} created successfully`);

            } catch (error) {
                console.error(`❌ Error creating delivery note ${docNum}:`, error.message);
                results.errors.push({
                    DocNum: docNum,
                    action: "create",
                    error: error.message,
                });
            }
        }

        // *** CALCULATE FINAL COUNTS USING INITIAL VALUES ***
        const finalLocalOpenCount = initialOpenCount - results.dnsClosed + results.dnsOpened + results.dnsCreated;
        const finalLocalClosedCount = initialClosedCount + results.dnsClosed - results.dnsOpened;

        console.log("\n" + "=".repeat(60));
        console.log("DELIVERY NOTE STATUS SYNC COMPLETED");
        console.log(`Open in SAP: ${results.totalOpenInSAP}`);
        console.log(`Open in Local (before): ${results.openInLocal}`);
        console.log(`Closed in Local (before): ${results.closedInLocal}`);
        console.log(`Actions taken:`);
        console.log(`  - Closed: ${results.dnsClosed}`);
        console.log(`  - Opened: ${results.dnsOpened}`);
        console.log(`  - Created: ${results.dnsCreated}`);
        console.log(`Calculation: ${results.openInLocal} - ${results.dnsClosed} + ${results.dnsOpened} + ${results.dnsCreated} = ${finalLocalOpenCount}`);
        console.log(`Open in Local (after): ${finalLocalOpenCount}`);
        console.log(`Closed in Local (after): ${finalLocalClosedCount}`);
        console.log(`Errors: ${results.errors.length}`);
        console.log(`MATCHED: ${finalLocalOpenCount === results.totalOpenInSAP ? '✅ YES' : '❌ NO'}`);
        console.log("=".repeat(60) + "\n");

        res.status(200).json({
            success: true,
            message: `Status sync completed. ${results.dnsClosed} closed, ${results.dnsOpened} opened, ${results.dnsCreated} created.`,
            data: {
                ...results,
                finalLocalOpenCount,
                finalLocalClosedCount,
                matched: finalLocalOpenCount === results.totalOpenInSAP,
            },
        });

    } catch (error) {
        console.error("Error in syncDeliveryNoteStatusesFromSAP:", error);
        res.status(500).json({
            success: false,
            message: "Error syncing delivery note statuses from SAP",
            error: error.message,
        });
    }
};