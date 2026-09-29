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
 * Sweep-clusters stops by polar angle around the depot, splitting whenever
 * adding the next stop would exceed the given capacity. Produces the fewest
 * geographically-coherent clusters that fit within capacity.
 *
 * @param {Array} stops - [{ id, coordinates: {lat,lng}, weightKg }]
 * @param {Object} depot - { lat, lng }
 * @param {number} capacityKg
 * @returns {Array<Array>} clusters of stops
 */
function sweepCluster(stops, depot, capacityKg) {
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
  let currentWeight = 0;

  for (const stop of withAngle) {
    const stopWeight = stop.weightKg || 0;
    if (current.length > 0 && currentWeight + stopWeight > capacityKg) {
      clusters.push(current);
      current = [];
      currentWeight = 0;
    }
    current.push(stop);
    currentWeight += stopWeight;
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
 * @param {Array} stops - [{ id, coordinates: {lat,lng}, weightKg }]
 * @param {Object} depot - { lat, lng }
 * @param {number} capacityKg
 * @returns {Array<Array>} clusters of stops (same shape as sweepCluster)
 */
function proximityCluster(stops, depot, capacityKg) {
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
    let weight = seed.weightKg || 0;
    let sumLat = seed.coordinates.lat;
    let sumLng = seed.coordinates.lng;

    // Grow: nearest stop to the cluster's centre that still fits.
    for (;;) {
      const centre = { lat: sumLat / cluster.length, lng: sumLng / cluster.length };
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < pool.length; i++) {
        if (weight + (pool[i].weightKg || 0) > capacityKg) continue;
        const d = haversineKm(centre, pool[i].coordinates);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      if (bestIdx === -1) break;
      const next = pool.splice(bestIdx, 1)[0];
      cluster.push(next);
      weight += next.weightKg || 0;
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
 * Picks the smallest truck (by maxWeightKg) able to carry the given weight,
 * from a list of candidate trucks. Returns null if none fits.
 */
function pickSmallestFittingTruck(trucks, weightKg) {
  const sorted = [...trucks].sort((a, b) => a.maxWeightKg - b.maxWeightKg);
  return sorted.find((t) => t.maxWeightKg >= weightKg) || null;
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
 * @param {Array} trucks - [{ id, capacityKg, stops: [{ id, coordinates, windowOpen, windowClose, weightKg, locked, ...anything else to carry through }] }]
 * @param {Object} depot
 * @param {number} speedKmh
 * @param {number} maxPasses
 * @param {"shortest"|"least_wait"} strategy - same meaning as sequenceRoute's:
 *   which metric a move has to improve before it's taken.
 * @param {Object} options - { maxMs } time budget for the search (default 8000, env ROUTE_IMPROVE_BUDGET_MS)
 * @returns {Promise<Array>} same shape as input, each truck additionally carrying { sequence, totalDistanceKm, totalDurationMin, totalWaitMin }; the array has `timedOut: true` if the budget ended the search early
 */
async function crossRouteImprove(trucks, depot, speedKmh = DEFAULT_SPEED_KMH, maxPasses = 3, strategy = "shortest", matrix = null, options = {}) {
  const maxMs = Number.isFinite(options.maxMs) ? options.maxMs : DEFAULT_IMPROVE_BUDGET_MS;
  const started = Date.now();
  let lastYield = started;
  const timeUp = () => Date.now() - started > maxMs;
  // Hand control back to the event loop regularly so a big Auto-Fill never
  // freezes the API for everyone else while it thinks.
  const maybeYield = async () => {
    if (Date.now() - lastYield > 15) {
      await new Promise((resolve) => setImmediate(resolve));
      lastYield = Date.now();
    }
  };

  const working = trucks.map((t) => ({ ...t, stops: t.stops.map((s) => ({ ...s })) }));
  const legs = makeLegs(matrix, speedKmh);

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
    return { cost: strategy === "least_wait" ? clock - departureMin : dist, late };
  };
  const EPSILON = strategy === "least_wait" ? 1 : 0.05; // 1 min or 0.05 km - ignore savings too small to be worth an extra stop-swap

  // The truck's stops in their current best visiting order.
  const orderOf = (truck) => evalStops(truck.stops, truck.departureMin).sequence;

  let movedAny = true;
  let pass = 0;
  let timedOut = false;
  outer: while (movedAny && pass < maxPasses) {
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
        if (!stop.coordinates || !Number.isFinite(stop.coordinates.lat)) continue; // can't be routed anyway
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
          const usedWeight = to.stops.reduce((sum, o) => sum + (o.weightKg || 0), 0);
          if (usedWeight + (stop.weightKg || 0) > to.capacityKg) continue;

          const dep = to.departureMin ?? DEFAULT_DEPARTURE_MIN;
          const toOrder = orderOf(to);
          const base = orderMetrics(toOrder, dep);
          // Cheapest place to slot the stop into the target's current order.
          // The stop itself must arrive in time, and no stop already on that
          // truck may become late because of it.
          for (let k = 0; k <= toOrder.length; k++) {
            const candidate = [...toOrder.slice(0, k), stop, ...toOrder.slice(k)];
            const m = orderMetrics(candidate, dep);
            if (m.late > base.late) continue;
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
            const withStopResult = evalStops([...bestTo.stops, stop], bestTo.departureMin);
            const exactInsertion = cost(withStopResult) - cost(evalStops(bestTo.stops, bestTo.departureMin));
            const placed = withStopResult.sequence.find((s) => s.id === stop.id);
            if (placed && !placed.infeasible && exactInsertion < exactRemoval - EPSILON) {
              from.stops = withoutStop;
              bestTo.stops = [...bestTo.stops, stop];
              movedAny = true;
            }
          }
        }
      }
    }
  }

  // Every truck gets one final full re-sequence of what it ended up with.
  const results = [];
  for (const t of working) {
    await maybeYield();
    const { sequence, totalDistanceKm, totalDurationMin, totalWaitMin } = evalStops(t.stops, t.departureMin);
    results.push({ ...t, sequence, totalDistanceKm, totalDurationMin, totalWaitMin });
  }
  // Tells the caller the search stopped on its time budget (result is still
  // valid - just not fully polished).
  results.timedOut = timedOut;
  return results;
}

/**
 * One number-set describing how good a set of truck routes is, so two plans
 * can be compared. `improved` is crossRouteImprove's result.
 */
function summarizePlan(improved, unassignedKg = 0) {
  const used = improved.filter((t) => t.sequence.length > 0);
  return {
    unassignedKg,
    trucks: used.length,
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
 * for both strategies - place every order, then as few late stops as possible
 * - and then the strategy's own goal: "shortest" = less driving distance,
 * "least_wait" = less total elapsed time (which is where idle waiting counts).
 * Ties go to `b` so the incumbent (the current method) is only replaced when
 * the alternative is actually better.
 */
function isBetterPlan(a, b, strategy = "shortest") {
  if (Math.abs(a.unassignedKg - b.unassignedKg) > 0.01) return a.unassignedKg < b.unassignedKg;
  if (a.late !== b.late) return a.late < b.late;
  const primary = strategy === "least_wait" ? "elapsedMin" : "km";
  const secondary = strategy === "least_wait" ? "km" : "elapsedMin";
  const tol = strategy === "least_wait" ? 1 : 0.05; // 1 minute / 50 metres: not a real difference
  if (Math.abs(a[primary] - b[primary]) > tol) return a[primary] < b[primary];
  if (Math.abs(a[secondary] - b[secondary]) > tol) return a[secondary] < b[secondary];
  return false;
}

/**
 * Plans one region's Auto-Fill without touching anything: groups the new
 * orders using `method`, gives each whole group to the smallest truck that
 * still has room, then runs the cross-truck improvement over every truck in
 * the region (existing stops included). Pure - the caller applies the result.
 *
 * @param {Object} args
 * @param {Array}  args.poolStops - new orders: [{ id, coordinates, weightKg, windowOpen, windowClose, ...anything to carry through }]
 * @param {Array}  args.trucks - [{ id, capacityKg, remainingKg, departureMin, stops: [existing stops] }]
 * @param {Object} args.depot
 * @param {"shortest"|"least_wait"} args.strategy
 * @param {Object|null} args.matrix - road distance matrix covering depot + existing + new stops
 * @param {"sweep"|"proximity"} args.method - how the new orders are grouped
 * @param {number} args.maxMs - time budget for the improvement step
 * @returns {Promise<{method, improved, unassigned, summary}>}
 */
async function planRegionAssignment({ poolStops, trucks, depot, strategy, matrix, method, maxMs }) {
  const groupFn = method === "proximity" ? proximityCluster : sweepCluster;
  const state = trucks.map((t) => ({ ...t, stops: t.stops.map((s) => ({ ...s })), remaining: t.remainingKg }));
  const open = state.filter((t) => t.remaining > 0);
  const largest = open.length > 0 ? Math.max(...open.map((t) => t.remaining)) : 0;

  const clusters = groupFn(poolStops.map((s) => ({ ...s })), depot, largest);
  // Biggest groups first - otherwise a large group can be left with only
  // small trucks even though a big truck was free at the start.
  const weightOf = (cl) => cl.reduce((sum, o) => sum + (o.weightKg || 0), 0);
  clusters.sort((a, b) => weightOf(b) - weightOf(a));

  const unassigned = [];
  let unassignedKg = 0;
  for (const cluster of clusters) {
    const w = weightOf(cluster);
    const candidates = open.filter((t) => t.remaining > 0).map((t) => ({ maxWeightKg: t.remaining, _ref: t }));
    const fit = pickSmallestFittingTruck(candidates, w);
    if (!fit) {
      unassigned.push({ stops: cluster, weightKg: w });
      unassignedKg += w;
      continue;
    }
    fit._ref.stops.push(...cluster);
    fit._ref.remaining -= w;
  }

  const improved = await crossRouteImprove(
    state.map((t) => ({ id: t.id, capacityKg: t.capacityKg, departureMin: t.departureMin, stops: t.stops })),
    depot,
    undefined,
    undefined,
    strategy,
    matrix,
    { maxMs }
  );
  return { method, improved, unassigned, summary: summarizePlan(improved, unassignedKg) };
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
  sweepCluster,
  proximityCluster,
  planRegionAssignment,
  summarizePlan,
  isBetterPlan,
  sequenceRoute,
  pickSmallestFittingTruck,
  crossRouteImprove,
  evaluateFixedRoute,
};
