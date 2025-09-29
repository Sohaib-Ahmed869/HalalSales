const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Contact sub-schema
const ContactSchema = new Schema({
    id: String,
    contact_id: String,
    identifier: String,
    name: String,
    channel_id: String,
    url: String,
}, { _id: false });

// Message Content sub-schema
const ContentSchema = new Schema({
    body: String,        // For text/SMS messages
    subject: String,     // For email messages
    text: String,        // For email text content
    html: String,        // For email HTML content
    type: {
        type: String,
        enum: ["text", "email", "sms", "call", "other"],
        required: true,
    },
    files: {
        type: [Schema.Types.Mixed],
        default: [],
    },
}, { _id: false });

// Main Message sub-schema
const MessageSchema = new Schema({
    id: {
        type: String,
        required: true,
    },
    status: {
        type: String,
        enum: ["sent", "received", "delivered", "failed", "pending"],
        required: true,
    },
    conversation_id: {
        type: String,
        required: true,
        index: true,
    },
    in_reply_to: String,
    content: {
        type: ContentSchema,
        required: true,
    },
    to: Schema.Types.Mixed,  // Can be Object or Array
    from: {
        type: ContactSchema,
        required: true,
    },
    created_at: {
        type: Date,
        required: true,
    },
    updated_at: {
        type: Date,
        required: true,
    },
    direction: {
        type: String,
        enum: ["inbound", "outbound"],
        required: true,
    },
    url: String,
}, { _id: false });

// Main MessageEvent Schema
const MessageEventSchema = new Schema({
    id: {
        type: String,
        required: true,
        unique: false,
        index: true,
    },
    message: {
        type: MessageSchema,
        required: true,
    },
    event: {
        type: String,
        enum: ["message_inbound", "message_outbound", "message_delivered", "message_failed"],
        required: true,
        index: true,
    },
    // Additional tracking fields
    processedAt: {
        type: Date,
        default: Date.now,
    },
    source: {
        type: String,
        default: "make",
    },
}, {
    timestamps: true,
});

// Compound indexes for common queries
MessageEventSchema.index({ "message.conversation_id": 1, "message.created_at": -1 });
MessageEventSchema.index({ "message.direction": 1, "message.status": 1 });
MessageEventSchema.index({ "message.from.identifier": 1 });
MessageEventSchema.index({ event: 1, processedAt: -1 });

// Text search index
MessageEventSchema.index({
    "message.content.body": "text",
    "message.content.subject": "text",
    "message.content.text": "text",
    "message.from.name": "text",
    "message.from.identifier": "text",
});

// Virtual for message type
MessageEventSchema.virtual("messageType").get(function () {
    return this.message?.content?.type || "unknown";
});

// Method to check if message is email
MessageEventSchema.methods.isEmail = function () {
    return this.message?.content?.type === "email";
};

// Method to check if message is SMS/text
MessageEventSchema.methods.isText = function () {
    return this.message?.content?.type === "text";
};

// Static method to find by conversation
MessageEventSchema.statics.findByConversation = function (conversationId) {
    return this.find({ "message.conversation_id": conversationId })
        .sort({ "message.created_at": -1 });
};

// Static method to find by contact identifier
MessageEventSchema.statics.findByContact = function (identifier) {
    return this.find({
        $or: [
            { "message.from.identifier": identifier },
            { "message.to.identifier": identifier },
            { "message.to.0.identifier": identifier },
        ],
    }).sort({ "message.created_at": -1 });
};

const MessageEvent = mongoose.model("inbound_messages", MessageEventSchema);
module.exports = MessageEvent;