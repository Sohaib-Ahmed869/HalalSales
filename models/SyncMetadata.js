const mongoose = require("mongoose");

const syncMetadataSchema = new mongoose.Schema({
    syncType: {
        type: String,
        required: true,
        unique: true,
        enum: ["invoice_status_sync"]
    },
    lastSyncDate: {
        type: Date,
        required: true
    },
    lastSyncStatus: {
        type: String,
        enum: ["success", "failed", "in_progress"],
        default: "success"
    },
    lastSyncStats: {
        type: Object,
        default: {}
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

module.exports = mongoose.model("SyncMetadata", syncMetadataSchema);