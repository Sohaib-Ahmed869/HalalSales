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
        salesAgent: {
            type: Schema.Types.ObjectId,
            ref: "User",
            required: true,
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

// Compound index for unique contact per agent
whatsappContactSchema.index({ phoneNumber: 1, salesAgent: 1 }, { unique: true });

module.exports = mongoose.model("WhatsAppContact", whatsappContactSchema);