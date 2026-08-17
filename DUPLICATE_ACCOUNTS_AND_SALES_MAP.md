# Duplicate Accounts & Sales Map — implementation notes

Work done 16 Aug 2026. Two related pieces:

1. **Same-shop / duplicate account detection** — identify accounts sharing a
   delivery address or phone, including shops re-registered under a new name.
2. **Sales map fixes** — the map was going blank and taking ~28s to load.

Backend: `D:\Calcite Codes\HalalSales`
Frontend: `D:\Calcite Codes\SalesFrontend`

---

## 1. Why the sales map went blank

Three independent causes. All fixed.

### 1a. A crash, not a slow load (the actual "goes blank")

`FitBounds` is declared at **module scope** in `MapPage.jsx` but was reading
`FRENCH_CITIES` / `FRENCH_DEPARTMENTS` / `FRENCH_REGIONS`, which are only defined
**inside** the `MapPage` component (they come from `getRegionConfig()`).

Selecting any Region, Department or City therefore threw
`ReferenceError: FRENCH_CITIES is not defined` inside a `useEffect`, React
unmounted the tree, and the page went white. An empty selection short-circuits on
`selectedCity && ...`, which is why the map worked until someone touched an area
filter.

**Fix:** the three tables are passed into `FitBounds` as props
(`regions` / `departments` / `cities`).

This was pre-existing and unrelated to the performance work — it was found by
`npx eslint`, which reports it as a `no-undef` error. `MSFMapPage.jsx` was checked
and does **not** have the same defect.

### 1b. 9,464 React markers

Every invoice/order/quotation was its own pin, each with an eagerly-mounted
`<Popup>` subtree, all inside `MarkerClusterGroup`. For a one-month range that is
~9,500 markers plus ~100k popup elements — enough to hang the tab.

**Fix:** the API now returns **one entry per physical location**
(`aggregate=true`), and markers render with **no `<Popup>` child at all**.
Clicking a pin opens a single detail card rendered once, in the top-left of the
map.

### 1c. N+1 query and no compression

`getDocumentsByDateRange` ran a separate `Invoice.find({ CardCode })` — fetching
*all* invoices ever — once per customer (533 queries for a one-month range). That
was the bulk of the 28 seconds. Replaced with a single `$group` aggregation
(`getCustomerSalesTotals`).

There was also **no gzip anywhere on the API**. `compression` middleware added in
`server.js`.

Also removed: on-request geocoding inside the invoice loop. It called Photon with
a 15s timeout per customer, and was dead code anyway — `customerMap` only ever
contains customers that already have coordinates.

### Measured result (same query, through the real HTTP stack)

| | before | after |
|---|---|---|
| response time | 28.3 s | 3.9 s |
| bytes on the wire | 3.5 MB | 491 KB |
| markers mounted | 9,464 (each w/ popup) | 5,568 pins, no popups |

---

## 2. Duplicate / same-shop detection

### Matching

`utils/addressNormalization.js` is the core. It:

- strips accents (`Jaurès` → `Jaures`)
- canonicalises French street types (`av`/`ave`/`avenue` → `av`, `r`/`rue` → `rue`,
  `bd`/`blvd`/`boulevard` → `bd`, …)
- drops articles (`rue de la gare` ≡ `rue gare`)
- keeps house-number suffixes attached (`225` ≠ `225 ter`, but
  `225ter` ≡ `225 ter`)
- requires a house number **and** a valid 5-digit postcode, else no key
- normalises phones to 9 national digits, rejecting placeholders

Address key format: `"<normalised street>|<zip>"`, namespaced as
`address:<key>` / `phone:<key>` when used as a match key.

### Real groups this finds in the live data

- **DAMEYO** — 4 accounts at 34 Bd de Nesles 77420, €247k of sales split across them
- **`LE CROUSTY` → `O' CROUSTY` → `Crousty Two`** at 75 Av Michelet 93400 — the rename case
- **ZAHRA ×3**, **JK DISTRIBUTION ×3**, **URBAN FOODS ×4**, **RESTO MARKET ×4**
- `DELICE CHICKEN / DELICE BLANKOK / BLANKOK BURGER / BK BURGER / BK FAMILY`
  at 177 rue Maxime Gorki 93150

Scale: **804** address groups at "likely or above"; **2,244** total groups across
both signals covering **5,126** accounts (of 9,101 non-prospect records scanned).

### Hub exclusion — important

Without this the list is unusable:

- **32 rue Raspail 93120 has 73 accounts** — that is our own depot (walk-in / cash
  & carry customers all booked to the depot address).
- Phone `0611223344` has **53** accounts — a placeholder.

Any address with **>8** accounts, or phone with **>5**, is classed as a *hub*
(shared location: depot, shopping centre, business park, accountant) and reported
separately, never as a duplicate. Can also be marked permanently via
`POST /api/duplicates/hub`.

### Coordinates are NOT trustworthy for this

Geocoding falls back to street and town centroids, so unrelated shops land on one
point — e.g. `LA ROSE DE TOULOUSE` and `LA ROSE DE LYON` both sit on a 93300
coordinate. The map groups **pins** by rounded coordinate (a rendering concern)
but computes the duplicate flag from the **normalised address key**. That cut
false-positive "multi-account locations" from 1,059 to 643.

### Decisions persist

This is what fixes "we have no way of identifying them".

`models/CustomerGroup.js`, one collection, `kind` field:

| kind | meaning |
|---|---|
| `shop` | confirmed: these accounts are one physical shop |
| `ignored` | reviewed and rejected — different businesses at one address |
| `hub` | the match key is a shared location; never suggest |

Confirming also stamps `shopGroup` on each `Customer`, so the customers list and
map can show the link without a lookup per row.

An `ignored` group is suppressed **only while unchanged**. If a new account later
appears at the same address the group resurfaces, badged
"New account since last review".

Linking is idempotent and absorbing: linking A+B then B+C yields **one** group of
three, not two overlapping ones (verified).

---

## Files changed

### Backend (new)
- `utils/addressNormalization.js` — normalisation + name similarity
- `models/CustomerGroup.js` — persisted shop / ignored / hub decisions
- `services/duplicateDetection.service.js` — detection, scoring, 5-min cache
- `controllers/duplicates.controller.js`
- `routes/duplicates.routes.js`

### Backend (modified)
- `server.js` — mount `/api/duplicates`; add `compression()` middleware
- `models/Customer.js` — add `shopGroup` ref (indexed, sparse)
- `controllers/map.controller.js` — aggregated `locations` path, N+1 fix,
  dead geocoding removed
- `controllers/customer.controller.js` — `getCustomers` returns `shopGroup`
  with member count
- `package.json` — **added `compression` dependency (needs `npm install` on deploy)**

### Frontend (new)
- `src/services/duplicateService.js`
- `src/pages/Dashboard/SalesManager/DuplicateAccounts.jsx`

### Frontend (modified)
- `src/pages/Dashboard/MapPage.jsx` — FitBounds fix, location markers, detail
  card, "Same address only" toggle, unmapped-invoice badge
- `src/services/mapService.js` — `aggregate=true` by default
- `src/pages/Dashboard/SalesManager/Customers.jsx` — "Same shop" badge + banner
- `src/App.jsx` — `/duplicate-accounts` route
- `src/components/common/sidebar.jsx` — nav entry (admin + sales_manager)

---

## API

All under `/api/duplicates`. View = any signed-in user; write = admin /
sales_manager.

| method | path | purpose |
|---|---|---|
| GET | `/` | review queue (filter, search, page) |
| GET | `/export` | CSV of the queue |
| GET | `/hubs` | shared locations |
| GET | `/groups` | confirmed links |
| GET | `/for-customer/:id` | siblings of one account (confirmed, else live suggestions) |
| POST | `/link` | confirm as one shop |
| POST | `/ignore` | mark not the same |
| POST | `/hub` | mark match key as a shared location |
| PUT | `/groups/:id` | rename / re-point primary / add / remove members |
| DELETE | `/groups/:id` | undo a decision |

Map: `GET /api/map/documents?...&aggregate=true` returns `data.locations`.
Without `aggregate` the **old per-document response shape is unchanged**, because
the MS Foods frontend (`msfbackend.foodservices.live`) hits the same endpoint.

### Confidence scoring

Address match starts at 0.55, phone at 0.45. Adjusted by: identical names +0.30,
similar names +0.22/+0.10, corroborating phone +0.20, pair +0.08, group of 4 −0.05,
5+ −0.15. UI buckets: ≥0.85 "Very likely", ≥0.65 "Likely", else "Possible".
Screen defaults to ≥0.6.

---

## Open items / things to decide

1. **`compression` must be installed on deploy** — `npm install` on the server.

2. **Scraped prospects excluded by default.** 17,643 of 27,095 customer records
   are `non-sap/prospect` lead-gen rows and swamp the queue. Pass
   `includeProspects=true` to include them. Decide whether they should ever be
   in scope.

3. **250 customers store a street only in the SAP `addresses[]` array**, with
   nothing in `address` / `deliveryAddress`. The review screen covers them.
   The **map's** duplicate flag skips them, to avoid pulling that array for all
   7,289 geocoded customers on every map load. Extend if wanted.

4. **Geocoding coverage is the biggest remaining data gap.** Only **7,289 of
   27,095** customers are geocoded, so **1,909 invoices per month never reach the
   map** (1,398 of those are `C9999`, the generic walk-in code — probably fine to
   ignore; the other ~511 across 214 customers are real). The map now shows this
   as an amber "N invoices not mapped" badge. Use the existing batch geocode
   button to close the gap.

5. **Merging is NOT implemented.** Groups are *linked*, not merged — no invoices,
   orders or notes move between accounts, and no CardCode is deactivated. That
   was deliberately scoped out because it touches SAP-synced records. If wanted,
   scope it separately.

6. **Detection cache is in-process, 5 minutes.** Fine for one instance; if the
   backend is ever run multi-instance, moving this to Redis would keep the
   "Rescan" button honest across nodes. Writes invalidate the local cache only.

7. **Uncached scan is ~5-7s** (loading ~9k customers from Atlas dominates). If
   that becomes annoying, persist `addressKey` / `phoneKey` on `Customer` and
   index them — note the SAP sync writes via `updateOne`/`bulkWrite`, which
   bypasses mongoose hooks, so it would need a backfill job rather than a
   pre-save hook.

---

## Testing notes

`node server.js` takes ~2 minutes to reach `listen` (parses .docx manuals,
verifies SMTP, starts cron). To test a route quickly, drop a temp file in the
**repo root** (module resolution is relative to the script, so a file elsewhere
cannot `require("dotenv")`) mounting just that router — ready in ~12s. Mint a JWT
with `jwt.sign({ userId }, process.env.JWT_SECRET)` for `auth`-protected routes.

`MONGO_URI` has no database in the path, so it resolves to the **`test`** database.

The duplicate flow was exercised end-to-end against live data (detect → link →
verify suppression → siblings → idempotent re-link → ignore → CSV) and every
record created was removed afterwards; `customergroups` count and customers with
`shopGroup` were both verified back at 0.
