const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Read-only view of the `leads` collection of the Leads page (model `Lead` in
// the main backend): the Sales map marks a scraped restaurant that was turned
// into a lead. Only the fields the map reads are declared; nothing here writes.
const SalesLeadSchema = new Schema(
  {
    fullName: String,
    company: String,
    status: String, // new | qualified | converted | dead
    tags: [String],
    sourceType: String,
    relatedRestaurant: Schema.Types.ObjectId, // _id in `restaurants`
    relatedUberEatsUuid: String, // uuid in `ubereats_restaurants` (assigned from the Uber Eats Scraper page)
    assignedTo: Schema.Types.ObjectId,
  },
  { collection: "leads", strict: false }
);

module.exports = mongoose.models.SalesLead || mongoose.model("SalesLead", SalesLeadSchema);
