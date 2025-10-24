// utils/emailLogger.js
const EmailLog = require("../models/EmailLog");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const { s3Client, generateS3Key } = require("../config/s3");
const { v4: uuidv4 } = require("uuid");

/**
 * Log an email with attachments to database and S3
 * @param {Object} emailData - Email data to log
 * @returns {Promise<Object>} - Saved email log
 */
const logEmail = async (emailData) => {
    try {
        const {
            to,
            cc,
            bcc,
            subject,
            text,
            html,
            attachments = [],
            emailType = "general",
            relatedInvoice = null,
            relatedCustomer = null,
            customerCardCode = null,
            status = "sent",
            error = null,
            messageId = null,
            sentBy = null,
            sentByName = null,
            metadata = {},
        } = emailData;

        // Upload attachments to S3
        const uploadedAttachments = [];

        for (const attachment of attachments) {
            try {
                // Generate unique S3 key for email attachment
                const timestamp = Date.now();
                const uuid = uuidv4();
                const s3Key = `email-logs/${emailType}/${timestamp}-${uuid}-${attachment.filename}`;

                // Prepare attachment buffer
                let attachmentBuffer;
                if (Buffer.isBuffer(attachment.content)) {
                    attachmentBuffer = attachment.content;
                } else if (typeof attachment.content === "string") {
                    attachmentBuffer = Buffer.from(attachment.content, "base64");
                } else {
                    console.warn(`Skipping attachment ${attachment.filename}: invalid content type`);
                    continue;
                }

                // Upload to S3
                const uploadParams = {
                    Bucket: process.env.S3_BUCKET || "halalfoodattachments",
                    Key: s3Key,
                    Body: attachmentBuffer,
                    ContentType: attachment.contentType || "application/octet-stream",
                    Metadata: {
                        emailType: emailType,
                        originalFilename: attachment.filename,
                        uploadedAt: new Date().toISOString(),
                    },
                };

                const command = new PutObjectCommand(uploadParams);
                await s3Client.send(command);

                const s3Url = `https://${process.env.S3_BUCKET || "halalfoodattachments"}.s3.${process.env.AWS_REGION || "eu-north-1"
                    }.amazonaws.com/${s3Key}`;

                uploadedAttachments.push({
                    filename: attachment.filename,
                    originalName: attachment.filename,
                    contentType: attachment.contentType || "application/octet-stream",
                    size: attachmentBuffer.length,
                    s3Key: s3Key,
                    s3Url: s3Url,
                });

                console.log(`✓ Uploaded attachment to S3: ${s3Key}`);
            } catch (uploadError) {
                console.error(`Error uploading attachment ${attachment.filename} to S3:`, uploadError);
                // Continue with other attachments even if one fails
            }
        }

        // Create email log entry
        const emailLog = new EmailLog({
            to: Array.isArray(to) ? to : [to],
            cc: cc ? (Array.isArray(cc) ? cc : [cc]) : [],
            bcc: bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : [],
            subject,
            body: text || "",
            htmlBody: html || "",
            emailType,
            relatedInvoice,
            relatedCustomer,
            customerCardCode,
            attachments: uploadedAttachments,
            status,
            error,
            messageId,
            sentBy,
            sentByName,
            metadata,
            sentAt: new Date(),
        });

        await emailLog.save();

        console.log(`✓ Email log saved: ${emailLog._id}`);

        return emailLog;
    } catch (error) {
        console.error("Error logging email:", error);
        // Don't throw error - we don't want email logging to break email sending
        return null;
    }
};

/**
 * Get email logs with filters
 * @param {Object} filters - Filter criteria
 * @returns {Promise<Array>} - Email logs
 */
const getEmailLogs = async (filters = {}) => {
    try {
        const {
            emailType,
            status,
            customerCardCode,
            relatedInvoice,
            relatedCustomer,
            fromDate,
            toDate,
            page = 1,
            limit = 50,
        } = filters;

        const query = {};

        if (emailType) query.emailType = emailType;
        if (status) query.status = status;
        if (customerCardCode) query.customerCardCode = customerCardCode;
        if (relatedInvoice) query.relatedInvoice = relatedInvoice;
        if (relatedCustomer) query.relatedCustomer = relatedCustomer;

        if (fromDate || toDate) {
            query.sentAt = {};
            if (fromDate) query.sentAt.$gte = new Date(fromDate);
            if (toDate) query.sentAt.$lte = new Date(toDate);
        }

        const skip = (page - 1) * limit;

        const [logs, total] = await Promise.all([
            EmailLog.find(query)
                .populate("relatedInvoice", "DocNum CardCode CardName")
                .populate("relatedCustomer", "CardCode CardName")
                .populate("sentBy", "firstName lastName email")
                .sort({ sentAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            EmailLog.countDocuments(query),
        ]);

        return {
            logs,
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit),
            },
        };
    } catch (error) {
        console.error("Error fetching email logs:", error);
        throw error;
    }
};

/**
 * Get email log by ID
 * @param {String} emailLogId - Email log ID
 * @returns {Promise<Object>} - Email log
 */
const getEmailLogById = async (emailLogId) => {
    try {
        const emailLog = await EmailLog.findById(emailLogId)
            .populate("relatedInvoice", "DocNum CardCode CardName DocDate DocTotal")
            .populate("relatedCustomer", "CardCode CardName Email")
            .populate("sentBy", "firstName lastName email")
            .lean();

        return emailLog;
    } catch (error) {
        console.error("Error fetching email log:", error);
        throw error;
    }
};

/**
 * Get email statistics
 * @param {Object} filters - Filter criteria
 * @returns {Promise<Object>} - Email statistics
 */
const getEmailStats = async (filters = {}) => {
    try {
        const { fromDate, toDate } = filters;

        const query = {};
        if (fromDate || toDate) {
            query.sentAt = {};
            if (fromDate) query.sentAt.$gte = new Date(fromDate);
            if (toDate) query.sentAt.$lte = new Date(toDate);
        }

        const [total, byType, byStatus] = await Promise.all([
            EmailLog.countDocuments(query),
            EmailLog.aggregate([
                { $match: query },
                { $group: { _id: "$emailType", count: { $sum: 1 } } },
            ]),
            EmailLog.aggregate([
                { $match: query },
                { $group: { _id: "$status", count: { $sum: 1 } } },
            ]),
        ]);

        return {
            total,
            byType: byType.reduce((acc, item) => {
                acc[item._id] = item.count;
                return acc;
            }, {}),
            byStatus: byStatus.reduce((acc, item) => {
                acc[item._id] = item.count;
                return acc;
            }, {}),
        };
    } catch (error) {
        console.error("Error fetching email stats:", error);
        throw error;
    }
};

module.exports = {
    logEmail,
    getEmailLogs,
    getEmailLogById,
    getEmailStats,
};