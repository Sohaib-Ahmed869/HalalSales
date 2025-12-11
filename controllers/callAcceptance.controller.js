const CallData = require("../models/CallData");

const callAcceptanceController = {
    // Get analyzed calls for review
    getAnalyzedCalls: async (req, res) => {
        try {
            const page = parseInt(req.query.page) || 1;
            const limit = parseInt(req.query.limit) || 10;
            const skip = (page - 1) * limit;

            // Build filter
            const filter = {
                qualityScore: { $exists: true, $ne: null, $gt: 0 },
                transcript: { $exists: true, $ne: null, $ne: "" },
                file: { $exists: true, $ne: null, $ne: "" },
            };

            // Filter by feedback status
            if (req.query.feedbackStatus) {
                if (req.query.feedbackStatus === "pending") {
                    filter["clientFeedback.submitted"] = { $ne: true };
                } else if (req.query.feedbackStatus === "submitted") {
                    filter["clientFeedback.submitted"] = true;
                }
            }

            // Filter by agent
            if (req.query.agentName) {
                filter.userName = new RegExp(req.query.agentName, "i");
            }

            // Filter by date range
            if (req.query.startDate && req.query.endDate) {
                filter.startTime = {
                    $gte: new Date(req.query.startDate),
                    $lte: new Date(req.query.endDate),
                };
            }

            // Filter by quality score range
            if (req.query.minScore) {
                filter.qualityScore = { ...filter.qualityScore, $gte: parseFloat(req.query.minScore) };
            }
            if (req.query.maxScore) {
                filter.qualityScore = { ...filter.qualityScore, $lte: parseFloat(req.query.maxScore) };
            }

            const calls = await CallData.find(filter)
                .sort({ startTime: -1 })
                .skip(skip)
                .limit(limit)
                .lean();

            const total = await CallData.countDocuments(filter);

            return res.status(200).json({
                data: calls,
                pagination: {
                    total,
                    page,
                    limit,
                    pages: Math.ceil(total / limit),
                },
            });
        } catch (error) {
            console.error("Error fetching analyzed calls:", error);
            return res.status(500).json({
                error: "Error fetching analyzed calls",
                details: error.message,
            });
        }
    },

    // Get call details
    getCallDetails: async (req, res) => {
        try {
            const { callID } = req.params;

            const call = await CallData.findOne({ callID }).lean();

            if (!call) {
                return res.status(404).json({ error: "Call not found" });
            }

            return res.status(200).json(call);
        } catch (error) {
            console.error("Error fetching call details:", error);
            return res.status(500).json({
                error: "Error fetching call details",
                details: error.message,
            });
        }
    },

    // Submit feedback
    submitFeedback: async (req, res) => {
        try {
            const { callID } = req.params;
            const { rating, comments, agreeWithAnalysis, specificFeedback } = req.body;

            // Validate rating
            if (!rating || rating < 1 || rating > 10) {
                return res.status(400).json({
                    error: "Invalid rating. Must be between 1 and 10",
                });
            }

            const call = await CallData.findOne({ callID });

            if (!call) {
                return res.status(404).json({ error: "Call not found" });
            }

            // Update with feedback
            call.clientFeedback = {
                rating,
                comments: comments || "",
                agreeWithAnalysis: agreeWithAnalysis !== undefined ? agreeWithAnalysis : null,
                specificFeedback: specificFeedback || {},
                submittedAt: new Date(),
                submittedBy: req.user.email || req.user.phone,
                submitted: true,
            };

            await call.save();

            return res.status(200).json({
                success: true,
                message: "Feedback submitted successfully",
                data: call.clientFeedback,
            });
        } catch (error) {
            console.error("Error submitting feedback:", error);
            return res.status(500).json({
                error: "Error submitting feedback",
                details: error.message,
            });
        }
    },

    // Get feedback statistics
    getFeedbackStats: async (req, res) => {
        try {
            const { startDate, endDate } = req.query;

            // Build filter
            const filter = {
                qualityScore: { $exists: true, $ne: null, $gt: 0 },
            };

            if (startDate && endDate) {
                filter.startTime = {
                    $gte: new Date(startDate),
                    $lte: new Date(endDate),
                };
            }

            const totalAnalyzed = await CallData.countDocuments(filter);

            const withFeedback = await CallData.countDocuments({
                ...filter,
                "clientFeedback.submitted": true,
            });

            const pendingFeedback = totalAnalyzed - withFeedback;

            // Average ratings
            const ratingStats = await CallData.aggregate([
                {
                    $match: {
                        ...filter,
                        "clientFeedback.submitted": true,
                    },
                },
                {
                    $group: {
                        _id: null,
                        avgClientRating: { $avg: "$clientFeedback.rating" },
                        avgSystemScore: { $avg: "$qualityScore" },
                        count: { $sum: 1 },
                    },
                },
            ]);

            // Agreement rate
            const agreementStats = await CallData.aggregate([
                {
                    $match: {
                        ...filter,
                        "clientFeedback.submitted": true,
                        "clientFeedback.agreeWithAnalysis": { $ne: null },
                    },
                },
                {
                    $group: {
                        _id: "$clientFeedback.agreeWithAnalysis",
                        count: { $sum: 1 },
                    },
                },
            ]);

            const agreementData = {
                agreed: 0,
                disagreed: 0,
                total: 0,
            };

            agreementStats.forEach((stat) => {
                if (stat._id === true) {
                    agreementData.agreed = stat.count;
                } else if (stat._id === false) {
                    agreementData.disagreed = stat.count;
                }
            });
            agreementData.total = agreementData.agreed + agreementData.disagreed;
            agreementData.agreementRate =
                agreementData.total > 0
                    ? ((agreementData.agreed / agreementData.total) * 100).toFixed(1)
                    : 0;

            return res.status(200).json({
                totalAnalyzed,
                withFeedback,
                pendingFeedback,
                feedbackRate:
                    totalAnalyzed > 0
                        ? ((withFeedback / totalAnalyzed) * 100).toFixed(1)
                        : 0,
                averageClientRating:
                    ratingStats.length > 0 ? ratingStats[0].avgClientRating.toFixed(1) : 0,
                averageSystemScore:
                    ratingStats.length > 0 ? ratingStats[0].avgSystemScore.toFixed(1) : 0,
                agreement: agreementData,
            });
        } catch (error) {
            console.error("Error fetching feedback stats:", error);
            return res.status(500).json({
                error: "Error fetching feedback stats",
                details: error.message,
            });
        }
    },
};

module.exports = callAcceptanceController;