// scripts/checkGeotab.js
//
// Checks the MyGeotab login in .env and prints what the portal will read:
// vehicles, their latest position, odometer, and this week's idling /
// speeding violations and fuel fill-ups. Read-only: changes nothing in
// MyGeotab or in the database.
//
//   node scripts/checkGeotab.js
//
// Needs GEOTAB_DATABASE, GEOTAB_USERNAME and GEOTAB_PASSWORD in .env.

require("dotenv").config();
const geotab = require("../utils/geotabClient");

const ago = (d) => {
  const min = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  return min < 60 ? `${min} min ago` : `${Math.floor(min / 60)} h ${min % 60} min ago`;
};

(async () => {
  const cfg = geotab.config();
  if (!cfg.enabled) {
    console.log("MyGeotab is not configured. Add to .env:");
    console.log("  GEOTAB_DATABASE=<database name>");
    console.log("  GEOTAB_USERNAME=<user email>");
    console.log("  GEOTAB_PASSWORD=<password>");
    process.exit(1);
  }
  console.log(`Logging in to ${cfg.server} / database "${cfg.database}" as ${cfg.userName} ...`);
  const session = await geotab.login();
  console.log(`OK. Data server: ${session.server}\n`);

  const [devices, statuses] = await Promise.all([geotab.getDevices(), geotab.getDeviceStatusInfo()]);
  const statusById = new Map(statuses.map((s) => [s.device?.id, s]));
  const odometers = await geotab.multiCall(devices.map((d) => geotab.statusAtCall(d.id, geotab.DIAGNOSTIC.odometer, new Date())));

  console.log(`${devices.length} active vehicle(s):`);
  devices.forEach((d, i) => {
    const s = statusById.get(d.id);
    const odo = odometers[i] && odometers[i].length ? `${Math.round(odometers[i][odometers[i].length - 1].data / 1000).toLocaleString()} km` : "no odometer reading";
    const where = s
      ? `${s.latitude.toFixed(5)}, ${s.longitude.toFixed(5)}  ${s.isDriving ? `driving ${Math.round(s.speed)} km/h` : "parked"}  (GPS fix ${ago(s.dateTime)}${s.isDeviceCommunicating === false ? ", NOT communicating" : ""})`
      : "no position yet";
    console.log(`  - ${d.name}  [${d.licensePlate || "no registration"}]  id ${d.id}`);
    console.log(`      ${odo}  |  ${where}`);
  });

  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  const [rules, events, fillUps] = await Promise.all([geotab.getRules(), geotab.getExceptionEvents(from, to), geotab.getFillUps(from, to)]);
  const ruleName = new Map(rules.map((r) => [r.id, r.name || r.id]));
  const byRule = new Map();
  events.forEach((e) => byRule.set(e.rule?.id, (byRule.get(e.rule?.id) || 0) + 1));
  console.log(`\nRule violations in the last 7 days (${events.length}):`);
  if (byRule.size === 0) console.log("  none");
  [...byRule.entries()].sort((a, b) => b[1] - a[1]).forEach(([id, n]) => console.log(`  - ${ruleName.get(id) || id} (${id}): ${n}`));
  console.log("  The portal counts rules named like 'idling' or 'speeding' (and the built-in RuleIdlingId / RulePostedSpeedingId).");
  console.log("  To count another rule, add its id to GEOTAB_IDLING_RULE_IDS or GEOTAB_SPEEDING_RULE_IDS.");

  console.log(`\nFuel fill-ups in the last 7 days: ${fillUps.length}`);
  fillUps.slice(-5).forEach((f) => {
    const name = devices.find((d) => d.id === f.device?.id)?.name || f.device?.id;
    console.log(`  - ${new Date(f.dateTime).toLocaleString()}  ${name}  ${Math.round((f.volume || f.derivedVolume || 0) * 10) / 10} L`);
  });
  console.log("\nAll good. Restart the backend, then use 'Geotab vehicles' on the Logistics page to say which vehicle is which truck.");
})().catch((error) => {
  console.error(`\nFailed: ${error.message}`);
  if (error.geotabName === "InvalidUserException") console.error("Check the database name, user name and password. A user that must change its password at next login cannot use the API.");
  process.exit(1);
});
