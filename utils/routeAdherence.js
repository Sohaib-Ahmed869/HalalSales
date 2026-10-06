// utils/routeAdherence.js
//
// Planned vs actual for one truck route (pure: no database, no network).
//
// Planned = the route as built in the portal: departure time, each stop's ETA
// and time allowance, the return time and the km. Actual = the truck's GPS
// breadcrumb for that day (MyGeotab). The result says when the truck really
// left, reached and left each stop and got back, and lists the deviations:
//
//   late_departure     left the depot later than planned
//   late_stop          reached a stop later than planned
//   long_stop          stayed at a stop well beyond its allowance
//   missed_stop        never stopped at a planned stop
//   out_of_order       visited the stops in another order than planned
//   unexplained_stop   parked for a long time away from every planned stop
//   off_route          drove away from the planned road for a while
//   extra_distance     drove clearly more km than planned
//   late_return        got back to the depot later than planned
//   not_returned       hasn't come back although the planned return is long past
//
// All times are minutes from midnight of the route's day on the depot's clock
// (the same clock as etaMin), so they can pass 1440 for a return after midnight.

const defaults = () => {
  const n = (name, fallback) => (Number.isFinite(Number(process.env[name])) && process.env[name] !== "" ? Number(process.env[name]) : fallback);
  return {
    stopRadiusM: n("STOP_VISIT_RADIUS_M", 150),
    minDwellMin: n("STOP_VISIT_MIN_DWELL_MIN", 2),
    depotRadiusM: n("ADHERENCE_DEPOT_RADIUS_M", 300),
    lateMin: n("ADHERENCE_LATE_MIN", 10), // later than this = late (departure, stop)
    dwellOverMin: n("ADHERENCE_DWELL_OVER_MIN", 10), // beyond the allowance by this = long stop
    unexplainedStopMin: n("ADHERENCE_UNEXPLAINED_STOP_MIN", 30),
    stationaryM: n("ADHERENCE_STATIONARY_M", 80),
    offRouteM: n("ADHERENCE_OFFROUTE_M", 400),
    offRouteEstimateM: n("ADHERENCE_OFFROUTE_ESTIMATE_M", 1500), // when only straight lines are known
    offRouteMin: n("ADHERENCE_OFFROUTE_MIN", 5),
    lateReturnMin: n("ADHERENCE_LATE_RETURN_MIN", 15),
    extraKmFactor: n("ADHERENCE_EXTRA_KM_FACTOR", 1.15),
    extraKmMin: n("ADHERENCE_EXTRA_KM_MIN", 5),
  };
};

const R = 6371000;
const rad = Math.PI / 180;

function distanceM(a, b) {
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Distance from p to a line of [lat, lng] points, on a local flat projection
// (accurate to well under a metre over the distances that matter here).
function makeLineDistance(line) {
  if (!line || line.length < 2) return null;
  const lat0 = line[0][0] * rad;
  const kx = Math.cos(lat0) * R * rad;
  const ky = R * rad;
  const xs = line.map((q) => q[1] * kx);
  const ys = line.map((q) => q[0] * ky);
  return (p) => {
    const px = p.lng * kx;
    const py = p.lat * ky;
    let best = Infinity;
    for (let i = 0; i < xs.length - 1; i++) {
      const dx = xs[i + 1] - xs[i];
      const dy = ys[i + 1] - ys[i];
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : ((px - xs[i]) * dx + (py - ys[i]) * dy) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = xs[i] + t * dx - px;
      const ey = ys[i] + t * dy - py;
      const d2 = ex * ex + ey * ey;
      if (d2 < best) best = d2;
    }
    return Math.sqrt(best);
  };
}

// Keeps at most `max` points of a long road line (enough for a 400 m test).
function thin(line, max = 1500) {
  if (!line || line.length <= max) return line;
  const step = Math.ceil(line.length / max);
  const out = line.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== line[line.length - 1]) out.push(line[line.length - 1]);
  return out;
}

const fmt = (min) => {
  if (!Number.isFinite(min)) return "?";
  const m = Math.round(min);
  return `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(((m % 60) + 60) % 60).padStart(2, "0")}`;
};
const mins = (n) => `${Math.round(n)} min`;
const dist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

/**
 * @param {Object} input
 * @param {Object} input.depot           { lat, lng }
 * @param {number} input.departureMin    planned departure
 * @param {number} input.plannedReturnMin
 * @param {number} input.plannedKm
 * @param {Array}  input.stops           planned order: [{ docEntry, name, seq, lat, lng, etaMin, waitMin, serviceMin }]
 * @param {Array}  input.points          GPS fixes sorted by time: [{ lat, lng, t (minutes on the depot clock), speedKmh }]
 * @param {Array}  [input.plannedLine]   road line [[lat, lng], ...]; without it straight lines between the stops are used
 * @param {number} [input.nowMin]        "now" on the same clock (to tell "not yet" from "missed")
 * @param {Object} [input.config]        overrides of the thresholds above
 */
function analyzeRoute({ depot, departureMin, plannedReturnMin, plannedKm, stops, points, plannedLine, nowMin, config = {} }) {
  const c = { ...defaults(), ...config };
  const deviations = [];
  const add = (type, severity, atMin, message, extra = {}) => deviations.push({ type, severity, atMin: Math.round(atMin), message, ...extra });

  const planned = {
    departureMin,
    returnMin: plannedReturnMin,
    km: plannedKm,
    stops: stops.length,
  };
  const stopRows = stops.map((s) => ({
    docEntry: s.docEntry,
    name: s.name,
    seq: s.seq,
    plannedArrivalMin: Number.isFinite(s.etaMin) ? s.etaMin - (s.waitMin || 0) : null,
    allowanceMin: (s.serviceMin || 0) + (s.waitMin || 0),
    actualArrivalMin: null,
    actualLeaveMin: null,
    dwellMin: null,
    deltaMin: null,
    status: "pending",
  }));

  const pts = (points || []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(p.t));
  if (pts.length < 2) {
    return { status: "no_data", planned, actual: { points: pts.length }, stops: stopRows, deviations, summary: summarize(stopRows, deviations) };
  }

  const dayOver = Number.isFinite(nowMin) ? nowMin > plannedReturnMin + c.lateReturnMin : true;
  const nearDepot = pts.map((p) => distanceM(p, depot) <= c.depotRadiusM);

  // --- Departure: the first fix away from the depot. If the fix just before
  // it was at the depot only a few minutes earlier, that one is the departure.
  let depIdx = nearDepot.findIndex((near) => !near);
  if (depIdx === -1) {
    // Never left the depot.
    const late = dayOver || (Number.isFinite(nowMin) && nowMin > departureMin + c.lateMin);
    if (late) add("late_departure", "high", departureMin, `Truck has not left the depot (planned ${fmt(departureMin)}).`);
    stopRows.forEach((r) => (r.status = dayOver ? "missed" : "pending"));
    if (dayOver) stopRows.forEach((r) => add("missed_stop", "high", r.plannedArrivalMin ?? departureMin, `Stop ${r.seq} ${r.name}: the truck never came here.`, { docEntry: r.docEntry }));
    return {
      status: dayOver ? "completed" : "not_started",
      planned,
      actual: { points: pts.length, departureMin: null, returnMin: null, km: 0 },
      stops: stopRows,
      deviations,
      summary: summarize(stopRows, deviations),
    };
  }
  let actualDeparture = pts[depIdx].t;
  if (depIdx > 0 && pts[depIdx].t - pts[depIdx - 1].t <= 10) actualDeparture = pts[depIdx - 1].t;
  const departureKnown = depIdx > 0; // the truck was seen at the depot first
  if (departureKnown && actualDeparture - departureMin > c.lateMin) {
    add("late_departure", "medium", actualDeparture, `Left the depot at ${fmt(actualDeparture)}, ${mins(actualDeparture - departureMin)} later than planned (${fmt(departureMin)}).`, {
      delayMin: Math.round(actualDeparture - departureMin),
    });
  }

  // --- Stop visits: the first stay of at least minDwellMin inside the radius.
  const lastT = pts[pts.length - 1].t;
  stops.forEach((s, k) => {
    const row = stopRows[k];
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) return;
    let i = depIdx;
    let driveBy = false;
    while (i < pts.length) {
      if (distanceM(pts[i], s) > c.stopRadiusM) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < pts.length && distanceM(pts[j + 1], s) <= c.stopRadiusM) j++;
      const stillThere = j === pts.length - 1;
      const leave = stillThere ? null : pts[j + 1].t;
      const dwell = (leave ?? lastT) - pts[i].t;
      if (dwell >= c.minDwellMin || stillThere) {
        row.actualArrivalMin = Math.round(pts[i].t);
        row.actualLeaveMin = leave == null ? null : Math.round(leave);
        row.dwellMin = Math.round(dwell);
        break;
      }
      driveBy = true;
      i = j + 1;
    }
    row.droveBy = row.actualArrivalMin == null && driveBy;
  });

  stopRows.forEach((r) => {
    if (r.actualArrivalMin == null) {
      r.status = dayOver ? "missed" : "pending";
      if (dayOver) {
        add("missed_stop", "high", r.plannedArrivalMin ?? departureMin, `Stop ${r.seq} ${r.name}: the truck never stopped here${r.droveBy ? " (it only drove past)" : ""}.`, {
          docEntry: r.docEntry,
        });
      }
      return;
    }
    if (r.plannedArrivalMin != null) {
      r.deltaMin = r.actualArrivalMin - r.plannedArrivalMin;
      r.status = r.deltaMin > c.lateMin ? "late" : r.deltaMin < -c.lateMin ? "early" : "on_time";
      if (r.status === "late") {
        add("late_stop", r.deltaMin > 30 ? "high" : "medium", r.actualArrivalMin, `Stop ${r.seq} ${r.name}: arrived ${fmt(r.actualArrivalMin)}, ${mins(r.deltaMin)} late (planned ${fmt(r.plannedArrivalMin)}).`, {
          docEntry: r.docEntry,
          delayMin: r.deltaMin,
        });
      }
    } else {
      r.status = "on_time";
    }
    if (r.actualLeaveMin != null && r.dwellMin > r.allowanceMin + c.dwellOverMin) {
      add("long_stop", r.dwellMin > r.allowanceMin + 30 ? "high" : "medium", r.actualArrivalMin, `Stop ${r.seq} ${r.name}: stayed ${mins(r.dwellMin)}, allowance was ${mins(r.allowanceMin)}.`, {
        docEntry: r.docEntry,
        durationMin: r.dwellMin,
      });
    }
  });

  // --- Order of the visits.
  const visited = stopRows.filter((r) => r.actualArrivalMin != null);
  const actualOrder = visited.slice().sort((a, b) => a.actualArrivalMin - b.actualArrivalMin || a.seq - b.seq);
  if (actualOrder.some((r, i) => i > 0 && r.seq < actualOrder[i - 1].seq)) {
    add("out_of_order", "medium", actualOrder[0].actualArrivalMin, `Stops visited in a different order: ${actualOrder.map((r) => r.seq).join(", ")} (planned ${visited.map((r) => r.seq).join(", ")}).`, {
      actualOrder: actualOrder.map((r) => r.seq),
    });
  }

  // --- Return: back at the depot after the last visited stop (or, with no
  // stop visited, after having been away from it).
  const lastLeave = visited.reduce((m, r) => Math.max(m, r.actualLeaveMin ?? r.actualArrivalMin), actualDeparture);
  let retIdx = -1;
  for (let i = depIdx + 1; i < pts.length; i++) {
    if (nearDepot[i] && pts[i].t >= lastLeave) {
      retIdx = i;
      break;
    }
  }
  const allSeen = visited.length === stopRows.length;
  // Coming back with stops still open only counts as the return once the day is over.
  const returned = retIdx !== -1 && (allSeen || dayOver);
  const actualReturn = returned ? pts[retIdx].t : null;
  if (returned && actualReturn - plannedReturnMin > c.lateReturnMin) {
    add("late_return", actualReturn - plannedReturnMin > 60 ? "high" : "medium", actualReturn, `Back at the depot at ${fmt(actualReturn)}, ${mins(actualReturn - plannedReturnMin)} later than planned (${fmt(plannedReturnMin)}).`, {
      delayMin: Math.round(actualReturn - plannedReturnMin),
    });
  } else if (!returned && dayOver && Number.isFinite(nowMin) && nowMin - plannedReturnMin > 60) {
    add("not_returned", "high", plannedReturnMin, `Not back at the depot yet; planned return was ${fmt(plannedReturnMin)}.`);
  }
  const endIdx = returned ? retIdx : pts.length - 1;

  // --- Distance driven between departure and return (GPS jitter while parked ignored).
  let metres = 0;
  for (let i = Math.max(depIdx, 1); i <= endIdx; i++) {
    const d = distanceM(pts[i - 1], pts[i]);
    if (d >= 15) metres += d;
  }
  const actualKm = Math.round(metres / 100) / 10;
  if (returned && plannedKm > 0 && actualKm > plannedKm * c.extraKmFactor && actualKm - plannedKm > c.extraKmMin) {
    add("extra_distance", "medium", actualReturn, `Drove ${actualKm} km, planned ${plannedKm} km (+${Math.round(actualKm - plannedKm)} km).`, {
      extraKm: Math.round((actualKm - plannedKm) * 10) / 10,
    });
  }

  // --- Planned line to measure "off route" against.
  const straight = [[depot.lat, depot.lng], ...stops.filter((s) => Number.isFinite(s.lat)).map((s) => [s.lat, s.lng]), [depot.lat, depot.lng]];
  const hasRoad = Array.isArray(plannedLine) && plannedLine.length > 1;
  const lineDistance = makeLineDistance(hasRoad ? thin(plannedLine) : straight);
  const offLimit = hasRoad ? c.offRouteM : c.offRouteEstimateM;
  const off = pts.map((p, i) => (i >= depIdx && i <= endIdx && lineDistance ? lineDistance(p) : 0));

  // --- Long stops away from every planned stop.
  const stopPoints = stops.filter((s) => Number.isFinite(s.lat));
  const unexplained = []; // index ranges, so they aren't also reported as off-route driving
  for (let i = depIdx; i < endIdx; ) {
    let j = i;
    while (j + 1 <= endIdx && distanceM(pts[j + 1], pts[i]) <= c.stationaryM) j++;
    const duration = pts[j].t - pts[i].t;
    if (j > i && duration >= c.unexplainedStopMin) {
      const here = pts[i];
      const atDepot = distanceM(here, depot) <= c.depotRadiusM;
      const atStop = stopPoints.some((s) => distanceM(here, s) <= c.stopRadiusM + 50);
      if (!atDepot && !atStop) {
        const offRoute = off[i] > offLimit;
        unexplained.push([i, j]);
        add("unexplained_stop", duration >= 60 ? "high" : "medium", here.t, `Parked ${mins(duration)} from ${fmt(here.t)} to ${fmt(pts[j].t)} at a place that is not a planned stop${offRoute ? `, ${dist(off[i])} off the planned route` : ""}.`, {
          durationMin: Math.round(duration),
          lat: here.lat,
          lng: here.lng,
          offRouteM: Math.round(off[i]),
        });
      }
    }
    i = j > i ? j : i + 1;
  }

  // --- Driving away from the planned road.
  const inUnexplained = (i) => unexplained.some(([a, b]) => i >= a && i <= b);
  for (let i = depIdx; i <= endIdx; ) {
    if (off[i] <= offLimit) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 <= endIdx && off[j + 1] > offLimit) j++;
    const duration = pts[j].t - pts[i].t;
    let km = 0;
    let far = i;
    for (let k = i; k <= j; k++) {
      if (k > i) km += distanceM(pts[k - 1], pts[k]) / 1000;
      if (off[k] > off[far]) far = k;
    }
    const parkedOnly = inUnexplained(i) && inUnexplained(j);
    if (!parkedOnly && duration >= c.offRouteMin) {
      add("off_route", off[far] > 2000 || duration >= 30 ? "high" : "medium", pts[i].t, `Off the planned route for ${mins(duration)} from ${fmt(pts[i].t)} to ${fmt(pts[j].t)} (${Math.round(km * 10) / 10} km, up to ${dist(off[far])} away).`, {
        durationMin: Math.round(duration),
        maxOffRouteM: Math.round(off[far]),
        km: Math.round(km * 10) / 10,
        lat: pts[far].lat,
        lng: pts[far].lng,
      });
    }
    i = j + 1;
  }

  deviations.sort((a, b) => a.atMin - b.atMin);
  return {
    status: returned ? "completed" : "in_progress",
    planned,
    actual: {
      points: pts.length,
      departureMin: departureKnown ? Math.round(actualDeparture) : null,
      firstSeenMin: Math.round(pts[0].t),
      returnMin: actualReturn == null ? null : Math.round(actualReturn),
      km: actualKm,
      lineSource: hasRoad ? "road" : "estimate",
    },
    stops: stopRows,
    deviations,
    summary: summarize(stopRows, deviations),
  };
}

function summarize(stopRows, deviations) {
  const visited = stopRows.filter((r) => r.actualArrivalMin != null);
  const onTime = visited.filter((r) => r.status === "on_time" || r.status === "early").length;
  return {
    stops: stopRows.length,
    visited: visited.length,
    onTime,
    late: visited.filter((r) => r.status === "late").length,
    missed: stopRows.filter((r) => r.status === "missed").length,
    onTimePercent: visited.length > 0 ? Math.round((onTime / visited.length) * 100) : null,
    deviations: deviations.length,
    high: deviations.filter((d) => d.severity === "high").length,
  };
}

module.exports = { analyzeRoute, distanceM, defaults };
