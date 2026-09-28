// utils/routeOptimizer.js
//
// Implements the CVRPTW heuristic described in implementation.md section 6:
//   - haversine distance x a road-distance factor as the v1 distance/duration
//     source (OSRM is the documented upgrade path — see open question in the
//     plan; this keeps route generation working with zero extra infra today)
//   - cheapest time-window-feasible insertion for stop sequencing (NOT
//     nearest-neighbor, which is what produces "drive past a shop, serve a
//     farther one, then come back" — the exact failure mode being fixed)
//   - 2-opt local search to remove any residual backtracking
//
// Pure functions, no DB access — callers pass in plain stop objects and get
// a sequenced route back.

const ROAD_DISTANCE_FACTOR = 1.3; // straight-line -> approximate road distance
const DEFAULT_SPEED_KMH = 40; // used to turn distance into a duration estimate

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

// Parses "HH:MM" into minutes-from-midnight. Returns null if unparseable.
function parseTimeToMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== "string") return null;
  const match = hhmm.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
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
 * @returns {Object} { sequence: [stop...with seq/etaMin/infeasible], totalDistanceKm, totalDurationMin, totalWaitMin, strategy }
 */
function sequenceRoute(stops, depot, departureMin = 8 * 60, speedKmh = DEFAULT_SPEED_KMH, strategy = "shortest") {
  const geocoded = stops.filter(
    (s) => s.coordinates && Number.isFinite(s.coordinates.lat) && Number.isFinite(s.coordinates.lng)
  );

  if (geocoded.length === 0) {
    return { sequence: [], totalDistanceKm: 0, totalDurationMin: 0, totalWaitMin: 0, strategy };
  }

  // --- Construction: cheapest time-window-feasible insertion ---
  const point = (s) => (s === "DEPOT" ? depot : s.coordinates);

  // Seed with the farthest stop from the depot.
  let seedIdx = 0;
  let seedDist = -Infinity;
  geocoded.forEach((s, i) => {
    const d = roadKm(depot, s.coordinates);
    if (d > seedDist) {
      seedDist = d;
      seedIdx = i;
    }
  });

  let route = ["DEPOT", geocoded[seedIdx], "DEPOT"];
  const remaining = geocoded.filter((_, i) => i !== seedIdx);

  // Computes arrival time (minutes-from-midnight) at each stop in a route,
  // given a fixed departure time and travel speed. Waiting is allowed if the
  // truck arrives before windowOpen — waitMin records how long, so
  // "least_wait" has something concrete to minimize.
  function computeArrivals(candidateRoute) {
    let clock = departureMin;
    const arrivals = [];
    for (let i = 1; i < candidateRoute.length; i++) {
      const prev = point(candidateRoute[i - 1]);
      const cur = point(candidateRoute[i]);
      const dist = roadKm(prev, cur);
      clock += durationMin(dist, speedKmh);
      const stop = candidateRoute[i];
      let waitMin = 0;
      if (stop !== "DEPOT" && stop.windowOpen != null && clock < stop.windowOpen) {
        waitMin = stop.windowOpen - clock;
        clock = stop.windowOpen; // wait for opening
      }
      arrivals.push({ stop, arrival: clock, distFromPrev: dist, waitMin });
    }
    return arrivals;
  }

  function isFeasible(arrivals) {
    return arrivals.every(
      ({ stop, arrival }) =>
        stop === "DEPOT" || stop.windowClose == null || arrival <= stop.windowClose
    );
  }

  function routeDistanceCost(candidateRoute) {
    let total = 0;
    for (let i = 1; i < candidateRoute.length; i++) {
      total += roadKm(point(candidateRoute[i - 1]), point(candidateRoute[i]));
    }
    return total;
  }

  // Total elapsed minutes from departure to the final return leg's arrival —
  // driving time AND waiting time both count against this, so a route that
  // avoids a long wait scores better here even if it drives more km.
  function routeElapsedCost(candidateRoute) {
    const arrivals = computeArrivals(candidateRoute);
    if (arrivals.length === 0) return 0;
    return arrivals[arrivals.length - 1].arrival - departureMin;
  }

  const routeCost = strategy === "least_wait" ? routeElapsedCost : routeDistanceCost;

  while (remaining.length > 0) {
    let bestStopIdx = -1;
    let bestPosition = -1;
    let bestExtraCost = Infinity;

    remaining.forEach((stop, stopIdx) => {
      for (let pos = 1; pos < route.length; pos++) {
        const candidate = [...route.slice(0, pos), stop, ...route.slice(pos)];
        const arrivals = computeArrivals(candidate);
        if (!isFeasible(arrivals)) continue;

        const before = routeCost(route);
        const after = routeCost(candidate);
        const extraCost = after - before;

        if (extraCost < bestExtraCost) {
          bestExtraCost = extraCost;
          bestStopIdx = stopIdx;
          bestPosition = pos;
        }
      }
    });

    if (bestStopIdx === -1) {
      // No feasible insertion point for any remaining stop within the time
      // windows already committed to — append at the end and flag infeasible
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
    while (improved) {
      improved = false;
      for (let i = 1; i < best.length - 2; i++) {
        for (let k = i + 1; k < best.length - 1; k++) {
          const reversed = [
            ...best.slice(0, i),
            ...best.slice(i, k + 1).reverse(),
            ...best.slice(k + 1),
          ];
          const arrivals = computeArrivals(reversed);
          if (!isFeasible(arrivals)) continue;
          if (routeCost(reversed) < routeCost(best) - 1e-9) {
            best = reversed;
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
    const { stop, arrival, distFromPrev, waitMin } = arrivals[i];
    totalDistanceKm += distFromPrev;
    totalWaitMin += waitMin || 0;
    if (stop === "DEPOT") continue;
    sequence.push({
      ...stop,
      seq: seq++,
      etaMin: Math.round(arrival),
      infeasible: Boolean(stop._infeasible),
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
 * @returns {Array} same shape as input, each truck additionally carrying { sequence, totalDistanceKm, totalDurationMin, totalWaitMin }
 */
function crossRouteImprove(trucks, depot, speedKmh = DEFAULT_SPEED_KMH, maxPasses = 3, strategy = "shortest") {
  const working = trucks.map((t) => ({ ...t, stops: t.stops.map((s) => ({ ...s })) }));
  // "shortest": compare total driving distance (km). "least_wait": compare
  // total elapsed time (minutes, driving + waiting) instead — a move only
  // happens if it improves whichever one the caller asked to optimize for.
  const costOf = (stops) => {
    const result = sequenceRoute(stops, depot, 8 * 60, speedKmh, strategy);
    return strategy === "least_wait" ? result.totalDurationMin : result.totalDistanceKm;
  };
  const EPSILON = strategy === "least_wait" ? 1 : 0.05; // 1 min or 0.05 km — ignore savings too small to be worth an extra stop-swap

  let movedAny = true;
  let pass = 0;
  while (movedAny && pass < maxPasses) {
    movedAny = false;
    pass++;

    for (let i = 0; i < working.length; i++) {
      const from = working[i];
      for (const stop of [...from.stops]) {
        if (stop.locked) continue;
        // No "leave at least one stop" guard here on purpose: fully draining
        // a near-empty truck into others (an empty route, needed by nobody
        // today) is exactly the "least trucks per area" outcome, not a bug
        // to avoid. An empty TruckRoute is a valid, informative result — it
        // means that scheduled truck genuinely isn't needed today.

        const withoutStop = from.stops.filter((s) => s.id !== stop.id);
        const removalSavings = costOf(from.stops) - costOf(withoutStop);

        let bestTo = null;
        let bestInsertionCost = Infinity;

        for (let j = 0; j < working.length; j++) {
          if (j === i) continue;
          const to = working[j];
          const usedWeight = to.stops.reduce((s, o) => s + (o.weightKg || 0), 0);
          if (usedWeight + (stop.weightKg || 0) > to.capacityKg) continue;

          const withStop = [...to.stops, stop];
          const insertionCost = costOf(withStop) - costOf(to.stops);
          if (insertionCost >= bestInsertionCost) continue;

          const seq = sequenceRoute(withStop, depot, 8 * 60, speedKmh, strategy).sequence;
          const placed = seq.find((s) => s.id === stop.id);
          if (!placed || placed.infeasible) continue; // don't move it somewhere it can't actually be delivered on time

          bestInsertionCost = insertionCost;
          bestTo = to;
        }

        if (bestTo && bestInsertionCost < removalSavings - EPSILON) {
          from.stops = withoutStop;
          bestTo.stops = [...bestTo.stops, stop];
          movedAny = true;
        }
      }
    }
  }

  return working.map((t) => {
    const { sequence, totalDistanceKm, totalDurationMin, totalWaitMin } = sequenceRoute(t.stops, depot, 8 * 60, speedKmh, strategy);
    return { ...t, sequence, totalDistanceKm, totalDurationMin, totalWaitMin };
  });
}

module.exports = {
  haversineKm,
  roadKm,
  durationMin,
  parseTimeToMinutes,
  sweepCluster,
  sequenceRoute,
  pickSmallestFittingTruck,
  crossRouteImprove,
};
