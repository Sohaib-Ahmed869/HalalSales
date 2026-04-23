/**
 * Test Ringover API Connection
 * Verifies that the Ringover API key works and the service can connect
 */

require("dotenv").config();
const axios = require("axios");

const RINGOVER_API_KEY = process.env.RINGOVER_API_KEY;
const RINGOVER_API_BASE = "https://api.ringover.com/v2";

async function testRingoverConnection() {
  console.log("🧪 Testing Ringover API Connection");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  if (!RINGOVER_API_KEY) {
    console.error("❌ RINGOVER_API_KEY not found in .env");
    process.exit(1);
  }

  console.log("✅ API Key loaded: ***" + RINGOVER_API_KEY.slice(-4));
  console.log("📡 Testing connection to Ringover API...\n");

  try {
    // Test with a simple auth endpoint
    const response = await axios.get(`${RINGOVER_API_BASE}/me`, {
      headers: {
        Authorization: `Bearer ${RINGOVER_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 10000,
    });

    console.log("✅ Ringover API Connection: SUCCESS");
    console.log("\n📋 Account Info:");
    console.log(JSON.stringify(response.data, null, 2));

    console.log("\n🎉 All systems ready for daily exports!");
    console.log("\n✨ Daily export will run automatically at 12:00 AM French time");
    console.log("📤 Or manually trigger: curl -X POST http://localhost:5000/api/ringover-export/daily");

    process.exit(0);
  } catch (error) {
    console.error("❌ Ringover API Connection: FAILED");
    console.error("\nError Details:");

    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Message: ${error.response.data?.message || error.response.statusText}`);
      console.error(`Data: ${JSON.stringify(error.response.data, null, 2)}`);
    } else if (error.request) {
      console.error("No response from server:", error.message);
    } else {
      console.error("Error:", error.message);
    }

    console.log("\n⚠️  Troubleshooting:");
    console.log("1. Verify RINGOVER_API_KEY is correct in .env");
    console.log("2. Check that Ringover API is accessible");
    console.log("3. Ensure the API key has proper permissions");

    process.exit(1);
  }
}

testRingoverConnection();
