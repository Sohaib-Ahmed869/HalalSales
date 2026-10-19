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
// Agents see conversations for their own leads only. Batches are for admins
// and sales managers.

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
  const customers = await Customer.find({ CardCode: { $in: codes } }).select("CardCode assignedTo").lean();
  const ownerIds = [...new Set(customers.map((c) => String(c.assignedTo || "")).filter(Boolean))];
  const users = await User.find({ _id: { $in: ownerIds } }).select("firstName lastName").lean();
  const nameOf = new Map(users.map((u) => [String(u._id), `${u.firstName || ""} ${u.lastName || ""}`.trim()]));
  const ownerOf = new Map(customers.map((c) => [c.CardCode, c.assignedTo ? nameOf.get(String(c.assignedTo)) || null : null]));
  return rows.map((r) => ({ ...r, owner: ownerOf.get(r[codeKey]) || null }));
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
