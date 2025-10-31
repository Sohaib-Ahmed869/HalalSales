const BankStatement = require("../models/BankStatement");
const PayPalStatement = require("../models/PayPalStatement");
const Invoice = require("../models/Invoice");
const XLSX = require("xlsx");

/**
 * Parse French number format (e.g., "461,52" -> 461.52)
 */
const parseFrenchNumber = (value) => {
    if (!value || value === "") return 0;
    if (typeof value === "number") return value;
    return parseFloat(String(value).replace(/\s/g, "").replace(",", "."));
};

/**
 * Parse French date format (DD/MM/YYYY)
 */
const parseFrenchDate = (dateStr) => {
    if (!dateStr) return null;
    if (dateStr instanceof Date) return dateStr;

    const parts = String(dateStr).split("/");
    if (parts.length === 3) {
        return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
    }
    return new Date(dateStr);
};

/**
 * Import bank statements from Excel file
 */
exports.importBankStatements = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "Excel file is required",
            });
        }

        console.log("Starting bank statement import...");

        // Parse Excel file
        const workbook = XLSX.read(req.file.buffer, {
            cellDates: true,
            cellNF: true,
            cellStyles: true,
        });

        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        // Convert to JSON
        const rows = XLSX.utils.sheet_to_json(worksheet, {
            defval: null,
            blankrows: false,
        });

        console.log(`Parsed ${rows.length} rows from Excel`);

        if (rows.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Excel file contains no data rows",
            });
        }

        const statements = [];
        const errors = [];

        for (let i = 0; i < rows.length; i++) {
            try {
                const row = rows[i];

                // Parse operation date
                const operationDate = row["Date d'opération"];
                if (!operationDate) {
                    errors.push({ row: i + 2, error: "Missing operation date" });
                    continue;
                }

                // Parse amount
                const amount = parseFrenchNumber(row["Montant"]);
                if (isNaN(amount)) {
                    errors.push({ row: i + 2, error: "Invalid amount" });
                    continue;
                }

                // Create statement object
                const statement = {
                    operationDate: operationDate instanceof Date ? operationDate : new Date(operationDate),
                    operationReference: row["Référence de l'opération"] || null,
                    operationType: row["Type de l'opération"]?.trim() || "Unknown",
                    amount: amount,
                    comment: row["Commentaire"] || null,
                    details: {
                        detail1: row["Détail 1"]?.trim() || null,
                        detail2: row["Détail 2"]?.trim() || null,
                        detail3: row["Détail 3"]?.trim() || null,
                        detail4: row["Détail 4"]?.trim() || null,
                        detail5: row["Détail 5"]?.trim() || null,
                        detail6: row["Détail 6"]?.trim() || null,
                    },
                };

                statements.push(statement);
            } catch (error) {
                errors.push({ row: i + 2, error: error.message });
            }
        }

        // Bulk insert
        let insertedCount = 0;
        if (statements.length > 0) {
            try {
                const result = await BankStatement.insertMany(statements, {
                    ordered: false,
                });
                insertedCount = result.length;
                console.log(`Successfully inserted ${insertedCount} bank statements`);
            } catch (error) {
                if (error.writeErrors) {
                    insertedCount = statements.length - error.writeErrors.length;
                    console.log(`Partial success: ${insertedCount} inserted, ${error.writeErrors.length} failed`);
                } else {
                    throw error;
                }
            }
        }

        return res.status(200).json({
            success: true,
            message: "Bank statement import completed",
            data: {
                totalRows: rows.length,
                inserted: insertedCount,
                skipped: rows.length - insertedCount,
                errors: errors.length > 0 ? errors : undefined,
            },
        });
    } catch (error) {
        console.error("Error importing bank statements:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to import bank statements",
            error: error.message,
        });
    }
};

/**
 * Import PayPal statements from CSV file
 */
exports.importPayPalStatements = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "CSV file is required",
            });
        }

        console.log("Starting PayPal statement import...");

        // Parse CSV file
        const workbook = XLSX.read(req.file.buffer, {
            cellDates: true,
            raw: false,
        });

        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        // Convert to JSON
        const rows = XLSX.utils.sheet_to_json(worksheet, {
            defval: null,
            blankrows: false,
        });

        console.log(`Parsed ${rows.length} rows from CSV`);

        if (rows.length === 0) {
            return res.status(400).json({
                success: false,
                message: "CSV file contains no data rows",
            });
        }

        const statements = [];
        const errors = [];
        const duplicates = [];

        for (let i = 0; i < rows.length; i++) {
            try {
                const row = rows[i];

                // Check for required fields
                const transactionId = row["Numéro de transaction"];
                if (!transactionId) {
                    errors.push({ row: i + 2, error: "Missing transaction ID" });
                    continue;
                }

                // Check if transaction already exists
                const exists = await PayPalStatement.findOne({ transactionId });
                if (exists) {
                    duplicates.push({ row: i + 2, transactionId });
                    continue;
                }

                // Parse date
                const date = parseFrenchDate(row["Date"]);
                if (!date) {
                    errors.push({ row: i + 2, error: "Invalid date" });
                    continue;
                }

                // Parse amounts
                const grossAmount = parseFrenchNumber(row["Avant commission"]);
                const fee = parseFrenchNumber(row["Commission"]);
                const netAmount = parseFrenchNumber(row["Net"]);
                const balance = parseFrenchNumber(row["Solde"]);

                // Create statement object
                const statement = {
                    date: date,
                    time: row["Heure"] || "00:00:00",
                    timezone: row["Fuseau horaire"] || "UTC",
                    name: row["Nom"] || null,
                    type: row["Type"]?.trim() || "Unknown",
                    status: row["État"]?.trim() || "Unknown",
                    currency: row["Devise"] || "EUR",
                    grossAmount: grossAmount,
                    fee: fee,
                    netAmount: netAmount,
                    fromEmail: row["De l'adresse email"] || null,
                    toEmail: row["À l'adresse email"] || null,
                    transactionId: transactionId,
                    referenceTransactionId: row["Numéro de la transaction de référence"] || null,
                    invoiceNumber: row["Numéro de facture"] || null,
                    customerNumber: row["Numéro de client"] || null,
                    receiptNumber: row["Numéro de reçu"] || null,
                    shippingAddress: {
                        fullAddress: row["Adresse de livraison"] || null,
                        addressStatus: row["État de l'adresse"] || null,
                        street: row["Adresse"] || null,
                        district: row["Adresse (suite)/District/Quartier"] || null,
                        city: row["Ville"] || null,
                        state: row["État/Province/Région/Comté/Territoire/Préfecture/République"] || null,
                        postalCode: row["Code postal"] ? String(row["Code postal"]) : null,
                        country: row["Pays"] || null,
                        phoneNumber: row["Numéro de téléphone du contact"] ? String(row["Numéro de téléphone du contact"]) : null,
                    },
                    itemTitle: row["Titre de l'objet"] || null,
                    itemNumber: row["Numéro de l'objet"] || null,
                    quantity: row["Quantité"] ? parseFloat(row["Quantité"]) : null,
                    shippingAndHandling: parseFrenchNumber(row["Montant des frais d'expédition et de traitement"]),
                    insurance: parseFrenchNumber(row["Montant de l'assurance"]),
                    vat: parseFrenchNumber(row["TVA"]),
                    option1Name: row["Nom de l'option 1"] || null,
                    option1Value: row["Valeur de l'option 1"] || null,
                    option2Name: row["Nom de l'option 2"] || null,
                    option2Value: row["Valeur de l'option 2"] || null,
                    balance: balance,
                    subject: row["Objet"] || null,
                    note: row["Remarque"] || null,
                    countryCode: row["Indicatif pays"] || null,
                    balanceImpact: row["Impact sur le solde"] || null,
                };

                statements.push(statement);
            } catch (error) {
                errors.push({ row: i + 2, error: error.message });
            }
        }

        // Bulk insert
        let insertedCount = 0;
        if (statements.length > 0) {
            try {
                const result = await PayPalStatement.insertMany(statements, {
                    ordered: false,
                });
                insertedCount = result.length;
                console.log(`Successfully inserted ${insertedCount} PayPal statements`);
            } catch (error) {
                if (error.writeErrors) {
                    insertedCount = statements.length - error.writeErrors.length;
                    console.log(`Partial success: ${insertedCount} inserted, ${error.writeErrors.length} failed`);
                } else {
                    throw error;
                }
            }
        }

        return res.status(200).json({
            success: true,
            message: "PayPal statement import completed",
            data: {
                totalRows: rows.length,
                inserted: insertedCount,
                duplicates: duplicates.length,
                errors: errors.length,
                details: {
                    duplicates: duplicates.length > 0 ? duplicates : undefined,
                    errors: errors.length > 0 ? errors : undefined,
                },
            },
        });
    } catch (error) {
        console.error("Error importing PayPal statements:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to import PayPal statements",
            error: error.message,
        });
    }
};

/**
 * Get bank statements with pagination and filters
 */
exports.getBankStatements = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 50,
            startDate,
            endDate,
            operationType,
            reconciliationStatus,
            matchedCustomer,
            minAmount,
            maxAmount,
        } = req.query;

        const filter = {};

        // Date range filter
        if (startDate && endDate) {
            filter.operationDate = {
                $gte: new Date(startDate),
                $lte: new Date(endDate),
            };
        }

        // Operation type filter
        if (operationType) {
            filter.operationType = { $regex: operationType, $options: "i" };
        }

        // Reconciliation status filter
        if (reconciliationStatus) {
            filter.reconciliationStatus = reconciliationStatus;
        }

        // Matched customer filter
        if (matchedCustomer) {
            filter.matchedCustomer = matchedCustomer;
        }

        // Amount range filter
        if (minAmount || maxAmount) {
            filter.amount = {};
            if (minAmount) filter.amount.$gte = parseFloat(minAmount);
            if (maxAmount) filter.amount.$lte = parseFloat(maxAmount);
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const statements = await BankStatement.find(filter)
            .sort({ operationDate: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .lean();

        const total = await BankStatement.countDocuments(filter);

        return res.status(200).json({
            success: true,
            data: {
                statements,
                pagination: {
                    total,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    pages: Math.ceil(total / parseInt(limit)),
                },
            },
        });
    } catch (error) {
        console.error("Error fetching bank statements:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch bank statements",
            error: error.message,
        });
    }
};

/**
 * Get PayPal statements with pagination and filters
 */
exports.getPayPalStatements = async (req, res) => {
    try {
        const {
            page = 1,
            limit = 50,
            startDate,
            endDate,
            type,
            status,
            reconciliationStatus,
            matchedCustomer,
            balanceImpact,
            minAmount,
            maxAmount,
        } = req.query;

        const filter = {};

        // Date range filter
        if (startDate && endDate) {
            filter.date = {
                $gte: new Date(startDate),
                $lte: new Date(endDate),
            };
        }

        // Type filter
        if (type) {
            filter.type = { $regex: type, $options: "i" };
        }

        // Status filter
        if (status) {
            filter.status = status;
        }

        // Reconciliation status filter
        if (reconciliationStatus) {
            filter.reconciliationStatus = reconciliationStatus;
        }

        // Matched customer filter
        if (matchedCustomer) {
            filter.matchedCustomer = matchedCustomer;
        }

        // Balance impact filter
        if (balanceImpact) {
            filter.balanceImpact = balanceImpact;
        }

        // Amount range filter
        if (minAmount || maxAmount) {
            filter.netAmount = {};
            if (minAmount) filter.netAmount.$gte = parseFloat(minAmount);
            if (maxAmount) filter.netAmount.$lte = parseFloat(maxAmount);
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const statements = await PayPalStatement.find(filter)
            .sort({ date: -1 })
            .skip(skip)
            .limit(parseInt(limit))
            .lean();

        const total = await PayPalStatement.countDocuments(filter);

        return res.status(200).json({
            success: true,
            data: {
                statements,
                pagination: {
                    total,
                    page: parseInt(page),
                    limit: parseInt(limit),
                    pages: Math.ceil(total / parseInt(limit)),
                },
            },
        });
    } catch (error) {
        console.error("Error fetching PayPal statements:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch PayPal statements",
            error: error.message,
        });
    }
};

/**
 * Get financial summary/dashboard
 */
exports.getFinancialSummary = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;

        const dateFilter = {};
        if (startDate && endDate) {
            dateFilter.operationDate = {
                $gte: new Date(startDate),
                $lte: new Date(endDate),
            };
        }

        const paypalDateFilter = {};
        if (startDate && endDate) {
            paypalDateFilter.date = {
                $gte: new Date(startDate),
                $lte: new Date(endDate),
            };
        }

        // Bank statement summary
        const bankSummary = await BankStatement.aggregate([
            { $match: dateFilter },
            {
                $group: {
                    _id: null,
                    totalTransactions: { $sum: 1 },
                    totalAmount: { $sum: "$amount" },
                    averageAmount: { $avg: "$amount" },
                    matchedCount: {
                        $sum: { $cond: [{ $eq: ["$reconciliationStatus", "Matched"] }, 1, 0] },
                    },
                    unmatchedCount: {
                        $sum: { $cond: [{ $eq: ["$reconciliationStatus", "Unmatched"] }, 1, 0] },
                    },
                },
            },
        ]);

        // PayPal summary
        const paypalSummary = await PayPalStatement.aggregate([
            { $match: paypalDateFilter },
            {
                $group: {
                    _id: null,
                    totalTransactions: { $sum: 1 },
                    totalGross: { $sum: "$grossAmount" },
                    totalFees: { $sum: "$fee" },
                    totalNet: { $sum: "$netAmount" },
                    averageNet: { $avg: "$netAmount" },
                    matchedCount: {
                        $sum: { $cond: [{ $eq: ["$reconciliationStatus", "Matched"] }, 1, 0] },
                    },
                    unmatchedCount: {
                        $sum: { $cond: [{ $eq: ["$reconciliationStatus", "Unmatched"] }, 1, 0] },
                    },
                },
            },
        ]);

        return res.status(200).json({
            success: true,
            data: {
                bank: bankSummary[0] || {},
                paypal: paypalSummary[0] || {},
            },
        });
    } catch (error) {
        console.error("Error fetching financial summary:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch financial summary",
            error: error.message,
        });
    }
};

/**
 * Match statement to invoice (manual reconciliation)
 */
exports.matchStatementToInvoice = async (req, res) => {
    try {
        const { statementId, statementType, invoiceDocNum, notes } = req.body;

        if (!statementId || !statementType || !invoiceDocNum) {
            return res.status(400).json({
                success: false,
                message: "Statement ID, type, and invoice DocNum are required",
            });
        }

        // Find the invoice
        const invoice = await Invoice.findOne({ DocNum: invoiceDocNum });
        if (!invoice) {
            return res.status(404).json({
                success: false,
                message: "Invoice not found",
            });
        }

        // Update the appropriate statement
        let statement;
        if (statementType === "bank") {
            statement = await BankStatement.findByIdAndUpdate(
                statementId,
                {
                    matchedCustomer: invoice.CardCode,
                    matchedInvoice: invoice.DocNum,
                    reconciliationStatus: "Matched",
                    reconciliationNotes: notes || `Manually matched to invoice ${invoice.DocNum}`,
                },
                { new: true }
            );
        } else if (statementType === "paypal") {
            statement = await PayPalStatement.findByIdAndUpdate(
                statementId,
                {
                    matchedCustomer: invoice.CardCode,
                    matchedInvoice: invoice.DocNum,
                    reconciliationStatus: "Matched",
                    reconciliationNotes: notes || `Manually matched to invoice ${invoice.DocNum}`,
                },
                { new: true }
            );
        } else {
            return res.status(400).json({
                success: false,
                message: "Invalid statement type. Must be 'bank' or 'paypal'",
            });
        }

        if (!statement) {
            return res.status(404).json({
                success: false,
                message: "Statement not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Statement matched successfully",
            data: statement,
        });
    } catch (error) {
        console.error("Error matching statement:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to match statement",
            error: error.message,
        });
    }
};

module.exports = exports;