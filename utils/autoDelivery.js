// utils/autoDelivery.js
//
// Marks a truck's stops delivered from its Traccar Client GPS fixes, so
// drivers never need a portal login. Called by the tracking ingest for every
// fix (controllers/tracking.controller.js).
//
// Rule (geofence + dwell): a stop on the truck's route for that day counts as
// delivered once the truck has stayed within DELIVERY_RADIUS_M of the
// customer for DELIVERY_MIN_DWELL_MIN minutes. Driving past (inside the
// circle for less than that, then leaving) resets it, so a stop is not
// ticked off just because the truck went by on the way to another one.
//
// Stored per stop: arrivedAt (first fix inside the circle, cleared on a
// drive-by), deliveredAt (device time of the fix that completed the dwell),
// deliveredBy "gps". Never un-delivers a stop and never touches failed stops.
//
// Env:
//   AUTO_DELIVERY_ENABLED     "false" = off
//   DELIVERY_RADIUS_M         default 150
//   DELIVERY_MIN_DWELL_MIN    default 3
//   DELIVERY_MAX_ACCURACY_M   fixes less accurate than this are ignored, default 100

const TruckRoute = require("../models/TruckRoute");

const cfg = () => ({
  enabled: process.env.AUTO_DELIVERY_ENABLED !== "false",
  radiusM: Number(process.env.DELIVERY_RADIUS_M) || 150,
  dwellMs: (Number(process.env.DELIVERY_MIN_DWELL_MIN) || 3) * 60 * 1000,
  maxAccuracyM: Number(process.env.DELIVERY_MAX_ACCURACY_M) || 100,
});

function distanceM(a, b) {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// Server-local day, the same convention TruckRoute.date uses everywhere else.
function dayRange(at) {
  const start = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  return { $gte: start, $lt: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/**
 * @param {{ tenant: string, truckNumber: number }} device
 * @param {{ lat: number, lng: number, accuracyM?: number, recordedAt: Date }} fix
 * @returns {Promise<Array<{ routeId, docEntry, status, arrivedAt, deliveredAt }>>} stops that changed
 */
async function processFix(device, fix) {
  const c = cfg();
  if (!c.enabled) return [];
  if (Number.isFinite(fix.accuracyM) && fix.accuracyM > c.maxAccuracyM) return [];

  const route = await TruckRoute.findOne({
    tenant: device.tenant,
    truckNumber: device.truckNumber,
    date: dayRange(fix.recordedAt),
  });
  if (!route) return [];

  const at = fix.recordedAt;
  const changed = [];
  for (const stop of route.orders) {
    if (stop.status === "delivered" || stop.status === "failed") continue;
    const pos = stop.coordinates;
    if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) continue;

    const inside = distanceM(fix, pos) <= c.radiusM;
    const before = { arrivedAt: stop.arrivedAt?.getTime(), status: stop.status };

    if (inside) {
      if (!stop.arrivedAt) stop.arrivedAt = at;
      if (at - stop.arrivedAt >= c.dwellMs) {
        stop.status = "delivered";
        stop.deliveredAt = at;
        stop.deliveredBy = "gps";
      }
    } else if (stop.arrivedAt && at > stop.arrivedAt) {
      // Left the circle before the dwell time was reached: a drive-by.
      stop.arrivedAt = undefined;
    }

    if (before.arrivedAt !== stop.arrivedAt?.getTime() || before.status !== stop.status) {
      changed.push({
        routeId: String(route._id),
        docEntry: stop.order?.DocEntry,
        status: stop.status,
        arrivedAt: stop.arrivedAt,
        deliveredAt: stop.deliveredAt,
      });
    }
  }

  if (changed.length > 0) await route.save();
  return changed;
}

module.exports = { processFix, distanceM };
