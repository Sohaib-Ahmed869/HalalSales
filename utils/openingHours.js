// utils/openingHours.js
//
// Customer opening / closing times (Customer.openingTime / closingTime) and
// preferred delivery times (preferredDeliveryFrom / To) are PLACEHOLDER data
// for now: scripts/seedTestOpeningHours.js filled random plausible values for
// testing, and the dispatch team plans deliveries on the fly. Planning still
// uses them exactly as before (late / "time-window issue" / preferred window
// not met flags are unchanged); every report that depends on them says so.
//
// Set PLACEHOLDER to false once real hours are entered for the customers.
const PLACEHOLDER = true;

const NOTE =
  "Customer opening / closing times and preferred delivery times are placeholder data (test values, not the shops' real hours). " +
  "Results marked as depending on them are indicative only.";

// What, in the plan and in the planned-vs-actual report, comes from those hours.
const DEPENDENT_RESULTS = [
  "a stop flagged as a time-window issue (arrives after closing)",
  'a preferred delivery window "not met"',
  "waiting for a shop to open, and every planned time after such a wait (ETAs, return time)",
  "late stops counted when choosing the Auto-Fill plan, and the \"least wait\" strategy",
  "in Planned vs Actual: late at stop, long stop and late return when the plan waited for a shop to open",
];

/** The notice sent with a plan or report (null once the hours are real). */
function placeholderNotice(counts = {}) {
  if (!PLACEHOLDER) return null;
  return { placeholder: true, note: NOTE, dependentResults: DEPENDENT_RESULTS, ...counts };
}

module.exports = { OPENING_HOURS_ARE_PLACEHOLDERS: PLACEHOLDER, placeholderNotice };
