// utils/geocodingService.js
// Wraps the Google Geocoding API (key already present in .env as GOOGLE_MAPS_API_KEY,
// previously unused anywhere in this codebase) to turn a Customer's address into
// lat/lng for the Sales Map Report / Truck Schedules routing feature.
//
// Never throws in a way that breaks the caller's request/response flow — callers
// invoke this fire-and-forget (see customer.controller.js) so a bad address or an
// unreachable API never blocks customer create/update.

const axios = require("axios");

const GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json";

function buildAddressString(address) {
  if (!address) return null;
  const parts = [address.street, address.zipCode, address.city, address.country].filter(
    (part) => part && String(part).trim().length > 0
  );
  if (parts.length === 0) return null;
  return parts.join(", ");
}

// Geocodes a single Customer document in place and saves it.
// Sets geo.geocodeStatus to "ok" or "failed" (never leaves it stuck on "pending"
// after a real attempt, so the "needs geocoding" admin queue reflects reality).
async function geocodeCustomer(customer) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  const addressString = buildAddressString(customer.address);

  if (!addressString) {
    customer.geo = {
      ...(customer.geo ? customer.geo.toObject?.() ?? customer.geo : {}),
      geocodeStatus: "failed",
    };
    await customer.save();
    return customer;
  }

  if (!apiKey) {
    console.warn(
      "GOOGLE_MAPS_API_KEY is not set — cannot geocode customer",
      customer.CardCode
    );
    customer.geo = {
      ...(customer.geo ? customer.geo.toObject?.() ?? customer.geo : {}),
      geocodeStatus: "failed",
    };
    await customer.save();
    return customer;
  }

  try {
    const response = await axios.get(GEOCODE_URL, {
      params: { address: addressString, key: apiKey },
      timeout: 8000,
    });

    const result = response.data?.results?.[0];
    if (response.data?.status !== "OK" || !result) {
      customer.geo = {
        lat: undefined,
        lng: undefined,
        geocodedAt: new Date(),
        geocodeStatus: "failed",
      };
      await customer.save();
      return customer;
    }

    customer.geo = {
      lat: result.geometry.location.lat,
      lng: result.geometry.location.lng,
      geocodedAt: new Date(),
      geocodeStatus: "ok",
    };
    await customer.save();
    return customer;
  } catch (error) {
    console.error(`Geocoding request failed for ${customer.CardCode}:`, error.message);
    customer.geo = {
      ...(customer.geo ? customer.geo.toObject?.() ?? customer.geo : {}),
      geocodeStatus: "failed",
    };
    await customer.save();
    return customer;
  }
}

module.exports = { geocodeCustomer, buildAddressString };
