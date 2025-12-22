const BankStatement = require("../models/BankStatement");
const PayPalStatement = require("../models/PayPalStatement");
const FlattenedPayment = require("../models/FlattenedPayment");
const Invoice = require("../models/Invoice");
const Customer = require("../models/Customer");
const syncMetadata = require("../models/SyncMetadata");
const XLSX = require("xlsx");
const pdfjsLib = require('pdfjs-dist');
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
 * Import SG Bank statements from PDF file - DIRECTLY TO FLATTENED PAYMENTS
 */
exports.importSGBankStatements = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "PDF file is required",
            });
        }

        console.log("Starting SG Bank statement import (PDF)...");

        // Parse PDF using pdfjs-dist
        const data = new Uint8Array(req.file.buffer);
        const loadingTask = pdfjsLib.getDocument({ data });
        const pdfDocument = await loadingTask.promise;

        let fullText = '';

        // Extract text from all pages
        for (let pageNum = 1; pageNum <= pdfDocument.numPages; pageNum++) {
            const page = await pdfDocument.getPage(pageNum);
            const textContent = await page.getTextContent();

            let lastY = null;
            textContent.items.forEach(item => {
                if (lastY !== null && Math.abs(item.transform[5] - lastY) > 5) {
                    fullText += '\n';
                }
                fullText += item.str + ' ';
                lastY = item.transform[5];
            });
            fullText += '\n\n';
        }

        console.log('Extracted text length:', fullText.length);

        const paymentsToCreate = [];
        const errors = [];
        const skippedReasons = {
            debit: 0,
            noAmount: 0,
            invalidAmount: 0,
            unknown: 0,
            noKeywords: 0
        };

        const lines = fullText.split('\n');
        let transactionCount = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            const dateMatch = line.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})/);

            if (!dateMatch) continue;

            transactionCount++;
            const operationDate = parseDate(dateMatch[1]);
            const valueDate = parseDate(dateMatch[2]);

            // Get more context
            const contextLines = [];
            for (let j = i; j < Math.min(i + 6, lines.length); j++) {
                contextLines.push(lines[j]);
            }
            const textAfterDates = contextLines.join(' ');
            const upperText = textAfterDates.toUpperCase();

            // Look for amounts
            const amountPattern = /(?:^|\s)([\d\s\.]+),(\d{2})(?:\s|$|\*)/g;
            const amounts = [];
            let amountMatch;

            while ((amountMatch = amountPattern.exec(textAfterDates)) !== null) {
                const amountStr = amountMatch[1].replace(/\s/g, '').replace(/\./g, '');
                const amount = parseFloat(`${amountStr}.${amountMatch[2]}`);

                if (!isNaN(amount) && amount > 0 && amount < 10000000) {
                    amounts.push({
                        value: amount,
                        position: amountMatch.index,
                        text: amountMatch[0].trim()
                    });
                }
            }

            // Remove duplicates
            const uniqueAmounts = [];
            const seenValues = new Set();
            for (const amt of amounts) {
                if (!seenValues.has(amt.value)) {
                    seenValues.add(amt.value);
                    uniqueAmounts.push(amt);
                }
            }

            // ✅ Determine if this is a credit or debit
            const isCreditKeyword =
                upperText.match(/VIR\s+(RECU|INST\s+RE)/) ||
                (upperText.includes('REMISE CB') && upperText.includes('REM.ACH.CB')) ||
                upperText.includes('DEBLOCAGE PROVISION') ||
                upperText.includes('VIREMENT RECU');

            const isDebitKeyword = !isCreditKeyword && (
                upperText.includes('VIR INSTANTANE EMIS') ||
                upperText.includes('VIR EUROPEEN EMIS') ||
                upperText.includes('PRELEVEMENT') ||
                upperText.includes('ECHEANCE PRET') ||
                upperText.match(/FRAIS\s+(VIR|SUR|VIREMENT)/) ||
                upperText.includes('CIONS TENUE') ||
                upperText.includes('ABONNT') ||
                upperText.includes('RELEVE DE COMMISSIONS') ||
                upperText.includes('INT DEBITEURS') ||
                upperText.includes('BLOCAGE PROVISION') ||
                upperText.includes('COTISATION') ||
                (upperText.includes('COM CB') && !upperText.includes('REM.ACH.CB'))
            );

            const shouldLogDetail = transactionCount <= 5 ||
                transactionCount % 10 === 0 ||
                i > lines.length - 100;

            if (shouldLogDetail) {
                console.log(`\n--- Transaction ${transactionCount} ---`);
                console.log(`Dates: ${dateMatch[1]} / ${dateMatch[2]}`);
                console.log(`Text: "${textAfterDates.substring(0, 200)}"`);
                console.log(`Amounts: ${uniqueAmounts.map(a => `€${a.value}`).join(', ')}`);
                console.log(`Credit: ${!!isCreditKeyword}, Debit: ${!!isDebitKeyword}`);
            }

            // Skip if no amount
            if (uniqueAmounts.length === 0) {
                skippedReasons.noAmount++;
                if (shouldLogDetail) console.log(`⏭️  SKIPPED: No amount`);
                continue;
            }

            // Skip if no keywords
            if (!isCreditKeyword && !isDebitKeyword) {
                skippedReasons.noKeywords++;
                if (shouldLogDetail) console.log(`⏭️  SKIPPED: No keywords`);
                continue;
            }

            // ✅ ONLY PROCESS CREDITS
            if (!isCreditKeyword) {
                skippedReasons.debit++;
                if (shouldLogDetail) console.log(`⏭️  SKIPPED: Debit`);
                continue;
            }

            // Get the transaction amount
            let amount = 0;
            if (uniqueAmounts.length === 1) {
                amount = uniqueAmounts[0].value;
            } else {
                const reasonableAmounts = uniqueAmounts.filter(a => a.value < 100000);
                if (reasonableAmounts.length > 0) {
                    amount = reasonableAmounts[reasonableAmounts.length - 1].value;
                } else {
                    amount = uniqueAmounts[0].value;
                }
            }

            if (amount <= 0 || isNaN(amount) || amount >= 1000000) {
                skippedReasons.invalidAmount++;
                if (shouldLogDetail) console.log(`⚠️  Invalid amount: ${amount}`);
                continue;
            }

            // ✅ EXTRACT DETAILED INFORMATION
            let operationType = 'CREDIT';
            let reference = '';
            let senderName = '';
            let paymentMethod = 'bank_transfer';
            let sourceDetails = {};

            // Parse VIR RECU (Wire Transfer Received)
            if (textAfterDates.includes('VIR RECU')) {
                operationType = 'VIR RECU';
                paymentMethod = 'wire_transfer';

                // Extract reference (transaction ID)
                const refMatch = textAfterDates.match(/VIR RECU\s+(\d+S?)/i);
                reference = refMatch ? refMatch[1] : '';

                // Extract sender (DE: ...)
                const senderMatch = textAfterDates.match(/DE[:\s]*([^\n]+?)(?:MOTIF|REF|PROVENANCE|$)/i);
                senderName = senderMatch ? senderMatch[1].trim() : '';

                // Extract MOTIF/REF
                const motifMatch = textAfterDates.match(/MOTIF[:\s]*([^\n]+?)(?:REF|PROVENANCE|$)/i);
                const refMatch2 = textAfterDates.match(/REF[:\s]*([A-Z0-9\/]+)/i);
                const provenanceMatch = textAfterDates.match(/PROVENANCE[:\s]*([A-Z\s]+?)(?:\s|$)/i);

                sourceDetails = {
                    transactionId: reference,
                    sender: senderName,
                    motif: motifMatch ? motifMatch[1].trim() : '',
                    reference: refMatch2 ? refMatch2[1] : '',
                    provenance: provenanceMatch ? provenanceMatch[1].trim() : '',
                };
            }

            // Parse VIR INST RE (Instant Wire Received)
            else if (textAfterDates.includes('VIR INST RE')) {
                operationType = 'VIR INST RE';
                paymentMethod = 'instant_wire';

                const refMatch = textAfterDates.match(/VIR INST RE\s+(\d+)/);
                reference = refMatch ? refMatch[1] : '';

                const senderMatch = textAfterDates.match(/DE[:\s]*([^\n]+?)(?:DATE|MOTIF|$)/i);
                senderName = senderMatch ? senderMatch[1].trim() : '';

                const dateMatch = textAfterDates.match(/DATE[:\s]*(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})/i);
                const motifMatch = textAfterDates.match(/MOTIF[:\s]*([^\n]+?)(?:REF|$)/i);

                sourceDetails = {
                    transactionId: reference,
                    sender: senderName,
                    date: dateMatch ? dateMatch[1] : '',
                    motif: motifMatch ? motifMatch[1].trim() : '',
                };
            }

            // Parse REMISE CB (Card Payment)
            else if (textAfterDates.includes('REMISE CB')) {
                operationType = 'REMISE CB';
                paymentMethod = 'card_payment';

                const refMatch = textAfterDates.match(/REM\.ACH\.CB(\d+)/);
                reference = refMatch ? refMatch[1] : '';

                const nameMatch = textAfterDates.match(/REMISE CB[^A-Z]*([A-Z][A-Z\s]+?)(?:\d|$)/);
                senderName = nameMatch ? nameMatch[1].trim() : 'Card Payment';

                const dateMatch = textAfterDates.match(/\/(\d{2}\/\d{2})\s+/);

                sourceDetails = {
                    cardReference: reference,
                    merchant: senderName,
                    date: dateMatch ? dateMatch[1] : '',
                };
            }

            // Parse DEBLOCAGE PROVISION
            else if (textAfterDates.includes('DEBLOCAGE')) {
                operationType = 'DEBLOCAGE PROVISION';
                paymentMethod = 'provision_unblock';
                senderName = 'Unblocked Provision';

                const amountMatch = textAfterDates.match(/de\s+([\d\s\.]+),(\d{2})\s+euros/i);
                if (amountMatch) {
                    sourceDetails.provisionAmount = amountMatch[0];
                }
            }

            // ✅ CREATE FLATTENED PAYMENT
            const payment = {
                cardCode: null, // Will be matched later
                cardName: senderName || null,
                amount: amount,
                reference: reference || null,
                source: 'sg_bank',
                paymentDate: operationDate,
                sourceDocument: {
                    sourceType: 'SG_Bank_Statement',
                    sourceId: null, // No intermediate BankStatement
                },
                reconciliationStatus: 'Unmatched',
                paymentMethod: paymentMethod,
                sourceDetails: {
                    operationType: operationType,
                    valueDate: valueDate,
                    senderName: senderName,
                    ...sourceDetails,
                    rawText: textAfterDates.substring(0, 300),
                },
                remainingAmount: amount,
                importedBy: req.user?._id,
            };

            paymentsToCreate.push(payment);

            if (shouldLogDetail) {
                console.log(`✅ ADDED: ${operationType} - €${amount.toFixed(2)} - ${senderName}`);
            }
        }

        console.log(`\n${'='.repeat(60)}`);
        console.log(`📊 SUMMARY`);
        console.log(`${'='.repeat(60)}`);
        console.log(`Total transactions found: ${transactionCount}`);
        console.log(`Credits to import: ${paymentsToCreate.length}`);
        console.log(`\nSkipped breakdown:`);
        console.log(`  - Debits: ${skippedReasons.debit}`);
        console.log(`  - No amount: ${skippedReasons.noAmount}`);
        console.log(`  - Invalid amount: ${skippedReasons.invalidAmount}`);
        console.log(`  - No keywords: ${skippedReasons.noKeywords}`);
        console.log(`  - Unknown: ${skippedReasons.unknown}`);
        console.log(`${'='.repeat(60)}\n`);

        if (paymentsToCreate.length === 0) {
            return res.status(400).json({
                success: false,
                message: "No valid credit transactions found in PDF.",
                data: {
                    totalRows: transactionCount,
                    inserted: 0,
                    skipped: transactionCount,
                    errors: [{
                        error: `No credits found. Breakdown: ${JSON.stringify(skippedReasons)}`
                    }],
                },
            });
        }

        // ✅ CHECK FOR DUPLICATES
        const existingPayments = await FlattenedPayment.find({
            source: 'sg_bank',
            paymentDate: {
                $in: paymentsToCreate.map(p => p.paymentDate),
            },
        }).lean();

        const existingKeys = new Set(
            existingPayments.map(
                p => `${p.paymentDate.toISOString()}-${p.amount}-${p.reference}`
            )
        );

        const newPayments = paymentsToCreate.filter(p => {
            const key = `${p.paymentDate.toISOString()}-${p.amount}-${p.reference}`;
            return !existingKeys.has(key);
        });

        console.log(`✨ ${newPayments.length} new payments (${paymentsToCreate.length - newPayments.length} duplicates skipped)`);

        // ✅ INSERT INTO FLATTENED PAYMENTS
        let inserted = 0;
        if (newPayments.length > 0) {
            const result = await FlattenedPayment.insertMany(newPayments);
            inserted = result.length;
        }

        return res.status(200).json({
            success: true,
            message: `Imported ${inserted} SG Bank payments`,
            data: {
                totalRows: paymentsToCreate.length,
                inserted: inserted,
                skipped: paymentsToCreate.length - inserted,
                errors: errors,
            },
        });

    } catch (error) {
        console.error("❌ Error importing SG Bank statements:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to import SG Bank statements",
            error: error.message,
        });
    }
};

// Helper function to parse dates
function parseDate(dateStr) {
    const [day, month, year] = dateStr.split('/');
    return new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
}

// Helper function to parse Excel dates
function parseExcelDate(excelDate) {
    if (excelDate instanceof Date) {
        return excelDate;
    }

    if (typeof excelDate === "number") {
        const epoch = new Date(1900, 0, 1);
        return new Date(epoch.getTime() + (excelDate - 2) * 86400000);
    }

    // Try to parse string date
    const date = new Date(excelDate);
    if (!isNaN(date.getTime())) {
        return date;
    }

    throw new Error(`Invalid date format: ${excelDate}`);
}
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
                lastInvoiceStatusSyncTime: lastSync ? lastSync.lastSyncDate : null,
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