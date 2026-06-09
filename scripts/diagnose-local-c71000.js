// Diagnostic: inspect local DB customers stuck on the corrupt C71000 code.
const mongoose = require("mongoose");
require("dotenv").config();
const Customer = require("../models/Customer");

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB.\n");

  const stuck = await Customer.find({ CardCode: "C71000" })
    .select("CardName CardCode tempCardCode SyncedWithSAP approvalStatus status createdAt")
    .sort({ createdAt: 1 })
    .lean();

  console.log(`Local customers with CardCode = "C71000": ${stuck.length}\n`);
  for (const c of stuck) {
    console.log(
      `${c.CardName} | synced=${c.SyncedWithSAP} | approval=${c.approvalStatus} | status=${c.status} | created=${c.createdAt && c.createdAt.toISOString().slice(0,10)} | _id=${c._id}`
    );
  }

  // Also surface anything else in the broken >C8999 numeric band locally
  const allHigh = await Customer.find({ CardCode: /^C\d{5,}$/ })
    .select("CardName CardCode")
    .lean();
  const weird = allHigh.filter((c) => {
    const m = c.CardCode.match(/^C(\d+)$/);
    return m && parseInt(m[1], 10) >= 9000 && c.CardCode !== "C9998" && c.CardCode !== "C9999";
  });
  console.log(`\nOther local customers with numeric CardCode >= 9000 (excl C9998/C9999): ${weird.length}`);
  for (const c of weird) console.log(`  ${c.CardCode} - ${c.CardName}`);

  await mongoose.disconnect();
}

main().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
