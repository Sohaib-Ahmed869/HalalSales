require('dotenv').config();

const config = {
  api: {
    baseUrl: process.env.SUPER_CHAT_API_BASE_URL || 'https://api.superchat.com/v1.0',
    apiKey: process.env.SUPER_CHAT_API_KEY || '',
    timeoutMs: Number(process.env.SUPER_CHAT_API_TIMEOUT_MS || 15000),
    authMethod: 'X-API-KEY', // Fixed to match official API
  },
  webhook: {
    secret: process.env.SUPER_CHAT_WEBHOOK_SECRET || '',
    endpoint: process.env.SUPER_CHAT_WEBHOOK_ENDPOINT || '/api/super-chat/webhook',
    enabled: process.env.SUPER_CHAT_WEBHOOK_ENABLED === 'true',
    events: [
      'message_inbound',
      'contact_updated',
      'contact_created',
      'message_outbound',
      'message_failed',
      'note_created',
      'conversation_done',
      'conversation_opened',
      'conversation_snoozed',
    ],
  },
  sync: {
    enabled: process.env.SUPER_CHAT_SYNC_ENABLED === 'true',
    intervalCron: process.env.SUPER_CHAT_SYNC_CRON || '*/10 * * * *',
  },
  features: {
    analytics: process.env.SUPER_CHAT_FEATURE_ANALYTICS !== 'false',
  },
};

module.exports = config;


