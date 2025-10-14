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

        // Include price list if available
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

                // Include price list for each line
                PriceList: line.PriceList
                    ? parseInt(line.PriceList, 10)
                    : deliveryNote.PriceList
                        ? parseInt(deliveryNote.PriceList, 10)
                        : 2,

                // ✅ DO NOT include BaseType, BaseEntry, BaseLine
                // This creates a standalone delivery note

                LineNum: index,
            };

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
            BaseEntry: salesOrder.DocEntry
        });

        if (existingDeliveryNote) {
            return res.status(400).json({
                success: false,
                message: "Delivery note already exists for this order",
                data: existingDeliveryNote,
            });
        }

        // *** UPDATED DOCNUM GENERATION FOR DELIVERY NOTES ***
        // Try to get the next DocNum from SAP first
        let newDocNum;
        let newDocEntry;

        try {
            // Import the function
            const { getNextDeliveryNoteDocNumFromSAP } = require("../utils/sapB1Integration");
            newDocNum = await getNextDeliveryNoteDocNumFromSAP();

            if (newDocNum) {
                console.log(`Using SAP-aligned Delivery Note DocNum: ${newDocNum}`);
                newDocEntry = newDocNum; // Use the same number for both
            } else {
                throw new Error("Could not get DocNum from SAP");
            }
        } catch (sapError) {
            console.warn(
                "Could not get Delivery Note DocNum from SAP, falling back to local generation:",
                sapError.message
            );

            // Fallback to local DocEntry generation
            const lastDeliveryNote = await DeliveryNote.findOne().sort({ DocEntry: -1 });
            newDocEntry = lastDeliveryNote ? lastDeliveryNote.DocEntry + 1 : 1;
            newDocNum = newDocEntry;

            console.log(`Using local Delivery Note DocNum: ${newDocNum}`);
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

        // Create delivery note from order
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

            // Reference to source order - USE SAP DOCENTRY
            BaseType: 17, // Sales Order
            BaseEntry: salesOrder.SAPDocEntry, // *** USE SAP DOCENTRY, NOT LOCAL ***
            OriginatingOrder: salesOrder.DocNum, // Keep local DocNum for reference

            // Document lines - map from order
            DocumentLines: salesOrder.DocumentLines.map((line, index) => ({
                ...line.toObject(),
                LineNum: index,
                BaseType: 17,
                BaseEntry: salesOrder.DocEntry,
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
        const { orderDocNums, autoSync = false } = req.body;

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

                // *** CRITICAL: Check if sales order is synced with SAP ***
                if (!salesOrder.SyncedWithSAP || !salesOrder.SAPDocEntry) {
                    results.failed.push({
                        docEntry,
                        orderNum: salesOrder.DocNum,
                        error: "Sales order not synced with SAP. Cannot create delivery note.",
                        synced: salesOrder.SyncedWithSAP,
                        sapDocEntry: salesOrder.SAPDocEntry
                    });
                    continue;
                }

                // Check if delivery note already exists - check by SAP DocEntry
                const existingDeliveryNote = await DeliveryNote.findOne({
                    BaseEntry: salesOrder.SAPDocEntry // *** USE SAP DOCENTRY ***
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

                // *** UPDATED DOCNUM GENERATION FOR DELIVERY NOTES ***
                // Try to get the next DocNum from SAP first
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
                    console.warn(
                        "Could not get Delivery Note DocNum from SAP, falling back to local generation:",
                        sapError.message
                    );

                    const lastDeliveryNote = await DeliveryNote.findOne().sort({ DocEntry: -1 });
                    newDocEntry = lastDeliveryNote ? lastDeliveryNote.DocEntry + 1 : 1;
                    newDocNum = newDocEntry;

                    console.log(`Using local Delivery Note DocNum: ${newDocNum}`);
                }

                // Create delivery note
                // Create delivery note
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
                    BaseType: 17,
                    BaseEntry: salesOrder.SAPDocEntry, // *** USE SAP DOCENTRY ***
                    OriginatingOrder: salesOrder.DocNum, // Keep local DocNum for reference
                    DocumentLines: salesOrder.DocumentLines.map((line, index) => ({
                        ...line.toObject(),
                        LineNum: index,
                        BaseType: 17,
                        BaseEntry: salesOrder.DocEntry,
                        BaseLine: line.LineNum,
                        ShipDate: new Date(),
                        ActualDeliveryDate: new Date(),
                    })),
                    DocumentStatus: "bost_Open",
                    SyncedWithSAP: false,
                    LocalStatus: "Created",
                    salesAgent: salesOrder.salesAgent,
                    Comments: `Delivery note for order #${salesOrder.DocNum}`,
                    U_Notes: salesOrder.U_Notes || "",
                });

                await deliveryNote.save();

                results.successful.push({
                    docEntry: newDocEntry,
                    docNum: newDocEntry,
                    orderDocEntry: salesOrder.DocEntry,
                    orderNum: salesOrder.DocNum,
                    cardCode: salesOrder.CardCode,
                });

                console.log(`✅ Created delivery note ${newDocEntry} for order ${salesOrder.DocNum}`);

            } catch (error) {
                console.error(`❌ Error processing order ${docEntry}:`, error);
                results.failed.push({
                    docEntry,
                    error: error.message,
                });
            }
        }

        // If autoSync is enabled, start background sync (don't wait for it)
        if (autoSync && results.successful.length > 0) {
            const deliveryNoteIds = results.successful.map(r => r.docEntry);

            // Start background sync - don't await
            setImmediate(async () => {
                try {
                    console.log("Starting background SAP sync for delivery notes...");
                    await exports.bulkPushDeliveryNotesToSAP({
                        body: { deliveryNoteDocEntries: deliveryNoteIds }
                    }, {
                        status: () => ({ json: () => { } }) // Mock response 
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

// Get all delivery notes with filters
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