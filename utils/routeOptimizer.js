// utils/routeOptimizer.js
//
// Implements the CVRPTW heuristic described in implementation.md section 6:
//   - real road distance/duration from a precomputed matrix (built by
//     utils/roadDistanceService.js from OSRM) when one is passed in; otherwise
//     haversine distance x a road-distance factor as the fallback estimate, so
//     route generation keeps working when the routing engine is unreachable
//   - cheapest time-window-feasible insertion for stop sequencing (NOT
//     nearest-neighbor, which is what produces "drive past a shop, serve a
//     farther one, then come back" — the exact failure mode being fixed)
//   - 2-opt local search to remove any residual backtracking
//
// Pure functions, no DB access — callers pass in plain stop objects and get
// a sequenced route back.

const ROAD_DISTANCE_FACTOR = 1.3; // straight-line -> approximate road distance
const DEFAULT_SPEED_KMH = 40; // used to turn distance into a duration estimate
// Time budget for the cross-truck improvement search. It is a polish step on
// top of an already-valid assignment, so stopping early is always safe; the
// budget keeps Auto-Fill inside typical HTTP/proxy timeouts on large days.
const DEFAULT_IMPROVE_BUDGET_MS = Number(process.env.ROUTE_IMPROVE_BUDGET_MS) > 0 ? Number(process.env.ROUTE_IMPROVE_BUDGET_MS) : 8000;
const DEFAULT_DEPARTURE_MIN = 8 * 60; // 08:00, when a route has no departure time of its own

// How long one run of a truck may take, depot to depot.
//   ROUTE_MAX_DURATION_MIN  longest run (driving, waiting and time at the
//                           stops), default 540 = 9 hours
//   RUN_TURNAROUND_MIN      when the same vehicle does another run later that
//                           day: minutes it needs at the depot in between
//                           (unload, reload), default 30
// The limit is soft. No order is left off a truck because of it; it stops the
// planner from cramming a day's work into too few vehicles and makes it use
// another run or vehicle instead.
const positiveEnv = (name, fallback) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);
const routeMaxDurationMin = () => positiveEnv("ROUTE_MAX_DURATION_MIN", 540);
const runTurnaroundMin = () => positiveEnv("RUN_TURNAROUND_MIN", 30);

/**
 * Longest a run leaving at `departureMin` may take: the general limit, and
 * back in time for the same vehicle's next run when it has one.
 */
function maxRunDurationMin(departureMin, nextDepartureMin = null) {
  let limit = routeMaxDurationMin();
  if (Number.isFinite(nextDepartureMin) && nextDepartureMin > departureMin) {
    limit = Math.min(limit, Math.max(15, nextDepartureMin - runTurnaroundMin() - departureMin));
  }
  return limit;
}

// Minutes spent at each stop (unloading, paperwork, signature) before the
// truck can drive on. Without it every later ETA drifts earlier by the sum of
// all previous stops. Override globally with STOP_SERVICE_MIN, or per stop
// with a `serviceMin` field on the stop object.
const envServiceMin = process.env.STOP_SERVICE_MIN;
const DEFAULT_SERVICE_MIN =
  envServiceMin != null && envServiceMin !== "" && Number.isFinite(Number(envServiceMin))
    ? Math.max(0, Number(envServiceMin))
    : 15;

function serviceOf(stop) {
  if (!stop || stop === "DEPOT") return 0;
  return Number.isFinite(stop.serviceMin) && stop.serviceMin >= 0 ? stop.serviceMin : DEFAULT_SERVICE_MIN;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

// Distance in km between two {lat,lng} points.
function haversineKm(a, b) {
  if (!a || !b) return Infinity;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return R * c;
}

function roadKm(a, b) {
  return haversineKm(a, b) * ROAD_DISTANCE_FACTOR;
}

function durationMin(distanceKm, speedKmh = DEFAULT_SPEED_KMH) {
  if (!speedKmh) speedKmh = DEFAULT_SPEED_KMH;
  return (distanceKm / speedKmh) * 60;
}

// Stable key for a coordinate, shared with roadDistanceService so both sides
// agree on which matrix row/column a point maps to (5 decimals ~ 1 metre).
function pointKey(p) {
  return `${Number(p.lat).toFixed(5)},${Number(p.lng).toFixed(5)}`;
}

/**
 * Builds the distance/duration lookups the optimizer uses. With a `matrix`
 * ({ index: Map<pointKey, i>, distKm[][], durMin[][] }) every leg between two
 * known points is a real road distance/time; any leg it doesn't know about
 * (or all legs, when matrix is null) falls back to the haversine estimate.
 * Point -> index lookups are memoized by object identity because the 2-opt
 * and cross-route loops call this millions of times.
 */
function makeLegs(matrix, speedKmh) {
  const idxCache = new WeakMap();
  const idxOf = (p) => {
    if (!p || typeof p !== "object") return undefined;
    let i = idxCache.get(p);
    if (i === undefined) {
      i = Number.isFinite(p.lat) && Number.isFinite(p.lng) ? matrix.index.get(pointKey(p)) : undefined;
      idxCache.set(p, i === undefined ? -1 : i);
      return i === undefined ? -1 : i;
    }
    return i;
  };
  const lookup = (a, b) => {
    if (!matrix) return null;
    const i = idxOf(a);
    const j = idxOf(b);
    if (i === undefined || j === undefined || i < 0 || j < 0) return null;
    const km = matrix.distKm[i][j];
    const min = matrix.durMin[i][j];
    return Number.isFinite(km) && Number.isFinite(min) ? { km, min } : null;
  };
  return {
    km(a, b) {
      const leg = lookup(a, b);
      return leg ? leg.km : roadKm(a, b);
    },
    min(a, b) {
      const leg = lookup(a, b);
      return leg ? leg.min : durationMin(roadKm(a, b), speedKmh);
    },
  };
}

// Parses "HH:MM" into minutes-from-midnight. Returns null if unparseable.
function parseTimeToMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== "string") return null;
  // "HH:MM", also tolerating "HH:MM:SS" and "H:MM AM/PM" as they turn up in
  // customer records; anything else is "no time known", never a guess.
  const match = hhmm.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)?$/i);
  if (!match) return null;
  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const meridiem = match[3] ? match[3].toLowerCase() : null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === "pm" ? 12 : 0);
  }
  if (minutes > 59 || hours > 24 || (hours === 24 && minutes !== 0)) return null;
  return hours * 60 + minutes;
}

/**
 * Turns a shop's opening/closing strings into the { windowOpen, windowClose }
 * minutes the optimizer uses, on one continuous clock that may run past 24:00.
 * A closing time at or before the opening time means the shop closes after
 * midnight: "18:00-02:00" -> 1080..1560, "11:00-00:00" -> 660..1440, and
 * "00:00-00:00" (open all day) -> 0..1440. Without this, closing "00:00"
 * parsed to minute 0 and every stop for that customer was flagged as late.
 * A closing time with no opening time known is treated the same way only for
 * "00:00" (midnight), since nothing else about it can be inferred.
 */
function parseTimeWindow(openingTime, closingTime) {
  const windowOpen = parseTimeToMinutes(openingTime);
  let windowClose = parseTimeToMinutes(closingTime);
  if (windowClose != null) {
    if (windowOpen != null && windowClose <= windowOpen) windowClose += 24 * 60;
    else if (windowOpen == null && windowClose === 0) windowClose = 24 * 60;
  }
  return { windowOpen, windowClose };
}

/**
 * The time window a stop is planned for. A customer's preferred delivery
 * window (storeHours.preferredFrom / preferredTo), when given, narrows the
 * shop's opening hours; customers without one are planned on opening hours
 * alone, as before. A preferred window that doesn't overlap the opening hours
 * is used as given (the customer asked for it).
 *
 * @param {Object} hours - { openingTime, closingTime, preferredFrom, preferredTo }
 * @returns {{ windowOpen: number|null, windowClose: number|null, shopClose: number|null, hasPreferred: boolean }}
 */
function stopWindow(hours = {}) {
  const shop = parseTimeWindow(hours?.openingTime, hours?.closingTime);
  const pref = parseTimeWindow(hours?.preferredFrom, hours?.preferredTo);
  if (pref.windowOpen == null && pref.windowClose == null) {
    return { windowOpen: shop.windowOpen, windowClose: shop.windowClose, shopClose: shop.windowClose, hasPreferred: false };
  }
  let windowOpen = pref.windowOpen;
  let windowClose = pref.windowClose;
  if (shop.windowOpen != null) windowOpen = windowOpen == null ? shop.windowOpen : Math.max(windowOpen, shop.windowOpen);
  if (shop.windowClose != null) windowClose = windowClose == null ? shop.windowClose : Math.min(windowClose, shop.windowClose);
  if (windowOpen != null && windowClose != null && windowClose < windowOpen) {
    windowOpen = pref.windowOpen;
    windowClose = pref.windowClose;
  }
  return { windowOpen, windowClose, shopClose: shop.windowClose, hasPreferred: true };
}

// ---------- Load: weight and volume ----------
// A stop carries weightKg and, when SAP has the items' volumes, volumeM3. A
// truck carries capacityKg and optionally capacityM3. Both limits must hold.
// A truck without a volume capacity has no volume limit, so nothing changes
// until volumes are entered; a stop without a volume takes no room.
const kgOf = (s) => (s && s.weightKg) || 0;
const m3Of = (s) => (s && s.volumeM3) || 0;
const VOLUME_EPS = 1e-9; // m³ sums like 0.1 + 0.2
const hasVolumeLimit = (capacityM3) => Number.isFinite(capacityM3) && capacityM3 > 0;

/** { kg, m3 } carried by a list of stops. */
function loadOf(stops) {
  let kg = 0;
  let m3 = 0;
  for (const s of stops) {
    kg += kgOf(s);
    m3 += m3Of(s);
  }
  return { kg, m3 };
}

/** Does `stop` still fit next to `used` ({ kg, m3 }) on a truck of capacityKg / capacityM3? */
function fitsLoad(used, stop, capacityKg, capacityM3) {
  if (used.kg + kgOf(stop) > capacityKg) return false;
  return !hasVolumeLimit(capacityM3) || used.m3 + m3Of(stop) <= capacityM3 + VOLUME_EPS;
}

/**
 * Which limit keeps a load out of every truck: "weight", "volume" or "both"
 * (each limit alone has a truck with room, but no truck has room for both).
 * @param {Array} rooms - [{ kg, m3 }] room left per truck (m3 Infinity = no volume limit)
 */
function blockingLimit(rooms, load) {
  const kgOk = rooms.some((r) => r.kg >= load.kg);
  const m3Ok = rooms.some((r) => r.m3 + VOLUME_EPS >= load.m3);
  if (!kgOk && m3Ok) return "weight";
  if (kgOk && !m3Ok) return "volume";
  return "both";
}

/**
 * Sweep-clusters stops by polar angle around the depot, splitting whenever
 * adding the next stop would exceed the given capacity (kg, and m³ when
 * capacityM3 is given). Produces the fewest geographically-coherent clusters
 * that fit within capacity.
 *
 * @param {Array} stops - [{ id, coordinates: {lat,lng}, weightKg, volumeM3 }]
 * @param {Object} depot - { lat, lng }
 * @param {number} capacityKg
 * @param {number} [capacityM3] - no volume limit when not a positive number
 * @returns {Array<Array>} clusters of stops
 */
function sweepCluster(stops, depot, capacityKg, capacityM3) {
  const withAngle = stops
    .filter((s) => s.coordinates && Number.isFinite(s.coordinates.lat) && Number.isFinite(s.coordinates.lng))
    .map((s) => {
      const angle = Math.atan2(
        s.coordinates.lat - depot.lat,
        s.coordinates.lng - depot.lng
      );
      return { ...s, _angle: angle };
    })
    .sort((a, b) => a._angle - b._angle);

  const clusters = [];
  let current = [];
  let load = { kg: 0, m3: 0 };

  for (const stop of withAngle) {
    if (current.length > 0 && !fitsLoad(load, stop, capacityKg, capacityM3)) {
      clusters.push(current);
      current = [];
      load = { kg: 0, m3: 0 };
    }
    current.push(stop);
    load.kg += kgOf(stop);
    load.m3 += m3Of(stop);
  }
  if (current.length > 0) clusters.push(current);

  return clusters;
}

/**
 * Distance-aware alternative to sweepCluster: groups stops that are close
 * together instead of cutting an angle-sorted list at the capacity limit.
 *
 * Repeatedly takes the unassigned stop farthest from the depot as a seed and
 * grows a cluster around it by adding the unassigned stop nearest to the
 * cluster's centre, until the next nearest stop would not fit the capacity.
 * Far patches are formed first so the awkward ones get compact groups and the
 * leftovers near the depot fill the last cluster.
 *
 * sweepCluster only looks at the direction from the depot, so stops in the
 * same direction but at different distances get interleaved, and the capacity
 * cut can separate two neighbours. This does not have that weakness; it can
 * however use a truck more, since compact patches do not divide by weight as
 * neatly as an angle sweep does.
 *
 * @param {Array} stops - [{ id, coordinates: {lat,lng}, weightKg, volumeM3 }]
 * @param {Object} depot - { lat, lng }
 * @param {number} capacityKg
 * @param {number} [capacityM3] - as in sweepCluster
 * @returns {Array<Array>} clusters of stops (same shape as sweepCluster)
 */
function proximityCluster(stops, depot, capacityKg, capacityM3) {
  const pool = stops.filter(
    (s) => s.coordinates && Number.isFinite(s.coordinates.lat) && Number.isFinite(s.coordinates.lng)
  );
  const clusters = [];

  while (pool.length > 0) {
    // Seed: farthest from the depot.
    let seedIdx = 0;
    let seedDist = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const d = haversineKm(depot, pool[i].coordinates);
      if (d > seedDist) {
        seedDist = d;
        seedIdx = i;
      }
    }
    const seed = pool.splice(seedIdx, 1)[0];
    const cluster = [seed];
    const load = { kg: kgOf(seed), m3: m3Of(seed) };
    let sumLat = seed.coordinates.lat;
    let sumLng = seed.coordinates.lng;

    // Grow: nearest stop to the cluster's centre that still fits.
    for (;;) {
      const centre = { lat: sumLat / cluster.length, lng: sumLng / cluster.length };
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < pool.length; i++) {
        if (!fitsLoad(load, pool[i], capacityKg, capacityM3)) continue;
        const d = haversineKm(centre, pool[i].coordinates);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) break;
      const next = pool.splice(bestIdx, 1)[0];
      cluster.push(next);
      load.kg += kgOf(next);
      load.m3 += m3Of(next);
      sumLat += next.coordinates.lat;
      sumLng += next.coordinates.lng;
    }
    clusters.push(cluster);
  }

  return clusters;
}

/**
 * Sequences a set of stops for one truck using cheapest time-window-feasible
 * insertion, then improves the result with 2-opt swaps.
 *
 * Two strategies, because they can genuinely disagree: the shortest-distance
 * route sometimes means a truck sits idle waiting for a shop to open, while
 * the route that avoids waiting sometimes drives more total distance to do
 * it. Every comparison during construction and 2-opt uses whichever cost the
 * chosen strategy cares about — not just a label applied after the fact.
 *
 * @param {Array} stops - [{ id, coordinates, windowOpen, windowClose, ...any extra fields kept as-is }]
 * @param {Object} depot - { lat, lng }
 * @param {number} departureMin - minutes-from-midnight the truck leaves the depot
 * @param {number} speedKmh
 * @param {"shortest"|"least_wait"} strategy - "shortest" (default) minimizes
 *   total driving distance, tolerating idle wait time if that's the shorter
 *   route. "least_wait" minimizes total elapsed time (driving + waiting
 *   combined) instead, even when that means more distance.
 * @param {Object|null} matrix - optional road distance matrix (see makeLegs)
 * @returns {Object} { sequence: [stop...with seq/etaMin/infeasible], totalDistanceKm, totalDurationMin, totalWaitMin, strategy }
 */
function sequenceRoute(stops, depot, departureMin = DEFAULT_DEPARTURE_MIN, speedKmh = DEFAULT_SPEED_KMH, strategy = "shortest", matrix = null) {
  const legs = makeLegs(matrix, speedKmh);
  // Copies, so the _infeasible flag set below never leaks onto the caller's
  // stop objects (crossRouteImprove re-evaluates the same stops many times).
  const geocoded = stops
    .filter((s) => s.coordinates && Number.isFinite(s.coordinates.lat) && Number.isFinite(s.coordinates.lng))
    .map((s) => ({ ...s }));

  if (geocoded.length === 0) {
    return { sequence: [], totalDistanceKm: 0, totalDurationMin: 0, totalWaitMin: 0, strategy };
  }

  // --- Construction: cheapest time-window-feasible insertion ---
  const point = (s) => (s === "DEPOT" ? depot : s.coordinates);

  // Seed with the farthest stop from the depot.
  let seedIdx = 0;
  let seedDist = -Infinity;
  geocoded.forEach((s, i) => {
    const d = legs.km(depot, s.coordinates);
    if (d > seedDist) {
      seedDist = d;
      seedIdx = i;
    }
  });

  let route = ["DEPOT", geocoded[seedIdx], "DEPOT"];
  const remaining = geocoded.filter((_, i) => i !== seedIdx);

  // Computes the timeline of a route: drive to the stop, WAIT if the shop
  // isn't open yet, serve the stop (service time), then drive on. `arrival`
  // is when service can begin (after any wait). Both the wait and the service
  // time advance the clock, so they push back every later stop's ETA and the
  // time the truck gets home — a truck held at one shop reaches the next late.
  function computeArrivals(candidateRoute) {
    let clock = departureMin;
    const arrivals = [];
    for (let i = 1; i < candidateRoute.length; i++) {
      const prev = point(candidateRoute[i - 1]);
      const cur = point(candidateRoute[i]);
      const dist = legs.km(prev, cur);
      const driveMin = legs.min(prev, cur);
      clock += driveMin;
      const stop = candidateRoute[i];
      let waitMin = 0;
      if (stop !== "DEPOT" && stop.windowOpen != null && clock < stop.windowOpen) {
        waitMin = stop.windowOpen - clock;
        clock = stop.windowOpen; // wait for opening
      }
      const arrival = clock;
      const serviceMin = serviceOf(stop);
      clock += serviceMin;
      arrivals.push({ stop, arrival, distFromPrev: dist, driveMin, waitMin, serviceMin });
    }
    return arrivals;
  }

  // Cost and feasibility of a candidate route in ONE pass with no per-leg
  // allocations. This is the inner loop of insertion and 2-opt (and, through
  // crossRouteImprove, of Auto-Fill), so it must stay cheap: it used to build a
  // full arrivals array three separate times per candidate.
  //
  // "shortest" is distance-first, but a pure distance cost leaves ties
  // (e.g. a simple 2-stop loop costs the *same* total distance regardless of
  // which stop is visited first - it's the same triangle in reverse) to
  // whichever insertion order the search happens to try first. That silently
  // picked the wait-inducing order in exactly that case. Adding a wait
  // component so small it can never outweigh a genuine distance difference
  // (worth ~1 metre of "distance" per minute of waiting) breaks real ties in
  // favour of not waiting, without changing what "shortest" optimizes for.
  //
  // "least_wait" costs total elapsed minutes from departure to the final
  // return leg's arrival - driving, waiting and service time all count, so a
  // route that avoids a long wait scores better even if it drives more km.
  const WAIT_TIEBREAK_KM_PER_MIN = 0.001;
  const leastWait = strategy === "least_wait";
  function evalRoute(candidateRoute) {
    let clock = departureMin;
    let dist = 0;
    let wait = 0;
    let feasible = true;
    for (let i = 1; i < candidateRoute.length; i++) {
      const prev = point(candidateRoute[i - 1]);
      const cur = point(candidateRoute[i]);
      dist += legs.km(prev, cur);
      clock += legs.min(prev, cur);
      const stop = candidateRoute[i];
      if (stop !== "DEPOT") {
        if (stop.windowOpen != null && clock < stop.windowOpen) {
          wait += stop.windowOpen - clock;
          clock = stop.windowOpen; // wait for opening
        }
        if (stop.windowClose != null && clock > stop.windowClose) feasible = false;
        clock += serviceOf(stop);
      }
    }
    return { feasible, cost: leastWait ? clock - departureMin : dist + wait * WAIT_TIEBREAK_KM_PER_MIN };
  }

  while (remaining.length > 0) {
    let bestStopIdx = -1;
    let bestPosition = -1;
    let bestExtraCost = Infinity;

    // Same for every candidate this round - compute once, not per candidate.
    const before = evalRoute(route).cost;

    remaining.forEach((stop, stopIdx) => {
      for (let pos = 1; pos < route.length; pos++) {
        const candidate = [...route.slice(0, pos), stop, ...route.slice(pos)];
        const evaluated = evalRoute(candidate);
        if (!evaluated.feasible) continue;

        const extraCost = evaluated.cost - before;
        if (extraCost < bestExtraCost) {
          bestExtraCost = extraCost;
          bestStopIdx = stopIdx;
          bestPosition = pos;
        }
      }
    });

    if (bestStopIdx === -1) {
      // No feasible insertion point for any remaining stop within the time
      // windows already committed to - append at the end and flag infeasible
      // rather than silently dropping the delivery.
      const stop = remaining.shift();
      stop._infeasible = true;
      route.splice(route.length - 1, 0, stop);
      continue;
    }

    const stop = remaining.splice(bestStopIdx, 1)[0];
    route.splice(bestPosition, 0, stop);
  }

  // --- Improvement: 2-opt ---
  function twoOptPass(candidateRoute) {
    let improved = true;
    let best = candidateRoute;
    let bestCost = evalRoute(best).cost;
    while (improved) {
      improved = false;
      for (let i = 1; i < best.length - 2; i++) {
        for (let k = i + 1; k < best.length - 1; k++) {
          const reversed = [
            ...best.slice(0, i),
            ...best.slice(i, k + 1).reverse(),
            ...best.slice(k + 1),
          ];
          const evaluated = evalRoute(reversed);
          if (!evaluated.feasible) continue;
          if (evaluated.cost < bestCost - 1e-9) {
            best = reversed;
            bestCost = evaluated.cost;
            improved = true;
          }
        }
      }
    }
    return best;
  }

  route = twoOptPass(route);

  // --- Final arrival/seq annotation ---
  const arrivals = computeArrivals(route);
  const sequence = [];
  let seq = 1;
  let totalDistanceKm = 0;
  let totalWaitMin = 0;
  for (let i = 0; i < arrivals.length; i++) {
    const { stop, arrival, distFromPrev, driveMin, waitMin, serviceMin } = arrivals[i];
    totalDistanceKm += distFromPrev;
    totalWaitMin += waitMin || 0;
    if (stop === "DEPOT") continue;
    sequence.push({
      ...stop,
      seq: seq++,
      etaMin: Math.round(arrival),
      driveMin: Math.round(driveMin),
      legKm: Math.round(distFromPrev * 10) / 10,
      waitMin: Math.round(waitMin || 0),
      serviceMin,
      // The seed stop (farthest from the depot) is placed without a time-window
      // check, so also flag any stop whose final ETA is after it closes.
      infeasible: Boolean(stop._infeasible) || (stop.windowClose != null && arrival > stop.windowClose),
    });
  }

  // totalDurationMin is the real elapsed time (driving + waiting) from
  // departure to the last stop — not just distance/speed, which would
  // understate it whenever the route includes any wait.
  const totalElapsedMin = arrivals.length > 0 ? arrivals[arrivals.length - 1].arrival - departureMin : 0;

  return {
    sequence,
    totalDistanceKm: Math.round(totalDistanceKm * 10) / 10,
    totalDurationMin: Math.round(totalElapsedMin),
    totalWaitMin: Math.round(totalWaitMin),
    strategy,
  };
}

/**
 * Picks the smallest truck (by maxWeightKg, then maxVolumeM3) able to carry
 * the given weight and volume, from a list of candidate trucks. A truck
 * without maxVolumeM3 has no volume limit. Returns null if none fits.
 */
function pickSmallestFittingTruck(trucks, weightKg, volumeM3 = 0) {
  const m3 = (t) => (hasVolumeLimit(t.maxVolumeM3) ? t.maxVolumeM3 : Infinity);
  const sorted = [...trucks].sort((a, b) => a.maxWeightKg - b.maxWeightKg || m3(a) - m3(b));
  return sorted.find((t) => t.maxWeightKg >= weightKg && m3(t) + VOLUME_EPS >= volumeM3) || null;
}

/**
 * Fixes the specific gap sweep-clustering leaves behind: capacity cutoffs
 * split a purely angle-sorted list, so a stop can land on truck A even
 * though it sits right next to truck B's route — "least trucks per area" and
 * "shortest/quickest route" are area-level (sweepCluster) and single-truck
 * (sequenceRoute) properties respectively; neither one looks at whether a
 * stop is actually cheaper on a *different* truck. This is the missing
 * between-truck step: a bounded local search (classic VRP "inter-route
 * relocation") that keeps moving one stop at a time from whichever truck it
 * costs the most to whichever truck it would cost the least, as long as
 * capacity and the stop's time window still hold, until no such move helps
 * or `maxPasses` is reached.
 *
 * @param {Array} trucks - [{ id, capacityKg, capacityM3?, stops: [{ id, coordinates, windowOpen, windowClose, weightKg, volumeM3?, locked, ...anything else to carry through }] }]
 * @param {Object} depot
 * @param {number} speedKmh
 * @param {number} maxPasses
 * @param {"shortest"|"least_wait"} strategy - same meaning as sequenceRoute's:
 *   which metric a move has to improve before it's taken.
 * @param {Object} options - { maxMs } time budget for the search (default 8000, env ROUTE_IMPROVE_BUDGET_MS);
 *   { minimizeVehicles } (default true): never move a stop onto a vehicle that
 *   is not out yet, and afterwards try to do the work with fewer vehicles
 *   (see "Consolidate" below); { relieve } (default true): see "Relieve".
 *   A truck may carry `vehicleId` (runs of one vehicle share it; default its
 *   own id), `maxDurationMin` (longest the run may take door to door, see
 *   maxRunDurationMin; default no limit) and `inUseElsewhere` (the vehicle
 *   has work on a run that is not part of this plan).
 * @returns {Promise<Array>} same shape as input, each truck additionally carrying { sequence, totalDistanceKm, totalDurationMin, totalWaitMin }; the array has `timedOut: true` if the budget ended the search early
 */
async function crossRouteImprove(trucks, depot, speedKmh = DEFAULT_SPEED_KMH, maxPasses = 3, strategy = "shortest", matrix = null, options = {}) {
  const maxMs = Number.isFinite(options.maxMs) ? options.maxMs : DEFAULT_IMPROVE_BUDGET_MS;
  const started = Date.now();
  let lastYield = started;
  const timeUp = () => Date.now() - started > maxMs;
  // Relieving overlong runs and freeing vehicles come after the polish and
  // matter more than it, so they get a little time of their own.
  const hardTimeUp = () => Date.now() - started > maxMs * 1.5 + 1000;
  // Hand control back to the event loop regularly so a big Auto-Fill never
  // freezes the API for everyone else while it thinks.
  const maybeYield = async () => {
    if (Date.now() - lastYield > 15) {
      await new Promise((resolve) => setImmediate(resolve));
      lastYield = Date.now();
    }
  };

  const minimizeVehicles = options.minimizeVehicles !== false;
  const working = trucks.map((t) => ({ ...t, vehicleId: t.vehicleId ?? t.id, stops: t.stops.map((s) => ({ ...s })) }));
  const legs = makeLegs(matrix, speedKmh);

  // How long a run may take door to door, and by how much a duration exceeds it.
  const limitOf = (t) => (Number.isFinite(t.maxDurationMin) ? t.maxDurationMin : Infinity);
  const overOf = (t, durationMin) => Math.max(0, durationMin - limitOf(t));
  const OVER_TOL = 0.5; // minutes
  // A vehicle is in use when any of its runs carries a stop (here or, as the
  // caller says, on a run outside this plan).
  const vehicleInUse = (vehicleId) => working.some((t) => t.vehicleId === vehicleId && (t.stops.length > 0 || t.inUseElsewhere));
  // The polish never opens a vehicle that is not needed today: a stop may go
  // onto an empty run only when that run's vehicle is already out.
  const mayReceive = (to) => !minimizeVehicles || to.stops.length > 0 || vehicleInUse(to.vehicleId);

  // Full sequenceRoute results (cheapest insertion + 2-opt), keyed by
  // (departure, ordered stop ids). Only computed for a truck's CURRENT
  // contents and for the two trucks touched by an accepted move - never per
  // candidate move, which is what made this search take minutes.
  const cache = new Map();
  const evalStops = (stops, departureMin) => {
    const key = `${departureMin}|${stops.map((s) => s.id).join(",")}`;
    let result = cache.get(key);
    if (!result) {
      if (cache.size > 5000) cache.clear();
      result = sequenceRoute(stops, depot, departureMin, speedKmh, strategy, matrix);
      cache.set(key, result);
    }
    return result;
  };

  // Metrics of a route visiting `order` exactly as given (depot -> stops ->
  // depot): same timeline rules as sequenceRoute (wait for opening, service
  // time, closing-time feasibility) but no reordering, so it is O(stops).
  // Unrounded, unlike evaluateFixedRoute, so tiny differences still compare.
  const orderMetrics = (order, departureMin) => {
    let clock = departureMin;
    let dist = 0;
    let late = 0;
    let prev = depot;
    for (const stop of order) {
      const cur = stop.coordinates;
      dist += legs.km(prev, cur);
      clock += legs.min(prev, cur);
      if (stop.windowOpen != null && clock < stop.windowOpen) clock = stop.windowOpen;
      if (stop.windowClose != null && clock > stop.windowClose) late++;
      clock += serviceOf(stop);
      prev = cur;
    }
    dist += legs.km(prev, depot);
    clock += legs.min(prev, depot);
    const elapsedMin = clock - departureMin;
    return { cost: strategy === "least_wait" ? elapsedMin : dist, late, elapsed: elapsedMin };
  };
  const EPSILON = strategy === "least_wait" ? 1 : 0.05; // 1 min or 0.05 km - ignore savings too small to be worth an extra stop-swap

  // The truck's stops in their current best visiting order.
  const orderOf = (truck) => evalStops(truck.stops, truck.departureMin).sequence;
  const weightOfStops = (stops) => stops.reduce((sum, o) => sum + (o.weightKg || 0), 0);
  const lateOf = (result) => result.sequence.filter((x) => x.infeasible).length;
  const elapsed = (result) => result.totalDurationMin;
  const routable = (s) => s.coordinates && Number.isFinite(s.coordinates.lat) && Number.isFinite(s.coordinates.lng);

  let timedOut = false;

  // --- Relocation: one stop at a time to the truck it costs least on ---
  const relocate = async (passes) => {
    let movedAny = true;
    let pass = 0;
    outer: while (movedAny && pass < passes) {
      movedAny = false;
      pass++;

      for (let i = 0; i < working.length; i++) {
        const from = working[i];
        for (const stop of [...from.stops]) {
          if (timeUp()) {
            timedOut = true;
            break outer;
          }
          await maybeYield();
          if (stop.locked) continue;
          if (!routable(stop)) continue; // can't be routed anyway
          // No "leave at least one stop" guard here on purpose: fully draining
          // a near-empty truck into others (an empty route, needed by nobody
          // today) is exactly the "least trucks per area" outcome, not a bug
          // to avoid. An empty TruckRoute is a valid, informative result - it
          // means that scheduled truck genuinely isn't needed today.

          const fromOrder = orderOf(from);
          const removalSavings =
            orderMetrics(fromOrder, from.departureMin ?? DEFAULT_DEPARTURE_MIN).cost -
            orderMetrics(fromOrder.filter((s) => s.id !== stop.id), from.departureMin ?? DEFAULT_DEPARTURE_MIN).cost;
          // A move only happens if inserting costs less than removal saves
          // (minus EPSILON), and an insertion never costs less than ~0 - so a
          // stop whose removal saves next to nothing is not worth moving.
          if (removalSavings <= EPSILON) continue;

          let bestTo = null;
          let bestInsertionCost = Infinity;

          for (let j = 0; j < working.length; j++) {
            if (j === i) continue;
            const to = working[j];
            if (!mayReceive(to)) continue;
            if (!fitsLoad(loadOf(to.stops), stop, to.capacityKg, to.capacityM3)) continue;

            const dep = to.departureMin ?? DEFAULT_DEPARTURE_MIN;
            const toOrder = orderOf(to);
            const base = orderMetrics(toOrder, dep);
            // Cheapest place to slot the stop into the target's current order.
            // The stop itself must arrive in time, no stop already on that
            // truck may become late because of it, and the run must not get
            // (more) over its allowed length.
            for (let k = 0; k <= toOrder.length; k++) {
              const candidate = [...toOrder.slice(0, k), stop, ...toOrder.slice(k)];
              const m = orderMetrics(candidate, dep);
              if (m.late > base.late) continue;
              if (overOf(to, m.elapsed) > overOf(to, base.elapsed) + OVER_TOL) continue;
              const insertionCost = m.cost - base.cost;
              if (insertionCost < bestInsertionCost) {
                bestInsertionCost = insertionCost;
                bestTo = to;
              }
            }
          }

          // The order-preserving estimates above are conservative (a truck can
          // usually re-sequence into something better than "same order plus
          // one stop"), so a move that only narrowly fails them can still be a
          // real improvement. Those get the exact check: full re-sequence of
          // both trucks, the same test this search always used. The cheap
          // estimate only decides which moves are worth that cost.
          if (bestTo) {
            const slack = Math.max(EPSILON * 4, Math.abs(removalSavings) * 0.3);
            if (bestInsertionCost < removalSavings + slack) {
              const cost = (r) => (strategy === "least_wait" ? r.totalDurationMin : r.totalDistanceKm);
              const withoutStop = from.stops.filter((s) => s.id !== stop.id);
              const exactRemoval = cost(evalStops(from.stops, from.departureMin)) - cost(evalStops(withoutStop, from.departureMin));
              const toBefore = evalStops(bestTo.stops, bestTo.departureMin);
              const withStopResult = evalStops([...bestTo.stops, stop], bestTo.departureMin);
              const exactInsertion = cost(withStopResult) - cost(toBefore);
              const placed = withStopResult.sequence.find((s) => s.id === stop.id);
              const noOvertime = overOf(bestTo, elapsed(withStopResult)) <= overOf(bestTo, elapsed(toBefore)) + OVER_TOL;
              if (placed && !placed.infeasible && noOvertime && exactInsertion < exactRemoval - EPSILON) {
                from.stops = withoutStop;
                bestTo.stops = [...bestTo.stops, stop];
                movedAny = true;
              }
            }
          }
        }
      }
    }
  };
  await relocate(maxPasses);

  // --- Swaps (least_wait only) ---
  // Moving one stop needs free capacity on the receiving truck, and a busy day
  // leaves every truck at ~100%, so a stop that makes its truck sit idle (a
  // shop opening at 11:00 on a truck that arrives at 08:45) can never move.
  // A swap trades that stop for one on another truck, weight permitting, when
  // that lowers the two trucks' combined elapsed time without making any stop
  // late. Only stops that actually wait are worth swapping out, which keeps
  // the search small. Both trucks of a swap already carry stops, so a swap
  // never opens an unused vehicle.
  const useSwaps = options.swaps === undefined ? strategy === "least_wait" : Boolean(options.swaps);

  // Looks for one improving swap between trucks X and Y; applies it and
  // returns true, or returns false when none exists.
  const trySwap = (X, Y) => {
    const depX = X.departureMin ?? DEFAULT_DEPARTURE_MIN;
    const depY = Y.departureMin ?? DEFAULT_DEPARTURE_MIN;
    const seqX = orderOf(X);
    const seqY = orderOf(Y);
    const baseX = orderMetrics(seqX, depX);
    const baseY = orderMetrics(seqY, depY);
    const lX = loadOf(X.stops);
    const lY = loadOf(Y.stops);
    const without = (l, s) => ({ kg: l.kg - kgOf(s), m3: l.m3 - m3Of(s) });
    const slack = EPSILON * 4;

    // Cheapest place for `stop` in `order`, or null if it would make a stop late.
    const bestInsert = (order, stop, dep, lateAllowed) => {
      let best = null;
      for (let k = 0; k <= order.length; k++) {
        const m = orderMetrics([...order.slice(0, k), stop, ...order.slice(k)], dep);
        if (m.late > lateAllowed) continue;
        if (!best || m.cost < best.cost) best = m;
      }
      return best;
    };

    for (const a of seqX) {
      if (!(a.waitMin > 0) || a.locked) continue;
      const aStop = X.stops.find((s) => s.id === a.id);
      if (!aStop) continue;
      const xWithoutA = seqX.filter((s) => s.id !== a.id);

      let best = null;
      for (const b of Y.stops) {
        if (timeUp()) return false;
        if (b.locked || !routable(b)) continue;
        if (!fitsLoad(without(lX, a), b, X.capacityKg, X.capacityM3)) continue;
        if (!fitsLoad(without(lY, b), a, Y.capacityKg, Y.capacityM3)) continue;
        const inX = bestInsert(xWithoutA, b, depX, baseX.late);
        if (!inX) continue;
        const yWithoutB = seqY.filter((s) => s.id !== b.id);
        const inY = bestInsert(yWithoutB, a, depY, baseY.late);
        if (!inY) continue;
        const delta = inX.cost - baseX.cost + (inY.cost - baseY.cost);
        if (delta < slack && (!best || delta < best.delta)) best = { b, delta };
      }
      if (!best) continue;

      // Cheap estimate says it may help: confirm with a full re-sequence.
      const newX = [...X.stops.filter((s) => s.id !== a.id), best.b];
      const newY = [...Y.stops.filter((s) => s.id !== best.b.id), aStop];
      const rx = evalStops(newX, X.departureMin);
      const ry = evalStops(newY, Y.departureMin);
      const beforeX = evalStops(X.stops, X.departureMin);
      const beforeY = evalStops(Y.stops, Y.departureMin);
      const exactGain = elapsed(beforeX) + elapsed(beforeY) - (elapsed(rx) + elapsed(ry));
      const noOvertime =
        overOf(X, elapsed(rx)) <= overOf(X, elapsed(beforeX)) + OVER_TOL && overOf(Y, elapsed(ry)) <= overOf(Y, elapsed(beforeY)) + OVER_TOL;
      if (exactGain > EPSILON && noOvertime && lateOf(rx) + lateOf(ry) <= lateOf(beforeX) + lateOf(beforeY)) {
        X.stops = newX;
        Y.stops = newY;
        return true;
      }
    }
    return false;
  };

  if (useSwaps && !timedOut) {
    for (let round = 0; round < maxPasses && !timedOut; round++) {
      let swappedAny = false;
      for (let i = 0; i < working.length && !timedOut; i++) {
        for (let j = 0; j < working.length && !timedOut; j++) {
          if (i === j) continue;
          let guard = 0;
          for (;;) {
            if (timeUp()) {
              timedOut = true;
              break;
            }
            await maybeYield();
            if (++guard > 50 || !trySwap(working[i], working[j])) break;
            swappedAny = true;
          }
        }
      }
      if (!swappedAny) break;
    }
  }

  // --- Relieve: a run that is too long, or has late stops, gets help ---
  // The grouping fills trucks by weight alone, so a run can end up longer than
  // a working day (or than the gap before the same vehicle's next run), or
  // with stops it reaches after closing. While an empty run exists, the tail
  // of such a run moves onto it: first an empty run of the same vehicle, then
  // of another vehicle that is already out, and only then an unused vehicle.
  // Kept only when the whole plan has fewer late stops, or as many and less
  // overtime.
  const planScore = () => {
    let late = 0;
    let over = 0;
    for (const t of working) {
      if (t.stops.length === 0) continue;
      const r = evalStops(t.stops, t.departureMin);
      late += lateOf(r);
      over += overOf(t, elapsed(r));
    }
    return { late, over };
  };
  let relieved = 0;
  const relieve = async () => {
    const tried = new Set();
    for (let guard = 0; guard < working.length * 2; guard++) {
      if (hardTimeUp()) break;
      await maybeYield();
      let src = null;
      let worst = null;
      for (const t of working) {
        if (t.stops.length < 2 || tried.has(t)) continue;
        const r = evalStops(t.stops, t.departureMin);
        const score = { late: lateOf(r), over: overOf(t, elapsed(r)) };
        if (score.late === 0 && score.over <= OVER_TOL) continue;
        if (!src || score.late > worst.late || (score.late === worst.late && score.over > worst.over)) {
          src = t;
          worst = score;
        }
      }
      if (!src) break;
      tried.add(src);
      const empties = working.filter((t) => t.stops.length === 0 && t !== src);
      if (empties.length === 0) break;
      const rank = (t) => (t.vehicleId === src.vehicleId ? 0 : vehicleInUse(t.vehicleId) ? 1 : 2);
      const targets = empties.slice().sort((a, b) => rank(a) - rank(b));
      const before = planScore();
      const seq = orderOf(src);
      for (const target of targets) {
        const moved = [];
        for (let i = seq.length - 1; i >= 0 && src.stops.length - moved.length > 1; i--) {
          const s = src.stops.find((x) => x.id === seq[i].id);
          if (!s || s.locked || !fitsLoad(loadOf(moved), s, target.capacityKg, target.capacityM3)) continue;
          moved.push(s);
          const rest = evalStops(src.stops.filter((x) => !moved.includes(x)), src.departureMin);
          if (lateOf(rest) === 0 && overOf(src, elapsed(rest)) <= OVER_TOL) break;
        }
        if (moved.length === 0) continue;
        const srcStops = src.stops;
        src.stops = srcStops.filter((x) => !moved.includes(x));
        target.stops = moved;
        const after = planScore();
        if (after.late < before.late || (after.late === before.late && after.over < before.over - OVER_TOL)) {
          relieved++;
          break;
        }
        src.stops = srcStops;
        target.stops = [];
      }
    }
  };
  if (options.relieve !== false) await relieve();

  // --- Consolidate: do the day's work with as few vehicles as possible ---
  // Takes the vehicle with the fewest stops and tries to place every one of
  // them on runs of the other vehicles that are out anyway: capacity must
  // hold, no stop anywhere may become late, and no run may get (more) over
  // its allowed length. If all its stops find a place the vehicle stays in
  // the yard; if not, nothing changes and the next vehicle is tried.
  const tryEmpty = (cand) => {
    const targets = working.filter((t) => t.vehicleId !== cand.id && (t.stops.length > 0 || vehicleInUse(t.vehicleId)));
    if (targets.length === 0) return false;
    const tentative = new Map();
    const stopsNow = (t) => tentative.get(t) || t.stops;
    const stops = cand.runs.flatMap((t) => t.stops).sort((a, b) => (b.weightKg || 0) - (a.weightKg || 0));
    for (const stop of stops) {
      if (!routable(stop)) return false;
      let best = null;
      for (const to of targets) {
        const cur = stopsNow(to);
        if (!fitsLoad(loadOf(cur), stop, to.capacityKg, to.capacityM3)) continue;
        const dep = to.departureMin ?? DEFAULT_DEPARTURE_MIN;
        const order = evalStops(cur, to.departureMin).sequence;
        const base = orderMetrics(order, dep);
        for (let k = 0; k <= order.length; k++) {
          const m = orderMetrics([...order.slice(0, k), stop, ...order.slice(k)], dep);
          if (m.late > base.late) continue;
          if (overOf(to, m.elapsed) > overOf(to, base.elapsed) + OVER_TOL) continue;
          const insertion = m.cost - base.cost;
          if (!best || insertion < best.cost) best = { to, cost: insertion };
        }
      }
      if (!best) return false;
      tentative.set(best.to, [...stopsNow(best.to), stop]);
    }
    // The estimates kept each run's order; confirm with a full re-sequence.
    for (const [t, newStops] of tentative) {
      const was = evalStops(t.stops, t.departureMin);
      const now = evalStops(newStops, t.departureMin);
      if (lateOf(now) > lateOf(was)) return false;
      if (overOf(t, elapsed(now)) > overOf(t, elapsed(was)) + OVER_TOL) return false;
    }
    tentative.forEach((newStops, t) => (t.stops = newStops));
    cand.runs.forEach((t) => (t.stops = []));
    return true;
  };
  let vehiclesFreed = 0;
  const consolidate = async () => {
    const failed = new Set();
    for (;;) {
      if (hardTimeUp()) break;
      const byVehicle = new Map();
      working.forEach((t) => {
        if (t.stops.length === 0 && !t.inUseElsewhere) return;
        const v = byVehicle.get(t.vehicleId) || { id: t.vehicleId, runs: [], count: 0, weight: 0, fixed: false };
        v.runs.push(t);
        v.count += t.stops.length;
        v.weight += weightOfStops(t.stops);
        // Stays out whatever happens here: a pinned stop, or work on a run outside this plan.
        if (t.inUseElsewhere || t.stops.some((s) => s.locked)) v.fixed = true;
        byVehicle.set(t.vehicleId, v);
      });
      if (byVehicle.size < 2) break;
      const candidates = [...byVehicle.values()]
        .filter((v) => !v.fixed && v.count > 0 && !failed.has(v.id))
        .sort((a, b) => a.count - b.count || a.weight - b.weight);
      let emptied = false;
      for (const cand of candidates) {
        await maybeYield();
        if (hardTimeUp()) break;
        if (tryEmpty(cand)) {
          vehiclesFreed++;
          failed.clear();
          emptied = true;
          break;
        }
        failed.add(cand.id);
      }
      if (!emptied) break;
    }
  };
  if (minimizeVehicles) {
    await consolidate();
    // Fuller trucks may now trade stops to their advantage (never onto a vehicle that stays in).
    if (vehiclesFreed > 0 && !timeUp()) await relocate(1);
  }

  // Every truck gets one final full re-sequence of what it ended up with.
  const results = [];
  for (const t of working) {
    await maybeYield();
    const { sequence, totalDistanceKm, totalDurationMin, totalWaitMin } = evalStops(t.stops, t.departureMin);
    const overtimeMin = sequence.length > 0 ? Math.round(overOf(t, totalDurationMin)) : 0;
    results.push({ ...t, sequence, totalDistanceKm, totalDurationMin, totalWaitMin, overtimeMin });
  }
  // Tells the caller the search stopped on its time budget (result is still
  // valid - just not fully polished).
  results.timedOut = timedOut;
  results.vehiclesFreed = vehiclesFreed;
  results.relieved = relieved;
  return results;
}

/**
 * One number-set describing how good a set of truck routes is, so two plans
 * can be compared. `improved` is crossRouteImprove's result.
 */
function summarizePlan(improved, unassignedKg = 0, unassignedOrders = null) {
  const used = improved.filter((t) => t.sequence.length > 0);
  const overtime = (t) => (Number.isFinite(t.maxDurationMin) ? Math.max(0, t.totalDurationMin - t.maxDurationMin) : 0);
  return {
    unassignedKg,
    // Orders left out (an order kept out by its volume can weigh 0 kg in SAP).
    unassignedOrders,
    trucks: used.length, // runs with stops
    // Vehicles that go out (a vehicle doing two runs counts once).
    vehicles: new Set(improved.filter((t) => t.sequence.length > 0 || t.inUseElsewhere).map((t) => t.vehicleId ?? t.id)).size,
    // Minutes by which runs exceed their allowed length, added up.
    overtimeMin: used.reduce((sum, t) => sum + overtime(t), 0),
    late: used.reduce((n, t) => n + t.sequence.filter((x) => x.infeasible).length, 0),
    km: used.reduce((sum, t) => sum + t.totalDistanceKm, 0),
    // Total elapsed time: driving + waiting outside shops + unloading. This is
    // exactly what the "least wait" strategy minimizes per truck.
    elapsedMin: used.reduce((sum, t) => sum + t.totalDurationMin, 0),
    idleMin: used.reduce((sum, t) => sum + (t.totalWaitMin || 0), 0),
  };
}

/**
 * Is plan `a` better than plan `b` for the chosen strategy? Same priorities
 * for both strategies - place every order, then as few late stops as possible,
 * then no run longer than allowed, then as few vehicles as possible - and
 * then the strategy's own goal: "shortest" = less driving distance,
 * "least_wait" = less total elapsed time (which is where idle waiting counts).
 * Ties go to `b` so the incumbent (the current method) is only replaced when
 * the alternative is actually better.
 */
function isBetterPlan(a, b, strategy = "shortest") {
  if (a.unassignedOrders != null && b.unassignedOrders != null && a.unassignedOrders !== b.unassignedOrders) {
    return a.unassignedOrders < b.unassignedOrders;
  }
  if (Math.abs(a.unassignedKg - b.unassignedKg) > 0.01) return a.unassignedKg < b.unassignedKg;
  if (a.late !== b.late) return a.late < b.late;
  const overA = a.overtimeMin || 0;
  const overB = b.overtimeMin || 0;
  if (Math.abs(overA - overB) > 5) return overA < overB;
  const vehiclesA = a.vehicles ?? a.trucks;
  const vehiclesB = b.vehicles ?? b.trucks;
  if (vehiclesA !== vehiclesB) return vehiclesA < vehiclesB;
  const primary = strategy === "least_wait" ? "elapsedMin" : "km";
  const secondary = strategy === "least_wait" ? "km" : "elapsedMin";
  const tol = strategy === "least_wait" ? 1 : 0.05; // 1 minute / 50 metres: not a real difference
  if (Math.abs(a[primary] - b[primary]) > tol) return a[primary] < b[primary];
  if (Math.abs(a[secondary] - b[secondary]) > tol) return a[secondary] < b[secondary];
  return false;
}

/**
 * Shop-hours-aware assignment of new stops to trucks ("timeline" grouping).
 *
 * The angle and proximity groupings only look at where stops are, so a stop
 * that opens at 11:00 can land on a truck that would reach it at 08:45 and sit
 * idle for two hours. This one builds all trucks' days forward in time
 * together: each truck has a clock and a position (after its existing stops),
 * and every step gives the (truck, stop) pair that costs the least extra time
 * (drive + any wait for the shop to open) to the truck it suits. Early-opening
 * stops therefore go first and late-opening ones are chained after enough
 * earlier work to fill the gap. A stop that would arrive after closing is only
 * taken when nothing else is placeable. Stops no truck has room for are
 * returned as unassigned groups. Mutates `state` (each truck's stops/remaining).
 *
 * @param {Array} state - trucks: { departureMin, remaining (kg), remainingM3 (Infinity = no volume limit), stops }
 * @param {Array} pool - new stops (copies)
 * @returns {Array<{stops, weightKg, volumeM3, limit}>} stops that could not be placed
 */
function timelineAssign(state, pool, depot, matrix, strategy = "least_wait") {
  const legs = makeLegs(matrix, DEFAULT_SPEED_KMH);
  const cursors = state.map((t) => {
    const dep = t.departureMin ?? DEFAULT_DEPARTURE_MIN;
    if (t.stops.length === 0) return { clock: dep, pos: depot };
    // Where an existing truck stands once its current stops are done.
    const seq = sequenceRoute(t.stops, depot, dep, DEFAULT_SPEED_KMH, strategy, matrix).sequence;
    if (seq.length === 0) return { clock: dep, pos: depot };
    const last = seq[seq.length - 1];
    return { clock: last.etaMin + serviceOf(last), pos: last.coordinates };
  });

  const remaining = [...pool];
  while (remaining.length > 0) {
    let best = null;
    for (let ti = 0; ti < state.length; ti++) {
      const t = state[ti];
      if (t.remaining <= 0) continue;
      for (let si = 0; si < remaining.length; si++) {
        const s = remaining[si];
        if (!fitsRoom(t, s)) continue;
        const arrive = cursors[ti].clock + legs.min(cursors[ti].pos, s.coordinates);
        const start = s.windowOpen != null ? Math.max(arrive, s.windowOpen) : arrive;
        const late = s.windowClose != null && start > s.windowClose;
        const cost = start - cursors[ti].clock;
        // On-time placements always beat late ones.
        if (!best || late < best.late || (late === best.late && cost < best.cost)) {
          best = { ti, si, start, cost, late };
        }
      }
    }
    if (!best) break; // nothing left fits any truck
    const [stop] = remaining.splice(best.si, 1);
    const t = state[best.ti];
    t.stops.push(stop);
    takeRoom(t, stop);
    cursors[best.ti] = { clock: best.start + serviceOf(stop), pos: stop.coordinates };
  }

  return remaining.map((s) => unplacedGroup(state, [s]));
}

// Room left on a planning truck: remaining (kg) and remainingM3 (Infinity = no volume limit).
const roomM3 = (t) => (typeof t.remainingM3 === "number" ? t.remainingM3 : Infinity);
const fitsRoom = (t, s) => kgOf(s) <= t.remaining && m3Of(s) <= roomM3(t) + VOLUME_EPS;
function takeRoom(t, s) {
  t.remaining -= kgOf(s);
  if (Number.isFinite(t.remainingM3)) t.remainingM3 -= m3Of(s);
}
// Stops no truck could take, with their load and which limit kept them out.
function unplacedGroup(state, stops) {
  const load = loadOf(stops);
  return { stops, weightKg: load.kg, volumeM3: load.m3, limit: blockingLimit(state.map((t) => ({ kg: t.remaining, m3: roomM3(t) })), load) };
}

/**
 * Plans one region's Auto-Fill without touching anything: groups the new
 * orders using `method`, gives each whole group to the smallest truck that
 * still has room (a group that fits nowhere is opened up and its orders
 * placed one by one), then runs the cross-truck improvement over every truck in
 * the region (existing stops included). Pure - the caller applies the result.
 *
 * @param {Object} args
 * @param {Array}  args.poolStops - new orders: [{ id, coordinates, weightKg, volumeM3?, windowOpen, windowClose, ...anything to carry through }]
 * @param {Array}  args.trucks - [{ id, capacityKg, remainingKg, capacityM3?, remainingM3?, departureMin, stops: [existing stops] }]
 *   (no capacityM3 = no volume limit for that truck)
 * @param {Object} args.depot
 * @param {"shortest"|"least_wait"} args.strategy
 * @param {Object|null} args.matrix - road distance matrix covering depot + existing + new stops
 * @param {"sweep"|"proximity"|"timeline"} args.method - how the new orders are grouped ("timeline" = shop-hours aware, used for least_wait)
 * @param {number} args.maxMs - time budget for the improvement step
 * @param {boolean} args.minimizeVehicles - default true (see crossRouteImprove)
 * @returns {Promise<{method, improved, unassigned, summary}>}
 *
 * A truck may also carry vehicleId / maxDurationMin / inUseElsewhere (see
 * crossRouteImprove); the summary then counts vehicles and overtime.
 */
async function planRegionAssignment({ poolStops, trucks, depot, strategy, matrix, method, maxMs, minimizeVehicles = true }) {
  const state = trucks.map((t) => ({
    ...t,
    stops: t.stops.map((s) => ({ ...s })),
    remaining: t.remainingKg,
    remainingM3: hasVolumeLimit(t.capacityM3) ? (Number.isFinite(t.remainingM3) ? t.remainingM3 : t.capacityM3) : Infinity,
  }));
  const open = state.filter((t) => t.remaining > 0 && t.remainingM3 > VOLUME_EPS);
  const weightOf = (cl) => cl.reduce((sum, o) => sum + (o.weightKg || 0), 0);

  const unassigned = [];
  let unassignedKg = 0;

  if (method === "timeline") {
    // Shop-hours-aware assignment: builds every truck's day forward in time.
    for (const group of timelineAssign(state, poolStops.map((s) => ({ ...s })), depot, matrix, strategy)) {
      unassigned.push(group);
      unassignedKg += group.weightKg;
    }
  } else {
    const groupFn = method === "proximity" ? proximityCluster : sweepCluster;
    const largest = open.length > 0 ? Math.max(...open.map((t) => t.remaining)) : 0;
    // Infinity (some truck has no volume limit) = groups are not cut by volume.
    const largestM3 = open.length > 0 ? Math.max(...open.map((t) => t.remainingM3)) : 0;
    const clusters = groupFn(poolStops.map((s) => ({ ...s })), depot, largest, largestM3);
    // Biggest groups first - otherwise a large group can be left with only
    // small trucks even though a big truck was free at the start.
    clusters.sort((a, b) => weightOf(b) - weightOf(a));

    // Is this truck's vehicle already going out (on this run or another)?
    const out = (t) => state.some((x) => (x.vehicleId ?? x.id) === (t.vehicleId ?? t.id) && (x.stops.length > 0 || x.inUseElsewhere));
    for (const cluster of clusters) {
      const { kg: w, m3: v } = loadOf(cluster);
      // Among trucks with the same room, one whose vehicle is already out first.
      const candidates = open
        .filter((t) => t.remaining > 0)
        .map((t) => ({ maxWeightKg: t.remaining, maxVolumeM3: t.remainingM3, _ref: t, _out: out(t) ? 0 : 1 }))
        .sort((a, b) => a._out - b._out);
      const fit = pickSmallestFittingTruck(candidates, w, v);
      if (!fit) {
        unassigned.push({ stops: cluster, weightKg: w, volumeM3: v });
        unassignedKg += w;
        continue;
      }
      fit._ref.stops.push(...cluster);
      cluster.forEach((s) => takeRoom(fit._ref, s));
    }

    // The groups are cut to the size of the biggest truck, so with trucks of
    // different sizes a whole group can find no truck while smaller trucks
    // still have room (seen with the real weekly templates, 1,000 / 2,000 /
    // 500 kg: 32 of 70 orders were left out next to an empty truck). Such a
    // group is opened up and its orders are placed one at a time, heaviest
    // first, on a truck with room: a vehicle that is already going out before
    // an unused one, then the truck whose stops are nearest. Only an order
    // that fits on no truck at all stays unassigned.
    if (unassigned.length > 0) {
      const leftovers = unassigned
        .splice(0)
        .flatMap((group) => group.stops)
        .sort((a, b) => (b.weightKg || 0) - (a.weightKg || 0));
      unassignedKg = 0;
      const centreOf = (t) =>
        t.stops.length === 0
          ? depot
          : { lat: t.stops.reduce((sum, x) => sum + x.coordinates.lat, 0) / t.stops.length, lng: t.stops.reduce((sum, x) => sum + x.coordinates.lng, 0) / t.stops.length };
      for (const stop of leftovers) {
        const w = stop.weightKg || 0;
        let best = null;
        for (const t of state) {
          if (t.remaining <= 0 || !fitsRoom(t, stop)) continue;
          const unused = out(t) ? 0 : 1;
          const km = haversineKm(centreOf(t), stop.coordinates);
          if (!best || unused < best.unused || (unused === best.unused && km < best.km)) best = { t, unused, km };
        }
        if (!best) {
          unassigned.push(unplacedGroup(state, [stop]));
          unassignedKg += w;
          continue;
        }
        best.t.stops.push(stop);
        takeRoom(best.t, stop);
      }
    }
  }

  const improved = await crossRouteImprove(
    state.map((t) => ({
      id: t.id,
      vehicleId: t.vehicleId,
      maxDurationMin: t.maxDurationMin,
      inUseElsewhere: t.inUseElsewhere,
      capacityKg: t.capacityKg,
      capacityM3: t.capacityM3,
      departureMin: t.departureMin,
      stops: t.stops,
    })),
    depot,
    undefined,
    undefined,
    strategy,
    matrix,
    { maxMs, minimizeVehicles }
  );
  const unassignedOrders = unassigned.reduce((n, g) => n + g.stops.length, 0);
  return { method, improved, unassigned, summary: summarizePlan(improved, unassignedKg, unassignedOrders) };
}

/**
 * Computes real distance/duration/wait/feasibility for a route in the EXACT
 * order given — no construction, no 2-opt, no reordering at all. Used after
 * a dispatcher manually drags/reorders stops: their chosen order must be
 * respected exactly, but the displayed totals (distance, ETA, wait, "time-
 * window issue" flags) still need to reflect what that specific order
 * actually costs, not go stale until the next full re-optimize.
 *
 * @param {Array} stops - in the exact order to evaluate
 * @param {Object} depot - { lat, lng }
 * @param {number} departureMin
 * @param {number} speedKmh
 * @param {Object|null} matrix - optional road distance matrix (see makeLegs)
 * @returns {Object} { sequence: [stop...with seq/etaMin/infeasible, same order as input], totalDistanceKm, totalDurationMin, totalWaitMin }
 */
function evaluateFixedRoute(stops, depot, departureMin = DEFAULT_DEPARTURE_MIN, speedKmh = DEFAULT_SPEED_KMH, matrix = null) {
  const legs = makeLegs(matrix, speedKmh);
  const geocoded = stops.filter(
    (s) => s.coordinates && Number.isFinite(s.coordinates.lat) && Number.isFinite(s.coordinates.lng)
  );
  if (geocoded.length === 0) {
    return { sequence: [], totalDistanceKm: 0, totalDurationMin: 0, totalWaitMin: 0 };
  }

  const point = (s) => (s === "DEPOT" ? depot : s.coordinates);
  const route = ["DEPOT", ...geocoded, "DEPOT"];

  let clock = departureMin;
  let totalDistanceKm = 0;
  let totalWaitMin = 0;
  const sequence = [];
  let seq = 1;

  for (let i = 1; i < route.length; i++) {
    const legKm = legs.km(point(route[i - 1]), point(route[i]));
    const legMin = legs.min(point(route[i - 1]), point(route[i]));
    totalDistanceKm += legKm;
    clock += legMin;

    const stop = route[i];
    if (stop === "DEPOT") continue;

    let waitMin = 0;
    if (stop.windowOpen != null && clock < stop.windowOpen) {
      waitMin = stop.windowOpen - clock;
      clock = stop.windowOpen;
    }
    totalWaitMin += waitMin;

    const infeasible = stop.windowClose != null && clock > stop.windowClose;
    const serviceMin = serviceOf(stop);
    sequence.push({
      ...stop,
      seq: seq++,
      etaMin: Math.round(clock),
      driveMin: Math.round(legMin),
      legKm: Math.round(legKm * 10) / 10,
      waitMin: Math.round(waitMin),
      serviceMin,
      infeasible,
    });
    clock += serviceMin; // time spent at the stop delays every later leg
  }

  return {
    sequence,
    totalDistanceKm: Math.round(totalDistanceKm * 10) / 10,
    totalDurationMin: Math.round(clock - departureMin),
    totalWaitMin: Math.round(totalWaitMin),
  };
}

module.exports = {
  haversineKm,
  roadKm,
  durationMin,
  pointKey,
  serviceOf,
  DEFAULT_DEPARTURE_MIN,
  DEFAULT_SERVICE_MIN,
  parseTimeToMinutes,
  parseTimeWindow,
  stopWindow,
  sweepCluster,
  proximityCluster,
  timelineAssign,
  planRegionAssignment,
  summarizePlan,
  isBetterPlan,
  sequenceRoute,
  pickSmallestFittingTruck,
  fitsLoad,
  loadOf,
  blockingLimit,
  crossRouteImprove,
  evaluateFixedRoute,
  maxRunDurationMin,
  routeMaxDurationMin,
  runTurnaroundMin,
};
