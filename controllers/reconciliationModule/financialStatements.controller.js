// controllers/financialStatements.controller.js
// ADD THESE NEW FUNCTIONS TO THE EXISTING CONTROLLER

const FlattenedPayment = require("../../models/FlattenedPayment");
const SalarySheetPayment = require("../../models/SalarySheetPayment");
const Customer = require("../../models/Customer");
const Invoice = require("../../models/Invoice");
const BankStatement = require("../../models/BankStatement");
const PayPalStatement = require("../../models/PayPalStatement");

// ADD THESE FUNCTIONS TO controllers/financialStatements.controller.js

/**
 * Get all flattened payments with filters
 */
exports.getFlattenedPayments = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 50,
            cardCode,
            source,
            reconciliationStatus,
            startDate,
            endDate,
            minAmount,
            maxAmount,
        } = req.query;

        const filter = {};

        if (cardCode) {
            filter.$or = [
                { cardCode: cardCode },
                { alternateCardCodes: cardCode },
            ];
        }

        if (source) {
            filter.source = source;
        }

        if (reconciliationStatus) {
            if (reconciliationStatus === 'Matched') {
                filter.cardCode = { $ne: null };
            } else if (reconciliationStatus === 'Unmatched') {
                filter.cardCode = null;
            }
        }

        if (startDate && endDate) {
            filter.paymentDate = {
                $gte: new Date(startDate),
                $lte: new Date(endDate),
            };
        }

        if (minAmount || maxAmount) {
            filter.amount = {};
            if (minAmount) filter.amount.$gte = parseFloat(minAmount);
            if (maxAmount) filter.amount.$lte = parseFloat(maxAmount);
        }

        console.log("Flattened Payments Filter:", filter);

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const payments = await FlattenedPayment.find(filter)
            .sort({ paymentDate: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .lean();

        const total = await FlattenedPayment.countDocuments(filter);

        return res.status(200).json({
            success: true,
            data: {
                payments,
                pagination: {
                    total,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    pages: Math.ceil(total / parseInt(limit)),
                },
            },
        });
    } catch (error) {
        console.error("Error fetching flattened payments:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch payments",
            error: error.message,
        });
    }
};

/**
 * Get unmatched payments for frontend matching
 */
exports.getUnmatchedPayments = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 50,
            source,
        } = req.query;

        const filter = {
            $or: [
                { cardCode: null },
                { cardCode: { $exists: false } },
                { cardCode: "" },
            ],
        };

        if (source) {
            filter.source = source;
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const payments = await FlattenedPayment.find(filter)
            .sort({ paymentDate: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .lean();

        const total = await FlattenedPayment.countDocuments(filter);

        return res.status(200).json({
            success: true,
            data: {
                payments,
                pagination: {
                    total,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    pages: Math.ceil(total / parseInt(limit)),
                },
            },
        });
    } catch (error) {
        console.error("Error fetching unmatched payments:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch unmatched payments",
            error: error.message,
        });
    }
};

/**
 * Get payments by customer
 */
exports.getPaymentsByCustomer = async (req, res) => {
    try {
        const { cardCode } = req.params;
        const {
            page = 1,
            limit = 50,
            reconciliationStatus,
        } = req.query;

        const filter = {
            $or: [
                { cardCode: cardCode },
                { alternateCardCodes: cardCode },
            ],
        };

        if (reconciliationStatus) {
            filter.reconciliationStatus = reconciliationStatus;
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const payments = await FlattenedPayment.find(filter)
            .sort({ paymentDate: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .lean();

        const total = await FlattenedPayment.countDocuments(filter);

        // Get summary
        const summary = await FlattenedPayment.aggregate([
            {
                $match: filter,
            },
            {
                $group: {
                    _id: null,
                    totalPayments: { $sum: "$amount" },
                    totalAllocated: { $sum: "$totalAllocated" },
                    totalRemaining: { $sum: "$remainingAmount" },
                },
            },
        ]);

        return res.status(200).json({
            success: true,
            data: {
                payments,
                summary: summary[0] || {
                    totalPayments: 0,
                    totalAllocated: 0,
                    totalRemaining: 0,
                },
                pagination: {
                    total,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    pages: Math.ceil(total / parseInt(limit)),
                },
            },
        });
    } catch (error) {
        console.error("Error fetching payments by customer:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch payments",
            error: error.message,
        });
    }
};

/**
 * Allocate payment to invoice
 */
exports.allocatePaymentToInvoice = async (req, res) => {
    try {
        const { paymentId, invoiceDocNum, amountToAllocate, notes } = req.body;

        if (!paymentId || !invoiceDocNum || !amountToAllocate) {
            return res.status(400).json({
                success: false,
                message: "Payment ID, invoice DocNum, and amount are required",
            });
        }

        // Find payment
        const payment = await FlattenedPayment.findById(paymentId);
        if (!payment) {
            return res.status(404).json({
                success: false,
                message: "Payment not found",
            });
        }

        // Find invoice
        const invoice = await Invoice.findOne({ DocNum: invoiceDocNum });
        if (!invoice) {
            return res.status(404).json({
                success: false,
                message: "Invoice not found",
            });
        }

        // Check if invoice is open (unpaid)
        if (!["bost_Open", "O"].includes(invoice.DocumentStatus)) {
            return res.status(400).json({
                success: false,
                message: "Invoice is already closed/paid",
            });
        }

  
        console.log(`Allocating ${amountToAllocate} from payment ${paymentId} to invoice ${invoiceDocNum}`);   

        // Check if payment has enough remaining amount
        if (payment.remainingAmount < amountToAllocate) {
            return res.status(400).json({
                success: false,
                message: `Payment only has ${payment.remainingAmount} remaining, cannot allocate ${amountToAllocate}`,
            });
        }

        // Calculate invoice remaining balance properly
        const totalPaid = invoice.PaidToDate || 0;
        const totalAllocated = (invoice.allocatedPayments || []).reduce((sum, alloc) => sum + alloc.amountAllocated, 0);
        const invoiceRemaining = invoice.DocTotal - totalPaid - totalAllocated;

        let differenceOfAllocation = amountToAllocate - invoiceRemaining;

        if (differenceOfAllocation > 1 || differenceOfAllocation < -1) {
            return res.status(400).json({
                success: false,
                message: `Invoice only needs ${invoiceRemaining}, cannot allocate ${amountToAllocate}`,
            });
        }

        // Add allocation to payment
        payment.matchedInvoices.push({
            invoiceDocNum: invoice.DocNum,
            invoiceDocEntry: invoice.DocEntry,
            amountAllocated: amountToAllocate,
            matchedDate: new Date(),
            matchedBy: req.user?._id,
        });

        payment.calculateRemaining();
        await payment.save();

        // Add allocation to invoice
        if (!invoice.allocatedPayments) {
            invoice.allocatedPayments = [];
        }

        invoice.allocatedPayments.push({
            flattenedPaymentId: payment._id,
            amountAllocated: amountToAllocate,
            allocationDate: new Date(),
            allocatedBy: req.user?._id,
            source: payment.source,
        });

        // Update invoice payment tracking
        if (!invoice.paymentTracking) {
            invoice.paymentTracking = {
                totalInvoiceAmount: invoice.DocTotal,
                totalPaidAmount: 0,
                totalCreditAmount: 0,
                remainingBalance: invoice.DocTotal,
            };
        }

        invoice.paymentTracking.totalPaidAmount += amountToAllocate;
        invoice.paymentTracking.remainingBalance = invoice.paymentTracking.totalInvoiceAmount -
            invoice.paymentTracking.totalPaidAmount -
            invoice.paymentTracking.totalCreditAmount;

        invoice.paymentTracking.lastPaymentDate = new Date();
        invoice.paymentTracking.lastPaymentAmount = amountToAllocate;

        // Update payment status
        if (invoice.paymentTracking.remainingBalance <= 0.01) {
            invoice.paymentStatus = "Fully Paid";
            invoice.DocumentStatus = "bost_Closed"; 
        } else if (invoice.paymentTracking.totalPaidAmount > 0) {
            invoice.paymentStatus = "Partially Paid";
        }

        await invoice.save();

        // Update customer totals
        await updateCustomerPaymentTotals([payment.cardCode]);
        await updateCustomerInvoiceTotals(invoice.CardCode);

        return res.status(200).json({
            success: true,
            message: "Payment allocated successfully",
            data: {
                payment: {
                    _id: payment._id,
                    remainingAmount: payment.remainingAmount,
                    reconciliationStatus: payment.reconciliationStatus,
                },
                invoice: {
                    DocNum: invoice.DocNum,
                    paymentStatus: invoice.paymentStatus,
                    remainingBalance: invoice.paymentTracking.remainingBalance,
                },
            },
        });

    } catch (error) {
        console.error("Error allocating payment:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to allocate payment",
            error: error.message,
        });
    }
};

/**
 * Auto-match payments to invoices
 */
exports.autoMatchPayments = async (req, res) => {
    try {
        const { cardCode, confidenceThreshold = 80 } = req.body;

        console.log(`Starting auto-match for customer: ${cardCode || "ALL"}`);

        const paymentFilter = {
            reconciliationStatus: "Unmatched",
            remainingAmount: { $gt: 0 },
        };

        if (cardCode) {
            paymentFilter.$or = [
                { cardCode: cardCode },
                { alternateCardCodes: cardCode },
            ];
        }

        const unmatchedPayments = await FlattenedPayment.find(paymentFilter).limit(100);

        console.log(`Found ${unmatchedPayments.length} unmatched payments`);

        const results = {
            processed: 0,
            matched: 0,
            failed: 0,
            matches: [],
        };

        for (const payment of unmatchedPayments) {
            try {
                results.processed++;

                // Find unpaid invoices for this customer (DocumentStatus = Open)
                const invoices = await Invoice.find({
                    CardCode: payment.cardCode,
                    DocumentStatus: { $in: ["bost_Open", "O"] },
                }).sort({ DocDate: 1 });

                if (invoices.length === 0) {
                    continue;
                }

                // Try to match by reference
                let matchedInvoice = null;
                let confidence = 0;

                if (payment.reference) {
                    // Try exact DocNum match
                    matchedInvoice = invoices.find(inv =>
                        inv.DocNum.toString() === payment.reference.replace(/\D/g, '')
                    );

                    if (matchedInvoice) {
                        confidence = 95;
                    } else {
                        // Try reference contains DocNum
                        matchedInvoice = invoices.find(inv =>
                            payment.reference.includes(inv.DocNum.toString())
                        );
                        if (matchedInvoice) {
                            confidence = 85;
                        }
                    }
                }

                // Try amount match
                if (!matchedInvoice) {
                    const amountMatches = invoices.filter(inv => {
                        // Calculate remaining: DocTotal - PaidToDate - any allocations
                        const totalPaid = inv.PaidToDate || 0;
                        const totalAllocated = (inv.allocatedPayments || []).reduce((sum, alloc) => sum + alloc.amountAllocated, 0);
                        const remaining = inv.DocTotal - totalPaid - totalAllocated;
                        return Math.abs(remaining - payment.remainingAmount) < 0.01;
                    });

                    if (amountMatches.length === 1) {
                        matchedInvoice = amountMatches[0];
                        confidence = 75;
                    }
                }

                // If confidence is high enough, create allocation
                if (matchedInvoice && confidence >= confidenceThreshold) {
                    // Calculate remaining balance properly
                    const totalPaid = matchedInvoice.PaidToDate || 0;
                    const totalAllocated = (matchedInvoice.allocatedPayments || []).reduce((sum, alloc) => sum + alloc.amountAllocated, 0);
                    const remaining = matchedInvoice.DocTotal - totalPaid - totalAllocated;

                    const amountToAllocate = Math.min(payment.remainingAmount, remaining);

                    // Add to payment
                    payment.matchedInvoices.push({
                        invoiceDocNum: matchedInvoice.DocNum,
                        invoiceDocEntry: matchedInvoice.DocEntry,
                        amountAllocated: amountToAllocate,
                        matchedDate: new Date(),
                    });

                    payment.autoMatchConfidence = confidence;
                    payment.calculateRemaining();
                    await payment.save();

                    // Add to invoice
                    if (!matchedInvoice.allocatedPayments) {
                        matchedInvoice.allocatedPayments = [];
                    }

                    matchedInvoice.allocatedPayments.push({
                        flattenedPaymentId: payment._id,
                        amountAllocated: amountToAllocate,
                        allocationDate: new Date(),
                        source: payment.source,
                    });

                    // Update invoice payment tracking
                    if (!matchedInvoice.paymentTracking) {
                        matchedInvoice.paymentTracking = {
                            totalInvoiceAmount: matchedInvoice.DocTotal,
                            totalPaidAmount: 0,
                            totalCreditAmount: 0,
                            remainingBalance: matchedInvoice.DocTotal,
                        };
                    }

                    matchedInvoice.paymentTracking.totalPaidAmount += amountToAllocate;
                    matchedInvoice.paymentTracking.remainingBalance -= amountToAllocate;

                    if (matchedInvoice.paymentTracking.remainingBalance <= 0.01) {
                        matchedInvoice.paymentStatus = "Fully Paid";
                    } else {
                        matchedInvoice.paymentStatus = "Partially Paid";
                    }

                    await matchedInvoice.save();

                    results.matched++;
                    results.matches.push({
                        paymentId: payment._id,
                        invoiceDocNum: matchedInvoice.DocNum,
                        amount: amountToAllocate,
                        confidence: confidence,
                    });

                    console.log(`✅ Matched payment ${payment._id} to invoice ${matchedInvoice.DocNum} (confidence: ${confidence}%)`);
                }

            } catch (error) {
                console.error(`Error processing payment ${payment._id}:`, error);
                results.failed++;
            }
        }

        // Update customer totals for all affected customers
        const affectedCustomers = new Set(unmatchedPayments.map(p => p.cardCode));
        for (const customerCode of affectedCustomers) {
            await updateCustomerPaymentTotals([customerCode]);
            await updateCustomerInvoiceTotals(customerCode);
        }

        console.log(`Auto-match completed: ${results.matched} matched out of ${results.processed} processed`);

        return res.status(200).json({
            success: true,
            message: `Auto-matched ${results.matched} payments`,
            data: results,
        });

    } catch (error) {
        console.error("Error in auto-match:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to auto-match payments",
            error: error.message,
        });
    }
};

// Helper function to update customer invoice totals
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
                    totalPaid: { $sum: "$paymentTracking.totalPaidAmount" },
                    totalUnpaid: { $sum: "$paymentTracking.remainingBalance" },
                },
            },
        ]);

        if (invoiceTotals.length > 0) {
            await Customer.findOneAndUpdate(
                { CardCode: cardCode },
                {
                    totalInvoiceAmount: invoiceTotals[0].totalInvoiceAmount,
                    totalInvoicePaid: invoiceTotals[0].totalPaid,
                    outstandingBalance: invoiceTotals[0].totalUnpaid,
                }
            );
        }
    } catch (error) {
        console.error(`Error updating invoice totals for ${cardCode}:`, error);
    }
}
/**
 * Import salary sheet and create payments
 */
exports.importSalarySheet = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "Excel file is required",
            });
        }

        console.log("Starting salary sheet import...");

        // Parse Excel file using existing controller logic
        const XLSX = require("xlsx");
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

        // Parse the sheet (reuse logic from salarySheet.controller.js)
        const parsedData = await parseSalarySheetData(rawData);

        // Extract all payments from parsed data
        const paymentsToCreate = [];
        const sheetDate = parsedData.metadata.date || new Date();

        // Process checks
        parsedData.deliveries.checks.forEach(payment => {
            if (payment.cardCode && payment.amount) {
                paymentsToCreate.push({
                    cardCode: payment.cardCode,
                    cardName: payment.client,
                    amount: payment.amount,
                    paymentDate: sheetDate,
                    reference: payment.checkNumber ? `CHK-${payment.checkNumber}` : null,
                    paymentMethod: "checks",
                    bank: payment.bank,
                    checkNumber: payment.checkNumber,
                    sap: payment.sap,
                    remarks: payment.remarks,
                    sheetDate: sheetDate,
                });
            }
        });

        // Process cash
        parsedData.deliveries.cash.forEach(payment => {
            if (payment.cardCode && payment.amount) {
                paymentsToCreate.push({
                    cardCode: payment.cardCode,
                    cardName: payment.client,
                    amount: payment.amount,
                    paymentDate: sheetDate,
                    reference: `CASH-${sheetDate.toISOString().split('T')[0]}`,
                    paymentMethod: "cash",
                    sap: payment.sap,
                    remarks: payment.remarks,
                    sheetDate: sheetDate,
                });
            }
        });

        // Process credit card site
        parsedData.deliveries.creditCardSite.forEach(payment => {
            if (payment.cardCode && payment.amount) {
                paymentsToCreate.push({
                    cardCode: payment.cardCode,
                    cardName: payment.client,
                    amount: payment.amount,
                    paymentDate: sheetDate,
                    reference: `CC-SITE-${payment.cardCode}`,
                    paymentMethod: "creditCardSite",
                    sap: payment.sap,
                    remarks: payment.remarks,
                    sheetDate: sheetDate,
                });
            }
        });

        // Process credit card phone
        parsedData.deliveries.creditCardPhone.forEach(payment => {
            if (payment.amount) {
                // These don't have cardCode yet, will be matched from frontend
                paymentsToCreate.push({
                    cardCode: "UNMATCHED",
                    cardName: payment.client,
                    amount: payment.amount,
                    paymentDate: sheetDate,
                    reference: `CC-PHONE-${payment.client}`,
                    paymentMethod: "creditCardPhone",
                    sheetDate: sheetDate,
                });
            }
        });

        // Process unpaid deliveries
        parsedData.deliveries.unpaid.forEach(payment => {
            if (payment.amount) {
                paymentsToCreate.push({
                    cardCode: payment.cardCode || "UNMATCHED",
                    cardName: payment.client,
                    amount: payment.amount,
                    paymentDate: sheetDate,
                    reference: `UNPAID-${payment.client}`,
                    paymentMethod: "unpaid",
                    sap: payment.sap,
                    remarks: payment.remarks,
                    sheetDate: sheetDate,
                });
            }
        });

        console.log(`Prepared ${paymentsToCreate.length} payments from salary sheet`);

        // Save to SalarySheetPayment collection
        const salaryPayments = await SalarySheetPayment.insertMany(
            paymentsToCreate.map(p => ({
                ...p,
                importedBy: req.user?._id,
            }))
        );

        console.log(`Saved ${salaryPayments.length} payments to SalarySheetPayment collection`);

        // Flatten to FlattenedPayment collection
        const flattenedPayments = await Promise.all(
            salaryPayments.map(async (payment) => {


                // Get customer name if not available
                let cardName = payment.cardName;
                if (!cardName) {
                    const customer = await Customer.findOne({ CardCode: payment.cardCode });
                    cardName = customer ? customer.CardName : payment.cardCode;
                }

                return {
                    cardCode: payment.cardCode,
                    cardName: cardName,
                    amount: payment.amount,
                    reference: payment.reference,
                    source: "salary_sheet",
                    paymentDate: payment.paymentDate,
                    sourceDocument: {
                        sourceType: "SalarySheetPayment",
                        sourceId: payment._id,
                    },
                    paymentMethod: payment.paymentMethod,
                    sourceDetails: {
                        bank: payment.bank,
                        checkNumber: payment.checkNumber,
                        sap: payment.sap,
                        remarks: payment.remarks,
                    },
                    remainingAmount: payment.amount,
                    importedBy: req.user?._id,
                };
            })
        );

        // Filter out nulls (UNMATCHED payments)
        const validFlattenedPayments = flattenedPayments.map(fp => {
            // If payment was marked as UNMATCHED, set cardCode to null instead
            if (fp && fp.cardCode === "UNMATCHED") {
                return {
                    ...fp,
                    cardCode: null,
                    reconciliationStatus: "Unmatched"
                };
            }
            return fp;
        }).filter(p => p !== null);
        const insertedFlattenedPayments = await FlattenedPayment.insertMany(validFlattenedPayments);

        console.log(`Created ${insertedFlattenedPayments.length} flattened payments`);

        // Update salary payments with flattenedPaymentId
        for (let i = 0; i < salaryPayments.length; i++) {
            if (validFlattenedPayments[i]) {
                salaryPayments[i].flattenedPaymentId = insertedFlattenedPayments[i]._id;
                await salaryPayments[i].save();
            }
        }

        // Update customer paymentNotAllocated
        await updateCustomerPaymentTotals(insertedFlattenedPayments.map(p => p.cardCode));

        return res.status(200).json({
            success: true,
            message: "Salary sheet imported successfully",
            data: {
                totalPayments: paymentsToCreate.length,
                salaryPayments: salaryPayments.length,
                flattenedPayments: insertedFlattenedPayments.length,
                unmatchedPayments: paymentsToCreate.length - validFlattenedPayments.length,
            },
        });

    } catch (error) {
        console.error("Error importing salary sheet:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to import salary sheet",
            error: error.message,
        });
    }
};

/**
 * Helper function to parse salary sheet data
 */
async function parseSalarySheetData(rawData) {
    // This is a simplified version - use the full logic from salarySheet.controller.js
    const parsedData = {
        metadata: {},
        deliveries: {
            checks: [],
            cash: [],
            creditCardSite: [],
            creditCardPhone: [],
            transfers: [],
            unpaid: [],
        },
    };

    // Parse date
    if (rawData[0] && rawData[0][8] === 'DATE' && rawData[0][9]) {
        const excelDate = rawData[0][9];
        const epoch = new Date(1900, 0, 1);
        const excelEpoch = new Date(epoch.getTime() + (excelDate - 2) * 86400000);
        parsedData.metadata.date = excelEpoch;
    }

    // Parse deliveries section (starting from row 18)
    let currentSection = null;
    for (let i = 18; i < rawData.length; i++) {
        const row = rawData[i];
        if (!row || row.every(cell => !cell)) continue;

        // Identify sections
        if (row[0] === 'Card Code' || row[1] === 'Paiements Chèques') {
            currentSection = 'checks';
            continue;
        } else if (row[1] === 'Paiements Espèces') {
            currentSection = 'cash';
            continue;
        } else if (row[1] === 'Paiements CB Site') {
            currentSection = 'creditCardSite';
            continue;
        } else if (row[1] === 'Paiements CB Téléphone') {
            currentSection = 'creditCardPhone';
            continue;
        } else if (row[1] === 'Virements') {
            currentSection = 'transfers';
            continue;
        } else if (row[1] === 'Livraisons non payées') {
            currentSection = 'unpaid';
            continue;
        }

        // Parse data based on section
        if (currentSection === 'checks' && row[0] && row[1]) {
            parsedData.deliveries.checks.push({
                cardCode: row[0],
                client: row[1],
                amount: row[4] || 0,
                bank: row[5] || '',
                checkNumber: row[6] || '',
                remarks: row[7] || '',
                sap: row[11] || '',
            });
        } else if (currentSection === 'cash' && row[0] && row[1]) {
            parsedData.deliveries.cash.push({
                cardCode: row[0],
                client: row[1],
                amount: row[4] || 0,
                remarks: row[5] || '',
                sap: row[11] || '',
            });
        } else if (currentSection === 'creditCardSite' && (row[0] || row[1] || row[2])) {
            parsedData.deliveries.creditCardSite.push({
                cardCode: row[0] || '',
                client: (row[1] || row[2] || '').trim(),
                amount: row[4] || 0,
                remarks: row[5] || '',
                sap: row[11] || '',
            });
        } else if (currentSection === 'creditCardPhone' && row[2]) {
            parsedData.deliveries.creditCardPhone.push({
                amount: row[2] || 0,
                client: row[3] || '',
            });
        } else if (currentSection === 'unpaid' && (row[1] || row[2])) {
            parsedData.deliveries.unpaid.push({
                client: (row[1] || row[2] || '').trim(),
                amount: row[4] || 0,
                remarks: row[5] || '',
                sap: row[11] || '',
            });
        }
    }

    return parsedData;
}

/**
 * Flatten bank statements to unified payments
 */
exports.flattenBankStatements = async (req, res) => {
    try {
        // Get all bank statements without matched customer
        const unmatchedStatements = await BankStatement.find({
            matchedCustomer: { $eq: null },
        });

        console.log(`Found ${unmatchedStatements.length} unmatched bank statements`);

        const flattenedPayments = [];

        for (const statement of unmatchedStatements) {
            // Try to match customer by reference or other fields
            let cardCode = statement.matchedCustomer;
            let cardName = null;



            flattenedPayments.push({
                cardCode: cardCode || null,  // Allow null cardCode
                cardName: cardName,
                amount: statement.amount,
                reference: statement.operationReference,
                source: "bred_bank",
                paymentDate: statement.operationDate,
                sourceDocument: {
                    sourceType: "BankStatement",
                    sourceId: statement._id,
                },
                sourceDetails: {
                    operationType: statement.operationType,
                    comment: statement.comment,
                    details: statement.details,
                },
                remainingAmount: statement.amount,
                reconciliationStatus: cardCode ? "Unmatched" : "Unmatched", // Will stay unmatched until customer assigned
            });
        }

        const inserted = await FlattenedPayment.insertMany(flattenedPayments);

        return res.status(200).json({
            success: true,
            message: `Flattened ${inserted.length} bank statements`,
            data: {
                total: unmatchedStatements.length,
                flattened: inserted.length,
                skipped: unmatchedStatements.length - inserted.length,
            },
        });

    } catch (error) {
        console.error("Error flattening bank statements:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to flatten bank statements",
            error: error.message,
        });
    }
};

/**
 * Flatten PayPal statements to unified payments
 */
exports.flattenPayPalStatements = async (req, res) => {
    try {
        const unmatchedStatements = await PayPalStatement.find({
            matchedCustomer: { $eq: null },
        });

        console.log(`Found ${unmatchedStatements.length} unmatched PayPal statements`);

        const flattenedPayments = [];

        for (const statement of unmatchedStatements) {
            let cardCode = statement.matchedCustomer;
            let cardName = null;

            // AFTER (updated code):
            flattenedPayments.push({
                cardCode: cardCode || null,  // Allow null cardCode
                cardName: cardName,
                amount: statement.netAmount,
                reference: statement.transactionId,
                source: "paypal",
                paymentDate: statement.date,
                sourceDocument: {
                    sourceType: "PayPalStatement",
                    sourceId: statement._id,
                },
                sourceDetails: {
                    type: statement.type,
                    status: statement.status,
                    fromEmail: statement.fromEmail,
                    toEmail: statement.toEmail,
                    invoiceNumber: statement.invoiceNumber,
                },
                remainingAmount: statement.netAmount,
                reconciliationStatus: cardCode ? "Unmatched" : "Unmatched",
            });
        }

        const inserted = await FlattenedPayment.insertMany(flattenedPayments);

        return res.status(200).json({
            success: true,
            message: `Flattened ${inserted.length} PayPal statements`,
            data: {
                total: unmatchedStatements.length,
                flattened: inserted.length,
                skipped: unmatchedStatements.length - inserted.length,
            },
        });

    } catch (error) {
        console.error("Error flattening PayPal statements:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to flatten PayPal statements",
            error: error.message,
        });
    }
};

/**
 * Update customer card code for payment (from frontend)
 */
exports.updatePaymentCardCode = async (req, res) => {
    try {
        const { paymentId, cardCode, cardCodes } = req.body;
        console.log("Updating payment card code:", paymentId, cardCode, cardCodes);

        if (!paymentId || (!cardCode && !cardCodes)) {
            return res.status(400).json({
                success: false,
                message: "Payment ID and cardCode(s) are required",
            });
        }

        // CHANGE 1: Find the FlattenedPayment directly (it should already exist)
        let flattenedPayment = await FlattenedPayment.findById(paymentId);

        if (!flattenedPayment) {
            return res.status(404).json({
                success: false,
                message: "Payment not found in flattened payments. Please ensure the payment was properly imported and flattened.",
            });
        }

        // Handle multiple card codes
        const cardCodeArray = cardCodes || [cardCode];
        const primaryCardCode = cardCodeArray[0];

        // Get customer name
        const customer = await Customer.findOne({ CardCode: primaryCardCode });
        if (!customer) {
            return res.status(404).json({
                success: false,
                message: `Customer with CardCode ${primaryCardCode} not found`,
            });
        }

        // CHANGE 2: Update the FlattenedPayment with customer info
        flattenedPayment.cardCode = primaryCardCode;
        flattenedPayment.cardName = customer.CardName;
        flattenedPayment.alternateCardCodes = cardCodeArray.slice(1);
        flattenedPayment.reconciliationStatus = "Unmatched"; // Still unmatched until allocated to invoice

        await flattenedPayment.save();

        // CHANGE 3: ALSO update the source document (BankStatement/PayPal/SalarySheet)
        if (flattenedPayment.sourceDocument && flattenedPayment.sourceDocument.sourceId) {
            const sourceType = flattenedPayment.sourceDocument.sourceType;
            const sourceId = flattenedPayment.sourceDocument.sourceId;

            let sourceModel;
            if (sourceType === "BankStatement") {
                sourceModel = BankStatement;
            } else if (sourceType === "PayPalStatement") {
                sourceModel = PayPalStatement;
            } else if (sourceType === "SalarySheetPayment") {
                sourceModel = SalarySheetPayment;
            }

            if (sourceModel) {
                await sourceModel.findByIdAndUpdate(sourceId, {
                    matchedCustomer: primaryCardCode,
                    cardCode: primaryCardCode,
                    reconciliationStatus: "Matched", // Customer matched, but not yet allocated to invoice
                });
            }
        }

        // CHANGE 4: Update customer payment totals
        await updateCustomerPaymentTotals([primaryCardCode, ...cardCodeArray.slice(1)]);

        return res.status(200).json({
            success: true,
            message: "Payment updated successfully with customer information",
            data: flattenedPayment,
        });

    } catch (error) {
        console.error("Error updating payment card code:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update payment",
            error: error.message,
        });
    }
};

/**
 * Helper function to update customer payment totals
 */
async function updateCustomerPaymentTotals(cardCodes) {
    const uniqueCardCodes = [...new Set(cardCodes)].filter(code => code && code !== "UNMATCHED"); // Filter out null/undefined

    for (const cardCode of uniqueCardCodes) {
        const totalPayments = await FlattenedPayment.aggregate([
            {
                $match: {
                    $or: [
                        { cardCode: cardCode },
                        { alternateCardCodes: cardCode },
                    ],
                },
            },
            {
                $group: {
                    _id: null,
                    totalAmount: { $sum: "$amount" },
                    totalAllocated: { $sum: "$totalAllocated" },
                    totalRemaining: { $sum: "$remainingAmount" },
                },
            },
        ]);

        if (totalPayments.length > 0) {
            await Customer.findOneAndUpdate(
                { CardCode: cardCode },
                {
                    totalPaymentsReceived: totalPayments[0].totalAmount,
                    "paymentAllocation.allocatedPayments": totalPayments[0].totalAllocated,
                    "paymentAllocation.unallocatedPayments": totalPayments[0].totalRemaining,
                    paymentNotAllocated: totalPayments[0].totalRemaining,
                    "paymentAllocation.lastUpdated": new Date(),
                }
            );
        }
    }
}

/**
 * Helper functions to find customers
 */
async function findCustomerFromBankStatement(statement) {
    // Try to match by details
    const detailsText = Object.values(statement.details || {}).join(" ").toLowerCase();

    // Try to find customer by name in details
    const customers = await Customer.find({ CardName: { $exists: true } });

    for (const customer of customers) {
        if (detailsText.includes(customer.CardName.toLowerCase())) {
            return customer;
        }
    }

    return null;
}

async function findCustomerFromPayPalStatement(statement) {
    // Try to match by invoice number
    if (statement.invoiceNumber) {
        const invoice = await Invoice.findOne({ DocNum: parseInt(statement.invoiceNumber) });
        if (invoice) {
            return await Customer.findOne({ CardCode: invoice.CardCode });
        }
    }

    // Try to match by email
    if (statement.fromEmail) {
        return await Customer.findOne({ Email: statement.fromEmail });
    }

    return null;
}

