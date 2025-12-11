const mongoose = require("mongoose");

const callDataSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    callID: { type: String, required: true },
    channelID: { type: String, required: true },
    type: { type: String },
    direction: { type: String },
    lastState: { type: String },
    startTime: { type: Date },
    answeredTime: { type: Date },
    hangupTime: { type: Date },
    totalDuration: { type: Number },
    inCallDuration: { type: Number },
    queueDuration: { type: Number },
    holdDuration: { type: Number },
    ringingDuration: { type: Number },
    afterCallDuration: { type: Number },
    ivrDuration: { type: Number },
    fromNumber: { type: String },
    toNumber: { type: String },
    contact: { type: String },
    userID: { type: String },
    userName: { type: String },
    ivrID: { type: String },
    ivrName: { type: String },
    scenarioName: { type: String },
    file: { type: String },
    note: { type: String },
    tags: [{ type: String }],
    groups: { type: String },
    notes: { type: String },
    locations: { type: String },
    digitEntered: { type: String },
    missed: { type: String },
    transcript: { type: String },
    analysis: { type: String },
    qualityScore: { type: Number, default: 0 },
    analysisTimestamp: { type: Date },
    summary: { type: String }, // ADD THIS
    originalTranscript: {
      type: String,
      default: null,
    },

    // ADD THIS ENTIRE FIELD
    speakers: [{
      speaker: { type: String },
      segments: [{
        start: { type: String },
        end: { type: String },
        text_fr: { type: String },
        text_en: { type: String }
      }]
    }],

    structuredAnalysis: {
      generalAnalysis: { type: String },
      speakerIdentification: {
        agentLines: { type: mongoose.Schema.Types.Mixed },
        clientLines: { type: mongoose.Schema.Types.Mixed },
        confidence: { type: String },
      },
      salesPerformance: {
        score: { type: Number },
        strengths: [{ type: String }],
        weaknesses: [{ type: String }],
        productsDiscussed: [{ type: String }],
        closingAttempts: { type: Number },
        objectionHandling: { type: String },
      },
      conversationDynamics: {
        agentTalkRatio: { type: String },
        keyMoments: [{ type: String }],
        missedOpportunities: [{ type: String }],
      },
      recommendations: [{ type: String }],
    },
    clientFeedback: {
      rating: {
        type: Number,
        min: 1,
        max: 10,
      },
      comments: String,
      agreeWithAnalysis: Boolean,
      specificFeedback: {
        strengthsAccurate: Boolean,
        weaknessesAccurate: Boolean,
        recommendationsHelpful: Boolean,
        additionalNotes: String,
      },
      submittedAt: Date,
      submittedBy: String,
      submitted: {
        type: Boolean,
        default: false,
      },
    },
  },
  {
    timestamps: true,
  }
);

const CallData = mongoose.model("CallData", callDataSchema);

module.exports = CallData;
