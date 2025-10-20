// controllers/orderPdfController.js
const SalesOrder = require("../models/SalesOrder");
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

// Generate single order (can span multiple pages)
const generateOrderPage = async (doc, order, logoBuffer, isFirstOrder = false) => {
    if (!isFirstOrder) {
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

        // RIGHT SIDE - Document info
        const rightColumnX = pageWidth - 200;

        doc.rect(rightColumnX - 10, margin, 8, 20).fill("#FFD700");
        doc.fontSize(16).font("Helvetica-Bold").fillColor("#000000");
        doc.text("Facture Proforma", rightColumnX, margin, { continued: false });

        // FIX 1: Add customer name prominently
        doc.fontSize(10).font("Helvetica-Bold").fillColor("#000000");
        doc.text(order.CardName || "", rightColumnX - 180, margin + 25, {
            width: 380,
            continued: false
        });

        let rightY = margin + 45;

        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text("Document Number", rightColumnX - 180, rightY, { continued: false });
        doc.font("Helvetica-Bold").fillColor("#000000");
        doc.text(order.DocNum || "", rightColumnX - 180, rightY + 12, { continued: false });

        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text("Document Date", rightColumnX - 70, rightY, { continued: false });
        doc.font("Helvetica-Bold").fillColor("#000000");
        doc.text(formatDate(order.DocDate), rightColumnX - 70, rightY + 12, { continued: false });

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
        doc.text(order.CardCode || "", rightColumnX - 180, rightY + 12, { continued: false });
        doc.font("Helvetica").fillColor("#666666");
        doc.text("Client TVA", rightColumnX - 70, rightY, { continued: false });

        doc.strokeColor("#CCCCCC").lineWidth(0.5).dash(2, 2);
        doc.moveTo(rightColumnX - 180, rightY + 26).lineTo(pageWidth - margin, rightY + 26).stroke();
        doc.undash();

        rightY += 30;

        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text("Votre reference", rightColumnX - 180, rightY, { continued: false });
        doc.text("Devise", rightColumnX - 70, rightY, { continued: false });
        doc.font("Helvetica-Bold").fillColor("#000000");
        doc.text(order.DocCurrency || "EUR", rightColumnX - 70, rightY + 12, { continued: false });
        doc.font("Helvetica").fillColor("#666666");
        doc.text("Date de livraison", rightColumnX + 40, rightY, { continued: false });
        doc.font("Helvetica-Bold").fillColor("#000000");
        doc.text(formatDate(order.StartDeliveryDate || order.DocDate), rightColumnX + 40, rightY + 12, { continued: false });

        doc.strokeColor("#CCCCCC").lineWidth(0.5).dash(2, 2);
        doc.moveTo(rightColumnX - 180, rightY + 26).lineTo(pageWidth - margin, rightY + 26).stroke();
        doc.undash();

        rightY += 30;

        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text("Condition de Paiement", rightColumnX - 180, rightY, { continued: false });
        doc.font("Helvetica-Bold").fillColor("#000000");
        doc.text("Immédiat", rightColumnX - 180, rightY + 12, { continued: false });
        doc.font("Helvetica").fillColor("#666666");
        doc.text("Date de Echance", rightColumnX - 70, rightY, { continued: false });
        doc.font("Helvetica-Bold").fillColor("#000000");
        doc.text(formatDate(order.DocDueDate || order.DocDate), rightColumnX - 70, rightY + 12, { continued: false });

        doc.strokeColor("#CCCCCC").lineWidth(0.5).dash(2, 2);
        doc.moveTo(rightColumnX - 180, rightY + 26).lineTo(pageWidth - margin, rightY + 26).stroke();
        doc.undash();

        return margin + 200;
    };

    const drawAddresses = (startY) => {
        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text("Addresse de facturation", margin, startY, { continued: false });

        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text("2 avenue emilie zola", margin, startY + 15, { continued: false });
        doc.text("75015 PARIS", margin, startY + 27, { continued: false });
        doc.text("FRANCE", margin, startY + 39, { continued: false });

        // FIX 2: Removed duplicate "Delivery Address" label
        const deliveryX = pageWidth / 2 + 20;
        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text("Addresse de livraison", deliveryX, startY, { continued: false });

        if (order.Address) {
            const addressLines = order.Address.split("\n").filter(line => line.trim()).slice(0, 3);
            let yOffset = startY + 15;
            doc.font("Helvetica").fontSize(9).fillColor("#000000");
            addressLines.forEach(line => {
                doc.text(line.trim().substring(0, 50), deliveryX, yOffset, { continued: false });
                yOffset += 12;
            });
        } else {
            doc.font("Helvetica").fontSize(9);
            doc.text("2 avenue emilie zola", deliveryX, startY + 15, { continued: false });
            doc.text("75015 PARIS", deliveryX, startY + 27, { continued: false });
            doc.text("FRANCE", deliveryX, startY + 39, { continued: false });
        }

        return startY + 60;
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
        doc.text(formatCurrency(totalExVAT, order.DocCurrency), totalsValueX, yPosition, { continued: false });

        doc.rect(totalsLabelX - 10, yPosition + lineSpacing, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text("Total Remise", totalsLabelX, yPosition + lineSpacing, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text(formatCurrency(0, order.DocCurrency), totalsValueX, yPosition + lineSpacing, { continued: false });

        doc.rect(totalsLabelX - 10, yPosition + lineSpacing * 2, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text("Total Apres Remise", totalsLabelX, yPosition + lineSpacing * 2, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text(formatCurrency(totalExVAT, order.DocCurrency), totalsValueX, yPosition + lineSpacing * 2, { continued: false });

        doc.rect(totalsLabelX - 10, yPosition + lineSpacing * 3, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text("TVA Totale", totalsLabelX, yPosition + lineSpacing * 3, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text(formatCurrency(totalVAT, order.DocCurrency), totalsValueX, yPosition + lineSpacing * 3, { continued: false });

        doc.rect(totalsLabelX - 10, yPosition + lineSpacing * 4, 3, 14).fill("#FFD700");
        doc.fontSize(11).font("Helvetica-Bold").fillColor("#000000");
        doc.text("Totale TTC", totalsLabelX, yPosition + lineSpacing * 4, { continued: false });
        doc.text(formatCurrency(totalIncVAT, order.DocCurrency), totalsValueX, yPosition + lineSpacing * 4, { continued: false });

        doc.rect(totalsLabelX - 10, yPosition + lineSpacing * 5, 3, 12).fill("#FFD700");
        doc.fontSize(9).font("Helvetica").fillColor("#000000");
        doc.text(`Devise ${order.DocCurrency || "EUR"}`, totalsLabelX, yPosition + lineSpacing * 5, { continued: false });

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

    // FIX 5: Optimized spacing calculations
    const rowHeight = 15;
    let totalExVAT = 0;
    let totalVAT = 0;
    const totalsHeight = 110;
    const notesHeight = 15;
    const blueLineHeight = 20;

    if (order.DocumentLines && order.DocumentLines.length > 0) {
        for (let i = 0; i < order.DocumentLines.length; i++) {
            const line = order.DocumentLines[i];

            // FIX 5: Only reserve space on LAST item
            const isLastItem = (i === order.DocumentLines.length - 1);
            const reserveSpace = isLastItem ? (totalsHeight + notesHeight + blueLineHeight) : 0;

            if (currentY + rowHeight + reserveSpace > maxContentY) {
                drawFooter();
                doc.addPage();
                currentY = margin + 50;
                currentY = drawTableHeader(currentY);
            }

            const lineTotal = (line.Quantity || 0) * (line.Price || 0);
            const vatAmount = lineTotal * 0.055;

            totalExVAT += lineTotal;
            totalVAT += vatAmount;

            doc.font("Helvetica").fontSize(8).fillColor("#000000");
            doc.text(line.ItemCode || "", col1, currentY, { continued: false });
            doc.text((line.ItemDescription || "").substring(0, 40), col2, currentY, { continued: false });
            doc.text((line.Quantity || 0).toString(), col3 + 30, currentY, { continued: false });
            doc.text(formatCurrency(line.Price || 0, order.DocCurrency), col4 + 20, currentY, { continued: false });
            doc.text(formatCurrency(lineTotal, order.DocCurrency), col5 + 10, currentY, { continued: false });
            doc.text(formatCurrency(vatAmount, order.DocCurrency), col6 + 5, currentY, { continued: false });
            currentY += rowHeight;
        }
    }

    // FIX 5: Precise space check before drawing totals
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

    drawTotals(totalExVAT, totalVAT, currentY);
    drawFooter();
};
// Main controller function to generate bulk PDFs
exports.generateBulkOrderPDFs = async (req, res) => {
    try {
        const { orderIds } = req.body;

        if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Please provide an array of order IDs"
            });
        }

        const ordersMap = {};
        const fetchedOrders = await SalesOrder.find({ _id: { $in: orderIds } })
            .populate("salesAgent", "firstName lastName email");

        fetchedOrders.forEach(order => {
            ordersMap[order._id.toString()] = order;
        });

        const orders = orderIds
            .map(id => ordersMap[id.toString()])
            .filter(order => order !== undefined);

        if (orders.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No orders found"
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
            `attachment; filename=orders-${Date.now()}.pdf`
        );

        doc.pipe(res);

        // FIX 4: Generate original + copy for EACH order immediately
        for (let i = 0; i < orders.length; i++) {
            // Original
            await generateOrderPage(doc, orders[i], logoBuffer, i === 0);
            // Copy (immediately after)
            await generateOrderPage(doc, orders[i], logoBuffer, false);
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
// Get orders for PDF generation (with filters)
exports.getOrdersForPDF = async (req, res) => {
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

        // Get orders
        const [orders, total] = await Promise.all([
            SalesOrder.find(query)
                .select("DocNum DocDate CardCode CardName DocTotal DocCurrency DocumentStatus")
                .populate("salesAgent", "firstName lastName")
                .sort({ DocDate: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            SalesOrder.countDocuments(query)
        ]);

        res.json({
            success: true,
            data: orders,
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error("Error fetching orders:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching orders",
            error: error.message
        });
    }
};