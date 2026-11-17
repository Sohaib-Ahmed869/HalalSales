// models/plugins/hideMergedLeads.js
//
// A lead merged into another one (Lead.mergedInto, scripts/mergeOwnerLeads.js) is
// kept for its history but must not show up anywhere: not on the Leads page, not
// in the counts, not as "already a lead" on the Uber Eats Scraper page or the
// Sales Map. Rather than adding the condition to the ~90 lead queries, every read
// query and aggregation on the `leads` collection gets `mergedInto: null` added.
// Left alone: a query that asks about mergedInto itself, a lookup of one lead by
// its _id (an old link to a merged lead still opens it, showing where it went),
// and any query run with the option { includeMerged: true }.
const READS = ["find", "findOne", "countDocuments", "distinct"];
const ALIVE = { mergedInto: null };

const mentionsMerged = (x) => JSON.stringify(x || {}).includes('"mergedInto"');
const isSingleId = (id) => id != null && (typeof id !== "object" || id._bsontype === "ObjectId" || typeof id.toHexString === "function");

module.exports = function hideMergedLeads(schema) {
  schema.pre(READS, function () {
    const filter = this.getFilter();
    if (this.getOptions().includeMerged || mentionsMerged(filter) || isSingleId(filter._id)) return;
    this.where(ALIVE);
  });
  schema.pre("aggregate", function () {
    if (this.options?.includeMerged) return;
    const pipeline = this.pipeline();
    if (mentionsMerged(pipeline)) return;
    // A leading $match takes the condition itself (a $text match must stay first);
    // $geoNear / $search must stay the first stage.
    if (pipeline[0]?.$match) pipeline[0] = { ...pipeline[0], $match: { ...pipeline[0].$match, ...ALIVE } };
    else pipeline.splice(pipeline[0] && (pipeline[0].$geoNear || pipeline[0].$search) ? 1 : 0, 0, { $match: ALIVE });
  });
};
