// scripts/seedTestOpeningHours.js
//
// One-off, manually run script. NOT wired into server.js, NOT a cron job,
// NOT run automatically anywhere. Fills random-but-plausible openingTime/
// closingTime onto customers for testing the map/truck-routing feature.
//
// Rule: only touches customers where BOTH openingTime and closingTime are
// currently unset. Any customer that already has a real value in either
// field (e.g. saved through the now-fixed Add/Edit Customer form) is left
// completely alone.
//
// Usage:
//   node scripts/seedTestOpeningHours.js

require("dotenv").config();
const dns = require("dns");
const mongoose = require("mongoose");
const Customer = require("../models/Customer");

// Same workaround as server.js: some Windows/ISP/router DNS setups fail SRV
// lookups (mongodb+srv://) even though the OS resolver works fine.
dns.setServers(["8.8.8.8", "1.1.1.1"]);

const PLAUSIBLE_WINDOWS = [
  { openingTime: "08:00", closingTime: "17:00" },
  { openingTime: "09:00", closingTime: "18:00" },
  { openingTime: "09:00", closingTime: "20:00" },
  { openingTime: "10:00", closingTime: "19:00" },
  { openingTime: "07:00", closingTime: "16:00" },
  { openingTime: "11:00", closingTime: "22:00" },
  { openingTime: "08:30", closingTime: "17:30" },
];

async function run() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  await mongoose.connect(mongoUri);
  console.log(`Connected to ${mongoUri}`);

  const filter = {
    $and: [
      { $or: [{ openingTime: { $exists: false } }, { openingTime: null }, { openingTime: "" }] },
      { $or: [{ closingTime: { $exists: false } }, { closingTime: null }, { closingTime: "" }] },
    ],
  };

  const candidateIds = await Customer.find(filter).distinct("_id");
  console.log(`Found ${candidateIds.length} customers with no opening/closing time set.`);

  const BATCH_SIZE = 500;
  let updated = 0;

  for (let i = 0; i < candidateIds.length; i += BATCH_SIZE) {
    const batchIds = candidateIds.slice(i, i + BATCH_SIZE);
    const ops = batchIds.map((id) => {
      const window = PLAUSIBLE_WINDOWS[Math.floor(Math.random() * PLAUSIBLE_WINDOWS.length)];
      return {
        updateOne: {
          // Re-check the same "still unset" condition at write time so a
          // record that picked up a real value between the find() and this
          // write (e.g. someone saving the Edit Customer form right now)
          // is never overwritten.
          filter: { _id: id, ...filter },
          update: { $set: { openingTime: window.openingTime, closingTime: window.closingTime } },
        },
      };
    });

    const result = await Customer.bulkWrite(ops, { ordered: false });
    updated += result.modifiedCount || 0;
    console.log(`  ...${Math.min(i + BATCH_SIZE, candidateIds.length)}/${candidateIds.length}`);
  }

  console.log(`Seeded random test opening/closing times for ${updated} customers.`);
  console.log("Existing values, if any, were left untouched.");
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Seed script failed:", err);
  process.exit(1);
});
