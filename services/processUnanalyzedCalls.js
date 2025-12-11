const CallData = require("../models/CallData");
const internalCallAnalysisService = require("./internalCallAnalysisService");

/**
 * Process up to 50 unanalyzed calls with duration > 2 minutes
 */
async function processUnanalyzedCalls() {
  try {
    console.log("Starting batch analysis of unanalyzed calls...");

    // Find calls that:
    // 1. Have a recording file
    // 2. Don't have an analysis yet (or qualityScore is 0/null)
    // 3. Have duration > 120 seconds (2 minutes)
    // 4. Limit to 50 calls
    // keep date range in the last 2 months
    const twoMonthsAgo = new Date();
    twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

    const unanalyzedCalls = await CallData.find({
      createdAt: { $gte: twoMonthsAgo },
      file: { $exists: true, $ne: null, $ne: "" },
      $or: [
        { qualityScore: { $exists: false } },
        { qualityScore: null },
        { qualityScore: 0 },
        { transcript: { $exists: false } },
        { transcript: null },
        { transcript: "" },
      ],
      totalDuration: { $gte: 120 }, // At least 2 minutes
    })
      .limit(50)
      .lean();

    console.log(`Found ${unanalyzedCalls.length} unanalyzed calls to process`);

    if (unanalyzedCalls.length === 0) {
      console.log("No unanalyzed calls found");
      return {
        success: true,
        message: "No unanalyzed calls to process",
        processed: 0,
        failed: 0,
      };
    }

    let processedCount = 0;
    let failedCount = 0;
    const errors = [];

    // Process each call
    for (const call of unanalyzedCalls) {
      try {
        console.log(`Processing call ${call.callID}...`);

        // Prepare call context
        const callContext = {
          callID: call.callID,
          direction: call.direction,
          duration: call.totalDuration,
          agentName: call.userName,
          fromNumber: call.fromNumber,
          toNumber: call.toNumber,
        };

        // Analyze the call
        const analysisResult = await internalCallAnalysisService.analyzeCall(
          call.file,
          callContext
        );

        // Update the call in the database
        await CallData.findOneAndUpdate(
          { callID: call.callID },
          {
            $set: {
              transcript: analysisResult.transcript,
              originalTranscript: analysisResult.originalTranscript,
              analysis: analysisResult.analysis,
              qualityScore: analysisResult.qualityScore || 0,
              analysisTimestamp: new Date(),
              structuredAnalysis: analysisResult.structuredAnalysis || null,
              speakers: analysisResult.speakers || null,
            },
          }
        );

        processedCount++;
        console.log(`✓ Call ${call.callID} analyzed successfully`);

        // Add a small delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(`✗ Error processing call ${call.callID}:`, error.message);
        failedCount++;
        errors.push({
          callID: call.callID,
          error: error.message,
        });
      }
    }

    console.log(
      `Batch analysis completed: ${processedCount} processed, ${failedCount} failed`
    );

    return {
      success: true,
      message: "Batch analysis completed",
      processed: processedCount,
      failed: failedCount,
      total: unanalyzedCalls.length,
      errors: errors.length > 0 ? errors : undefined,
    };
  } catch (error) {
    console.error("Error in batch analysis:", error);
    throw error;
  }
}

module.exports = processUnanalyzedCalls;