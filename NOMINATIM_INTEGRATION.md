# Nominatim Geocoding Integration

This document describes the Nominatim geocoding integration for dynamic region lookup across European countries.

## Overview

The truck routing system now uses **OpenStreetMap's Nominatim API** for dynamic region/state lookup from postal codes. This replaces the hardcoded FRENCH_DEPARTMENTS mapping and supports all European countries.

## Features

✅ **Zero-cost**: Nominatim is completely free with no API key required
✅ **Europe-wide**: Works for all European countries and beyond
✅ **Cached**: In-memory caching prevents repeated API calls for the same postal code
✅ **Automatic**: Region names are automatically extracted from postal code locations
✅ **Async**: Non-blocking API calls with 8-second timeout

## Usage

### Basic Usage

```javascript
const { getRegionFromPostalCode } = require('./utils/nominatimGeocoding');

// Get region for a postal code
const region = await getRegionFromPostalCode('75001', 'FR');
console.log(region); // Output: "Île-de-France"

// Works with other countries too
const regionDE = await getRegionFromPostalCode('10115', 'DE');
console.log(regionDE); // Output: "Berlin"
```

### Controller Integration

In `controllers/truckRoute.controller.js`, the region filtering now works dynamically:

```javascript
// In generateTruckRoute function
const orderRegion = await getRegionFromPostalCode(postalCode, countryCode);
if (orderRegion && orderRegion === route.region) {
    regionFilteredOrders.push(order);
}

// In getAvailableOrdersByTruckRegion function
const orderRegion = await getRegionFromPostalCode(address.zipCode.toString(), countryCode);
if (orderRegion === truckRegion) {
    filteredOrders.push(enrichedOrder);
}
```

## API Specification

### `getRegionFromPostalCode(postalCode, countryCode = "FR")`

**Parameters:**
- `postalCode` (string): The postal/zip code to lookup
- `countryCode` (string, optional): ISO 2-letter country code (default: "FR")

**Returns:**
- Promise<string | null>: Region name or null if lookup fails

**Example:**
```javascript
// France
await getRegionFromPostalCode('75001', 'FR')   // "Île-de-France"
await getRegionFromPostalCode('13000', 'FR')   // "Provence-Alpes-Côte d'Azur"
await getRegionFromPostalCode('69000', 'FR')   // "Auvergne-Rhône-Alpes"

// Germany
await getRegionFromPostalCode('10115', 'DE')   // "Berlin"
await getRegionFromPostalCode('80339', 'DE')   // "Bavaria"

// Spain
await getRegionFromPostalCode('28001', 'ES')   // "Community of Madrid"

// Italy
await getRegionFromPostalCode('20100', 'IT')   // "Lombardy"

// UK
await getRegionFromPostalCode('SW1A1AA', 'GB') // "London"
```

### `getRegionsForPostalCodes(postalCodes)`

**Parameters:**
- `postalCodes` (Array): Array of {postalCode, countryCode} objects

**Returns:**
- Promise<Map>: Map of postal code to region

**Example:**
```javascript
const results = await getRegionsForPostalCodes([
    { postalCode: '75001', countryCode: 'FR' },
    { postalCode: '10115', countryCode: 'DE' },
    { postalCode: '28001', countryCode: 'ES' }
]);

for (const [postalCode, region] of results) {
    console.log(`${postalCode}: ${region}`);
}
```

### `clearCache()`

Clear the in-memory cache. Useful for testing.

```javascript
const { clearCache } = require('./utils/nominatimGeocoding');
clearCache();
```

### `getCacheStats()`

Get information about cached entries.

```javascript
const { getCacheStats } = require('./utils/nominatimGeocoding');
const stats = getCacheStats();
console.log(`Cached entries: ${stats.cachedEntries}`);
```

## How It Works

1. **Request**: User provides a postal code and country code
2. **Cache Check**: System checks if region is cached, returns immediately if found
3. **API Query**: If not cached, Nominatim API is queried: `https://nominatim.openstreetmap.org/search?postalcode={code}&country={countryCode}&format=json`
4. **Parsing**: Response display_name is parsed to extract region name
5. **Caching**: Result is cached in memory for future requests
6. **Response**: Region name is returned or null if not found

### Response Parsing Example

For postal code 75001 in France, Nominatim returns:
```
display_name: "75001, Paris, Île-de-France, France métropolitaine, France"
```

The utility extracts "Île-de-France" by filtering out:
- Country names ("France", "France métropolitaine")
- Short codes (ISO country codes like "FR")
- Country divisions containing keywords like "métropolitaine"

## Performance Characteristics

| Metric | Value |
|--------|-------|
| API Timeout | 8 seconds |
| Cache Type | In-memory Map |
| Cache Invalidation | On server restart |
| Rate Limit | 1 request/second (OSM policy) |

## Error Handling

All errors are gracefully handled:

```javascript
try {
    const region = await getRegionFromPostalCode('INVALID', 'FR');
    if (!region) {
        console.log('Region not found');
    }
} catch (error) {
    console.error('API error:', error.message);
}
```

## Nominatim Usage Policy

As per OSM's Nominatim Usage Policy:
- ✅ Identify your application in the User-Agent header (we use "HalalSales-TruckRouting/1.0")
- ✅ Cache results to minimize API calls
- ✅ No more than 1 request/second
- ✅ Non-commercial and commercial use allowed
- ✅ No API key required

## Supported Countries

The system works for all countries supported by Nominatim, including:

**Western Europe:**
- France (FR)
- Germany (DE)
- Spain (ES)
- Italy (IT)
- Netherlands (NL)
- Belgium (BE)
- Switzerland (CH)
- Austria (AT)
- Portugal (PT)

**Central/Eastern Europe:**
- Poland (PL)
- Czech Republic (CZ)
- Slovakia (SK)
- Hungary (HU)
- Romania (RO)
- Bulgaria (BG)

**Nordic Countries:**
- Sweden (SE)
- Denmark (DK)
- Norway (NO)
- Finland (FI)

**And many more...**

## Migration from Hardcoded Mapping

### Before (Hardcoded)
```javascript
const FRENCH_DEPARTMENTS = {
    "75": { region: "Île-de-France" },
    "77": { region: "Île-de-France" },
    // ... 90+ more mappings
};

const deptCode = zipCode.substring(0, 2);
const dept = FRENCH_DEPARTMENTS[deptCode];
```

### After (Dynamic)
```javascript
const region = await getRegionFromPostalCode(zipCode, countryCode);
```

## Future Enhancements

- [ ] Persistent cache (Redis/MongoDB)
- [ ] Batch geocoding API endpoint
- [ ] Reverse geocoding (coordinates → region)
- [ ] Fallback to alternative geocoding service
- [ ] Caching statistics monitoring
- [ ] Region name normalization (e.g., accent removal)

## Testing

Run the test file to verify the integration:

```bash
node test-nominatim-integration.js
```

Expected output:
```
Testing Nominatim Integration:
FR-75013: Île-de-France ✓
FR-75005: Île-de-France ✓
FR-78300: Île-de-France ✓
FR-13000: Provence-Alpes-Côte d'Azur ✓
DE-10115: Berlin ✓
```

## Troubleshooting

### Region returns null

- Check postal code format is valid
- Verify country code is correct ISO 2-letter code
- Check network connection to nominatim.openstreetmap.org
- Try clearing cache with `clearCache()`

### API timeout (8 seconds)

- Network latency to Nominatim might be slow
- Try again (may be temporary)
- Check internet connection

### Incorrect region returned

- Some postal codes might span multiple regions
- Nominatim might return a different level of region
- Try looking up coordinates instead if precision needed

## References

- **Nominatim Documentation**: https://nominatim.org/
- **OSM Usage Policy**: https://www.openstreetmap.org/copyright
- **Country Codes**: https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2
