// controllers/salarySheet.controller.js
const XLSX = require('xlsx');

/**
 * @route   POST /api/salary-sheet/parse
 * @desc    Parse salary/financial sheet and return categorized JSON
 * @access  Public
 */
exports.parseSalarySheet = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "No file uploaded. Please upload an Excel file.",
            });
        }

        // Read the Excel file from buffer
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];

        // Convert to array of arrays
        const rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

        // Parse the structured data
        const parsedData = {
            metadata: {},
            bankDeposit: {},
            cashRegister: {
                cash: {},
                checks: {},
                creditCard: {}
            },
            expenses: [],
            deliveries: {
                checks: [],
                cash: [],
                creditCardSite: [],
                creditCardPhone: [],
                transfers: [],
                unpaid: []
            },
            totals: {}
        };

        // Parse metadata (date)
        if (rawData[0] && rawData[0][8] === 'DATE' && rawData[0][9]) {
            const excelDate = rawData[0][9];
            parsedData.metadata.date = convertExcelDate(excelDate);
            parsedData.metadata.excelDateValue = excelDate;
        }

        // Parse bank deposit section
        if (rawData[2] && rawData[2][4] === 'Remise Bancaire (SAP)') {
            parsedData.bankDeposit.reference = rawData[2][6] || '';
        }

        // Parse payment methods
        for (let i = 3; i <= 6; i++) {
            if (rawData[i]) {
                const row = rawData[i];
                if (row[8] === 'ESPECES') {
                    parsedData.bankDeposit.cash = {
                        reference: row[6] || '',
                        amount: row[10] || 0
                    };
                } else if (row[8] === 'CHEQUES') {
                    parsedData.bankDeposit.checks = {
                        reference: row[6] || '',
                        amount: row[10] || 0
                    };
                } else if (row[8] === 'CARTE CREDIT') {
                    parsedData.bankDeposit.creditCard = {
                        amount: row[10] || 0
                    };
                } else if (row[8] === 'VIREMENT') {
                    parsedData.bankDeposit.transfer = {
                        amount: row[10] || 0
                    };
                }
            }
        }

        // Parse Cash Register - Billets (Bills)
        const cashBills = [];
        for (let i = 8; i <= 13; i++) {
            if (rawData[i] && rawData[i][1] && rawData[i][1].includes('Billets')) {
                cashBills.push({
                    denomination: rawData[i][1],
                    amount: rawData[i][2] || 0
                });
            } else if (rawData[i] && rawData[i][1] === 'Monnaie') {
                cashBills.push({
                    denomination: 'Monnaie',
                    amount: rawData[i][2] || 0
                });
            } else if (rawData[i] && rawData[i][1] === 'Total') {
                parsedData.cashRegister.cash.total = rawData[i][2] || 0;
            } else if (rawData[i] && rawData[i][1] === 'Fond de caisse') {
                parsedData.cashRegister.cash.fundDesk = rawData[i][2] || 0;
            }
        }
        parsedData.cashRegister.cash.bills = cashBills;

        // Parse Cash Register - Checks
        const cashChecks = [];
        for (let i = 9; i <= 14; i++) {
            if (rawData[i] && rawData[i][3] && rawData[i][4] && rawData[i][3] !== 'Client') {
                cashChecks.push({
                    client: rawData[i][3],
                    amount: rawData[i][4] || 0
                });
            }
            if (rawData[i] && rawData[i][3] === 'Total' && rawData[i][4]) {
                parsedData.cashRegister.checks.total = rawData[i][4];
            }
        }
        parsedData.cashRegister.checks.items = cashChecks;

        // Parse Cash Register - Credit Card
        const creditCardItems = [];
        for (let i = 9; i <= 14; i++) {
            if (rawData[i] && rawData[i][5] && rawData[i][6] && rawData[i][5] !== 'Client') {
                creditCardItems.push({
                    client: rawData[i][5],
                    amount: rawData[i][6] || 0
                });
            }
            if (rawData[i] && rawData[i][5] === 'Total' && rawData[i][6]) {
                parsedData.cashRegister.creditCard.total = rawData[i][6];
            }
        }
        parsedData.cashRegister.creditCard.items = creditCardItems;

        // Parse Expenses
        for (let i = 9; i <= 15; i++) {
            if (rawData[i] && rawData[i][8] && rawData[i][11] && !rawData[i][8].includes('Dépenses')) {
                if (rawData[i][8] !== 'Différence Fond Caisse') {
                    parsedData.expenses.push({
                        description: rawData[i][8],
                        amount: rawData[i][11] || 0
                    });
                } else {
                    parsedData.cashRegister.cash.difference = rawData[i][11] || 0;
                }
            }
        }

        // Parse total expenses difference
        if (rawData[15] && rawData[15][10] === 'Total') {
            parsedData.expenses.totalDifference = rawData[15][11] || 0;
        }

        // Parse Delivery Payments - Checks
        let currentSection = null;
        for (let i = 18; i < rawData.length; i++) {
            const row = rawData[i];

            if (!row || row.every(cell => !cell)) continue;

            // Identify sections
            if (row[1] === 'Paiements Chèques' || row[0] === 'Card Code') {
                currentSection = 'checks';
                continue;
            } else if (row[0] === 'Card Code' && row[1] === 'Paiements Espèces') {
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
            } else if (row[1] && row[1].includes('TOTAL')) {
                // Parse totals
                if (row[1] === 'TOTAL ESPECES') {
                    parsedData.totals.cash = row[4] || 0;
                } else if (row[1] === 'TOTAL CHEQUES') {
                    parsedData.totals.checks = row[4] || 0;
                } else if (row[1] === 'TOTAL CB Internet & Phone') {
                    parsedData.totals.creditCard = row[4] || 0;
                }
                continue;
            }

            // Parse data based on current section
            if (currentSection === 'checks' && row[0] && row[1]) {
                parsedData.deliveries.checks.push({
                    cardCode: row[0],
                    client: row[1],
                    amount: row[4] || 0,
                    bank: row[5] || '',
                    checkNumber: row[6] || '',
                    remarks: row[7] || '',
                    sap: row[11] || ''
                });
            } else if (currentSection === 'cash' && row[0] && row[1]) {
                parsedData.deliveries.cash.push({
                    cardCode: row[0],
                    client: row[1],
                    amount: row[4] || 0,
                    remarks: row[5] || '',
                    sap: row[11] || ''
                });
            } else if (currentSection === 'creditCardSite' && (row[0] || row[1] || row[2])) {
                parsedData.deliveries.creditCardSite.push({
                    cardCode: row[0] || '',
                    client: (row[1] || row[2] || '').trim(),
                    amount: row[4] || 0,
                    remarks: row[5] || '',
                    sap: row[11] || ''
                });
            } else if (currentSection === 'creditCardPhone' && row[2]) {
                parsedData.deliveries.creditCardPhone.push({
                    amount: row[2] || 0,
                    client: row[3] || ''
                });
            } else if (currentSection === 'unpaid' && (row[1] || row[2])) {
                parsedData.deliveries.unpaid.push({
                    client: (row[1] || row[2] || '').trim(),
                    amount: row[4] || 0,
                    remarks: row[5] || '',
                    sap: row[11] || ''
                });
            }
        }

        return res.status(200).json({
            success: true,
            message: "File parsed successfully",
            data: parsedData
        });

    } catch (error) {
        console.error("Error parsing salary sheet:", error);
        return res.status(500).json({
            success: false,
            message: "Error parsing file",
            error: error.message
        });
    }
};

// Helper function to convert Excel date to readable format
function convertExcelDate(excelDate) {
    const epoch = new Date(1900, 0, 1);
    const excelEpoch = new Date(epoch.getTime() + (excelDate - 2) * 86400000);
    return excelEpoch.toISOString().split('T')[0];
}