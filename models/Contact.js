const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Handle sub-schema for contact information (email, phone, etc.)
const HandleSchema = new Schema({
    id: {
        type: String,
        required: true,
    },
    type: {
        type: String,
        enum: ["mail", "phone", "mobile", "sms", "whatsapp", "other"],
        required: true,
    },
    value: {
        type: String,
        required: true,
    },
}, { _id: false });

// Custom Attribute sub-schema
const CustomAttributeSchema = new Schema({
    key: String,
    value: Schema.Types.Mixed,
}, { _id: false });

// Main Contact sub-schema
const ContactSchema = new Schema({
    id: {
        type: String,
        required: true,
    },
    first_name: {
        type: String,
        trim: true,
    },
    last_name: {
        type: String,
        trim: true,
    },
    gender: {
        type: String,
        enum: ["male", "female", "other", "unknown"],
    },
    handles: {
        type: [HandleSchema],
        default: [],
    },
    custom_attributes: {
        type: [CustomAttributeSchema],
        default: [],
    },
    url: String,
    created_at: {
        type: Date,
        required: true,
    },
    updated_at: {
        type: Date,
        required: true,
    },
}, { _id: false });

// Main ContactEvent Schema
const ContactEventSchema = new Schema({
    id: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    contact: {
        type: ContactSchema,
        required: true,
    },
    event: {
        type: String,
        enum: [
            "contact_created",
            "contact_updated",
            "contact_deleted",
            "contact_merged",
        ],
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
ContactEventSchema.index({ "contact.id": 1, processedAt: -1 });
ContactEventSchema.index({ event: 1, processedAt: -1 });
ContactEventSchema.index({ "contact.created_at": -1 });
ContactEventSchema.index({ "contact.handles.value": 1 }); // For searching by email/phone

// Text search index
ContactEventSchema.index({
    "contact.first_name": "text",
    "contact.last_name": "text",
    "contact.handles.value": "text",
});

// Virtual for full name
ContactEventSchema.virtual("contact.fullName").get(function () {
    const { first_name, last_name } = this.contact || {};
    return [first_name, last_name].filter(Boolean).join(" ").trim() || "Unknown";
});

// Method to get primary email
ContactEventSchema.methods.getPrimaryEmail = function () {
    return this.contact?.handles?.find(h => h.type === "mail")?.value || null;
};

// Method to get primary phone
ContactEventSchema.methods.getPrimaryPhone = function () {
    const phoneTypes = ["phone", "mobile", "sms", "whatsapp"];
    return this.contact?.handles?.find(h => phoneTypes.includes(h.type))?.value || null;
};

// Method to get all emails
ContactEventSchema.methods.getAllEmails = function () {
    return this.contact?.handles
        ?.filter(h => h.type === "mail")
        .map(h => h.value) || [];
};

// Method to get all phones
ContactEventSchema.methods.getAllPhones = function () {
    const phoneTypes = ["phone", "mobile", "sms", "whatsapp"];
    return this.contact?.handles
        ?.filter(h => phoneTypes.includes(h.type))
        .map(h => h.value) || [];
};

// Static method to find by contact ID
ContactEventSchema.statics.findByContactId = function (contactId) {
    return this.find({ "contact.id": contactId })
        .sort({ processedAt: -1 });
};

// Static method to find by email or phone
ContactEventSchema.statics.findByHandle = function (value) {
    return this.find({ "contact.handles.value": value })
        .sort({ processedAt: -1 });
};

// Static method to find latest contact event by contact ID
ContactEventSchema.statics.findLatestByContactId = function (contactId) {
    return this.findOne({ "contact.id": contactId })
        .sort({ processedAt: -1 });
};

const ContactEvent = mongoose.model("Contact", ContactEventSchema, "Contacts");
module.exports = ContactEvent;