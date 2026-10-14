// utils/truckRuns.js
//
// A vehicle can do more than one run a day (models/TruckRoute.js, `trip`).
// The truck's GPS only says where the vehicle is, so the code that follows it
// (utils/stopVisits.js, utils/liveEta.js) has to know which of the day's runs
// the vehicle can be on at a given moment.

const { parseTimeToMinutes, DEFAULT_DEPARTURE_MIN } = require("./routeOptimizer");

// A later run counts from this long before it is due to leave.
const RUN_START_MARGIN_MIN = 30;

// Minutes since midnight of `date` on `timeZone`'s wall clock.
function clockMinutes(date, timeZone) {
  const parts = {};
  new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" })
    .formatToParts(date)
    .forEach((p) => (parts[p.type] = Number(p.value)));
  return parts.hour * 60 + parts.minute + date.getSeconds() / 60;
}

function departureMinOf(route) {
  const parsed = parseTimeToMinutes(route.departureTime);
  return parsed == null ? DEFAULT_DEPARTURE_MIN : parsed;
}

const stopDone = (o) => Boolean(o.departedAt) || o.status === "delivered" || o.status === "failed";

// The day's runs of one vehicle, first run first.
const sortRuns = (routes) => routes.slice().sort((a, b) => departureMinOf(a) - departureMinOf(b) || (a.trip || 1) - (b.trip || 1));

/**
 * The runs the vehicle can be on at `nowMin` (minutes from midnight on the
 * depot's clock): always its first run; a later run once it is due to leave
 * within RUN_START_MARGIN_MIN, or once every stop of the earlier runs is done.
 * Without this a stop of the afternoon run that the truck passes in the
 * morning would be recorded as visited.
 */
function eligibleRuns(routes, nowMin) {
  const runs = sortRuns(routes);
  return runs.filter((run, i) => {
    if (i === 0) return true;
    if (nowMin >= departureMinOf(run) - RUN_START_MARGIN_MIN) return true;
    return runs.slice(0, i).every((earlier) => earlier.orders.every(stopDone));
  });
}

module.exports = { clockMinutes, departureMinOf, stopDone, sortRuns, eligibleRuns, RUN_START_MARGIN_MIN };
