// controllers/emailLogController.js
const {
    getEmailLogs,
    getEmailLogById,
    getEmailStats,
} = require("../utils/emailLogger");
const { generatePresignedUrl } = require("../config/s3");

// Get email logs with filters
exports.getEmailLogs = async (req, res) => {
    try {
        const filters = {
            emailType: req.query.emailType,
            status: req.query.status,
            customerCardCode: req.query.customerCardCode,
            relatedInvoice: req.query.relatedInvoice,
            relatedCustomer: req.query.relatedCustomer,
            fromDate: req.query.fromDate,
            toDate: req.query.toDate,
            page: parseInt(req.query.page) || 1,
            limit: parseInt(req.query.limit) || 50,
        };

        const result = await getEmailLogs(filters);

        res.json({
            success: true,
            ...result,
        });
    } catch (error) {
        console.error("Error fetching email logs:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching email logs",
            error: error.message,
        });
    }
};

// Get single email log by ID
exports.getEmailLogById = async (req, res) => {
    try {
        const { id } = req.params;

        const emailLog = await getEmailLogById(id);

        if (!emailLog) {
            return res.status(404).json({
                success: false,
                message: "Email log not found",
            });
        }

        // Generate presigned URLs for attachments
        const attachmentsWithUrls = await Promise.all(
            emailLog.attachments.map(async (attachment) => {
                try {
                    const presignedUrl = await generatePresignedUrl(attachment.s3Key, 3600); // 1 hour expiry
                    return {
                        ...attachment,
                        downloadUrl: presignedUrl,
                    };
                } catch (error) {
                    console.error(`Error generating presigned URL for ${attachment.s3Key}:`, error);
                    return attachment;
                }
            })
        );

        res.json({
            success: true,
            data: {
                ...emailLog,
                attachments: attachmentsWithUrls,
            },
        });
    } catch (error) {
        console.error("Error fetching email log:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching email log",
            error: error.message,
        });
    }
};

// Get email statistics
exports.getEmailStats = async (req, res) => {
    try {
        const filters = {
            fromDate: req.query.fromDate,
            toDate: req.query.toDate,
        };

        const stats = await getEmailStats(filters);

        res.json({
            success: true,
            data: stats,
        });
    } catch (error) {
        console.error("Error fetching email stats:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching email stats",
            error: error.message,
        });
    }
};

// Download email attachment
exports.downloadAttachment = async (req, res) => {
    try {
        const { id, attachmentIndex } = req.params;

        const emailLog = await getEmailLogById(id);

        if (!emailLog) {
            return res.status(404).json({
                success: false,
                message: "Email log not found",
            });
        }

        const attachment = emailLog.attachments[parseInt(attachmentIndex)];

        if (!attachment) {
            return res.status(404).json({
                success: false,
                message: "Attachment not found",
            });
        }

        // Generate presigned URL for download
        const downloadUrl = await generatePresignedUrl(attachment.s3Key, 300); // 5 minutes

        res.json({
            success: true,
            data: {
                filename: attachment.filename,
                downloadUrl,
            },
        });
    } catch (error) {
        console.error("Error generating download URL:", error);
        res.status(500).json({
            success: false,
            message: "Error generating download URL",
            error: error.message,
        });
    }
};

module.exports = exports;