// agents/orchestratorAgent.js
const cron = require('node-cron');
const { BaseAgent, actionLog } = require('./baseAgent');
const inboundAgent = require('./inboundAgent');
const outboundAgent = require('./outboundAgent');
const discoveryAgent = require('./discoveryAgent');
const comparisonAgent = require('./comparisonAgent');

// Known events that map directly to agents
const EVENT_MAP = {
    rfq_created: 'outbound',
    rfq_send_requested: 'outbound',
    check_inbox: 'inbound',
    rfq_closed: 'comparison',
    vendor_missing_contact: 'discovery',
};

class OrchestratorAgent extends BaseAgent {
    constructor() {
        super('Orchestrator');
        this.isRunning = false;
        this.cronJob = null;
    }

    /**
     * Start the orchestrator — replaces the old rfqResponsePoller.start()
     */
    start() {
        if (this.isRunning) {
            this.log('Already running');
            return;
        }

        const intervalMinutes = parseInt(process.env.AGENT_POLL_INTERVAL_MINUTES) || 5;

        this.log(`Starting orchestrator (inbox check every ${intervalMinutes} minutes)`);

        this.cronJob = cron.schedule(`*/${intervalMinutes} * * * *`, async () => {
            await this.handleEvent('check_inbox', {});
        });

        this.isRunning = true;
        this.addToActionLog('orchestrator_started', { intervalMinutes });

        // Run inbox check once immediately on start
        this.handleEvent('check_inbox', {}).catch(err =>
            this.logError('Initial inbox check failed:', err)
        );
    }

    /**
     * Stop the orchestrator
     */
    stop() {
        if (this.cronJob) {
            this.cronJob.stop();
            this.isRunning = false;
            this.log('Stopped');
            this.addToActionLog('orchestrator_stopped');
        }
    }

    /**
     * Handle an event — route to the correct agent
     * @param {string} event - Event name
     * @param {Object} payload - Event data
     */
    async handleEvent(event, payload = {}) {
        this.log(`Handling event: ${event}`, payload);
        this.addToActionLog('event_received', { event, payload });

        try {
            // Direct mapping for known events
            const agentType = EVENT_MAP[event];

            if (agentType) {
                return await this._routeToAgent(agentType, event, payload);
            }

            // Ambiguous event — use Claude to decide
            this.log(`Unknown event "${event}", using AI to route`);
            return await this._aiRoute(event, payload);
        } catch (error) {
            this.logError(`Error handling event "${event}":`, error);
            this.addToActionLog('event_error', { event, error: error.message });
            throw error;
        }
    }

    /**
     * Route to the correct agent
     */
    async _routeToAgent(agentType, event, payload) {
        switch (agentType) {
            case 'inbound':
                return await this._runInbound(payload);

            case 'outbound':
                return await this._runOutbound(payload);

            case 'comparison':
                return await this._runComparison(payload);

            case 'discovery':
                return await this._runDiscovery(payload);

            default:
                throw new Error(`Unknown agent type: ${agentType}`);
        }
    }

    /**
     * Run Inbound Agent — check inbox
     */
    async _runInbound(payload) {
        this.log('Routing to InboundAgent');
        try {
            const result = await inboundAgent.checkInbox();
            return { agent: 'inbound', success: true, result };
        } catch (error) {
            this.logError('InboundAgent error:', error);
            return { agent: 'inbound', success: false, error: error.message };
        }
    }

    /**
     * Run Outbound Agent — send RFQ
     */
    async _runOutbound(payload) {
        const { rfqId, vendorCodes, sendMethod, customMessage } = payload;

        if (!rfqId) {
            throw new Error('rfqId is required for outbound events');
        }

        this.log(`Routing to OutboundAgent for RFQ ${rfqId}`);

        // If vendorCodes not provided, get them from the RFQ
        let codes = vendorCodes;
        if (!codes || codes.length === 0) {
            const RFQ = require('../models/RFQ');
            const rfq = await RFQ.findById(rfqId);
            if (rfq) {
                codes = rfq.vendorsContacted
                    .filter(v => v.status === 'draft')
                    .map(v => v.vendorCode);
            }
        }

        if (!codes || codes.length === 0) {
            return { agent: 'outbound', success: false, error: 'No vendor codes to send to' };
        }

        // Check for missing contacts and run discovery first
        const vendorsNeedingDiscovery = await this._findVendorsWithoutContact(codes);
        if (vendorsNeedingDiscovery.length > 0) {
            this.log(`${vendorsNeedingDiscovery.length} vendors need contact discovery first`);
            await discoveryAgent.discoverMultiple(vendorsNeedingDiscovery);
        }

        try {
            const result = await outboundAgent.sendRFQ({
                rfqId,
                vendorCodes: codes,
                sendMethod: sendMethod || 'email',
                customMessage,
            });
            return { agent: 'outbound', success: true, result };
        } catch (error) {
            this.logError('OutboundAgent error:', error);
            return { agent: 'outbound', success: false, error: error.message };
        }
    }

    /**
     * Run Comparison Agent
     */
    async _runComparison(payload) {
        const { rfqId } = payload;
        if (!rfqId) throw new Error('rfqId is required for comparison events');

        this.log(`Routing to ComparisonAgent for RFQ ${rfqId}`);

        try {
            const result = await comparisonAgent.compare({ rfqId });
            return { agent: 'comparison', success: true, result };
        } catch (error) {
            this.logError('ComparisonAgent error:', error);
            return { agent: 'comparison', success: false, error: error.message };
        }
    }

    /**
     * Run Discovery Agent
     */
    async _runDiscovery(payload) {
        const { vendorName, vendorCode, country, productCategory } = payload;
        if (!vendorName && !vendorCode) {
            throw new Error('vendorName or vendorCode is required for discovery events');
        }

        this.log(`Routing to DiscoveryAgent for ${vendorName || vendorCode}`);

        try {
            const result = await discoveryAgent.discoverContact({
                vendorName,
                vendorCode,
                country,
                productCategory,
            });
            return { agent: 'discovery', success: true, result };
        } catch (error) {
            this.logError('DiscoveryAgent error:', error);
            return { agent: 'discovery', success: false, error: error.message };
        }
    }

    /**
     * Use Claude to route ambiguous events
     */
    async _aiRoute(event, payload) {
        try {
            const response = await this.callLLM(
                `You are an event router for an RFQ management system. Map events to agents.

Available agents:
- inbound: Checks inbox for vendor email responses
- outbound: Sends RFQs to vendors via email/whatsapp
- comparison: Compares vendor quotes and picks a winner
- discovery: Finds vendor contact info via web search

Return JSON: { "agent": "agent_name", "reasoning": "why" }`,
                `Route this event:
Event: "${event}"
Payload: ${JSON.stringify(payload)}

Which agent should handle this?`,
            );

            const text = this.extractText(response);
            const result = this.extractJSON(text);

            if (result?.agent && ['inbound', 'outbound', 'comparison', 'discovery'].includes(result.agent)) {
                this.log(`AI routed "${event}" to ${result.agent}: ${result.reasoning}`);
                this.addToActionLog('ai_routed', { event, agent: result.agent, reasoning: result.reasoning });
                return await this._routeToAgent(result.agent, event, payload);
            }

            throw new Error(`AI could not determine agent for event: ${event}`);
        } catch (error) {
            this.logError('AI routing failed:', error);
            throw new Error(`Cannot route event "${event}": ${error.message}`);
        }
    }

    /**
     * Find vendors that are missing email/phone
     */
    async _findVendorsWithoutContact(vendorCodes) {
        const Vendor = require('../models/Vendor');
        const PDA_Supplier = require('../models/PDA_Supplier');

        const needsDiscovery = [];

        const pdaIds = vendorCodes.filter(c => /^[0-9a-fA-F]{24}$/.test(c));
        const sapCodes = vendorCodes.filter(c => !/^[0-9a-fA-F]{24}$/.test(c));

        if (sapCodes.length > 0) {
            const vendors = await Vendor.find({
                CardCode: { $in: sapCodes },
                $or: [
                    { email: { $exists: false } },
                    { email: null },
                    { email: '' },
                ],
            });

            for (const v of vendors) {
                needsDiscovery.push({
                    vendorName: v.CardName,
                    vendorCode: v.CardCode,
                    country: v.country,
                    productCategory: v.productCategories?.[0],
                });
            }
        }

        if (pdaIds.length > 0) {
            const suppliers = await PDA_Supplier.find({
                _id: { $in: pdaIds },
                $or: [
                    { email: { $exists: false } },
                    { email: null },
                    { email: '' },
                ],
            });

            for (const s of suppliers) {
                needsDiscovery.push({
                    vendorName: s.supplierName,
                    vendorCode: s._id.toString(),
                    country: s.country,
                    productCategory: s.searchTerm,
                });
            }
        }

        return needsDiscovery;
    }

    /**
     * Get status info
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            pollInterval: `${parseInt(process.env.AGENT_POLL_INTERVAL_MINUTES) || 5} minutes`,
            recentActions: actionLog.slice(0, 10),
            totalLogEntries: actionLog.length,
        };
    }
}

module.exports = new OrchestratorAgent();
