// utils/rfqAttention.js
// Single source of truth for "which RFQs need admin attention", shared by the
// GET /api/rfq/pending-attention endpoint and the socket push that replaced the
// sidebar's 15s poll.

/**
 * RFQs where the bot flagged acceptance for review, or negotiation stalled.
 */
const PENDING_ATTENTION_FILTER = {
    status: { $nin: ['completed', 'cancelled'] },
    vendorsContacted: {
        $elemMatch: {
            $or: [
                { pendingAdminReview: true },
                { negotiationStatus: { $in: ['awaiting_admin_approval', 'stalled'] } },
            ],
        },
    },
};

const getPendingAttentionCount = async () => {
    const RFQ = require('../models/RFQ');
    return RFQ.countDocuments(PENDING_ATTENTION_FILTER);
};

/**
 * Recompute the badge count and push it to admins/managers.
 * Best-effort — callers should not fail because a socket push did.
 */
const pushPendingAttentionCount = async () => {
    try {
        const { emitRfqAttentionCount } = require('../socket');
        const count = await getPendingAttentionCount();
        emitRfqAttentionCount(count);
        return count;
    } catch (err) {
        console.warn('[rfqAttention] push failed:', err.message);
        return null;
    }
};

module.exports = {
    PENDING_ATTENTION_FILTER,
    getPendingAttentionCount,
    pushPendingAttentionCount,
};
