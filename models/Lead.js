const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const LeadSchema = new Schema({
  // Basic info
  fullName: {
    type: String,
    required: true,
    trim: true,
  },
  email: {
    type: String,
    trim: true,
  },
  phoneNumber: {
    type: String,
    trim: true,
  },
  company: {
    type: String,
    trim: true,
  },

  // Lead categorization
  status: {
    type: String,
    enum: ["new", "qualified", "converted", "dead"],
    default: "new",
  },
  tags: [
    {
      type: String,
      enum: ["hot", "cold", "warm", "priority", "partner"],
    },
  ],

  // Lead ownership
  assignedTo: {
    type: Schema.Types.ObjectId,
    ref: "User",
  },

  // Lead details
  notes: {
    type: String,
  },

  // Follow-up tasks reference
  tasks: [
    {
      type: Schema.Types.ObjectId,
      ref: "Task",
    },
  ],

  // NEW: Restaurant integration fields
  sourceType: {
    type: String,
    enum: ["manual", "import", "restaurant_scraping", "ai_generated"],
    default: "manual",
  },

  // An existing SAP customer brought back in as a lead (e.g. by the AI
  // WhatsApp agent). Such a lead is never converted — that would create a
  // duplicate account — the agent opens the existing customer instead.
  sapCardCode: {
    type: String,
    trim: true,
    index: true,
  },
  existingCustomer: {
    type: Schema.Types.ObjectId,
    ref: "Customer",
  },

  // What the AI agent hands over with an ai_generated lead.
  aiHandoff: {
    // ready_to_order | callback | complaint | gave_prices | negotiation | question
    // | warm_no_reply | negotiation_no_reply | missed_window | no_price_sheet
    // | reopened | conversation — or, with outcome "closed", business_closed | wrong_number
    reason: String,
    reasonLabel: String,
    outcome: { type: String, enum: ["handoff", "closed"], default: "handoff" },
    priority: { type: String, enum: ["high", "medium", "low"] },
    intent: String,
    complaintTopic: String, // credit_refund | delivery | quality | invoice | service | other
    products: [String],
    silent: Boolean, // the customer was NOT told a colleague would contact them
    salesStage: String,
    campaignId: String,
    campaignName: String,
    priceSheet: [{ _id: false, itemCode: String, name: String, price: Number, orders: Number }],
    account: {
      orderCount: Number,
      lifetimeValue: Number,
      lastOrderDate: Date,
      daysSinceLastOrder: Number,
      segment: String,
      topItems: [String],
    },
    threadId: String, // CustomerThread id in hfs-intelligence
    summary: String,
    conversation: [
      {
        direction: { type: String, enum: ["inbound", "outbound"] },
        text: String,
        at: Date,
        author: String,
      },
    ],
    handedOffAt: Date,
    taskId: { type: Schema.Types.ObjectId, ref: "Task" },
  },
  relatedRestaurant: {
    type: Schema.Types.ObjectId,
    ref: "Restaurant",
  },
  relatedRestaurantAssignment: {
    type: Schema.Types.ObjectId,
    ref: "RestaurantAssignment",
  },
  // The Uber Eats store (ubereats_restaurants.uuid) this lead was made from,
  // when assigned to an agent from the Uber Eats Scraper page.
  relatedUberEatsUuid: {
    type: String,
    index: true,
    sparse: true,
  },
  // One lead per owner (services/ubereats/owners.js): virtual brands cooked in one
  // kitchen by one owner share a lead, so the agent calls that owner once.
  // ownerKey = "siren:<9 digits>" (or "phone:", "email:", "addr:" when the stores
  // have no SIREN); brands = every Uber Eats store on this lead, the one in
  // relatedUberEatsUuid included.
  ownerKey: {
    type: String,
    index: true,
    sparse: true,
  },
  brands: [
    {
      _id: false,
      uuid: { type: String, index: true },
      title: String,
      url: String,
      phone: String,
      email: String,
      postalCode: String,
      address: String,
      registrationNumber: String,
      addedAt: { type: Date, default: Date.now },
    },
  ],
  // A duplicate merged into another lead (scripts/mergeOwnerLeads.js). It is kept,
  // not deleted, for its history, but hidden from every list (models/plugins/hideMergedLeads.js).
  mergedInto: {
    type: Schema.Types.ObjectId,
    ref: "Lead",
  },
  mergedAt: Date,
  // On the lead that was kept: the leads merged into it.
  mergedLeads: [
    {
      _id: false,
      leadId: { type: Schema.Types.ObjectId, ref: "Lead" },
      name: String,
      status: String,
      assignedTo: { type: Schema.Types.ObjectId, ref: "User" },
      mergedAt: Date,
      reason: String,
    },
  ],
  restaurantData: {
    name: String,
    postalCode: String,
    menuItemsCount: Number,
    contactInfo: {
      email: String,
      phone: String,
      address: String,
    },
    url: String,
    // Uber Eats store only: SIRET / SIREN and the registry, from the store's legal info.
    registrationNumber: String,
    registry: String,
  },

  // Timeline tracking
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
  nextFollowUp: {
    type: Date,
  },

  // When the current owner got it (end-of-day lead report, services/leadFollowUp.js).
  assignedAt: Date,
  // Every attempt to reach the lead, logged by the agent. A call nobody
  // answered must come with the next follow-up; a conversation with what was said.
  contactLog: [
    {
      _id: false,
      at: { type: Date, default: Date.now },
      by: { type: Schema.Types.ObjectId, ref: "User" },
      byName: String,
      channel: { type: String, enum: ["call", "whatsapp", "email", "visit"], default: "call" },
      outcome: {
        type: String,
        enum: ["spoke", "no_answer", "voicemail", "busy", "wrong_number", "message_sent"],
        required: true,
      },
      note: String,
      nextFollowUp: Date,
    },
  ],
  lastContactAt: Date,
  lastContactOutcome: String,
});

// Update timestamps before saving
LeadSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

// Merged duplicates stay in the collection but never show up in a list.
LeadSchema.plugin(require("./plugins/hideMergedLeads"));

// Create a text index for searching leads
LeadSchema.index({
  fullName: "text",
  email: "text",
  phoneNumber: "text",
  company: "text",
  notes: "text",
});

const Lead = mongoose.model("Lead", LeadSchema);
module.exports = Lead;