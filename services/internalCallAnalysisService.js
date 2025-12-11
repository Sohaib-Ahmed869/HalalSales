const OpenAI = require("openai");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");

const openai = new OpenAI({
    apiKey: process.env.NEW_OPENAI_API_KEY,
});

class InternalCallAnalysisService {
    constructor() {
        this.tempDir = path.join(__dirname, "../temp");
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    /**
     * Download audio file from URL
     */
    async downloadAudio(audioUrl) {
        try {
            const fileName = `audio_${Date.now()}.mp3`;
            const filePath = path.join(this.tempDir, fileName);

            const response = await axios({
                method: "GET",
                url: audioUrl,
                responseType: "stream",
            });

            const writer = fs.createWriteStream(filePath);
            response.data.pipe(writer);

            return new Promise((resolve, reject) => {
                writer.on("finish", () => resolve(filePath));
                writer.on("error", reject);
            });
        } catch (error) {
            console.error("Error downloading audio:", error);
            throw new Error(`Failed to download audio: ${error.message}`);
        }
    }

    /**
     * Step 1: Transcribe the audio using Whisper
     */
    async transcribeAudio(audioFilePath) {
        try {
            console.log("Transcribing audio file...");

            const transcription = await openai.audio.transcriptions.create({
                file: fs.createReadStream(audioFilePath),
                model: "whisper-1",
                language: "fr", // French
                response_format: "verbose_json",
                timestamp_granularities: ["segment"],
            });

            console.log("Transcription completed");
            return transcription;
        } catch (error) {
            console.error("Error transcribing audio:", error);
            throw new Error(`Transcription failed: ${error.message}`);
        }
    }

    /**
     * Step 2: Translate French transcript to English
     */
    async translateToEnglish(frenchText) {
        try {
            console.log("Translating transcript to English...");

            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "system",
                        content:
                            "You are a professional translator. Translate the following French conversation to English. Maintain the conversation structure and speaker indicators if present. Provide ONLY the translation without any additional commentary.",
                    },
                    {
                        role: "user",
                        content: frenchText,
                    },
                ],
                temperature: 0.3,
            });

            const translation = response.choices[0].message.content.trim();
            console.log("Translation completed");
            return translation;
        } catch (error) {
            console.error("Error translating:", error);
            throw new Error(`Translation failed: ${error.message}`);
        }
    }

    /**
     * Step 3: Identify speakers (agent vs client)
     */
    async identifySpeakers(transcript, callContext) {
        try {
            console.log("Identifying speakers...");

            const response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    {
                        role: "system",
                        content: `You are an expert at analyzing call transcripts and identifying speakers. 
Given a call transcript, identify which lines belong to the agent and which belong to the client.

Call Context:
- Agent Name: ${callContext.agentName || "Unknown"}
- Call Direction: ${callContext.direction}
- Call Duration: ${callContext.duration} seconds

Your task:
1. Analyze the conversation flow
2. Identify professional language patterns (agent) vs customer queries/responses (client)
3. Return a JSON object with speaker identification

Return ONLY valid JSON in this exact format:
{
  "speakers": {
    "agent": [list of line numbers or ranges],
    "client": [list of line numbers or ranges]
  },
  "confidence": "high/medium/low",
  "reasoning": "brief explanation"
}`,
                    },
                    {
                        role: "user",
                        content: `Analyze this transcript and identify speakers:\n\n${transcript}`,
                    },
                ],
                temperature: 0.3,
                response_format: { type: "json_object" },
            });

            const speakerInfo = JSON.parse(response.choices[0].message.content);
            console.log("Speaker identification completed");
            return speakerInfo;
        } catch (error) {
            console.error("Error identifying speakers:", error);
            throw new Error(`Speaker identification failed: ${error.message}`);
        }
    }

    /**
     * Step 4: Analyze the situation and context
     */
    async analyzeSituation(transcript, callContext) {
        try {
            console.log("Analyzing call situation...");

            const response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    {
                        role: "system",
                        content: `You are an expert sales call analyst. Analyze the conversation to understand the situation, context, and call type.

Call Context:
- Agent: ${callContext.agentName || "Unknown"}
- Direction: ${callContext.direction}
- Duration: ${callContext.duration} seconds
- From: ${callContext.fromNumber}
- To: ${callContext.toNumber}

Identify:
1. Call type (new_customer_outreach, existing_customer_order, follow_up, inquiry_inbound, complaint_handling, information_request, referral_obtained, successful_pitch, unsuccessful_pitch)
2. Main purpose of the call
3. Customer sentiment
4. Key topics discussed
5. Outcome of the call

Return ONLY valid JSON in this exact format:
{
  "callType": "string",
  "purpose": "string",
  "customerSentiment": "positive/neutral/negative",
  "keyTopics": ["topic1", "topic2"],
  "outcome": "string",
  "productsDiscussed": ["product1", "product2"],
  "contextSummary": "brief summary"
}`,
                    },
                    {
                        role: "user",
                        content: `Analyze this call:\n\n${transcript}`,
                    },
                ],
                temperature: 0.4,
                response_format: { type: "json_object" },
            });

            const situationAnalysis = JSON.parse(
                response.choices[0].message.content
            );
            console.log("Situation analysis completed");
            return situationAnalysis;
        } catch (error) {
            console.error("Error analyzing situation:", error);
            throw new Error(`Situation analysis failed: ${error.message}`);
        }
    }

    /**
     * Step 5: Rate agent performance based on situation
     */
    async rateAgentPerformance(transcript, situationAnalysis, speakerInfo) {
        try {
            console.log("Rating agent performance...");

            const response = await openai.chat.completions.create({
                model: "gpt-4o",
                messages: [
                    {
                        role: "system",
                        content: `You are an expert sales performance analyst. Rate the agent's performance based on the call situation and context.

Call Situation:
- Type: ${situationAnalysis.callType}
- Purpose: ${situationAnalysis.purpose}
- Customer Sentiment: ${situationAnalysis.customerSentiment}
- Outcome: ${situationAnalysis.outcome}

Rate the agent on a scale of 1-10 considering:
1. Communication clarity and professionalism
2. Product knowledge and explanation
3. Active listening and empathy
4. Problem-solving ability
5. Call control and efficiency
6. Rapport building
7. Handling objections
8. Call closing and next steps

IMPORTANT: 
- Be balanced and objective in your assessment
- Identify REAL strengths and weaknesses, not generic ones
- If the agent performed well overall, focus strengths on what they did best
- If the agent had issues, focus weaknesses on specific areas that need improvement
- Don't force finding equal numbers of strengths and weaknesses - be honest
- Provide specific, actionable recommendations

Return ONLY valid JSON in this exact format:
{
  "qualityScore": 7.5,
  "strengths": ["specific strength 1", "specific strength 2", "specific strength 3"],
  "weaknesses": ["specific weakness 1", "specific weakness 2"],
  "conversationDynamics": {
    "agentTalkRatio": "65%",
    "keyMoments": ["moment 1", "moment 2"],
    "missedOpportunities": ["opportunity 1"]
  },
  "recommendations": [
    "specific recommendation 1",
    "specific recommendation 2",
    "specific recommendation 3"
  ],
  "detailedAnalysis": "paragraph explaining the rating"
}`,
                    },
                    {
                        role: "user",
                        content: `Rate this agent's performance:\n\nTranscript:\n${transcript}\n\nContext:\n${JSON.stringify(
                            situationAnalysis
                        )}`,
                    },
                ],
                temperature: 0.5,
                response_format: { type: "json_object" },
            });

            const performanceRating = JSON.parse(
                response.choices[0].message.content
            );
            console.log("Performance rating completed");
            return performanceRating;
        } catch (error) {
            console.error("Error rating performance:", error);
            throw new Error(`Performance rating failed: ${error.message}`);
        }
    }

    /**
     * Main analysis function - orchestrates the entire pipeline
     */
    async analyzeCall(audioUrl, callContext) {
        let audioFilePath = null;

        try {
            console.log("Starting call analysis pipeline...");

            // Step 1: Download audio
            audioFilePath = await this.downloadAudio(audioUrl);

            // Step 2: Transcribe audio (in French)
            const transcriptionResult = await this.transcribeAudio(audioFilePath);
            const frenchTranscript = transcriptionResult.text;

            // Step 3: Translate to English
            const englishTranscript = await this.translateToEnglish(frenchTranscript);

            // Step 4: Identify speakers
            const speakerInfo = await this.identifySpeakers(
                englishTranscript,
                callContext
            );

            // Step 5: Analyze situation
            const situationAnalysis = await this.analyzeSituation(
                englishTranscript,
                callContext
            );

            // Step 6: Rate agent performance
            const performanceRating = await this.rateAgentPerformance(
                englishTranscript,
                situationAnalysis,
                speakerInfo
            );

            // Combine all results
            const finalAnalysis = {
                transcript: englishTranscript,
                originalTranscript: frenchTranscript,
                analysis: performanceRating.detailedAnalysis,
                qualityScore: performanceRating.qualityScore,
                speakers: speakerInfo,
                structuredAnalysis: {
                    callType: situationAnalysis.callType,
                    generalAnalysis: situationAnalysis.contextSummary,
                    speakerIdentification: {
                        agentLines: speakerInfo.speakers.agent,
                        clientLines: speakerInfo.speakers.client,
                        confidence: speakerInfo.confidence,
                    },
                    salesPerformance: {
                        score: performanceRating.qualityScore,
                        strengths: performanceRating.strengths,
                        weaknesses: performanceRating.weaknesses,
                        productsDiscussed: situationAnalysis.productsDiscussed,
                    },
                    conversationDynamics: performanceRating.conversationDynamics,
                    recommendations: performanceRating.recommendations,
                    customerSentiment: situationAnalysis.customerSentiment,
                    callOutcome: situationAnalysis.outcome,
                },
                summary: situationAnalysis.contextSummary,
            };

            console.log("Call analysis pipeline completed successfully");
            return finalAnalysis;
        } catch (error) {
            console.error("Error in call analysis pipeline:", error);
            throw error;
        } finally {
            // Cleanup: Delete temporary audio file
            if (audioFilePath && fs.existsSync(audioFilePath)) {
                try {
                    fs.unlinkSync(audioFilePath);
                    console.log("Temporary audio file deleted");
                } catch (cleanupError) {
                    console.error("Error deleting temporary file:", cleanupError);
                }
            }
        }
    }

    /**
     * Cleanup old temporary files
     */
    cleanupOldFiles() {
        try {
            const files = fs.readdirSync(this.tempDir);
            const now = Date.now();
            const oneHourAgo = now - 60 * 60 * 1000;

            files.forEach((file) => {
                const filePath = path.join(this.tempDir, file);
                const stats = fs.statSync(filePath);

                if (stats.mtimeMs < oneHourAgo) {
                    fs.unlinkSync(filePath);
                    console.log(`Cleaned up old file: ${file}`);
                }
            });
        } catch (error) {
            console.error("Error cleaning up old files:", error);
        }
    }
}

module.exports = new InternalCallAnalysisService();