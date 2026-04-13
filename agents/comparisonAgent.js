// agents/comparisonAgent.js
const { BaseAgent } = require('./baseAgent');
const RFQ = require('../models/RFQ');
const Vendor = require('../models/Vendor');
const PurchaseInvoice = require('../models/Purchase');
const gmailService = require('../services/gmailService');

class ComparisonAgent extends BaseAgent {
    constructor() {
        super('Comparison');
    }

    /**
     * Generate a comparison report for an RFQ
     * @param {string} rfqId
     * @returns {Object} Comparison report
     */
    async compare({ rfqId }) {
        this.log(`Generating comparison for RFQ ${rfqId}`);
        this.addToActionLog('comparison_started', { rfqId });

        try {
            const rfq = await RFQ.findById(rfqId);
            if (!rfq) throw new Error(`RFQ ${rfqId} not found`);

            const respondedVendors = rfq.vendorsContacted.filter(
                v => v.status === 'responded' && (v.quotationData?.totalQuotedAmount || v.quotedTotal)
            );

            if (respondedVendors.length === 0) {
                this.log('No vendor responses to compare');
                return {
                    rfqNumber: rfq.rfqNumber,
                    message: 'No vendor responses with pricing to compare',
                    comparison: [],
                };
            }

            this.log(`Comparing ${respondedVendors.length} vendor responses`);

            // Gather vendor history from MongoDB
            const vendorHistories = await this._getVendorHistories(
                respondedVendors.map(v => v.vendorCode)
            );

            // Build context for Claude
            const vendorData = respondedVendors.map(v => {
                const history = vendorHistories[v.vendorCode] || {};
                return {
                    vendorCode: v.vendorCode,
                    vendorName: v.vendorName,
                    vendorSource: v.vendorSource || 'SAP',
                    quotedTotal: v.quotationData?.totalQuotedAmount || v.quotedTotal || 0,
                    currency: v.quotationData?.currency || 'EUR',
                    quotedItems: v.quotationData?.quotedItems || [],
                    deliveryTimeInDays: v.quotationData?.deliveryTimeInDays,
                    paymentTerms: v.quotationData?.paymentTerms || v.paymentTerms,
                    additionalNotes: v.quotationData?.additionalNotes,
                    // Historical data
                    historicalOrders: history.totalOrders || 0,
                    historicalAvgPrice: history.avgPrice || 0,
                    onTimeDeliveryRate: history.onTimeDeliveryRate || 0,
                    qualityRating: history.qualityRating || 0,
                    lastOrderDate: history.lastOrderDate,
                    isNewVendor: (history.totalOrders || 0) === 0,
                };
            });

            // Build target prices map (internal only — for comparison report)
            const targetPricesMap = {};
            rfq.items.forEach(item => {
                targetPricesMap[item.productName] = item.targetPrice || item.estimatedPrice || null;
            });

            const systemPrompt = `You are a procurement analysis expert for Halal Foods, a premium food wholesaler.

Generate a comprehensive vendor comparison report for an RFQ. Consider ALL factors, not just price.
Include ITEM-LEVEL comparison showing how each vendor priced each individual product.

Return a JSON object with this EXACT structure:
{
  "summary": "One paragraph executive summary",
  "itemComparison": [
    {
      "productName": "string",
      "targetPrice": number_or_null,
      "unit": "string",
      "vendorPrices": [
        {
          "vendorCode": "string",
          "vendorName": "string",
          "unitPrice": number,
          "vsTarget": "+X% or -X% (only if targetPrice exists)"
        }
      ],
      "bestVendor": "vendor name with lowest price",
      "bestPrice": number,
      "meetsTarget": true_or_false
    }
  ],
  "priceRanking": [
    {
      "rank": 1,
      "vendorCode": "string",
      "vendorName": "string",
      "totalQuoted": number,
      "currency": "string",
      "priceVsAverage": "X% below/above average"
    }
  ],
  "deliveryRanking": [
    {
      "rank": 1,
      "vendorCode": "string",
      "vendorName": "string",
      "deliveryDays": number,
      "assessment": "string"
    }
  ],
  "paymentTermsAnalysis": [
    {
      "vendorCode": "string",
      "vendorName": "string",
      "terms": "string",
      "favorability": "favorable|neutral|unfavorable"
    }
  ],
  "riskFlags": [
    {
      "vendorCode": "string",
      "vendorName": "string",
      "riskLevel": "low|medium|high",
      "flags": ["string"],
      "reasoning": "string"
    }
  ],
  "recommendation": {
    "winnerCode": "string",
    "winnerName": "string",
    "reasoning": "string",
    "alternativeCode": "string",
    "alternativeName": "string",
    "alternativeReasoning": "string"
  },
  "potentialSavings": {
    "highestQuote": number,
    "lowestQuote": number,
    "savingsAmount": number,
    "savingsPercentage": "string"
  },
  "targetPriceAnalysis": {
    "itemsMeetingTarget": number,
    "totalItems": number,
    "summary": "string describing how quotes compare to targets"
  }
}`;

            const userMessage = `Compare these vendor responses for RFQ ${rfq.rfqNumber}:

RFQ Items (with internal target prices for comparison):
${rfq.items.map((item, i) => `${i + 1}. ${item.productName} — ${item.quantity} ${item.unit} — Target: ${item.targetPrice || item.estimatedPrice || 'N/A'}`).join('\n')}

Internal Target Prices (for analysis, NOT for sharing with vendors):
${JSON.stringify(targetPricesMap, null, 2)}

Vendor Responses:
${JSON.stringify(vendorData, null, 2)}

IMPORTANT:
- The CHEAPEST vendor is not always the best choice
- New vendors (0 historical orders) carry higher risk
- Consider delivery time, payment terms, and track record
- Flag prices that are >30% below average (suspiciously low)
- Recommend the best OVERALL value, not just cheapest
- Compare EACH item's quoted price across all vendors (itemComparison)
- Show how each quote compares to the target price (vsTarget percentage)
- The target prices are INTERNAL — this report is for internal use only`;

            const response = await this.callLLM(systemPrompt, userMessage);
            const reportText = this.extractText(response);
            const report = this.extractJSON(reportText);

            if (!report) {
                throw new Error('Failed to parse comparison report from AI');
            }

            // Save report to RFQ metadata
            rfq.metadata = {
                ...rfq.metadata,
                comparisonReport: {
                    ...report,
                    generatedAt: new Date(),
                    vendorsCompared: respondedVendors.length,
                },
            };
            await rfq.save();

            this.log(`Comparison report saved for RFQ ${rfq.rfqNumber}`);

            // Send summary email to RFQ contact
            await this._sendSummaryEmail(rfq, report);

            this.addToActionLog('comparison_completed', {
                rfqNumber: rfq.rfqNumber,
                vendorsCompared: respondedVendors.length,
                winner: report.recommendation?.winnerName,
            });

            return report;
        } catch (error) {
            this.logError('Error generating comparison:', error);
            this.addToActionLog('comparison_error', { rfqId, error: error.message });
            throw error;
        }
    }

    /**
     * Get vendor histories from MongoDB
     */
    async _getVendorHistories(vendorCodes) {
        const histories = {};

        // Get from Vendor model
        const vendors = await Vendor.find({ CardCode: { $in: vendorCodes } });
        for (const v of vendors) {
            histories[v.CardCode] = {
                totalOrders: v.performanceMetrics?.totalOrders || 0,
                avgPrice: v.performanceMetrics?.averageOrderValue || 0,
                onTimeDeliveryRate: v.performanceMetrics?.onTimeDeliveryRate || 0,
                qualityRating: v.performanceMetrics?.qualityRating || 0,
                lastOrderDate: v.lastOrderDate,
            };
        }

        // Enrich with actual purchase data
        try {
            const purchaseStats = await PurchaseInvoice.aggregate([
                { $match: { CardCode: { $in: vendorCodes } } },
                {
                    $group: {
                        _id: '$CardCode',
                        totalOrders: { $sum: 1 },
                        avgTotal: { $avg: '$DocTotal' },
                        lastOrder: { $max: '$DocDate' },
                    },
                },
            ]);

            for (const stat of purchaseStats) {
                if (histories[stat._id]) {
                    histories[stat._id].totalOrders = Math.max(
                        histories[stat._id].totalOrders,
                        stat.totalOrders
                    );
                    histories[stat._id].avgPrice = stat.avgTotal;
                    histories[stat._id].lastOrderDate = stat.lastOrder;
                } else {
                    histories[stat._id] = {
                        totalOrders: stat.totalOrders,
                        avgPrice: stat.avgTotal,
                        onTimeDeliveryRate: 0,
                        qualityRating: 0,
                        lastOrderDate: stat.lastOrder,
                    };
                }
            }
        } catch (err) {
            this.logError('Error fetching purchase stats:', err);
        }

        return histories;
    }

    /**
     * Send comparison summary email
     */
    async _sendSummaryEmail(rfq, report) {
        if (!rfq.contactEmail) {
            this.log('No contact email on RFQ, skipping summary email');
            return;
        }

        try {
            const priceRows = (report.priceRanking || [])
                .map(v => `<tr>
                    <td style="padding:8px;border-bottom:1px solid #eee;">${v.rank}</td>
                    <td style="padding:8px;border-bottom:1px solid #eee;">${v.vendorName}</td>
                    <td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold;">${v.currency || 'EUR'} ${v.totalQuoted?.toLocaleString()}</td>
                    <td style="padding:8px;border-bottom:1px solid #eee;">${v.priceVsAverage || '-'}</td>
                </tr>`)
                .join('');

            const riskRows = (report.riskFlags || [])
                .map(v => `<li><strong>${v.vendorName}</strong> (${v.riskLevel} risk): ${v.flags?.join(', ')}</li>`)
                .join('');

            const html = `
<div style="font-family: Arial, sans-serif; max-width: 600px;">
    <h2 style="color: #1a472a;">RFQ Comparison Report — ${rfq.rfqNumber}</h2>

    <p style="color: #4b5563;">${report.summary || ''}</p>

    <h3 style="color: #1a472a;">Price Ranking</h3>
    <table style="width:100%;border-collapse:collapse;">
        <tr style="background:#f3f4f6;">
            <th style="padding:8px;text-align:left;">Rank</th>
            <th style="padding:8px;text-align:left;">Vendor</th>
            <th style="padding:8px;text-align:left;">Total</th>
            <th style="padding:8px;text-align:left;">vs Average</th>
        </tr>
        ${priceRows}
    </table>

    ${report.recommendation ? `
    <h3 style="color: #1a472a;">Recommendation</h3>
    <div style="background:#f0f9ff;border-left:4px solid #3b82f6;padding:15px;margin:15px 0;">
        <p style="margin:0;"><strong>Winner: ${report.recommendation.winnerName}</strong></p>
        <p style="margin:5px 0 0;color:#4b5563;">${report.recommendation.reasoning}</p>
    </div>
    ${report.recommendation.alternativeName ? `
    <p style="color:#6b7280;"><em>Alternative: ${report.recommendation.alternativeName} — ${report.recommendation.alternativeReasoning}</em></p>
    ` : ''}
    ` : ''}

    ${riskRows ? `
    <h3 style="color: #1a472a;">Risk Flags</h3>
    <ul style="color:#4b5563;">${riskRows}</ul>
    ` : ''}

    ${report.potentialSavings ? `
    <h3 style="color: #1a472a;">Potential Savings</h3>
    <p style="color:#4b5563;">
        Choosing the lowest quote saves <strong>${report.potentialSavings.currency || 'EUR'} ${report.potentialSavings.savingsAmount?.toLocaleString()}</strong>
        (${report.potentialSavings.savingsPercentage}) compared to the highest quote.
    </p>
    ` : ''}

    <hr style="margin:20px 0;border:none;border-top:1px solid #e5e7eb;">
    <p style="color:#9ca3af;font-size:12px;">
        Generated by Halal Foods AI Agent System<br>
        ${new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' })}
    </p>
</div>`;

            await gmailService.sendEmail({
                to: rfq.contactEmail,
                subject: `RFQ Comparison Report — ${rfq.rfqNumber}`,
                html,
                text: `RFQ Comparison Report for ${rfq.rfqNumber}\n\n${report.summary || ''}\n\nRecommended winner: ${report.recommendation?.winnerName || 'N/A'}\nReason: ${report.recommendation?.reasoning || 'N/A'}`,
            });

            this.log(`Summary email sent to ${rfq.contactEmail}`);
        } catch (err) {
            this.logError('Failed to send summary email:', err);
        }
    }
}

module.exports = new ComparisonAgent();
