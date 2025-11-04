// controllers/invoiceSync.controller.js
const Invoice = require("../models/Invoice");
const Customer = require("../models/Customer");
const FlattenedPayment = require("../models/FlattenedPayment");
const axios = require("axios");

const SAP_CONFIG = {
    serviceLayerUrl: process.env.SAP_SERVICE_LAYER_URL,
    companyDB: process.env.COMPANY_DB,
    username: process.env.USER_NAME,
    password: process.env.PASSWORD,
};

/**
 * Live sync invoice statuses from SAP (similar to order status sync)
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

        let openInvoicesInSAP = [];
        let totalFetched = 0;

        // Fetch all OPEN invoices from SAP
        let nextLink = `${SAP_CONFIG.serviceLayerUrl}/Invoices?$filter=DocumentStatus eq 'bost_Open'&$orderby=DocNum`;

        console.log("Fetching open invoices from SAP...");

        while (nextLink) {
            try {
                console.log(`Fetching batch from SAP...`);
                const response = await axios.get(nextLink, { headers });

                const currentBatch = response.data.value;
                console.log(`Fetched ${currentBatch.length} invoices in this batch`);

                openInvoicesInSAP.push(...currentBatch);
                totalFetched += currentBatch.length;

                console.log(`Total open invoices fetched so far: ${totalFetched}`);

                nextLink = response.data["odata.nextLink"];

                if (nextLink && nextLink.startsWith("Invoices")) {
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

        console.log(`\nTotal open invoices in SAP: ${openInvoicesInSAP.length}`);

        const sapOpenDocNums = openInvoicesInSAP.map(inv => inv.DocNum);

        // Find all invoices marked as Open in local DB
        const localOpenInvoices = await Invoice.find({
            DocumentStatus: { $in: ["bost_Open", "O"] },
        }).select("DocNum DocEntry DocumentStatus CardCode CardName DocTotal VatSum PaidToDate SAPDocEntry DocumentLines");

        console.log(`\nTotal open invoices in local DB: ${localOpenInvoices.length}`);

        const localOpenDocNums = localOpenInvoices.map(inv => inv.DocNum);

        // Create map of SAP invoices
        const sapInvoicesMap = {};
        openInvoicesInSAP.forEach(inv => {
            sapInvoicesMap[inv.DocNum] = inv;
        });

        // Find invoices to close (open locally but NOT in SAP's open list)
        // This means they were closed/paid in SAP
        const invoicesToClose = localOpenInvoices.filter(
            inv => !sapOpenDocNums.includes(inv.DocNum)
        );

        // Find missing invoices to create (open in SAP but not in local DB)
        const missingInvoiceDocNums = sapOpenDocNums.filter(
            docNum => !localOpenDocNums.includes(docNum)
        );

        console.log(`\nInvoices to close: ${invoicesToClose.length}`);
        console.log(`Missing invoices to create: ${missingInvoiceDocNums.length}`);

        const results = {
            totalOpenInSAP: openInvoicesInSAP.length,
            totalOpenInLocalDB: localOpenInvoices.length,
            invoicesClosed: 0,
            invoicesCreated: 0,
            invoicesUpdated: 0,
            errors: [],
            closedInvoices: [],
            createdInvoices: [],
            updatedInvoices: [],
        };

        // STEP 1: Update existing open invoices (check for changes)
        console.log("\n🔄 Checking for updates in existing open invoices...");

        for (const localInvoice of localOpenInvoices) {
            // Skip invoices that will be closed
            if (invoicesToClose.some(inv => inv.DocNum === localInvoice.DocNum)) {
                continue;
            }

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

                // **CHECK FOR CHANGES IN DOCUMENT LINES** (like orders)
                if (sapInvoice.DocumentLines && sapInvoice.DocumentLines.length > 0) {
                    const localLines = localInvoice.DocumentLines || [];
                    const sapLines = sapInvoice.DocumentLines;

                    // Check if number of lines changed
                    if (localLines.length !== sapLines.length) {
                        hasChanges = true;
                        changeDetails.push(`Line count changed: ${localLines.length} → ${sapLines.length}`);
                    } else {
                        // Compare each line for changes
                        for (let i = 0; i < sapLines.length; i++) {
                            const sapLine = sapLines[i];
                            const localLine = localLines.find(l => l.LineNum === sapLine.LineNum) || localLines[i];

                            if (!localLine) {
                                hasChanges = true;
                                changeDetails.push(`New line added: ${sapLine.ItemCode}`);
                                continue;
                            }

                            // Check ItemCode change
                            if (localLine.ItemCode !== sapLine.ItemCode) {
                                hasChanges = true;
                                changeDetails.push(`Line ${sapLine.LineNum || i}: Item changed from ${localLine.ItemCode} to ${sapLine.ItemCode}`);
                            }

                            // Check Quantity change
                            const localQty = parseFloat(localLine.Quantity) || 0;
                            const sapQty = parseFloat(sapLine.Quantity) || 0;
                            if (Math.abs(localQty - sapQty) > 0.001) {
                                hasChanges = true;
                                changeDetails.push(`Line ${sapLine.LineNum || i} (${sapLine.ItemCode}): Qty ${localQty} → ${sapQty}`);
                            }

                            // Check Price change
                            const localPrice = parseFloat(localLine.Price) || 0;
                            const sapPrice = parseFloat(sapLine.Price || sapLine.UnitPrice) || 0;
                            if (Math.abs(localPrice - sapPrice) > 0.01) {
                                hasChanges = true;
                                changeDetails.push(`Line ${sapLine.LineNum || i} (${sapLine.ItemCode}): Price ${localPrice} → ${sapPrice}`);
                            }

                            // Check LineTotal change
                            const localLineTotal = parseFloat(localLine.LineTotal) || 0;
                            const sapLineTotal = parseFloat(sapLine.LineTotal) || 0;
                            if (Math.abs(localLineTotal - sapLineTotal) > 0.01) {
                                hasChanges = true;
                                changeDetails.push(`Line ${sapLine.LineNum || i} (${sapLine.ItemCode}): Total ${localLineTotal} → ${sapLineTotal}`);
                            }
                        }
                    }
                }

                if (hasChanges) {
                    console.log(`📝 Invoice ${localInvoice.DocNum} has been modified in SAP`);
                    console.log(`   Changes detected:`);
                    changeDetails.forEach(detail => console.log(`   - ${detail}`));

                    // Update the invoice with SAP data
                    localInvoice.DocTotal = sapInvoice.DocTotal;
                    localInvoice.VatSum = sapInvoice.VatSum;
                    localInvoice.PaidToDate = sapInvoice.PaidToDate;
                    localInvoice.DocCurrency = sapInvoice.DocCurrency || localInvoice.DocCurrency;
                    localInvoice.DiscountPercent = sapInvoice.DiscountPercent || localInvoice.DiscountPercent;
                    localInvoice.Address = sapInvoice.Address || localInvoice.Address;
                    localInvoice.DocDate = sapInvoice.DocDate || localInvoice.DocDate;
                    localInvoice.DocDueDate = sapInvoice.DocDueDate || localInvoice.DocDueDate;
                    localInvoice.Comments = sapInvoice.Comments || localInvoice.Comments;
                    localInvoice.U_Notes = sapInvoice.Comments || localInvoice.U_Notes;

                    // Update document lines if they changed
                    if (sapInvoice.DocumentLines && sapInvoice.DocumentLines.length > 0) {
                        localInvoice.DocumentLines = sapInvoice.DocumentLines.map((line, index) => {
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
                        });
                    }

                    // Update payment tracking
                    if (!localInvoice.paymentTracking) {
                        localInvoice.paymentTracking = {};
                    }

                    localInvoice.paymentTracking.totalInvoiceAmount = sapInvoice.DocTotal;
                    localInvoice.paymentTracking.totalPaidAmount = sapInvoice.PaidToDate || 0;
                    localInvoice.paymentTracking.remainingBalance = sapInvoice.DocTotal - (sapInvoice.PaidToDate || 0);

                    if (paidDifference > 0.01) {
                        localInvoice.paymentTracking.lastPaymentDate = new Date();
                        localInvoice.paymentTracking.lastPaymentAmount = sapPaid - localPaid;
                    }

                    // Update payment status based on remaining balance
                    const remainingBalance = localInvoice.paymentTracking.remainingBalance;
                    if (remainingBalance <= 0.01) {
                        localInvoice.paymentStatus = "Fully Paid";
                    } else if (sapInvoice.PaidToDate > 0) {
                        localInvoice.paymentStatus = "Partially Paid";
                    } else {
                        localInvoice.paymentStatus = "Unpaid";
                    }

                    localInvoice.UpdateDate = new Date();
                    localInvoice.LocalStatus = "Synced";

                    await localInvoice.save();

                    results.invoicesUpdated++;
                    results.updatedInvoices.push({
                        DocNum: localInvoice.DocNum,
                        CardCode: localInvoice.CardCode,
                        CardName: localInvoice.CardName,
                        oldTotal: localTotal,
                        newTotal: sapTotal,
                        oldPaid: localPaid,
                        newPaid: sapPaid,
                        remainingBalance: localInvoice.paymentTracking.remainingBalance,
                        paymentStatus: localInvoice.paymentStatus,
                        changes: changeDetails,
                    });

                    console.log(`✅ Invoice ${localInvoice.DocNum} updated successfully`);
                }

            } catch (error) {
                console.error(`❌ Error updating invoice ${localInvoice.DocNum}:`, error.message);
                results.errors.push({
                    DocNum: localInvoice.DocNum,
                    action: "update",
                    error: error.message,
                });
            }
        }

        // STEP 2: Close invoices (closed in SAP, still open locally)
        for (const invoice of invoicesToClose) {
            try {
                console.log(`Closing invoice DocNum: ${invoice.DocNum} (${invoice.CardCode})`);

                // Mark as closed
                invoice.DocumentStatus = "bost_Close";
                invoice.UpdateDate = new Date();
                invoice.LocalStatus = "Synced";

                // Update payment status to Fully Paid (since it's closed in SAP)
                invoice.paymentStatus = "Fully Paid";

                // Initialize payment tracking if not exists
                if (!invoice.paymentTracking) {
                    invoice.paymentTracking = {
                        totalInvoiceAmount: invoice.DocTotal,
                        totalPaidAmount: invoice.DocTotal, // Assume fully paid if closed
                        totalCreditAmount: 0,
                        remainingBalance: 0,
                    };
                } else {
                    // Set remaining balance to 0
                    invoice.paymentTracking.remainingBalance = 0;
                    // If PaidToDate wasn't already set, set it to DocTotal
                    if (!invoice.paymentTracking.totalPaidAmount || invoice.paymentTracking.totalPaidAmount < invoice.DocTotal) {
                        invoice.paymentTracking.totalPaidAmount = invoice.DocTotal;
                    }
                }

                invoice.U_Notes = (invoice.U_Notes || "") + ` [Auto-closed via invoice status sync on ${new Date().toISOString()}]`;

                await invoice.save();

                results.invoicesClosed++;
                results.closedInvoices.push({
                    DocNum: invoice.DocNum,
                    CardCode: invoice.CardCode,
                    CardName: invoice.CardName,
                    DocTotal: invoice.DocTotal,
                });

                console.log(`✅ Invoice ${invoice.DocNum} closed successfully`);

            } catch (error) {
                console.error(`❌ Error closing invoice ${invoice.DocNum}:`, error.message);
                results.errors.push({
                    DocNum: invoice.DocNum,
                    action: "close",
                    error: error.message,
                });
            }
        }

        // STEP 3: Create missing invoices
        for (const docNum of missingInvoiceDocNums) {
            try {
                const sapInvoice = openInvoicesInSAP.find(inv => inv.DocNum === docNum);

                if (!sapInvoice) {
                    console.log(`⚠️ Could not find details for DocNum ${docNum}`);
                    continue;
                }

                console.log(`Creating missing invoice DocNum: ${sapInvoice.DocNum} (${sapInvoice.CardCode})`);

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
                    DocumentLines: sapInvoice.DocumentLines?.map((line, index) => ({
                        LineNum: line.LineNum || index,
                        ItemCode: line.ItemCode,
                        ItemDescription: line.ItemDescription,
                        Quantity: line.Quantity,
                        Price: line.Price || line.UnitPrice,
                        PriceAfterVAT: line.PriceAfterVAT,
                        Currency: line.Currency || sapInvoice.DocCurrency,
                        LineTotal: line.LineTotal,
                        VatGroup: line.VatGroup,
                    })) || [],
                    DocumentStatus: sapInvoice.DocumentStatus || "bost_Open",
                    SyncedWithSAP: true,
                    LocalStatus: "Synced",
                    ImportDate: new Date(),
                    ImportSource: "Invoice_Status_Sync",
                    Comments: sapInvoice.Comments || "",

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

        // STEP 4: Update customer totals
        console.log("\n💰 Updating customer payment totals...");

        const affectedCustomers = new Set();
        results.updatedInvoices.forEach(inv => affectedCustomers.add(inv.CardCode));
        results.closedInvoices.forEach(inv => affectedCustomers.add(inv.CardCode));
        results.createdInvoices.forEach(inv => affectedCustomers.add(inv.CardCode));

        for (const cardCode of affectedCustomers) {
            await updateCustomerInvoiceTotals(cardCode);
        }

        console.log(`Updated payment totals for ${affectedCustomers.size} customers`);

        const finalLocalOpenCount = localOpenInvoices.length - results.invoicesClosed + results.invoicesCreated;

        console.log("\n" + "=".repeat(60));
        console.log("INVOICE STATUS SYNC COMPLETED");
        console.log(`Open invoices in SAP: ${results.totalOpenInSAP}`);
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
                matched: finalLocalOpenCount === results.totalOpenInSAP,
            },
        });

    } catch (error) {
        console.error("Error in syncInvoiceStatusesFromSAP:", error);
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

            await Customer.findOneAndUpdate(
                { CardCode: cardCode },
                {
                    totalInvoiceAmount: totals.totalInvoiceAmount,
                    totalInvoicePaid: totals.totalPaid,
                    outstandingBalance: totals.openInvoiceAmount,
                }
            );

            console.log(`✅ Updated totals for customer ${cardCode}:`);
            console.log(`   Total Invoices: ${totals.totalInvoiceAmount}`);
            console.log(`   Total Paid: ${totals.totalPaid}`);
            console.log(`   Outstanding: ${totals.openInvoiceAmount}`);
        }
    } catch (error) {
        console.error(`Error updating totals for customer ${cardCode}:`, error);
    }
}

module.exports = exports;