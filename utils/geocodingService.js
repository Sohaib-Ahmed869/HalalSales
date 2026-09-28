// utils/geocodingService.js
//
// Turns a Customer's address into lat/lng for the Sales Map Report / Truck
// Schedules routing feature.
//
// Provider: Photon (https://photon.komoot.io), free, no API key, no billing
// — the same service that already populated customer.coordinates for 7,289
// existing customers (see models/Customer.js comments on that field), so
// this keeps using the provider actually proven to work in this codebase.
// GOOGLE_MAPS_API_KEY exists in .env but that Google Cloud project has
// billing disabled (every request returns REQUEST_DENIED, confirmed
// directly against the live API — not assumed); Google is kept as an
// optional second attempt only, in case billing gets enabled later, and is
// silently skipped if the key is missing or requests keep failing.
//
// Never throws in a way that breaks the caller's request/response flow —
// callers invoke this fire-and-forget (see customer.controller.js) so a bad
// address or an unreachable API never blocks customer create/update.

const axios = require("axios");

const PHOTON_URL = "https://photon.komoot.io/api/";
const GOOGLE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

function buildAddressString(address) {
  if (!address) return null;
  const parts = [address.street, address.zipCode, address.city, address.country].filter(
    (part) => part && String(part).trim().length > 0
  );
  if (parts.length === 0) return null;
  return parts.join(", ");
}

async function geocodeWithPhoton(addressString) {
  const response = await axios.get(PHOTON_URL, {
    params: { q: addressString, limit: 1, lang: "en" },
    timeout: 8000,
  });
  const feature = response.data?.features?.[0];
  if (!feature) return null;
  const [lng, lat] = feature.geometry.coordinates;
  return { lat, lng };
}

async function geocodeWithGoogle(addressString) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return null;
  const response = await axios.get(GOOGLE_URL, {
    params: { address: addressString, key: apiKey },
    timeout: 8000,
  });
  if (response.data?.status !== "OK") return null;
  const result = response.data?.results?.[0];
  if (!result) return null;
  return { lat: result.geometry.location.lat, lng: result.geometry.location.lng };
}

// Geocodes a single Customer document in place and saves it. Sets
// geo.geocodeStatus to "ok" or "failed" (never leaves it stuck on "pending"
// after a real attempt, so the "needs geocoding" admin queue reflects reality).
async function geocodeCustomer(customer) {
  const addressString = buildAddressString(customer.address);

  if (!addressString) {
    customer.geo = { geocodeStatus: "failed" };
    await customer.save();
    return customer;
  }

  let coords = null;
  try {
    coords = await geocodeWithPhoton(addressString);
  } catch (error) {
    console.error(`Photon geocoding failed for ${customer.CardCode}:`, error.message);
  }

  if (!coords) {
    try {
      coords = await geocodeWithGoogle(addressString);
    } catch (error) {
      console.error(`Google geocoding failed for ${customer.CardCode}:`, error.message);
    }
  }

  if (!coords) {
    customer.geo = { geocodedAt: new Date(), geocodeStatus: "failed" };
    await customer.save();
    return customer;
  }

  customer.geo = {
    lat: coords.lat,
    lng: coords.lng,
    geocodedAt: new Date(),
    geocodeStatus: "ok",
  };
  await customer.save();
  return customer;
}

module.exports = { geocodeCustomer, buildAddressString };
