// utils/pdfGenerator.js
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');

/**
 * Generate RFQ PDF document with enhanced design
 * @param {Object} rfq - RFQ data
 * @returns {Promise<Buffer>} PDF buffer
 */
async function generateRFQPDF(rfq) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: 'A4',
                margins: {
                    top: 40,
                    bottom: 40,
                    left: 40,
                    right: 40,
                },
            });

            const chunks = [];

            doc.on('data', chunk => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            // Color palette
            const colors = {
                primary: '#1a472a',      // Deep forest green
                secondary: '#2d7a4a',    // Medium green
                accent: '#f97316',       // Orange accent
                dark: '#1f2937',         // Dark gray
                light: '#f3f4f6',        // Light gray
                white: '#ffffff',
                border: '#e5e7eb',
                textMuted: '#6b7280'
            };

            // Header background with gradient effect
            doc
                .rect(0, 0, 595, 140)
                .fill(colors.primary);

            // Decorative top border
            doc
                .rect(0, 0, 595, 8)
                .fill(colors.accent);

            // Company name
            doc
                .fontSize(32)
                .font('Helvetica-Bold')
                .fillColor(colors.white)
                .text('HALAL FOODS', 40, 35);

            // Tagline with icon-like bullet
            doc
                .fontSize(11)
                .font('Helvetica')
                .fillColor('#d1fae5')
                .text('● Premium Food Wholesaler | Paris, France', 40, 75);

            doc
                .fontSize(10)
                .fillColor('#a7f3d0')
                .text('600+ Product References  •  100+ Trusted Suppliers  •  Est. Since Generations', 40, 95);

            // RFQ Badge
            const badgeX = 400;
            const badgeY = 35;
            const badgeWidth = 155;
            const badgeHeight = 85;

            doc
                .roundedRect(badgeX, badgeY, badgeWidth, badgeHeight, 8)
                .fillAndStroke(colors.white, colors.accent);

            doc
                .fontSize(10)
                .font('Helvetica-Bold')
                .fillColor(colors.accent)
                .text('REQUEST FOR', badgeX, badgeY + 15, {
                    width: badgeWidth,
                    align: 'center'
                });

            doc
                .fontSize(20)
                .fillColor(colors.primary)
                .text('QUOTATION', badgeX, badgeY + 32, {
                    width: badgeWidth,
                    align: 'center'
                });

            doc
                .fontSize(9)
                .font('Helvetica')
                .fillColor(colors.textMuted)
                .text(rfq.rfqNumber, badgeX, badgeY + 62, {
                    width: badgeWidth,
                    align: 'center'
                });

            // Reset Y position after header
            doc.y = 160;

            // RFQ Details Cards
            const cardY = doc.y;
            const cardHeight = 110;
            const leftCardX = 40;
            const rightCardX = 310;
            const cardWidth = 245;

            // Left card - Timeline & Terms
            const leftCardHeight = 155;
            doc
                .roundedRect(leftCardX, cardY, cardWidth, leftCardHeight, 6)
                .fillAndStroke(colors.white, colors.border);

            doc
                .fontSize(12)
                .font('Helvetica-Bold')
                .fillColor(colors.primary)
                .text('Timeline & Terms', leftCardX + 15, cardY + 15);

            let detailY = cardY + 38;
            const lineSpacing = 22;

            drawDetailRow(doc, leftCardX + 15, detailY, 'Date Issued', formatDate(rfq.dateIssued), colors, false);
            detailY += lineSpacing;

            drawDetailRow(doc, leftCardX + 15, detailY, 'Quote Due', formatDate(rfq.quotationDueDate), colors, true);
            detailY += lineSpacing;

            drawDetailRow(doc, leftCardX + 15, detailY, 'Delivery By', formatDate(rfq.deliveryBy), colors, false);
            detailY += lineSpacing;

            drawDetailRow(doc, leftCardX + 15, detailY, 'Incoterm', rfq.incoterm || 'EXW', colors, false);
            detailY += lineSpacing;

            drawDetailRow(doc, leftCardX + 15, detailY, 'Destination', rfq.destination || 'Paris, France', colors, false);

            // Right card - Contact Information
            doc
                .roundedRect(rightCardX, cardY, cardWidth, leftCardHeight, 6)
                .fillAndStroke(colors.white, colors.border);

            doc
                .fontSize(12)
                .font('Helvetica-Bold')
                .fillColor(colors.primary)
                .text('Contact Information', rightCardX + 15, cardY + 15);

            detailY = cardY + 38;

            // Real company contact details (RFQ-specific overrides win; otherwise config/.env).
            // Lines with no value are skipped rather than printed as "N/A".
            const company = (config && config.company) || {};
            const contactRows = [
                ['Email', rfq.contactEmail || company.email],
                ['Phone', rfq.contactPhone || company.phone],
                ['Location', rfq.location || company.address],
                ['Web', company.website],
                ['VAT/SIRET', company.vat],
            ].filter(([, val]) => val);

            contactRows.forEach(([label, val]) => {
                drawDetailRow(doc, rightCardX + 15, detailY, label, val, colors, false);
                detailY += lineSpacing;
            });

            doc.y = cardY + leftCardHeight + 25;

            // Products Section Header
            doc
                .fontSize(16)
                .font('Helvetica-Bold')
                .fillColor(colors.primary)
                .text('Product Requirements', 40, doc.y);

            // Decorative underline
            const underlineY = doc.y + 5;
            doc
                .moveTo(40, underlineY)
                .lineTo(180, underlineY)
                .lineWidth(3)
                .strokeColor(colors.accent)
                .stroke();

            doc.y = underlineY + 20;

            // Modern Table
            const tableTop = doc.y;
            const colX = {
                no: 40,
                product: 80,
                specs: 260,
                qty: 430,
                unit: 500
            };
            const colWidths = {
                no: 35,
                product: 175,
                specs: 165,
                qty: 65,
                unit: 55
            };
            const headerHeight = 35;
            const rowHeight = 30;

            // Reusable table-header drawer (re-drawn at the top of each new page)
            const drawTableHeader = (y) => {
                doc
                    .rect(40, y, 515, headerHeight)
                    .fill(colors.secondary);
                doc
                    .fontSize(10)
                    .font('Helvetica-Bold')
                    .fillColor(colors.white);
                doc.text('#', colX.no + 8, y + 12);
                doc.text('Product Name', colX.product + 8, y + 12);
                doc.text('Specifications', colX.specs + 8, y + 12);
                doc.text('Quantity', colX.qty + 8, y + 12);
                doc.text('Unit', colX.unit + 8, y + 12);
            };

            // Bottom limit for table rows on a page (keep clear of the page footer)
            const ROW_BOTTOM_LIMIT = 760;
            const PAGE_TOP = 50;

            drawTableHeader(tableTop);
            let currentY = tableTop + headerHeight;

            // Table rows with improved styling + automatic page breaks for long lists
            rfq.items.forEach((item, index) => {
                // Start a new page if the next row would run into the footer area
                if (currentY + rowHeight > ROW_BOTTOM_LIMIT) {
                    doc.addPage();
                    drawTableHeader(PAGE_TOP);
                    currentY = PAGE_TOP + headerHeight;
                }

                const bgColor = index % 2 === 0 ? colors.white : colors.light;

                doc
                    .rect(40, currentY, 515, rowHeight)
                    .fill(bgColor);

                // Subtle border between rows
                doc
                    .moveTo(40, currentY)
                    .lineTo(555, currentY)
                    .strokeColor(colors.border)
                    .lineWidth(0.5)
                    .stroke();

                doc
                    .fontSize(9)
                    .font('Helvetica-Bold')
                    .fillColor(colors.primary);

                doc.text((index + 1).toString(), colX.no + 8, currentY + 10);

                doc
                    .font('Helvetica')
                    .fillColor(colors.dark);

                doc.text(item.productName, colX.product + 8, currentY + 10, {
                    width: colWidths.product - 10,
                    ellipsis: true
                });

                // Combine specifications and additionalInfo (never include targetPrice)
                const specsText = [item.specifications, item.additionalInfo].filter(Boolean).join(' | ') || '—';
                doc
                    .fillColor(colors.textMuted)
                    .text(specsText, colX.specs + 8, currentY + 10, {
                        width: colWidths.specs - 10,
                        ellipsis: true
                    });

                doc
                    .font('Helvetica-Bold')
                    .fillColor(colors.dark)
                    .text(item.quantity.toString(), colX.qty + 8, currentY + 10);

                doc
                    .font('Helvetica')
                    .fillColor(colors.textMuted)
                    .text(item.unit, colX.unit + 8, currentY + 10);

                currentY += rowHeight;
            });

            // Table bottom border
            doc
                .moveTo(40, currentY)
                .lineTo(555, currentY)
                .strokeColor(colors.border)
                .lineWidth(1)
                .stroke();

            doc.y = currentY + 20;

            // Special Requirements
            if (rfq.packagingRequirements || rfq.paymentTermsPreference || rfq.otherNotes) {
                // If there isn't enough room left on the page, start a fresh one
                if (doc.y > 620) {
                    doc.addPage();
                    doc.y = 50;
                }
                doc
                    .fontSize(16)
                    .font('Helvetica-Bold')
                    .fillColor(colors.primary)
                    .text('Special Requirements', 40, doc.y);

                const reqUnderlineY = doc.y + 5;
                doc
                    .moveTo(40, reqUnderlineY)
                    .lineTo(210, reqUnderlineY)
                    .lineWidth(3)
                    .strokeColor(colors.accent)
                    .stroke();

                doc.y = reqUnderlineY + 20;

                const reqBoxX = 40;
                const reqBoxWidth = 515;
                let reqBoxHeight = 0;
                const reqStartY = doc.y;

                // Calculate height needed
                const tempY = doc.y;
                doc.fontSize(9).font('Helvetica');

                if (rfq.packagingRequirements) {
                    reqBoxHeight += 25;
                }
                if (rfq.paymentTermsPreference) {
                    reqBoxHeight += 25;
                }
                if (rfq.otherNotes) {
                    reqBoxHeight += 25;
                }

                // Draw background box
                doc
                    .roundedRect(reqBoxX, reqStartY, reqBoxWidth, reqBoxHeight, 6)
                    .fillAndStroke(colors.light, colors.border);

                let reqY = reqStartY + 12;

                if (rfq.packagingRequirements) {
                    doc
                        .fontSize(9)
                        .font('Helvetica-Bold')
                        .fillColor(colors.primary)
                        .text('Packaging: ', reqBoxX + 15, reqY);

                    doc
                        .font('Helvetica')
                        .fillColor(colors.dark)
                        .text(rfq.packagingRequirements, reqBoxX + 100, reqY, {
                            width: reqBoxWidth - 120
                        });
                    reqY += 25;
                }

                if (rfq.paymentTermsPreference) {
                    doc
                        .font('Helvetica-Bold')
                        .fillColor(colors.primary)
                        .text('Payment: ', reqBoxX + 15, reqY);

                    doc
                        .font('Helvetica')
                        .fillColor(colors.dark)
                        .text(rfq.paymentTermsPreference, reqBoxX + 100, reqY, {
                            width: reqBoxWidth - 120
                        });
                    reqY += 25;
                }

                if (rfq.otherNotes) {
                    doc
                        .font('Helvetica-Bold')
                        .fillColor(colors.primary)
                        .text('Notes: ', reqBoxX + 15, reqY);

                    doc
                        .font('Helvetica')
                        .fillColor(colors.dark)
                        .text(rfq.otherNotes, reqBoxX + 100, reqY, {
                            width: reqBoxWidth - 120
                        });
                }

                doc.y = reqStartY + reqBoxHeight + 20;
            }

            // Footer — pin to the bottom of the page, but drop to a new page if the
            // content already runs into that area (avoids overlap on long RFQs).
            let footerY = 750;
            if (doc.y > footerY - 30) {
                doc.addPage();
                footerY = 750;
            }

            // Footer separator
            doc
                .moveTo(40, footerY)
                .lineTo(555, footerY)
                .strokeColor(colors.border)
                .lineWidth(1)
                .stroke();

            // Real company contact line in the footer (only the values we actually have)
            const companyFooter = (config && config.company) || {};
            const footerContact = [
                companyFooter.name,
                companyFooter.phone,
                companyFooter.email,
                companyFooter.website,
            ].filter(Boolean).join('  •  ');

            doc
                .fontSize(9)
                .font('Helvetica')
                .fillColor(colors.textMuted)
                .text(
                    'Please submit your quotation before the due date. Include unit prices, total cost, delivery terms, and payment conditions.',
                    40,
                    footerY + 10,
                    {
                        width: 515,
                        align: 'center',
                        lineGap: 2
                    }
                );

            doc
                .fontSize(8)
                .font('Helvetica-Bold')
                .fillColor(colors.primary)
                .text(footerContact || (companyFooter.name || 'Halal Foods'), 40, footerY + 38, {
                    width: 515,
                    align: 'center'
                });

            // Finalize PDF
            doc.end();

        } catch (error) {
            reject(error);
        }
    });
}

/**
 * Helper function to draw detail rows
 */
function drawDetailRow(doc, x, y, label, value, colors, isUrgent) {
    doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor(colors.textMuted)
        .text(label, x, y);

    doc
        .font('Helvetica-Bold')
        .fillColor(isUrgent ? colors.accent : colors.dark)
        .text(value, x + 95, y, {
            width: 130,
            ellipsis: true
        });
}

/**
 * Format date to readable string
 */
function formatDate(date) {
    if (!date) return 'N/A';

    const d = new Date(date);
    const options = { year: 'numeric', month: 'short', day: 'numeric' };
    return d.toLocaleDateString('en-GB', options);
}

module.exports = {
    generateRFQPDF,
};