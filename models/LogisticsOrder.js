const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// An open sales order an operator explicitly sent to Logistics from the Bulk
// Order Conversion page ("Move to Logistics"), with the day it is planned to
// go out. The Logistics page plans exactly these orders for a date; it no
// longer pulls every document dated that day.
//
// A snapshot of the order (lines included, for the weight) is kept so the
// plan doesn't depend on the order still being open in SAP when it is routed.
const LogisticsOrderSchema = new Schema({
  tenant: {
    type: String,
    enum: ["halal-food-sales", "pqf", "data-tech", "ms-foods"],
    default: "halal-food-sales",
  },
  DocEntry: { type: Number, required: true }, // the SAP sales order
  DocNum: { type: Number },
  DocDate: { type: Date },
  DocDueDate: { type: Date },
  CardCode: { type: String, required: true },
  CardName: { type: String },
  DocTotal: { type: Number },
  DocumentLines: [
    {
      _id: false,
      ItemCode: String,
      ItemDescription: String,
      Quantity: Number,
    },
  ],
  // Start of the planned delivery day (server-local midnight, the same
  // convention TruckRoute.date uses).
  deliveryDate: { type: Date, required: true, index: true },
  movedBy: { type: Schema.Types.ObjectId, ref: "User" },
  movedAt: { type: Date, default: Date.now },
});

LogisticsOrderSchema.index({ tenant: 1, DocEntry: 1 }, { unique: true });

module.exports = mongoose.model("LogisticsOrder", LogisticsOrderSchema);
