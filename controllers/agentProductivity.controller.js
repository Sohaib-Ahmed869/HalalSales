// controllers/agentProductivity.controller.js
//
// Agent productivity v1 (delivery plan #14): per agent, per day and for the
// whole range — DeskTime time at the desk, orders and invoiced sales, calls,
// leads called and follow-ups, plus two ratios per productive hour.
//
// Where each figure comes from (checked on live data, 17 Nov 2026):
//  - DeskTime   desktimes, matched on the user's email. Filled by the Excel
//               upload (/api/desktime/upload*) — last upload covers up to
//               18 Mar 2026. The daily API job stores "Yes"/"No" in
//               arrived/left instead of a clock time, so arrival/leave times
//               only exist for uploaded days.
//  - Orders     SalesOrders.salesAgent (orders placed in the app), as the
//               admin dashboard counts them; cancelled orders left out.
//  - Invoiced   SAP invoices have no salesAgent: attributed to the agent the
//               customer is assigned to (Customer.assignedTo), net of VAT and
//               of credit notes — same rule as the dashboard's team table.
//  - Calls      Ringover calls (calldatas), matched on the Ringover user name
//               (no user id link exists). The Ringover sync is switched off:
//               the last call stored is from 25 May 2026.
//  - Leads called  the lead call log (Lead.contactLog, channel "call"), only
//               in use since the end of Oct 2026.
//  - Follow-ups Tasks of type follow-up / call / restaurant_follow_up whose
//               due date falls in the day; "done" = completed.
//
// A figure whose source has nothing for the day is null, not 0, so the page
// can tell "no data" from "did nothing". `sources` tells the page how fresh
// each source is.
const mongoose = require("mongoose");
const User = require("../models/User");
const Customer = require("../models/Customer");
const SalesOrder = require("../models/SalesOrder");
const Invoice = require("../models/Invoice");
const CreditNote = require("../models/CreditNotes");
const DeskTime = require("../models/desktime.model");
const CallData = require("../models/CallData");
const Lead = require("../models/Lead");
const Task = require("../models/Task");
const timeParser = require("../utils/time-parser");
const { parisDay } = require("../services/leadFollowUp");

const TZ = "Europe/Paris";
const MAX_DAYS = 366;
const FOLLOW_UP_TYPES = ["follow-up", "call", "restaurant_follow_up"];
const NET = { $subtract: [{ $ifNull: ["$DocTotal", 0] }, { $ifNull: ["$VatSum", 0] }] };
const parisDayKey = (field) => ({ $dateToString: { format: "%Y-%m-%d", date: field, timezone: TZ } });
// DeskTime, invoices and credit notes carry a calendar date stored at UTC midnight.
const utcDayKey = (field) => ({ $dateToString: { format: "%Y-%m-%d", date: field } });

const round = (n, d = 2) => (n === null || n === undefined ? null : parseFloat(Number(n).toFixed(d)));
const fullName = (u) => [u.firstName, u.lastName].filter(Boolean).join(" ").trim();

// "Naoufal HBILI" (Ringover) and "Naoufal Hbili" (HalalSales) are the same
// person: compare lower-cased, accent-free name parts in any order.
const nameKey = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");

// A real clock time ("11:14:28"), not the API job's "Yes"/"No" or an empty "0:00:00".
const clockTime = (s) => {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s || "").trim());
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes > 0 ? minutes : null;
};
const toHHMM = (minutes) =>
  minutes === null ? null : `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(Math.round(minutes % 60)).padStart(2, "0")}`;

// ?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD (Paris days), default this week.
function getRange(query) {
  const today = parisDay().iso;
  let fromIso = String(query.fromDate || "").slice(0, 10);
  let toIso = String(query.toDate || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toIso)) toIso = today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromIso)) {
    const d = new Date(`${toIso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday
    fromIso = d.toISOString().slice(0, 10);
  }
  if (fromIso > toIso) [fromIso, toIso] = [toIso, fromIso];
  return {
    fromIso,
    toIso,
    start: parisDay(fromIso).start,
    end: parisDay(toIso).end, // exclusive
    utcStart: new Date(`${fromIso}T00:00:00.000Z`),
    utcEnd: new Date(`${toIso}T23:59:59.999Z`),
    days: Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86400000) + 1,
  };
}

/**
 * Which agents the caller may see — the same rules as the admin dashboard:
 *  - admin          -> every active sales agent
 *  - sales_manager  -> the agents they manage (User.manager)
 *  - sales_agent    -> only themself
 * `?salesAgent=` narrows to one agent inside that scope (403 outside it).
 */
async function scopedAgents(req) {
  const role = req.user.role;
  const query = { role: "sales_agent", deactivated: false };
  if (role === "sales_manager") query.manager = req.user._id;
  if (role === "sales_agent") query._id = req.user._id;

  const picked = req.query.salesAgent;
  if (picked) {
    if (!mongoose.Types.ObjectId.isValid(picked)) return { forbidden: true };
    if (role === "sales_agent" && String(picked) !== String(req.user._id)) return { forbidden: true };
    if (role !== "sales_agent") query._id = new mongoose.Types.ObjectId(picked);
  }

  const agents = await User.find(query).select("firstName lastName email").sort({ firstName: 1 }).lean();
  if (picked && !agents.length) return { forbidden: true };
  return { agents };
}

const emptyDay = () => ({
  // DeskTime
  productiveHours: null,
  deskHours: null,
  arrived: null,
  left: null,
  // Sales
  ordersCount: 0,
  ordersValue: 0,
  invoicedNet: 0,
  invoiceCount: 0,
  // Calls (Ringover)
  callsOut: null,
  callsOutAnswered: null,
  callsInAnswered: null,
  talkMinutes: null,
  // Leads CRM
  leadsCalled: 0,
  leadContacts: 0,
  followUpsDue: 0,
  followUpsDone: 0,
});

// Ratios and the productivity % from the summed figures. For a range, only
// days that have DeskTime time count towards the ratios (`onDesk`), so days
// with orders/calls but no DeskTime row do not inflate them.
function withRatios(m, onDesk = m) {
  const ph = m.productiveHours;
  return {
    ...m,
    productivityPct: m.deskHours > 0 ? round((ph / m.deskHours) * 100, 1) : null,
    ordersPerProductiveHour: ph > 0 ? round(onDesk.ordersCount / ph) : null,
    callsPerProductiveHour: ph > 0 && onDesk.callsOut !== null ? round(onDesk.callsOut / ph) : null,
  };
}

/**
 * GET /api/agent-productivity?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD[&salesAgent=<id>]
 */
exports.getAgentProductivity = async (req, res) => {
  try {
    const range = getRange(req.query);
    if (range.days > MAX_DAYS) {
      return res.status(400).json({ success: false, message: `Pick at most ${MAX_DAYS} days.` });
    }
    const scope = await scopedAgents(req);
    if (scope.forbidden) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }
    const agents = scope.agents;
    const agentIds = agents.map((a) => a._id);
    const byId = new Map(agents.map((a) => [String(a._id), a]));
    const byEmail = new Map(agents.filter((a) => a.email).map((a) => [a.email.toLowerCase(), String(a._id)]));
    const byName = new Map(agents.map((a) => [nameKey(fullName(a)), String(a._id)]));

    const customers = await Customer.find({ assignedTo: { $in: agentIds } }).select("CardCode assignedTo").lean();
    const cardToAgent = {};
    customers.forEach((c) => {
      if (c.CardCode && c.assignedTo) cardToAgent[c.CardCode] = String(c.assignedTo);
    });
    const cardCodes = Object.keys(cardToAgent);

    const parisRange = { $gte: range.start, $lt: range.end };
    const utcRange = { $gte: range.utcStart, $lte: range.utcEnd };

    const [desktime, orders, invoices, creditNotes, calls, leadLog, tasks, latest] = await Promise.all([
      DeskTime.find({ email: { $in: [...byEmail.keys()] }, date: utcRange })
        .select("email date productiveTime totalDeskTime arrived left")
        .lean(),
      SalesOrder.aggregate([
        { $match: { salesAgent: { $in: agentIds }, DocDate: parisRange, Cancelled: { $nin: ["Y", "tYES"] } } },
        { $group: { _id: { a: "$salesAgent", d: parisDayKey("$DocDate") }, count: { $sum: 1 }, value: { $sum: NET } } },
      ]),
      Invoice.aggregate([
        { $match: { CardCode: { $in: cardCodes }, DocDate: utcRange } },
        { $group: { _id: { c: "$CardCode", d: utcDayKey("$DocDate") }, count: { $sum: 1 }, value: { $sum: NET } } },
      ]),
      CreditNote.aggregate([
        { $match: { CardCode: { $in: cardCodes }, DocDate: utcRange } },
        { $group: { _id: { c: "$CardCode", d: utcDayKey("$DocDate") }, value: { $sum: NET } } },
      ]),
      // Ringover users are few: group every call in the range by user and
      // day, then keep the ones whose name matches an agent in scope.
      CallData.aggregate([
        { $match: { startTime: parisRange, userName: { $nin: [null, ""] } } },
        {
          $group: {
            _id: { u: "$userName", d: parisDayKey("$startTime") },
            out: { $sum: { $cond: [{ $eq: ["$direction", "out"] }, 1, 0] } },
            outAnswered: { $sum: { $cond: [{ $and: [{ $eq: ["$direction", "out"] }, { $eq: ["$lastState", "ANSWERED"] }] }, 1, 0] } },
            inAnswered: { $sum: { $cond: [{ $and: [{ $eq: ["$direction", "in"] }, { $eq: ["$lastState", "ANSWERED"] }] }, 1, 0] } },
            talkSeconds: { $sum: { $ifNull: ["$inCallDuration", 0] } },
          },
        },
      ]),
      Lead.aggregate([
        { $match: { "contactLog.at": parisRange, "contactLog.by": { $in: agentIds } } },
        { $unwind: "$contactLog" },
        { $match: { "contactLog.at": parisRange, "contactLog.by": { $in: agentIds } } },
        {
          $group: {
            _id: { a: "$contactLog.by", d: parisDayKey("$contactLog.at") },
            contacts: { $sum: 1 },
            calledLeads: { $addToSet: { $cond: [{ $eq: ["$contactLog.channel", "call"] }, "$_id", null] } },
          },
        },
      ]),
      Task.aggregate([
        {
          $match: {
            assignedTo: { $in: agentIds },
            type: { $in: FOLLOW_UP_TYPES },
            status: { $nin: ["rejected", "cancelled"] },
            dueDate: parisRange,
          },
        },
        {
          $group: {
            _id: { a: "$assignedTo", d: parisDayKey("$dueDate") },
            due: { $sum: 1 },
            done: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
          },
        },
      ]),
      // How fresh the synced sources are.
      Promise.all([
        DeskTime.findOne({}).sort({ date: -1 }).select("date").lean(),
        CallData.findOne({}).sort({ startTime: -1 }).select("startTime").lean(),
        Lead.aggregate([{ $unwind: "$contactLog" }, { $group: { _id: null, first: { $min: "$contactLog.at" }, last: { $max: "$contactLog.at" } } }]),
      ]),
    ]);

    // agentId -> date -> metrics
    const grid = new Map(agents.map((a) => [String(a._id), new Map()]));
    const cell = (agentId, day) => {
      const days = grid.get(agentId);
      if (!days) return null;
      if (!days.has(day)) days.set(day, emptyDay());
      return days.get(day);
    };

    // DeskTime: several uploads can cover the same day — keep the fullest row.
    desktime.forEach((r) => {
      const c = cell(byEmail.get(String(r.email).toLowerCase()), r.date.toISOString().slice(0, 10));
      if (!c) return;
      const desk = timeParser.parseTimeToHours(r.totalDeskTime) || 0;
      if (c.deskHours !== null && c.deskHours >= desk) return;
      c.deskHours = desk;
      c.productiveHours = timeParser.parseTimeToHours(r.productiveTime) || 0;
      c.arrived = toHHMM(clockTime(r.arrived));
      c.left = toHHMM(clockTime(r.left));
    });
    orders.forEach((r) => {
      const c = cell(String(r._id.a), r._id.d);
      if (!c) return;
      c.ordersCount += r.count;
      c.ordersValue += r.value;
    });
    invoices.forEach((r) => {
      const c = cell(cardToAgent[r._id.c], r._id.d);
      if (!c) return;
      c.invoiceCount += r.count;
      c.invoicedNet += r.value;
    });
    creditNotes.forEach((r) => {
      const c = cell(cardToAgent[r._id.c], r._id.d);
      if (c) c.invoicedNet -= r.value;
    });
    calls.forEach((r) => {
      const c = cell(byName.get(nameKey(r._id.u)), r._id.d);
      if (!c) return;
      c.callsOut = (c.callsOut || 0) + r.out;
      c.callsOutAnswered = (c.callsOutAnswered || 0) + r.outAnswered;
      c.callsInAnswered = (c.callsInAnswered || 0) + r.inAnswered;
      c.talkMinutes = (c.talkMinutes || 0) + r.talkSeconds / 60;
    });
    leadLog.forEach((r) => {
      const c = cell(String(r._id.a), r._id.d);
      if (!c) return;
      c.leadContacts += r.contacts;
      c.leadsCalled += r.calledLeads.filter(Boolean).length;
    });
    tasks.forEach((r) => {
      const c = cell(String(r._id.a), r._id.d);
      if (!c) return;
      c.followUpsDue += r.due;
      c.followUpsDone += r.done;
    });

    // Null-aware sum: stays null while every day is null.
    const add = (a, b) => (b === null ? a : (a || 0) + b);
    const data = agents.map((agent) => {
      const id = String(agent._id);
      const dayRows = [...grid.get(id).entries()].sort(([a], [b]) => a.localeCompare(b));
      const t = emptyDay();
      let deskDays = 0;
      const onDesk = { ordersCount: 0, callsOut: null };
      const arrivals = [];
      const leaves = [];
      dayRows.forEach(([, m]) => {
        if (m.productiveHours > 0) {
          onDesk.ordersCount += m.ordersCount;
          onDesk.callsOut = add(onDesk.callsOut, m.callsOut);
        }
        ["productiveHours", "deskHours", "callsOut", "callsOutAnswered", "callsInAnswered", "talkMinutes"].forEach((k) => {
          t[k] = add(t[k], m[k]);
        });
        ["ordersCount", "ordersValue", "invoicedNet", "invoiceCount", "leadsCalled", "leadContacts", "followUpsDue", "followUpsDone"].forEach((k) => {
          t[k] += m[k];
        });
        if (m.deskHours > 0) deskDays += 1;
        if (m.arrived) arrivals.push(clockTime(m.arrived));
        if (m.left) leaves.push(clockTime(m.left));
      });
      const avg = (list) => (list.length ? toHHMM(list.reduce((s, x) => s + x, 0) / list.length) : null);
      const tidy = (m) => ({
        ...m,
        productiveHours: round(m.productiveHours),
        deskHours: round(m.deskHours),
        ordersValue: round(m.ordersValue),
        invoicedNet: round(m.invoicedNet),
        talkMinutes: round(m.talkMinutes, 1),
      });
      return {
        agentId: id,
        name: fullName(agent),
        email: agent.email,
        // arrived / left are the average clock times over the days that have one.
        totals: withRatios(tidy({ ...t, arrived: avg(arrivals), left: avg(leaves), deskDays }), onDesk),
        days: dayRows.map(([date, m]) => ({ date, ...withRatios(tidy(m)) })),
      };
    });

    const [lastDesk, lastCall, logSpan] = latest;
    const anyIn = (k) => data.some((a) => a.totals[k] !== null);
    res.status(200).json({
      success: true,
      range: { fromDate: range.fromIso, toDate: range.toIso, days: range.days },
      sources: {
        desktime: {
          hasData: anyIn("deskHours"),
          lastDate: lastDesk?.date || null,
          note: "DeskTime Excel uploads; arrival/leave only on uploaded days",
        },
        calls: {
          hasData: anyIn("callsOut"),
          lastDate: lastCall?.startTime || null,
          note: "Ringover calls, matched on the agent's name; sync currently off",
        },
        leadCallLog: {
          firstDate: logSpan[0]?.first || null,
          lastDate: logSpan[0]?.last || null,
          note: "Lead call log (Leads CRM)",
        },
      },
      data,
    });
  } catch (error) {
    console.error("Error in getAgentProductivity:", error);
    res.status(500).json({ success: false, message: "Error fetching agent productivity", error: error.message });
  }
};
