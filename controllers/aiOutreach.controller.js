// controllers/aiOutreach.controller.js
//
// The AI WhatsApp outreach (hfs-intelligence), worked from HalalSales:
//
//   - a lead's AI conversation — every message, the stage, why it was handed
//     over, the prices sent, the agent's decisions — and taking it over or
//     handing it back;
//   - outreach batches — preview who would be contacted, strike accounts off,
//     launch, follow each account to its outcome, stop.
//
// Agents see conversations for their own leads (and customers) only. Batches,
// any conversation by thread, and assigning an account are for admins and
// sales managers.

const Lead = require("../models/Lead");
const Customer = require("../models/Customer");
const User = require("../models/User");
const intelligence = require("../services/intelligenceClient");

const MANAGERS = ["admin", "sales_manager"];

const fail = (res, err) => {
  const status = err.status || 500;
  if (status >= 500) console.error("[ai-outreach]", err.message);
  res.status(status).json({ success: false, message: err.message });
};

const leadFor = async (req) => {
  const query = { _id: req.params.leadId };
  if (req.user.role === "sales_agent") query.assignedTo = req.user._id;
  return Lead.findOne(query).select("fullName company phoneNumber sapCardCode aiHandoff assignedTo sourceType").lean();
};

/** The AI conversation behind a lead (by thread id, else SAP code, else phone). */
exports.getLeadConversation = async (req, res) => {
  try {
    const lead = await leadFor(req);
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
    if (!intelligence.configured()) {
      return res.status(503).json({ success: false, message: "AI outreach is not configured on this server" });
    }
    const data = await intelligence.lookupThread(
      { threadId: lead.aiHandoff?.threadId, cardCode: lead.sapCardCode, phone: lead.phoneNumber },
      req.user
    );
    res.json({ success: true, data });
  } catch (err) {
    if (err.status === 404) return res.json({ success: true, data: null });
    fail(res, err);
  }
};

const threadAction = (fn) => async (req, res) => {
  try {
    const lead = await leadFor(req);
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
    const found = await intelligence.lookupThread(
      { threadId: lead.aiHandoff?.threadId, cardCode: lead.sapCardCode, phone: lead.phoneNumber },
      req.user
    );
    const data = await fn(found.thread.id, req.user);
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
};

exports.takeoverLeadConversation = threadAction(intelligence.takeover);
exports.resumeLeadConversation = threadAction(intelligence.resume);

/* ── Any outreach conversation, by thread (managers) ─────────────────── */

/** The AI conversation behind a batch row, whether or not it became a lead. */
exports.getThreadConversation = async (req, res) => {
  try {
    const data = await intelligence.lookupThread({ threadId: req.params.threadId }, req.user);
    res.json({ success: true, data });
  } catch (err) {
    if (err.status === 404) return res.json({ success: true, data: null });
    fail(res, err);
  }
};

const byThread = (fn) => async (req, res) => {
  try {
    res.json({ success: true, data: await fn(req.params.threadId, req.user) });
  } catch (err) {
    fail(res, err);
  }
};

exports.takeoverThread = byThread(intelligence.takeover);
exports.resumeThread = byThread(intelligence.resume);

/**
 * Put an outreach account in an agent's hands, replied or not, with a note:
 * an AI lead assigned to them, a call task due now, a notification.
 */
exports.assignAccount = async (req, res) => {
  try {
    const { cardCode, threadId, agentId, note } = req.body || {};
    if (!cardCode || !agentId) return res.status(400).json({ success: false, message: "cardCode and agentId are required" });
    const { assignAiAccount } = require("./lead2.controller");
    const data = await assignAiAccount({ cardCode: String(cardCode), threadId, agentId, note, user: req.user });
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
};

/* ── A customer's AI conversations (customer page) ───────────────────── */

/**
 * The AI WhatsApp conversation with a customer, live from hfs-intelligence;
 * when it cannot be reached, the copies stored with the AI leads. Agents see
 * their own customers (or customers whose AI lead is theirs) only.
 */
exports.getCustomerConversation = async (req, res) => {
  try {
    const { cardCode } = req.params;
    const customer = await Customer.findOne({ CardCode: cardCode }).select("_id assignedTo phoneNumber").lean();
    if (!customer) return res.status(404).json({ success: false, message: "Customer not found" });
    const leads = await Lead.find({ sapCardCode: cardCode, sourceType: "ai_generated" })
      .select("fullName company status assignedTo aiHandoff createdAt")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
    if (req.user.role === "sales_agent") {
      const mine = (id) => id && String(id) === String(req.user._id);
      if (!mine(customer.assignedTo) && !leads.some((l) => mine(l.assignedTo))) {
        return res.status(403).json({ success: false, message: "You can only see your own customers' conversations" });
      }
    }
    const stored = leads.map((l) => ({
      leadId: l._id,
      status: l.status,
      createdAt: l.createdAt,
      handoff: l.aiHandoff ? { ...l.aiHandoff, conversation: undefined } : null,
      messages: (l.aiHandoff?.conversation || []).map((m, i) => ({
        id: `${l._id}-${i}`,
        direction: m.direction,
        by: m.direction === "inbound" ? "customer" : m.author === "human" ? "agent" : "ai",
        text: m.text,
        at: m.at,
      })),
    }));

    let live = null;
    let liveError = null;
    if (intelligence.configured()) {
      try {
        live = await intelligence.lookupThread({ cardCode }, req.user);
      } catch (err) {
        if (err.status !== 404) liveError = err.message;
      }
    } else {
      liveError = "AI outreach is not configured on this server";
    }
    res.json({ success: true, data: { live, stored, liveError } });
  } catch (err) {
    fail(res, err);
  }
};

/* ── Batches ─────────────────────────────────────────────────────────── */

exports.overview = async (req, res) => {
  try {
    res.json({ success: true, data: await intelligence.overview(req.user) });
  } catch (err) {
    fail(res, err);
  }
};

exports.batchOptions = async (req, res) => {
  try {
    res.json({ success: true, data: await intelligence.batchOptions(req.user) });
  } catch (err) {
    fail(res, err);
  }
};

exports.listBatches = async (req, res) => {
  try {
    const data = await intelligence.listBatches(req.user);
    res.json({ success: true, data: data.items || [] });
  } catch (err) {
    fail(res, err);
  }
};

/**
 * Who owns each account, so the reviewer sees which agent will pick up the
 * replies (and spots accounts nobody owns).
 */
const withOwners = async (rows, codeKey = "cardCode") => {
  const codes = [...new Set(rows.map((r) => r[codeKey]).filter(Boolean))];
  if (!codes.length) return rows;
  const [customers, leads] = await Promise.all([
    Customer.find({ CardCode: { $in: codes } }).select("CardCode assignedTo").lean(),
    // The open AI lead on each account, so a row shows who is following it up.
    Lead.find({ sapCardCode: { $in: codes }, sourceType: "ai_generated", status: { $nin: ["converted", "dead"] } })
      .select("sapCardCode assignedTo")
      .sort({ createdAt: 1 })
      .lean(),
  ]);
  const ownerIds = [...new Set([...customers, ...leads].map((c) => String(c.assignedTo || "")).filter(Boolean))];
  const users = await User.find({ _id: { $in: ownerIds } }).select("firstName lastName").lean();
  const nameOf = new Map(users.map((u) => [String(u._id), `${u.firstName || ""} ${u.lastName || ""}`.trim()]));
  const customerOf = new Map(customers.map((c) => [c.CardCode, c]));
  const leadOf = new Map(leads.map((l) => [l.sapCardCode, l]));
  return rows.map((r) => {
    const c = customerOf.get(r[codeKey]);
    const l = leadOf.get(r[codeKey]);
    return {
      ...r,
      owner: c?.assignedTo ? nameOf.get(String(c.assignedTo)) || null : null,
      customerId: c?._id || null,
      assignedTo: c?.assignedTo || null,
      aiLead: l ? { id: l._id, assignedTo: l.assignedTo || null, agent: l.assignedTo ? nameOf.get(String(l.assignedTo)) || null : null } : null,
    };
  });
};

exports.previewBatch = async (req, res) => {
  try {
    const data = await intelligence.previewBatch(req.body || {}, req.user);
    data.picked = await withOwners(data.picked || []);
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
};

exports.createBatch = async (req, res) => {
  try {
    res.json({ success: true, data: await intelligence.createBatch(req.body || {}, req.user) });
  } catch (err) {
    fail(res, err);
  }
};

exports.batchReport = async (req, res) => {
  try {
    const data = await intelligence.batchReport(req.params.id, req.user);
    data.rows = await withOwners(data.rows || []);
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
};

exports.stopBatch = async (req, res) => {
  try {
    res.json({ success: true, data: await intelligence.stopBatch(req.params.id, req.user) });
  } catch (err) {
    fail(res, err);
  }
};

/* ── The catalogue to the new Uber Eats prospects ────────────────────── */

const pass = (fn) => async (req, res) => {
  try {
    res.json({ success: true, data: await fn(req) });
  } catch (err) {
    fail(res, err);
  }
};

exports.listCatalogue = pass((req) => intelligence.listCatalogue(req.user));
exports.previewCatalogue = pass((req) => intelligence.previewCatalogue(req.body || {}, req.user));
exports.createCatalogue = pass((req) => intelligence.createCatalogue(req.body || {}, req.user));
exports.stopCatalogue = pass((req) => intelligence.stopCatalogue(req.params.id, req.user));

/** Which agent covers each prospect's postcode (the Uber Eats Scraper's postal-code assignment). */
exports.catalogueReport = async (req, res) => {
  try {
    const data = await intelligence.catalogueReport(req.params.id, req.user);
    const agents = await User.find({ role: { $in: ["sales_agent", "sales_manager"] }, deactivated: { $ne: true }, assignedPostalCodes: { $exists: true, $ne: [] } })
      .select("firstName lastName assignedPostalCodes")
      .lean();
    const byCode = new Map();
    for (const a of agents) for (const code of a.assignedPostalCodes || []) if (!byCode.has(code)) byCode.set(code, `${a.firstName || ""} ${a.lastName || ""}`.trim());
    data.rows = (data.rows || []).map((r) => ({ ...r, owner: byCode.get(r.postalCode) || null }));
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err);
  }
};

exports.MANAGERS = MANAGERS;
