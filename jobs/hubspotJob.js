const cron = require("node-cron");
const axios = require("axios");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const Deal = require("../models/Deal"); // Using your existing Deal model

// Load environment variables
dotenv.config();

// HubSpot API configuration
const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;
const HUBSPOT_API_URL = "https://api.hubapi.com/crm/v3/objects/deals";

// Connect to MongoDB (if not already connected in your main app)
if (!mongoose.connection.readyState) {
  mongoose
    .connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    })
    .then(() => console.log("MongoDB connected for HubSpot"))
    .catch((err) => console.error("MongoDB connection error:", err));
}

/**
 * Formats date to ISO string for HubSpot API
 * @param {Date} date - Date to format
 * @returns {string} Formatted date string in ISO format
 */
function formatDateForHubSpot(date) {
  return date.toISOString();
}

/**
 * Extracts address information from HubSpot properties
 * @param {Object} properties - HubSpot deal properties
 * @param {String} prefix - Property prefix (e.g., 'billing', 'shipping')
 * @returns {Object} Address object matching the AddressSchema
 */
function extractAddressFromProperties(properties, prefix) {
  return {
    line1: properties[`${prefix}_address_line1`] || "",
    line2: properties[`${prefix}_address_line2`] || "",
    city: properties[`${prefix}_city`] || "",
    state: properties[`${prefix}_state`] || "",
    postalCode:
      properties[`${prefix}_postal_code`] || properties[`${prefix}_zip`] || "",
    country: properties[`${prefix}_country`] || "",
    phone: properties[`${prefix}_phone`] || "",
    mobilePhone: properties[`${prefix}_mobile_phone`] || "",
  };
}

/**
 * Maps HubSpot API response to your existing Deal model format
 * @param {Object} hubspotDeal - Deal data from HubSpot API
 * @returns {Object} Formatted deal data for MongoDB using your schema
 */
function mapHubSpotDealToModel(hubspotDeal) {
  // Extract all properties
  const properties = hubspotDeal.properties || {};

  // Check deal stage to determine if it's closed (won or lost)
  const dealStage = properties.dealstage || "";
  const isClosed =
    dealStage.includes("closed") ||
    dealStage.includes("won") ||
    dealStage.includes("lost");
  const isClosedWon = dealStage.includes("won");
  const isClosedLost = dealStage.includes("lost");

  // Extract contact information
  const contactInfo = {
    phone: properties.phone || "",
    mobilePhone: properties.mobilephone || "",
    email: properties.email || "",
  };

  // Map products if available (this would need enhancing based on HubSpot's product association structure)
  const products = [];
  // This is a placeholder - you might need to fetch product associations separately
  // or parse them from a custom HubSpot property

  // Map HubSpot deal to your model
  return {
    recordId: hubspotDeal.id,
    abandonedCartUrl: properties.abandoned_cart_url || "",
    billingAddress: extractAddressFromProperties(properties, "billing"),
    shippingAddress: extractAddressFromProperties(properties, "shipping"),
    amount: parseFloat(properties.amount) || 0,
    amountInCompanyCurrency:
      parseFloat(properties.amount_in_company_currency) || 0,
    currency: properties.currency || "EUR",
    createDate: properties.createdate
      ? new Date(parseInt(properties.createdate))
      : null,
    closeDate: properties.closedate
      ? new Date(parseInt(properties.closedate))
      : null,
    dealName: properties.dealname || "",
    dealOwner: properties.hubspot_owner_name || "",
    dealProbability: parseFloat(properties.hs_probability) || 0,
    dealStage: dealStage,
    dealType: properties.dealtype || "",
    orderNumber: properties.order_number || "",
    products: products,
    isPaid: properties.is_paid === "true" || false,
    isClosedWon: isClosedWon,
    isClosedLost: isClosedLost,
    isClosed: isClosed,
    pipeline: properties.pipeline || "Ecommerce Pipeline",
    totalProductsWithTaxes:
      parseFloat(properties.total_products_with_taxes) || 0,
    totalExcludingTaxes: parseFloat(properties.total_excluding_taxes) || 0,
    totalIncludingTaxes: parseFloat(properties.total_including_taxes) || 0,
    taxPrice: parseFloat(properties.tax_price) || 0,
    paymentMethod: properties.payment_method || "",
    customerName: properties.customer_name || "",
    customerEmail: properties.customer_email || "",
    lastModifiedDate: properties.hs_lastmodifieddate
      ? new Date(parseInt(properties.hs_lastmodifieddate))
      : null,
    contactInfo: contactInfo,
    source: properties.source || "",
    sourceDetail: properties.source_detail || "",
  };
}

/**
 * Fetches deal data from HubSpot API for a specific date range
 * @param {Date} startDate - Start date for fetching deals
 * @param {Date} endDate - End date for fetching deals
 * @returns {Promise<Array>} - Array of deal data
 */
async function fetchHubSpotDeals(startDate, endDate) {
  const formattedStartDate = formatDateForHubSpot(startDate);
  const formattedEndDate = formatDateForHubSpot(endDate);

  console.log(
    `Fetching HubSpot deals from ${formattedStartDate} to ${formattedEndDate}`
  );

  let allDeals = [];
  let hasMore = true;
  let after = undefined;
  const limit = 100; // Maximum allowed by API

  // Filter deals that were updated in the given date range
  const filterGroups = [
    {
      filters: [
        {
          propertyName: "hs_lastmodifieddate",
          operator: "GTE",
          value: new Date(startDate).getTime().toString(),
        },
        {
          propertyName: "hs_lastmodifieddate",
          operator: "LTE",
          value: new Date(endDate).getTime().toString(),
        },
      ],
    },
  ];

  // Paginate through all results
  while (hasMore) {
    try {
      const response = await axios({
        method: "POST",
        url: `${HUBSPOT_API_URL}/search`,
        headers: {
          Authorization: `Bearer ${HUBSPOT_API_KEY}`,
          "Content-Type": "application/json",
        },
        data: {
          filterGroups: filterGroups,
          sorts: [
            {
              propertyName: "hs_lastmodifieddate",
              direction: "DESCENDING",
            },
          ],
          properties: [
            // Deal basic information
            "dealname",
            "amount",
            "closedate",
            "createdate",
            "hs_lastmodifieddate",
            "pipeline",
            "dealstage",
            "hs_probability",
            "dealtype",
            "hubspot_owner_id",
            "hubspot_owner_name",

            // Currency and pricing fields
            "currency",
            "amount_in_company_currency",
            "total_products_with_taxes",
            "total_excluding_taxes",
            "total_including_taxes",
            "tax_price",

            // E-commerce specific fields
            "order_number",
            "abandoned_cart_url",
            "is_paid",
            "payment_method",

            // Customer information
            "customer_name",
            "customer_email",

            // Billing address fields
            "billing_address_line1",
            "billing_address_line2",
            "billing_city",
            "billing_state",
            "billing_postal_code",
            "billing_country",
            "billing_phone",

            // Shipping address fields
            "shipping_address_line1",
            "shipping_address_line2",
            "shipping_city",
            "shipping_state",
            "shipping_postal_code",
            "shipping_country",
            "shipping_phone",

            // Source information
            "source",
            "source_detail",

            // Contact info
            "phone",
            "mobilephone",
            "email",
          ],
          limit: limit,
          after: after,
        },
      });

      const deals = response.data?.results || [];
      allDeals = [...allDeals, ...deals];

      // Check if we have more results
      after = response.data?.paging?.next?.after;
      hasMore = !!after;

      console.log(
        `Retrieved ${deals.length} deals in this batch, total: ${allDeals.length}`
      );

      // Add a small delay to avoid rate limiting
      if (hasMore) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error(
        "Error fetching HubSpot deals:",
        error.response?.data || error.message
      );
      hasMore = false;
    }
  }

  return allDeals;
}

/**
 * Fetches and processes product associations for deals if needed
 * Note: This is a placeholder function that should be implemented based on
 * your specific HubSpot setup for deal products
 * @param {String} dealId - HubSpot deal ID
 * @returns {Promise<Array>} - Array of product data
 */
async function fetchDealProducts(dealId) {
  try {
    // This is where you would implement the API call to get product line items
    // for a specific deal from HubSpot

    const response = await axios({
      method: "GET",
      url: `https://api.hubapi.com/crm/v3/objects/deals/${dealId}/associations/line_items`,
      headers: {
        Authorization: `Bearer ${HUBSPOT_API_KEY}`,
        "Content-Type": "application/json",
      },
    });

    // Process the line item associations and fetch product details
    // This will depend on your specific HubSpot setup

    return []; // Return processed products
  } catch (error) {
    console.error(`Error fetching products for deal ${dealId}:`, error.message);
    return [];
  }
}

/**
 * Main function to fetch yesterday's deals and save to MongoDB
 */
async function fetchAndSaveYesterdayDeals() {
  try {
    // Calculate yesterday's date range (full 24 hours)
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const endOfYesterday = new Date(yesterday);
    endOfYesterday.setHours(23, 59, 59, 999);

    // Fetch deals from HubSpot API
    const deals = await fetchHubSpotDeals(yesterday, endOfYesterday);
    console.log(`Retrieved ${deals.length} deals from HubSpot API`);

    // Map and save each deal to MongoDB
    let savedCount = 0;
    let errorCount = 0;

    for (const hubspotDeal of deals) {
      try {
        const dealData = mapHubSpotDealToModel(hubspotDeal);

        // Use findOneAndUpdate with upsert to avoid duplicates
        await Deal.findOneAndUpdate({ recordId: dealData.recordId }, dealData, {
          upsert: true,
          new: true,
        });

        savedCount++;
      } catch (error) {
        console.error(`Error saving deal ${hubspotDeal.id}:`, error.message);
        errorCount++;
      }
    }

    console.log(
      `HubSpot data sync completed. Saved: ${savedCount}, Errors: ${errorCount}`
    );

    return { savedCount, errorCount, totalDeals: deals.length };
  } catch (error) {
    console.error("Error in fetchAndSaveYesterdayDeals:", error);
    throw error;
  }
}

/**
 * Function to sync data for a specific date range
 * @param {Date} startDate - Start date for the range
 * @param {Date} endDate - End date for the range (defaults to current date)
 * @returns {Promise<Object>} - Results of the operation
 */
async function syncDateRange(startDate, endDate = new Date()) {
  console.log(
    `Running HubSpot sync for date range: ${
      startDate.toISOString().split("T")[0]
    } to ${endDate.toISOString().split("T")[0]}`
  );

  try {
    // Fetch deals from HubSpot API for the date range
    const deals = await fetchHubSpotDeals(startDate, endDate);
    console.log(
      `Retrieved ${deals.length} deals from HubSpot API for the date range`
    );

    // Map and save each deal to MongoDB
    let savedCount = 0;
    let errorCount = 0;

    for (const hubspotDeal of deals) {
      try {
        const dealData = mapHubSpotDealToModel(hubspotDeal);

        // Use findOneAndUpdate with upsert to avoid duplicates
        await Deal.findOneAndUpdate({ recordId: dealData.recordId }, dealData, {
          upsert: true,
          new: true,
        });

        savedCount++;
      } catch (error) {
        console.error(`Error saving deal ${hubspotDeal.id}:`, error.message);
        errorCount++;
      }
    }

    console.log(
      `HubSpot date range sync completed. Saved: ${savedCount}, Errors: ${errorCount}`
    );

    return {
      savedCount,
      errorCount,
      totalDeals: deals.length,
      dateRange: {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      },
    };
  } catch (error) {
    console.error("Error in syncDateRange:", error);
    throw error;
  }
}

/**
 * Function to fetch data from February 21, 2025 to today
 * This can be called manually as needed
 */
async function syncFromFeb21() {
  // Set start date to February 21, 2025
  const startDate = new Date(2025, 1, 21); // Month is 0-indexed, so 1 = February
  startDate.setHours(0, 0, 0, 0);

  // End date is end of march
  const endDate = new Date(2025, 2, 31); // Month is 0-indexed, so 2 = March
  endDate.setHours(23, 59, 59, 999);

  return syncDateRange(startDate, endDate);
}

// Schedule the task to run daily at 1:00 AM
cron.schedule("0 1 * * *", async () => {
  console.log("Running scheduled HubSpot deal fetch task");
  await fetchAndSaveYesterdayDeals();
});

// Initialize job
console.log("HubSpot daily deal fetch scheduler initialized");

module.exports = {
  fetchAndSaveYesterdayDeals,
  syncDateRange,
  syncFromFeb21,
};
