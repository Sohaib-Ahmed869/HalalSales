// utils/geotabClient.js
//
// Thin client for the MyGeotab API (JSON-RPC over HTTPS), the source of the
// trucks' live GPS and fleet data. MyGeotab has no API key: the portal logs in
// as a MyGeotab user (a dedicated "service account") with database, user name
// and password, gets a session id back, and reuses it until Geotab rejects it.
//
// Env:
//   GEOTAB_DATABASE     the company database name (first part of the MyGeotab
//                       address: my.geotab.com/<database>)
//   GEOTAB_USERNAME     the service account's email
//   GEOTAB_PASSWORD     its password
//   GEOTAB_SERVER       default "my.geotab.com" (Geotab redirects to the
//                       database's own server after login)
//   GEOTAB_ENABLED      "false" = off
//   GEOTAB_TIMEOUT_MS   default 30000
//   GEOTAB_URL          full API URL (only for testing against a mock)

const axios = require("axios");

const config = () => {
  const database = process.env.GEOTAB_DATABASE || "";
  const userName = process.env.GEOTAB_USERNAME || "";
  const password = process.env.GEOTAB_PASSWORD || "";
  return {
    database,
    userName,
    password,
    server: (process.env.GEOTAB_SERVER || "my.geotab.com").replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
    url: process.env.GEOTAB_URL || "",
    timeout: Number(process.env.GEOTAB_TIMEOUT_MS) || 30000,
    enabled: process.env.GEOTAB_ENABLED !== "false" && Boolean(database && userName && password),
  };
};

const isConfigured = () => config().enabled;

// One login shared by every caller; Geotab limits Authenticate to a few calls
// per minute, so a session is never requested twice at once.
let session = null; // { credentials, server, key }
let loggingIn = null;

class GeotabError extends Error {
  constructor(message, name) {
    super(message);
    this.geotabName = name;
  }
}

async function post(url, method, params, timeout) {
  const { data } = await axios.post(url, { method, params }, { timeout, headers: { "Content-Type": "application/json" } });
  if (data && data.error) {
    const first = data.error.errors?.[0];
    throw new GeotabError(first?.message || data.error.message || "Geotab error", first?.name || data.error.name);
  }
  return data ? data.result : undefined;
}

const apiUrl = (cfg, server) => cfg.url || `https://${server}/apiv1`;

async function login() {
  const cfg = config();
  if (!cfg.enabled) throw new GeotabError("Geotab is not configured (GEOTAB_DATABASE, GEOTAB_USERNAME, GEOTAB_PASSWORD)", "NotConfigured");
  const key = `${cfg.server}|${cfg.database}|${cfg.userName}`;
  if (session && session.key === key) return session;
  if (!loggingIn) {
    loggingIn = post(apiUrl(cfg, cfg.server), "Authenticate", { database: cfg.database, userName: cfg.userName, password: cfg.password }, cfg.timeout)
      .then((result) => {
        // path = the server this database lives on ("ThisServer" = the one we asked).
        const server = result.path && result.path !== "ThisServer" ? result.path : cfg.server;
        session = { credentials: result.credentials, server, key };
        return session;
      })
      .finally(() => {
        loggingIn = null;
      });
  }
  return loggingIn;
}

const SESSION_ERRORS = ["InvalidUserException", "DbUnavailableException"];

async function call(method, params = {}) {
  const cfg = config();
  for (let attempt = 0; ; attempt++) {
    const s = await login();
    try {
      return await post(apiUrl(cfg, s.server), method, { ...params, credentials: s.credentials }, cfg.timeout);
    } catch (error) {
      // An expired session is renewed once; anything else is the caller's.
      if (attempt === 0 && SESSION_ERRORS.includes(error.geotabName)) {
        session = null;
        continue;
      }
      throw error;
    }
  }
}

const get = (typeName, search, resultsLimit) =>
  call("Get", { typeName, ...(search ? { search } : {}), ...(resultsLimit ? { resultsLimit } : {}) });

// Several calls in one request; results come back in the same order.
async function multiCall(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 60) {
    const part = await call("ExecuteMultiCall", { calls: calls.slice(i, i + 60) });
    out.push(...(part || []));
  }
  return out;
}

const iso = (d) => new Date(d).toISOString();

// Vehicles that are active now (not archived / historic).
const getDevices = () => get("Device", { fromDate: iso(Date.now()) });

// Latest position, speed and state of every vehicle, in one call.
const getDeviceStatusInfo = () => get("DeviceStatusInfo");

// GPS breadcrumb of one vehicle between two instants.
const getLogRecords = (deviceId, from, to) =>
  get("LogRecord", { deviceSearch: { id: deviceId }, fromDate: iso(from), toDate: iso(to) });

const getRules = () => get("Rule");

// Rule violations (idling, speeding, ...) of every vehicle in the period.
const getExceptionEvents = (from, to) => get("ExceptionEvent", { fromDate: iso(from), toDate: iso(to) });

// Fuel fill-ups Geotab detected in the period.
const getFillUps = (from, to) => get("FillUp", { fromDate: iso(from), toDate: iso(to) });

// With the same from and to date Geotab returns the diagnostic's value at
// that instant (interpolated from the readings around it).
const statusAtCall = (deviceId, diagnosticId, at) => ({
  method: "Get",
  params: {
    typeName: "StatusData",
    search: { deviceSearch: { id: deviceId }, diagnosticSearch: { id: diagnosticId }, fromDate: iso(at), toDate: iso(at) },
  },
});

const DIAGNOSTIC = {
  odometer: "DiagnosticOdometerAdjustmentId", // metres
  totalFuel: "DiagnosticDeviceTotalFuelId", // litres used since the device was installed
};

// For tests: forget the cached login.
function reset() {
  session = null;
  loggingIn = null;
}

module.exports = {
  config,
  isConfigured,
  login,
  call,
  get,
  multiCall,
  getDevices,
  getDeviceStatusInfo,
  getLogRecords,
  getRules,
  getExceptionEvents,
  getFillUps,
  statusAtCall,
  DIAGNOSTIC,
  GeotabError,
  reset,
};
