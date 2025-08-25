const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const SuperChatAssignmentSchema = new Schema(
  {
    chat: { type: Schema.Types.ObjectId, ref: "SuperChat", required: true, index: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    assignedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    assignedAt: { type: Date, default: Date.now },
    unassignedAt: { type: Date },
    active: { type: Boolean, default: true, index: true },
    notes: { type: String },

    // performance metrics snapshot
    metrics: {
      messagesHandled: { type: Number, default: 0 },
      firstResponseMinutes: { type: Number },
      resolutionMinutes: { type: Number },
      customerSatisfaction: { type: Number, min: 1, max: 5 },
    },
  },
  {
    timestamps: true,
    collection: "SuperChatAssignments",
  }
);

SuperChatAssignmentSchema.index({ assignedTo: 1, active: 1 });

module.exports = mongoose.model("SuperChatAssignment", SuperChatAssignmentSchema);


