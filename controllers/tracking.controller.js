// controllers/tracking.controller.js
// Live GPS for trucks, fed by the free Traccar Client phone app (OsmAnd
// protocol). Phones -> POST /api/tracking/osmand (no login, device id is the
// secret); portal -> REST + socket.io ("truck:position").
const crypto = require("crypto");
const TruckDevice = require("../models/TruckDevice");
const TruckPosition = require("../models/TruckPosition");
const { emitPosition } = require("../services/trackingSocket");

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

// Unix seconds, unix ms or an ISO string -> Date. Falls back to "now" for
// missing/garbage/future timestamps (a phone with a wrong clock must not
// pin a truck in the future).
function parseTimestamp(v) {
  let ms;
  if (v === undefined || v === null || v === "") return new Date();
  if (!Number.isNaN(Number(v))) {
    const n = Number(v);
    ms = n > 1e12 ? n : n * 1000;
  } else {
    ms = Date.parse(v);
  }
  if (!Number.isFinite(ms) || ms > Date.now() + 5 * 60 * 1000) return new Date();
  return new Date(ms);
}

// Traccar Client sends either the classic OsmAnd query/form
// (id, lat, lon, timestamp, speed[km/h], bearing, accuracy, batt) or, in newer
// versions, a JSON body ({device_id, location:{timestamp, coords:{latitude,
// longitude, speed[m/s], heading, accuracy}, battery:{level 0..1}}}). Accept both.
function parseFix(req) {
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const q = req.query || {};

  if (b.location && b.location.coords) {
    const c = b.location.coords;
    const speedMs = num(c.speed);
    const level = num(b.location.battery?.level);
    return {
      deviceId: String(b.device_id || q.id || ""),
      lat: num(c.latitude),
      lng: num(c.longitude),
      speedKmh: speedMs !== undefined && speedMs >= 0 ? Math.round(speedMs * 3.6 * 10) / 10 : undefined,
      heading: num(c.heading),
      accuracyM: num(c.accuracy),
      battery: level !== undefined ? Math.round(level * 100) : undefined,
      recordedAt: parseTimestamp(b.location.timestamp),
    };
  }

  const p = { ...q, ...b };
  return {
    deviceId: String(p.id || p.deviceid || ""),
    lat: num(p.lat),
    lng: num(p.lon ?? p.lng),
    speedKmh: num(p.speed),
    heading: num(p.bearing ?? p.heading),
    accuracyM: num(p.accuracy ?? p.hdop),
    battery: num(p.batt),
    recordedAt: parseTimestamp(p.timestamp),
  };
}

// GET or POST /api/tracking/osmand  (public)
exports.ingest = async (req, res) => {
  try {
    const fix = parseFix(req);
    if (!fix.deviceId) return res.status(400).send("Missing device id");
    if (
      fix.lat === undefined ||
      fix.lng === undefined ||
      Math.abs(fix.lat) > 90 ||
      Math.abs(fix.lng) > 180 ||
      (fix.lat === 0 && fix.lng === 0)
    ) {
      return res.status(400).send("Invalid coordinates");
    }

    const device = await TruckDevice.findOne({ deviceId: fix.deviceId, isActive: true });
    // 404 (not 200) so the app's own status screen shows a wrong id right away.
    if (!device) return res.status(404).send("Unknown device");

    await TruckPosition.create({
      deviceId: device.deviceId,
      tenant: device.tenant,
      truckNumber: device.truckNumber,
      lat: fix.lat,
      lng: fix.lng,
      speedKmh: fix.speedKmh,
      heading: fix.heading,
      accuracyM: fix.accuracyM,
      battery: fix.battery,
      recordedAt: fix.recordedAt,
    });

    // The app buffers fixes while offline and uploads them later, out of order.
    // History keeps all of them; the "current" position only moves forward.
    const prev = device.lastPosition?.recordedAt;
    if (!prev || fix.recordedAt >= prev) {
      device.lastPosition = {
        lat: fix.lat,
        lng: fix.lng,
        speedKmh: fix.speedKmh,
        heading: fix.heading,
        accuracyM: fix.accuracyM,
        battery: fix.battery,
        recordedAt: fix.recordedAt,
      };
      device.lastSeenAt = new Date();
      await device.save();
      emitPosition(device.tenant, {
        deviceId: device.deviceId,
        truckNumber: device.truckNumber,
        label: device.label,
        ...device.lastPosition.toObject(),
        lastSeenAt: device.lastSeenAt,
      });
    }

    res.status(200).send("OK");
  } catch (error) {
    console.error("tracking ingest error:", error.message);
    res.status(500).send("Error");
  }
};

function ingestUrl(req) {
  if (process.env.TRACKING_PUBLIC_URL) return process.env.TRACKING_PUBLIC_URL.replace(/\/$/, "");
  const proto = req.get("x-forwarded-proto") || req.protocol;
  return `${proto}://${req.get("host")}/api/tracking/osmand`;
}

const publicDevice = (d) => ({
  _id: d._id,
  deviceId: d.deviceId,
  truckNumber: d.truckNumber,
  label: d.label,
  isActive: d.isActive,
  lastPosition: d.lastPosition?.lat !== undefined ? d.lastPosition : null,
  lastSeenAt: d.lastSeenAt,
});

// GET /api/tracking/devices
exports.listDevices = async (req, res) => {
  try {
    const devices = await TruckDevice.find({ tenant: tenantFromReq(req), isActive: true })
      .sort({ truckNumber: 1 })
      .lean();
    res.json({ ingestUrl: ingestUrl(req), devices: devices.map(publicDevice) });
  } catch (error) {
    res.status(500).json({ message: "Failed to load devices", error: error.message });
  }
};

// POST /api/tracking/devices  { truckNumber, label }
exports.createDevice = async (req, res) => {
  try {
    const truckNumber = num(req.body.truckNumber);
    if (!Number.isInteger(truckNumber) || truckNumber < 1) {
      return res.status(400).json({ message: "truckNumber is required" });
    }
    const device = await TruckDevice.create({
      deviceId: crypto.randomBytes(8).toString("hex"),
      tenant: tenantFromReq(req),
      truckNumber,
      label: req.body.label,
    });
    res.status(201).json({ ingestUrl: ingestUrl(req), device: publicDevice(device) });
  } catch (error) {
    res.status(500).json({ message: "Failed to create device", error: error.message });
  }
};

// DELETE /api/tracking/devices/:id  (deactivates; old fixes stay in history)
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
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || "") ? req.query.date : null;
    if (truckNumber === undefined || !date) {
      return res.status(400).json({ message: "truckNumber and date (YYYY-MM-DD) are required" });
    }
    const start = new Date(`${date}T00:00:00.000Z`);
    const end = new Date(`${date}T23:59:59.999Z`);
    const points = await TruckPosition.find({
      tenant: tenantFromReq(req),
      truckNumber,
      recordedAt: { $gte: start, $lte: end },
    })
      .sort({ recordedAt: 1 })
      .limit(5000)
      .select("lat lng speedKmh recordedAt -_id")
      .lean();
    res.json({ points });
  } catch (error) {
    res.status(500).json({ message: "Failed to load trail", error: error.message });
  }
};
