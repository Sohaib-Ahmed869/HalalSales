// controllers/deliveryNotePdfController.js
const DeliveryNote = require("../models/DeliveryNote");
const PDFDocument = require("pdfkit");
const axios = require("axios");

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

// Generate single delivery note (can span multiple pages)
const generateDeliveryNotePage = async (doc, deliveryNote, logoBuffer, isFirstDeliveryNote = false) => {
    // Add new page if not first delivery note
    if (!isFirstDeliveryNote) {
        doc.addPage();
    }

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const margin = 40;
    const footerHeight = 80;
    const maxContentY = pageHeight - footerHeight - 10;

    // Helper to draw footer
    const drawFooter = () => {
        const footerY = pageHeight - 60;

        // Left side - Siret and TVA
        doc.fontSize(7).font("Helvetica").fillColor("#000000");
        doc.text("Siret: 79854544800010", margin, footerY, { continued: false });
        doc.text("TVA No.: FR02798545448", margin, footerY + 12, { continued: false });

        // Right side - IBAN and SWIFT
        const footerRightX = pageWidth - 250;
        doc.text("IBAN: fr7610107006090001804792320", footerRightX, footerY, { continued: false });
        doc.text("SWIFT: BREDFRPPXXX", footerRightX, footerY + 12, { continued: false });

        // Bottom disclaimer
        doc.fontSize(6).font("Helvetica").fillColor("#666666");
        const centerX = pageWidth / 2;
        doc.text("Une copie complète de nos termes et conditions", centerX - 100, footerY + 30, { continued: false });
        doc.text("sont disponibles sur demande", centerX - 70, footerY + 38, { continued: false });
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

        // Right side - "Bon de Livraison" with yellow bar
        const rightColumnX = pageWidth - 200;

        doc.rect(rightColumnX - 10, margin, 8, 20).fill("#FFD700");
        doc.fontSize(16).font("Helvetica-Bold").fillColor("#000000");
        doc.text("Bon de Livraison", rightColumnX, margin, { continued: false });

        // Document info section
        let rightY = margin + 30;

        // Document Number, Document Date, Page
        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text("Document Number", rightColumnX - 180, rightY, { continued: false });
        doc.font("Helvetica-Bold").fillColor("#000000");
        doc.text(deliveryNote.DocNum || "", rightColumnX - 180, rightY + 12, { continued: false });

        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text("Document Date", rightColumnX - 70, rightY, { continued: false });
        doc.font("Helvetica-Bold").fillColor("#000000");
        doc.text(formatDate(deliveryNote.DocDate), rightColumnX - 70, rightY + 12, { continued: false });

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
        doc.text(deliveryNote.CardCode || "", rightColumnX - 180, rightY + 12, { continued: false });
        doc.font("Helvetica").fillColor("#666666");
        doc.text("Client TVA", rightColumnX - 70, rightY, { continued: false });

        // Dotted line
        doc.strokeColor("#CCCCCC").lineWidth(0.5).dash(2, 2);
        doc.moveTo(rightColumnX - 180, rightY + 26).lineTo(pageWidth - margin, rightY + 26).stroke();
        doc.undash();

        rightY += 30;

        // Reference to originating order
        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text("Commande No.", rightColumnX - 180, rightY, { continued: false });
        doc.font("Helvetica-Bold").fillColor("#000000");
        doc.text(deliveryNote.OriginatingOrder || "", rightColumnX - 180, rightY + 12, { continued: false });

        doc.font("Helvetica").fillColor("#666666");
        doc.text("Devise", rightColumnX - 70, rightY, { continued: false });
        doc.font("Helvetica-Bold").fillColor("#000000");
        doc.text(deliveryNote.DocCurrency || "EUR", rightColumnX - 70, rightY + 12, { continued: false });

        doc.font("Helvetica").fillColor("#666666");
        doc.text("Date de livraison", rightColumnX + 40, rightY, { continued: false });
        doc.font("Helvetica-Bold").fillColor("#000000");
        doc.text(formatDate(deliveryNote.DocDate), rightColumnX + 40, rightY + 12, { continued: false });

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

        if (deliveryNote.Address) {
            const addressLines = deliveryNote.Address.split("\n").filter(line => line.trim()).slice(0, 3);
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

    // Helper to draw totals
    const drawTotals = (totalExVAT, totalVAT, yPosition) => {
        const totalsLabelX = pageWidth - 250;
        const totalsValueX = pageWidth - 100;
        const totalIncVAT = totalExVAT + totalVAT;

        // Total Avant Remise
        doc.rect(totalsLabelX - 10, yPosition, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text("Total Avant Remise", totalsLabelX, yPosition, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text(formatCurrency(totalExVAT, deliveryNote.DocCurrency), totalsValueX, yPosition, { continued: false });

        // Total Remise
        doc.rect(totalsLabelX - 10, yPosition + 20, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text("Total Remise", totalsLabelX, yPosition + 20, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text(formatCurrency(0, deliveryNote.DocCurrency), totalsValueX, yPosition + 20, { continued: false });

        // Total Apres Remise
        doc.rect(totalsLabelX - 10, yPosition + 40, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text("Total Apres Remise", totalsLabelX, yPosition + 40, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text(formatCurrency(totalExVAT, deliveryNote.DocCurrency), totalsValueX, yPosition + 40, { continued: false });

        // TVA Totale
        doc.rect(totalsLabelX - 10, yPosition + 60, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text("TVA Totale", totalsLabelX, yPosition + 60, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text(formatCurrency(totalVAT, deliveryNote.DocCurrency), totalsValueX, yPosition + 60, { continued: false });

        // Totale TTC (highlighted)
        doc.rect(totalsLabelX - 10, yPosition + 80, 3, 14).fill("#FFD700");
        doc.fontSize(11).font("Helvetica-Bold").fillColor("#000000");
        doc.text("Totale TTC", totalsLabelX, yPosition + 80, { continued: false });
        doc.text(formatCurrency(totalIncVAT, deliveryNote.DocCurrency), totalsValueX, yPosition + 80, { continued: false });

        // Devise
        doc.rect(totalsLabelX - 10, yPosition + 100, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text(`Devise ${deliveryNote.DocCurrency || "EUR"}`, totalsLabelX, yPosition + 100, { continued: false });

        return yPosition + 120;
    };

    // Start drawing the delivery note
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

    if (deliveryNote.DocumentLines && deliveryNote.DocumentLines.length > 0) {
        for (let i = 0; i < deliveryNote.DocumentLines.length; i++) {
            const line = deliveryNote.DocumentLines[i];

            // Check if we need a new page
            const isNearEnd = (i >= deliveryNote.DocumentLines.length - 5);
            const reserveSpace = isNearEnd ? (totalsHeight + notesHeight) : 0;

            if (currentY + rowHeight + reserveSpace > maxContentY) {
                // Add continuation page
                doc.addPage();
                currentY = margin + 50;
                currentY = drawTableHeader(currentY);
            }

            const lineTotal = (line.Quantity || 0) * (line.Price || line.UnitPrice || 0);
            const vatAmount = lineTotal * 0.055;

            totalExVAT += lineTotal;
            totalVAT += vatAmount;

            // Use regular font for table text
            doc.font("Helvetica").fontSize(8).fillColor("#000000");
            doc.text(line.ItemCode || "", col1, currentY, { continued: false });
            doc.text((line.ItemDescription || "").substring(0, 40), col2, currentY, { continued: false });
            doc.text((line.Quantity || 0).toString(), col3 + 30, currentY, { continued: false });
            doc.text(formatCurrency(line.Price || line.UnitPrice || 0, deliveryNote.DocCurrency), col4 + 20, currentY, { continued: false });
            doc.text(formatCurrency(lineTotal, deliveryNote.DocCurrency), col5 + 10, currentY, { continued: false });
            doc.text(formatCurrency(vatAmount, deliveryNote.DocCurrency), col6 + 5, currentY, { continued: false });
            currentY += rowHeight;
        }
    }

    // Check if we have enough space for table end, notes and totals
    if (currentY + totalsHeight + notesHeight > maxContentY) {
        // Move to new page if not enough space
        doc.addPage();
        currentY = margin + 50;
    }

    // Blue line after table
    doc.strokeColor("#2E5CB8").lineWidth(1.5);
    doc.moveTo(margin - 15, currentY + 5).lineTo(pageWidth - margin, currentY + 5).stroke();

    // Notes section and totals in same line
    currentY += 15;

    // Notes on left
    doc.fontSize(8).font("Helvetica").fillColor("#666666");
    doc.text("Notes:", margin, currentY, { continued: false });

    // Draw totals on right (same Y position as notes)
    drawTotals(totalExVAT, totalVAT, currentY);
};

// Main controller function to generate bulk PDFs
exports.generateBulkDeliveryNotePDFs = async (req, res) => {
    try {
        const { deliveryNoteIds } = req.body;
        console.log("Received delivery note IDs for PDF generation:", deliveryNoteIds);

        if (!deliveryNoteIds || !Array.isArray(deliveryNoteIds) || deliveryNoteIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Please provide an array of delivery note IDs"
            });
        }

        console.log(`Generating PDF for ${deliveryNoteIds.length} delivery notes`);

        // Fetch all delivery notes
        const deliveryNotes = await DeliveryNote.find({ _id: { $in: deliveryNoteIds } })
            .populate("salesAgent", "firstName lastName email")
            .sort({ DocNum: 1 });

        if (deliveryNotes.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No delivery notes found"
            });
        }

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
            `attachment; filename=delivery-notes-${Date.now()}.pdf`
        );

        // Pipe PDF to response
        doc.pipe(res);

        // Generate page for each delivery note
        for (let i = 0; i < deliveryNotes.length; i++) {
            await generateDeliveryNotePage(doc, deliveryNotes[i], logoBuffer, i === 0);
        }

        // Finalize PDF
        doc.end();

        console.log(`PDF generated successfully for ${deliveryNotes.length} delivery notes`);

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

// Get delivery notes for PDF generation (with filters)
exports.getDeliveryNotesForPDF = async (req, res) => {
    try {
        const { fromDate, toDate, cardCode, status, search } = req.query;
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

        if (search) {
            query.$or = [
                { DocNum: { $regex: search, $options: "i" } },
                { CardCode: { $regex: search, $options: "i" } },
                { CardName: { $regex: search, $options: "i" } }
            ];
        }

        // Get delivery notes
        const [deliveryNotes, total] = await Promise.all([
            DeliveryNote.find(query)
                .select("DocNum DocDate CardCode CardName DocTotal DocCurrency DocumentStatus OriginatingOrder SyncedWithSAP")
                .populate("salesAgent", "firstName lastName")
                .sort({ DocDate: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            DeliveryNote.countDocuments(query)
        ]);

        res.json({
            success: true,
            data: deliveryNotes,
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error("Error fetching delivery notes:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching delivery notes",
            error: error.message
        });
    }
};