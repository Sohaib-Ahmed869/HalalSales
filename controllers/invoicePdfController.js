// controllers/invoicePdfController.js
const Invoice = require("../models/Invoice");
const PDFDocument = require("pdfkit");
const axios = require("axios");
const { sendEmail } = require("../utils/emailService");

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
    return new Intl.NumberFormat("fr-FR", {
        style: "currency",
        currency: currency,
    }).format(amount);
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
    // Add new page if not first invoice
    if (!isFirstInvoice) {
        doc.addPage();
    }

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const margin = 40;
    const footerHeight = 80;
    const maxContentY = pageHeight - footerHeight - 40;

    // Helper to draw footer
    const drawFooter = () => {
        const footerY = pageHeight - 80;  // Changed from -60 to -80

        // Add dotted line above footer
        doc.strokeColor("#CCCCCC").lineWidth(0.5).dash(2, 2);
        doc.moveTo(margin, footerY - 10).lineTo(pageWidth - margin, footerY - 10).stroke();
        doc.undash();

        // Left side - Siret and TVA
        doc.fontSize(7).font("Helvetica").fillColor("#000000");
        doc.text("Siret: 79854544800010", margin, footerY, { continued: false });
        doc.text("TVA No.: FR02798545448", margin, footerY + 12, { continued: false });

        // Right side - IBAN and SWIFT
        const footerRightX = pageWidth - 250;
        doc.text("IBAN: fr7610107006090001804792320", footerRightX, footerY, { continued: false });
        doc.text("SWIFT: BREDFRPPXXX", footerRightX, footerY + 12, { continued: false });

        // Bottom disclaimer - single line
        doc.fontSize(6).font("Helvetica").fillColor("#666666");
        const centerX = pageWidth / 2;
        doc.text("Une copie complète de nos termes et conditions sont disponibles sur demande", centerX - 100, footerY + 30, { continued: false });
    };

    // Helper to draw header
    const drawHeader = () => {
        // Add logo at top left
        if (logoBuffer) {
            try {
                doc.image(logoBuffer, margin, margin, { width: 120, height: 60 });
            } catch (error) {
                console.error("Error adding logo:", error);
            }
        }

        // Company info below logo (left side)
        doc.fontSize(10).font("Helvetica-Bold").fillColor("#000000");
        doc.text("Halal Food Service", margin, margin + 70, { continued: false });

        doc.font("Helvetica").fontSize(8);
        doc.text("Batiment 3 et 4", margin, margin + 85, { continued: false });
        doc.text("32 rue raspail", margin, margin + 97, { continued: false });
        doc.text("93120 LA COURNEUVE", margin, margin + 109, { continued: false });
        doc.text("FRANCE", margin, margin + 121, { continued: false });

        // Contact details
        doc.fontSize(8);
        doc.text("T: 00 33 179 64 84 00", margin, margin + 145, { continued: false });
        doc.text("E: commande@halalfs.com", margin, margin + 157, { continued: false });
        doc.text("W: www.halalfs.com", margin, margin + 169, { continued: false });

        // Right side - "Facture" with yellow bar
        const rightColumnX = pageWidth - 200;

        doc.rect(rightColumnX - 10, margin, 8, 20).fill("#FFD700");
        doc.fontSize(16).font("Helvetica-Bold").fillColor("#000000");
        doc.text("Facture", rightColumnX, margin, { continued: false });

        // Document info section
        let rightY = margin + 30;

        // Document Number, Document Date, Page
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

        // Dotted line
        doc.strokeColor("#CCCCCC").lineWidth(0.5).dash(2, 2);
        doc.moveTo(rightColumnX - 180, rightY + 26).lineTo(pageWidth - margin, rightY + 26).stroke();
        doc.undash();

        rightY += 30;

        // Client No. and Client TVA
        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text("Client No.", rightColumnX - 180, rightY, { continued: false });
        doc.font("Helvetica-Bold").fillColor("#000000");
        doc.text(invoice.CardCode || "", rightColumnX - 180, rightY + 12, { continued: false });
        doc.font("Helvetica").fillColor("#666666");
        doc.text("Client TVA", rightColumnX - 70, rightY, { continued: false });

        // Dotted line
        doc.strokeColor("#CCCCCC").lineWidth(0.5).dash(2, 2);
        doc.moveTo(rightColumnX - 180, rightY + 26).lineTo(pageWidth - margin, rightY + 26).stroke();
        doc.undash();

        rightY += 30;

        // Reference to originating delivery note (if applicable)
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

        // Dotted line
        doc.strokeColor("#CCCCCC").lineWidth(0.5).dash(2, 2);
        doc.moveTo(rightColumnX - 180, rightY + 26).lineTo(pageWidth - margin, rightY + 26).stroke();
        doc.undash();

        return margin + 220;
    };

    // Helper to draw addresses
    const drawAddresses = (startY) => {
        // Billing address (left)
        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text("Addresse de facturation", margin, startY, { continued: false });

        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text("2 avenue emilie zola", margin, startY + 20, { continued: false });
        doc.text("75015 PARIS", margin, startY + 33, { continued: false });
        doc.text("FRANCE", margin, startY + 46, { continued: false });

        // Delivery address (right)
        const deliveryX = pageWidth / 2 + 20;
        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text("Addresse de livraison", deliveryX, startY, { continued: false });

        doc.fontSize(9).font("Helvetica-Bold").fillColor("#000000");
        doc.text("Delivery Address", deliveryX, startY + 20, { continued: false });

        if (invoice.Address) {
            const addressLines = invoice.Address.split("\n").filter(line => line.trim()).slice(0, 3);
            let yOffset = startY + 33;
            doc.font("Helvetica");
            addressLines.forEach(line => {
                doc.text(line.trim().substring(0, 50), deliveryX, yOffset, { continued: false });
                yOffset += 13;
            });
        } else {
            doc.font("Helvetica");
            doc.text("2 avenue emilie zola", deliveryX, startY + 33, { continued: false });
            doc.text("75015 PARIS", deliveryX, startY + 46, { continued: false });
            doc.text("FRANCE", deliveryX, startY + 59, { continued: false });
        }

        return startY + 100;
    };

    // Helper to draw table header
    const drawTableHeader = (startY) => {
        doc.rect(margin - 15, startY, pageWidth - (2 * margin) + 15, 18).fill("#F5F5F5");
        const col1 = margin - 10;
        const col2 = margin + 65;
        const col3 = pageWidth - 255;
        const col4 = pageWidth - 185;
        const col5 = pageWidth - 125;
        const col6 = pageWidth - 75;

        doc.fontSize(8).font("Helvetica").fillColor("#000000");
        doc.text("Article Code", col1, startY + 5, { continued: false });
        doc.text("Description", col2, startY + 5, { continued: false });
        doc.text("Quantite", col3 + 20, startY + 5, { continued: false });
        doc.text("Prix", col4 + 30, startY + 5, { continued: false });
        doc.text("Total", col5 + 20, startY + 5, { continued: false });
        doc.text("TVA", col6 + 10, startY + 5, { continued: false });

        // Blue line after header
        doc.strokeColor("#2E5CB8").lineWidth(1.5);
        doc.moveTo(margin - 15, startY + 18).lineTo(pageWidth - margin, startY + 18).stroke();
        return startY + 25;
    };

    // Calculate credit notes if any
    let totalCreditAmount = 0;
    if (invoice.hasCreditNotes && invoice.totalCreditAmount) {
        totalCreditAmount = invoice.totalCreditAmount;
    }

    // Calculate payments if any
    let totalPaidAmount = 0;
    if (invoice.hasPayments && invoice.totalPaidAmount) {
        totalPaidAmount = invoice.totalPaidAmount;
    }

    let remainingBalance = (invoice.DocTotal || 0) - totalCreditAmount - totalPaidAmount;

    const drawTotals = (totalExVAT, totalVAT, totalCreditAmount, totalPaidAmount, remainingBalance, yPosition) => {
        const totalsLabelX = pageWidth - 220;  // Changed from -250 to -220
        const totalsValueX = pageWidth - 80;   // Changed from -100 to -80
        const totalIncVAT = totalExVAT + totalVAT;

        // Total Avant Remise
        doc.rect(totalsLabelX - 10, yPosition, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text("Total Avant Remise", totalsLabelX, yPosition, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text(formatCurrency(totalExVAT, invoice.DocCurrency), totalsValueX, yPosition, { continued: false });

        // Total Remise
        doc.rect(totalsLabelX - 10, yPosition + 20, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text("Total Remise", totalsLabelX, yPosition + 20, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text(formatCurrency(0, invoice.DocCurrency), totalsValueX, yPosition + 20, { continued: false });

        // Total Apres Remise
        doc.rect(totalsLabelX - 10, yPosition + 40, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text("Total Apres Remise", totalsLabelX, yPosition + 40, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text(formatCurrency(totalExVAT, invoice.DocCurrency), totalsValueX, yPosition + 40, { continued: false });

        // TVA Totale
        doc.rect(totalsLabelX - 10, yPosition + 60, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text("TVA Totale", totalsLabelX, yPosition + 60, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text(formatCurrency(totalVAT, invoice.DocCurrency), totalsValueX, yPosition + 60, { continued: false });

        // Totale TTC
        doc.rect(totalsLabelX - 10, yPosition + 80, 3, 14).fill("#FFD700");
        doc.fontSize(11).font("Helvetica-Bold").fillColor("#000000");
        doc.text("Totale TTC", totalsLabelX, yPosition + 80, { continued: false });
        doc.text(formatCurrency(totalIncVAT, invoice.DocCurrency), totalsValueX, yPosition + 80, { continued: false });

        let currentY = yPosition + 100;

        // **NEW: Credit Notes Section**
        if (totalCreditAmount > 0) {
            doc.rect(totalsLabelX - 10, currentY, 3, 12).fill("#FF6B6B");
            doc.fontSize(9).font("Helvetica").fillColor("#DC2626");
            doc.text("Avoir(s) Appliqué(s)", totalsLabelX, currentY, { continued: false });
            doc.font("Helvetica-Bold");
            doc.text(`-${formatCurrency(totalCreditAmount, invoice.DocCurrency)}`, totalsValueX, currentY, { continued: false });
            currentY += 20;
        }

        // **NEW: Payments Section**
        if (totalPaidAmount > 0) {
            doc.rect(totalsLabelX - 10, currentY, 3, 12).fill("#10B981");
            doc.fontSize(9).font("Helvetica").fillColor("#059669");
            doc.text("Paiement(s) Reçu(s)", totalsLabelX, currentY, { continued: false });
            doc.font("Helvetica-Bold");
            doc.text(`-${formatCurrency(totalPaidAmount, invoice.DocCurrency)}`, totalsValueX, currentY, { continued: false });
            currentY += 20;
        }

        // **NEW: Remaining Balance**
        if (totalCreditAmount > 0 || totalPaidAmount > 0) {
            // Dotted line separator
            doc.strokeColor("#CCCCCC").lineWidth(0.5).dash(2, 2);
            doc.moveTo(totalsLabelX - 10, currentY).lineTo(pageWidth - margin, currentY).stroke();
            doc.undash();
            currentY += 10;

            // Remaining balance
            doc.rect(totalsLabelX - 10, currentY, 3, 14).fill(remainingBalance > 0 ? "#F59E0B" : "#10B981");
            doc.fontSize(11).font("Helvetica-Bold").fillColor(remainingBalance > 0 ? "#D97706" : "#059669");
            doc.text("Solde Restant", totalsLabelX, currentY, { continued: false });
            doc.text(formatCurrency(remainingBalance, invoice.DocCurrency), totalsValueX, currentY, { continued: false });
            currentY += 20;

            // Payment status badge
            if (remainingBalance <= 0) {
                doc.fontSize(8).font("Helvetica-Bold").fillColor("#059669");
                doc.text("✓ PAYÉ", totalsValueX + 10, currentY, { continued: false });
            } else if (totalPaidAmount > 0 || totalCreditAmount > 0) {
                doc.fontSize(8).font("Helvetica-Bold").fillColor("#D97706");
                doc.text("PARTIELLEMENT PAYÉ", totalsValueX - 20, currentY, { continued: false });
            }
            currentY += 20;
        } else {
            currentY += 20;
        }

        // Devise
        doc.rect(totalsLabelX - 10, currentY, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text(`Devise ${invoice.DocCurrency || "EUR"}`, totalsLabelX, currentY, { continued: false });
        currentY += 20;

        return currentY;
    };

    // Start drawing the invoice
    let currentY = drawHeader();
    currentY = drawAddresses(currentY);
    currentY = drawTableHeader(currentY);

    // Draw table rows
    const col1 = margin - 10;
    const col2 = margin + 65;
    const col3 = pageWidth - 255;
    const col4 = pageWidth - 185;
    const col5 = pageWidth - 125;
    const col6 = pageWidth - 75;
    const rowHeight = 18;
    let totalExVAT = 0;
    let totalVAT = 0;
    const totalsHeight = 140;
    const notesHeight = 30;

    if (invoice.DocumentLines && invoice.DocumentLines.length > 0) {
        for (let i = 0; i < invoice.DocumentLines.length; i++) {
            const line = invoice.DocumentLines[i];

            // Check if we need a new page
            const isNearEnd = (i >= invoice.DocumentLines.length - 5);
            const reserveSpace = isNearEnd ? (totalsHeight + notesHeight) : 0;

            if (currentY + rowHeight + reserveSpace > maxContentY) {
                drawFooter();  // Draw footer before new page
                // Add continuation page
                doc.addPage();
                currentY = margin + 50;
                currentY = drawTableHeader(currentY);
            }

            const lineTotal = (line.Quantity || 0) * (line.Price || 0);
            const vatAmount = lineTotal * 0.055;

            totalExVAT += lineTotal;
            totalVAT += vatAmount;

            // Use regular font for table text
            doc.font("Helvetica").fontSize(8).fillColor("#000000");
            doc.text(line.ItemCode || "", col1, currentY, { continued: false });
            doc.text((line.ItemDescription || "").substring(0, 40), col2, currentY, { continued: false });
            doc.text((line.Quantity || 0).toString(), col3 + 30, currentY, { continued: false });
            doc.text(formatCurrency(line.Price || 0, invoice.DocCurrency), col4 + 20, currentY, { continued: false });
            doc.text(formatCurrency(lineTotal, invoice.DocCurrency), col5 + 10, currentY, { continued: false });
            doc.text(formatCurrency(vatAmount, invoice.DocCurrency), col6 + 5, currentY, { continued: false });
            currentY += rowHeight;
        }
    }

    // Check if we have enough space for table end, notes and totals
    if (currentY + totalsHeight + notesHeight + 20 > maxContentY) {  // Added +20 buffer
        drawFooter();  // Draw footer before new page
        // Move to new page if not enough space
        doc.addPage();
        currentY = margin + 50;
    }

    // Blue line after table
    doc.strokeColor("#2E5CB8").lineWidth(1.5);
    doc.moveTo(margin - 15, currentY + 5).lineTo(pageWidth - margin, currentY + 5).stroke();

    // Notes section and totals in same line
    currentY += 15;

    // Add blue line above totals section
    doc.strokeColor("#2E5CB8").lineWidth(1.5);
    doc.moveTo(margin - 15, currentY - 10).lineTo(pageWidth - margin, currentY - 10).stroke();

    // Notes on left
    doc.fontSize(8).font("Helvetica").fillColor("#666666");
    doc.text("Notes:", margin, currentY, { continued: false });

    currentY = drawTotals(totalExVAT, totalVAT, totalCreditAmount, totalPaidAmount, remainingBalance, currentY);

    // Draw footer at end
    drawFooter();
};

// controllers/invoicePdfController.js
// Add this helper function at the end of the file
// Bulk email invoices grouped by customer
exports.bulkEmailInvoicesByCustomer = async (req, res) => {
    try {
        const { invoiceIds } = req.body;

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
            CardCode: { $in: cardCodes },
            Email: { $exists: true, $ne: "" }
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
                invoicesByCustomer[cardCode] = {
                    customerName: invoice.CardName,
                    email: customerEmailMap[cardCode],
                    invoices: []
                };
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
                if (!data.email) {
                    results.skipped.push({
                        cardCode,
                        customerName: data.customerName,
                        invoiceCount: data.invoices.length,
                        reason: "No email address found"
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
        console.log("Received invoice IDs for PDF generation:", invoiceIds);

        if (!invoiceIds || !Array.isArray(invoiceIds) || invoiceIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Please provide an array of invoice IDs"
            });
        }

        console.log(`Generating PDF for ${invoiceIds.length} invoices in specified order`);

        // Fetch invoices without sorting
        const invoicesMap = {};
        const fetchedInvoices = await Invoice.find({ _id: { $in: invoiceIds } })
            .populate("salesAgent", "firstName lastName email");

        // Create a map for quick lookup
        fetchedInvoices.forEach(invoice => {
            invoicesMap[invoice._id.toString()] = invoice;
        });

        // Maintain the order from invoiceIds array
        const invoices = invoiceIds
            .map(id => invoicesMap[id.toString()])
            .filter(invoice => invoice !== undefined);

        if (invoices.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No invoices found"
            });
        }

        console.log(`Invoices arranged in click order:`, invoices.map(inv => inv.DocNum));

        // Download logo
        const logoUrl = "https://imageshfs.s3.ap-southeast-2.amazonaws.com/image-removebg-preview+(1).png";
        const logoBuffer = await downloadImage(logoUrl);

        // Create PDF document
        const doc = new PDFDocument({
            size: "A4",
            margins: { top: 40, bottom: 40, left: 40, right: 40 },
            bufferPages: true
        });

        // Set response headers
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename=invoices-${Date.now()}.pdf`
        );

        // Pipe PDF to response
        doc.pipe(res);

        // Generate page for each invoice IN THE ORDER RECEIVED (FIRST SET)
        for (let i = 0; i < invoices.length; i++) {
            await generateInvoicePage(doc, invoices[i], logoBuffer, i === 0);
        }

        // Generate page for each invoice AGAIN (SECOND SET - DUPLICATE)
        for (let i = 0; i < invoices.length; i++) {
            await generateInvoicePage(doc, invoices[i], logoBuffer, false);
        }

        // Finalize PDF
        doc.end();

        console.log(`PDF generated successfully for ${invoices.length} invoices in click order`);

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

        await sendEmail(emailOptions);

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

module.exports = exports;