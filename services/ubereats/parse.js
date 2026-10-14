// services/ubereats/parse.js
// Uber Eats getStoreV1 / feed card -> restaurant document fields.
// Ported from ubereats-scraper-2-hfs/src/scraper/parse.ts.

const BASE = "https://www.ubereats.com";

const hhmm = (minutes) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const text = (v) => (typeof v === "string" ? v : v?.text) || undefined;

const unique = (xs) => [...new Set(xs)];
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

/** French postal code as 5 digits ("75001.0", " 75001 " -> "75001"); undefined when there is none. */
function normalizePostalCode(v) {
  if (v == null) return undefined;
  return String(v).replace(/\s+/g, "").match(/\d{5}/)?.[0];
}

/** A usable coordinate pair (Uber Eats sometimes sends 0,0 for an unknown spot). */
const hasCoords = (lat, lng) =>
  typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);

/** Uber Eats store URLs use the store UUID as url-safe base64. */
function uuidToStoreId(uuid) {
  return Buffer.from(uuid.replace(/-/g, ""), "hex").toString("base64url");
}

/** Every field of a restaurant that comes from getStoreV1 (no bookkeeping fields). */
function parseStore(d) {
  const loc = d.location || {};
  const merchantType = d.storeMerchantTypeInfo?.uberMerchantType?.type;
  const { sections, partial } = parseMenu(d);

  return {
    uuid: d.uuid,
    slug: d.slug,
    title: String(d.title ?? "").trim(),
    url: `${BASE}/fr/store/${d.slug}/${uuidToStoreId(d.uuid)}`,
    imageUrls: (d.heroImageUrls || []).map((i) => i.url).filter(Boolean),
    categories: unique(d.cuisineList?.length ? d.cuisineList : (d.categories || []).filter((c) => !/^€+$/.test(c))),
    priceBucket: d.priceBucket || undefined,
    storeType: merchantType ?? loc.locationType,
    isRestaurant: merchantType ? merchantType === "MERCHANT_TYPE_RESTAURANT" : loc.locationType !== "GROCERY_STORE",
    location: {
      address: loc.address,
      streetAddress: loc.streetAddress,
      city: loc.city,
      postalCode: loc.postalCode,
      region: loc.region,
      country: loc.country,
      neighborhood: d.breadcrumbs?.value?.find((b) => b.href?.includes("/neighborhood/"))?.title,
      latitude: loc.latitude,
      longitude: loc.longitude,
      locationType: loc.locationType,
    },
    // Where the store is located (the Restaurants tab files it under this code).
    postalCode: normalizePostalCode(loc.postalCode),
    ...(hasCoords(loc.latitude, loc.longitude)
      ? { geo: { type: "Point", coordinates: [loc.longitude, loc.latitude] }, geoSource: "ubereats" }
      : {}),
    phoneNumber: d.phoneNumber || undefined,
    rating: d.rating ? { value: d.rating.ratingValue, count: d.rating.reviewCount } : undefined,
    hours: (d.hours || []).map((h) => ({
      dayRange: h.dayRange,
      sections: (h.sectionHours || []).map((s) => ({
        start: hhmm(s.startTime),
        end: hhmm(s.endTime),
        title: s.sectionTitle || undefined,
      })),
    })),
    chain: d.parentChain?.uuid ? { uuid: d.parentChain.uuid, name: d.parentChain.name } : undefined,
    tags: (d.tags || []).map((t) => text(t) ?? String(t)).filter(Boolean),
    supportedDiningModes: (d.supportedDiningModes || []).filter((m) => m.isAvailable).map((m) => m.mode),
    breadcrumbs: (d.breadcrumbs?.value || []).map((b) => ({ title: b.title, href: b.href })),
    menu: sections,
    menuItemCount: sections.reduce((n, s) => n + s.items.length, 0),
    menuPartial: partial || undefined,
    live: {
      isOpen: d.isOpen,
      isOrderable: d.isOrderable,
      etaText: text(d.etaRange),
      distanceText: text(d.distanceBadge),
      deliveryFeeText: text(d.fareBadge),
      promotion: text(d.promotion?.promotionText) ?? d.promotion?.title,
    },
  };
}

/**
 * catalogSectionsMap: { [menuUuid]: CatalogSection[] }; each section's items are in
 * payload.standardItemsPayload. Featured / carousel sections repeat items from the real menu, so
 * the real (vertical) sections are taken first and duplicates dropped.
 */
function parseMenu(d) {
  const menuTitles = new Map((d.sections || []).map((s) => [s.uuid, s.title]));
  const raw = [];
  for (const [menuUuid, secs] of Object.entries(d.catalogSectionsMap || {})) {
    for (const sec of secs || []) {
      if (!sec?.payload?.standardItemsPayload) continue;
      raw.push({ menuUuid, sec, primary: sec.type !== "HORIZONTAL_GRID" });
    }
  }
  raw.sort((a, b) => Number(b.primary) - Number(a.primary));

  const seen = new Set();
  const sections = [];
  for (const { menuUuid, sec } of raw) {
    const p = sec.payload.standardItemsPayload;
    const items = [];
    for (const it of p.catalogItems || []) {
      if (!it?.uuid || seen.has(it.uuid)) continue;
      seen.add(it.uuid);
      items.push({
        uuid: it.uuid,
        title: String(it.title ?? "").trim(),
        description: it.itemDescription || undefined,
        price: typeof it.price === "number" ? it.price : undefined,
        priceText: it.priceTagline?.text,
        imageUrl: it.imageUrl || undefined,
        isSoldOut: it.isSoldOut,
        isAvailable: it.isAvailable,
        hasCustomizations: it.hasCustomizations,
        tags: collectTagTexts(it.imageOverlayElements),
      });
    }
    if (!items.length) continue;
    sections.push({
      // sectionUUID is the parent menu for regular sections; catalogSectionUUID is the section itself.
      uuid: sec.catalogSectionUUID ?? p.sectionUUID,
      title: text(p.title) ?? "",
      menuUuid,
      menuTitle: menuTitles.get(menuUuid),
      items,
    });
  }
  // Grocery-style stores return only the first catalog page.
  const partial = d.catalogSectionPagingInfo?.offset != null;
  return { sections, partial };
}

function collectTagTexts(elements) {
  const out = [];
  for (const el of elements || []) for (const t of el?.element?.payload?.tagsPayload?.tags || []) if (t.text) out.push(t.text);
  return out.length ? out : undefined;
}

/** The few fields a feed card gives (used when details are skipped or fail). */
function parseFeedStore(s) {
  return {
    uuid: s.uuid,
    title: s.title,
    url: s.actionUrl ? `${BASE}/fr${s.actionUrl.split("?")[0]}` : `${BASE}/fr/store/-/${uuidToStoreId(s.uuid)}`,
    imageUrls: s.imageUrl ? [s.imageUrl] : [],
    rating: s.rating != null ? { value: round(s.rating, 2), count: s.ratingCount } : undefined,
    live: { etaText: s.etaText, isOrderable: s.isOrderable },
  };
}

module.exports = { parseStore, parseFeedStore, normalizePostalCode, hasCoords, uuidToStoreId };
