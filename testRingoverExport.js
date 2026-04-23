/**
 * Temporary test script for Ringover export
 * Run with: node testRingoverExport.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const { generateRingoverExport } = require("./services/ringoverExportService");

const MONGO_URI =
  process.env.MONGO_URI || "mongodb://127.0.0.1:27017/salesHalal";

async function testExport() {
  try {
    console.log("Connecting to MongoDB...");
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log("✅ Connected to MongoDB");

    console.log("\n🔄 Starting Ringover export with test data...");
    const result = await generateRingoverExport({
      includeTest: true,
      userId: "test-user",
    });

    console.log("\n✅ Export completed!");
    console.log("Batch ID:", result.batchId);
    console.log("Timestamp:", result.timestamp);
    console.log("\nSummary:");
    console.log(JSON.stringify(result.summary, null, 2));
    console.log("\nFiles generated:");
    for (const file of result.files) {
      console.log(`- ${file.fileName} (${file.recordCount} records)`);
      console.log(`  URL: ${file.s3Url}`);
    }

    if (result.errors.length > 0) {
      console.log("\nErrors:");
      result.errors.forEach((err) => console.log(`- ${err}`));
    }

    console.log("\n📋 Full result:");
    console.log(JSON.stringify(result, null, 2));

    await mongoose.connection.close();
    console.log("✅ MongoDB connection closed");
  } catch (error) {
    console.error("❌ Test failed:", error);
    process.exit(1);
  }
}

testExport();
