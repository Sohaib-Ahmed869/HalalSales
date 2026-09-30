// controllers/invoiceSync.controller.js
const Invoice = require("../models/Invoice");
const Customer = require("../models/Customer");
const FlattenedPayment = require("../models/FlattenedPayment");
const SyncMetadata = require("../models/SyncMetadata");
const axios = require("axios");

const SAP_CONFIG = {
    serviceLayerUrl: process.env.SAP_SERVICE_LAYER_URL,
    companyDB: process.env.COMPANY_DB,
    username: process.env.USER_NAME,
    password: process.env.PASSWORD,
};

/**
 * Comprehensive workflow to fix duplicate DocEntry errors
 * 
 * Workflow:
 * 1. For each errorDocNum, fetch its correct DocEntry from SAP
 * 2. Check if local invoice has same DocEntry as SAP (if same, skip - no issue)
 * 3. If different, identify which other invoice is occupying that DocEntry
 * 4. Update the errorDocNum invoice with correct DocEntry from SAP
 * 5. Track all conflicts and resolutions
 */
exports.fixDuplicateDocEntries = async (req, res) => {
    try {
        console.log("\n" + "=".repeat(80));
        console.log("COMPREHENSIVE DUPLICATE DOCENTRY FIX WORKFLOW");
        console.log("=".repeat(80));

        const { loginToSAP } = require("../utils/sapB1Integration");

        // Login to SAP
        const sessionId = await loginToSAP();
        const headers = {
            "Content-Type": "application/json",
            Cookie: `B1SESSION=${sessionId}`,
        };

        // Extract DocNums from request body
        const { docNums } = req.body;

        if (!docNums || !Array.isArray(docNums) || docNums.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Please provide an array of DocNums to fix",
                example: { docNums: [148097, 174084, 185298] }
            });
        }

        console.log(`\n📊 Processing ${docNums.length} invoices with duplicate DocEntry errors...\n`);

        const results = {
            total: docNums.length,
            processed: 0,
            sameDocEntry: 0,        // DocEntry matches SAP - no issue
            differentDocEntry: 0,   // DocEntry differs from SAP - needs update
            conflicts: 0,            // DocEntry occupied by another invoice
            fixed: 0,                // Successfully updated
            created: 0,              // Created new invoice
            notFoundInSAP: 0,       // Not found in SAP
            notFoundLocally: 0,     // Not found in local DB
            errors: [],

            detailedResults: [],
            conflictDetails: [],
            fixedInvoices: [],
            notFound: [],
        };

        // Process each DocNum
        for (const docNum of docNums) {
            try {
                console.log(`\n${"─".repeat(80)}`);
                console.log(`📋 STEP 1: Processing DocNum: ${docNum}`);
                console.log(`${"─".repeat(80)}`);

                // STEP 1: Fetch invoice from SAP by DocNum
                const sapUrl = `${SAP_CONFIG.serviceLayerUrl}/Invoices?$filter=DocNum eq ${docNum}`;
                console.log(`🔍 Fetching from SAP: DocNum ${docNum}...`);

                const sapResponse = await axios.get(sapUrl, { headers });

                if (!sapResponse.data.value || sapResponse.data.value.length === 0) {
                    console.log(`❌ Invoice ${docNum} NOT FOUND in SAP`);
                    results.notFoundInSAP++;
                    results.notFound.push({
                        DocNum: docNum,
                        location: "SAP",
                        issue: "Invoice not found in SAP"
                    });
                    continue;
                }

                const sapInvoice = sapResponse.data.value[0];
                const correctDocEntry = sapInvoice.DocEntry;

                console.log(`✅ Found in SAP:`);
                console.log(`   DocNum: ${sapInvoice.DocNum}`);
                console.log(`   Correct DocEntry (from SAP): ${correctDocEntry}`);
                console.log(`   CardCode: ${sapInvoice.CardCode}`);
                console.log(`   Total: ${sapInvoice.DocTotal}`);

                // STEP 2: Check if invoice exists locally by DocNum
                console.log(`\n📋 STEP 2: Checking local database for DocNum ${docNum}...`);
                const localInvoiceByDocNum = await Invoice.findOne({ DocNum: docNum });

                if (!localInvoiceByDocNum) {
                    console.log(`⚠️ Invoice ${docNum} NOT FOUND in local database`);
                    console.log(`   Will create new invoice with correct DocEntry ${correctDocEntry}`);
                    results.notFoundLocally++;

                    // Create new invoice
                    await createInvoiceFromSAP(sapInvoice, results);
                    continue;
                }

                const currentLocalDocEntry = localInvoiceByDocNum.DocEntry;
                console.log(`✅ Found locally:`);
                console.log(`   DocNum: ${localInvoiceByDocNum.DocNum}`);
                console.log(`   Current Local DocEntry: ${currentLocalDocEntry}`);
                console.log(`   CardCode: ${localInvoiceByDocNum.CardCode}`);

                // STEP 3: Compare DocEntry - if same, no issue
                console.log(`\n📋 STEP 3: Comparing DocEntry values...`);
                console.log(`   SAP DocEntry:   ${correctDocEntry}`);
                console.log(`   Local DocEntry: ${currentLocalDocEntry}`);

                if (currentLocalDocEntry === correctDocEntry) {
                    console.log(`✅ MATCH! DocEntry is already correct. No update needed.`);
                    results.sameDocEntry++;
                    results.detailedResults.push({
                        DocNum: docNum,
                        status: "same_docentry",
                        localDocEntry: currentLocalDocEntry,
                        sapDocEntry: correctDocEntry,
                        message: "DocEntry matches SAP - no issue"
                    });
                    continue;
                }

                console.log(`⚠️ MISMATCH DETECTED!`);
                console.log(`   Current: ${currentLocalDocEntry}`);
                console.log(`   Should be: ${correctDocEntry}`);
                results.differentDocEntry++;

                // STEP 4: Check if the correct DocEntry is occupied by another invoice
                console.log(`\n📋 STEP 4: Checking if DocEntry ${correctDocEntry} is occupied by another invoice...`);
                const occupyingInvoice = await Invoice.findOne({ DocEntry: correctDocEntry });

                if (occupyingInvoice && occupyingInvoice.DocNum !== docNum) {
                    console.log(`🚨 CONFLICT DETECTED!`);
                    console.log(`   DocEntry ${correctDocEntry} is currently used by:`);
                    console.log(`   - DocNum: ${occupyingInvoice.DocNum}`);
                    console.log(`   - CardCode: ${occupyingInvoice.CardCode}`);
                    console.log(`   - CardName: ${occupyingInvoice.CardName}`);

                    results.conflicts++;

                    // STEP 5: Get the occupying invoice's correct DocEntry from SAP
                    console.log(`\n📋 STEP 5: Fetching correct DocEntry for occupying invoice ${occupyingInvoice.DocNum} from SAP...`);

                    const occupyingSapUrl = `${SAP_CONFIG.serviceLayerUrl}/Invoices?$filter=DocNum eq ${occupyingInvoice.DocNum}`;
                    const occupyingSapResponse = await axios.get(occupyingSapUrl, { headers });

                    let occupyingCorrectDocEntry = null;

                    if (occupyingSapResponse.data.value && occupyingSapResponse.data.value.length > 0) {
                        occupyingCorrectDocEntry = occupyingSapResponse.data.value[0].DocEntry;
                        console.log(`✅ Occupying invoice's correct DocEntry from SAP: ${occupyingCorrectDocEntry}`);
                    } else {
                        console.log(`❌ Occupying invoice ${occupyingInvoice.DocNum} not found in SAP`);
                    }

                    results.conflictDetails.push({
                        errorDocNum: docNum,
                        errorInvoiceCurrentDocEntry: currentLocalDocEntry,
                        errorInvoiceCorrectDocEntry: correctDocEntry,
                        occupyingInvoiceDocNum: occupyingInvoice.DocNum,
                        occupyingInvoiceCurrentDocEntry: occupyingInvoice.DocEntry,
                        occupyingInvoiceCorrectDocEntry: occupyingCorrectDocEntry,
                        occupyingInvoiceCardCode: occupyingInvoice.CardCode,
                        occupyingInvoiceCardName: occupyingInvoice.CardName,
                    });

                    // Update occupying invoice first if we found its correct DocEntry
                    if (occupyingCorrectDocEntry && occupyingCorrectDocEntry !== occupyingInvoice.DocEntry) {
                        console.log(`\n🔄 Updating occupying invoice ${occupyingInvoice.DocNum}...`);
                        console.log(`   Old DocEntry: ${occupyingInvoice.DocEntry}`);
                        console.log(`   New DocEntry: ${occupyingCorrectDocEntry}`);

                        occupyingInvoice.DocEntry = occupyingCorrectDocEntry;
                        occupyingInvoice.SAPDocEntry = occupyingCorrectDocEntry;
                        occupyingInvoice.UpdateDate = new Date();
                        occupyingInvoice.U_Notes = (occupyingInvoice.U_Notes || "") +
                            ` [DocEntry corrected from ${occupyingInvoice.DocEntry} to ${occupyingCorrectDocEntry} on ${new Date().toISOString()}]`;

                        await occupyingInvoice.save();
                        console.log(`✅ Occupying invoice updated successfully`);
                    }
                } else {
                    console.log(`✅ No conflict - DocEntry ${correctDocEntry} is available`);
                }

                // STEP 6: Update the error invoice with correct DocEntry
                console.log(`\n📋 STEP 6: Updating invoice ${docNum} with correct DocEntry...`);
                console.log(`   Old DocEntry: ${currentLocalDocEntry}`);
                console.log(`   New DocEntry: ${correctDocEntry}`);

                localInvoiceByDocNum.DocEntry = correctDocEntry;
                localInvoiceByDocNum.SAPDocEntry = correctDocEntry;
                localInvoiceByDocNum.UpdateDate = new Date();
                localInvoiceByDocNum.LocalStatus = "Synced";

                // Update other fields from SAP to ensure data is fresh
                localInvoiceByDocNum.DocTotal = sapInvoice.DocTotal;
                localInvoiceByDocNum.VatSum = sapInvoice.VatSum;
                localInvoiceByDocNum.PaidToDate = sapInvoice.PaidToDate || 0;
                localInvoiceByDocNum.DocumentStatus = sapInvoice.DocumentStatus || "bost_Open";
                localInvoiceByDocNum.CardCode = sapInvoice.CardCode;
                localInvoiceByDocNum.CardName = sapInvoice.CardName;
                localInvoiceByDocNum.DocDate = sapInvoice.DocDate;
                localInvoiceByDocNum.DocDueDate = sapInvoice.DocDueDate;

                // Add note about the fix
                localInvoiceByDocNum.U_Notes = (localInvoiceByDocNum.U_Notes || "") +
                    ` [DocEntry corrected from ${currentLocalDocEntry} to ${correctDocEntry} on ${new Date().toISOString()}]`;

                await localInvoiceByDocNum.save();

                results.fixed++;
                results.fixedInvoices.push({
                    DocNum: docNum,
                    oldDocEntry: currentLocalDocEntry,
                    newDocEntry: correctDocEntry,
                    CardCode: sapInvoice.CardCode,
                    CardName: sapInvoice.CardName,
                    status: "updated",
                });

                console.log(`✅ Successfully updated DocNum ${docNum} with correct DocEntry ${correctDocEntry}`);

                results.detailedResults.push({
                    DocNum: docNum,
                    status: "fixed",
                    oldDocEntry: currentLocalDocEntry,
                    newDocEntry: correctDocEntry,
                    hadConflict: occupyingInvoice ? true : false,
                    message: "DocEntry updated successfully"
                });

                results.processed++;

            } catch (error) {
                console.error(`❌ Error processing DocNum ${docNum}:`, error.message);
                results.errors.push({
                    DocNum: docNum,
                    error: error.message,
                    stack: error.stack,
                });
            }

            // Small delay to avoid overwhelming SAP
            await new Promise(resolve => setTimeout(resolve, 300));
        }

        // Final Summary
        console.log("\n" + "=".repeat(80));
        console.log("DUPLICATE DOCENTRY FIX COMPLETED");
        console.log("=".repeat(80));
        console.log(`📊 SUMMARY:`);
        console.log(`   Total Invoices Processed: ${results.total}`);
        console.log(`   ✅ Same DocEntry (no issue): ${results.sameDocEntry}`);
        console.log(`   ⚠️  Different DocEntry (needed fix): ${results.differentDocEntry}`);
        console.log(`   🚨 Conflicts Found: ${results.conflicts}`);
        console.log(`   🔧 Successfully Fixed: ${results.fixed}`);
        console.log(`   ➕ Created New: ${results.created}`);
        console.log(`   ❌ Not Found in SAP: ${results.notFoundInSAP}`);
        console.log(`   ❌ Not Found Locally: ${results.notFoundLocally}`);
        console.log(`   ⚠️  Errors: ${results.errors.length}`);
        console.log("=".repeat(80) + "\n");

        if (results.conflictDetails.length > 0) {
            console.log("\n🚨 CONFLICT DETAILS:");
            console.log("=".repeat(80));
            results.conflictDetails.forEach((conflict, index) => {
                console.log(`\nConflict #${index + 1}:`);
                console.log(`  Error Invoice DocNum: ${conflict.errorDocNum}`);
                console.log(`    - Current DocEntry: ${conflict.errorInvoiceCurrentDocEntry}`);
                console.log(`    - Correct DocEntry: ${conflict.errorInvoiceCorrectDocEntry}`);
                console.log(`  Occupying Invoice DocNum: ${conflict.occupyingInvoiceDocNum}`);
                console.log(`    - Current DocEntry: ${conflict.occupyingInvoiceCurrentDocEntry}`);
                console.log(`    - Correct DocEntry: ${conflict.occupyingInvoiceCorrectDocEntry || 'Not found in SAP'}`);
                console.log(`    - Customer: ${conflict.occupyingInvoiceCardCode} - ${conflict.occupyingInvoiceCardName}`);
            });
            console.log("=".repeat(80));
        }

        res.status(200).json({
            success: true,
            message: `DocEntry fix completed. ${results.fixed} updated, ${results.created} created, ${results.sameDocEntry} already correct.`,
            summary: {
                total: results.total,
                sameDocEntry: results.sameDocEntry,
                differentDocEntry: results.differentDocEntry,
                conflicts: results.conflicts,
                fixed: results.fixed,
                created: results.created,
                notFoundInSAP: results.notFoundInSAP,
                notFoundLocally: results.notFoundLocally,
                errors: results.errors.length,
            },
            data: results,
        });

    } catch (error) {
        console.error("Error in fixDuplicateDocEntries:", error);
        res.status(500).json({
            success: false,
            message: "Error fixing duplicate DocEntry errors",
            error: error.message,
        });
    }
};

/**
 * Helper function to create invoice from SAP data
 */
async function createInvoiceFromSAP(sapInvoice, results) {
    try {
        console.log(`\n➕ Creating new invoice DocNum ${sapInvoice.DocNum} with DocEntry ${sapInvoice.DocEntry}`);

        const newInvoice = new Invoice({
            DocEntry: sapInvoice.DocEntry,
            DocNum: sapInvoice.DocNum,
            SAPDocEntry: sapInvoice.DocEntry,
            DocType: sapInvoice.DocObjectCode || "dDocument_Items",
            CardCode: sapInvoice.CardCode,
            CardName: sapInvoice.CardName,
            Address: sapInvoice.Address,
            DocDate: sapInvoice.DocDate,
            DocDueDate: sapInvoice.DocDueDate,
            CreationDate: sapInvoice.CreationDate || new Date(),
            UpdateDate: new Date(),
            DocTotal: sapInvoice.DocTotal,
            DocCurrency: sapInvoice.DocCurrency || "EUR",
            VatSum: sapInvoice.VatSum,
            PaidToDate: sapInvoice.PaidToDate || 0,
            DocumentLines: sapInvoice.DocumentLines?.map((line, index) => {
                const originalPrice = line.Price || line.UnitPrice || 0;
                const discountPercent = parseFloat(line.DiscountPercent) || 0;
                const effectivePrice = discountPercent >= 100 ? 0 : originalPrice * (1 - discountPercent / 100);

                return {
                    LineNum: line.LineNum || index,
                    ItemCode: line.ItemCode,
                    ItemDescription: line.ItemDescription,
                    Quantity: line.Quantity,
                    Price: effectivePrice,
                    OriginalPrice: originalPrice,
                    DiscountPercent: discountPercent,
                    PriceAfterVAT: line.PriceAfterVAT,
                    Currency: line.Currency || sapInvoice.DocCurrency,
                    LineTotal: line.LineTotal,
                    VatGroup: line.VatGroup,
                };
            }) || [],
            DocumentStatus: sapInvoice.DocumentStatus || "bost_Open",
            SyncedWithSAP: true,
            LocalStatus: "Synced",
            ImportDate: new Date(),
            ImportSource: "DocEntry_Fix_Creation",
            Comments: sapInvoice.Comments || "",
            U_Notes: `Created via DocEntry fix on ${new Date().toISOString()}`,

            // Payment tracking
            paymentStatus: sapInvoice.PaidToDate >= sapInvoice.DocTotal ? "Fully Paid" :
                sapInvoice.PaidToDate > 0 ? "Partially Paid" : "Unpaid",
            paymentTracking: {
                totalInvoiceAmount: sapInvoice.DocTotal,
                totalPaidAmount: sapInvoice.PaidToDate || 0,
                remainingBalance: sapInvoice.DocTotal - (sapInvoice.PaidToDate || 0),
            },
        });

        await newInvoice.save();

        results.created++;
        results.fixedInvoices.push({
            DocNum: sapInvoice.DocNum,
            DocEntry: sapInvoice.DocEntry,
            CardCode: sapInvoice.CardCode,
            CardName: sapInvoice.CardName,
            status: "created",
        });

        results.detailedResults.push({
            DocNum: sapInvoice.DocNum,
            status: "created",
            newDocEntry: sapInvoice.DocEntry,
            message: "Invoice created from SAP"
        });

        console.log(`✅ Successfully created invoice DocNum ${sapInvoice.DocNum}`);

    } catch (error) {
        console.error(`❌ Error creating invoice ${sapInvoice.DocNum}:`, error.message);
        results.errors.push({
            DocNum: sapInvoice.DocNum,
            action: "create",
            error: error.message,
        });
    }
}

/**
 * Live sync invoice statuses from SAP (optimized with bulk operations)
 */
/**
 * Live sync invoice statuses from SAP (optimized with bulk operations)
 */
/**
 * Live sync invoice statuses from SAP (optimized with bulk operations)
 */
exports.syncInvoiceStatusesFromSAP = async (req, res) => {
    try {
        console.log("\n" + "=".repeat(60));
        console.log("STARTING INVOICE STATUS SYNC FROM SAP");
        console.log("=".repeat(60));

        const { loginToSAP } = require("../utils/sapB1Integration");

        // Login to SAP
        const sessionId = await loginToSAP();
        const headers = {
            "Content-Type": "application/json",
            Cookie: `B1SESSION=${sessionId}`,
        };

        // Get last sync date
        let lastSyncMetadata = await SyncMetadata.findOne({ syncType: "invoice_status_sync" });
        let lastSyncDate = null;

        if (lastSyncMetadata && lastSyncMetadata.lastSyncDate) {
            lastSyncDate = new Date(lastSyncMetadata.lastSyncDate);
            // Subtract 1 day to ensure we don't miss any invoices
            lastSyncDate.setDate(lastSyncDate.getDate() - 1);
            console.log(`Last sync was performed on: ${new Date(lastSyncMetadata.lastSyncDate).toISOString()}`);
            console.log(`Will fetch invoices updated after: ${lastSyncDate.toISOString()} (1 day buffer)`);
        } else {
            console.log("No previous sync found. Performing full sync.");
        }

        let openInvoicesInSAP = [];
        let closedInvoicesInSAP = [];
        let totalFetched = 0;

        // STEP 1: Fetch OPEN invoices updated after last sync
        let sapOpenFilter = "DocumentStatus eq 'bost_Open'";
        if (lastSyncDate) {
            const formattedDate = lastSyncDate.toISOString().split('T')[0];
            sapOpenFilter += ` and UpdateDate ge '${formattedDate}'`;
            console.log(`Fetching OPEN invoices updated after: ${formattedDate}`);
        } else {
            console.log(`Fetching ALL open invoices (first sync)...`);
        }

        let nextLink = `${SAP_CONFIG.serviceLayerUrl}/Invoices?$filter=${sapOpenFilter}&$orderby=DocNum`;

        console.log("\n📂 Fetching updated OPEN invoices from SAP...");

        while (nextLink) {
            try {
                const response = await axios.get(nextLink, { headers });
                const currentBatch = response.data.value;
                console.log(`Fetched ${currentBatch.length} open invoices in this batch`);

                openInvoicesInSAP.push(...currentBatch);
                totalFetched += currentBatch.length;

                nextLink = response.data["odata.nextLink"];
                if (nextLink && nextLink.startsWith("Invoices")) {
                    nextLink = `${SAP_CONFIG.serviceLayerUrl}/${nextLink}`;
                }

                if (nextLink) {
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            } catch (error) {
                console.error("Error fetching open invoices from SAP:", error.message);
                if (error.response) {
                    console.error("SAP Error details:", error.response.data);
                }
                break;
            }
        }

        console.log(`✅ Total OPEN invoices fetched: ${openInvoicesInSAP.length}`);

        // STEP 2: Fetch CLOSED invoices updated after last sync (to detect closures)
        if (lastSyncDate) {
            const formattedDate = lastSyncDate.toISOString().split('T')[0];
            let sapClosedFilter = `DocumentStatus eq 'bost_Close' and UpdateDate ge '${formattedDate}'`;

            console.log(`\n📂 Fetching CLOSED invoices updated after: ${formattedDate}`);

            nextLink = `${SAP_CONFIG.serviceLayerUrl}/Invoices?$filter=${sapClosedFilter}&$orderby=DocNum`;

            while (nextLink) {
                try {
                    const response = await axios.get(nextLink, { headers });
                    const currentBatch = response.data.value;
                    console.log(`Fetched ${currentBatch.length} closed invoices in this batch`);

                    closedInvoicesInSAP.push(...currentBatch);

                    nextLink = response.data["odata.nextLink"];
                    if (nextLink && nextLink.startsWith("Invoices")) {
                        nextLink = `${SAP_CONFIG.serviceLayerUrl}/${nextLink}`;
                    }

                    if (nextLink) {
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                } catch (error) {
                    console.error("Error fetching closed invoices from SAP:", error.message);
                    if (error.response) {
                        console.error("SAP Error details:", error.response.data);
                    }
                    break;
                }
            }

            console.log(`✅ Total CLOSED invoices fetched: ${closedInvoicesInSAP.length}`);
        }

        const sapOpenDocNums = openInvoicesInSAP.map(inv => inv.DocNum);
        const sapClosedDocNums = closedInvoicesInSAP.map(inv => inv.DocNum);

        // Find all invoices marked as Open in local DB
        const localOpenInvoices = await Invoice.find({
            DocumentStatus: { $in: ["bost_Open", "O"] },
        }).select("DocNum DocEntry DocumentStatus CardCode CardName DocTotal VatSum PaidToDate SAPDocEntry DocumentLines Comments");

        console.log(`\nTotal open invoices in local DB: ${localOpenInvoices.length}`);

        const localOpenDocNums = localOpenInvoices.map(inv => inv.DocNum);

        // Create map of SAP invoices
        const sapInvoicesMap = {};
        openInvoicesInSAP.forEach(inv => {
            sapInvoicesMap[inv.DocNum] = inv;
        });

        // Find invoices to close - those that are in the closed list from SAP
        const invoicesToClose = localOpenInvoices.filter(
            inv => sapClosedDocNums.includes(inv.DocNum)
        );

        // Find invoices to update - those that are in the open list from SAP and exist locally
        const invoicesToUpdate = localOpenInvoices.filter(
            inv => sapOpenDocNums.includes(inv.DocNum)
        );

        // Find missing invoices to create (open in SAP but not in local DB)
        const missingInvoiceDocNums = sapOpenDocNums.filter(
            docNum => !localOpenDocNums.includes(docNum)
        );

        console.log(`\n📊 Analysis:`);
        console.log(`   Invoices to update: ${invoicesToUpdate.length}`);
        console.log(`   Invoices to close: ${invoicesToClose.length}`);
        console.log(`   Missing invoices to create: ${missingInvoiceDocNums.length}`);

        const results = {
            totalOpenInSAP: openInvoicesInSAP.length,
            totalClosedInSAP: closedInvoicesInSAP.length,
            totalOpenInLocalDB: localOpenInvoices.length,
            invoicesClosed: 0,
            invoicesCreated: 0,
            invoicesUpdated: 0,
            errors: [],
            closedInvoices: [],
            createdInvoices: [],
            updatedInvoices: [],
        };

        // STEP 1: Update existing open invoices in bulk
        console.log("\n🔄 Checking for updates in existing open invoices...");

        const bulkUpdateOps = [];
        const affectedCustomersSet = new Set();

        for (const localInvoice of invoicesToUpdate) {
            const sapInvoice = sapInvoicesMap[localInvoice.DocNum];

            if (!sapInvoice) {
                continue;
            }

            try {
                // Compare totals to detect changes
                const localTotal = parseFloat(localInvoice.DocTotal) || 0;
                const sapTotal = parseFloat(sapInvoice.DocTotal) || 0;
                const localVat = parseFloat(localInvoice.VatSum) || 0;
                const sapVat = parseFloat(sapInvoice.VatSum) || 0;
                const localPaid = parseFloat(localInvoice.PaidToDate) || 0;
                const sapPaid = parseFloat(sapInvoice.PaidToDate) || 0;

                let hasChanges = false;
                let changeDetails = [];

                // Check DocTotal change
                const totalDifference = Math.abs(localTotal - sapTotal);
                if (totalDifference > 0.01) {
                    hasChanges = true;
                    changeDetails.push(`DocTotal changed: ${localTotal} → ${sapTotal}`);
                }

                // Check VatSum change
                const vatDifference = Math.abs(localVat - sapVat);
                if (vatDifference > 0.01) {
                    hasChanges = true;
                    changeDetails.push(`VatSum changed: ${localVat} → ${sapVat}`);
                }

                // Check PaidToDate change (payment received)
                const paidDifference = Math.abs(localPaid - sapPaid);
                if (paidDifference > 0.01) {
                    hasChanges = true;
                    changeDetails.push(`PaidToDate changed: ${localPaid} → ${sapPaid}`);
                }

                // Check Comments change
                if (sapInvoice.Comments !== localInvoice.Comments) {
                    hasChanges = true;
                    changeDetails.push(`Comments changed`);
                }

                // Check for changes in document lines
                if (sapInvoice.DocumentLines && sapInvoice.DocumentLines.length > 0) {
                    const localLines = localInvoice.DocumentLines || [];
                    const sapLines = sapInvoice.DocumentLines;

                    if (localLines.length !== sapLines.length) {
                        hasChanges = true;
                        changeDetails.push(`Line count changed: ${localLines.length} → ${sapLines.length}`);
                    } else {
                        for (let i = 0; i < sapLines.length; i++) {
                            const sapLine = sapLines[i];
                            const localLine = localLines.find(l => l.LineNum === sapLine.LineNum) || localLines[i];

                            if (!localLine) {
                                hasChanges = true;
                                changeDetails.push(`New line added: ${sapLine.ItemCode}`);
                                continue;
                            }

                            if (localLine.ItemCode !== sapLine.ItemCode) {
                                hasChanges = true;
                                changeDetails.push(`Line ${sapLine.LineNum || i}: Item changed`);
                            }

                            const localQty = parseFloat(localLine.Quantity) || 0;
                            const sapQty = parseFloat(sapLine.Quantity) || 0;
                            if (Math.abs(localQty - sapQty) > 0.001) {
                                hasChanges = true;
                                changeDetails.push(`Line ${sapLine.LineNum || i}: Qty changed`);
                            }

                            const localPrice = parseFloat(localLine.Price) || 0;
                            const sapPrice = parseFloat(sapLine.Price || sapLine.UnitPrice) || 0;
                            if (Math.abs(localPrice - sapPrice) > 0.01) {
                                hasChanges = true;
                                changeDetails.push(`Line ${sapLine.LineNum || i}: Price changed`);
                            }
                        }
                    }
                }

                if (hasChanges) {
                    console.log(`📝 Invoice ${localInvoice.DocNum} has been modified in SAP`);
                    console.log(`   Changes detected: ${changeDetails.join(", ")}`);

                    // Calculate payment status
                    const remainingBalance = sapInvoice.DocTotal - (sapInvoice.PaidToDate || 0);
                    let paymentStatus = "Unpaid";
                    if (remainingBalance <= 0.01) {
                        paymentStatus = "Fully Paid";
                    } else if (sapInvoice.PaidToDate > 0) {
                        paymentStatus = "Partially Paid";
                    }

                    // Prepare document lines
                    const documentLines = sapInvoice.DocumentLines?.map((line, index) => {
                        const originalPrice = line.Price || line.UnitPrice || 0;
                        const discountPercent = parseFloat(line.DiscountPercent) || 0;
                        const effectivePrice = discountPercent >= 100 ? 0 : originalPrice * (1 - discountPercent / 100);

                        return {
                            LineNum: line.LineNum || index,
                            ItemCode: line.ItemCode,
                            ItemDescription: line.ItemDescription,
                            Quantity: line.Quantity,
                            Price: effectivePrice,
                            OriginalPrice: originalPrice,
                            DiscountPercent: discountPercent,
                            PriceAfterVAT: line.PriceAfterVAT,
                            Currency: line.Currency || sapInvoice.DocCurrency,
                            LineTotal: line.LineTotal,
                            VatGroup: line.VatGroup,
                        };
                    }) || [];

                    // Add to bulk operations
                    bulkUpdateOps.push({
                        updateOne: {
                            filter: { DocNum: localInvoice.DocNum },
                            update: {
                                $set: {
                                    DocTotal: sapInvoice.DocTotal,
                                    VatSum: sapInvoice.VatSum,
                                    PaidToDate: sapInvoice.PaidToDate,
                                    DocCurrency: sapInvoice.DocCurrency || localInvoice.DocCurrency,
                                    DiscountPercent: sapInvoice.DiscountPercent || localInvoice.DiscountPercent,
                                    Address: sapInvoice.Address || localInvoice.Address,
                                    DocDate: sapInvoice.DocDate || localInvoice.DocDate,
                                    DocDueDate: sapInvoice.DocDueDate || localInvoice.DocDueDate,
                                    Comments: sapInvoice.Comments || localInvoice.Comments,
                                    U_Notes: sapInvoice.Comments || localInvoice.U_Notes,
                                    DocumentLines: documentLines,
                                    paymentStatus: paymentStatus,
                                    "paymentTracking.totalInvoiceAmount": sapInvoice.DocTotal,
                                    "paymentTracking.totalPaidAmount": sapInvoice.PaidToDate || 0,
                                    "paymentTracking.remainingBalance": remainingBalance,
                                    ...(paidDifference > 0.01 && {
                                        "paymentTracking.lastPaymentDate": new Date(),
                                        "paymentTracking.lastPaymentAmount": sapPaid - localPaid,
                                    }),
                                    UpdateDate: new Date(),
                                    LocalStatus: "Synced",
                                }
                            }
                        }
                    });

                    affectedCustomersSet.add(localInvoice.CardCode);

                    results.updatedInvoices.push({
                        DocNum: localInvoice.DocNum,
                        CardCode: localInvoice.CardCode,
                        CardName: localInvoice.CardName,
                        oldTotal: localTotal,
                        newTotal: sapTotal,
                        oldPaid: localPaid,
                        newPaid: sapPaid,
                        remainingBalance: remainingBalance,
                        paymentStatus: paymentStatus,
                        changes: changeDetails,
                    });
                }

            } catch (error) {
                console.error(`❌ Error preparing update for invoice ${localInvoice.DocNum}:`, error.message);
                results.errors.push({
                    DocNum: localInvoice.DocNum,
                    action: "update",
                    error: error.message,
                });
            }
        }

        // Execute bulk updates in batches
        if (bulkUpdateOps.length > 0) {
            const BATCH_SIZE = 300;
            console.log(`\n📦 Executing ${bulkUpdateOps.length} updates in batches of ${BATCH_SIZE}...`);

            for (let i = 0; i < bulkUpdateOps.length; i += BATCH_SIZE) {
                const batch = bulkUpdateOps.slice(i, i + BATCH_SIZE);
                try {
                    const bulkResult = await Invoice.bulkWrite(batch, { ordered: false });
                    results.invoicesUpdated += bulkResult.modifiedCount || 0;
                    console.log(`✅ Batch ${Math.floor(i / BATCH_SIZE) + 1}: Updated ${bulkResult.modifiedCount} invoices`);
                } catch (error) {
                    console.error(`❌ Error in batch update:`, error.message);
                    results.errors.push({
                        action: "bulk_update",
                        error: error.message,
                    });
                }
            }
        }

        // STEP 2: Close invoices in bulk
        if (invoicesToClose.length > 0) {
            console.log(`\n🔒 Closing ${invoicesToClose.length} invoices in bulk...`);

            const closeOps = invoicesToClose.map(invoice => {
                affectedCustomersSet.add(invoice.CardCode);

                results.closedInvoices.push({
                    DocNum: invoice.DocNum,
                    CardCode: invoice.CardCode,
                    CardName: invoice.CardName,
                    DocTotal: invoice.DocTotal,
                });

                return {
                    updateOne: {
                        filter: { DocNum: invoice.DocNum },
                        update: {
                            $set: {
                                DocumentStatus: "bost_Close",
                                UpdateDate: new Date(),
                                LocalStatus: "Synced",
                                paymentStatus: "Fully Paid",
                                // PaidToDate is what every balance calculation in the app
                                // reads. Leaving it behind on a closed invoice makes the
                                // invoice look permanently unpaid.
                                PaidToDate: invoice.DocTotal,
                                "paymentTracking.remainingBalance": 0,
                                "paymentTracking.totalPaidAmount": invoice.DocTotal,
                                U_Notes: (invoice.U_Notes || "") + ` [Auto-closed via invoice status sync on ${new Date().toISOString()}]`,
                            }
                        }
                    }
                };
            });

            const BATCH_SIZE = 300;
            for (let i = 0; i < closeOps.length; i += BATCH_SIZE) {
                const batch = closeOps.slice(i, i + BATCH_SIZE);
                try {
                    const bulkResult = await Invoice.bulkWrite(batch, { ordered: false });
                    results.invoicesClosed += bulkResult.modifiedCount || 0;
                    console.log(`✅ Closed batch ${Math.floor(i / BATCH_SIZE) + 1}: ${bulkResult.modifiedCount} invoices`);
                } catch (error) {
                    console.error(`❌ Error closing batch:`, error.message);
                    results.errors.push({
                        action: "bulk_close",
                        error: error.message,
                    });
                }
            }
        }

        // STEP 3: Create missing invoices (with duplicate handling)
        if (missingInvoiceDocNums.length > 0) {
            console.log(`\n➕ Creating ${missingInvoiceDocNums.length} missing invoices...`);

            for (const docNum of missingInvoiceDocNums) {
                try {
                    const sapInvoice = openInvoicesInSAP.find(inv => inv.DocNum === docNum);

                    if (!sapInvoice) {
                        console.log(`⚠️ Could not find details for DocNum ${docNum}`);
                        continue;
                    }

                    console.log(`Creating invoice DocNum: ${sapInvoice.DocNum} (${sapInvoice.CardCode})`);

                    // Check if DocEntry already exists
                    const existingInvoiceWithDocEntry = await Invoice.findOne({ DocEntry: sapInvoice.DocEntry });

                    if (existingInvoiceWithDocEntry) {
                        console.log(`⚠️ DocEntry ${sapInvoice.DocEntry} already exists for DocNum ${existingInvoiceWithDocEntry.DocNum}`);
                        console.log(`🗑️ Deleting duplicate invoice with DocEntry ${sapInvoice.DocEntry}...`);

                        // Delete the existing invoice with this DocEntry
                        await Invoice.deleteOne({ DocEntry: sapInvoice.DocEntry });

                        console.log(`✅ Deleted old invoice. Now creating new invoice...`);
                    }

                    const newInvoice = new Invoice({
                        DocEntry: sapInvoice.DocEntry,
                        DocNum: sapInvoice.DocNum,
                        SAPDocEntry: sapInvoice.DocEntry,
                        DocType: sapInvoice.DocObjectCode || "dDocument_Items",
                        CardCode: sapInvoice.CardCode,
                        CardName: sapInvoice.CardName,
                        Address: sapInvoice.Address,
                        DocDate: sapInvoice.DocDate,
                        DocDueDate: sapInvoice.DocDueDate,
                        CreationDate: sapInvoice.CreationDate || new Date(),
                        UpdateDate: new Date(),
                        DocTotal: sapInvoice.DocTotal,
                        DocCurrency: sapInvoice.DocCurrency || "EUR",
                        VatSum: sapInvoice.VatSum,
                        PaidToDate: sapInvoice.PaidToDate || 0,
                        DocumentLines: sapInvoice.DocumentLines?.map((line, index) => {
                            const originalPrice = line.Price || line.UnitPrice || 0;
                            const discountPercent = parseFloat(line.DiscountPercent) || 0;
                            const effectivePrice = discountPercent >= 100 ? 0 : originalPrice * (1 - discountPercent / 100);

                            return {
                                LineNum: line.LineNum || index,
                                ItemCode: line.ItemCode,
                                ItemDescription: line.ItemDescription,
                                Quantity: line.Quantity,
                                Price: effectivePrice,
                                OriginalPrice: originalPrice,
                                DiscountPercent: discountPercent,
                                PriceAfterVAT: line.PriceAfterVAT,
                                Currency: line.Currency || sapInvoice.DocCurrency,
                                LineTotal: line.LineTotal,
                                VatGroup: line.VatGroup,
                            };
                        }) || [],
                        DocumentStatus: sapInvoice.DocumentStatus || "bost_Open",
                        SyncedWithSAP: true,
                        LocalStatus: "Synced",
                        ImportDate: new Date(),
                        ImportSource: "Invoice_Status_Sync",
                        Comments: sapInvoice.Comments || "",
                        paymentStatus: sapInvoice.PaidToDate >= sapInvoice.DocTotal ? "Fully Paid" :
                            sapInvoice.PaidToDate > 0 ? "Partially Paid" : "Unpaid",
                        paymentTracking: {
                            totalInvoiceAmount: sapInvoice.DocTotal,
                            totalPaidAmount: sapInvoice.PaidToDate || 0,
                            remainingBalance: sapInvoice.DocTotal - (sapInvoice.PaidToDate || 0),
                        },
                    });

                    await newInvoice.save();

                    affectedCustomersSet.add(sapInvoice.CardCode);
                    results.invoicesCreated++;
                    results.createdInvoices.push({
                        DocNum: sapInvoice.DocNum,
                        CardCode: sapInvoice.CardCode,
                        CardName: sapInvoice.CardName,
                        DocTotal: sapInvoice.DocTotal,
                        PaidToDate: sapInvoice.PaidToDate,
                        paymentStatus: newInvoice.paymentStatus,
                    });

                    console.log(`✅ Invoice ${sapInvoice.DocNum} created successfully`);

                } catch (error) {
                    console.error(`❌ Error creating invoice ${docNum}:`, error.message);
                    results.errors.push({
                        DocNum: docNum,
                        action: "create",
                        error: error.message,
                    });
                }
            }
        }

        // STEP 4: Update customer totals in bulk
        console.log("\n💰 Updating customer payment totals...");

        const customerUpdatePromises = Array.from(affectedCustomersSet).map(cardCode =>
            updateCustomerInvoiceTotals(cardCode)
        );

        await Promise.all(customerUpdatePromises);
        console.log(`Updated payment totals for ${affectedCustomersSet.size} customers`);

        // STEP 5: Save sync metadata
        const currentSyncDate = new Date();
        await SyncMetadata.findOneAndUpdate(
            { syncType: "invoice_status_sync" },
            {
                lastSyncDate: currentSyncDate,
                lastSyncStatus: "success",
                lastSyncStats: {
                    totalOpenInSAP: results.totalOpenInSAP,
                    totalClosedInSAP: results.totalClosedInSAP,
                    invoicesClosed: results.invoicesClosed,
                    invoicesCreated: results.invoicesCreated,
                    invoicesUpdated: results.invoicesUpdated,
                    errors: results.errors.length,
                },
                updatedAt: currentSyncDate,
            },
            { upsert: true, new: true }
        );

        console.log(`\n✅ Sync metadata saved. Next sync will fetch invoices updated after ${currentSyncDate.toISOString()}`);

        const finalLocalOpenCount = localOpenInvoices.length - results.invoicesClosed + results.invoicesCreated;

        console.log("\n" + "=".repeat(60));
        console.log("INVOICE STATUS SYNC COMPLETED");
        console.log(`Open invoices fetched from SAP: ${results.totalOpenInSAP}`);
        console.log(`Closed invoices fetched from SAP: ${results.totalClosedInSAP}`);
        console.log(`Open invoices in Local DB (before): ${results.totalOpenInLocalDB}`);
        console.log(`Invoices closed: ${results.invoicesClosed}`);
        console.log(`Invoices created: ${results.invoicesCreated}`);
        console.log(`Invoices updated: ${results.invoicesUpdated}`);
        console.log(`Open invoices in Local DB (after): ${finalLocalOpenCount}`);
        console.log(`Errors: ${results.errors.length}`);
        console.log("=".repeat(60) + "\n");

        res.status(200).json({
            success: true,
            message: `Invoice status sync completed. ${results.invoicesClosed} closed, ${results.invoicesCreated} created, ${results.invoicesUpdated} updated.`,
            data: {
                ...results,
                finalLocalOpenCount,
                lastSyncDate: currentSyncDate,
            },
        });

    } catch (error) {
        console.error("Error in syncInvoiceStatusesFromSAP:", error);

        // Mark sync as failed
        try {
            await SyncMetadata.findOneAndUpdate(
                { syncType: "invoice_status_sync" },
                {
                    lastSyncStatus: "failed",
                    updatedAt: new Date(),
                },
                { upsert: true }
            );
        } catch (metaError) {
            console.error("Error updating sync metadata:", metaError);
        }

        res.status(500).json({
            success: false,
            message: "Error syncing invoice statuses from SAP",
            error: error.message,
        });
    }
};
/**
 * Helper function to update customer invoice totals
 */
async function updateCustomerInvoiceTotals(cardCode) {
    try {
        const invoiceTotals = await Invoice.aggregate([
            {
                $match: { CardCode: cardCode },
            },
            {
                $group: {
                    _id: null,
                    totalInvoiceAmount: { $sum: "$DocTotal" },
                    totalPaid: { $sum: "$PaidToDate" },
                    openInvoices: {
                        $sum: {
                            $cond: [
                                { $in: ["$DocumentStatus", ["bost_Open", "O"]] },
                                1,
                                0,
                            ],
                        },
                    },
                    openInvoiceAmount: {
                        $sum: {
                            $cond: [
                                { $in: ["$DocumentStatus", ["bost_Open", "O"]] },
                                { $subtract: ["$DocTotal", "$PaidToDate"] },
                                0,
                            ],
                        },
                    },
                },
            },
        ]);

        if (invoiceTotals.length > 0) {
            const totals = invoiceTotals[0];

            // NOTE: outstandingBalance is deliberately not written here. It mirrors
            // SAP's BusinessPartners.CurrentAccountBalance (which nets credit notes,
            // down payments and journal entries, and goes negative for prepaid
            // customers) and is maintained by
            // services/sapCustomerBalanceSync.service.js. Deriving it from the local
            // open-invoice mirror produced figures that drifted from SAP by
            // thousands of euros.
            await Customer.findOneAndUpdate(
                { CardCode: cardCode },
                {
                    totalInvoiceAmount: totals.totalInvoiceAmount,
                    totalInvoicePaid: totals.totalPaid,
                    openInvoiceAmount: totals.openInvoiceAmount,
                    openInvoiceCount: totals.openInvoices,
                }
            );

            console.log(`✅ Updated totals for customer ${cardCode}:`);
            console.log(`   Total Invoices: ${totals.totalInvoiceAmount}`);
            console.log(`   Total Paid: ${totals.totalPaid}`);
            console.log(`   Open invoice amount: ${totals.openInvoiceAmount}`);
        }
    } catch (error) {
        console.error(`Error updating totals for customer ${cardCode}:`, error);
    }
}

module.exports = exports;