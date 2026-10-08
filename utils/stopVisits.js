// utils/stopVisits.js
//
// Records when a truck actually reached and left each stop, from its GPS
// (MyGeotab, services/geotabSync.js). It never marks a stop delivered: the
// times are only used for live ETAs and for the planned-vs-actual report.
//
// Rule (geofence + dwell): arrivedAt = first fix within STOP_VISIT_RADIUS_M of
// the customer; departedAt = first fix outside again, provided the truck
// stayed at least STOP_VISIT_MIN_DWELL_MIN. Leaving sooner is a drive-by and
// clears arrivedAt, so a stop isn't counted because the truck passed it on the
// way to another one.
//
// Env:
//   STOP_VISITS_ENABLED         "false" = off
//   STOP_VISIT_RADIUS_M         default 150
//   STOP_VISIT_MIN_DWELL_MIN    default 2
//   STOP_VISIT_MAX_ACCURACY_M   fixes less accurate than this are ignored, default 100

const TruckRoute = require("../models/TruckRoute");

const cfg = () => ({
  enabled: process.env.STOP_VISITS_ENABLED !== "false",
  radiusM: Number(process.env.STOP_VISIT_RADIUS_M) || 150,
  dwellMs: (Number(process.env.STOP_VISIT_MIN_DWELL_MIN) || 2) * 60 * 1000,
  maxAccuracyM: Number(process.env.STOP_VISIT_MAX_ACCURACY_M) || 100,
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
 * @returns {Promise<Array<{ routeId, docEntry, arrivedAt, departedAt }>>} stops that changed
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
    if (stop.departedAt) continue; // already visited
    const pos = stop.coordinates;
    if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) continue;

    const inside = distanceM(fix, pos) <= c.radiusM;
    const before = { arrivedAt: stop.arrivedAt?.getTime(), departedAt: stop.departedAt?.getTime() };

    if (inside) {
      if (!stop.arrivedAt) stop.arrivedAt = at;
    } else if (stop.arrivedAt && at > stop.arrivedAt) {
      if (at - stop.arrivedAt >= c.dwellMs) stop.departedAt = at;
      else stop.arrivedAt = undefined; // left too soon: a drive-by
    }

    if (before.arrivedAt !== stop.arrivedAt?.getTime() || before.departedAt !== stop.departedAt?.getTime()) {
      changed.push({
        routeId: String(route._id),
        docEntry: stop.order?.DocEntry,
        arrivedAt: stop.arrivedAt,
        departedAt: stop.departedAt,
      });
    }
  }

  if (changed.length > 0) await route.save();
  return changed;
}

module.exports = { processFix, distanceM };
