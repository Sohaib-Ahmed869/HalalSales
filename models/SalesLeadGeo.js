const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Map pin of a lead that was typed by hand or imported (no scraped restaurant
// behind it): its own address is geocoded once and the pin kept here, never
// written into `leads`. `addressKey` is the address the pin was made from, so a
// lead whose address is corrected on the Leads page is located again.
const SalesLeadGeoSchema = new Schema({
  leadId: { type: Schema.Types.ObjectId, required: true, unique: true },
  addressKey: String,
  lat: Number,
  lng: Number,
  status: { type: String, enum: ["ok", "failed"], default: "ok" },
  source: String,
  confidence: String,
  geocodedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.models.SalesLeadGeo || mongoose.model("SalesLeadGeo", SalesLeadGeoSchema);
