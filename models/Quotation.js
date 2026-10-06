const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Read-only view of the `Quotations` collection (written by the quotation
// pages of the portal). Only what the Sales map counts is declared.
const QuotationSchema = new Schema(
  {
    DocEntry: Number,
    DocNum: Number,
    DocDate: Date,
    CardCode: String,
    CardName: String,
    DocTotal: Number,
  },
  { collection: "Quotations", strict: false }
);

module.exports = mongoose.models.Quotation || mongoose.model("Quotation", QuotationSchema);
