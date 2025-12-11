const gmailService = require('./gmailService');
const rfqResponseParser = require('./rfqResponseParser');
const RFQ = require('../models/RFQ');

class RFQEmailMonitor {
    constructor() {
        this.isMonitoring = false;
        this.monitoringInterval = null;
    }

    /**
     * Start monitoring for RFQ responses
     */
    startMonitoring(intervalMs = 300000) { // Default: 5 minutes
        if (this.isMonitoring) {
            console.log('⚠️ Email monitoring already running');
            return;
        }

        console.log(`🔄 Starting RFQ email monitoring (every ${intervalMs / 1000}s)`);
        this.isMonitoring = true;

        // Run immediately
        this.checkForResponses();

        // Then run periodically
        this.monitoringInterval = setInterval(() => {
            this.checkForResponses();
        }, intervalMs);
    }

    /**
     * Stop monitoring
     */
    stopMonitoring() {
        if (this.monitoringInterval) {
            clearInterval(this.monitoringInterval);
            this.isMonitoring = false;
            console.log('⏹️ Email monitoring stopped');
        }
    }

    /**
     * Check for new RFQ responses
     */
    async checkForResponses() {
        try {
            console.log('\n🔍 Checking for new RFQ responses...');

            // Get all active RFQs (sent or in_progress)
            const activeRFQs = await RFQ.find({
                status: { $in: ['sent', 'in_progress'] },
            });

            console.log(`📋 Found ${activeRFQs.length} active RFQs`);

            for (const rfq of activeRFQs) {
                await this.processRFQResponses(rfq);
            }

            console.log('✅ Email check complete\n');
        } catch (error) {
            console.error('❌ Error checking for responses:', error);
        }
    }

    /**
     * Process responses for a specific RFQ
     */
    async processRFQResponses(rfq) {
        try {
            // Fetch emails related to this RFQ
            const emails = await gmailService.fetchRFQResponses(rfq.rfqNumber);

            if (emails.length === 0) {
                return;
            }

            console.log(`📬 Processing ${emails.length} emails for ${rfq.rfqNumber}`);

            for (const email of emails) {
                const parsedResponse = await rfqResponseParser.parseVendorResponse(email, rfq);

                if (parsedResponse && parsedResponse.quotationData.isValidQuotation) {
                    // Update RFQ with vendor response
                    await this.updateRFQWithResponse(rfq, parsedResponse);

                    // Mark email as read
                    await gmailService.markAsRead(email.messageId);

                    console.log(`✅ Recorded response from ${parsedResponse.vendorName}`);
                }
            }
        } catch (error) {
            console.error(`❌ Error processing RFQ ${rfq.rfqNumber}:`, error);
        }
    }

    /**
     * Update RFQ document with vendor response
     */
    async updateRFQWithResponse(rfq, parsedResponse) {
        const vendor = rfq.vendorsContacted.find(
            v => v.vendorCode === parsedResponse.vendorCode
        );

        if (!vendor) return;

        // Update vendor response
        vendor.status = 'responded';
        vendor.responseDate = parsedResponse.receivedDate;
        vendor.quotedTotal = parsedResponse.quotationData.totalQuotedAmount;
        vendor.deliveryDate = parsedResponse.quotationData.deliveryDate
            ? new Date(parsedResponse.quotationData.deliveryDate)
            : null;
        vendor.paymentTerms = parsedResponse.quotationData.paymentTerms;
        vendor.notes = parsedResponse.quotationData.additionalNotes;
        vendor.quotationData = parsedResponse.quotationData;
        vendor.emailMessageId = parsedResponse.messageId;

        // Update RFQ status
        const allResponded = rfq.vendorsContacted.every(
            v => ['responded', 'declined'].includes(v.status)
        );

        rfq.status = allResponded ? 'completed' : 'in_progress';

        await rfq.save();
    }
}

module.exports = new RFQEmailMonitor();