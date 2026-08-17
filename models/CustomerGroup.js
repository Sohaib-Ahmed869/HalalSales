const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// One account that belongs to a group. Name and code are denormalised so the
// group still reads correctly after an account is renamed again.
const MemberSchema = new Schema(
  {
    customer: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },
    cardCode: String,
    cardName: String,
    addedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

/**
 * A reviewed decision about a set of customer accounts that look like the same
 * physical shop.
 *
 * `kind` records which decision was made:
 *   shop    - confirmed: these accounts are one shop that has been renamed
 *             and/or re-registered over time.
 *   ignored - reviewed and rejected: genuinely different businesses that happen
 *             to share an address or phone. Suppressed from future suggestions.
 *   hub     - the match key is a shared location (own depot, shopping centre,
 *             business park, accountant's address) so it must never be
 *             suggested as a duplicate at all.
 */
const CustomerGroupSchema = new Schema(
  {
    name: {
      type: String,
      trim: true,
    },
    kind: {
      type: String,
      enum: ["shop", "ignored", "hub"],
      default: "shop",
      index: true,
    },
    // What originally brought these records together.
    matchType: {
      type: String,
      enum: ["address", "phone", "manual"],
      default: "address",
    },
    // Normalised "<street>|<zip>" or 9-digit phone key. For `hub` records this
    // is the only field that matters.
    matchKey: {
      type: String,
      index: true,
    },
    members: [MemberSchema],
    // The account treated as the current/canonical one for the shop.
    primaryCustomer: {
      type: Schema.Types.ObjectId,
      ref: "Customer",
    },
    coordinates: {
      lat: Number,
      lng: Number,
    },
    address: {
      street: String,
      zipCode: String,
      city: String,
    },
    notes: String,
    reviewedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    reviewedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

CustomerGroupSchema.index({ kind: 1, matchKey: 1 });
CustomerGroupSchema.index({ "members.customer": 1 });

/**
 * Ids of every account in the group, as strings, sorted — used to tell whether
 * a freshly detected candidate is the same set that was reviewed before.
 */
CustomerGroupSchema.methods.memberIdSet = function memberIdSet() {
  return new Set((this.members || []).map((m) => String(m.customer)));
};

module.exports = mongoose.model("CustomerGroup", CustomerGroupSchema);
