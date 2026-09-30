// services/sapCustomerBalanceSync.service.js
//
// Keeps Customer.outstandingBalance aligned with the BP account balance held in
// SAP (BusinessPartners.CurrentAccountBalance) - the exact figure users read off
// the Business Partner Master Data screen.
//
// Before this existed the field was only written by (a) a manual Excel upload of
// the SAP "Account Balance" report and (b) updateCustomerInvoiceTotals(), which
// re-derived it from local open invoices. Both drift: the local invoice mirror
// misses payments applied in SAP after an invoice was first imported, and it can
// never produce the negative balances that represent prepaid credit.

const cron = require("node-cron");
const axios = require("axios");
const Customer = require("../models/Customer");
const SyncMetadata = require("../models/SyncMetadata");
const { loginToSAP } = require("../utils/sapB1Integration");

const SERVICE_LAYER_URL = process.env.SAP_SERVICE_LAYER_URL;
const PAGE_SIZE = 500;
const SYNC_TYPE = "customer_balance_sync";

/**
 * Page through every customer BP in SAP and return a Map of CardCode -> balance.
 */
async function fetchAllBalancesFromSAP(headers) {
  const balances = new Map();

  let nextLink =
    `${SERVICE_LAYER_URL}/BusinessPartners` +
    `?$select=CardCode,CurrentAccountBalance` +
    `&$filter=CardType eq 'cCustomer'` +
    `&$orderby=CardCode`;

  let page = 0;

  while (nextLink) {
    const response = await axios.get(nextLink, { headers });
    const batch = response.data.value || [];

    for (const bp of batch) {
      if (bp.CardCode) {
        balances.set(bp.CardCode, Number(bp.CurrentAccountBalance) || 0);
      }
    }

    page++;
    console.log(
      `   page ${page}: ${batch.length} business partners (${balances.size} total)`
    );

    nextLink = response.data["odata.nextLink"];
    if (nextLink && !nextLink.startsWith("http")) {
      nextLink = `${SERVICE_LAYER_URL}/${nextLink.replace(/^\//, "")}`;
    }

    if (nextLink) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  return balances;
}

/**
 * Sync the account balance of every SAP customer into Mongo.
 *
 * @param {Object}  [options]
 * @param {boolean} [options.dryRun] Report what would change without writing.
 * @returns {Promise<Object>} sync statistics
 */
async function syncAllCustomerBalancesFromSAP(options = {}) {
  const { dryRun = false } = options;
  const startedAt = new Date();

  console.log("\n" + "=".repeat(60));
  console.log("STARTING CUSTOMER BALANCE SYNC FROM SAP");
  console.log("=".repeat(60));

  const sessionId = await loginToSAP();
  const headers = {
    "Content-Type": "application/json",
    Cookie: `B1SESSION=${sessionId}`,
    Prefer: `odata.maxpagesize=${PAGE_SIZE}`,
  };

  console.log("\nFetching business partner balances from SAP...");
  const sapBalances = await fetchAllBalancesFromSAP(headers);
  console.log(`Fetched ${sapBalances.size} business partner balances`);

  const localCustomers = await Customer.find({
    CardCode: { $in: Array.from(sapBalances.keys()) },
  })
    .select("CardCode outstandingBalance")
    .lean();

  console.log(`Matched ${localCustomers.length} local customers`);

  const bulkOps = [];
  const changes = [];
  let unchanged = 0;

  for (const customer of localCustomers) {
    const sapBalance = sapBalances.get(customer.CardCode);
    const localBalance = Number(customer.outstandingBalance) || 0;

    if (Math.abs(localBalance - sapBalance) <= 0.005) {
      unchanged++;
      continue;
    }

    changes.push({
      CardCode: customer.CardCode,
      from: localBalance,
      to: sapBalance,
    });

    bulkOps.push({
      updateOne: {
        filter: { CardCode: customer.CardCode },
        update: {
          $set: {
            outstandingBalance: sapBalance,
            sapBalanceSyncedAt: startedAt,
          },
        },
      },
    });
  }

  console.log(
    `\n${changes.length} balances differ from SAP, ${unchanged} already correct`
  );

  let updated = 0;

  if (!dryRun && bulkOps.length > 0) {
    const BATCH_SIZE = 500;
    for (let i = 0; i < bulkOps.length; i += BATCH_SIZE) {
      const batch = bulkOps.slice(i, i + BATCH_SIZE);
      const result = await Customer.bulkWrite(batch, { ordered: false });
      updated += result.modifiedCount || 0;
      console.log(
        `Batch ${Math.floor(i / BATCH_SIZE) + 1}: updated ${result.modifiedCount} customers`
      );
    }
  }

  const stats = {
    sapBusinessPartners: sapBalances.size,
    localCustomersMatched: localCustomers.length,
    balancesChanged: changes.length,
    balancesUnchanged: unchanged,
    customersUpdated: updated,
    dryRun,
    // Biggest corrections first - the useful ones to eyeball after a run.
    largestCorrections: changes
      .slice()
      .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from))
      .slice(0, 20),
  };

  if (!dryRun) {
    await SyncMetadata.findOneAndUpdate(
      { syncType: SYNC_TYPE },
      {
        lastSyncDate: startedAt,
        lastSyncStatus: "success",
        lastSyncStats: {
          sapBusinessPartners: stats.sapBusinessPartners,
          localCustomersMatched: stats.localCustomersMatched,
          balancesChanged: stats.balancesChanged,
          customersUpdated: stats.customersUpdated,
        },
        updatedAt: new Date(),
      },
      { upsert: true }
    );
  }

  console.log("\n" + "=".repeat(60));
  console.log("CUSTOMER BALANCE SYNC COMPLETED");
  console.log(`Business partners in SAP: ${stats.sapBusinessPartners}`);
  console.log(`Local customers matched:  ${stats.localCustomersMatched}`);
  console.log(`Balances corrected:       ${stats.customersUpdated}`);
  console.log(`Took ${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)}s`);
  console.log("=".repeat(60) + "\n");

  return stats;
}

/**
 * Refresh a single customer's balance straight from SAP.
 *
 * @param {string} cardCode
 * @returns {Promise<number|null>} the SAP balance, or null if not held in SAP
 */
async function syncCustomerBalanceFromSAP(cardCode) {
  if (!cardCode) return null;

  const sessionId = await loginToSAP();
  const headers = {
    "Content-Type": "application/json",
    Cookie: `B1SESSION=${sessionId}`,
  };

  const response = await axios.get(
    `${SERVICE_LAYER_URL}/BusinessPartners('${encodeURIComponent(cardCode)}')` +
    `?$select=CardCode,CurrentAccountBalance`,
    { headers }
  );

  const sapBalance = Number(response.data?.CurrentAccountBalance) || 0;

  await Customer.findOneAndUpdate(
    { CardCode: cardCode },
    { $set: { outstandingBalance: sapBalance, sapBalanceSyncedAt: new Date() } }
  );

  return sapBalance;
}

let cronTask = null;

/**
 * Run the balance sync daily. Scheduled after the 04:00 invoice import so the
 * balances line up with the invoices that landed the same night.
 */
function startCustomerBalanceSyncCron(
  schedule = process.env.CUSTOMER_BALANCE_SYNC_CRON || "30 5 * * *"
) {
  if (cronTask) return cronTask;

  cronTask = cron.schedule(schedule, async () => {
    try {
      await syncAllCustomerBalancesFromSAP();
    } catch (error) {
      console.error("Customer balance sync failed:", error.message);
      await SyncMetadata.findOneAndUpdate(
        { syncType: SYNC_TYPE },
        { lastSyncStatus: "failed", updatedAt: new Date() },
        { upsert: true }
      ).catch(() => { });
    }
  });

  console.log(`Customer balance sync cron scheduled (${schedule})`);
  return cronTask;
}

function stopCustomerBalanceSyncCron() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }
}

module.exports = {
  syncAllCustomerBalancesFromSAP,
  syncCustomerBalanceFromSAP,
  startCustomerBalanceSyncCron,
  stopCustomerBalanceSyncCron,
};
