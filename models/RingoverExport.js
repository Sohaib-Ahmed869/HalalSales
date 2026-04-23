const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const RingoverExportSchema = new Schema({
  batchId: {
    type: String,
    required: true,
    index: true,
    unique: true,
  },
  exportedBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
    nullable: true,
  },
  exportedAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  files: [
    {
      s3Key: String,
      s3Url: String,
      fileName: String,
      fileSize: Number,
      type: {
        type: String,
        enum: ["test", "export"],
        default: "export",
      },
      recordCount: Number,
      fileIndex: Number,
      totalFiles: Number,
    },
  ],
  summary: {
    totalExported: Number,
    totalContacts: Number,
    fileCount: Number,
    includesTestData: Boolean,
    executionTimeMs: Number,
  },
  errors: [String],
  status: {
    type: String,
    enum: ["success", "partial", "failed"],
    default: "success",
  },
});

RingoverExportSchema.index({ exportedAt: -1 }); // Most recent first
RingoverExportSchema.index({ status: 1 }); // Filter by status

module.exports = mongoose.model("RingoverExport", RingoverExportSchema);
