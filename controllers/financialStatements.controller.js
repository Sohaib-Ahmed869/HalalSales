const BankStatement = require("../models/BankStatement");
const PayPalStatement = require("../models/PayPalStatement");
const FlattenedPayment = require("../models/FlattenedPayment");
const Invoice = require("../models/Invoice");
const Customer = require("../models/Customer");
const syncMetadata = require("../models/SyncMetadata");
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

// CORRECTED IMPORT FUNCTIONS

/**
 * Import and flatten bank statements (Excel/CSV format)
 */
exports.importBankStatements = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "Excel or CSV file is required",
            });
        }

        console.log("Starting bank statement import and flattening...");

        const XLSX = require("xlsx");
        let parsedData = [];

        // Determine file type and parse accordingly
        const fileExtension = req.file.originalname.split('.').pop().toLowerCase();

        if (fileExtension === 'xls' || fileExtension === 'xlsx') {
            // Parse Excel file
            const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];

            // Get raw data with header row
            const rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: null });

            // Skip header row (row 0) and process data rows
            for (let i = 1; i < rawData.length; i++) {
                const row = rawData[i];
                if (!row || row.length === 0) continue;

                parsedData.push({
                    dateSerial: row[0],  // Excel date serial number
                    reference: row[1] || null,
                    operationType: row[2] ? row[2].trim() : null,
                    amountStr: row[3],  // French format string
                    comment: row[4] || null,
                    detail1: row[5] ? row[5].trim() : null,
                    detail2: row[6] ? row[6].trim() : null,
                    detail3: row[7] ? row[7].trim() : null,
                    detail4: row[8] ? row[8].trim() : null,
                    detail5: row[9] ? row[9].trim() : null,
                    detail6: row[10] ? row[10].trim() : null,
                });
            }
        } else {
            // Parse CSV file
            const csv = require("csv-parser");
            const { Readable } = require("stream");

            await new Promise((resolve, reject) => {
                const stream = Readable.from(req.file.buffer.toString());
                stream
                    .pipe(csv({ separator: ";" }))
                    .on("data", (row) => {
                        parsedData.push({
                            dateStr: row["Date d'opération"] || row["Date opération"],
                            reference: row["Référence de l'opération"] || row["Référence"],
                            operationType: row["Type de l'opération"] || row["Type d'opération"],
                            amountStr: row["Montant"],
                            comment: row["Commentaire"],
                            detail1: row["Détail 1"],
                            detail2: row["Détail 2"],
                            detail3: row["Détail 3"],
                            detail4: row["Détail 4"],
                            detail5: row["Détail 5"],
                            detail6: row["Détail 6"],
                        });
                    })
                    .on("end", resolve)
                    .on("error", reject);
            });
        }

        console.log(`Parsed ${parsedData.length} rows from file`);

        const bankStatements = [];
        const flattenedPayments = [];

        for (const row of parsedData) {
            // Parse date
            let operationDate;
            if (row.dateSerial) {
                // Excel date serial number (days since 1900-01-01)
                // Excel incorrectly treats 1900 as a leap year, so subtract 1
                const excelEpoch = new Date(1900, 0, 1);
                operationDate = new Date(excelEpoch.getTime() + (row.dateSerial - 2) * 86400000);
            } else if (row.dateStr) {
                // CSV date string format "DD/MM/YYYY"
                const [day, month, year] = row.dateStr.split("/");
                operationDate = new Date(`${year}-${month}-${day}`);
            } else {
                operationDate = new Date();
            }

            // Parse amount - handle both French and standard formats
            let amount = 0;
            if (row.amountStr) {
                // French format: "1 234,56" or "461,52"
                // Standard format: "1234.56"
                const amountStr = String(row.amountStr)
                    .replace(/\s/g, "")  // Remove spaces
                    .replace(",", ".");   // Replace comma with dot
                amount = parseFloat(amountStr) || 0;
            }

            // Skip rows with zero or invalid amounts
            if (amount === 0) {
                console.log(`Skipping row with zero amount:`, row);
                continue;
            }

            // Create bank statement
            const bankStatement = {
                operationDate: operationDate,
                operationReference: row.reference,
                operationType: row.operationType || "VIREMENT",
                amount: amount,
                comment: row.comment,
                details: {
                    detail1: row.detail1,
                    detail2: row.detail2,
                    detail3: row.detail3,
                    detail4: row.detail4,
                    detail5: row.detail5,
                    detail6: row.detail6,
                },
                reconciliationStatus: "Unmatched",
                importedAt: new Date(),
            };

            bankStatements.push(bankStatement);

            // Try to match customer
            let cardCode = null;
            let cardName = null;


            // Create flattened payment with ALL available data
            const flattenedPayment = {
                cardCode: cardCode,
                cardName: cardName,
                amount: amount,
                reference: row.reference,
                source: "bred_bank",
                paymentDate: operationDate,
                sourceDocument: {
                    sourceType: "BankStatement",
                    sourceId: null, // Will be updated after saving bank statement
                },
                paymentMethod: row.operationType,
                sourceDetails: {
                    operationType: row.operationType,
                    operationReference: row.reference,
                    comment: row.comment,
                    details: {
                        detail1: row.detail1,
                        detail2: row.detail2,
                        detail3: row.detail3,
                        detail4: row.detail4,
                        detail5: row.detail5,
                        detail6: row.detail6,
                    },

                },
                remainingAmount: amount,
                reconciliationStatus: cardCode ? "Unmatched" : "Unmatched",
                importedBy: req.user?._id,
                importedAt: new Date(),
            };

            flattenedPayments.push(flattenedPayment);
        }

        if (bankStatements.length === 0) {
            return res.status(400).json({
                success: false,
                message: "No valid bank statements found in file",
            });
        }

        // Save bank statements
        const savedBankStatements = await BankStatement.insertMany(bankStatements);
        console.log(`✅ Saved ${savedBankStatements.length} bank statements`);

        // Update sourceId in flattened payments
        for (let i = 0; i < flattenedPayments.length; i++) {
            flattenedPayments[i].sourceDocument.sourceId = savedBankStatements[i]._id;
        }

        // Save flattened payments
        const savedFlattenedPayments = await FlattenedPayment.insertMany(flattenedPayments);
        console.log(`✅ Created ${savedFlattenedPayments.length} flattened payments`);

        // Update bank statements with flattenedPaymentId reference
        for (let i = 0; i < savedBankStatements.length; i++) {
            savedBankStatements[i].flattenedPaymentId = savedFlattenedPayments[i]._id;
            await savedBankStatements[i].save();
        }

        // Update customer payment totals for matched customers
        const matchedCardCodes = flattenedPayments
            .filter(fp => fp.cardCode)
            .map(fp => fp.cardCode);

        if (matchedCardCodes.length > 0) {
            await updateCustomerPaymentTotals(matchedCardCodes);
        }

        return res.status(200).json({
            success: true,
            message: "Bank statements imported and flattened successfully",
            data: {
                totalImported: savedBankStatements.length,
                flattenedPayments: savedFlattenedPayments.length,
                matchedCustomers: matchedCardCodes.length,
                unmatchedPayments: savedFlattenedPayments.length - matchedCardCodes.length,
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
 * Import and flatten PayPal statements (CSV format)
 */
exports.importPayPalStatements = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "CSV file is required",
            });
        }

        console.log("Starting PayPal statement import and flattening...");

        const csv = require("csv-parser");
        const { Readable } = require("stream");
        const results = [];

        // Parse CSV (PayPal uses comma separator)
        await new Promise((resolve, reject) => {
            const stream = Readable.from(req.file.buffer.toString());
            stream
                .pipe(csv({ separator: "," }))  // PayPal uses comma
                .on("data", (data) => results.push(data))
                .on("end", resolve)
                .on("error", reject);
        });

        console.log(`Parsed ${results.length} rows from CSV`);

        const paypalStatements = [];
        const flattenedPayments = [];

        for (const row of results) {
            // Parse date - French format: "19/10/2025"
            const dateStr = row["Date"] || row["date"];
            const timeStr = row["Heure"] || row["Time"] || row["time"] || "00:00:00";
            const timezone = row["Fuseau horaire"] || row["TimeZone"] || row["timezone"] || "PDT";

            let transactionDate = new Date();
            if (dateStr) {
                const [day, month, year] = dateStr.split("/");
                const [hours, minutes, seconds] = timeStr.split(":");
                transactionDate = new Date(`${year}-${month}-${day}T${hours || '00'}:${minutes || '00'}:${seconds || '00'}`);
            }

            // Parse amounts - French format with comma: "461,65"
            const parseAmount = (amountStr) => {
                if (!amountStr) return 0;
                // Remove quotes, spaces, and convert comma to dot
                const cleaned = String(amountStr)
                    .replace(/"/g, "")
                    .replace(/\s/g, "")
                    .replace(",", ".");
                return parseFloat(cleaned) || 0;
            };

            const grossAmount = parseAmount(row["Avant commission"] || row["Gross"] || row["gross"]);
            const fee = parseAmount(row["Commission"] || row["Fee"] || row["fee"]);
            const netAmount = parseAmount(row["Avant commission"] || row["Avant commission"]);

            // Skip zero amount transactions
            if (netAmount === 0) {
                continue;
            }

            // if negative transaction, skip for now
            if (netAmount < 0) {
                continue;
            }

            // Create PayPal statement with ALL fields
            const paypalStatement = {
                date: transactionDate,
                time: timeStr,
                timezone: timezone,
                name: row["Nom"] || row["Name"] || row["name"] || null,
                type: row["Type"] || row["type"] || "Payment",
                status: row["État"] || row["Status"] || row["status"] || "Completed",
                currency: row["Devise"] || row["Currency"] || row["currency"] || "EUR",
                grossAmount: grossAmount,
                fee: fee,
                netAmount: netAmount,
                fromEmail: row["De l'adresse email"] || row["From Email Address"] || row["from_email"] || null,
                toEmail: row["À l'adresse email"] || row["To Email Address"] || row["to_email"] || null,
                transactionId: row["Numéro de transaction"] || row["Transaction ID"] || row["transaction_id"] || `PAYPAL-${Date.now()}-${Math.random()}`,
                referenceTransactionId: row["Numéro de la transaction de référence"] || row["Reference Txn ID"] || null,
                invoiceNumber: row["Numéro de facture"] || row["Invoice Number"] || row["invoice_number"] || null,
                customerNumber: row["Numéro de client"] || row["Customer Number"] || null,
                receiptNumber: row["Numéro de reçu"] || row["Receipt ID"] || null,
                shippingAddress: {
                    fullAddress: row["Adresse de livraison"] || row["Shipping Address"] || null,
                    addressStatus: row["État de l'adresse"] || row["Address Status"] || null,
                    street: row["Adresse"] || row["Street"] || null,
                    district: row["Adresse (suite)/District/Quartier"] || row["District/Neighborhood"] || null,
                    city: row["Ville"] || row["Town/City"] || null,
                    state: row["État/Province/Région/Comté/Territoire/Préfecture/République"] || row["State/Province/Region/County/Territory/Prefecture/Republic"] || null,
                    postalCode: row["Code postal"] || row["Zip/Postal Code"] || null,
                    country: row["Pays"] || row["Country"] || null,
                    phoneNumber: row["Numéro de téléphone du contact"] || row["Contact Phone Number"] || null,
                },
                itemTitle: row["Titre de l'objet"] || row["Item Title"] || null,
                itemNumber: row["Numéro de l'objet"] || row["Item ID"] || null,
                quantity: row["Quantité"] ? parseInt(row["Quantité"]) : null,
                shippingAndHandling: parseAmount(row["Montant des frais d'expédition et de traitement"] || row["Shipping and Handling Amount"] || "0"),
                insurance: parseAmount(row["Montant de l'assurance"] || row["Insurance Amount"] || "0"),
                vat: parseAmount(row["TVA"] || row["Sales Tax"] || "0"),
                option1Name: row["Nom de l'option 1"] || row["Option 1 Name"] || null,
                option1Value: row["Valeur de l'option 1"] || row["Option 1 Value"] || null,
                option2Name: row["Nom de l'option 2"] || row["Option 2 Name"] || null,
                option2Value: row["Valeur de l'option 2"] || row["Option 2 Value"] || null,
                balance: parseAmount(row["Solde"] || row["Balance"] || "0"),
                subject: row["Objet"] || row["Subject"] || null,
                note: row["Remarque"] || row["Note"] || null,
                countryCode: row["Indicatif pays"] || row["Country Code"] || null,
                balanceImpact: row["Impact sur le solde"] || row["Balance Impact"] || null,
                reconciliationStatus: "Unmatched",
                importedAt: new Date(),
            };



            paypalStatements.push(paypalStatement);

            // Try to match customer
            let cardCode = null;
            let cardName = null;

            // Try matching by invoice number
            if (paypalStatement.invoiceNumber) {
                const invoice = await Invoice.findOne({
                    DocNum: parseInt(paypalStatement.invoiceNumber),
                }).lean();

                if (invoice) {
                    const customer = await Customer.findOne({
                        CardCode: invoice.CardCode,
                    }).lean();

                    if (customer) {
                        cardCode = customer.CardCode;
                        cardName = customer.CardName;
                        paypalStatement.matchedCustomer = cardCode;
                        paypalStatement.matchedInvoice = invoice.DocNum;
                        console.log(`✅ Matched by invoice: ${customer.CardName} (${cardCode})`);
                    }
                }
            }


            // Create flattened payment with ALL available data
            const flattenedPayment = {
                cardCode: cardCode,
                cardName: cardName,
                amount: netAmount,
                reference: paypalStatement.transactionId,
                source: "paypal",
                paymentDate: transactionDate,
                sourceDocument: {
                    sourceType: "PayPalStatement",
                    sourceId: null, // Will be updated after saving
                },
                paymentMethod: paypalStatement.type,
                sourceDetails: {
                    type: paypalStatement.type,
                    status: paypalStatement.status,
                    currency: paypalStatement.currency,
                    grossAmount: grossAmount,
                    fee: fee,
                    netAmount: netAmount,
                    fromEmail: paypalStatement.fromEmail,
                    toEmail: paypalStatement.toEmail,
                    transactionId: paypalStatement.transactionId,
                    referenceTransactionId: paypalStatement.referenceTransactionId,
                    invoiceNumber: paypalStatement.invoiceNumber,
                    customerNumber: paypalStatement.customerNumber,
                    receiptNumber: paypalStatement.receiptNumber,
                    itemTitle: paypalStatement.itemTitle,
                    itemNumber: paypalStatement.itemNumber,
                    quantity: paypalStatement.quantity,
                    shippingAndHandling: paypalStatement.shippingAndHandling,
                    insurance: paypalStatement.insurance,
                    vat: paypalStatement.vat,
                    shippingAddress: paypalStatement.shippingAddress,
                    subject: paypalStatement.subject,
                    note: paypalStatement.note,
                    balance: paypalStatement.balance,
                    balanceImpact: paypalStatement.balanceImpact,
                    timezone: timezone,
                    time: timeStr,
                },
                remainingAmount: netAmount,
                reconciliationStatus: cardCode ? "Unmatched" : "Unmatched",
                importedBy: req.user?._id,
                importedAt: new Date(),
            };

            flattenedPayments.push(flattenedPayment);
        }

        if (paypalStatements.length === 0) {
            return res.status(400).json({
                success: false,
                message: "No valid PayPal statements found in file",
            });
        }

        // Save PayPal statements
        const savedPayPalStatements = await PayPalStatement.insertMany(paypalStatements);
        console.log(`✅ Saved ${savedPayPalStatements.length} PayPal statements`);

        // Update sourceId in flattened payments
        for (let i = 0; i < flattenedPayments.length; i++) {
            flattenedPayments[i].sourceDocument.sourceId = savedPayPalStatements[i]._id;
        }

        // Save flattened payments
        const savedFlattenedPayments = await FlattenedPayment.insertMany(flattenedPayments);
        console.log(`✅ Created ${savedFlattenedPayments.length} flattened payments`);

        // Update PayPal statements with flattenedPaymentId reference
        for (let i = 0; i < savedPayPalStatements.length; i++) {
            savedPayPalStatements[i].flattenedPaymentId = savedFlattenedPayments[i]._id;
            await savedPayPalStatements[i].save();
        }



        return res.status(200).json({
            success: true,
            message: "PayPal statements imported and flattened successfully",
            data: {
                totalImported: savedPayPalStatements.length,
                flattenedPayments: savedFlattenedPayments.length,


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

        const lastSync = await syncMetadata.findOne({ syncType: "invoice_status_sync" }).lean();

        return res.status(200).json({
            success: true,
            data: {
                bank: bankSummary[0] || {},
                paypal: paypalSummary[0] || {},
                lastInvoiceStatusSyncTime : lastSync ? lastSync.lastSyncDate : null,
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