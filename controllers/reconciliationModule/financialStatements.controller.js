// controllers/financialStatements.controller.js
// ADD THESE NEW FUNCTIONS TO THE EXISTING CONTROLLER

const FlattenedPayment = require("../../models/FlattenedPayment");
const SalarySheetPayment = require("../../models/SalarySheetPayment");
const Customer = require("../../models/Customer");
const Invoice = require("../../models/Invoice");
const BankStatement = require("../../models/BankStatement");
const PayPalStatement = require("../../models/PayPalStatement");
const sapPaymentService = require("../../services/sapPaymentService");
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

        const filter = {
            amount: { $gt: 0 }, // ✅ Only show positive payments
            remainingAmount: { $gt: 0 } // ✅ Only show payments with remaining balance
        };

        // ... rest of existing filter logic stays the same
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
            filter.amount = filter.amount || {};
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
 * ✅ UPDATED: Allocate payment to invoice WITH SAP INTEGRATION
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

        // Check if invoice is open
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

        // Calculate invoice remaining balance
        const totalPaid = invoice.PaidToDate || 0;
        const totalAllocated = (invoice.allocatedPayments || []).reduce((sum, alloc) => sum + alloc.amountAllocated, 0);
        const invoiceRemaining = invoice.DocTotal - totalPaid - totalAllocated;

        let differenceOfAllocation = amountToAllocate - invoiceRemaining;

        // if (differenceOfAllocation > 1 || differenceOfAllocation < -1) {
        //     return res.status(400).json({
        //         success: false,
        //         message: `Invoice only needs ${invoiceRemaining}, cannot allocate ${amountToAllocate}`,
        //     });
        // }

        // ✅ NEW: Create payment in SAP
        let sapPaymentDocEntry = null;
        let sapError = null;

        try {
            // Determine payment method and account based on source
            let paymentMethod = {};

            // Map payment source to SAP payment method
            if (payment.source === 'bred_bank' || payment.paymentMethod === 'VIREMENT') {
                paymentMethod.TransferSum = amountToAllocate;
                paymentMethod.TransferAccount = process.env.SAP_BANK_ACCOUNT || '_SYS00000000001';
            } else if (payment.source === 'paypal') {
                paymentMethod.TransferSum = amountToAllocate;
                paymentMethod.TransferAccount = process.env.SAP_PAYPAL_ACCOUNT || '_SYS00000000002';
            } else if (payment.paymentMethod === 'checks' || payment.paymentMethod?.toLowerCase().includes('cheque')) {
                paymentMethod.CheckSum = amountToAllocate;  // Only add CheckSum when needed

                if (payment.sourceDetails?.checkNumber) {
                    paymentMethod.PaymentChecks = [{
                        CheckNumber: payment.sourceDetails.checkNumber,
                        BankCode: payment.sourceDetails.bank || '',
                        CheckSum: amountToAllocate,
                        DueDate: payment.paymentDate,
                    }];
                    paymentMethod.CheckAccount = process.env.SAP_CHEQUE_ACCOUNT || '_SYS00000000003';
                }
            } else if (payment.paymentMethod?.toLowerCase().includes('cash')) {
                paymentMethod.CashSum = amountToAllocate;
                paymentMethod.CashAccount = process.env.SAP_CASH_ACCOUNT || '_SYS00000000003';
            } else if (payment.paymentMethod?.toLowerCase().includes('credit')) {
                // For credit card payments, use CashSum and specify the account
                paymentMethod.CashSum = amountToAllocate;
                paymentMethod.CashAccount = process.env.SAP_CREDIT_CARD_ACCOUNT || '511003';

                // Don't use PaymentCreditCards array unless you have valid credit card codes in SAP
                // If you want to track card details, just add to remarks
            } else {
                // Default to bank transfer
                paymentMethod.TransferSum = amountToAllocate;
                paymentMethod.TransferAccount = process.env.SAP_BANK_ACCOUNT || '_SYS00000000001';
            }

            const invoiceDate = new Date(invoice.DocDate);
            const paymentDate = new Date(payment.paymentDate);
            const reconciliationDate = invoiceDate > paymentDate ? invoiceDate : paymentDate;


            const sapPaymentData = {
                CardCode: invoice.CardCode,
                DocDate: reconciliationDate.toISOString().split('T')[0], // ✅ USE reconciliationDate
                TaxDate: reconciliationDate.toISOString().split('T')[0], // ✅ USE reconciliationDate
                Remarks: notes || `Payment from ${payment.source} - Ref: ${payment.reference || 'N/A'} (Payment date: ${paymentDate.toISOString().split('T')[0]})`,
                ...paymentMethod,
                PaymentInvoices: [{
                    DocEntry: invoice.DocEntry,
                    InvoiceType: 'it_Invoice',
                    SumApplied: amountToAllocate,
                }],
            };

            console.log('Creating SAP payment:', JSON.stringify(sapPaymentData, null, 2));

            const sapResponse = await sapPaymentService.createIncomingPayment(sapPaymentData);
            sapPaymentDocEntry = sapResponse.DocEntry;

            console.log(`✅ SAP Payment created: DocEntry ${sapPaymentDocEntry}`);



        } catch (error) {
            console.error('❌ SAP Payment Creation Error:', error);
            sapError = error.message;

            // Continue with local allocation even if SAP fails
        }

        // ✅ ONLY UPDATE LOCAL DB IF SAP SYNC WAS SUCCESSFUL
        if (sapPaymentDocEntry) {
            // Add allocation to payment
            payment.matchedInvoices.push({
                invoiceDocNum: invoice.DocNum,
                invoiceDocEntry: invoice.DocEntry,
                amountAllocated: amountToAllocate,
                matchedDate: new Date(),
                matchedBy: req.user?._id,
                sapPaymentDocEntry: sapPaymentDocEntry,
            });

            payment.calculateRemaining();
            await payment.save();

            // Add allocation to invoice
            if (!invoice.allocatedPayments) {
                invoice.allocatedPayments = [];
            }

            invoice.allocatedPayments.push({
                flattenedPaymentId: payment._id,
                creditNoteId: null,
                allocationType: 'payment',
                amountAllocated: amountToAllocate,
                allocationDate: new Date(),
                allocatedBy: req.user?._id,
                source: payment.source,
                notes: notes,
                sapPaymentDocEntry: sapPaymentDocEntry,
                sapSyncStatus: 'synced',
                sapSyncError: null,
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

            // Update breakdown
            if (!invoice.paymentBreakdown) {
                invoice.paymentBreakdown = {
                    actualPayments: 0,
                    creditNotes: 0,
                    outstandingBalance: 0
                };
            }

            invoice.paymentBreakdown.actualPayments += amountToAllocate;
            invoice.paymentTracking.totalPaidAmount += amountToAllocate;
            invoice.paymentTracking.remainingBalance -= amountToAllocate;

            invoice.paymentTracking.lastPaymentDate = new Date();
            invoice.paymentTracking.lastPaymentAmount = amountToAllocate;

            // Update payment status
            if (invoice.paymentTracking.remainingBalance <= 0.01) {
                invoice.paymentStatus = "Fully Paid";
                invoice.DocumentStatus = "bost_Close";
            } else if (invoice.paymentTracking.totalPaidAmount > 0) {
                invoice.paymentStatus = "Partially Paid";
            }

            await invoice.save();

            // Update customer totals
            await updateCustomerPaymentTotals([payment.cardCode]);
            await updateCustomerInvoiceTotals(invoice.CardCode);
        } else {
            // ✅ SAP SYNC FAILED - Don't update local DB, return error immediately
            return res.status(500).json({
                success: false,
                message: "Failed to sync payment to SAP. Local database not updated to prevent inconsistencies.",
                error: sapError,
                data: {
                    payment: {
                        _id: payment._id,
                        amount: payment.amount,
                        remainingAmount: payment.remainingAmount,
                    },
                    invoice: {
                        DocNum: invoice.DocNum,
                        DocTotal: invoice.DocTotal,
                    },
                },
            });
        }
        // ✅ This return will only execute if SAP sync was successful
        return res.status(200).json({
            success: true,
            message: "Payment allocated and synced to SAP successfully",
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
                    paymentBreakdown: invoice.paymentBreakdown
                },
                sapSync: {
                    synced: !!sapPaymentDocEntry,
                    sapPaymentDocEntry: sapPaymentDocEntry,
                    error: sapError,
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
 * ✅ UPDATED: Allocate outstanding balance to invoice WITH SAP INTEGRATION
 */
exports.allocateOutstandingBalanceToInvoice = async (req, res) => {
    try {
        const { invoiceDocNum, amountToAllocate, notes } = req.body;

        if (!invoiceDocNum || !amountToAllocate || amountToAllocate <= 0) {
            console.log("Invalid invoice DocNum or amount to allocate");
            console.log({ invoiceDocNum, amountToAllocate });
            return res.status(400).json({
                success: false,
                message: "Invoice DocNum and valid amount are required",
            });
        }

        console.log(`Allocating ${amountToAllocate} from outstanding balance to invoice ${invoiceDocNum}`);

        // Find invoice
        const invoice = await Invoice.findOne({ DocNum: invoiceDocNum });
        if (!invoice) {
            return res.status(404).json({
                success: false,
                message: "Invoice not found",
            });
        }

        // Check if invoice is open
        if (!["bost_Open", "O"].includes(invoice.DocumentStatus)) {
            console.log(`Invoice ${invoiceDocNum} is already closed/paid with status ${invoice.DocumentStatus}`);
            return res.status(400).json({
                success: false,
                message: "Invoice is already closed/paid",
            });
        }

        // Find customer
        const customer = await Customer.findOne({ CardCode: invoice.CardCode });
        if (!customer) {
            return res.status(404).json({
                success: false,
                message: "Customer not found",
            });
        }

        // Calculate available outstanding balance
        const sapBalance = customer.outstandingBalance || 0;
        const localUsed = customer.outstandingBalanceUsed || 0;

        // ✅ FIX: Only negative balance is available to allocate
        if (sapBalance >= 0) {
            return res.status(400).json({
                success: false,
                message: `Customer has no prepaid balance. Outstanding balance must be negative to allocate. Current balance: €${sapBalance.toFixed(2)}`,
                data: {
                    sapBalance,
                    localUsed,
                    availableBalance: 0
                }
            });
        }

        // Convert to positive for allocation (negative balance = available credit)
        const availableBalance = Math.abs(sapBalance);

        console.log(`Customer ${customer.CardCode} - SAP Balance: ${sapBalance}, Local Used: ${localUsed}, Available: ${availableBalance}`);

        if (availableBalance <= 0) {
            return res.status(400).json({
                success: false,
                message: `No prepaid balance available. Customer has already used all prepaid credit.`,
                data: {
                    sapBalance,
                    localUsed,
                    availableBalance: 0
                }
            });
        }

        if (availableBalance < amountToAllocate) {
            console.log(`Insufficient prepaid balance. Available: €${availableBalance.toFixed(2)}, Requested: €${amountToAllocate.toFixed(2)}`)
            return res.status(400).json({
                success: false,
                message: `Insufficient prepaid balance. Available: €${availableBalance.toFixed(2)}, Requested: €${amountToAllocate.toFixed(2)}`,
                data: {
                    sapBalance,
                    localUsed,
                    availableBalance
                }
            });
        }

        // Calculate invoice remaining
        const totalPaid = invoice.PaidToDate || 0;
        const totalAllocated = (invoice.allocatedPayments || []).reduce((sum, alloc) => sum + alloc.amountAllocated, 0);
        const invoiceRemaining = invoice.DocTotal - totalPaid - totalAllocated;

        if (amountToAllocate > invoiceRemaining + 1) {
            return res.status(400).json({
                success: false,
                message: `Cannot allocate more than invoice balance. Invoice needs: €${invoiceRemaining.toFixed(2)}, Requested: €${amountToAllocate.toFixed(2)}`,
            });
        }

        // ✅ NEW: Close invoice in SAP (but don't create payment)
        let sapClosed = false;
        let sapError = null;
        let sapResponse = null; // ← ADD THIS LINE

        try {
            // When using outstanding balance (prepayment), we need to create an Incoming Payment
            // that applies the prepayment to the invoice

            const sapPaymentData = {
                CardCode: invoice.CardCode,
                DocDate: new Date().toISOString().split('T')[0],
                TaxDate: new Date().toISOString().split('T')[0],
                Remarks: notes || `Outstanding balance applied - Prepayment allocation`,
                // Use CashSum with the On Account clearing account
                CashSum: amountToAllocate,
                CashAccount: process.env.SAP_ON_ACCOUNT_CLEARING || '_SYS00000000099', // On Account clearing account
                PaymentInvoices: [{
                    DocEntry: invoice.DocEntry,
                    InvoiceType: 'it_Invoice',
                    SumApplied: amountToAllocate,
                }],
            };

            console.log('Creating SAP payment from outstanding balance:', JSON.stringify(sapPaymentData, null, 2));

            sapResponse = await sapPaymentService.createIncomingPayment(sapPaymentData);
            const sapPaymentDocEntry = sapResponse.DocEntry;

            sapClosed = true;
            console.log(`✅ SAP Payment created from outstanding balance: DocEntry ${sapPaymentDocEntry}`);

        } catch (error) {
            console.error('❌ SAP Payment Creation Error:', error);
            sapError = error.message;
        }

        // Add allocation to invoice
        if (!invoice.allocatedPayments) {
            invoice.allocatedPayments = [];
        }

        invoice.allocatedPayments.push({
            flattenedPaymentId: null,
            creditNoteId: null,
            allocationType: 'outstanding_balance',
            amountAllocated: amountToAllocate,
            allocationDate: new Date(),
            allocatedBy: req.user?._id,
            notes: notes || `Outstanding balance applied by ${req.user?.firstName || 'system'}`,
            sapPaymentDocEntry: sapClosed ? sapResponse.DocEntry : null, // Store SAP payment DocEntry
            sapSyncStatus: sapClosed ? 'synced' : 'pending',
            sapSyncError: sapError,
        });

        // Update payment tracking
        if (!invoice.paymentTracking) {
            invoice.paymentTracking = {
                totalInvoiceAmount: invoice.DocTotal,
                totalPaidAmount: 0,
                totalCreditAmount: 0,
                remainingBalance: invoice.DocTotal,
            };
        }

        // Update breakdown
        if (!invoice.paymentBreakdown) {
            invoice.paymentBreakdown = {
                actualPayments: 0,
                creditNotes: 0,
                outstandingBalance: 0
            };
        }

        invoice.paymentBreakdown.outstandingBalance += amountToAllocate;
        invoice.paymentTracking.totalPaidAmount += amountToAllocate;
        invoice.paymentTracking.remainingBalance -= amountToAllocate;

        // Update payment status
        if (invoice.paymentTracking.remainingBalance <= 0.01) {
            invoice.paymentStatus = "Fully Paid";
            invoice.DocumentStatus = "bost_Close";
        } else {
            invoice.paymentStatus = "Partially Paid";
        }

        // Mark if SAP sync needed
        if (!sapClosed && invoiceRemaining - amountToAllocate <= 0.01) {
            invoice.paymentSyncStatus = {
                needsSync: true,
                lastSyncAttempt: new Date(),
                syncErrors: sapError,
            };
        }

        await invoice.save();

        // Return appropriate response based on SAP sync status
        if (sapClosed) {
            return res.status(200).json({
                success: true,
                message: "Outstanding balance allocated and synced to SAP successfully",
                data: {
                    invoice: {
                        DocNum: invoice.DocNum,
                        paymentStatus: invoice.paymentStatus,
                        remainingBalance: invoice.paymentTracking.remainingBalance,
                        paymentBreakdown: invoice.paymentBreakdown
                    },
                    customer: {
                        CardCode: customer.CardCode,
                        sapOutstandingBalance: customer.outstandingBalance,
                        localUsed: customer.outstandingBalanceUsed,
                        availableBalance: customer.availableOutstandingBalance
                    },
                    sapSync: {
                        synced: true,
                        sapPaymentDocEntry: sapResponse?.DocEntry,
                    },
                },
            });
        } else {
            // SAP sync failed - rollback local changes
            return res.status(500).json({
                success: false,
                message: "Failed to sync outstanding balance allocation to SAP. Local database not updated to prevent inconsistencies.",
                error: sapError,
                data: {
                    invoice: {
                        DocNum: invoice.DocNum,
                        remainingBalance: invoiceRemaining,
                    },
                    customer: {
                        CardCode: customer.CardCode,
                        availableBalance: availableBalance,
                    },
                },
            });
        }

    } catch (error) {
        console.error("Error allocating outstanding balance:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to allocate outstanding balance",
            error: error.message,
        });
    }
};

/**
 * ✅ NEW: Retry failed SAP syncs
 */
exports.retrySAPSync = async (req, res) => {
    try {
        const { invoiceDocNum } = req.body;

        const invoice = await Invoice.findOne({ DocNum: invoiceDocNum });
        if (!invoice) {
            return res.status(404).json({
                success: false,
                message: "Invoice not found",
            });
        }

        if (!invoice.paymentSyncStatus?.needsSync) {
            return res.status(400).json({
                success: false,
                message: "Invoice doesn't need SAP sync",
            });
        }

        // Get all pending allocations
        const pendingAllocations = (invoice.allocatedPayments || []).filter(
            alloc => alloc.sapSyncStatus === 'pending'
        );

        if (pendingAllocations.length === 0) {
            return res.status(400).json({
                success: false,
                message: "No pending allocations to sync",
            });
        }

        const results = {
            successful: [],
            failed: [],
        };

        for (const allocation of pendingAllocations) {
            try {
                if (allocation.allocationType === 'payment') {
                    // Find the payment
                    const payment = await FlattenedPayment.findById(allocation.flattenedPaymentId);
                    if (!payment) continue;

                    // Create payment in SAP (use same logic as allocatePaymentToInvoice)
                    const sapPaymentData = {
                        CardCode: invoice.CardCode,
                        DocDate: new Date(allocation.allocationDate).toISOString().split('T')[0],
                        TaxDate: new Date().toISOString().split('T')[0],
                        Remarks: allocation.notes || `Retry sync - ${payment.source}`,
                        TransferSum: allocation.amountAllocated,
                        TransferAccount: process.env.SAP_BANK_ACCOUNT || '_SYS00000000001',
                        PaymentInvoices: [{
                            DocEntry: invoice.DocEntry,
                            InvoiceType: 'it_Invoice',
                            SumApplied: allocation.amountAllocated,
                        }],
                    };

                    const sapResponse = await sapPaymentService.createIncomingPayment(sapPaymentData);

                    // Update allocation
                    allocation.sapPaymentDocEntry = sapResponse.DocEntry;
                    allocation.sapSyncStatus = 'synced';
                    allocation.sapSyncError = null;

                    results.successful.push(allocation);

                } else if (allocation.allocationType === 'outstanding_balance') {

                    allocation.sapSyncStatus = 'synced';
                    allocation.sapSyncError = null;

                    results.successful.push(allocation);
                }

            } catch (error) {
                console.error(`SAP Sync retry failed for allocation:`, error);
                allocation.sapSyncError = error.message;
                results.failed.push(allocation);
            }
        }

        // Update invoice sync status
        if (results.failed.length === 0) {
            invoice.paymentSyncStatus.needsSync = false;
        }
        invoice.paymentSyncStatus.lastSyncAttempt = new Date();

        await invoice.save();

        return res.status(200).json({
            success: true,
            message: `Synced ${results.successful.length} allocations, ${results.failed.length} failed`,
            data: {
                successful: results.successful.length,
                failed: results.failed.length,
                invoice: {
                    DocNum: invoice.DocNum,
                    needsSync: invoice.paymentSyncStatus.needsSync,
                },
            },
        });

    } catch (error) {
        console.error("Error retrying SAP sync:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to retry SAP sync",
            error: error.message,
        });
    }
};

/**
 * ✅ CORRECTED FINAL VERSION: Allocate credit note to invoice
 * Uses customer's on-account balance (credit note creates credit balance)
 */
exports.allocateCreditNoteToInvoice = async (req, res) => {
    try {
        const { creditNoteDocNum, invoiceDocNum, amountToAllocate, notes } = req.body;

        if (!creditNoteDocNum || !invoiceDocNum || !amountToAllocate || amountToAllocate <= 0) {
            return res.status(400).json({
                success: false,
                message: "Credit note DocNum, invoice DocNum, and valid amount are required",
            });
        }

        console.log(`Allocating ${amountToAllocate} from credit note ${creditNoteDocNum} to invoice ${invoiceDocNum}`);

        // Find credit note
        const CreditNotes = require("../../models/CreditNotes");
        const creditNote = await CreditNotes.findOne({ DocNum: creditNoteDocNum });

        if (!creditNote) {
            return res.status(404).json({
                success: false,
                message: "Credit note not found",
            });
        }

        // Calculate credit note remaining amount
        const creditNoteUsed = (creditNote.allocatedToInvoices || []).reduce((sum, alloc) => sum + alloc.amountAllocated, 0);
        const creditNoteRemaining = (creditNote.DocTotal || 0) - creditNoteUsed;

        console.log(`Credit note ${creditNoteDocNum} - Total: ${creditNote.DocTotal}, Used: ${creditNoteUsed}, Remaining: ${creditNoteRemaining}`);

        if (creditNoteRemaining < amountToAllocate) {
            return res.status(400).json({
                success: false,
                message: `Insufficient credit note balance. Available: €${creditNoteRemaining.toFixed(2)}, Requested: €${amountToAllocate.toFixed(2)}`,
                data: {
                    creditNoteTotal: creditNote.DocTotal,
                    creditNoteUsed,
                    creditNoteRemaining
                }
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

        // Check if invoice is open
        if (!["bost_Open", "O"].includes(invoice.DocumentStatus)) {
            return res.status(400).json({
                success: false,
                message: "Invoice is already closed/paid",
            });
        }

        // Verify same customer
        if (invoice.CardCode !== creditNote.CardCode) {
            return res.status(400).json({
                success: false,
                message: "Credit note and invoice must belong to same customer",
                data: {
                    invoiceCustomer: invoice.CardCode,
                    creditNoteCustomer: creditNote.CardCode
                }
            });
        }

        // Calculate invoice remaining
        const totalPaid = invoice.PaidToDate || 0;
        const totalAllocated = (invoice.allocatedPayments || []).reduce((sum, alloc) => sum + alloc.amountAllocated, 0);
        const invoiceRemaining = invoice.DocTotal - totalPaid - totalAllocated;

        if (amountToAllocate > invoiceRemaining + 1) {
            return res.status(400).json({
                success: false,
                message: `Cannot allocate more than invoice balance. Invoice needs: €${invoiceRemaining.toFixed(2)}, Requested: €${amountToAllocate.toFixed(2)}`,
            });
        }

        // ✅ Calculate newRemainingAmount early
        const newRemainingAmount = creditNoteRemaining - amountToAllocate;

        // ✅ CORRECTED APPROACH: Create payment using on-account balance
        let sapPaymentDocEntry = null;
        let sapError = null;
        let creditNoteUpdateSuccess = false;

        try {
            const invoiceDate = new Date(invoice.DocDate);
            const creditNoteDate = new Date(creditNote.DocDate);
            const reconciliationDate = invoiceDate > creditNoteDate ? invoiceDate : creditNoteDate;

            // ✅ ONLY include the invoice, use CashAccount as "on account" payment
            const sapPaymentData = {
                CardCode: invoice.CardCode,
                DocDate: reconciliationDate.toISOString().split('T')[0],
                TaxDate: reconciliationDate.toISOString().split('T')[0],
                Remarks: notes || `Applied Credit Note ${creditNoteDocNum} (DocEntry: ${creditNote.DocEntry}) to Invoice ${invoiceDocNum}`,
                // ✅ Use CashSum with on-account clearing - represents using customer's credit balance
                CashSum: amountToAllocate,
                CashAccount: process.env.SAP_ON_ACCOUNT_CLEARING || '_SYS00000000099', // On Account clearing
                // ✅ ONLY include the invoice being paid
                PaymentInvoices: [
                    {
                        DocEntry: invoice.DocEntry,
                        InvoiceType: 'it_Invoice',
                        SumApplied: amountToAllocate,
                    }
                ],
            };

            console.log('Creating SAP payment using credit note balance:', JSON.stringify(sapPaymentData, null, 2));

            const sapResponse = await sapPaymentService.createIncomingPayment(sapPaymentData);
            sapPaymentDocEntry = sapResponse.DocEntry;

            console.log(`✅ SAP Payment created: DocEntry ${sapPaymentDocEntry}`);

            // ✅ NOW manually link the credit note by updating it in SAP
            // This closes the credit note by marking it as applied
            try {
                console.log(`Attempting to update SAP Credit Note ${creditNote.DocEntry}...`);
                console.log(`New remaining amount: ${newRemainingAmount}`);
                console.log(`Should close? ${newRemainingAmount <= 0.01}`);

                const updatePayload = {
                    U_AppliedToInvoice: invoiceDocNum.toString(),
                    U_AppliedAmount: amountToAllocate,
                    U_PaymentDocEntry: sapPaymentDocEntry,
                };

                // Only update DocumentStatus if fully consumed
                if (newRemainingAmount <= 0.01) {
                    updatePayload.DocumentStatus = 'bost_Close';
                }

                console.log('Credit Note Update Payload:', JSON.stringify(updatePayload, null, 2));

                await sapPaymentService.patch(`/CreditNotes(${creditNote.DocEntry})`, updatePayload);

                creditNoteUpdateSuccess = true;
                console.log(`✅ Updated credit note ${creditNoteDocNum} in SAP`);

            } catch (cnError) {
                console.error('❌ Failed to update credit note in SAP:', cnError);
                console.error('Error details:', cnError.response?.data || cnError.message);

                // Store the error but don't fail the whole operation
                sapError = cnError.message;
            }

        } catch (error) {
            console.error('❌ SAP Payment Creation Error:', error);
            sapError = error.message;
        }

        // ✅ ONLY UPDATE LOCAL DB IF SAP SYNC WAS SUCCESSFUL
        if (!sapPaymentDocEntry) {
            return res.status(500).json({
                success: false,
                message: "Failed to apply credit note in SAP. Local database not updated to prevent inconsistencies.",
                error: sapError,
                data: {
                    invoice: {
                        DocNum: invoice.DocNum,
                        DocEntry: invoice.DocEntry,
                        remainingBalance: invoiceRemaining,
                    },
                    creditNote: {
                        DocNum: creditNote.DocNum,
                        DocEntry: creditNote.DocEntry,
                        remainingAmount: creditNoteRemaining,
                    },
                },
            });
        }

        // ✅ Update Invoice in local DB
        if (!invoice.allocatedPayments) {
            invoice.allocatedPayments = [];
        }

        invoice.allocatedPayments.push({
            flattenedPaymentId: null,
            creditNoteId: creditNote._id,
            allocationType: 'credit_note',
            amountAllocated: amountToAllocate,
            allocationDate: new Date(),
            allocatedBy: req.user?._id,
            source: 'credit_note',
            notes: notes || `Credit note #${creditNoteDocNum} applied`,
            sapPaymentDocEntry: sapPaymentDocEntry,
            sapSyncStatus: 'synced',
            sapSyncError: null,
        });

        // Update payment tracking
        if (!invoice.paymentTracking) {
            invoice.paymentTracking = {
                totalInvoiceAmount: invoice.DocTotal,
                totalPaidAmount: 0,
                totalCreditAmount: 0,
                remainingBalance: invoice.DocTotal,
            };
        }

        // Update breakdown
        if (!invoice.paymentBreakdown) {
            invoice.paymentBreakdown = {
                actualPayments: 0,
                creditNotes: 0,
                outstandingBalance: 0
            };
        }

        invoice.paymentBreakdown.creditNotes += amountToAllocate;
        invoice.paymentTracking.totalCreditAmount += amountToAllocate;
        invoice.paymentTracking.remainingBalance -= amountToAllocate;

        // ✅ Update PaidToDate to reflect SAP state
        invoice.PaidToDate = (invoice.PaidToDate || 0) + amountToAllocate;

        // Update payment status
        if (invoice.paymentTracking.remainingBalance <= 0.01) {
            invoice.paymentStatus = "Fully Paid";
            invoice.DocumentStatus = "bost_Close";
        } else {
            invoice.paymentStatus = "Partially Paid";
        }

        await invoice.save();

        // ✅ Update Credit Note in local DB
        if (!creditNote.allocatedToInvoices) {
            creditNote.allocatedToInvoices = [];
        }

        creditNote.allocatedToInvoices.push({
            invoiceDocNum: invoice.DocNum,
            invoiceDocEntry: invoice.DocEntry,
            amountAllocated: amountToAllocate,
            allocationDate: new Date(),
            sapPaymentDocEntry: sapPaymentDocEntry,
        });

        // ✅ Update remaining amount
        creditNote.remainingAmount = newRemainingAmount;

        // ✅ Mark as fully allocated if consumed
        if (newRemainingAmount <= 0.01) {
            creditNote.fullyAllocated = true;
            creditNote.DocumentStatus = "bost_Close";
        }

        // ✅ Store SAP sync status for credit note
        creditNote.sapSyncStatus = {
            paymentSynced: true,
            creditNoteUpdateSynced: creditNoteUpdateSuccess,
            lastSyncAttempt: new Date(),
            syncError: creditNoteUpdateSuccess ? null : sapError,
        };

        await creditNote.save();

        // ✅ Update customer totals
        //await updateCustomerInvoiceTotals(invoice.CardCode);

        console.log(`✅ Successfully allocated ${amountToAllocate} from credit note ${creditNoteDocNum} to invoice ${invoiceDocNum}`);
        console.log(`   Invoice remaining: ${invoice.paymentTracking.remainingBalance}`);
        console.log(`   Credit note remaining: ${creditNote.remainingAmount}`);
        console.log(`   SAP credit note update: ${creditNoteUpdateSuccess ? 'SUCCESS' : 'FAILED'}`);

        return res.status(200).json({
            success: true,
            message: creditNoteUpdateSuccess
                ? "Credit note allocated and synced to SAP successfully"
                : "Credit note allocated, but SAP credit note update failed (payment was created)",
            data: {
                invoice: {
                    DocNum: invoice.DocNum,
                    DocEntry: invoice.DocEntry,
                    paymentStatus: invoice.paymentStatus,
                    DocumentStatus: invoice.DocumentStatus,
                    PaidToDate: invoice.PaidToDate,
                    remainingBalance: invoice.paymentTracking.remainingBalance,
                    paymentBreakdown: invoice.paymentBreakdown
                },
                creditNote: {
                    DocNum: creditNote.DocNum,
                    DocEntry: creditNote.DocEntry,
                    totalAmount: creditNote.DocTotal,
                    usedAmount: creditNote.DocTotal - newRemainingAmount,
                    remainingAmount: newRemainingAmount,
                    fullyAllocated: creditNote.fullyAllocated,
                    DocumentStatus: creditNote.DocumentStatus
                },
                sapSync: {
                    paymentSynced: true,
                    sapPaymentDocEntry: sapPaymentDocEntry,
                    creditNoteUpdateSynced: creditNoteUpdateSuccess,
                    creditNoteUpdateError: creditNoteUpdateSuccess ? null : sapError,
                },
            },
        });

    } catch (error) {
        console.error("Error allocating credit note:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to allocate credit note",
            error: error.message,
        });
    }
};
/**
 * Get available credit notes for customer
 */
exports.getAvailableCreditNotesByCustomer = async (req, res) => {
    try {
        const { cardCode } = req.params;
        const {
            page = 1,
            limit = 50,
        } = req.query;

        const CreditNotes = require("../../models/CreditNotes");

        // Get credit notes that are not fully allocated
        const filter = {
            CardCode: cardCode,
            fullyAllocated: { $ne: true },
            Cancelled: { $ne: "Y" },
            DocTotal: { $gt: 0 },
        };

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const creditNotes = await CreditNotes.find(filter)
            .sort({ DocDate: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .lean();

        // Calculate remaining amount for each credit note
        const creditNotesWithRemaining = creditNotes.map(cn => {
            const used = (cn.allocatedToInvoices || []).reduce((sum, alloc) => sum + alloc.amountAllocated, 0);
            return {
                ...cn,
                usedAmount: used,
                remainingAmount: (cn.DocTotal || 0) - used,
            };
        });

        // Filter out fully allocated ones (in case remainingAmount field wasn't updated)
        const availableCreditNotes = creditNotesWithRemaining.filter(cn => cn.remainingAmount > 0.01);

        const total = await CreditNotes.countDocuments(filter);

        // Calculate summary
        const summary = {
            totalCreditNotes: availableCreditNotes.length,
            totalAvailableAmount: availableCreditNotes.reduce((sum, cn) => sum + cn.remainingAmount, 0),
        };

        return res.status(200).json({
            success: true,
            data: {
                creditNotes: availableCreditNotes,
                summary,
                pagination: {
                    total,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    pages: Math.ceil(total / parseInt(limit)),
                },
            },
        });
    } catch (error) {
        console.error("Error fetching available credit notes:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch credit notes",
            error: error.message,
        });
    }
};

/**
 * Enhanced auto-match: learns from previous manual matches
 */
exports.autoMatchPayments = async (req, res) => {
    try {
        const { cardCode, confidenceThreshold = 70 } = req.body;

        const IGNORE = new Set([
            // Banking operation words
            'VIR', 'VIREMENT', 'RECU', 'SEPA', 'INST', 'INSTANTANE', 'EUROPEEN',
            // French prepositions/articles
            'DE', 'DU', 'DES', 'LE', 'LA', 'LES', 'UNE', 'PAR', 'SUR', 'POUR', 'EST',
            // Bank codes
            'CMC', 'BNP', 'CIC', 'LCL', 'SAS', 'SARL', 'CMCI', 'CMCIFRPPXXX',
            'FRPP', 'XXX', 'SG', 'SA', 'QNTOFRP', 'SOGEFRPPXXX', 'CCBPFRPPGRE',
            'CCBPFRPPMTG', 'CEPAFRPP', 'AGRIFRPP', 'BNPAFRPPXXX', 'CMCIFR',
            'QNTOFRP1XXX', 'SWNBFR22XXX', 'CRLYFRPPXXX', 'NOTPROVIDED', 'CMCIFR2AXXX', 'PAIEMENT', 'VIRSEPA', 'VIREMENTSEPA',
            // English words
            'THE', 'AND', 'FROM', 'PAY', 'PAYMENT', 'REF', 'REC', 'EUR',
            // Common short noise
            'VH', 'REM', 'ACH', 'MON', 'INT', 'NET', 'CET',
            // Business/food domain words that appear in EVERY payment — too generic
            'FOOD', 'HALAL', 'SERVICE', 'FACTURE', 'FAST', 'VERS', 'ACHAT',
            'REGLEMENT', 'DEVIS', 'FACT', 'FOURNISEUR', 'BOISSONS',
            'MARCHANDISES', 'NUMERO', 'FORMAT', 'PRO', 'VIREMENT',
        ]);

        const extractKeywords = (payment) => {
            const fields = [
                payment.sourceDetails?.details?.detail1,
                payment.sourceDetails?.details?.detail2,
                payment.sourceDetails?.details?.detail3,
                payment.sourceDetails?.details?.detail4,
                payment.sourceDetails?.senderName,
                payment.sourceDetails?.fromEmail,
                payment.cardName,
            ].filter(Boolean);

            const words = new Set();
            for (const field of fields) {
                const tokens = String(field).toUpperCase().split(/[\s\/\-_,;:.@]+/);
                for (const token of tokens) {
                    if (
                        token.length > 2 &&
                        /^[A-Z]+$/.test(token) &&  // letters only, no numbers or mixed
                        !IGNORE.has(token)
                    ) {
                        words.add(token);
                    }
                }
            }
            return words;
        };

        // ✅ STEP 1: Build pattern library ONLY from payments with a real cardCode
        const matchedPayments = await FlattenedPayment.find({
            cardCode: { $nin: [null, "", undefined] },
        }).lean();

        console.log(`Building pattern library from ${matchedPayments.length} matched payments...`);

        // keywordMap: keyword → { cardCode: occurrenceCount }
        const keywordMap = {};

        for (const p of matchedPayments) {
            // Extra safety — skip anything without a valid cardCode
            if (!p.cardCode || p.cardCode === 'null' || p.cardCode === '') continue;

            const keywords = extractKeywords(p);
            for (const kw of keywords) {
                if (!keywordMap[kw]) keywordMap[kw] = {};
                keywordMap[kw][p.cardCode] = (keywordMap[kw][p.cardCode] || 0) + 1;
            }
        }

        // ✅ PRUNE generic keywords — if a keyword maps to more than 1 customer
        // it's too generic (like FOOD, HALAL, SERVICE) and will cause false matches
        let prunedCount = 0;
        for (const kw of Object.keys(keywordMap)) {
            const uniqueCustomers = Object.keys(keywordMap[kw]).length;
            if (uniqueCustomers > 1) {
                delete keywordMap[kw];
                prunedCount++;
            }
        }

        console.log(`Pattern library built: ${Object.keys(keywordMap).length} unique keywords (pruned ${prunedCount} generic ones)`);
        console.log(`Sample keywords:`, Object.keys(keywordMap).slice(0, 30));

        if (Object.keys(keywordMap).length === 0) {
            return res.status(400).json({
                success: false,
                message: "No matched payments found to build pattern library. Please manually match at least one payment first.",
            });
        }

        // ✅ STEP 2: Find unmatched payments
        const unmatchedFilter = {
            $and: [
                {
                    $or: [
                        { cardCode: null },
                        { cardCode: "" },
                        { cardCode: { $exists: false } },
                        { cardCode: "null" },
                    ]
                },
                { amount: { $gt: 0 } }
            ]
        };

        const unmatchedPayments = await FlattenedPayment.find(unmatchedFilter)
            .sort({ createdAt: -1 })
            .limit(1000)
            .lean();

        console.log(`Found ${unmatchedPayments.length} unmatched payments to process`);

        // Debug: log how many contain known keywords
        const debugCount = unmatchedPayments.filter(p => {
            const kws = extractKeywords(p);
            return [...kws].some(kw => keywordMap[kw]);
        }).length;
        console.log(`Of which ${debugCount} have at least one keyword in the library`);

        const results = { processed: 0, matched: 0, skipped: 0, failed: 0, matches: [] };

        for (const payment of unmatchedPayments) {
            try {
                results.processed++;

                // Extract keywords from this payment
                const paymentKeywords = extractKeywords(payment);

                if (paymentKeywords.size === 0) {
                    results.skipped++;
                    continue;
                }

                // Only score against keywords that exist in the library
                const mappableKeywords = [...paymentKeywords].filter(kw => keywordMap[kw]);

                if (mappableKeywords.length === 0) {
                    results.skipped++;
                    continue;
                }

                // Score each cardCode
                const scores = {};

                for (const kw of mappableKeywords) {
                    for (const [cc, count] of Object.entries(keywordMap[kw])) {
                        // Never score against null or empty
                        if (!cc || cc === 'null' || cc === '') continue;
                        if (!scores[cc]) scores[cc] = { matchCount: 0, totalWeight: 0, matchedKeywords: [] };
                        scores[cc].matchCount++;
                        scores[cc].totalWeight += count;
                        scores[cc].matchedKeywords.push(kw);
                    }
                }

                if (Object.keys(scores).length === 0) {
                    results.skipped++;
                    continue;
                }

                // Pick best scoring cardCode
                let bestCardCode = null;
                let bestScore = 0;
                let bestMatchedKeywords = [];

                for (const [cc, data] of Object.entries(scores)) {
                    const confidence =
                        (data.matchCount / mappableKeywords.length) * 70 +
                        Math.min(data.totalWeight * 2, 30);

                    if (confidence > bestScore) {
                        bestScore = confidence;
                        bestCardCode = cc;
                        bestMatchedKeywords = data.matchedKeywords;
                    }
                }

                const confidence = Math.min(Math.round(bestScore), 99);

                if (!bestCardCode || confidence < confidenceThreshold) {
                    console.log(`⏭ ${payment._id}: best confidence ${confidence}% < threshold ${confidenceThreshold}% — skipping`);
                    results.skipped++;
                    continue;
                }

                // Ambiguity check — if another customer scores within 10 points, skip unless very confident
                const competitors = Object.entries(scores).filter(([cc, data]) => {
                    if (cc === bestCardCode) return false;
                    const c =
                        (data.matchCount / mappableKeywords.length) * 70 +
                        Math.min(data.totalWeight * 2, 30);
                    return c >= confidence - 10;
                });

                if (competitors.length > 0 && confidence < 85) {
                    console.log(`⚠️ ${payment._id}: ambiguous between ${bestCardCode} and ${competitors.map(([cc]) => cc).join(', ')} — skipping`);
                    results.skipped++;
                    continue;
                }

                // Verify customer exists
                const customer = await Customer.findOne({ CardCode: bestCardCode }).lean();
                if (!customer) {
                    console.log(`⚠️ ${payment._id}: customer ${bestCardCode} not found in DB — skipping`);
                    results.skipped++;
                    continue;
                }

                // ✅ Save the match
                await FlattenedPayment.findByIdAndUpdate(
                    payment._id,
                    {
                        $set: {
                            cardCode: bestCardCode,
                            cardName: customer.CardName,
                            autoMatchConfidence: confidence,
                            autoMatchReason: `keyword_match: ${bestMatchedKeywords.join(', ')}`,
                            autoMatchedAt: new Date(),
                            reconciliationStatus: 'Unmatched',
                        }
                    },
                    { strict: false }
                );

                results.matched++;
                results.matches.push({
                    paymentId: payment._id,
                    cardCode: bestCardCode,
                    cardName: customer.CardName,
                    amount: payment.amount,
                    confidence,
                    matchedKeywords: bestMatchedKeywords,
                    source: payment.source,
                });

                console.log(`✅ ${payment._id} → ${bestCardCode} (${customer.CardName}) | ${confidence}% | [${bestMatchedKeywords.join(', ')}]`);

            } catch (err) {
                console.error(`Error processing payment ${payment._id}:`, err);
                results.failed++;
            }
        }

        // Update customer payment totals
        const affectedCardCodes = [...new Set(results.matches.map(m => m.cardCode))];
        for (const cc of affectedCardCodes) {
            await updateCustomerPaymentTotals([cc]);
        }

        console.log(`\n===== AUTO MATCH COMPLETE =====`);
        console.log(`Processed : ${results.processed}`);
        console.log(`Matched   : ${results.matched}`);
        console.log(`Skipped   : ${results.skipped}`);
        console.log(`Failed    : ${results.failed}`);
        console.log(`===============================\n`);

        return res.status(200).json({
            success: true,
            message: `Auto-matched ${results.matched} out of ${results.processed} payments`,
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

exports.resetAllPaymentsToUnmatched = async (req, res) => {
    try {
        const result = await FlattenedPayment.updateMany(
            {},
            {
                $set: {
                    cardCode: null,
                    cardName: null,
                    autoMatchConfidence: null,
                    autoMatchReason: null,
                    autoMatchedAt: null,
                    reconciliationStatus: 'Unmatched',
                },
                $unset: {
                    matchedInvoices: "",
                }
            },
            { strict: false }
        );

        return res.status(200).json({
            success: true,
            message: `Reset ${result.modifiedCount} payments to unmatched`,
            data: { modifiedCount: result.modifiedCount }
        });
    } catch (error) {
        console.error("Error resetting payments:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to reset payments",
            error: error.message
        });
    }
};

/**
 * Get auto-matched payments (for the auto-match review tab)
 */
exports.getAutoMatchedPayments = async (req, res) => {
    try {
        const { page = 1, limit = 50, cardCode, source, minConfidence = 0 } = req.query;

        const filter = {
            autoMatchedAt: { $exists: true },
            autoMatchConfidence: { $gte: parseInt(minConfidence) },
        };

        if (cardCode) filter.cardCode = cardCode;
        if (source) filter.source = source;

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const payments = await FlattenedPayment.find(filter)
            .sort({ autoMatchedAt: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .lean();

        const total = await FlattenedPayment.countDocuments(filter);

        // Stats
        const stats = await FlattenedPayment.aggregate([
            { $match: { autoMatchedAt: { $exists: true } } },
            {
                $group: {
                    _id: null,
                    avgConfidence: { $avg: "$autoMatchConfidence" },
                    total: { $sum: 1 },
                    highConfidence: { $sum: { $cond: [{ $gte: ["$autoMatchConfidence", 80] }, 1, 0] } },
                    medConfidence: { $sum: { $cond: [{ $and: [{ $gte: ["$autoMatchConfidence", 60] }, { $lt: ["$autoMatchConfidence", 80] }] }, 1, 0] } },
                }
            }
        ]);

        return res.status(200).json({
            success: true,
            data: {
                payments,
                stats: stats[0] || {},
                pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
            },
        });
    } catch (error) {
        console.error("Error fetching auto-matched payments:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch auto-matched payments", error: error.message });
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
                //skipping unpaid deliveries for payment creation
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
                source: statement.bankSource === "SG" ? "sg_bank" : "bred_bank",
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

