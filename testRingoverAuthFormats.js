/**
 * Test Ringover API - Try different auth formats
 */

require("dotenv").config();
const axios = require("axios");

const RINGOVER_API_KEY = process.env.RINGOVER_API_KEY;
const RINGOVER_API_BASE = "https://api.ringover.com/v2";

async function testAuthFormat(name, headers) {
  try {
    console.log(`\n🔍 Testing: ${name}`);
    const response = await axios.get(`${RINGOVER_API_BASE}/me`, {
      headers,
      timeout: 5000,
    });
    console.log(`✅ SUCCESS with format: ${name}`);
    console.log(JSON.stringify(response.data, null, 2));
    return true;
  } catch (error) {
    const status = error.response?.status;
    const msg = error.response?.data?.message || error.message;
    console.log(`❌ Failed (${status}): ${msg}`);
    return false;
  }
}

async function testAllFormats() {
  console.log("🧪 Testing Ringover Auth Formats");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`API Key: ***${RINGOVER_API_KEY.slice(-4)}`);

  const formats = [
    {
      name: "Bearer Token",
      headers: {
        Authorization: `Bearer ${RINGOVER_API_KEY}`,
        "Content-Type": "application/json",
      },
    },
    {
      name: "Basic Auth",
      headers: {
        Authorization: `Basic ${Buffer.from(`:${RINGOVER_API_KEY}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
    },
    {
      name: "X-API-Key Header",
      headers: {
        "X-API-Key": RINGOVER_API_KEY,
        "Content-Type": "application/json",
      },
    },
    {
      name: "Query Parameter",
      headers: {
        "Content-Type": "application/json",
      },
    },
  ];

  for (const format of formats.slice(0, 3)) {
    await testAuthFormat(format.name, format.headers);
  }

  // Test with query param
  try {
    console.log(`\n🔍 Testing: Query Parameter`);
    const response = await axios.get(`${RINGOVER_API_BASE}/me?api_key=${RINGOVER_API_KEY}`, {
      timeout: 5000,
    });
    console.log(`✅ SUCCESS with query parameter`);
    console.log(JSON.stringify(response.data, null, 2));
  } catch (error) {
    const status = error.response?.status;
    const msg = error.response?.data?.message || error.message;
    console.log(`❌ Failed (${status}): ${msg}`);
  }

  console.log("\n📝 Note: Check Ringover documentation for correct auth format");
  console.log("       The API key format may have changed or require a specific header");
}

testAllFormats();
