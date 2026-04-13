// routes/agentRoutes.js
const express = require('express');
const router = express.Router();
const orchestratorAgent = require('../agents/orchestratorAgent');
const discoveryAgent = require('../agents/discoveryAgent');
const comparisonAgent = require('../agents/comparisonAgent');
const { actionLog } = require('../agents/baseAgent');

/**
 * POST /api/agents/trigger
 * Manually trigger an agent event
 * Body: { event: string, payload: object }
 */
router.post('/trigger', async (req, res) => {
    try {
        const { event, payload = {} } = req.body;

        if (!event) {
            return res.status(400).json({
                success: false,
                error: 'Event name is required',
            });
        }

        const result = await orchestratorAgent.handleEvent(event, payload);

        res.json({
            success: true,
            message: `Event "${event}" handled successfully`,
            data: result,
        });
    } catch (error) {
        console.error('[AgentRoutes] Trigger error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * GET /api/agents/log
 * View recent agent action log
 * Query: ?limit=20&agent=Inbound
 */
router.get('/log', (req, res) => {
    try {
        let { limit = 50, agent } = req.query;
        limit = Math.min(parseInt(limit) || 50, 200);

        let logs = actionLog;

        if (agent) {
            logs = logs.filter(entry => entry.agent.toLowerCase() === agent.toLowerCase());
        }

        res.json({
            success: true,
            data: {
                total: logs.length,
                entries: logs.slice(0, limit),
            },
        });
    } catch (error) {
        console.error('[AgentRoutes] Log error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * POST /api/agents/discover-contact
 * Run DiscoveryAgent for a specific vendor
 * Body: { vendorName, vendorCode, country?, productCategory? }
 */
router.post('/discover-contact', async (req, res) => {
    try {
        const { vendorName, vendorCode, country, productCategory } = req.body;

        if (!vendorName) {
            return res.status(400).json({
                success: false,
                error: 'vendorName is required',
            });
        }

        const result = await discoveryAgent.discoverContact({
            vendorName,
            vendorCode,
            country,
            productCategory,
        });

        res.json({
            success: true,
            message: result.found
                ? `Contact found for ${vendorName}`
                : `No contact found for ${vendorName}`,
            data: result,
        });
    } catch (error) {
        console.error('[AgentRoutes] Discover error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * POST /api/agents/compare/:rfqId
 * Manually trigger ComparisonAgent for an RFQ
 */
router.post('/compare/:rfqId', async (req, res) => {
    try {
        const { rfqId } = req.params;

        const result = await comparisonAgent.compare({ rfqId });

        res.json({
            success: true,
            message: 'Comparison report generated',
            data: result,
        });
    } catch (error) {
        console.error('[AgentRoutes] Compare error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * GET /api/agents/status
 * Health check — shows if orchestrator is running
 */
router.get('/status', (req, res) => {
    try {
        const status = orchestratorAgent.getStatus();

        res.json({
            success: true,
            data: {
                ...status,
                uptime: process.uptime(),
                timestamp: new Date().toISOString(),
            },
        });
    } catch (error) {
        console.error('[AgentRoutes] Status error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

module.exports = router;
