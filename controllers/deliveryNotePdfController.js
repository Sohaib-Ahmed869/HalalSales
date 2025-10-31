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
const generateDeliveryNotePage = async (doc, deliveryNote, logoBuffer, customer, isFirstDeliveryNote = false) => {
    if (!isFirstDeliveryNote) {
        doc.addPage();
    }

    const pageWidth = doc.page.width;
    const pageHeight = doc.page.height;
    const margin = 40;
    const footerHeight = 80;
    const maxContentY = pageHeight - footerHeight - 30;

    const Return = require("../models/Return");
    let returnedQty = {};
    let returnedSubtotal = 0;
    let returnedVat = 0;

    if (deliveryNote.hasReturns && deliveryNote.returnDocEntries && deliveryNote.returnDocEntries.length > 0) {
        const returns = await Return.find({
            DocEntry: { $in: deliveryNote.returnDocEntries }
        });
        returns.forEach(returnDoc => {
            if (returnDoc.DocumentLines && Array.isArray(returnDoc.DocumentLines)) {
                returnDoc.DocumentLines.forEach(line => {
                    const key = line.ItemCode;
                    returnedQty[key] = (returnedQty[key] || 0) + line.Quantity;
                    const lineTotal = (line.Price || 0) * line.Quantity;
                    const lineVat = lineTotal * (line.VatGroup === "C3" ? 0.055 : line.VatGroup === "C4" ? 0.20 : 0);
                    returnedSubtotal += lineTotal;
                    returnedVat += lineVat;
                });
            }
        });
        console.log(`📦 Calculated returned quantities for DN ${deliveryNote.DocNum}:`, returnedQty);
    }

    console.log("Amount of returns to deduct:", {
        returnedSubtotal,
        returnedVat
    });

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

        // Get billing address from customer
        let billingAddress = null;
        if (customer && customer.addresses && customer.addresses.length > 0) {
            billingAddress = customer.addresses.find(addr =>
                addr.addressType === "bo_BillTo" && addr.isDefault
            ) || customer.addresses.find(addr => addr.addressType === "bo_BillTo");
        }

        if (billingAddress) {
            let yOffset = startY + 30;
            doc.fontSize(9).font("Helvetica").fillColor("#000000");

            if (billingAddress.street) {
                doc.text(sanitizeText(billingAddress.street).substring(0, 50), margin, yOffset, { continued: false });
                yOffset += 12;
            }

            const cityLine = [billingAddress.zipCode, billingAddress.city]
                .filter(Boolean)
                .join(" ");
            if (cityLine) {
                doc.text(sanitizeText(cityLine).substring(0, 50), margin, yOffset, { continued: false });
                yOffset += 12;
            }

            if (billingAddress.country) {
                doc.text(sanitizeText(billingAddress.country).substring(0, 50), margin, yOffset, { continued: false });
            }
        } else {
            // Fallback to default
            doc.font("Helvetica").fontSize(9);
            doc.text("2 avenue emilie zola", margin, startY + 30, { continued: false });
            doc.text("75015 PARIS", margin, startY + 42, { continued: false });
            doc.text("FRANCE", margin, startY + 54, { continued: false });
        }

        // RIGHT COLUMN - Delivery Address with customer name on top
        const deliveryX = pageWidth / 2 + 20;

        doc.fontSize(10).font("Helvetica-Bold").fillColor("#000000");
        doc.text(deliveryNote.CardName || "", deliveryX, startY, {
            width: (pageWidth / 2) - margin - 20,
            continued: false
        });

        doc.fontSize(8).font("Helvetica").fillColor("#666666");
        doc.text("Addresse de livraison", deliveryX, startY + 15, { continued: false });

        let yOffset = startY + 30;
        doc.fontSize(9).font("Helvetica").fillColor("#000000");

        // Check if AddressExtension has ShipTo data
        let hasShipToExtension = false;
        if (deliveryNote.AddressExtension) {
            const addrExt = deliveryNote.AddressExtension;
            hasShipToExtension = !!(
                addrExt.ShipToStreet ||
                addrExt.ShipToStreetNo ||
                addrExt.ShipToCity ||
                addrExt.ShipToZipCode ||
                addrExt.ShipToCountry
            );
        }

        if (hasShipToExtension) {
            // Use AddressExtension from delivery note
            const addrExt = deliveryNote.AddressExtension;

            // Build street address
            const streetParts = [
                addrExt.ShipToStreet,
                addrExt.ShipToStreetNo,
                addrExt.ShipToBuilding,
                addrExt.ShipToBlock
            ].filter(Boolean);

            if (streetParts.length > 0) {
                doc.text(sanitizeText(streetParts.join(" ")).substring(0, 50), deliveryX, yOffset, { continued: false });
                yOffset += 12;
            }

            // City line with zip code
            const cityLine = [addrExt.ShipToZipCode, addrExt.ShipToCity]
                .filter(Boolean)
                .join(" ");
            if (cityLine) {
                doc.text(sanitizeText(cityLine).substring(0, 50), deliveryX, yOffset, { continued: false });
                yOffset += 12;
            }

            // County/State
            if (addrExt.ShipToCounty || addrExt.ShipToState) {
                const regionLine = [addrExt.ShipToCounty, addrExt.ShipToState]
                    .filter(Boolean)
                    .join(", ");
                doc.text(sanitizeText(regionLine).substring(0, 50), deliveryX, yOffset, { continued: false });
                yOffset += 12;
            }

            // Country
            if (addrExt.ShipToCountry) {
                doc.text(sanitizeText(addrExt.ShipToCountry).substring(0, 50), deliveryX, yOffset, { continued: false });
                yOffset += 12;
            }
        } else {
            // Fallback to customer address
            let shipToAddress = null;
            if (customer && customer.addresses && customer.addresses.length > 0) {
                shipToAddress = customer.addresses.find(addr =>
                    addr.addressType === "bo_ShipTo" && addr.isDefault
                ) || customer.addresses.find(addr => addr.addressType === "bo_ShipTo");
            }

            if (shipToAddress) {
                if (shipToAddress.street) {
                    doc.text(sanitizeText(shipToAddress.street).substring(0, 50), deliveryX, yOffset, { continued: false });
                    yOffset += 12;
                }

                const cityLine = [shipToAddress.zipCode, shipToAddress.city]
                    .filter(Boolean)
                    .join(" ");
                if (cityLine) {
                    doc.text(sanitizeText(cityLine).substring(0, 50), deliveryX, yOffset, { continued: false });
                    yOffset += 12;
                }

                if (shipToAddress.country) {
                    doc.text(sanitizeText(shipToAddress.country).substring(0, 50), deliveryX, yOffset, { continued: false });
                    yOffset += 12;
                }
            } else if (deliveryNote.Address) {
                // Fallback to delivery note address
                const cleanAddress = sanitizeText(deliveryNote.Address);
                const addressLines = cleanAddress
                    .split('\n')
                    .map(line => line.trim())
                    .filter(line => line.length > 0)
                    .slice(0, 3);

                addressLines.forEach(line => {
                    doc.text(line.substring(0, 50), deliveryX, yOffset, { continued: false });
                    yOffset += 12;
                });
            } else {
                // Default fallback
                doc.text("2 avenue emilie zola", deliveryX, yOffset, { continued: false });
                yOffset += 12;
                doc.text("75015 PARIS", deliveryX, yOffset, { continued: false });
                yOffset += 12;
                doc.text("FRANCE", deliveryX, yOffset, { continued: false });
                yOffset += 12;
            }
        }

        // Add phone numbers after delivery address
        if (customer && (customer.phoneNumber || (customer.additionalPhoneNumbers && customer.additionalPhoneNumbers.length > 0))) {
            const phoneNumbers = [];

            // Add main phone number
            if (customer.phoneNumber) {
                phoneNumbers.push(customer.phoneNumber);
            }

            // Add additional phone numbers
            if (customer.additionalPhoneNumbers && Array.isArray(customer.additionalPhoneNumbers)) {
                phoneNumbers.push(...customer.additionalPhoneNumbers);
            }

            // Display phone numbers
            if (phoneNumbers.length > 0) {
                doc.fontSize(8).font("Helvetica").fillColor("#000000");
                phoneNumbers.forEach((phone, index) => {
                    doc.text(sanitizeText(phone), deliveryX, yOffset, { continued: false });
                    yOffset += 12;
                });
            }
        }

        return startY + 90; // Increased to accommodate phone number
    };

    const drawTableHeader = (startY) => {
        doc.rect(margin - 15, startY, pageWidth - (2 * margin) + 15, 18).fill("#F5F5F5");
        // FIXED: Moved columns left and added more space for currency
        const col1 = margin - 10;
        const col2 = margin + 60;
        const col3 = pageWidth - 285;  // Moved left by 30px
        const col4 = pageWidth - 215;  // Moved left by 30px
        const col5 = pageWidth - 145;  // Moved left by 20px
        const col6 = pageWidth - 85;   // Moved left by 10px

        doc.fontSize(8).font("Helvetica").fillColor("#000000");
        doc.text("Article Code", col1, startY + 5, { continued: false });
        doc.text("Description", col2, startY + 5, { continued: false });
        doc.text("Quantite", col3 + 15, startY + 5, { continued: false });
        doc.text("Prix", col4 + 15, startY + 5, { continued: false });
        doc.text("Total", col5 + 10, startY + 5, { continued: false });
        doc.text("TVA", col6 + 5, startY + 5, { continued: false });

        doc.strokeColor("#2E5CB8").lineWidth(1.5);
        doc.moveTo(margin - 15, startY + 18).lineTo(pageWidth - margin, startY + 18).stroke();
        return startY + 25;
    };


    const drawTotals = (totalExVAT, totalVAT, startY, totalIncVAT, returnedSubtotal = 0, returnedVat = 0) => {
        const availableSpace = pageHeight - footerHeight - 160; // 160 for the sections height
        let totalsY = Math.max(startY + 30, availableSpace);

        // subtract returned amounts if any
        totalExVAT -= returnedSubtotal;
        totalVAT -= returnedVat;
        totalIncVAT -= (returnedSubtotal + returnedVat);

        // Calculate column widths - divide page into 3 sections
        const sectionWidth = (pageWidth - (margin * 2)) / 3;
        const livreurX = margin;
        const clientX = margin + sectionWidth;
        const totalsX = margin + (sectionWidth * 2);

        // LEFT SECTION - Livreur (Delivery Person)
        doc.fontSize(9).font("Helvetica-Bold").fillColor("#000000");
        doc.text("Livreur", livreurX, totalsY, { continued: false });

        doc.fontSize(10).font("Helvetica").fillColor("#000000");
        doc.text("Nom:............................................", livreurX, totalsY + 15, { continued: false });
        doc.text("Prenom:.....................................", livreurX, totalsY + 28, { continued: false });
        doc.text("Paiment Montant:....................", livreurX, totalsY + 41, { continued: false });
        doc.text("Mode de Paiment:...................", livreurX, totalsY + 54, { continued: false });

        // MIDDLE SECTION - Client
        doc.fontSize(9).font("Helvetica-Bold").fillColor("#000000");
        doc.text("Client", clientX, totalsY, { continued: false });

        doc.fontSize(10).font("Helvetica").fillColor("#000000");
        doc.text("Signature:....................................", clientX, totalsY + 15, { continued: false });
        doc.text("Nom:.............................................", clientX, totalsY + 28, { continued: false });
        doc.text("Date:............. Time:..................", clientX, totalsY + 41, { continued: false });

        // Add delivery note reference below client section
        doc.fontSize(8).font("Helvetica-Bold").fillColor("#000000");
        doc.text(`Delivery note for order`, clientX, totalsY + 65, { continued: false });
        doc.text(`#${deliveryNote.OriginatingOrder || ''}`, clientX, totalsY + 77, { continued: false });

        // RIGHT SECTION - Totals
        // Draw orange bar next to totals
        doc.rect(totalsX - 10, totalsY, 4, 85).fill("#FFD700");

        let totalsRowY = totalsY;

        // Total Before Discount
        doc.fontSize(8).font("Helvetica").fillColor("#000000");
        doc.text("Total Avant Remise", totalsX, totalsRowY, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text(totalExVAT.toFixed(2), totalsX + 100, totalsRowY, {
            width: 80,
            align: "right",
            continued: false
        });

        // Total Discount
        totalsRowY += 13;
        doc.font("Helvetica").fillColor("#000000");
        doc.text("Total Remise", totalsX, totalsRowY, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text("0.00", totalsX + 100, totalsRowY, {
            width: 80,
            align: "right",
            continued: false
        });

        // Total After Discount
        totalsRowY += 13;
        doc.font("Helvetica").fillColor("#000000");
        doc.text("Total Apres Remise", totalsX, totalsRowY, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text(totalExVAT.toFixed(2), totalsX + 100, totalsRowY, {
            width: 80,
            align: "right",
            continued: false
        });

        // VAT Total
        totalsRowY += 13;
        doc.font("Helvetica").fillColor("#000000");
        doc.text("TVA Totale", totalsX, totalsRowY, { continued: false });
        doc.font("Helvetica-Bold");
        doc.text(totalVAT.toFixed(2), totalsX + 100, totalsRowY, {
            width: 80,
            align: "right",
            continued: false
        });

        // Draw line before final total
        totalsRowY += 13;
        doc.strokeColor("#2E5CB8").lineWidth(1);
        doc.moveTo(totalsX, totalsRowY).lineTo(pageWidth - margin, totalsRowY).stroke();

        // Total TTC (Total Including VAT)
        totalsRowY += 5;
        doc.fontSize(10).font("Helvetica-Bold").fillColor("#000000");
        doc.text("Totale TTC", totalsX, totalsRowY, { continued: false });
        doc.text(totalIncVAT.toFixed(2), totalsX + 100, totalsRowY, {
            width: 80,
            align: "right",
            continued: false
        });

        // Currency
        totalsRowY += 15;
        doc.fontSize(8).font("Helvetica").fillColor("#000000");
        doc.text("Devise EUR", totalsX, totalsRowY, { continued: false });
    };

    let currentY = drawHeader();
    currentY = drawAddresses(currentY);
    currentY = drawTableHeader(currentY);

    const col1 = margin - 10;
    const col2 = margin + 60;
    const col3 = pageWidth - 285;
    const col4 = pageWidth - 215;
    const col5 = pageWidth - 145;
    const col6 = pageWidth - 85;

    // FIX 3: Optimized spacing
    const rowHeight = 12;
    let totalIncVAT = deliveryNote.DocTotal;
    let totalVAT = deliveryNote.VatSum ? deliveryNote.VatSum : deliveryNote.DocTotal - deliveryNote.DocumentLines.map(line => {
        const lineVAT = line.Price * line.Quantity;
        return lineVAT;
    }).reduce((acc, curr) => acc + curr, 0);
    let totalExVAT = deliveryNote.VatSum ? deliveryNote.DocTotal - deliveryNote.VatSum : deliveryNote.DocTotal - totalVAT;
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
            const vatAmount = lineTotal * (line.VATGroup === "C3" ? 0.055 : line.VATGroup === "C4" ? 0.20 : 0);




            doc.font("Helvetica").fontSize(7.5).fillColor("#000000");  // FIXED: Slightly smaller font for compactness
            doc.text(line.ItemCode || "", col1, currentY, { continued: false });
            doc.text((line.ItemDescription || "").substring(0, 45), col2, currentY, { continued: false });  // FIXED: More chars
            doc.text(netQty.toString(), col3 + 15, currentY, { continued: false });  // FIXED: Adjusted spacing
            doc.text(formatCurrency(line.Price || line.UnitPrice || 0, deliveryNote.DocCurrency), col4 + 15, currentY, { continued: false });
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
    if (deliveryNote.Comments) {
        doc.fontSize(8).font("Helvetica").fillColor("#000000");
        doc.text(deliveryNote.Comments, margin, currentY + 12, {
            width: pageWidth - margin - 280,
            continued: false
        });
    }

    const sectionsHeight = 110; // Height needed for Livreur, Client, and Totals
    const availableSpace = pageHeight - footerHeight - 160;
    const targetY = Math.max(currentY + 30, availableSpace);

    if (targetY + sectionsHeight > maxContentY) {
        drawFooter();
        doc.addPage();
        currentY = availableSpace; // Start at bottom of new page
    }


    drawTotals(totalExVAT, totalVAT, currentY, totalIncVAT, returnedSubtotal, returnedVat);
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

        // Fetch customers for all delivery notes
        const cardCodes = [...new Set(deliveryNotes.map(dn => dn.CardCode))];
        const Customer = require("../models/Customer");
        const customers = await Customer.find({ CardCode: { $in: cardCodes } })
            .select("CardCode addresses phoneNumber additionalPhoneNumbers")
            .lean();

        const customerMap = {};
        customers.forEach(c => {
            customerMap[c.CardCode] = c;
        });

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
            const customer = customerMap[deliveryNotes[i].CardCode];
            // Original
            await generateDeliveryNotePage(doc, deliveryNotes[i], logoBuffer, customer, i === 0);
            // Copy (immediately after)
            await generateDeliveryNotePage(doc, deliveryNotes[i], logoBuffer, customer, false);
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