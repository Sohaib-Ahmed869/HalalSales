// scripts/geocodeDeliveryAddresses.js
//
// One-time (re-runnable) backfill for the Logistics map: geocodes every
// customer whose delivery address has no pin that belongs to it (see
// deliveryPoint in utils/geocodingService.js), e.g. customers with a separate
// deliveryAddress whose old pin came from the billing address. Without it
// they are geocoded on the fly the first time their orders are listed, which
// slows that first page load.
//
//   node scripts/geocodeDeliveryAddresses.js            dry run: counts only, writes nothing
//   node scripts/geocodeDeliveryAddresses.js --apply    geocode and save (Google, then Photon)
//   node scripts/geocodeDeliveryAddresses.js --apply --limit 200
//
// Uses the backend .env (MONGO_URI, GOOGLE_MAPS_API_KEY). One Google
// Geocoding request per customer, sequential. Only fills customer.geo; the
// pre-existing `coordinates` field is never changed.

require("dotenv").config();
const mongoose = require("mongoose");
const Customer = require("../models/Customer");
const { deliveryPoint, geocodeCustomer } = require("../utils/geocodingService");

const apply = process.argv.includes("--apply");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) || Infinity : Infinity;

(async () => {
  await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const todo = [];
  let total = 0;
  const cursor = Customer.find({ fulfillmentMethod: { $ne: "pickup" } }).lean().cursor();
  for await (const c of cursor) {
    total++;
    const { address, coords } = deliveryPoint(c);
    if (coords || !(address?.street || address?.zipCode)) continue;
    if (c.geo?.geocodeStatus === "failed" && c.geo?.addressKey) continue; // already tried this address
    todo.push(c.CardCode);
  }
  console.log(`${total} delivery customers, ${todo.length} need their delivery address geocoded.`);
  if (!apply) {
    console.log("Dry run: nothing written. Run with --apply to geocode them.");
    await mongoose.disconnect();
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const cardCode of todo.slice(0, limit)) {
    const doc = await Customer.findOne({ CardCode: cardCode });
    if (!doc) continue;
    await geocodeCustomer(doc);
    if (doc.geo?.geocodeStatus === "ok") ok++;
    else failed++;
    if ((ok + failed) % 50 === 0) console.log(`  ${ok + failed} done (${ok} ok, ${failed} failed)`);
  }
  console.log(`Finished: ${ok} geocoded, ${failed} failed (check those addresses).`);
  await mongoose.disconnect();
})().catch((e) => {
  console.error("Failed:", e.message);
  process.exit(1);
});
