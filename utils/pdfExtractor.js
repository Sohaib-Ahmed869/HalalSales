// ============================================================================
// COMPLETE FILE: utils/pdfExtractor.js
// Create this file if it doesn't exist, or replace entirely
// ============================================================================
 
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

// Disable worker to avoid issues in Node.js
pdfjsLib.GlobalWorkerOptions.workerSrc = null;

/**
 * Extract text content from PDF buffer
 * @param {Buffer} pdfBuffer - PDF file as buffer
 * @returns {Promise<string>} - Extracted text content
 */
async function extractTextFromPDF(pdfBuffer) {
    try {
        // Convert buffer to Uint8Array
        const pdfData = new Uint8Array(pdfBuffer);

        // Load PDF document
        const loadingTask = pdfjsLib.getDocument({
            data: pdfData,
            useSystemFonts: true,
            standardFontDataUrl: null,
        });

        const pdf = await loadingTask.promise;
        let fullText = '';

        console.log(`📄 PDF has ${pdf.numPages} page(s)`);

        // Extract text from each page
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();

            // Combine text items with spaces
            const pageText = textContent.items
                .map(item => item.str)
                .join(' ');

            fullText += `\n--- Page ${pageNum} ---\n${pageText}\n`;

            console.log(`✅ Extracted ${pageText.length} characters from page ${pageNum}`);
        }

        return fullText.trim();
    } catch (error) {
        console.error('❌ Error extracting text from PDF:', error.message);
        throw new Error(`PDF extraction failed: ${error.message}`);
    }
}

/**
 * Extract text from multiple PDF buffers
 * @param {Array<{buffer: Buffer, filename: string}>} pdfs
 * @returns {Promise<string>} - Combined extracted text
 */
async function extractTextFromMultiplePDFs(pdfs) {
    let combinedText = '';

    for (const pdf of pdfs) {
        try {
            console.log(`\n📄 Extracting text from: ${pdf.filename}`);
            const text = await extractTextFromPDF(pdf.buffer);
            combinedText += `\n\n=== PDF: ${pdf.filename} ===\n`;
            combinedText += text;
            combinedText += `\n=== END OF ${pdf.filename} ===\n\n`;
        } catch (error) {
            console.error(`❌ Failed to extract ${pdf.filename}:`, error.message);
            combinedText += `\n\n=== FAILED TO EXTRACT: ${pdf.filename} ===\n`;
            combinedText += `Error: ${error.message}\n`;
        }
    }

    return combinedText;
}

module.exports = {
    extractTextFromPDF,
    extractTextFromMultiplePDFs,
};