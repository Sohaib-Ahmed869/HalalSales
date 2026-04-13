const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const whatsappContactSchema = new Schema(
    {
        phoneNumber: {
            type: String,
            required: true,
            index: true,
        },
        name: {
            type: String,
            required: true,
        },
        company: {
            type: String,
        },
        email: {
            type: String,
        },
        tags: [String],
        notes: String,
        // salesAgent is optional — unassigned contacts are visible to all agents
        // until one of them claims the conversation by replying.
        salesAgent: {
            type: Schema.Types.ObjectId,
            ref: "User",
            default: null,
            index: true,
        },
        isCustomer: {
            type: Boolean,
            default: false,
        },
        customerId: {
            type: String,
        },
        lastMessageAt: {
            type: Date,
        },
        // Timestamp of the last INBOUND message from this contact.
        // Drives the Meta 24h customer-service-window check.
        lastInboundMessageAt: {
            type: Date,
        },
        totalMessages: {
            type: Number,
            default: 0,
        },
        isFavorite: {
            type: Boolean,
            default: false,
        },
        isBlocked: {
            type: Boolean,
            default: false,
        },
        metadata: {
            profilePicUrl: String,
            waId: String,
        },
    },
    {
        timestamps: true,
    }
);

// Unique per (phoneNumber, salesAgent) — unassigned contacts collapse into one doc (salesAgent=null)
whatsappContactSchema.index({ phoneNumber: 1, salesAgent: 1 }, { unique: true });

module.exports = mongoose.model("WhatsAppContact", whatsappContactSchema);
