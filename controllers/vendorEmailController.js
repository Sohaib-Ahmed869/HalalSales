// controllers/vendorEmailController.js
const vendorEmailService = require('../services/vendorEmailService');
const Vendor = require('../models/Vendor');

/**
 * Sync vendors from Gmail history
 * POST /api/vendor-email/sync
 */
exports.syncVendorsFromEmail = async (req, res) => {
    try {
        console.log('Starting vendor sync from email...');

        const vendors = await vendorEmailService.storeEmailVendorsInDB();

        res.json({
            success: true,
            message: `Successfully synced ${vendors.length} vendors from email history`,
            data: {
                totalVendors: vendors.length,
                vendors: vendors.map(v => ({
                    cardCode: v.CardCode,
                    name: v.CardName,
                    email: v.email,
                    categories: v.productCategories,
                    certifications: v.certifications,
                })),
            },
        });
    } catch (error) {
        console.error('Error syncing vendors:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
};

/**
 * Get email vendors
 * GET /api/vendor-email/list
 */
exports.getEmailVendors = async (req, res) => {
    try {
        const vendors = await Vendor.find({
            'customFields.isEmailVendor': true,
            isActive: true,
        }).select('CardCode CardName email productCategories certifications customFields');

        res.json({
            success: true,
            data: vendors,
        });
    } catch (error) {
        console.error('Error fetching email vendors:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
};

/**
 * Parse RFQ responses from email
 * GET /api/vendor-email/rfq-responses/:rfqNumber
 */
exports.getRFQResponsesFromEmail = async (req, res) => {
    try {
        const { rfqNumber } = req.params;

        const responses = await vendorEmailService.parseRFQResponsesFromEmail(rfqNumber);

        res.json({
            success: true,
            data: {
                rfqNumber,
                totalResponses: responses.length,
                responses,
            },
        });
    } catch (error) {
        console.error('Error fetching RFQ responses:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
};

module.exports = exports;