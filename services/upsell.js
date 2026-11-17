// services/upsell.js
//
// Upsell flags: what an existing customer sells on Uber Eats against what they
// buy from us. "Sells chicken wings on their menu, bought no wings from us in
// the last 6 months" + the menu items that show it + our products to offer.
//
// - Which customers: every customer the Sales Map / Uber Eats Scraper already
//   knows as the same business as a scraped Uber Eats store (prospectContext:
//   phone / email / name / address matching, kept 10 minutes), plus the store
//   saved on the customer's profile (Customer.uberEatsUrl). A customer with
//   several stores (brands of one kitchen) gets the menus of all of them.
// - What their menu implies: the keyword table in config/upsellCategories.js
//   (no AI; every flag names the menu items it comes from).
// - What they buy: invoice lines (DocumentLines.ItemCode), not cancelled.
//
// Read only: nothing is written anywhere. The list of every flagged customer
// takes a few seconds to build (the menus and 24 months of invoice lines of the
// ~350 linked customers who bought in the period, on top of the store matching),
// so it is kept in memory for 10 minutes, like the matching it relies on; one
// customer's flags are computed on each request (a few small queries).
const Customer = require("../models/Customer");
const Invoice = require("../models/Invoice");
const Item = require("../models/item");
const { ueCollections } = require("../utils/ubereatsDb");
const { existingUeMatches, ownerNames } = require("../utils/prospectContext");
const cfg = require("../config/upsellCategories");

const TTL_MS = 10 * 60 * 1000;

// ---------- text matching ----------

/** Lowercase, no accents, only letters / digits separated by single spaces. */
function norm(v) {
  return String(v || "")
    .toLowerCase()
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const escapeRegex = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One regex for a list of words / phrases: whole words, optional plural s / x on the last one. */
function wordsRegex(list) {
  const words = [...new Set((list || []).map(norm).filter(Boolean))];
  if (!words.length) return null;
  return new RegExp(`(?:^| )(?:${words.map(escapeRegex).join("|")})(?:s|x)?(?= |$)`);
}

// The table, compiled once.
const KIND_ORDER = new Map(cfg.KINDS.map((k, i) => [k.key, i]));
const CATEGORIES = cfg.CATEGORIES.map((c) => ({
  ...c,
  menuRe: wordsRegex(c.menu),
  menuNotRe: wordsRegex(c.menuNot),
  groups: new Set(c.products.groups || []),
  nameParts: (c.products.name || []).map(norm),
  notParts: (c.products.not || []).map(norm),
}));

const menuHas = (cat, text) => cat.menuRe && cat.menuRe.test(text) && !(cat.menuNotRe && cat.menuNotRe.test(text));
const itemIs = (cat, item) => {
  if (cat.groups.size && !cat.groups.has(item.ItemsGroupCode)) return false;
  const name = ` ${norm(item.ItemName)} `;
  return cat.nameParts.some((p) => name.includes(p)) && !cat.notParts.some((p) => name.includes(p));
};
const isActive = (item) => item.Valid !== "tNO" && item.Frozen !== "tYES";

// ---------- which Uber Eats stores are a customer ----------

/** Uber Eats store URL (…/store/<slug>/<id>) -> store uuid; null when it isn't one. */
function storeUuidFromUrl(url) {
  const id = String(url || "").match(/\/store\/[^/]+\/([A-Za-z0-9_-]{22})/)?.[1];
  if (!id) return null;
  const hex = Buffer.from(id, "base64url").toString("hex");
  if (hex.length !== 32) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** CardCode -> [{ uuid, via }] for every customer that is an Uber Eats store. `onlyCodes` limits it to some customers. */
async function linkedStores(onlyCodes = null) {
  const out = new Map();
  const add = (code, uuid, via) => {
    if (!code || !uuid || (onlyCodes && !onlyCodes.has(code))) return;
    const list = out.get(code) || [];
    if (!list.some((l) => l.uuid === uuid)) list.push({ uuid, via });
    out.set(code, list);
  };
  const matches = await existingUeMatches();
  matches.forEach((m, uuid) => m.type === "customer" && add(m.id, uuid, `same ${m.via}`));
  const saved = await Customer.find({ uberEatsUrl: { $nin: [null, ""] }, ...(onlyCodes ? { CardCode: { $in: [...onlyCodes] } } : {}) })
    .select("CardCode uberEatsUrl")
    .lean();
  saved.forEach((c) => add(c.CardCode, storeUuidFromUrl(c.uberEatsUrl), "Uber Eats link on the customer"));
  return out;
}

const STORE_FIELDS = { _id: 0, uuid: 1, title: 1, url: 1, menuItemCount: 1, detailsScrapedAt: 1, lastSeenAt: 1, "menu.title": 1, "menu.items.title": 1 };

async function loadStores(uuids) {
  if (!uuids.length) return new Map();
  const c = await ueCollections();
  const stores = await c.restaurants.find({ uuid: { $in: uuids } }, { projection: STORE_FIELDS }).toArray();
  return new Map(stores.map((s) => [s.uuid, s]));
}

// ---------- our catalogue ----------

let catalogueCache = null;

/**
 * { byCategory: key -> { codes:Set, active:[item] }, popularity: ItemCode -> customers who bought it in the
 * lookback } — kept 10 minutes. Active items of a category are sorted most bought first.
 */
async function catalogue() {
  if (catalogueCache && Date.now() - catalogueCache.at < TTL_MS) return catalogueCache.data;
  const since = monthsAgo(cfg.LOOKBACK_MONTHS);
  const [items, pop] = await Promise.all([
    Item.find({}).select("ItemCode ItemName ItemsGroupCode Valid Frozen").lean(),
    Invoice.aggregate([
      { $match: { DocDate: { $gte: since }, ...NOT_CANCELLED } },
      { $project: { CardCode: 1, "DocumentLines.ItemCode": 1 } },
      { $unwind: "$DocumentLines" },
      { $group: { _id: "$DocumentLines.ItemCode", customers: { $addToSet: "$CardCode" } } },
      { $project: { n: { $size: "$customers" } } },
    ]),
  ]);
  const popularity = new Map(pop.map((p) => [p._id, p.n]));
  const byCategory = new Map();
  CATEGORIES.forEach((cat) => {
    const all = items.filter((i) => itemIs(cat, i));
    const active = all
      .filter(isActive)
      .map((i) => ({ ItemCode: i.ItemCode, ItemName: i.ItemName, customers: popularity.get(i.ItemCode) || 0 }))
      .sort((a, b) => b.customers - a.customers || a.ItemName.localeCompare(b.ItemName));
    byCategory.set(cat.key, { codes: new Set(all.map((i) => i.ItemCode)), active, names: new Map(all.map((i) => [i.ItemCode, i.ItemName])) });
  });
  const data = { byCategory, popularity };
  catalogueCache = { at: Date.now(), data };
  return data;
}

// ---------- what a customer buys ----------

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

const NOT_CANCELLED = { Cancelled: { $nin: ["tYES", "Y"] } };
const NO_ACTIVITY = { invoices: 0, total: 0, lastInvoiceAt: null };

/** CardCode -> { invoices, total, lastInvoiceAt } over the last LOOKBACK_MONTHS (customers without any are left out). */
async function activity(codes) {
  if (!codes.length) return new Map();
  const rows = await Invoice.aggregate([
    { $match: { CardCode: { $in: codes }, DocDate: { $gte: monthsAgo(cfg.LOOKBACK_MONTHS) }, ...NOT_CANCELLED } },
    { $group: { _id: "$CardCode", invoices: { $sum: 1 }, total: { $sum: "$DocTotal" }, last: { $max: "$DocDate" } } },
  ]);
  return new Map(rows.map((t) => [t._id, { invoices: t.invoices, total: Math.round((t.total || 0) * 100) / 100, lastInvoiceAt: t.last }]));
}

/** CardCode -> (ItemCode -> last invoice date) over the last HISTORY_MONTHS. */
async function itemHistory(codes) {
  const out = new Map(codes.map((c) => [c, new Map()]));
  if (!codes.length) return out;
  const lines = await Invoice.aggregate([
    { $match: { CardCode: { $in: codes }, DocDate: { $gte: monthsAgo(cfg.HISTORY_MONTHS) }, ...NOT_CANCELLED } },
    { $project: { CardCode: 1, DocDate: 1, "DocumentLines.ItemCode": 1 } },
    { $unwind: "$DocumentLines" },
    { $group: { _id: { c: "$CardCode", i: "$DocumentLines.ItemCode" }, last: { $max: "$DocDate" } } },
  ]);
  lines.forEach((l) => out.get(l._id.c)?.set(l._id.i, l.last));
  return out;
}

// ---------- flags ----------

/** Menu evidence per category: key -> [{ item, store, section }] (distinct item titles). */
function menuEvidence(stores) {
  const out = new Map();
  stores.forEach((s) => {
    (s.menu || []).forEach((sec) => {
      const secText = norm(sec.title);
      const items = (sec.items || []).map((it) => ({ title: it.title, text: norm(it.title) }));
      CATEGORIES.forEach((cat) => {
        const found = items.filter((it) => menuHas(cat, it.text));
        // A section called "Wings" counts even when its items are "x6", "x12"…
        if (!found.length && items.length && menuHas(cat, secText)) found.push({ title: `${sec.title} (section)`, text: secText });
        if (!found.length) return;
        const list = out.get(cat.key) || [];
        found.forEach((it) => {
          if (!list.some((e) => e.text === it.text)) list.push({ item: it.title, store: s.title, section: sec.title || "", text: it.text });
        });
        out.set(cat.key, list);
      });
    });
  });
  return out;
}

/**
 * Flags of one customer. `bought` = ItemCode -> last invoice date (itemHistory()).
 * @returns {{ flags: Array, covered: Array }} covered = categories on the menu they do buy from us
 */
function flagsFor(stores, bought, catalog) {
  const evidence = menuEvidence(stores);
  const lookback = monthsAgo(cfg.LOOKBACK_MONTHS);
  const flags = [];
  const covered = [];
  CATEGORIES.forEach((cat) => {
    const ev = evidence.get(cat.key);
    if (!ev) return;
    const prod = catalog.byCategory.get(cat.key);
    // Last purchase of any item of the category (within HISTORY_MONTHS).
    let last = null;
    let lastCode = null;
    prod.codes.forEach((code) => {
      const at = bought.get(code);
      if (at && (!last || at > last)) {
        last = at;
        lastCode = code;
      }
    });
    const base = { key: cat.key, label: cat.label, kind: cat.kind, evidenceCount: ev.length, evidence: ev.slice(0, cfg.EVIDENCE_PER_FLAG).map(({ text, ...e }) => e) };
    if (last && last >= lookback) {
      covered.push({ key: cat.key, label: cat.label, kind: cat.kind, lastBoughtAt: last, lastBoughtItem: prod.names.get(lastCode) || lastCode });
      return;
    }
    // Nothing of ours to offer: not a flag.
    if (!prod.active.length) return;
    flags.push({
      ...base,
      lapsed: Boolean(last),
      lastBoughtAt: last,
      lastBoughtItem: last ? prod.names.get(lastCode) || lastCode : null,
      suggestions: prod.active.slice(0, cfg.SUGGESTIONS_PER_FLAG),
    });
  });
  const byKind = (a, b) => (KIND_ORDER.get(a.kind) ?? 99) - (KIND_ORDER.get(b.kind) ?? 99) || b.evidenceCount - a.evidenceCount;
  return { flags: flags.sort(byKind), covered: covered.sort(byKind) };
}

const storeInfo = (s, via) => ({
  uuid: s.uuid,
  title: s.title,
  url: s.url,
  via,
  menuItemCount: s.menuItemCount || 0,
  menuScrapedAt: s.detailsScrapedAt || null,
  lastSeenAt: s.lastSeenAt || null,
});

const settings = () => ({ lookbackMonths: cfg.LOOKBACK_MONTHS, historyMonths: cfg.HISTORY_MONTHS, kinds: cfg.KINDS });

/** Flags of one customer (computed now). */
async function customerFlags(cardCode) {
  const customer = await Customer.findOne({ CardCode: cardCode }).select("CardCode CardName assignedTo uberEatsUrl").lean();
  if (!customer) return null;
  const links = (await linkedStores(new Set([cardCode]))).get(cardCode) || [];
  const [storesByUuid, catalog, bought, act] = await Promise.all([loadStores(links.map((l) => l.uuid)), catalogue(), itemHistory([cardCode]), activity([cardCode])]);
  const stores = links.map((l) => storesByUuid.get(l.uuid)).filter(Boolean);
  const { flags, covered } = flagsFor(stores, bought.get(cardCode), catalog);
  return {
    cardCode: customer.CardCode,
    cardName: customer.CardName,
    stores: links.map((l) => storesByUuid.get(l.uuid) && storeInfo(storesByUuid.get(l.uuid), l.via)).filter(Boolean),
    purchases: act.get(cardCode) || NO_ACTIVITY,
    flags,
    covered,
    settings: settings(),
  };
}

// ---------- every linked customer (cached) ----------

let listCache = null;
let building = null;

/**
 * Upsell is for customers who buy from us now: the list keeps those with an invoice in the last
 * LOOKBACK_MONTHS (a customer who stopped buying altogether is a reactivation, not an upsell; their
 * flags are still on their own page).
 */
async function buildList() {
  const started = Date.now();
  const links = await linkedStores();
  const act = await activity([...links.keys()]);
  const codes = [...act.keys()];
  const [customers, storesByUuid, catalog, bought] = await Promise.all([
    Customer.find({ CardCode: { $in: codes } }).select("CardCode CardName assignedTo").lean(),
    loadStores([...new Set(codes.flatMap((code) => links.get(code).map((l) => l.uuid)))]),
    catalogue(),
    itemHistory(codes),
  ]);
  const names = await ownerNames(customers.map((c) => c.assignedTo && String(c.assignedTo)));
  const rows = [];
  customers.forEach((c) => {
    const ls = links.get(c.CardCode) || [];
    const stores = ls.map((l) => storesByUuid.get(l.uuid)).filter(Boolean);
    if (!stores.some((s) => (s.menu || []).length)) return; // no menu scraped yet
    const { flags, covered } = flagsFor(stores, bought.get(c.CardCode), catalog);
    const ownerId = c.assignedTo ? String(c.assignedTo) : null;
    rows.push({
      cardCode: c.CardCode,
      cardName: c.CardName,
      ownerId,
      ownerName: ownerId ? names.get(ownerId) || null : null,
      stores: ls.map((l) => storesByUuid.get(l.uuid) && storeInfo(storesByUuid.get(l.uuid), l.via)).filter(Boolean),
      purchases: act.get(c.CardCode),
      flagCount: flags.length,
      coveredCount: covered.length,
      flags,
    });
  });
  // Categories no SAP item answers to (the table needs a look).
  const withoutProducts = CATEGORIES.filter((cat) => !catalog.byCategory.get(cat.key).active.length).map((cat) => cat.key);
  return { at: new Date(), ms: Date.now() - started, linkedCustomers: links.size, buyingCustomers: codes.length, rows, withoutProducts };
}

/** Every buying customer linked to a store with a menu, with their flags. Kept 10 minutes; `fresh` rebuilds it. */
async function allFlags({ fresh = false } = {}) {
  if (!fresh && listCache && Date.now() - listCache.at.getTime() < TTL_MS) return listCache;
  if (!building) {
    building = buildList()
      .then((data) => {
        listCache = data;
        return data;
      })
      .finally(() => {
        building = null;
      });
  }
  return building;
}

module.exports = { customerFlags, allFlags, settings, norm, storeUuidFromUrl };

