// controllers/deliveryNotePdfController.js
const DeliveryNote = require("../models/DeliveryNote");
const PDFDocument = require("pdfkit");
const axios = require("axios");
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

// Generate single delivery note (can span multiple pages)
const generateDeliveryNotePage = async (doc, deliveryNote, logoBuffer, isFirstDeliveryNote = false) => {
    if (!isFirstDeliveryNote) {
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

        doc.font("Helvetica").fontSize(8);
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
        doc.text("Bon de Livraison", rightColumnX, margin, { continued: false });

        let rightY = margin + 45;

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

        doc.strokeColor("#CCCCCC").lineWidth(0.5).dash(2, 2);
        doc.moveTo(rightColumnX - 180, rightY + 26).lineTo(pageWidth - margin, rightY + 26).stroke();
        doc.undash();

        rightY += 30;

        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text("Client No.", rightColumnX - 180, rightY, { continued: false });
        doc.font("Helvetica-Bold").fillColor("#000000");
        doc.text(deliveryNote.CardCode || "", rightColumnX - 180, rightY + 12, { continued: false });
        doc.font("Helvetica").fillColor("#666666");
        doc.text("Client TVA", rightColumnX - 70, rightY, { continued: false });

        doc.strokeColor("#CCCCCC").lineWidth(0.5).dash(2, 2);
        doc.moveTo(rightColumnX - 180, rightY + 26).lineTo(pageWidth - margin, rightY + 26).stroke();
        doc.undash();

        rightY += 30;

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

        doc.strokeColor("#CCCCCC").lineWidth(0.5).dash(2, 2);
        doc.moveTo(rightColumnX - 180, rightY + 26).lineTo(pageWidth - margin, rightY + 26).stroke();
        doc.undash();

        return margin + 200;
    };

    const drawAddresses = (startY) => {
        // LEFT COLUMN - Billing Address with customer name on top
        doc.fontSize(10).font("Helvetica-Bold").fillColor("#000000");
        doc.text(deliveryNote.CardName || "", margin, startY, {
            width: (pageWidth / 2) - margin - 20,
            continued: false
        });

        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text("Addresse de facturation", margin, startY + 15, { continued: false });

        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text("2 avenue emilie zola", margin, startY + 30, { continued: false });
        doc.text("75015 PARIS", margin, startY + 42, { continued: false });
        doc.text("FRANCE", margin, startY + 54, { continued: false });

        // RIGHT COLUMN - Delivery Address with customer name on top
        const deliveryX = pageWidth / 2 + 20;

        doc.fontSize(10).font("Helvetica-Bold").fillColor("#000000");
        doc.text(deliveryNote.CardName || "", deliveryX, startY, {
            width: (pageWidth / 2) - margin - 20,
            continued: false
        });

        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text("Addresse de livraison", deliveryX, startY + 15, { continued: false });

        if (deliveryNote.Address) {
            // Clean and split the address properly
            const cleanAddress = sanitizeText(deliveryNote.Address);
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

        doc.strokeColor("#2E5CB8").lineWidth(1.5);
        doc.moveTo(margin - 15, startY + 18).lineTo(pageWidth - margin, startY + 18).stroke();
        return startY + 25;
    };

    const drawTotals = (totalExVAT, totalVAT, yPosition) => {
        const totalsLabelX = pageWidth - 220;
        const totalsValueX = pageWidth - 80;
        const totalIncVAT = totalExVAT + totalVAT;
        const lineSpacing = 18;

        doc.rect(totalsLabelX - 10, yPosition, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text("Total Avant Remise", totalsLabelX, yPosition, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text(formatCurrency(totalExVAT, deliveryNote.DocCurrency), totalsValueX, yPosition, { continued: false });

        doc.rect(totalsLabelX - 10, yPosition + lineSpacing, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text("Total Remise", totalsLabelX, yPosition + lineSpacing, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text(formatCurrency(0, deliveryNote.DocCurrency), totalsValueX, yPosition + lineSpacing, { continued: false });

        doc.rect(totalsLabelX - 10, yPosition + lineSpacing * 2, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text("Total Apres Remise", totalsLabelX, yPosition + lineSpacing * 2, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text(formatCurrency(totalExVAT, deliveryNote.DocCurrency), totalsValueX, yPosition + lineSpacing * 2, { continued: false });

        doc.rect(totalsLabelX - 10, yPosition + lineSpacing * 3, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text("TVA Totale", totalsLabelX, yPosition + lineSpacing * 3, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text(formatCurrency(totalVAT, deliveryNote.DocCurrency), totalsValueX, yPosition + lineSpacing * 3, { continued: false });

        doc.rect(totalsLabelX - 10, yPosition + lineSpacing * 4, 3, 14).fill("#FFD700");
        doc.fontSize(11).font("Helvetica-Bold").fillColor("#000000");
        doc.text("Totale TTC", totalsLabelX, yPosition + lineSpacing * 4, { continued: false });
        doc.text(formatCurrency(totalIncVAT, deliveryNote.DocCurrency), totalsValueX, yPosition + lineSpacing * 4, { continued: false });

        doc.rect(totalsLabelX - 10, yPosition + lineSpacing * 5, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text(`Devise ${deliveryNote.DocCurrency || "EUR"}`, totalsLabelX, yPosition + lineSpacing * 5, { continued: false });

        return yPosition + lineSpacing * 6;
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

    // FIX 3: Optimized spacing
    const rowHeight = 15;
    let totalExVAT = 0;
    let totalVAT = 0;
    const totalsHeight = 110;
    const notesHeight = 15;
    const blueLineHeight = 20;

    // Get returned quantities for this delivery note
    let returnedQuantities = {};
    if (deliveryNote.hasReturns && deliveryNote.returnDocEntries && deliveryNote.returnDocEntries.length > 0) {
        const Return = require("../models/Return");
        const returns = await Return.find({
            DocEntry: { $in: deliveryNote.returnDocEntries }
        });

        returns.forEach(returnDoc => {
            if (returnDoc.DocumentLines && Array.isArray(returnDoc.DocumentLines)) {
                returnDoc.DocumentLines.forEach(line => {
                    const key = line.ItemCode;
                    returnedQuantities[key] = (returnedQuantities[key] || 0) + line.Quantity;
                });
            }
        });
    }

    if (deliveryNote.DocumentLines && deliveryNote.DocumentLines.length > 0) {
        for (let i = 0; i < deliveryNote.DocumentLines.length; i++) {
            const line = deliveryNote.DocumentLines[i];

            // Calculate net quantity (delivered - returned)
            const deliveredQty = line.Quantity || 0;
            const returnedQty = returnedQuantities[line.ItemCode] || 0;
            const netQty = deliveredQty - returnedQty;

            // Skip lines that are fully returned
            if (netQty <= 0) {
                continue;
            }

            // FIX 3: Only reserve space on LAST item
            const isLastItem = (i === deliveryNote.DocumentLines.length - 1);
            const reserveSpace = isLastItem ? (totalsHeight + notesHeight + blueLineHeight) : 0;

            if (currentY + rowHeight + reserveSpace > maxContentY) {
                drawFooter();
                doc.addPage();
                currentY = margin + 50;
                currentY = drawTableHeader(currentY);
            }

            const lineTotal = netQty * (line.Price || line.UnitPrice || 0);
            const vatAmount = lineTotal * 0.055;

            totalExVAT += lineTotal;
            totalVAT += vatAmount;

            doc.font("Helvetica").fontSize(8).fillColor("#000000");
            doc.text(line.ItemCode || "", col1, currentY, { continued: false });
            doc.text((line.ItemDescription || "").substring(0, 40), col2, currentY, { continued: false });
            doc.text(netQty.toString(), col3 + 30, currentY, { continued: false });
            doc.text(formatCurrency(line.Price || line.UnitPrice || 0, deliveryNote.DocCurrency), col4 + 20, currentY, { continued: false });
            doc.text(formatCurrency(lineTotal, deliveryNote.DocCurrency), col5 + 10, currentY, { continued: false });
            doc.text(formatCurrency(vatAmount, deliveryNote.DocCurrency), col6 + 5, currentY, { continued: false });
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
    if (deliveryNote.U_Notes) {
        doc.fontSize(8).font("Helvetica").fillColor("#000000");
        doc.text(deliveryNote.U_Notes, margin, currentY + 12, {
            width: pageWidth - margin - 280,
            continued: false
        });
    }

    drawTotals(totalExVAT, totalVAT, currentY);
    drawFooter();
};

// Main controller function to generate bulk PDFs
exports.generateBulkDeliveryNotePDFs = async (req, res) => {
    try {
        const { deliveryNoteIds } = req.body;

        if (!deliveryNoteIds || !Array.isArray(deliveryNoteIds) || deliveryNoteIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Please provide an array of delivery note IDs"
            });
        }

        const deliveryNotesMap = {};
        const fetchedDeliveryNotes = await DeliveryNote.find({ _id: { $in: deliveryNoteIds } })
            .populate("salesAgent", "firstName lastName email");

        fetchedDeliveryNotes.forEach(dn => {
            deliveryNotesMap[dn._id.toString()] = dn;
        });

        const deliveryNotes = deliveryNoteIds
            .map(id => deliveryNotesMap[id.toString()])
            .filter(dn => dn !== undefined);

        if (deliveryNotes.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No delivery notes found"
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
            `attachment; filename=delivery-notes-${Date.now()}.pdf`
        );

        doc.pipe(res);

        // FIX 4: Generate original + copy for EACH delivery note immediately
        for (let i = 0; i < deliveryNotes.length; i++) {
            // Original
            await generateDeliveryNotePage(doc, deliveryNotes[i], logoBuffer, i === 0);
            // Copy (immediately after)
            await generateDeliveryNotePage(doc, deliveryNotes[i], logoBuffer, false);
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
// In controllers/deliveryNotePdfController.js
// Replace getDeliveryNotesForPDF function (around line 400)

exports.getDeliveryNotesForPDF = async (req, res) => {
    try {
        const { fromDate, toDate, cardCode, status, search, excludeReturns } = req.query;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

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

        if (excludeReturns === "true") {
            query.hasReturns = { $ne: true };
        }

        if (search) {
            query.$or = [
                { DocNum: { $regex: search, $options: "i" } },
                { CardCode: { $regex: search, $options: "i" } },
                { CardName: { $regex: search, $options: "i" } }
            ];
        }

        // **NEW: Aggregate to calculate net totals**
        const Return = require("../models/Return");

        const [deliveryNotes, total] = await Promise.all([
            DeliveryNote.find(query)
                .select("DocNum DocDate CardCode CardName DocTotal DocCurrency DocumentStatus OriginatingOrder SyncedWithSAP hasReturns returnDocEntries totalReturnedAmount DocumentLines")
                .populate("salesAgent", "firstName lastName")
                .sort({ DocDate: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            DeliveryNote.countDocuments(query)
        ]);

        // **NEW: Calculate net totals for each delivery note**
        const enrichedDeliveryNotes = await Promise.all(
            deliveryNotes.map(async (dn) => {
                if (dn.hasReturns && dn.returnDocEntries && dn.returnDocEntries.length > 0) {
                    // Get all returns for this DN
                    const returns = await Return.find({
                        DocEntry: { $in: dn.returnDocEntries }
                    }).lean();

                    // Calculate returned quantities per item
                    const returnedQuantities = {};
                    let totalReturnAmount = 0;

                    returns.forEach(returnDoc => {
                        if (returnDoc.DocumentLines) {
                            returnDoc.DocumentLines.forEach(line => {
                                returnedQuantities[line.ItemCode] = (returnedQuantities[line.ItemCode] || 0) + line.Quantity;
                                totalReturnAmount += (line.Quantity * line.Price);
                            });
                        }
                    });

                    // Calculate net total
                    const netTotal = dn.DocTotal - totalReturnAmount;

                    return {
                        ...dn,
                        netDocTotal: netTotal,
                        totalReturnedAmount: totalReturnAmount,
                        returnedQuantities
                    };
                }

                return {
                    ...dn,
                    netDocTotal: dn.DocTotal
                };
            })
        );

        res.json({
            success: true,
            data: enrichedDeliveryNotes,
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