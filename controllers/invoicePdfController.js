// controllers/invoicePdfController.js
const Invoice = require("../models/Invoice");
const PDFDocument = require("pdfkit");
const axios = require("axios");
const Customer = require("../models/Customer");
const { sendEmail } = require("../utils/emailService");
// Helper function to sanitize text for PDF rendering
// Helper function to sanitize text for PDF rendering
const sanitizeText = (text) => {
    if (!text) return "";
    return text
        // Remove all carriage returns and normalize line breaks
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        // Remove any remaining non-printable characters except spaces and line breaks
        .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '')
        // Replace common French accented characters
        .replace(/[àâä]/g, 'a')
        .replace(/[éèêë]/g, 'e')
        .replace(/[îï]/g, 'i')
        .replace(/[ôö]/g, 'o')
        .replace(/[ùûü]/g, 'u')
        .replace(/ÿ/g, 'y')
        .replace(/ç/g, 'c')
        .replace(/[ÀÂÄ]/g, 'A')
        .replace(/[ÉÈÊË]/g, 'E')
        .replace(/[ÎÏ]/g, 'I')
        .replace(/[ÔÖ]/g, 'O')
        .replace(/[ÙÛÜ]/g, 'U')
        .replace(/Ÿ/g, 'Y')
        .replace(/Ç/g, 'C')
        // Remove any other non-ASCII characters
        .replace(/[^\x20-\x7E\n]/g, '')
        .trim();
};
// Helper function to download image from URL
const downloadImage = async (url) => {
    try {
        const response = await axios.get(url, { responseType: "arraybuffer" });
        return Buffer.from(response.data);
    } catch (error) {
        console.error("Error downloading image:", error);
        return null;
    }
};

// Helper function to format currency
const formatCurrency = (amount, currency = "EUR") => {
    const formatted = new Intl.NumberFormat("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(amount);

    // Add currency symbol
    const currencySymbols = {
        "EUR": "€",
        "USD": "$",
        "GBP": "£"
    };

    return `${formatted} ${currencySymbols[currency] || currency}`;
};

// Helper function to format date
const formatDate = (date) => {
    if (!date) return "";
    return new Date(date).toLocaleDateString("fr-FR", {
        day: "2-digit",
        month: "2-digit",
        year: "2-digit",
    });
};

// Generate single invoice (can span multiple pages)
const generateInvoicePage = async (doc, invoice, logoBuffer, isFirstInvoice = false) => {
    if (!isFirstInvoice) {
        doc.addPage();
    }

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const margin = 40;
    const footerHeight = 80;
    const maxContentY = pageHeight - footerHeight - 30;

    const drawFooter = () => {
        const footerY = pageHeight - 80;
        doc.strokeColor("#CCCCCC").lineWidth(0.5).dash(2, 2);
        doc.moveTo(margin, footerY - 10).lineTo(pageWidth - margin, footerY - 10).stroke();
        doc.undash();

        doc.fontSize(7).font("Helvetica").fillColor("#000000");
        doc.text("Siret: 79854544800010", margin, footerY, { continued: false });
        doc.text("TVA No.: FR02798545448", margin, footerY + 12, { continued: false });

        const footerRightX = pageWidth - 250;
        doc.text("IBAN: fr7610107006090001804792320", footerRightX, footerY, { continued: false });
        doc.text("SWIFT: BREDFRPPXXX", footerRightX, footerY + 12, { continued: false });

        doc.fontSize(6).font("Helvetica").fillColor("#666666");
        const centerX = pageWidth / 2;
        doc.text("Une copie complète de nos termes et conditions sont disponibles sur demande", centerX - 100, footerY + 30, { continued: false });
    };

    const drawHeader = () => {
        if (logoBuffer) {
            try {
                doc.image(logoBuffer, margin, margin, { width: 120, height: 60 });
            } catch (error) {
                console.error("Error adding logo:", error);
            }
        }

        doc.fontSize(10).font("Helvetica-Bold").fillColor("#000000");
        doc.text("Halal Food Service", margin, margin + 70, { continued: false });

        doc.font("Helvetica").fontSize(7.5);
        doc.text("Batiment 3 et 4", margin, margin + 85, { continued: false });
        doc.text("32 rue raspail", margin, margin + 97, { continued: false });
        doc.text("93120 LA COURNEUVE", margin, margin + 109, { continued: false });
        doc.text("FRANCE", margin, margin + 121, { continued: false });

        doc.fontSize(8);
        doc.text("T: 00 33 179 64 84 00", margin, margin + 133, { continued: false });
        doc.text("E: commande@halalfs.com", margin, margin + 145, { continued: false });
        doc.text("W: www.halalfs.com", margin, margin + 157, { continued: false });

        const rightColumnX = pageWidth - 200;

        doc.rect(rightColumnX - 10, margin, 8, 20).fill("#FFD700");
        doc.fontSize(16).font("Helvetica-Bold").fillColor("#000000");
        doc.text("Facture", rightColumnX, margin, { continued: false });



        let rightY = margin + 45;

        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text("Document Number", rightColumnX - 180, rightY, { continued: false });
        doc.font("Helvetica-Bold").fillColor("#000000");
        doc.text(invoice.DocNum || "", rightColumnX - 180, rightY + 12, { continued: false });

        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text("Document Date", rightColumnX - 70, rightY, { continued: false });
        doc.font("Helvetica-Bold").fillColor("#000000");
        doc.text(formatDate(invoice.DocDate), rightColumnX - 70, rightY + 12, { continued: false });

        doc.font("Helvetica").fillColor("#666666");
        doc.text("Page", rightColumnX + 40, rightY, { continued: false });
        doc.font("Helvetica-Bold").fillColor("#000000");
        doc.text("1/1", rightColumnX + 40, rightY + 12, { continued: false });

        doc.strokeColor("#CCCCCC").lineWidth(0.5).dash(2, 2);
        doc.moveTo(rightColumnX - 180, rightY + 26).lineTo(pageWidth - margin, rightY + 26).stroke();
        doc.undash();

        rightY += 30;

        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text("Client No.", rightColumnX - 180, rightY, { continued: false });
        doc.font("Helvetica-Bold").fillColor("#000000");
        doc.text(invoice.CardCode || "", rightColumnX - 180, rightY + 12, { continued: false });
        doc.font("Helvetica").fillColor("#666666");
        doc.text("Client TVA", rightColumnX - 70, rightY, { continued: false });

        doc.strokeColor("#CCCCCC").lineWidth(0.5).dash(2, 2);
        doc.moveTo(rightColumnX - 180, rightY + 26).lineTo(pageWidth - margin, rightY + 26).stroke();
        doc.undash();

        rightY += 30;

        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text("Bon de Livraison No.", rightColumnX - 180, rightY, { continued: false });
        doc.font("Helvetica-Bold").fillColor("#000000");
        doc.text(invoice.OriginatingDeliveryNote || "N/A", rightColumnX - 180, rightY + 12, { continued: false });

        doc.font("Helvetica").fillColor("#666666");
        doc.text("Devise", rightColumnX - 70, rightY, { continued: false });
        doc.font("Helvetica-Bold").fillColor("#000000");
        doc.text(invoice.DocCurrency || "EUR", rightColumnX - 70, rightY + 12, { continued: false });

        doc.font("Helvetica").fillColor("#666666");
        doc.text("Date de Echance", rightColumnX + 40, rightY, { continued: false });
        doc.font("Helvetica-Bold").fillColor("#000000");
        doc.text(formatDate(invoice.DocDueDate), rightColumnX + 40, rightY + 12, { continued: false });

        doc.strokeColor("#CCCCCC").lineWidth(0.5).dash(2, 2);
        doc.moveTo(rightColumnX - 180, rightY + 26).lineTo(pageWidth - margin, rightY + 26).stroke();
        doc.undash();

        return margin + 200;
    };

    const drawAddresses = (startY) => {
        // LEFT COLUMN - Billing Address with customer name on top
        doc.fontSize(10).font("Helvetica-Bold").fillColor("#000000");
        doc.text(invoice.CardName || "", margin, startY, {
            width: (pageWidth / 2) - margin - 20,
            continued: false
        });

        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text("Addresse de facturation", margin, startY + 15, { continued: false });

        const cleanAddress = sanitizeText(invoice.Address);
        const addressLines = cleanAddress
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .slice(0, 3);

        let yOffset = startY + 30;
        doc.font("Helvetica").fontSize(9).fillColor("#000000");
        addressLines.forEach(line => {
            doc.text(line.substring(0, 50), margin, yOffset, { continued: false });
            yOffset += 12;
        });
        // RIGHT COLUMN - Delivery Address with customer name on top
        const deliveryX = pageWidth / 2 + 20;

        doc.fontSize(10).font("Helvetica-Bold").fillColor("#000000");
        doc.text(invoice.CardName || "", deliveryX, startY, {
            width: (pageWidth / 2) - margin - 20,
            continued: false
        });

        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text("Addresse de livraison", deliveryX, startY + 15, { continued: false });

        if (invoice.Address) {
            // Clean and split the address properly
            const cleanAddress = sanitizeText(invoice.Address);
            const addressLines = cleanAddress
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0)
                .slice(0, 3);

            let yOffset = startY + 30;
            doc.font("Helvetica").fontSize(9).fillColor("#000000");
            addressLines.forEach(line => {
                doc.text(line.substring(0, 50), deliveryX, yOffset, { continued: false });
                yOffset += 12;
            });
        } else {
            doc.font("Helvetica").fontSize(9);
            doc.text("2 avenue emilie zola", deliveryX, startY + 30, { continued: false });
            doc.text("75015 PARIS", deliveryX, startY + 42, { continued: false });
            doc.text("FRANCE", deliveryX, startY + 54, { continued: false });
        }

        return startY + 75;
    };

    const drawTableHeader = (startY) => {
        doc.rect(margin - 15, startY, pageWidth - (2 * margin) + 15, 18).fill("#F5F5F5");
        const col1 = margin - 10;
        const col2 = margin + 60;      // Adjusted
        const col3 = pageWidth - 285;  // Moved left
        const col4 = pageWidth - 215;  // Moved left
        const col5 = pageWidth - 145;  // Moved left
        const col6 = pageWidth - 85;

        doc.fontSize(8).font("Helvetica").fillColor("#000000");
        doc.text("Article Code", col1, startY + 5, { continued: false });
        doc.text("Description", col2, startY + 5, { continued: false });
        doc.text("Quantite", col3 + 20, startY + 5, { continued: false });
        doc.text("Prix", col4 + 30, startY + 5, { continued: false });
        doc.text("Total", col5 + 20, startY + 5, { continued: false });
        doc.text("TVA", col6 + 10, startY + 5, { continued: false });

        doc.strokeColor("#2E5CB8").lineWidth(1.5);
        doc.moveTo(margin - 15, startY + 18).lineTo(pageWidth - margin, startY + 18).stroke();
        return startY + 25;
    };

    // Calculate credit notes and payments
    let totalCreditAmount = 0;
    if (invoice.hasCreditNotes && invoice.totalCreditAmount) {
        totalCreditAmount = invoice.totalCreditAmount;
    }

    let totalPaidAmount = 0;
    if (invoice.hasPayments && invoice.totalPaidAmount) {
        totalPaidAmount = invoice.totalPaidAmount;
    }

    let remainingBalance = (invoice.DocTotal || 0) - totalCreditAmount - totalPaidAmount;

    const drawTotals = (totalExVAT, totalVAT, totalCreditAmount, totalPaidAmount, remainingBalance, yPosition, totalIncVAT) => {
        const totalsLabelX = pageWidth - 240;  // FIXED
        const totalsValueX = pageWidth - 100;

        const lineSpacing = 18;

        doc.rect(totalsLabelX - 10, yPosition, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text("Total Avant Remise", totalsLabelX, yPosition, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text(formatCurrency(totalExVAT, invoice.DocCurrency), totalsValueX, yPosition, { continued: false });

        doc.rect(totalsLabelX - 10, yPosition + lineSpacing, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text("Total Remise", totalsLabelX, yPosition + lineSpacing, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text(formatCurrency(0, invoice.DocCurrency), totalsValueX, yPosition + lineSpacing, { continued: false });

        doc.rect(totalsLabelX - 10, yPosition + lineSpacing * 2, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text("Total Apres Remise", totalsLabelX, yPosition + lineSpacing * 2, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text(formatCurrency(totalExVAT, invoice.DocCurrency), totalsValueX, yPosition + lineSpacing * 2, { continued: false });

        doc.rect(totalsLabelX - 10, yPosition + lineSpacing * 3, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text("TVA Totale", totalsLabelX, yPosition + lineSpacing * 3, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text(formatCurrency(totalVAT, invoice.DocCurrency), totalsValueX, yPosition + lineSpacing * 3, { continued: false });

        doc.rect(totalsLabelX - 10, yPosition + lineSpacing * 4, 3, 14).fill("#FFD700");
        doc.fontSize(11).font("Helvetica-Bold").fillColor("#000000");
        doc.text("Totale TTC", totalsLabelX, yPosition + lineSpacing * 4, { continued: false });
        doc.text(formatCurrency(totalIncVAT, invoice.DocCurrency), totalsValueX, yPosition + lineSpacing * 4, { continued: false });

        let currentY = yPosition + lineSpacing * 5;

        // Credit Notes Section
        if (totalCreditAmount > 0) {
            doc.rect(totalsLabelX - 10, currentY, 3, 12).fill("#FF6B6B");
            doc.fontSize(9).font("Helvetica").fillColor("#DC2626");
            doc.text("Avoir(s) Appliqué(s)", totalsLabelX, currentY, { continued: false });
            doc.font("Helvetica-Bold");
            doc.text(`-${formatCurrency(totalCreditAmount, invoice.DocCurrency)}`, totalsValueX, currentY, { continued: false });
            currentY += lineSpacing;
        }

        // Payments Section
        if (totalPaidAmount > 0) {
            doc.rect(totalsLabelX - 10, currentY, 3, 12).fill("#10B981");
            doc.fontSize(9).font("Helvetica").fillColor("#059669");
            doc.text("Paiement(s) Reçu(s)", totalsLabelX, currentY, { continued: false });
            doc.font("Helvetica-Bold");
            doc.text(`-${formatCurrency(totalPaidAmount, invoice.DocCurrency)}`, totalsValueX, currentY, { continued: false });
            currentY += lineSpacing;
        }

        // Remaining Balance
        if (totalCreditAmount > 0 || totalPaidAmount > 0) {
            doc.strokeColor("#CCCCCC").lineWidth(0.5).dash(2, 2);
            doc.moveTo(totalsLabelX - 10, currentY).lineTo(pageWidth - margin, currentY).stroke();
            doc.undash();
            currentY += 10;

            doc.rect(totalsLabelX - 10, currentY, 3, 14).fill(remainingBalance > 0 ? "#F59E0B" : "#10B981");
            doc.fontSize(11).font("Helvetica-Bold").fillColor(remainingBalance > 0 ? "#D97706" : "#059669");
            doc.text("Solde Restant", totalsLabelX, currentY, { continued: false });
            doc.text(formatCurrency(remainingBalance, invoice.DocCurrency), totalsValueX, currentY, { continued: false });
            currentY += lineSpacing;

            if (remainingBalance <= 0) {
                doc.fontSize(8).font("Helvetica-Bold").fillColor("#059669");
                doc.text("✓ PAYÉ", totalsValueX + 10, currentY, { continued: false });
            } else if (totalPaidAmount > 0 || totalCreditAmount > 0) {
                doc.fontSize(8).font("Helvetica-Bold").fillColor("#D97706");
                doc.text("PARTIELLEMENT PAYÉ", totalsValueX - 20, currentY, { continued: false });
            }
            currentY += lineSpacing;
        } else {
            currentY += lineSpacing;
        }

        doc.rect(totalsLabelX - 10, currentY, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text(`Devise ${invoice.DocCurrency || "EUR"}`, totalsLabelX, currentY, { continued: false });
        currentY += lineSpacing;

        return currentY;
    };

    let currentY = drawHeader();
    currentY = drawAddresses(currentY);
    currentY = drawTableHeader(currentY);

    const col1 = margin - 10;
    const col2 = margin + 65;
    const col3 = pageWidth - 255;
    const col4 = pageWidth - 185;
    const col5 = pageWidth - 125;
    const col6 = pageWidth - 75;

    // FIX 3: Optimized spacing (account for payment info in totals)
    const rowHeight = 12;
    let totalIncVAT = invoice.DocTotal;
    let totalVAT = invoice.VatSum ? invoice.VatSum : invoice.DocTotal - invoice.DocumentLines.map(line => {
        const lineVAT = line.Price * line.Quantity;
        return lineVAT;
    }).reduce((acc, curr) => acc + curr, 0);
    let totalExVAT = totalIncVAT - totalVAT;
    // Dynamic totals height based on payment status
    let totalsHeight = 110; // Base height
    if (totalCreditAmount > 0) totalsHeight += 20;
    if (totalPaidAmount > 0) totalsHeight += 20;
    if (totalCreditAmount > 0 || totalPaidAmount > 0) totalsHeight += 40; // For balance + status

    const notesHeight = 15;
    const blueLineHeight = 20;

    if (invoice.DocumentLines && invoice.DocumentLines.length > 0) {
        for (let i = 0; i < invoice.DocumentLines.length; i++) {
            const line = invoice.DocumentLines[i];

            // FIX 3: Only reserve space on LAST item
            const isLastItem = (i === invoice.DocumentLines.length - 1);
            const reserveSpace = isLastItem ? (totalsHeight + notesHeight + blueLineHeight) : 0;

            if (currentY + rowHeight + reserveSpace > maxContentY) {
                drawFooter();
                doc.addPage();
                currentY = margin + 50;
                currentY = drawTableHeader(currentY);
            }

            const lineTotal = (line.Quantity || 0) * (line.Price || 0);
            const vatRate = line.VatGroup === "C3" ? 0.055 : line.VatGroup === "C4" ? 0.20 : (line.VatPcnt || 0) / 100;
            const vatAmount = lineTotal * vatRate;


            doc.font("Helvetica").fontSize(7.5).fillColor("#000000");
            doc.text(line.ItemCode || "", col1, currentY, { continued: false });
            doc.text((line.ItemDescription || "").substring(0, 40), col2, currentY, { continued: false });
            doc.text((line.Quantity || 0).toString(), col3 + 30, currentY, { continued: false });
            doc.text(formatCurrency(line.Price || 0, invoice.DocCurrency), col4 + 20, currentY, { continued: false });
            doc.text(formatCurrency(lineTotal, invoice.DocCurrency), col5 + 10, currentY, { continued: false });
            doc.text(formatCurrency(vatAmount, invoice.DocCurrency), col6 + 5, currentY, { continued: false });
            currentY += rowHeight;
        }
    }

    // FIX 3: Precise space check
    const spaceNeeded = totalsHeight + notesHeight + blueLineHeight + 10;

    if (currentY + spaceNeeded > maxContentY) {
        drawFooter();
        doc.addPage();
        currentY = margin + 50;
    }

    doc.strokeColor("#2E5CB8").lineWidth(1.5);
    doc.moveTo(margin - 15, currentY + 5).lineTo(pageWidth - margin, currentY + 5).stroke();

    currentY += 15;

    doc.strokeColor("#2E5CB8").lineWidth(1.5);
    doc.moveTo(margin - 15, currentY - 10).lineTo(pageWidth - margin, currentY - 10).stroke();

    doc.fontSize(8).font("Helvetica").fillColor("#666666");
    doc.text("Notes:", margin, currentY, { continued: false });
    // Display Comments field only
    if (invoice.Comments) {
        doc.fontSize(8).font("Helvetica").fillColor("#000000");
        doc.text(invoice.Comments, margin, currentY + 12, {
            width: pageWidth - margin - 280,
            continued: false
        });
    }
    currentY = drawTotals(totalExVAT, totalVAT, totalCreditAmount, totalPaidAmount, remainingBalance, currentY, totalIncVAT);

    drawFooter();
};

/**
 * Build a single PDF buffer containing one page per invoice.
 * Reusable helper so other services (e.g. the automated daily invoice email
 * job) render invoices exactly the same way as the manual flows above.
 *
 * @param {Array} invoices - array of (lean or hydrated) invoice documents
 * @returns {Promise<Buffer>} the generated PDF as a Buffer
 */
exports.buildInvoicesPdfBuffer = async (invoices) => {
    if (!Array.isArray(invoices) || invoices.length === 0) {
        throw new Error("buildInvoicesPdfBuffer requires a non-empty array of invoices");
    }

    // Download logo once
    const logoUrl = "https://imageshfs.s3.ap-southeast-2.amazonaws.com/image-removebg-preview+(1).png";
    const logoBuffer = await downloadImage(logoUrl);

    const doc = new PDFDocument({
        size: "A4",
        margins: { top: 40, bottom: 40, left: 40, right: 40 },
        bufferPages: true,
    });

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));

    const pdfPromise = new Promise((resolve, reject) => {
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);
    });

    for (let i = 0; i < invoices.length; i++) {
        await generateInvoicePage(doc, invoices[i], logoBuffer, i === 0);
    }

    doc.end();
    return pdfPromise;
};

// controllers/invoicePdfController.js
// Add this helper function at the end of the file
// Bulk email invoices grouped by customer
exports.bulkEmailInvoicesByCustomer = async (req, res) => {
    try {
        const { invoiceIds, emailOverrides = {} } = req.body;

        if (!invoiceIds || !Array.isArray(invoiceIds) || invoiceIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Please provide an array of invoice IDs"
            });
        }

        console.log(`Processing ${invoiceIds.length} invoices for bulk email...`);

        // Fetch all invoices
        const invoices = await Invoice.find({ _id: { $in: invoiceIds } })
            .populate("salesAgent", "firstName lastName email")
            .lean();

        if (invoices.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No invoices found"
            });
        }

        // Get customers with emails
        const Customer = require("../models/Customer");
        const cardCodes = [...new Set(invoices.map(inv => inv.CardCode))];
        const customers = await Customer.find({
            CardCode: { $in: cardCodes }
        }).lean();

        const customerEmailMap = {};
        customers.forEach(customer => {
            customerEmailMap[customer.CardCode] = customer.Email;
        });

        // Group invoices by customer
        const invoicesByCustomer = {};
        invoices.forEach(invoice => {
            const cardCode = invoice.CardCode;
            if (!invoicesByCustomer[cardCode]) {
                // CRITICAL FIX: Use emailOverrides first, then fall back to customer email
                const overrideEmail = emailOverrides[cardCode];
                const customerEmail = customerEmailMap[cardCode];

                invoicesByCustomer[cardCode] = {
                    customerName: invoice.CardName,
                    email: overrideEmail || customerEmail, // Priority: override > customer email
                    invoices: []
                };

                console.log(`📧 Customer ${cardCode}: Override=${overrideEmail}, Customer=${customerEmail}, Using=${overrideEmail || customerEmail}`);
            }
            invoicesByCustomer[cardCode].invoices.push(invoice);
        });

        console.log(`Grouped into ${Object.keys(invoicesByCustomer).length} customers`);

        // Download logo once
        const logoUrl = "https://imageshfs.s3.ap-southeast-2.amazonaws.com/image-removebg-preview+(1).png";
        const logoBuffer = await downloadImage(logoUrl);

        const results = {
            sent: [],
            failed: [],
            skipped: []
        };

        // Process each customer
        for (const [cardCode, data] of Object.entries(invoicesByCustomer)) {
            try {
                if (!data.email || !data.email.trim()) {
                    results.skipped.push({
                        cardCode,
                        customerName: data.customerName,
                        invoiceCount: data.invoices.length,
                        reason: "No email address provided"
                    });
                    continue;
                }

                // Validate email format
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (!emailRegex.test(data.email)) {
                    results.skipped.push({
                        cardCode,
                        customerName: data.customerName,
                        invoiceCount: data.invoices.length,
                        reason: "Invalid email format"
                    });
                    continue;
                }

                // Generate PDF with all invoices for this customer
                const doc = new PDFDocument({
                    size: "A4",
                    margins: { top: 40, bottom: 40, left: 40, right: 40 },
                    bufferPages: true
                });

                const chunks = [];
                doc.on('data', (chunk) => chunks.push(chunk));

                const pdfPromise = new Promise((resolve, reject) => {
                    doc.on('end', () => {
                        const pdfBuffer = Buffer.concat(chunks);
                        resolve(pdfBuffer);
                    });
                    doc.on('error', reject);
                });

                // Add all invoices to PDF
                for (let i = 0; i < data.invoices.length; i++) {
                    await generateInvoicePage(doc, data.invoices[i], logoBuffer, i === 0);
                }

                doc.end();
                const pdfBuffer = await pdfPromise;

                // Prepare email
                const invoiceNumbers = data.invoices.map(inv => inv.DocNum).join(", ");
                const totalAmount = data.invoices.reduce((sum, inv) => sum + (inv.DocTotal || 0), 0);

                const emailSubject = data.invoices.length === 1
                    ? `Facture #${data.invoices[0].DocNum} - ${data.customerName}`
                    : `Factures (${data.invoices.length}) - ${data.customerName}`;

                const emailText = `
Bonjour,

Veuillez trouver ci-joint ${data.invoices.length === 1 ? 'votre facture' : `vos ${data.invoices.length} factures`}.

${data.invoices.length === 1 ? 'Numéro: ' : 'Numéros: '}${invoiceNumbers}
Montant total: ${formatCurrency(totalAmount, data.invoices[0].DocCurrency || "EUR")}

Cordialement,
Halal Food Service
                `.trim();

                const filename = data.invoices.length === 1
                    ? `Facture-${data.invoices[0].DocNum}.pdf`
                    : `Factures-${cardCode}-${Date.now()}.pdf`;

                // Send email
                await sendEmail({
                    to: data.email,
                    subject: emailSubject,
                    text: emailText,
                    attachments: [
                        {
                            filename: filename,
                            content: pdfBuffer,
                            contentType: "application/pdf"
                        }
                    ]
                });

                results.sent.push({
                    cardCode,
                    customerName: data.customerName,
                    email: data.email,
                    invoiceCount: data.invoices.length,
                    invoiceNumbers: data.invoices.map(inv => inv.DocNum)
                });

                console.log(`✅ Sent ${data.invoices.length} invoice(s) to ${data.email}`);

            } catch (error) {
                console.error(`❌ Failed to send to ${cardCode}:`, error);
                results.failed.push({
                    cardCode,
                    customerName: data.customerName,
                    email: data.email,
                    invoiceCount: data.invoices.length,
                    error: error.message
                });
            }
        }

        res.status(200).json({
            success: true,
            message: `Sent emails to ${results.sent.length} customer(s)`,
            data: results
        });

    } catch (error) {
        console.error("Error in bulk email:", error);
        res.status(500).json({
            success: false,
            message: "Error sending bulk emails",
            error: error.message
        });
    }
};
/**
 * Send invoice email to customer (helper function)
 * Can be called internally from other controllers
 */
exports.sendInvoiceEmailToCustomer = async (invoiceId, emailOptions) => {
    try {
        const { recipientEmail, ccEmail, subject, message } = emailOptions;

        if (!invoiceId || !recipientEmail) {
            return {
                success: false,
                error: "Invoice ID and recipient email are required"
            };
        }

        console.log(`Preparing to email invoice ${invoiceId} to ${recipientEmail}`);

        // Fetch invoice
        const invoice = await Invoice.findById(invoiceId)
            .populate("salesAgent", "firstName lastName email");

        if (!invoice) {
            return {
                success: false,
                error: "Invoice not found"
            };
        }

        // Download logo
        const logoUrl = "https://imageshfs.s3.ap-southeast-2.amazonaws.com/image-removebg-preview+(1).png";
        const logoBuffer = await downloadImage(logoUrl);

        // Generate PDF in memory
        const doc = new PDFDocument({
            size: "A4",
            margins: { top: 40, bottom: 40, left: 40, right: 40 },
            bufferPages: true
        });

        // Collect PDF data in buffer
        const chunks = [];
        doc.on('data', (chunk) => chunks.push(chunk));

        const pdfPromise = new Promise((resolve, reject) => {
            doc.on('end', () => {
                const pdfBuffer = Buffer.concat(chunks);
                resolve(pdfBuffer);
            });
            doc.on('error', reject);
        });

        // Generate invoice page
        await generateInvoicePage(doc, invoice, logoBuffer, true);
        doc.end();

        // Wait for PDF generation to complete
        const pdfBuffer = await pdfPromise;

        // Prepare email
        const emailSubject = subject || `Facture #${invoice.DocNum} - ${invoice.CardName}`;
        const emailText = message || `
Bonjour,

Veuillez trouver ci-joint votre facture #${invoice.DocNum}.

Montant total: ${formatCurrency(invoice.DocTotal, invoice.DocCurrency)}
Date: ${formatDate(invoice.DocDate)}
Date d'échéance: ${formatDate(invoice.DocDueDate)}

Cordialement,
Halal Food Service
    `.trim();

        // Send email with PDF attachment
        const emailPayload = {
            to: recipientEmail,
            subject: emailSubject,
            text: emailText,
            attachments: [
                {
                    filename: `Facture-${invoice.DocNum}.pdf`,
                    content: pdfBuffer,
                    contentType: "application/pdf"
                }
            ]
        };

        if (ccEmail) {
            emailPayload.cc = ccEmail;
        }

        await sendEmail(emailPayload);

        console.log(`Invoice ${invoice.DocNum} emailed successfully to ${recipientEmail}`);

        return {
            success: true,
            invoiceNum: invoice.DocNum,
            recipient: recipientEmail,
            cc: ccEmail
        };

    } catch (error) {
        console.error("Error sending invoice email:", error);
        return {
            success: false,
            error: error.message
        };
    }
};

// Main controller function to generate bulk PDFs
exports.generateBulkInvoicePDFs = async (req, res) => {
    try {
        const { invoiceIds } = req.body;

        if (!invoiceIds || !Array.isArray(invoiceIds) || invoiceIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Please provide an array of invoice IDs"
            });
        }

        const invoicesMap = {};
        const fetchedInvoices = await Invoice.find({ _id: { $in: invoiceIds } })
            .populate("salesAgent", "firstName lastName email");

        fetchedInvoices.forEach(invoice => {
            invoicesMap[invoice._id.toString()] = invoice;
        });

        const invoices = invoiceIds
            .map(id => invoicesMap[id.toString()])
            .filter(invoice => invoice !== undefined);

        if (invoices.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No invoices found"
            });
        }

        const logoUrl = "https://imageshfs.s3.ap-southeast-2.amazonaws.com/image-removebg-preview+(1).png";
        const logoBuffer = await downloadImage(logoUrl);

        const doc = new PDFDocument({
            size: "A4",
            margins: { top: 40, bottom: 40, left: 40, right: 40 },
            bufferPages: true
        });

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename=invoices-${Date.now()}.pdf`
        );

        doc.pipe(res);

        // FIX 4: Generate original + copy for EACH invoice immediately
        for (let i = 0; i < invoices.length; i++) {
            // Original
            await generateInvoicePage(doc, invoices[i], logoBuffer, i === 0);

        }

        doc.end();

    } catch (error) {
        console.error("Error generating bulk PDFs:", error);
        if (!res.headersSent) {
            res.status(500).json({
                success: false,
                message: "Error generating PDFs",
                error: error.message
            });
        }
    }
};

// Get invoices for PDF generation (with filters)
exports.getInvoicesForPDF = async (req, res) => {
    try {
        const { fromDate, toDate, cardCode, status, syncStatus, search } = req.query;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        // Build query
        const query = {};

        if (fromDate && toDate) {
            query.DocDate = {
                $gte: new Date(fromDate),
                $lte: new Date(toDate)
            };
        }

        if (cardCode) {
            query.CardCode = { $regex: cardCode, $options: "i" };
        }

        if (status) {
            query.DocumentStatus = status;
        }

        if (syncStatus) {
            if (syncStatus === "synced") {
                query.SyncedWithSAP = true;
            } else if (syncStatus === "unsynced") {
                query.SyncedWithSAP = false;
            } else if (syncStatus === "failed") {
                query.LocalStatus = "SyncFailed";
            }
        }

        if (search) {
            query.$or = [
                { DocNum: { $regex: search, $options: "i" } },
                { CardCode: { $regex: search, $options: "i" } },
                { CardName: { $regex: search, $options: "i" } }
            ];
        }

        // Get invoices
        const [invoices, total] = await Promise.all([
            Invoice.find(query)
                .populate("salesAgent", "firstName lastName")
                .sort({ DocDate: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Invoice.countDocuments(query)
        ]);

        res.json({
            success: true,
            data: invoices,
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error("Error fetching invoices:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching invoices",
            error: error.message
        });
    }
};

// Email invoice to customer
exports.emailInvoiceToCustomer = async (req, res) => {
    try {
        const { invoiceId, recipientEmail, ccEmail, subject, message } = req.body;

        if (!invoiceId || !recipientEmail) {
            return res.status(400).json({
                success: false,
                message: "Invoice ID and recipient email are required"
            });
        }

        console.log(`Emailing invoice ${invoiceId} to ${recipientEmail}`);

        // Fetch invoice
        const invoice = await Invoice.findById(invoiceId)
            .populate("salesAgent", "firstName lastName email");

        if (!invoice) {
            return res.status(404).json({
                success: false,
                message: "Invoice not found"
            });
        }

        // Download logo
        const logoUrl = "https://imageshfs.s3.ap-southeast-2.amazonaws.com/image-removebg-preview+(1).png";
        const logoBuffer = await downloadImage(logoUrl);

        // Generate PDF in memory
        const doc = new PDFDocument({
            size: "A4",
            margins: { top: 40, bottom: 40, left: 40, right: 40 },
            bufferPages: true
        });

        // Collect PDF data in buffer
        const chunks = [];
        doc.on('data', (chunk) => chunks.push(chunk));

        const pdfPromise = new Promise((resolve, reject) => {
            doc.on('end', () => {
                const pdfBuffer = Buffer.concat(chunks);
                resolve(pdfBuffer);
            });
            doc.on('error', reject);
        });

        // Generate invoice page
        await generateInvoicePage(doc, invoice, logoBuffer, true);
        doc.end();

        // Wait for PDF generation to complete
        const pdfBuffer = await pdfPromise;

        // Prepare email
        const emailSubject = subject || `Facture #${invoice.DocNum} - ${invoice.CardName}`;
        const emailText = message || `
Bonjour,

Veuillez trouver ci-joint votre facture #${invoice.DocNum}.

Montant total: ${formatCurrency(invoice.DocTotal, invoice.DocCurrency)}
Date: ${formatDate(invoice.DocDate)}
Date d'échéance: ${formatDate(invoice.DocDueDate)}

Cordialement,
Halal Food Service
        `.trim();

        // Send email with PDF attachment
        const emailOptions = {
            to: recipientEmail,
            subject: emailSubject,
            text: emailText,
            attachments: [
                {
                    filename: `Facture-${invoice.DocNum}.pdf`,
                    content: pdfBuffer,
                    contentType: "application/pdf"
                }
            ]
        };

        if (ccEmail) {
            emailOptions.cc = ccEmail;
        }

        await sendEmail({
            ...emailOptions,
            emailType: "invoice",
            relatedInvoice: invoice._id,
            customerCardCode: invoice.CardCode,
            sentBy: req.user?._id,
            sentByName: req.user ? `${req.user.firstName} ${req.user.lastName}` : "System",
            metadata: {
                invoiceNum: invoice.DocNum,
                docDate: invoice.DocDate,
                docTotal: invoice.DocTotal,
            },
        });

        console.log(`Invoice ${invoice.DocNum} emailed successfully to ${recipientEmail}`);

        res.status(200).json({
            success: true,
            message: `Invoice emailed successfully to ${recipientEmail}`,
            data: {
                invoiceNum: invoice.DocNum,
                recipient: recipientEmail,
                cc: ccEmail
            }
        });

    } catch (error) {
        console.error("Error emailing invoice:", error);
        res.status(500).json({
            success: false,
            message: "Error emailing invoice",
            error: error.message
        });
    }
};

// Resend invoice with apology message
exports.resendInvoiceWithApology = async (req, res) => {
    try {
        const { invoiceId, recipientEmail, ccEmail } = req.body;

        if (!invoiceId || !recipientEmail) {
            return res.status(400).json({
                success: false,
                message: "Invoice ID and recipient email are required"
            });
        }

        console.log(`Resending invoice ${invoiceId} with apology to ${recipientEmail}`);

        // Fetch invoice
        const invoice = await Invoice.findById(invoiceId)
            .populate("salesAgent", "firstName lastName email");

        if (!invoice) {
            return res.status(404).json({
                success: false,
                message: "Invoice not found"
            });
        }

        // Download logo
        const logoUrl = "https://imageshfs.s3.ap-southeast-2.amazonaws.com/image-removebg-preview+(1).png";
        const logoBuffer = await downloadImage(logoUrl);

        // Generate PDF in memory
        const doc = new PDFDocument({
            size: "A4",
            margins: { top: 40, bottom: 40, left: 40, right: 40 },
            bufferPages: true
        });

        // Collect PDF data in buffer
        const chunks = [];
        doc.on('data', (chunk) => chunks.push(chunk));

        const pdfPromise = new Promise((resolve, reject) => {
            doc.on('end', () => {
                const pdfBuffer = Buffer.concat(chunks);
                resolve(pdfBuffer);
            });
            doc.on('error', reject);
        });

        // Generate invoice page
        await generateInvoicePage(doc, invoice, logoBuffer, true);
        doc.end();

        // Wait for PDF generation to complete
        const pdfBuffer = await pdfPromise;

        // Apology email message
        const emailSubject = `Correction - Facture #${invoice.DocNum} - ${invoice.CardName}`;
        const emailText = `Bonjour,

Nous vous prions de bien vouloir nous excuser pour cette erreur. Nous utilisons un nouveau logiciel et il y avait une erreur dans le calcul de la TVA dans l'e-mail recu precedemment.

Veuillez trouver ci-joint la facture correcte pour la livraison d'hier.

Facture #${invoice.DocNum}
Montant total: ${formatCurrency(invoice.DocTotal, invoice.DocCurrency)}
Date: ${formatDate(invoice.DocDate)}
Date d'echeance: ${formatDate(invoice.DocDueDate)}

Nous vous remercions de votre comprehension.

Cordialement,
Halal Food Service`.trim();

        // Send email with PDF attachment
        const emailOptions = {
            to: recipientEmail,
            subject: emailSubject,
            text: emailText,
            attachments: [
                {
                    filename: `Facture-Corrected-${invoice.DocNum}.pdf`,
                    content: pdfBuffer,
                    contentType: "application/pdf"
                }
            ]
        };

        if (ccEmail) {
            emailOptions.cc = ccEmail;
        }

        await sendEmail(emailOptions);

        console.log(`Apology invoice ${invoice.DocNum} emailed successfully to ${recipientEmail}`);

        res.status(200).json({
            success: true,
            message: `Apology email sent successfully to ${recipientEmail}`,
            data: {
                invoiceNum: invoice.DocNum,
                recipient: recipientEmail,
                cc: ccEmail
            }
        });

    } catch (error) {
        console.error("Error resending invoice with apology:", error);
        res.status(500).json({
            success: false,
            message: "Error resending invoice",
            error: error.message
        });
    }
};

// Preview invoices for resending with apology
// Preview invoices for resending with apology
exports.previewResendInvoices = async (req, res) => {
    try {
        const { invoiceIds } = req.body;

        if (!invoiceIds || !Array.isArray(invoiceIds) || invoiceIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Invoice IDs array is required"
            });
        }

        // Fetch invoices
        const invoices = await Invoice.find({ _id: { $in: invoiceIds } })
            .populate("salesAgent", "firstName lastName email")
            .lean();

        // Fetch customer emails for each invoice by CardCode
        const previewData = await Promise.all(
            invoices.map(async (invoice) => {
                let customerEmail = "";
                let hasEmail = false;

                try {
                    // Fetch customer by CardCode to get email
                    const customer = await Customer.findOne({ CardCode: invoice.CardCode }).lean();
                    if (customer && customer.Email) {
                        customerEmail = customer.Email;
                        hasEmail = true;
                    }
                    // customerEmail = "sohaibahmedsipra@gmail.com";
                    // hasEmail = true;
                } catch (error) {
                    console.error(`Error fetching customer email for ${invoice.CardCode}:`, error);
                }

                return {
                    _id: invoice._id,
                    DocNum: invoice.DocNum,
                    CardCode: invoice.CardCode,
                    CardName: invoice.CardName,
                    CustomerEmail: customerEmail,
                    DocDate: invoice.DocDate,
                    DocTotal: invoice.DocTotal,
                    DocCurrency: invoice.DocCurrency || "EUR",
                    hasEmail
                };
            })
        );

        res.json({
            success: true,
            data: previewData,
            summary: {
                total: invoices.length,
                withEmail: previewData.filter(inv => inv.hasEmail).length,
                withoutEmail: previewData.filter(inv => !inv.hasEmail).length
            }
        });

    } catch (error) {
        console.error("Error previewing resend invoices:", error);
        res.status(500).json({
            success: false,
            message: "Error previewing invoices",
            error: error.message
        });
    }
};
// Bulk resend invoices with apology
// Bulk resend invoices with apology
exports.bulkResendInvoicesWithApology = async (req, res) => {
    try {
        const { invoiceIds } = req.body;

        if (!invoiceIds || !Array.isArray(invoiceIds) || invoiceIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Invoice IDs array is required"
            });
        }

        // Fetch invoices
        const invoices = await Invoice.find({ _id: { $in: invoiceIds } })
            .populate("salesAgent", "firstName lastName email");

        const results = {
            successful: [],
            failed: [],
            skipped: []
        };

        // Download logo once
        const logoUrl = "https://imageshfs.s3.ap-southeast-2.amazonaws.com/image-removebg-preview+(1).png";
        const logoBuffer = await downloadImage(logoUrl);

        // Process each invoice
        for (const invoice of invoices) {
            try {
                // Fetch customer email by CardCode
                // let customerEmail = "sohaibahmedsipra@gmail.com";
                try {
                    const customer = await Customer.findOne({ CardCode: invoice.CardCode }).lean();
                    if (customer && customer.Email) {
                        customerEmail = customer.Email;
                    }
                } catch (error) {
                    console.error(`Error fetching customer email for ${invoice.CardCode}:`, error);
                }

                // Skip if no email
                if (!customerEmail || !customerEmail.trim()) {
                    results.skipped.push({
                        invoiceNum: invoice.DocNum,
                        cardCode: invoice.CardCode,
                        reason: "No email address found for customer"
                    });
                    continue;
                }

                // Generate PDF
                const doc = new PDFDocument({
                    size: "A4",
                    margins: { top: 40, bottom: 40, left: 40, right: 40 },
                    bufferPages: true
                });

                const chunks = [];
                doc.on('data', (chunk) => chunks.push(chunk));

                const pdfPromise = new Promise((resolve, reject) => {
                    doc.on('end', () => {
                        const pdfBuffer = Buffer.concat(chunks);
                        resolve(pdfBuffer);
                    });
                    doc.on('error', reject);
                });

                await generateInvoicePage(doc, invoice, logoBuffer, true);
                doc.end();

                const pdfBuffer = await pdfPromise;

                // Prepare apology email
                const emailSubject = `Correction - Facture #${invoice.DocNum} - ${invoice.CardName}`;
                const emailText = `Bonjour,

Nous vous prions de bien vouloir nous excuser pour cette erreur. Nous utilisons un nouveau logiciel et il y avait une erreur dans le calcul de la TVA dans l'e-mail recu precedemment.

Veuillez trouver ci-joint la facture correcte pour la livraison d'hier.

Facture #${invoice.DocNum}
Montant total: ${formatCurrency(invoice.DocTotal, invoice.DocCurrency)}
Date: ${formatDate(invoice.DocDate)}
Date d'echeance: ${formatDate(invoice.DocDueDate)}

Nous vous remercions de votre comprehension.

Cordialement,
Halal Food Service`.trim();

                // Send email with logging
                await sendEmail({
                    to: customerEmail,
                    subject: emailSubject,
                    text: emailText,
                    attachments: [
                        {
                            filename: `Facture-Corrected-${invoice.DocNum}.pdf`,
                            content: pdfBuffer,
                            contentType: "application/pdf"
                        }
                    ],
                    emailType: "invoice_apology",
                    relatedInvoice: invoice._id,
                    customerCardCode: invoice.CardCode,
                    sentBy: req.user?._id,
                    sentByName: req.user ? `${req.user.firstName} ${req.user.lastName}` : "System",
                    metadata: {
                        invoiceNum: invoice.DocNum,
                        docDate: invoice.DocDate,
                        docTotal: invoice.DocTotal,
                        resendReason: "TVA calculation correction",
                    },
                });

                results.successful.push({
                    invoiceNum: invoice.DocNum,
                    cardCode: invoice.CardCode,
                    recipient: customerEmail
                });

                console.log(`✓ Sent apology invoice ${invoice.DocNum} to ${customerEmail}`);

            } catch (error) {
                console.error(`Error processing invoice ${invoice.DocNum}:`, error);
                results.failed.push({
                    invoiceNum: invoice.DocNum,
                    cardCode: invoice.CardCode,
                    error: error.message
                });
            }
        }

        console.log(`Bulk resend completed: ${results.successful.length} successful, ${results.failed.length} failed, ${results.skipped.length} skipped`);

        res.json({
            success: true,
            message: `Processed ${invoices.length} invoices`,
            results
        });

    } catch (error) {
        console.error("Error bulk resending invoices:", error);
        res.status(500).json({
            success: false,
            message: "Error bulk resending invoices",
            error: error.message
        });
    }
};
module.exports = exports;