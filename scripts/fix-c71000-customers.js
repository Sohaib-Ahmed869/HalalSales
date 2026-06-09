// Cleanup: re-number local customers stuck on the corrupt "C71000" CardCode.
//
// Background: a bug in generateNextCardCode() produced "C71000" for every new
// customer. SAP enforces unique CardCodes, so only the FIRST C71000 reached SAP;
// the rest are stuck locally with SyncedWithSAP=false. This script assigns each
// unsynced C71000 customer the next correct sequential code (C8003, C8004, ...)
// and creates it in SAP B1.
//
// It processes customers ONE AT A TIME and pushes to SAP before generating the
// next code, so the codes stay sequential and never collide.
//
// Usage:
//   node scripts/fix-c71000-customers.js            (dry run - shows plan only)
//   node scripts/fix-c71000-customers.js --apply     (actually writes to SAP)

const mongoose = require("mongoose");
require("dotenv").config();
const Customer = require("../models/Customer");
const {
  generateNextCardCode,
  formatCustomerForSAP,
  createCustomerInSAP,
} = require("../utils/sapB1CustomerIntegration");

const APPLY = process.argv.includes("--apply");

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`Connected to MongoDB. Mode: ${APPLY ? "APPLY (writing to SAP)" : "DRY RUN"}\n`);

  // The corrupt C71000 BP was manually deleted from SAP, so ALL C71000 records
  // (including the formerly-synced LR FOOD) need a fresh sequential code and a
  // push to SAP. Processed in creation order.
  const toFix = await Customer.find({ CardCode: "C71000" }).sort({ createdAt: 1 });

  console.log(`Customers to re-number: ${toFix.length}\n`);

  const results = [];
  for (const customer of toFix) {
    const newCode = await generateNextCardCode();
    console.log(`${customer.CardName}: C71000 -> ${newCode}${APPLY ? "" : "  (dry run)"}`);

    if (!APPLY) {
      results.push({ name: customer.CardName, newCode, applied: false });
      // In dry-run we cannot reserve the code in SAP, so we cannot preview the
      // *next* sequential value accurately. Stop after showing the first target.
      console.log("\n(Dry run: only the first target is shown because subsequent");
      console.log(" codes depend on each push landing in SAP. Re-run with --apply.)");
      break;
    }

    customer.CardCode = newCode;
    await customer.save();

    try {
      const sapCustomer = await formatCustomerForSAP(customer);
      const sapResponse = await createCustomerInSAP(sapCustomer);

      if (sapResponse && sapResponse.CardCode) {
        customer.CardCode = sapResponse.CardCode;
        customer.customerType = "sap";
        customer.SyncedWithSAP = true;
        customer.LocalStatus = "Synced";
        customer.SyncErrors = undefined;
        customer.updatedAt = new Date();
        await customer.save();
        console.log(`   -> synced to SAP as ${sapResponse.CardCode}`);
        results.push({ name: customer.CardName, newCode: sapResponse.CardCode, applied: true });
      } else {
        throw new Error("Invalid response from SAP (no CardCode)");
      }
    } catch (err) {
      customer.SyncErrors = err.message;
      customer.LastSyncAttempt = new Date();
      customer.LocalStatus = "SyncFailed";
      await customer.save();
      console.error(`   !! FAILED to sync ${customer.CardName}: ${err.message}`);
      console.error("   Stopping to avoid reusing the same code. Fix and re-run.");
      results.push({ name: customer.CardName, newCode, applied: false, error: err.message });
      break;
    }
  }

  console.log("\n=== Summary ===");
  for (const r of results) {
    console.log(`${r.applied ? "OK " : "-- "} ${r.name} -> ${r.newCode}${r.error ? " (ERROR: " + r.error + ")" : ""}`);
  }

  await mongoose.disconnect();
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
