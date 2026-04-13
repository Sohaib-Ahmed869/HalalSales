// agents/baseAgent.js
const OpenAI = require('openai');

const OPENAI_MODEL = 'gpt-4o';
const MAX_TOKENS = 4096;
const MAX_LOG_ENTRIES = parseInt(process.env.AGENT_LOG_MAX_ENTRIES) || 50;

// Shared action log across all agents
const actionLog = [];

class BaseAgent {
    constructor(name) {
        this.name = name;
        this.prefix = `[${name}]`;
        this.client = new OpenAI({
            apiKey: process.env.NEW_OPENAI_API_KEY,
        });
        this.model = OPENAI_MODEL;
        this.maxTokens = MAX_TOKENS;
    }

    log(message, data = null) {
        const entry = `${this.prefix} ${message}`;
        console.log(entry);
        if (data) console.log(data);
    }

    logError(message, error) {
        console.error(`${this.prefix} ${message}`, error?.message || error);
    }

    addToActionLog(action, details = {}) {
        const entry = {
            timestamp: new Date().toISOString(),
            agent: this.name,
            action,
            details,
        };
        actionLog.unshift(entry);
        if (actionLog.length > MAX_LOG_ENTRIES) {
            actionLog.length = MAX_LOG_ENTRIES;
        }
        return entry;
    }

    static getActionLog() {
        return actionLog;
    }

    /**
     * Call OpenAI with optional function calling.
     * Returns the full chat completion response.
     */
    async callLLM(systemPrompt, userMessage, tools = []) {
        try {
            const params = {
                model: this.model,
                max_tokens: this.maxTokens,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userMessage },
                ],
            };

            if (tools.length > 0) {
                params.tools = tools;
            }

            const response = await this.client.chat.completions.create(params);
            return response;
        } catch (error) {
            this.logError('OpenAI API call failed:', error);
            throw error;
        }
    }

    /**
     * Run a tool-use loop: call OpenAI, execute function calls, feed results back.
     * toolExecutors is a map of { toolName: async (input) => result }
     * tools should be in OpenAI format: [{ type: "function", function: { name, description, parameters } }]
     */
    async runToolLoop(systemPrompt, userMessage, tools, toolExecutors, maxIterations = 10) {
        let messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
        ];
        let finalTextContent = '';

        for (let i = 0; i < maxIterations; i++) {
            const response = await this.client.chat.completions.create({
                model: this.model,
                max_tokens: this.maxTokens,
                messages,
                tools,
            });

            const choice = response.choices[0];
            const message = choice.message;

            // Collect text content
            if (message.content) {
                finalTextContent += message.content;
            }

            // Check if the model wants to call functions
            if (!message.tool_calls || message.tool_calls.length === 0 || choice.finish_reason === 'stop') {
                return { textContent: finalTextContent, response };
            }

            // Add assistant message with tool_calls
            messages.push(message);

            // Execute each tool call and add results
            for (const toolCall of message.tool_calls) {
                const fnName = toolCall.function.name;
                const fnArgs = JSON.parse(toolCall.function.arguments);
                const executor = toolExecutors[fnName];

                let result;
                if (executor) {
                    try {
                        result = await executor(fnArgs);
                    } catch (err) {
                        this.logError(`Tool ${fnName} failed:`, err);
                        result = { error: err.message };
                    }
                } else {
                    result = { error: `Unknown tool: ${fnName}` };
                }

                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: typeof result === 'string' ? result : JSON.stringify(result),
                });
            }
        }

        return { textContent: finalTextContent, response: null };
    }

    /**
     * Extract text content from an OpenAI response
     */
    extractText(response) {
        if (!response?.choices?.[0]?.message?.content) return '';
        return response.choices[0].message.content;
    }

    /**
     * Extract JSON from a text response
     */
    extractJSON(text) {
        try {
            // Try direct parse first
            return JSON.parse(text.trim());
        } catch {
            // Try to find JSON in the text
            const match = text.match(/\{[\s\S]*\}/);
            if (match) {
                return JSON.parse(match[0]);
            }
            return null;
        }
    }
}

module.exports = { BaseAgent, actionLog };
