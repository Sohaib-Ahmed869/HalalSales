// services/intelligenceClient.js
//
// Thin client for hfs-intelligence (the AI WhatsApp outreach agent), so the
// leads screen can show a lead's AI conversation and the team can review and
// launch outreach batches without leaving HalalSales.
//
// Same shared secret as the hand-off push in the other direction
// (INTELLIGENCE_SERVICE_KEY), sent as `x-api-key`. The acting user is passed
// along for the agent's audit trail only — roles are enforced here, before
// anything is proxied.

const axios = require("axios");

const BASE_URL = (process.env.INTELLIGENCE_API_URL || "").replace(/\/+$/, "");
const KEY = process.env.INTELLIGENCE_SERVICE_KEY;

class IntelligenceError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function assertConfigured() {
  if (!BASE_URL || !KEY) {
    throw new IntelligenceError("AI outreach is not configured (INTELLIGENCE_API_URL / INTELLIGENCE_SERVICE_KEY)", 503);
  }
}

function actorHeaders(user) {
  if (!user) return {};
  return {
    "x-actor-id": String(user._id || ""),
    "x-actor-name": `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "",
    "x-actor-role": user.role || "",
  };
}

async function request(method, path, { user, params, data, timeout = 30000 } = {}) {
  assertConfigured();
  try {
    const res = await axios({
      method,
      url: `${BASE_URL}/api/service${path}`,
      params,
      data,
      timeout,
      headers: { "x-api-key": KEY, "Content-Type": "application/json", ...actorHeaders(user) },
    });
    return res.data;
  } catch (err) {
    if (err.response) {
      throw new IntelligenceError(err.response.data?.error || err.response.statusText, err.response.status);
    }
    throw new IntelligenceError(`AI outreach service unreachable: ${err.message}`, 502);
  }
}

module.exports = {
  IntelligenceError,
  configured: () => Boolean(BASE_URL && KEY),
  lookupThread: (q, user) => request("get", "/threads/lookup", { params: q, user }),
  takeover: (threadId, user) => request("post", `/threads/${encodeURIComponent(threadId)}/takeover`, { user }),
  resume: (threadId, user) => request("post", `/threads/${encodeURIComponent(threadId)}/resume`, { user }),
  overview: (user) => request("get", "/overview", { user }),
  batchOptions: (user) => request("get", "/batches/options", { user }),
  listBatches: (user) => request("get", "/batches", { user, timeout: 60000 }),
  previewBatch: (body, user) => request("post", "/batches/preview", { data: body, user, timeout: 60000 }),
  createBatch: (body, user) => request("post", "/batches", { data: body, user, timeout: 120000 }),
  batchReport: (id, user) => request("get", `/batches/${encodeURIComponent(id)}`, { user, timeout: 60000 }),
  stopBatch: (id, user) => request("post", `/batches/${encodeURIComponent(id)}/stop`, { user }),
  listCatalogue: (user) => request("get", "/catalogue", { user, timeout: 60000 }),
  previewCatalogue: (body, user) => request("post", "/catalogue/preview", { data: body, user, timeout: 170000 }),
  createCatalogue: (body, user) => request("post", "/catalogue", { data: body, user, timeout: 600000 }),
  catalogueReport: (id, user) => request("get", `/catalogue/${encodeURIComponent(id)}`, { user, timeout: 60000 }),
  stopCatalogue: (id, user) => request("post", `/catalogue/${encodeURIComponent(id)}/stop`, { user }),

  // Scheduled email campaigns (Amazon SES / Sendy), see hfs-intelligence deploy/EMAIL_CAMPAIGNS.md.
  emailCampaigns: {
    options: (user) => request("get", "/email-campaigns/options", { user, timeout: 60000 }),
    health: (user) => request("get", "/email-campaigns/health", { user }),
    calendar: (params, user) => request("get", "/email-campaigns/calendar", { params, user }),
    timeline: (email, user) => request("get", "/email-campaigns/timeline", { params: { email }, user }),
    sendyLists: (user) => request("get", "/email-campaigns/sendy/lists", { user, timeout: 60000 }),
    previewAudience: (body, user) => request("post", "/email-campaigns/audience/preview", { data: body, user, timeout: 170000 }),
    plan: (body, user) => request("post", "/email-campaigns/plan", { data: body, user }),
    test: (body, user) => request("post", "/email-campaigns/test", { data: body, user, timeout: 60000 }),
    list: (user) => request("get", "/email-campaigns", { user, timeout: 60000 }),
    create: (body, user) => request("post", "/email-campaigns", { data: body, user }),
    get: (id, user) => request("get", `/email-campaigns/${encodeURIComponent(id)}`, { user, timeout: 60000 }),
    update: (id, body, user) => request("patch", `/email-campaigns/${encodeURIComponent(id)}`, { data: body, user, timeout: 60000 }),
    remove: (id, user) => request("delete", `/email-campaigns/${encodeURIComponent(id)}`, { user }),
    kpis: (id, user) => request("get", `/email-campaigns/${encodeURIComponent(id)}/kpis`, { user, timeout: 60000 }),
    recipients: (id, params, user) => request("get", `/email-campaigns/${encodeURIComponent(id)}/recipients`, { params, user, timeout: 60000 }),
    recipient: (id, messageId, user) =>
      request("get", `/email-campaigns/${encodeURIComponent(id)}/recipients/${encodeURIComponent(messageId)}`, { user }),
    // Freezing the audience runs the MX checks: give it time.
    schedule: (id, body, user) => request("post", `/email-campaigns/${encodeURIComponent(id)}/schedule`, { data: body, user, timeout: 600000 }),
    reschedule: (id, body, user) => request("post", `/email-campaigns/${encodeURIComponent(id)}/reschedule`, { data: body, user, timeout: 60000 }),
    pause: (id, user) => request("post", `/email-campaigns/${encodeURIComponent(id)}/pause`, { user, timeout: 60000 }),
    resume: (id, user) => request("post", `/email-campaigns/${encodeURIComponent(id)}/resume`, { user, timeout: 60000 }),
    cancel: (id, user) => request("post", `/email-campaigns/${encodeURIComponent(id)}/cancel`, { user, timeout: 60000 }),
    setWaveList: (id, index, body, user) =>
      request("put", `/email-campaigns/${encodeURIComponent(id)}/waves/${encodeURIComponent(index)}/sendy-list`, { data: body, user, timeout: 60000 }),
    confirmSendyWave: (id, index, body, user) =>
      request("post", `/email-campaigns/${encodeURIComponent(id)}/waves/${encodeURIComponent(index)}/sendy-confirm`, { data: body, user, timeout: 120000 }),
  },
};
