// scripts/reconcile-invoice-statuses.js
//
// Full re-baseline of the local invoice mirror against SAP.
//
// syncInvoiceStatusesFromSAP (POST /api/invoices/invoices/sync-status) is
// incremental: it only looks at invoices whose UpdateDate moved since the last
// successful run. If that endpoint stops being called - it has no cron of its
// own - the mirror freezes: invoices settled in SAP stay flagged bost_Open
// locally, and invoices that were closed keep the PaidToDate they were first
// imported with (usually 0). Both make every locally derived balance too high.
//
// This script re-reads DocumentStatus and PaidToDate for every invoice in SAP
// and writes them over the local copies. Run it once after a long gap, then let
// the incremental sync take over again.
//
//   node scripts/reconcile-invoice-statuses.js --dry-run
//   node scripts/reconcile-invoice-statuses.js
//   node scripts/reconcile-invoice-statuses.js --card-code C4925

require("dotenv").config();

const mongoose = require("mongoose");
const axios = require("axios");

const Invoice = require("../models/Invoice");
const { loginToSAP } = require("../utils/sapB1Integration");

const SERVICE_LAYER_URL = process.env.SAP_SERVICE_LAYER_URL;
const PAGE_SIZE = 500;
const BATCH_SIZE = 500;

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const cardCodeArg = args.indexOf("--card-code");
const CARD_CODE = cardCodeArg !== -1 ? args[cardCodeArg + 1] : null;

async function fetchInvoicesFromSAP(headers) {
  const invoices = new Map();

  const filter = CARD_CODE ? `?$filter=CardCode eq '${CARD_CODE}'&` : "?";
  let nextLink =
    `${SERVICE_LAYER_URL}/Invoices${filter}` +
    `$select=DocEntry,DocNum,CardCode,DocTotal,PaidToDate,DocumentStatus,Cancelled` +
    `&$orderby=DocEntry`;

  let page = 0;

  while (nextLink) {
    const response = await axios.get(nextLink, { headers });
    const batch = response.data.value || [];

    for (const inv of batch) {
      invoices.set(inv.DocNum, {
        DocNum: inv.DocNum,
        DocEntry: inv.DocEntry,
        CardCode: inv.CardCode,
        DocTotal: Number(inv.DocTotal) || 0,
        PaidToDate: Number(inv.PaidToDate) || 0,
        DocumentStatus: inv.DocumentStatus,
        Cancelled: inv.Cancelled,
      });
    }

    page++;
    if (page % 20 === 0 || batch.length < PAGE_SIZE) {
      console.log(`   page ${page}: ${invoices.size} invoices read from SAP`);
    }

    nextLink = response.data["odata.nextLink"];
    if (nextLink && !nextLink.startsWith("http")) {
      nextLink = `${SERVICE_LAYER_URL}/${nextLink.replace(/^\//, "")}`;
    }
  }

  return invoices;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  const sessionId = await loginToSAP();
  const headers = {
    "Content-Type": "application/json",
    Cookie: `B1SESSION=${sessionId}`,
    Prefer: `odata.maxpagesize=${PAGE_SIZE}`,
  };

  console.log("\nReading invoices from SAP...");
  const sapInvoices = await fetchInvoicesFromSAP(headers);
  console.log(`Read ${sapInvoices.size} invoices from SAP`);

  const localFilter = CARD_CODE ? { CardCode: CARD_CODE } : {};
  const localInvoices = await Invoice.find(localFilter)
    .select("DocNum DocTotal PaidToDate DocumentStatus CardCode")
    .lean();
  console.log(`Read ${localInvoices.length} invoices from Mongo`);

  const bulkOps = [];
  const stats = {
    statusCorrected: 0,
    paidToDateCorrected: 0,
    notInSAP: 0,
    unchanged: 0,
    phantomBalanceCleared: 0,
  };

  for (const local of localInvoices) {
    const sap = sapInvoices.get(local.DocNum);

    if (!sap) {
      stats.notInSAP++;
      continue;
    }

    const localPaid = Number(local.PaidToDate) || 0;
    const statusDiffers = local.DocumentStatus !== sap.DocumentStatus;
    const paidDiffers = Math.abs(localPaid - sap.PaidToDate) > 0.005;

    if (!statusDiffers && !paidDiffers) {
      stats.unchanged++;
      continue;
    }

    if (statusDiffers) stats.statusCorrected++;
    if (paidDiffers) stats.paidToDateCorrected++;

    // How much fictitious outstanding this row was contributing.
    const oldBalance =
      ["bost_Open", "O"].includes(local.DocumentStatus) || statusDiffers
        ? (Number(local.DocTotal) || 0) - localPaid
        : 0;
    const newBalance =
      sap.DocumentStatus === "bost_Open" ? sap.DocTotal - sap.PaidToDate : 0;
    stats.phantomBalanceCleared += Math.max(0, oldBalance - newBalance);

    const remaining = Math.max(0, sap.DocTotal - sap.PaidToDate);

    bulkOps.push({
      updateOne: {
        filter: { DocNum: local.DocNum },
        update: {
          $set: {
            DocumentStatus: sap.DocumentStatus,
            PaidToDate: sap.PaidToDate,
            Cancelled: sap.Cancelled,
            LocalStatus: "Synced",
            paymentStatus:
              remaining <= 0.01
                ? "Fully Paid"
                : sap.PaidToDate > 0
                  ? "Partially Paid"
                  : "Unpaid",
            "paymentTracking.totalInvoiceAmount": sap.DocTotal,
            "paymentTracking.totalPaidAmount": sap.PaidToDate,
            "paymentTracking.remainingBalance": remaining,
          },
        },
      },
    });
  }

  console.log("\nDifferences found:");
  console.log(`   DocumentStatus corrections: ${stats.statusCorrected}`);
  console.log(`   PaidToDate corrections:     ${stats.paidToDateCorrected}`);
  console.log(`   Already correct:            ${stats.unchanged}`);
  console.log(`   Local invoices not in SAP:  ${stats.notInSAP}`);
  console.log(
    `   Fictitious outstanding cleared: EUR ${stats.phantomBalanceCleared.toFixed(2)}`
  );

  if (DRY_RUN) {
    console.log("\nDry run - nothing written.");
  } else if (bulkOps.length > 0) {
    let modified = 0;
    for (let i = 0; i < bulkOps.length; i += BATCH_SIZE) {
      const batch = bulkOps.slice(i, i + BATCH_SIZE);
      const result = await Invoice.bulkWrite(batch, { ordered: false });
      modified += result.modifiedCount || 0;
      console.log(
        `   batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(bulkOps.length / BATCH_SIZE)}: ${result.modifiedCount} updated`
      );
    }
    console.log(`\nUpdated ${modified} invoices.`);
  } else {
    console.log("\nNothing to update.");
  }

  await mongoose.disconnect();
}

main()
  .then(() => {
    // loginToSAP arms a 25-minute session-refresh timer that would otherwise
    // hold the event loop open long after the work is done.
    process.exit(0);
  })
  .catch((error) => {
    console.error("Reconciliation failed:", error);
    process.exit(1);
  });
