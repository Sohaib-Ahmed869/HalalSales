// services/geotabSync.js
//
// MyGeotab -> portal. Replaces the Traccar Client phone tracker.
//
//   - Live positions: every GEOTAB_POLL_SEC (default 15) one DeviceStatusInfo
//     call returns every vehicle's latest position. Vehicles assigned to a
//     truck number (TruckDevice, "Geotab vehicles" in the portal) get their
//     position stored (TruckPosition breadcrumb), pushed to the map over
//     socket.io ("truck:position"), checked against the day's stops
//     (utils/stopVisits.js) and used for live ETAs (utils/liveEta.js).
//   - backfillDay: copies a vehicle's full GPS log for a day from Geotab, so
//     the planned-vs-actual report is complete even if this server was down.
//   - fleetOverview: registration, odometer, idling / speeding violations,
//     fuel fill-ups and fuel economy per vehicle.
//
// Env: GEOTAB_* (utils/geotabClient.js), GEOTAB_POLL_SEC, GEOTAB_TENANT
// (default halal-food-sales), GEOTAB_IDLING_RULE_IDS / GEOTAB_SPEEDING_RULE_IDS
// (comma lists, to count other rules than the built-in ones).

const geotab = require("../utils/geotabClient");
const TruckDevice = require("../models/TruckDevice");
const TruckPosition = require("../models/TruckPosition");
const { emitPosition, emitStopUpdate, emitEtaUpdate } = require("./trackingSocket");
const { processFix } = require("../utils/stopVisits");
const { maybeUpdateLiveEtas } = require("../utils/liveEta");

const tenant = () => process.env.GEOTAB_TENANT || "halal-food-sales";
const pollMs = () => Math.max(5, Number(process.env.GEOTAB_POLL_SEC) || 15) * 1000;
const HEARTBEAT_MS = 60 * 1000;

const state = { timer: null, polling: false, lastOkAt: null, lastError: null, lastErrorAt: null };

const validFix = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);

const round1 = (n) => Math.round(n * 10) / 10;

// One poll: read every vehicle's status, update the assigned trucks.
async function pollOnce() {
  const devices = await TruckDevice.find({ provider: "geotab", isActive: true, geotabId: { $exists: true, $ne: null } });
  if (devices.length === 0) return 0;

  const statuses = await geotab.getDeviceStatusInfo();
  const byId = new Map((statuses || []).map((s) => [s.device?.id, s]));
  const now = new Date();
  let moved = 0;

  for (const device of devices) {
    const st = byId.get(device.geotabId);
    if (!st || !validFix(st.latitude, st.longitude)) continue;

    const gpsAt = new Date(st.dateTime);
    if (Number.isNaN(gpsAt.getTime()) || gpsAt > new Date(now.getTime() + 5 * 60 * 1000)) continue;
    const prevAt = device.lastPosition?.recordedAt;
    const isNew = !prevAt || gpsAt > prevAt;
    const communicating = st.isDeviceCommunicating !== false;
    const heartbeatDue = !device.lastSeenAt || now - device.lastSeenAt >= HEARTBEAT_MS;
    if (!isNew && !(communicating && heartbeatDue)) continue;

    const fix = {
      lat: st.latitude,
      lng: st.longitude,
      speedKmh: Number.isFinite(st.speed) ? round1(st.speed) : undefined,
      heading: Number.isFinite(st.bearing) && st.bearing >= 0 ? st.bearing : undefined,
      recordedAt: isNew ? gpsAt : prevAt,
      driving: Boolean(st.isDriving),
      communicating,
    };

    if (isNew) {
      moved++;
      await TruckPosition.create({
        deviceId: device.deviceId,
        tenant: device.tenant,
        truckNumber: device.truckNumber,
        lat: fix.lat,
        lng: fix.lng,
        speedKmh: fix.speedKmh,
        heading: fix.heading,
        recordedAt: gpsAt,
      });
    }

    device.lastPosition = fix;
    if (communicating) device.lastSeenAt = now;
    await device.save();
    emitPosition(device.tenant, {
      deviceId: device.deviceId,
      truckNumber: device.truckNumber,
      label: device.label,
      licensePlate: device.licensePlate,
      ...fix,
      lastSeenAt: device.lastSeenAt,
    });

    if (!isNew) continue; // parked and unchanged: nothing new to work out

    let stopChanged = false;
    try {
      const changed = await processFix(device, fix);
      stopChanged = changed.length > 0;
      changed.forEach((c) => emitStopUpdate(device.tenant, { truckNumber: device.truckNumber, ...c }));
    } catch (error) {
      console.error("[geotab] stop visit error:", error.message);
    }
    // Not awaited: one slow traffic request must not hold up the other trucks.
    maybeUpdateLiveEtas(device, fix, {
      force: stopChanged,
      onUpdated: (r) => emitEtaUpdate(device.tenant, { truckNumber: device.truckNumber, ...r }),
    });
  }
  return moved;
}

async function tick() {
  if (state.polling) return;
  state.polling = true;
  try {
    await pollOnce();
    state.lastOkAt = new Date();
    state.lastError = null;
  } catch (error) {
    // Logged once per distinct problem, not every 15 seconds.
    if (state.lastError !== error.message) console.error("[geotab] poll failed:", error.message);
    state.lastError = error.message;
    state.lastErrorAt = new Date();
  } finally {
    state.polling = false;
  }
}

function start() {
  if (state.timer) return true;
  if (!geotab.isConfigured()) {
    console.log("[geotab] not configured (GEOTAB_DATABASE / GEOTAB_USERNAME / GEOTAB_PASSWORD): live truck GPS is off");
    return false;
  }
  state.timer = setInterval(tick, pollMs());
  if (state.timer.unref) state.timer.unref();
  syncVehicles()
    .catch((error) => console.error("[geotab] vehicle sync failed:", error.message))
    .then(tick);
  console.log(`[geotab] polling vehicle positions every ${pollMs() / 1000}s`);
  return true;
}

function stop() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/**
 * Makes every MyGeotab vehicle a truck of the portal: a vehicle seen for the
 * first time gets the next free truck number; known ones keep their number
 * and get their name / registration refreshed. A vehicle switched off in the
 * portal ("Not a delivery truck") stays off.
 * @returns {Promise<Array>} the active TruckDevice documents (lean), by truck number
 */
async function syncVehicles(tenantName = tenant()) {
  const vehicles = (await geotab.getDevices()) || [];
  const known = await TruckDevice.find({ deviceId: { $in: vehicles.map((v) => `geotab:${v.id}`) } });
  const byDeviceId = new Map(known.map((d) => [d.deviceId, d]));
  const taken = await TruckDevice.find({ tenant: tenantName, isActive: true }).select("truckNumber").lean();
  let next = taken.reduce((max, d) => Math.max(max, d.truckNumber || 0), 0);

  for (const v of vehicles.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    const info = { label: v.name, licensePlate: v.licensePlate, vin: v.vehicleIdentificationNumber, serialNumber: v.serialNumber };
    const device = byDeviceId.get(`geotab:${v.id}`);
    if (!device) {
      await TruckDevice.create({ deviceId: `geotab:${v.id}`, tenant: tenantName, truckNumber: ++next, provider: "geotab", geotabId: v.id, ...info });
    } else if (Object.keys(info).some((k) => (device[k] || "") !== (info[k] || ""))) {
      Object.assign(device, info);
      await device.save();
    }
  }
  return TruckDevice.find({ tenant: tenantName, isActive: true, provider: "geotab" }).sort({ truckNumber: 1 }).lean();
}

const status = () => ({
  configured: geotab.isConfigured(),
  polling: Boolean(state.timer),
  pollSec: pollMs() / 1000,
  lastOkAt: state.lastOkAt,
  lastError: state.lastError,
  lastErrorAt: state.lastErrorAt,
});

/**
 * Copies a vehicle's GPS log between two instants from Geotab into the
 * breadcrumb history (fixes already stored are skipped).
 * @returns {Promise<number>} fixes added
 */
async function backfillDay(device, from, to) {
  if (!geotab.isConfigured() || !device.geotabId) return 0;
  const records = await geotab.getLogRecords(device.geotabId, from, to);
  if (!records || records.length === 0) return 0;
  const have = new Set(
    (
      await TruckPosition.find({ deviceId: device.deviceId, recordedAt: { $gte: from, $lte: to } })
        .select("recordedAt -_id")
        .lean()
    ).map((p) => p.recordedAt.getTime())
  );
  const docs = [];
  for (const r of records) {
    const at = new Date(r.dateTime);
    if (Number.isNaN(at.getTime()) || have.has(at.getTime()) || !validFix(r.latitude, r.longitude)) continue;
    have.add(at.getTime());
    docs.push({
      deviceId: device.deviceId,
      tenant: device.tenant,
      truckNumber: device.truckNumber,
      lat: r.latitude,
      lng: r.longitude,
      speedKmh: Number.isFinite(r.speed) ? round1(r.speed) : undefined,
      recordedAt: at,
    });
  }
  if (docs.length > 0) await TruckPosition.insertMany(docs, { ordered: false });
  return docs.length;
}

/**
 * Every time the vehicle stood still between two instants, with how long the
 * engine was off and how long it was running (from Geotab's trips). Lets the
 * planned-vs-actual report tell a parked truck from one standing in traffic.
 * @returns {Promise<Array<{ from: Date, to: Date, lat: number, lng: number, offMin: number, idleMin: number }>>}
 */
async function engineStops(device, from, to) {
  if (!geotab.isConfigured() || !device.geotabId) return [];
  const trips = (await geotab.getTrips(device.geotabId, from, to)) || [];
  const stops = [];
  for (const t of trips) {
    const start = new Date(t.stop);
    const end = new Date(t.nextTripStart);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) continue;
    const total = (end - start) / 60000;
    const idleMin = Math.min(total, geotab.timeSpanMinutes(t.idlingDuration));
    stops.push({
      from: start,
      to: end,
      lat: t.stopPoint?.y,
      lng: t.stopPoint?.x,
      idleMin,
      offMin: Math.max(0, total - idleMin),
    });
  }
  return stops;
}

// ---------- Fleet data ----------

const listEnv = (name) =>
  (process.env[name] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// Which Geotab rules count as idling / speeding: the built-in ones, any rule
// named like them, or the ids given in the env lists.
function classifyRules(rules) {
  const idlingIds = new Set(["RuleIdlingId", ...listEnv("GEOTAB_IDLING_RULE_IDS")]);
  const speedingIds = new Set(["RulePostedSpeedingId", "RuleSpeedingId", ...listEnv("GEOTAB_SPEEDING_RULE_IDS")]);
  const kind = new Map();
  const names = { idling: [], speeding: [] };
  (rules || []).forEach((r) => {
    const name = r.name || r.id;
    let k = null;
    if (idlingIds.has(r.id) || /idl/i.test(name)) k = "idling";
    else if (speedingIds.has(r.id) || /speed/i.test(name)) k = "speeding";
    if (k) {
      kind.set(r.id, k);
      names[k].push(name);
    }
  });
  // Built-in rules count even if the Rule list didn't return them.
  idlingIds.forEach((id) => !kind.has(id) && kind.set(id, "idling"));
  speedingIds.forEach((id) => !kind.has(id) && kind.set(id, "speeding"));
  return { kind, names, ruleName: new Map((rules || []).map((r) => [r.id, r.name || r.id])) };
}

const firstValue = (result) => {
  const v = Array.isArray(result) && result.length > 0 ? result[result.length - 1].data : null;
  return Number.isFinite(v) ? v : null;
};

const fleetCache = new Map(); // "from|to" -> { at, data }
const FLEET_CACHE_MS = 5 * 60 * 1000;

/**
 * Per-vehicle fleet figures for a period.
 * @param {Date} from
 * @param {Date} to
 */
async function fleetOverview(from, to, { fresh = false } = {}) {
  const key = `${from.getTime()}|${to.getTime()}`;
  const cached = fleetCache.get(key);
  if (!fresh && cached && Date.now() - cached.at < FLEET_CACHE_MS) return cached.data;

  const now = new Date();
  const until = to > now ? now : to;
  const [devices, statuses, rules, events, fillUps, assigned] = await Promise.all([
    geotab.getDevices(),
    geotab.getDeviceStatusInfo(),
    geotab.getRules().catch(() => []),
    geotab.getExceptionEvents(from, until),
    geotab.getFillUps(from, until).catch(() => []),
    TruckDevice.find({ provider: "geotab", isActive: true, tenant: tenant() }).lean(),
  ]);

  const statusById = new Map((statuses || []).map((s) => [s.device?.id, s]));
  const truckById = new Map(assigned.map((d) => [d.geotabId, d.truckNumber]));
  const { kind, names, ruleName } = classifyRules(rules);

  // Odometer now, and odometer + total fuel used at both ends of the period.
  const calls = [];
  (devices || []).forEach((d) => {
    calls.push(geotab.statusAtCall(d.id, geotab.DIAGNOSTIC.odometer, until));
    calls.push(geotab.statusAtCall(d.id, geotab.DIAGNOSTIC.odometer, from));
    calls.push(geotab.statusAtCall(d.id, geotab.DIAGNOSTIC.totalFuel, until));
    calls.push(geotab.statusAtCall(d.id, geotab.DIAGNOSTIC.totalFuel, from));
  });
  let readings = [];
  try {
    readings = calls.length > 0 ? await geotab.multiCall(calls) : [];
  } catch (error) {
    console.warn("[geotab] odometer / fuel readings unavailable:", error.message);
  }

  const rows = new Map();
  (devices || []).forEach((d, i) => {
    const st = statusById.get(d.id);
    const odoEnd = firstValue(readings[i * 4]);
    const odoStart = firstValue(readings[i * 4 + 1]);
    const fuelEnd = firstValue(readings[i * 4 + 2]);
    const fuelStart = firstValue(readings[i * 4 + 3]);
    const km = odoEnd != null && odoStart != null && odoEnd >= odoStart ? (odoEnd - odoStart) / 1000 : null;
    const litres = fuelEnd != null && fuelStart != null && fuelEnd >= fuelStart ? fuelEnd - fuelStart : null;
    rows.set(d.id, {
      geotabId: d.id,
      name: d.name,
      registration: d.licensePlate || "",
      vin: d.vehicleIdentificationNumber || "",
      serialNumber: d.serialNumber || "",
      truckNumber: truckById.get(d.id) ?? null,
      odometerKm: odoEnd != null ? Math.round(odoEnd / 1000) : null,
      distanceKm: km != null ? round1(km) : null,
      fuelUsedL: litres != null ? round1(litres) : null,
      // Needs a real distance: a few km of noise would give a silly figure.
      fuelEconomyL100: km != null && litres != null && km >= 5 && litres > 0 ? round1((litres / km) * 100) : null,
      idlingCount: 0,
      idlingMin: 0,
      speedingCount: 0,
      speedingMin: 0,
      fillUpCount: 0,
      fillUpLitres: 0,
      fillUpCost: 0,
      fillUpCurrency: null,
      lastFillUpAt: null,
      position: st && validFix(st.latitude, st.longitude) ? { lat: st.latitude, lng: st.longitude } : null,
      speedKmh: st && Number.isFinite(st.speed) ? round1(st.speed) : null,
      driving: st ? Boolean(st.isDriving) : null,
      communicating: st ? st.isDeviceCommunicating !== false : null,
      positionAt: st?.dateTime || null,
    });
  });

  const violations = [];
  (events || []).forEach((e) => {
    const k = kind.get(e.rule?.id);
    const row = rows.get(e.device?.id);
    if (!k || !row) return;
    const start = new Date(e.activeFrom);
    const end = new Date(e.activeTo);
    const min = Number.isFinite(end - start) && end > start ? (end - start) / 60000 : 0;
    row[`${k}Count`]++;
    row[`${k}Min`] += min;
    violations.push({
      type: k,
      rule: ruleName.get(e.rule?.id) || e.rule?.id,
      geotabId: row.geotabId,
      vehicle: row.name,
      registration: row.registration,
      truckNumber: row.truckNumber,
      from: e.activeFrom,
      to: e.activeTo,
      durationMin: round1(min),
      distanceKm: Number.isFinite(e.distance) ? round1(e.distance) : null,
    });
  });

  const fills = [];
  (fillUps || []).forEach((f) => {
    const row = rows.get(f.device?.id);
    if (!row) return;
    const litres = Number.isFinite(f.volume) && f.volume > 0 ? f.volume : Number.isFinite(f.derivedVolume) ? f.derivedVolume : 0;
    row.fillUpCount++;
    row.fillUpLitres += litres;
    if (Number.isFinite(f.cost)) row.fillUpCost += f.cost;
    if (f.currencyCode) row.fillUpCurrency = f.currencyCode;
    if (!row.lastFillUpAt || new Date(f.dateTime) > new Date(row.lastFillUpAt)) row.lastFillUpAt = f.dateTime;
    fills.push({
      geotabId: row.geotabId,
      vehicle: row.name,
      registration: row.registration,
      truckNumber: row.truckNumber,
      at: f.dateTime,
      litres: round1(litres),
      cost: Number.isFinite(f.cost) ? Math.round(f.cost * 100) / 100 : null,
      currency: f.currencyCode || null,
      odometerKm: Number.isFinite(f.odometer) ? Math.round(f.odometer / 1000) : null,
      location: f.location && validFix(f.location.y, f.location.x) ? { lat: f.location.y, lng: f.location.x } : null,
    });
  });

  const vehicles = [...rows.values()]
    .map((r) => ({
      ...r,
      idlingMin: Math.round(r.idlingMin),
      speedingMin: Math.round(r.speedingMin),
      fillUpLitres: round1(r.fillUpLitres),
      fillUpCost: Math.round(r.fillUpCost * 100) / 100,
    }))
    .sort((a, b) => (a.truckNumber ?? 1e9) - (b.truckNumber ?? 1e9) || String(a.name).localeCompare(String(b.name)));

  const byNewest = (field) => (a, b) => new Date(b[field]) - new Date(a[field]);
  const data = {
    from,
    to: until,
    generatedAt: now,
    rules: names,
    vehicles,
    violations: violations.sort(byNewest("from")),
    fillUps: fills.sort(byNewest("at")),
  };
  fleetCache.set(key, { at: Date.now(), data });
  if (fleetCache.size > 20) fleetCache.delete(fleetCache.keys().next().value);
  return data;
}

module.exports = { start, stop, status, pollOnce, syncVehicles, backfillDay, engineStops, fleetOverview, tenant };
