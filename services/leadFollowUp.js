// Lead follow-up (Idris, 22 Oct meeting):
//  - an AI lead nobody owns goes to an agent automatically;
//  - the agent gets a WhatsApp the moment a lead is theirs ("new lead, follow up");
//  - every call / message is logged on the lead, a call nobody answered must
//    come with the next follow-up, a conversation with what was said;
//  - at the end of the day a report: per agent, what was assigned, what was
//    followed up and what nobody touched.

const cron = require("node-cron");
const Lead = require("../models/Lead");
const User = require("../models/User");
const Task = require("../models/Task");

const TZ = "Europe/Paris";
const NOT_REACHED = ["no_answer", "voicemail", "busy", "message_sent"];
const OUTCOME_LABEL = {
  spoke: "Spoke to them",
  no_answer: "No answer",
  voicemail: "Voicemail",
  busy: "Busy / call back",
  wrong_number: "Wrong number",
  message_sent: "Message sent, no reply yet",
};

const name = (u) => [u?.firstName, u?.lastName].filter(Boolean).join(" ").trim();
const frontendUrl = () => (process.env.FRONTEND_URL || "").replace(/\/$/, "");

/* ── Who gets an AI lead nobody owns ─────────────────────────────── */

/**
 * The agents AI leads are shared between: AI_LEAD_AGENTS (comma-separated
 * emails or user ids) when set, else every active sales agent with a phone
 * (test accounts left out).
 */
async function agentPool() {
  const listed = String(process.env.AI_LEAD_AGENTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const base = { role: "sales_agent", deactivated: { $ne: true } };
  if (listed.length) {
    const ids = listed.filter((s) => /^[a-f0-9]{24}$/i.test(s));
    const emails = listed.filter((s) => s.includes("@")).map((s) => s.toLowerCase());
    return User.find({ ...base, $or: [{ _id: { $in: ids } }, { email: { $in: emails } }] }).select("_id firstName lastName phone").lean();
  }
  const users = await User.find({ ...base, phone: { $nin: [null, ""] } }).select("_id firstName lastName phone").lean();
  return users.filter((u) => !/\btest\b/i.test(name(u)));
}

/** The pool agent with the fewest open AI leads (ties: fewest assigned this week). */
async function pickAgentForAiLead() {
  const pool = await agentPool();
  if (!pool.length) return null;
  const ids = pool.map((u) => u._id);
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const [open, recent] = await Promise.all([
    Lead.aggregate([
      { $match: { sourceType: "ai_generated", status: { $nin: ["converted", "dead"] }, assignedTo: { $in: ids } } },
      { $group: { _id: "$assignedTo", n: { $sum: 1 } } },
    ]),
    Lead.aggregate([
      { $match: { assignedTo: { $in: ids }, assignedAt: { $gte: weekAgo } } },
      { $group: { _id: "$assignedTo", n: { $sum: 1 } } },
    ]),
  ]);
  const count = (rows, id) => rows.find((r) => String(r._id) === String(id))?.n || 0;
  return pool
    .map((u) => ({ u, open: count(open, u._id), recent: count(recent, u._id) }))
    .sort((a, b) => a.open - b.open || a.recent - b.recent)[0].u;
}

/* ── WhatsApp to the agent ───────────────────────────────────────── */

/** "06 12 34 56 78" / "+33 6…" / "0033…" → "336…" (wa_id digits). */
function toWaNumber(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 10 && d.startsWith("0")) d = `33${d.slice(1)}`;
  return d.length >= 10 ? d : null;
}

/**
 * "New lead: <name> — <reason>. Open: <link>". Free text when the agent wrote
 * to the business number in the last 24h, otherwise the approved template
 * LEAD_ALERT_TEMPLATE (Meta only lets a business start a chat with a template).
 */
async function whatsappAgent(agent, lead, { reasonLabel } = {}) {
  const wa = require("./whatsappBusinessApi");
  const to = toWaNumber(agent?.phone);
  if (!to) return { sent: false, reason: "agent has no phone" };
  if (!process.env.WHATSAPP_PHONE_NUMBER_ID || !process.env.WHATSAPP_ACCESS_TOKEN) return { sent: false, reason: "whatsapp not configured" };
  if (process.env.LEAD_ALERT_WHATSAPP === "off") return { sent: false, reason: "disabled" };

  const leadName = lead.company || lead.fullName || "Lead";
  const why = reasonLabel || lead.aiHandoff?.reasonLabel || (lead.sourceType === "ai_generated" ? "AI lead" : "New lead");
  const link = frontendUrl() ? `${frontendUrl()}/leads-management${lead._id ? `?lead=${lead._id}` : ""}` : "";
  const ctx = { aiAgentContext: { source: "lead-alert", leadId: String(lead._id), agentId: String(agent._id) } };
  try {
    if (await wa.isWithinCustomerServiceWindow(`+${to}`)) {
      const text =
        `🔔 Nouveau lead pour vous : *${leadName}*\n${why}` +
        (lead.phoneNumber ? `\nTél : ${lead.phoneNumber}` : "") +
        `\nMerci de le contacter maintenant et de noter l'appel dans HalalSales.` +
        (link ? `\n${link}` : "");
      await wa.sendText({ to, text, ...ctx });
      return { sent: true, kind: "text" };
    }
    const template = process.env.LEAD_ALERT_TEMPLATE;
    if (!template) return { sent: false, reason: "agent outside 24h window and LEAD_ALERT_TEMPLATE not set" };
    // Named parameters: agent_name, lead_name, reason (see docs in services/leadFollowUp.js).
    const param = (parameter_name, text) => ({ type: "text", parameter_name, text: String(text).slice(0, 200) });
    await wa.sendTemplate({
      to,
      templateName: template,
      languageCode: process.env.LEAD_ALERT_TEMPLATE_LANG || "fr",
      components: [{ type: "body", parameters: [param("agent_name", agent.firstName || name(agent)), param("lead_name", leadName), param("reason", why)] }],
      ...ctx,
    });
    return { sent: true, kind: "template" };
  } catch (err) {
    const reason = err?.response?.data?.error?.message || err.message;
    console.warn(`[lead-alert] WhatsApp to ${name(agent)} failed:`, reason);
    return { sent: false, reason };
  }
}

/**
 * A lead (or several) just became an agent's: in-app notification (unless the
 * caller already sent one) and a WhatsApp. Never throws.
 */
async function onAssigned(leads, agentId, { byUserId, reasonLabel, inApp = true } = {}) {
  try {
    const list = (Array.isArray(leads) ? leads : [leads]).filter(Boolean);
    if (!list.length || !agentId) return;
    const agent = await User.findById(agentId).select("_id firstName lastName phone").lean();
    if (!agent) return;
    if (inApp) {
      const NotificationService = require("../utils/notificationService");
      for (const lead of list) {
        await NotificationService.createNotification({
          recipient: agent._id,
          sender: byUserId || agent._id,
          type: "lead_assigned",
          title: `New lead: ${lead.company || lead.fullName}`,
          message: reasonLabel || lead.aiHandoff?.reasonLabel || "Assigned to you. Please contact them and log the call.",
          relatedLead: lead._id,
          allowSelfNotify: true,
        });
      }
    }
    if (list.length === 1) {
      await whatsappAgent(agent, list[0], { reasonLabel });
    } else {
      // A bulk assignment is one message, not twenty.
      await whatsappAgent(agent, { _id: "", company: `${list.length} leads`, sourceType: "bulk" }, { reasonLabel: list.slice(0, 5).map((l) => l.company || l.fullName).join(", ") + (list.length > 5 ? "…" : "") });
    }
  } catch (err) {
    console.warn("[lead-alert] onAssigned failed:", err.message);
  }
}

/* ── Call / message log ──────────────────────────────────────────── */

class LogError extends Error {}

/**
 * Record one attempt on a lead. Rules: a call nobody answered (or a message
 * with no reply) needs `nextFollowUp` in the future; a conversation needs a
 * note saying what was said.
 */
async function logContact(lead, user, { outcome, channel = "call", note, nextFollowUp } = {}) {
  if (!OUTCOME_LABEL[outcome]) throw new LogError("Choose what happened.");
  const text = String(note || "").trim();
  const when = nextFollowUp ? new Date(nextFollowUp) : null;
  if (when && Number.isNaN(when.getTime())) throw new LogError("The follow-up date is not valid.");
  if (NOT_REACHED.includes(outcome) && !(when && when > new Date())) {
    throw new LogError("They were not reached: set when you will try again.");
  }
  if (outcome === "spoke" && text.length < 5) throw new LogError("Write what was said (a line is enough).");

  const at = new Date();
  lead.contactLog = [...(lead.contactLog || []), { at, by: user._id, byName: name(user), channel, outcome, note: text || undefined, nextFollowUp: when || undefined }];
  lead.lastContactAt = at;
  lead.lastContactOutcome = outcome;
  if (when) lead.nextFollowUp = when;
  const stamp = at.toLocaleString("fr-FR", { timeZone: TZ });
  const line = `[${stamp}] ${name(user)} — ${channel}: ${OUTCOME_LABEL[outcome]}${text ? ` — ${text}` : ""}${when ? ` (next: ${when.toLocaleString("fr-FR", { timeZone: TZ })})` : ""}`;
  lead.notes = lead.notes ? `${line}\n\n${lead.notes}` : line;
  await lead.save();

  // Keep the lead's open task in step: done when they were reached, moved to
  // the follow-up time when they were not.
  const openTask = await Task.findOne({ leadId: lead._id, status: { $in: ["pending", "pending_approval"] } }).sort({ dueDate: 1 });
  if (openTask) {
    if (outcome === "spoke" && !when) {
      openTask.status = "completed";
    } else if (when) {
      openTask.dueDate = when;
    }
    await openTask.save().catch((e) => console.warn("[lead-log] task update failed:", e.message));
  } else if (when && lead.assignedTo) {
    await Task.create({
      title: `Follow up: ${lead.company || lead.fullName}`.slice(0, 200),
      description: line,
      leadId: lead._id,
      priority: "medium",
      type: channel === "call" ? "call" : "follow-up",
      dueDate: when,
      assignedTo: lead.assignedTo,
      createdBy: user._id,
    }).catch((e) => console.warn("[lead-log] follow-up task failed:", e.message));
  }
  return lead;
}

/* ── End-of-day report ───────────────────────────────────────────── */

/** Start and end of a Paris calendar day ("YYYY-MM-DD", default today). */
function parisDay(day) {
  const iso = day || new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
  // Offset of Paris from UTC at noon that day (handles summer / winter time).
  const noon = new Date(`${iso}T12:00:00Z`);
  const parisNoon = new Date(noon.toLocaleString("en-US", { timeZone: TZ }));
  const offsetMs = parisNoon.getTime() - new Date(noon.toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  const start = new Date(new Date(`${iso}T00:00:00Z`).getTime() - offsetMs);
  return { iso, start, end: new Date(start.getTime() + 24 * 3600 * 1000) };
}

/**
 * Per agent, for one day: leads assigned that day, follow-ups due that day,
 * which of those were contacted (and reached), and which nobody touched.
 */
async function dailyReport(day) {
  const { iso, start, end } = parisDay(day);
  const open = { status: { $nin: ["converted", "dead"] } };
  const leads = await Lead.find({
    assignedTo: { $exists: true, $ne: null },
    $or: [
      { assignedAt: { $gte: start, $lt: end } },
      { ...open, nextFollowUp: { $lt: end } },
      { "contactLog.at": { $gte: start, $lt: end } },
    ],
  })
    .select("fullName company phoneNumber sourceType status assignedTo assignedAt nextFollowUp contactLog aiHandoff.reasonLabel aiHandoff.priority")
    .populate("assignedTo", "firstName lastName")
    .lean();

  const byAgent = new Map();
  for (const l of leads) {
    const agentKey = String(l.assignedTo?._id || l.assignedTo);
    if (!byAgent.has(agentKey)) {
      byAgent.set(agentKey, { agentId: agentKey, agent: name(l.assignedTo) || "?", assigned: 0, due: 0, contacted: 0, reached: 0, untouched: [], overdue: [], contacts: 0 });
    }
    const a = byAgent.get(agentKey);
    const today = (l.contactLog || []).filter((c) => c.at >= start && c.at < end);
    const assignedToday = l.assignedAt && l.assignedAt >= start && l.assignedAt < end;
    const isOpen = !["converted", "dead"].includes(l.status);
    const dueToday = isOpen && l.nextFollowUp && l.nextFollowUp < end;
    if (assignedToday) a.assigned += 1;
    if (dueToday) a.due += 1;
    a.contacts += today.length;
    if (today.length) a.contacted += 1;
    if (today.some((c) => c.outcome === "spoke")) a.reached += 1;
    const row = {
      leadId: String(l._id),
      name: l.company || l.fullName,
      phone: l.phoneNumber,
      ai: l.sourceType === "ai_generated",
      reason: l.aiHandoff?.reasonLabel,
      assignedAt: l.assignedAt,
      nextFollowUp: l.nextFollowUp,
      lastOutcome: (l.contactLog || []).slice(-1)[0]?.outcome || null,
    };
    if ((assignedToday || dueToday) && !today.length) a.untouched.push(row);
    // Still open and its follow-up time has passed without a newer attempt.
    const lastAt = (l.contactLog || []).slice(-1)[0]?.at;
    if (dueToday && l.nextFollowUp < new Date() && (!lastAt || lastAt < l.nextFollowUp)) a.overdue.push(row);
  }
  const agents = [...byAgent.values()].sort((x, y) => y.untouched.length - x.untouched.length || x.agent.localeCompare(y.agent));
  const totals = agents.reduce(
    (t, a) => ({ assigned: t.assigned + a.assigned, due: t.due + a.due, contacted: t.contacted + a.contacted, reached: t.reached + a.reached, untouched: t.untouched + a.untouched.length }),
    { assigned: 0, due: 0, contacted: 0, reached: 0, untouched: 0 }
  );
  return { day: iso, generatedAt: new Date(), totals, agents };
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function reportHtml(r) {
  const link = (id) => (frontendUrl() ? `${frontendUrl()}/leads-management?lead=${id}` : null);
  const rows = r.agents
    .map(
      (a) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee"><b>${esc(a.agent)}</b></td>
<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${a.assigned}</td>
<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${a.due}</td>
<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${a.contacted}</td>
<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${a.reached}</td>
<td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:${a.untouched.length ? "#b91c1c" : "#334155"}"><b>${a.untouched.length}</b></td></tr>`
    )
    .join("");
  const untouched = r.agents
    .filter((a) => a.untouched.length)
    .map(
      (a) =>
        `<h3 style="margin:18px 0 6px;font-size:14px">${esc(a.agent)}: not contacted (${a.untouched.length})</h3><ul style="margin:0;padding-left:18px">` +
        a.untouched
          .map((l) => {
            const href = link(l.leadId);
            const label = `${esc(l.name)}${l.ai ? " (AI)" : ""}${l.reason ? ` — ${esc(l.reason)}` : ""}${l.phone ? ` · ${esc(l.phone)}` : ""}`;
            return `<li>${href ? `<a href="${href}">${label}</a>` : label}</li>`;
          })
          .join("") +
        "</ul>"
    )
    .join("");
  return `<div style="font-family:Arial,sans-serif;font-size:13px;color:#0f172a">
<h2 style="font-size:17px">Leads follow-up — ${esc(r.day)}</h2>
<p>${r.totals.assigned} assigned today · ${r.totals.due} follow-ups due or overdue · ${r.totals.contacted} contacted · ${r.totals.reached} reached · <b style="color:${r.totals.untouched ? "#b91c1c" : "#0f172a"}">${r.totals.untouched} not touched</b></p>
<table style="border-collapse:collapse;font-size:13px"><thead><tr style="background:#f1f5f9">
<th style="padding:6px 10px;text-align:left">Agent</th><th style="padding:6px 10px">Assigned</th><th style="padding:6px 10px">Due or overdue</th><th style="padding:6px 10px">Contacted</th><th style="padding:6px 10px">Reached</th><th style="padding:6px 10px">Not touched</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6" style="padding:10px">No leads assigned or due today.</td></tr>'}</tbody></table>
${untouched}
<p style="color:#64748b;font-size:11.5px;margin-top:18px">"Contacted" means a call or message was logged on the lead in HalalSales today; "reached" means the agent spoke to them.</p></div>`;
}

/** Email the report to LEAD_REPORT_EMAILS (else every active admin / sales manager). */
async function sendDailyReport(day) {
  const r = await dailyReport(day);
  if (!r.agents.length) return { sent: false, reason: "nothing to report", report: r };
  let to = String(process.env.LEAD_REPORT_EMAILS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!to.length) {
    to = (await User.find({ role: { $in: ["admin", "sales_manager"] }, deactivated: { $ne: true }, email: { $nin: [null, ""] } }).select("email").lean())
      .map((u) => u.email)
      .filter((e) => !/test/i.test(e));
  }
  if (!to.length) return { sent: false, reason: "no recipients", report: r };
  const { sendEmail } = require("../utils/emailService");
  await sendEmail({
    to: to.join(","),
    subject: `Leads follow-up ${r.day}: ${r.totals.contacted} contacted, ${r.totals.untouched} not touched`,
    html: reportHtml(r),
    text: r.agents.map((a) => `${a.agent}: assigned ${a.assigned}, due ${a.due}, contacted ${a.contacted}, reached ${a.reached}, not touched ${a.untouched.length}`).join("\n"),
    emailType: "lead_daily_report",
  });
  return { sent: true, to, report: r };
}

/* ── Follow-up due: remind the agent (Idris, 18 Nov meeting) ─────── */

// "Call him back in 1 hour" must pop up for the agent in 1 hour. Every few
// minutes, each open follow-up / call task on a lead whose time has come gets
// one in-app notification. Tasks more than REMINDER_LOOKBACK_H overdue are
// left alone, so switching this on does not flood agents with old tasks.
const REMINDER_TYPES = ["follow-up", "call", "restaurant_follow_up"];
const REMINDER_LOOKBACK_H = 12;

async function remindDueFollowUps(now = new Date()) {
  const due = await Task.find({
    type: { $in: REMINDER_TYPES },
    status: { $in: ["pending", "pending_approval"] },
    leadId: { $ne: null },
    dueDate: { $lte: now, $gte: new Date(now.getTime() - REMINDER_LOOKBACK_H * 3600 * 1000) },
    reminderSentAt: null,
  })
    .select("_id title leadId assignedTo createdBy dueDate")
    .limit(500)
    .lean();
  if (!due.length) return 0;

  const NotificationService = require("../utils/notificationService");
  const leads = await Lead.find({ _id: { $in: due.map((t) => t.leadId) } })
    .select("_id company fullName phoneNumber lastContactOutcome")
    .lean();
  const byId = new Map(leads.map((l) => [String(l._id), l]));

  let sent = 0;
  for (const t of due) {
    // Claim the task first: with several server processes only one reminds.
    const claimed = await Task.updateOne({ _id: t._id, reminderSentAt: null }, { $set: { reminderSentAt: now } });
    if (!claimed.modifiedCount) continue;
    const lead = byId.get(String(t.leadId));
    const who = lead?.company || lead?.fullName || t.title;
    const last = lead?.lastContactOutcome ? ` Last attempt: ${OUTCOME_LABEL[lead.lastContactOutcome] || lead.lastContactOutcome}.` : "";
    try {
      await NotificationService.createNotification({
        recipient: t.assignedTo,
        sender: t.createdBy || t.assignedTo,
        type: "follow_up_due",
        title: `Follow-up due: ${who}`,
        message: `Time to contact them again${lead?.phoneNumber ? ` (${lead.phoneNumber})` : ""}.${last} Log the call on the lead when done.`,
        relatedTask: t._id,
        relatedLead: t.leadId,
        allowSelfNotify: true,
      });
      sent++;
    } catch (err) {
      // Let the next run try again.
      await Task.updateOne({ _id: t._id }, { $set: { reminderSentAt: null } }).catch(() => {});
      console.warn("[lead-reminder] notification failed:", err.message);
    }
  }
  return sent;
}

let reminderJob = null;
function startReminderCron() {
  const expr = process.env.LEAD_REMINDER_CRON || "*/5 * * * *";
  if (expr === "off" || reminderJob) return;
  if (!cron.validate(expr)) {
    console.warn(`[lead-reminder] LEAD_REMINDER_CRON "${expr}" is not valid; follow-up reminders are off`);
    return;
  }
  reminderJob = cron.schedule(
    expr,
    () =>
      remindDueFollowUps()
        .then((n) => n && console.log(`[lead-reminder] ${n} follow-up reminder(s) sent`))
        .catch((e) => console.error("[lead-reminder] failed:", e.message)),
    { timezone: TZ }
  );
}

let job = null;
function startCron() {
  startReminderCron();
  const expr = process.env.LEAD_REPORT_CRON || "30 18 * * 1-6";
  if (expr === "off" || job) return;
  if (!cron.validate(expr)) {
    console.warn(`[lead-report] LEAD_REPORT_CRON "${expr}" is not valid; end-of-day lead report is off`);
    return;
  }
  job = cron.schedule(
    expr,
    () =>
      sendDailyReport()
        .then((r) => console.log(`[lead-report] ${r.sent ? `sent to ${r.to.length}` : `not sent (${r.reason})`}`))
        .catch((e) => console.error("[lead-report] failed:", e.message)),
    { timezone: TZ }
  );
}

module.exports = {
  pickAgentForAiLead,
  agentPool,
  onAssigned,
  whatsappAgent,
  toWaNumber,
  logContact,
  LogError,
  OUTCOME_LABEL,
  dailyReport,
  sendDailyReport,
  reportHtml,
  parisDay,
  remindDueFollowUps,
  startCron,
};
