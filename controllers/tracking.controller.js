// controllers/tracking.controller.js
// Live GPS and fleet data for trucks, read from MyGeotab
// (utils/geotabClient.js, services/geotabSync.js), plus the planned-vs-actual
// report (services/adherenceService.js). The portal gets positions over REST
// and socket.io ("truck:position").
const TruckDevice = require("../models/TruckDevice");
const TruckPosition = require("../models/TruckPosition");
const geotab = require("../utils/geotabClient");
const geotabSync = require("../services/geotabSync");
const adherence = require("../services/adherenceService");
const { vehicleDay } = require("../services/vehicleDay");
const { placeholderNotice } = require("../utils/openingHours");

const TENANTS = ["halal-food-sales", "pqf", "data-tech", "ms-foods"];

function tenantFromReq(req) {
  const t = req.query.tenant || req.body?.tenant || "halal-food-sales";
  return TENANTS.includes(t) ? t : "halal-food-sales";
}

const num = (v) => {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "");

const publicDevice = (d) => ({
  _id: d._id,
  deviceId: d.deviceId,
  geotabId: d.geotabId,
  truckNumber: d.truckNumber,
  label: d.label,
  licensePlate: d.licensePlate,
  vin: d.vin,
  isActive: d.isActive,
  lastPosition: d.lastPosition?.lat !== undefined ? d.lastPosition : null,
  lastSeenAt: d.lastSeenAt,
});

// GET /api/tracking/devices -> the vehicles assigned to a truck, with their latest position
exports.listDevices = async (req, res) => {
  try {
    const devices = await TruckDevice.find({ tenant: tenantFromReq(req), isActive: true, provider: "geotab" })
      .sort({ truckNumber: 1 })
      .lean();
    res.json({ provider: "geotab", geotab: geotabSync.status(), devices: devices.map(publicDevice) });
  } catch (error) {
    res.status(500).json({ message: "Failed to load devices", error: error.message });
  }
};

// GET /api/tracking/geotab/vehicles -> every vehicle in MyGeotab and the truck
// it is assigned to here; also the connection test behind the setup dialog.
exports.listGeotabVehicles = async (req, res) => {
  const status = geotabSync.status();
  if (!status.configured) {
    return res.json({ ...status, connected: false, vehicles: [], message: "MyGeotab is not set up on the server yet." });
  }
  try {
    // Every MyGeotab vehicle is a truck here: new ones get a truck number now.
    const assigned = await geotabSync.syncVehicles(tenantFromReq(req));
    const vehicles = await geotab.getDevices();
    const byGeotabId = new Map(assigned.map((d) => [d.geotabId, d]));
    res.json({
      ...status,
      connected: true,
      database: geotab.config().database,
      vehicles: (vehicles || [])
        .map((v) => {
          const mine = byGeotabId.get(v.id);
          return {
            geotabId: v.id,
            name: v.name,
            registration: v.licensePlate || "",
            vin: v.vehicleIdentificationNumber || "",
            serialNumber: v.serialNumber || "",
            truckNumber: mine ? mine.truckNumber : null,
            maxWeightKg: mine ? mine.maxWeightKg ?? null : null,
            maxVolumeM3: mine ? mine.maxVolumeM3 ?? null : null,
            departureTime: mine ? mine.departureTime || null : null,
            deviceDocId: mine ? mine._id : null,
            lastSeenAt: mine ? mine.lastSeenAt : null,
          };
        })
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    });
  } catch (error) {
    // 200 with the reason, so the dialog can show what to fix (wrong password, database, ...).
    res.json({ ...status, connected: false, vehicles: [], message: error.message });
  }
};

// POST /api/tracking/devices  { geotabId, truckNumber } -> assigns a MyGeotab vehicle to a truck number
exports.assignDevice = async (req, res) => {
  try {
    const truckNumber = num(req.body.truckNumber);
    const geotabId = String(req.body.geotabId || "").trim();
    if (!geotabId) return res.status(400).json({ message: "geotabId is required" });
    if (!Number.isInteger(truckNumber) || truckNumber < 1) {
      return res.status(400).json({ message: "truckNumber is required" });
    }
    const tenant = tenantFromReq(req);

    const vehicles = await geotab.getDevices();
    const vehicle = (vehicles || []).find((v) => v.id === geotabId);
    if (!vehicle) return res.status(404).json({ message: "Vehicle not found in MyGeotab" });

    // One vehicle per truck number: whichever had this number before is released.
    await TruckDevice.updateMany(
      { tenant, truckNumber, isActive: true, deviceId: { $ne: `geotab:${geotabId}` } },
      { isActive: false }
    );
    const device = await TruckDevice.findOneAndUpdate(
      { deviceId: `geotab:${geotabId}` },
      {
        $set: {
          tenant,
          truckNumber,
          provider: "geotab",
          geotabId,
          label: vehicle.name,
          licensePlate: vehicle.licensePlate,
          vin: vehicle.vehicleIdentificationNumber,
          serialNumber: vehicle.serialNumber,
          isActive: true,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    geotabSync.start();
    res.status(201).json({ device: publicDevice(device) });
  } catch (error) {
    res.status(500).json({ message: "Failed to assign vehicle", error: error.message });
  }
};

// DELETE /api/tracking/devices/:id  (unassigns; the GPS history stays)
exports.deleteDevice = async (req, res) => {
  try {
    const device = await TruckDevice.findOneAndUpdate(
      { _id: req.params.id, tenant: tenantFromReq(req) },
      { isActive: false }
    );
    if (!device) return res.status(404).json({ message: "Device not found" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete device", error: error.message });
  }
};

// GET /api/tracking/trail/:truckNumber?date=YYYY-MM-DD  -> the day's breadcrumb
exports.getTrail = async (req, res) => {
  try {
    const truckNumber = num(req.params.truckNumber);
    const date = isDay(req.query.date) ? req.query.date : null;
    if (truckNumber === undefined || !date) {
      return res.status(400).json({ message: "truckNumber and date (YYYY-MM-DD) are required" });
    }
    // Server-local day, like TruckRoute.date; a little past midnight for late returns.
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start.getTime() + 30 * 60 * 60 * 1000);
    const points = await TruckPosition.find({
      tenant: tenantFromReq(req),
      truckNumber,
      recordedAt: { $gte: start, $lte: end },
    })
      .sort({ recordedAt: 1 })
      .limit(8000)
      .select("lat lng speedKmh recordedAt -_id")
      .lean();
    res.json({ points });
  } catch (error) {
    res.status(500).json({ message: "Failed to load trail", error: error.message });
  }
};

// GET /api/tracking/fleet?from=YYYY-MM-DD&to=YYYY-MM-DD[&fresh=true]
// Registration, odometer, idling / speeding violations, fill-ups and fuel
// economy per vehicle. Defaults to the last 7 days.
exports.getFleet = async (req, res) => {
  if (!geotab.isConfigured()) {
    return res.json({ configured: false, vehicles: [], violations: [], fillUps: [], message: "MyGeotab is not set up on the server yet." });
  }
  try {
    const to = isDay(req.query.to) ? new Date(req.query.to) : new Date();
    to.setHours(23, 59, 59, 999);
    const from = isDay(req.query.from) ? new Date(req.query.from) : new Date(to.getTime() - 6 * 24 * 60 * 60 * 1000);
    from.setHours(0, 0, 0, 0);
    if (from > to) return res.status(400).json({ message: "from must be before to" });
    const data = await geotabSync.fleetOverview(from, to, { fresh: req.query.fresh === "true" });
    res.json({ configured: true, ...data });
  } catch (error) {
    res.status(502).json({ message: `MyGeotab: ${error.message}` });
  }
};

// GET /api/tracking/vehicle-day?geotabId=b12&date=YYYY-MM-DD[&fresh=true]
// What one vehicle did that day (route, stops with times and addresses, drives,
// events, fill-ups, matched with the portal's plan), read from MyGeotab.
exports.getVehicleDay = async (req, res) => {
  if (!geotab.isConfigured()) {
    return res.json({ configured: false, message: "MyGeotab is not set up on the server yet." });
  }
  const geotabId = String(req.query.geotabId || "").trim();
  if (!geotabId || !isDay(req.query.date)) return res.status(400).json({ message: "geotabId and date (YYYY-MM-DD) are required" });
  try {
    const data = await vehicleDay({ geotabId, date: req.query.date, tenant: tenantFromReq(req), fresh: req.query.fresh === "true" });
    res.json({ configured: true, ...data });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    res.status(502).json({ message: `MyGeotab: ${error.message}` });
  }
};

// GET /api/tracking/adherence?date=YYYY-MM-DD[&refresh=true]
// The planned-vs-actual report of every truck that day. Computed when asked
// to (refresh) or when nothing is stored for the day yet.
exports.getAdherence = async (req, res) => {
  try {
    if (!isDay(req.query.date)) return res.status(400).json({ message: "date (YYYY-MM-DD) is required" });
    const tenant = tenantFromReq(req);
    let reports = req.query.refresh === "true" ? null : await adherence.getForDate(req.query.date, tenant);
    if (!reports || reports.length === 0) reports = await adherence.runForDate(req.query.date, tenant);
    // Says which results depend on the (placeholder) customer opening / preferred hours.
    const hours = placeholderNotice({
      deviations: reports.reduce((n, r) => n + (r.summary?.fromHours || 0), 0),
      stops: reports.reduce((n, r) => n + (r.summary?.stopsFromHours || 0), 0),
    });
    res.json({ date: req.query.date, geotab: geotabSync.status(), reports, placeholderHours: hours });
  } catch (error) {
    console.error("Adherence error:", error);
    res.status(500).json({ message: "Failed to build the planned vs actual report", error: error.message });
  }
};
