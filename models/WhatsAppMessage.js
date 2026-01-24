const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const whatsappMessageSchema = new mongoose.Schema(
    {
        messageId: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },
        conversationId: {
            type: String,
            index: true,
        },
        from: {
            type: String,
            required: true,
            index: true,
        },
        to: {
            type: String,
            required: true,
        },
        direction: {
            type: String,
            enum: ["inbound", "outbound"],
            required: true,
        },
        messageType: {
            type: String,
            enum: ["text", "image", "video", "audio", "document", "location", "contacts", "interactive", "template", "reaction", "sticker"],
            required: true,
        },
        content: {
            text: String,
            caption: String,
            mediaUrl: String,
            mediaId: String,
            mimeType: String,
            filename: String,
            latitude: Number,
            longitude: Number,
            locationName: String,
            locationAddress: String,
            contacts: [Object],
            interactive: Object,
            template: Object,
            reaction: Object,
            stickerUrl: String,
        },
        status: {
            type: String,
            enum: ["sent", "delivered", "read", "failed", "pending"],
            default: "pending",
        },
        timestamp: {
            type: Date,
            default: Date.now,
            index: true,
        },
        statusUpdates: [
            {
                status: String,
                timestamp: Date,
                errorCode: String,
                errorMessage: String,
            },
        ],
        metadata: {
            profileName: String,
            waId: String,
            isForwarded: Boolean,
            isFrequentlyForwarded: Boolean,
            context: {
                messageId: String,
                from: String,
            },
        },
        error: {
            code: String,
            message: String,
            details: Object,
        },
        salesAgent: {
            type: Schema.Types.ObjectId,
            ref: "User",
            index: true,
        },
        salesAgentPhone: {
            type: String,
            index: true,
        },
        contactInfo: {
            name: String,
            company: String,
            notes: String,
            tags: [String],
            isCustomer: Boolean,
            customerId: String,
        },
    },
    {
        timestamps: true,
    }
);

// Index for quick conversation retrieval
whatsappMessageSchema.index({ from: 1, timestamp: -1 });
whatsappMessageSchema.index({ to: 1, timestamp: -1 });
whatsappMessageSchema.index({ conversationId: 1, timestamp: 1 });

module.exports = mongoose.model("WhatsAppMessage", whatsappMessageSchema);