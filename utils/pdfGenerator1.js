// utils/pdfGenerator.js
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const config = require('../config/config');

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2; // 515

/**
 * Generate RFQ PDF document with a clean, professional layout.
 * @param {Object} rfq - RFQ data
 * @returns {Promise<Buffer>} PDF buffer
 */
async function generateRFQPDF(rfq) {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: 'A4',
                margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
            });

            const chunks = [];
            doc.on('data', chunk => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            const colors = {
                primary: '#1a472a',      // Deep green (headings / titles)
                secondary: '#5ba34a',    // Brand green (logo swoosh) — table header
                accent: '#e64a2e',       // Brand coral-red (logo wordmark) — stripes, badge, underlines
                dark: '#1f2937',         // Dark gray
                text: '#374151',         // Body text
                light: '#f3f4f6',        // Light gray
                white: '#ffffff',
                border: '#e5e7eb',
                textMuted: '#6b7280',
            };

            const company = (config && config.company) || {};
            const companyName = company.name || 'Halal Foods';

            // ============================ HEADER ============================
            // Brand top stripe (coral red)
            doc.rect(0, 0, PAGE_W, 8).fill(colors.accent);

            // Brand logo, top-left (falls back to the company name as text if missing)
            const logoPath = path.join(__dirname, '..', 'assets', 'logo.png');
            let logoOk = false;
            try {
                if (fs.existsSync(logoPath)) {
                    doc.image(logoPath, MARGIN, 26, { width: 130 });
                    logoOk = true;
                }
            } catch (_) {
                logoOk = false;
            }
            if (!logoOk) {
                const headerName = companyName.toUpperCase();
                doc.fontSize(headerName.length > 16 ? 22 : 28).font('Helvetica-Bold').fillColor(colors.accent)
                    .text(headerName, MARGIN, 36, { width: 350, lineBreak: false });
            }

            // Tagline under the logo
            doc.fontSize(9).font('Helvetica').fillColor(colors.textMuted)
                .text('Premium Halal Food Wholesaler', MARGIN, 112, { width: 320, lineBreak: false });

            // RFQ Badge (top-right) — red outline on white
            const badgeX = 410, badgeY = 28, badgeW = 145, badgeH = 82;
            doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 8).lineWidth(1.5).fillAndStroke(colors.white, colors.accent);
            doc.fontSize(10).font('Helvetica-Bold').fillColor(colors.accent)
                .text('REQUEST FOR', badgeX, badgeY + 14, { width: badgeW, align: 'center' });
            doc.fontSize(19).fillColor(colors.primary)
                .text('QUOTATION', badgeX, badgeY + 31, { width: badgeW, align: 'center' });
            doc.fontSize(9).font('Helvetica').fillColor(colors.textMuted)
                .text(rfq.rfqNumber || '', badgeX, badgeY + 60, { width: badgeW, align: 'center' });

            // Divider under header
            doc.moveTo(MARGIN, 134).lineTo(PAGE_W - MARGIN, 134).strokeColor(colors.border).lineWidth(1).stroke();

            // ============================ INFO CARDS ============================
            const cardY = 152;
            const leftX = MARGIN;
            const rightX = 305;
            const cardW = 250;
            const pad = 15;
            const innerValueW = cardW - pad * 2;

            // Left card content (short values → inline label/value)
            const terms = [
                ['Date Issued', formatDate(rfq.dateIssued), false],
                ['Quote Due', formatDate(rfq.quotationDueDate), true],
                ['Delivery By', formatDate(rfq.deliveryBy), false],
                ['Incoterm', rfq.incoterm || 'EXW', false],
                ['Destination', rfq.destination || 'See below', false],
            ];

            // Right card content (long values → stacked label over wrapped value)
            const contacts = [
                ['Email', rfq.contactEmail || company.email],
                ['Phone', rfq.contactPhone || company.phone],
                ['Address', rfq.location || company.address],
                ['Website', company.website],
                ['VAT / SIRET', company.vat],
            ].filter(([, v]) => v);

            // Measure the stacked (right) card so both cards share a height with no overlap
            const labelH = 12, stackGap = 7, rowGap = 22, titleBlock = 42;
            doc.fontSize(9).font('Helvetica-Bold');
            let rightContentH = 0;
            contacts.forEach(([, val]) => {
                rightContentH += labelH + doc.heightOfString(String(val), { width: innerValueW }) + stackGap;
            });
            const leftContentH = terms.length * rowGap;
            const cardH = Math.max(leftContentH, rightContentH) + titleBlock + 8;

            // Backgrounds
            doc.roundedRect(leftX, cardY, cardW, cardH, 6).fillAndStroke(colors.white, colors.border);
            doc.roundedRect(rightX, cardY, cardW, cardH, 6).fillAndStroke(colors.white, colors.border);

            // Left card — Timeline & Terms
            doc.fontSize(12).font('Helvetica-Bold').fillColor(colors.primary)
                .text('Timeline & Terms', leftX + pad, cardY + 15);
            let ly = cardY + titleBlock;
            terms.forEach(([label, val, urgent]) => {
                doc.fontSize(9).font('Helvetica').fillColor(colors.textMuted).text(label, leftX + pad, ly);
                doc.font('Helvetica-Bold').fillColor(urgent ? colors.accent : colors.dark)
                    .text(String(val), leftX + pad + 82, ly, { width: cardW - pad * 2 - 82, ellipsis: true });
                ly += rowGap;
            });

            // Right card — Contact Information (stacked, wraps cleanly)
            doc.fontSize(12).font('Helvetica-Bold').fillColor(colors.primary)
                .text('Contact Information', rightX + pad, cardY + 15);
            let ry = cardY + titleBlock;
            contacts.forEach(([label, val]) => {
                doc.fontSize(7.5).font('Helvetica').fillColor(colors.textMuted)
                    .text(label.toUpperCase(), rightX + pad, ry, { characterSpacing: 0.5 });
                ry += labelH;
                doc.fontSize(9).font('Helvetica-Bold').fillColor(colors.dark)
                    .text(String(val), rightX + pad, ry, { width: innerValueW });
                ry += doc.heightOfString(String(val), { width: innerValueW }) + stackGap;
            });

            doc.y = cardY + cardH + 26;

            // ============================ PRODUCTS ============================
            sectionHeading(doc, 'Product Requirements', colors, 150);

            const tableTop = doc.y;
            const colX = { no: 40, product: 80, specs: 260, qty: 432, unit: 500 };
            const colWidths = { no: 35, product: 175, specs: 165, qty: 65, unit: 55 };
            const headerHeight = 32;
            const rowHeight = 28;
            const ROW_BOTTOM_LIMIT = 762;
            const PAGE_TOP = 50;

            const drawTableHeader = (y) => {
                doc.rect(MARGIN, y, CONTENT_W, headerHeight).fill(colors.secondary);
                doc.fontSize(10).font('Helvetica-Bold').fillColor(colors.white);
                doc.text('#', colX.no + 8, y + 11);
                doc.text('Product Name', colX.product + 8, y + 11);
                doc.text('Specifications', colX.specs + 8, y + 11);
                doc.text('Quantity', colX.qty + 8, y + 11);
                doc.text('Unit', colX.unit + 8, y + 11);
            };

            drawTableHeader(tableTop);
            let currentY = tableTop + headerHeight;

            (rfq.items || []).forEach((item, index) => {
                // Page break for long item lists
                if (currentY + rowHeight > ROW_BOTTOM_LIMIT) {
                    doc.addPage();
                    drawTableHeader(PAGE_TOP);
                    currentY = PAGE_TOP + headerHeight;
                }

                const bgColor = index % 2 === 0 ? colors.white : colors.light;
                doc.rect(MARGIN, currentY, CONTENT_W, rowHeight).fill(bgColor);
                doc.moveTo(MARGIN, currentY).lineTo(PAGE_W - MARGIN, currentY)
                    .strokeColor(colors.border).lineWidth(0.5).stroke();

                doc.fontSize(9).font('Helvetica-Bold').fillColor(colors.primary)
                    .text((index + 1).toString(), colX.no + 8, currentY + 9);

                doc.font('Helvetica').fillColor(colors.dark)
                    .text(item.productName || '—', colX.product + 8, currentY + 9, { width: colWidths.product - 10, ellipsis: true });

                const specsText = [item.specifications, item.additionalInfo].filter(Boolean).join(' | ') || '—';
                doc.fillColor(colors.text)
                    .text(specsText, colX.specs + 8, currentY + 9, { width: colWidths.specs - 10, ellipsis: true });

                doc.font('Helvetica-Bold').fillColor(colors.dark)
                    .text(String(item.quantity ?? ''), colX.qty + 8, currentY + 9);

                doc.font('Helvetica').fillColor(colors.textMuted)
                    .text(item.unit || '', colX.unit + 8, currentY + 9);

                currentY += rowHeight;
            });

            doc.moveTo(MARGIN, currentY).lineTo(PAGE_W - MARGIN, currentY)
                .strokeColor(colors.border).lineWidth(1).stroke();
            doc.y = currentY + 22;

            // ============================ SPECIAL REQUIREMENTS ============================
            const reqItems = [
                ['Packaging', rfq.packagingRequirements],
                ['Payment', rfq.paymentTermsPreference],
                ['Notes', rfq.otherNotes],
            ].filter(([, v]) => v);

            if (reqItems.length) {
                // Measure box height (values may wrap)
                const reqValueX = MARGIN + 95;
                const reqValueW = CONTENT_W - 95 - 15;
                doc.fontSize(9).font('Helvetica');
                let reqBoxHeight = 16;
                const heights = reqItems.map(([, val]) => Math.max(16, doc.heightOfString(String(val), { width: reqValueW }) + 6));
                heights.forEach(h => { reqBoxHeight += h; });

                // New page if not enough room for the heading + box
                if (doc.y + reqBoxHeight + 50 > PAGE_H - MARGIN) {
                    doc.addPage();
                    doc.y = PAGE_TOP;
                }

                sectionHeading(doc, 'Special Requirements', colors, 180);

                const reqStartY = doc.y;
                doc.roundedRect(MARGIN, reqStartY, CONTENT_W, reqBoxHeight, 6).fillAndStroke(colors.light, colors.border);

                let reqY = reqStartY + 12;
                reqItems.forEach(([label, val], i) => {
                    doc.fontSize(9).font('Helvetica-Bold').fillColor(colors.primary)
                        .text(`${label}:`, MARGIN + 15, reqY);
                    doc.font('Helvetica').fillColor(colors.dark)
                        .text(String(val), reqValueX, reqY, { width: reqValueW });
                    reqY += heights[i];
                });
                doc.y = reqStartY + reqBoxHeight + 20;
            }

            // ============================ FOOTER ============================
            // Pin to the bottom of the page; only push to a new page if content runs into it.
            if (doc.y > PAGE_H - MARGIN - 70) {
                doc.addPage();
            }
            const footerY = PAGE_H - MARGIN - 48; // ~754

            doc.moveTo(MARGIN, footerY).lineTo(PAGE_W - MARGIN, footerY)
                .strokeColor(colors.border).lineWidth(1).stroke();

            doc.fontSize(9).font('Helvetica').fillColor(colors.textMuted).text(
                'Please submit your quotation before the due date, including unit prices, total cost, delivery terms and payment conditions.',
                MARGIN, footerY + 12, { width: CONTENT_W, align: 'center', lineGap: 2 }
            );

            const footerContact = [company.name, company.phone, company.email, company.website]
                .filter(Boolean).join('   •   ');
            doc.fontSize(8).font('Helvetica-Bold').fillColor(colors.primary).text(
                footerContact || companyName, MARGIN, footerY + 36, { width: CONTENT_W, align: 'center' }
            );

            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}

/** Section heading with an accent underline. */
function sectionHeading(doc, title, colors, underlineWidth) {
    doc.fontSize(16).font('Helvetica-Bold').fillColor(colors.primary).text(title, 40, doc.y);
    const underlineY = doc.y + 4;
    doc.moveTo(40, underlineY).lineTo(40 + (underlineWidth || 160), underlineY)
        .lineWidth(3).strokeColor(colors.accent).stroke();
    doc.y = underlineY + 18;
}

/** Format date to a readable string. */
function formatDate(date) {
    if (!date) return 'N/A';
    const d = new Date(date);
    return d.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
}

module.exports = {
    generateRFQPDF,
};
