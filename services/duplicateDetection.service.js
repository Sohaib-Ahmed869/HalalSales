// services/duplicateDetection.service.js
//
// Finds customer accounts that are really the same physical shop.
//
// Two things drive this:
//   1. Accounts sharing a delivery address but trading under different names.
//   2. Shops that get re-registered under a new name over time, leaving a trail
//      of stale accounts that nobody can connect back to the original.
//
// Detection is deliberately recomputed on demand rather than stored on the
// customer: the address/phone data changes constantly via the SAP sync, which
// writes with updateOne/bulkWrite and would bypass any mongoose hook.
// Confirmed decisions ARE stored, in CustomerGroup.

const Customer = require("../models/Customer");
const CustomerGroup = require("../models/CustomerGroup");
const Invoice = require("../models/Invoice");
const {
  buildAddressKey,
  collectPhoneKeys,
  pickMatchAddress,
  summariseNames,
} = require("../utils/addressNormalization");

// Above this many accounts a shared address or phone stops meaning "same shop".
// 32 rue Raspail (the depot) has 73 accounts against it; shopping centres and
// business parks produce the same shape. These are surfaced separately as hubs
// rather than dumped into the review queue.
const HUB_ADDRESS_THRESHOLD = 8;
const HUB_PHONE_THRESHOLD = 5;

const FIELDS =
  "CardCode CardName Email phoneNumber additionalPhoneNumbers status customerType " +
  "address deliveryAddress addresses coordinates assignedTo createdAt lastActivityDate " +
  "outstandingBalance company";

// A record can only take part in a match if it has an address or a phone.
// Skipping the rest avoids pulling ~6k useless documents over the wire.
const MATCHABLE = {
  $or: [
    { "address.street": { $nin: [null, ""] } },
    { "deliveryAddress.street": { $nin: [null, ""] } },
    { "addresses.street": { $nin: [null, ""] } },
    { phoneNumber: { $nin: [null, ""] } },
    { "additionalPhoneNumbers.0": { $exists: true } },
  ],
};

/**
 * Load the customers worth comparing.
 *
 * Scraped `prospect` records (17k of the 27k) are excluded by default: they are
 * lead-generation rows, not accounts, and they swamp the review queue.
 */
const loadCustomers = async ({ includeProspects = false, extraFilter = {} } = {}) => {
  const filter = { ...MATCHABLE, ...extraFilter };
  if (!includeProspects) filter.status = { $ne: "prospect" };
  return Customer.find(filter).select(FIELDS).lean();
};

/**
 * Group customers by a key produced by `keyFn`, dropping keys that only have
 * one account behind them.
 */
const groupBy = (customers, keyFn) => {
  const buckets = new Map();

  customers.forEach((customer) => {
    const keys = keyFn(customer);
    (Array.isArray(keys) ? keys : [keys]).filter(Boolean).forEach((key) => {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(customer);
    });
  });

  [...buckets.entries()].forEach(([key, members]) => {
    if (members.length < 2) buckets.delete(key);
  });

  return buckets;
};

/**
 * Score how confident we are that a group is one shop, 0..1.
 *
 * A shared *delivery* address is the strongest single signal, so it starts
 * high. Matching names, a shared phone and a small group size all push it up;
 * a large group pushes it down because big clusters are usually buildings
 * rather than businesses.
 */
const scoreGroup = ({ matchType, size, nameSummary, sharesPhone }) => {
  let score = matchType === "address" ? 0.55 : 0.45;

  if (nameSummary.allNamesIdentical) score += 0.3;
  else if (nameSummary.maxNameSimilarity >= 0.6) score += 0.22;
  else if (nameSummary.maxNameSimilarity >= 0.3) score += 0.1;

  if (sharesPhone && matchType === "address") score += 0.2;

  if (size === 2) score += 0.08;
  else if (size >= 5) score -= 0.15;
  else if (size >= 4) score -= 0.05;

  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
};

/**
 * Turn a bucket of customers into the candidate group shape the UI consumes.
 */
const buildCandidate = (key, matchType, members) => {
  const names = members.map((m) => m.CardName || "");
  const nameSummary = summariseNames(names);

  // Do the members also share a phone number? Corroborates an address match.
  const phoneSets = members.map((m) => new Set(collectPhoneKeys(m)));
  const sharesPhone = phoneSets.some((set, i) =>
    phoneSets.some((other, j) => i !== j && [...set].some((p) => other.has(p)))
  );

  const withCoords = members.find((m) => m.coordinates && m.coordinates.lat != null);
  const addr = pickMatchAddress(members.find((m) => pickMatchAddress(m)) || members[0]);

  return {
    key,
    matchType,
    size: members.length,
    confidence: scoreGroup({ matchType, size: members.length, nameSummary, sharesPhone }),
    ...nameSummary,
    sharesPhone,
    // The renaming case the sales team asked about: one address, several
    // different trading names.
    differentNames: nameSummary.distinctNameCount > 1,
    address: addr
      ? { street: addr.street, zipCode: addr.zipCode, city: addr.city }
      : null,
    coordinates: withCoords ? withCoords.coordinates : null,
    members: members.map((m) => ({
      _id: m._id,
      cardCode: m.CardCode,
      cardName: m.CardName,
      email: m.Email,
      phoneNumber: m.phoneNumber,
      status: m.status,
      customerType: m.customerType,
      company: m.company,
      assignedTo: m.assignedTo,
      createdAt: m.createdAt,
      lastActivityDate: m.lastActivityDate,
      outstandingBalance: m.outstandingBalance,
      address: m.deliveryAddress?.street ? m.deliveryAddress : m.address,
      coordinates: m.coordinates,
    })),
  };
};

/**
 * Attach sales activity to each member so the reviewer can tell which account is
 * the live one and which are the abandoned shells. One aggregation for all of
 * them, not one query per member.
 */
const attachSalesActivity = async (candidates) => {
  const cardCodes = [
    ...new Set(
      candidates.flatMap((c) => c.members.map((m) => m.cardCode).filter(Boolean))
    ),
  ];
  if (!cardCodes.length) return;

  const rows = await Invoice.aggregate([
    { $match: { CardCode: { $in: cardCodes } } },
    {
      $group: {
        _id: "$CardCode",
        totalSales: { $sum: "$DocTotal" },
        invoiceCount: { $sum: 1 },
        lastInvoiceDate: { $max: "$DocDate" },
      },
    },
  ]);

  const byCode = new Map(rows.map((r) => [r._id, r]));

  candidates.forEach((candidate) => {
    candidate.members.forEach((member) => {
      const stats = byCode.get(member.cardCode);
      member.totalSales = stats ? Math.round(stats.totalSales * 100) / 100 : 0;
      member.invoiceCount = stats ? stats.invoiceCount : 0;
      member.lastInvoiceDate = stats ? stats.lastInvoiceDate : null;
    });

    // Most recently invoiced account is the best guess at the live one.
    const active = [...candidate.members]
      .filter((m) => m.lastInvoiceDate)
      .sort((a, b) => new Date(b.lastInvoiceDate) - new Date(a.lastInvoiceDate))[0];

    candidate.suggestedPrimary = active ? active._id : candidate.members[0]._id;
    candidate.groupTotalSales =
      Math.round(candidate.members.reduce((s, m) => s + (m.totalSales || 0), 0) * 100) / 100;
    candidate.activeAccountCount = candidate.members.filter((m) => m.invoiceCount > 0).length;
  });
};

/**
 * Prior decisions, indexed by match key.
 */
const loadDecisions = async () => {
  const groups = await CustomerGroup.find({}).lean();

  const hubKeys = new Set();
  const ignored = new Map(); // matchKey -> Set of reviewed member ids
  const linkedByCustomer = new Map(); // customerId -> group

  groups.forEach((group) => {
    if (group.kind === "hub") {
      if (group.matchKey) hubKeys.add(group.matchKey);
      return;
    }

    if (group.kind === "ignored") {
      if (!group.matchKey) return;
      if (!ignored.has(group.matchKey)) ignored.set(group.matchKey, new Set());
      const set = ignored.get(group.matchKey);
      (group.members || []).forEach((m) => set.add(String(m.customer)));
      return;
    }

    (group.members || []).forEach((m) => linkedByCustomer.set(String(m.customer), group));
  });

  return { hubKeys, ignored, linkedByCustomer, groups };
};

/**
 * Scan the whole customer base and build every candidate group.
 *
 * This is the expensive half (a few seconds against Atlas) and is what gets
 * cached; filtering and paging happen against the cached result.
 */
const computeAllGroups = async ({ includeProspects = false } = {}) => {
  const [customers, decisions] = await Promise.all([
    loadCustomers({ includeProspects }),
    loadDecisions(),
  ]);

  const { hubKeys, ignored, linkedByCustomer } = decisions;

  const candidates = [];
  const hubs = [];

  const collect = (buckets, type, hubThreshold) => {
    buckets.forEach((members, key) => {
      const namespacedKey = `${type}:${key}`;

      // Shared locations/numbers: report them, but never as duplicates.
      if (members.length > hubThreshold || hubKeys.has(namespacedKey)) {
        hubs.push({
          key: namespacedKey,
          matchType: type,
          size: members.length,
          confirmedHub: hubKeys.has(namespacedKey),
          address: type === "address" ? key.split("|") : null,
          phone: type === "phone" ? key : null,
          sampleNames: members.slice(0, 6).map((m) => m.CardName),
        });
        return;
      }

      const candidate = buildCandidate(namespacedKey, type, members);

      const reviewedIds = ignored.get(namespacedKey);
      const memberIds = candidate.members.map((m) => String(m._id));
      // Suppress a rejected group only while it is unchanged. If a new account
      // shows up at the same address the group is worth another look.
      const fullyIgnored =
        reviewedIds && memberIds.every((id) => reviewedIds.has(id));

      const linkedGroup = memberIds
        .map((id) => linkedByCustomer.get(id))
        .find(Boolean);
      const fullyLinked =
        linkedGroup &&
        memberIds.every((id) => {
          const g = linkedByCustomer.get(id);
          return g && String(g._id) === String(linkedGroup._id);
        });

      candidate.reviewStatus = fullyLinked ? "linked" : fullyIgnored ? "ignored" : "new";
      candidate.linkedGroupId = fullyLinked ? linkedGroup._id : null;
      candidate.hasNewMembers = Boolean(
        (reviewedIds || linkedGroup) && !fullyIgnored && !fullyLinked
      );

      candidates.push(candidate);
    });
  };

  collect(groupBy(customers, buildAddressKey), "address", HUB_ADDRESS_THRESHOLD);
  collect(groupBy(customers, collectPhoneKeys), "phone", HUB_PHONE_THRESHOLD);

  // When both signals fire for the same set of accounts, keep the address one:
  // a shared delivery address is the stronger claim about a physical shop.
  const seenSignatures = new Map();
  const deduped = [];
  candidates
    .sort((a, b) => (a.matchType === "address" ? -1 : 1))
    .forEach((candidate) => {
      const signature = candidate.members
        .map((m) => String(m._id))
        .sort()
        .join(",");
      if (seenSignatures.has(signature)) {
        // Record that the phone agreed, then drop the duplicate entry.
        seenSignatures.get(signature).sharesPhone = true;
        return;
      }
      seenSignatures.set(signature, candidate);
      deduped.push(candidate);
    });

  await attachSalesActivity(deduped);

  deduped.sort(
    (a, b) => b.confidence - a.confidence || b.groupTotalSales - a.groupTotalSales
  );

  return {
    groups: deduped,
    hubs: hubs.sort((a, b) => b.size - a.size),
    scannedCustomers: customers.length,
  };
};

// The scan takes a few seconds against Atlas and the underlying data barely
// moves between SAP syncs, so the result is held briefly in memory. Any write
// through this service clears it so a confirmed link disappears immediately.
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();

const invalidateCache = () => cache.clear();

const getComputedGroups = async ({ includeProspects = false, refresh = false } = {}) => {
  const cacheKey = `prospects:${includeProspects}`;
  const hit = cache.get(cacheKey);

  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { ...hit.value, cached: true, computedAt: new Date(hit.at) };
  }

  const value = await computeAllGroups({ includeProspects });
  cache.set(cacheKey, { at: Date.now(), value });
  return { ...value, cached: false, computedAt: new Date() };
};

/**
 * Query the detected groups: filter, search and page.
 *
 * @param {Object} options
 * @param {'address'|'phone'|'all'} options.matchType
 * @param {'new'|'linked'|'ignored'|'all'} options.reviewStatus
 * @param {number}  options.minConfidence
 * @param {boolean} options.onlyDifferentNames  only the "renamed shop" case
 * @param {boolean} options.onlyWithSales       only groups that have traded
 * @param {string}  options.search              name / card code / postcode
 * @param {'confidence'|'sales'|'size'} options.sortBy
 */
const detectDuplicateGroups = async ({
  matchType = "all",
  reviewStatus = "new",
  minConfidence = 0,
  onlyDifferentNames = false,
  onlyWithSales = false,
  includeProspects = false,
  search = "",
  sortBy = "confidence",
  page = 1,
  limit = 25,
  refresh = false,
} = {}) => {
  const computed = await getComputedGroups({ includeProspects, refresh });

  let groups = computed.groups;

  if (matchType !== "all") groups = groups.filter((g) => g.matchType === matchType);
  if (reviewStatus !== "all") groups = groups.filter((g) => g.reviewStatus === reviewStatus);
  if (minConfidence > 0) groups = groups.filter((g) => g.confidence >= minConfidence);
  if (onlyDifferentNames) groups = groups.filter((g) => g.differentNames);
  if (onlyWithSales) groups = groups.filter((g) => g.groupTotalSales > 0);

  if (search) {
    const needle = search.toLowerCase().trim();
    groups = groups.filter((g) =>
      g.members.some(
        (m) =>
          (m.cardName || "").toLowerCase().includes(needle) ||
          (m.cardCode || "").toLowerCase().includes(needle)
      ) || (g.address?.zipCode || "").toLowerCase().includes(needle)
    );
  }

  const sorters = {
    confidence: (a, b) => b.confidence - a.confidence || b.groupTotalSales - a.groupTotalSales,
    sales: (a, b) => b.groupTotalSales - a.groupTotalSales,
    size: (a, b) => b.size - a.size || b.confidence - a.confidence,
  };
  groups = [...groups].sort(sorters[sortBy] || sorters.confidence);

  const total = groups.length;
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 200));
  const safePage = Math.max(1, Number(page) || 1);
  const paged = groups.slice((safePage - 1) * safeLimit, safePage * safeLimit);

  // Headline counts describe the whole detected set, not the current page, so
  // the numbers do not jump around as filters are applied.
  const all = computed.groups;
  const unreviewed = all.filter((g) => g.reviewStatus === "new");

  return {
    groups: paged,
    hubs: computed.hubs,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.ceil(total / safeLimit) || 1,
    },
    summary: {
      scannedCustomers: computed.scannedCustomers,
      totalGroups: all.length,
      unreviewedGroups: unreviewed.length,
      affectedAccounts: unreviewed.reduce((s, g) => s + g.size, 0),
      renamedShopGroups: unreviewed.filter((g) => g.differentNames).length,
      exactDuplicateGroups: unreviewed.filter((g) => !g.differentNames).length,
      linkedGroups: all.filter((g) => g.reviewStatus === "linked").length,
      ignoredGroups: all.filter((g) => g.reviewStatus === "ignored").length,
      hubLocations: computed.hubs.length,
      matchingFilters: total,
    },
    cached: computed.cached,
    computedAt: computed.computedAt,
  };
};

module.exports = {
  detectDuplicateGroups,
  getComputedGroups,
  invalidateCache,
  loadDecisions,
  HUB_ADDRESS_THRESHOLD,
  HUB_PHONE_THRESHOLD,
};
