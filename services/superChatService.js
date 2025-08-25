const axios = require('axios');
const config = require('./superChatConfig');
const SuperChat = require('../models/SuperChat');

function api() {
  const headers = {
    'Content-Type': 'application/json',
    'X-API-KEY': config.api.apiKey,
  };
  
  const instance = axios.create({
    baseURL: config.api.baseUrl,
    timeout: config.api.timeoutMs,
    headers,
  });
  return instance;
}

async function makeApiCall(method, url, data, params) {
  const client = api();
  const res = await client.request({ method, url, data, params });
  return res.data;
}

module.exports = {
  async healthCheck() {
    try {
      if (!config.api.baseUrl) return { externalApi: false, reason: 'No base URL' };
      // Use the correct /me endpoint
      const data = await makeApiCall('get', '/me');
      return { externalApi: true, data };
    } catch (e) {
      return { externalApi: false, reason: e.message };
    }
  },

  // Get all inboxes
  async fetchInboxes() {
    const data = await makeApiCall('get', '/inboxes');
    return data;
  },

  // Get all conversations (this is the main endpoint!)
  async fetchConversations({ page, limit = 50, status, inbox_id, after } = {}) {
    const params = { limit };
    
    // Support both page-based and cursor-based pagination
    if (after) {
      params.after = after;
    } else if (page) {
      params.page = page;
    }
    
    if (status) params.status = status;
    if (inbox_id) params.inbox_id = inbox_id;
    
    const data = await makeApiCall('get', '/conversations', null, params);
    return data;
  },

  // Get specific conversation with messages
  async getConversation(conversationId) {
    const data = await makeApiCall('get', `/conversations/${conversationId}`);
    return data;
  },

  // Get all contacts
  async fetchContacts({ page, limit = 50, after } = {}) {
    const params = { limit };
    
    // Support both page-based and cursor-based pagination
    if (after) {
      params.after = after;
    } else if (page) {
      params.page = page;
    }
    
    const data = await makeApiCall('get', '/contacts', null, params);
    return data;
  },

  // Get all users
  async fetchUsers({ page, limit = 50, after } = {}) {
    const params = { limit };
    
    // Support both page-based and cursor-based pagination
    if (after) {
      params.after = after;
    } else if (page) {
      params.page = page;
    }
    
    const data = await makeApiCall('get', '/users', null, params);
    return data;
  },

  // Get all channels
  async fetchChannels({ page, limit =100, after } = {}) {
    const params = { limit };
    
    // Support both page-based and cursor-based pagination
    if (after) {
      params.after = after;
    } else if (page) {
      params.page = page;
    }
    
    const data = await makeApiCall('get', '/channels', null, params);
    return data;
  },

  // Get all files
  async fetchFiles({ page = 1, limit = 50 } = {}) {
    const data = await makeApiCall('get', '/files', null, { page, limit });
    return data;
  },

  // Get custom attributes
  async fetchCustomAttributes() {
    const data = await makeApiCall('get', '/custom-attributes');
    return data;
  },

  // Send message to a contact (READ-ONLY for now)
  async sendMessage(contactId, payload) {
    // READ-ONLY: Don't actually send messages yet
    console.log('📝 READ-ONLY MODE: Would send message to contact:', contactId, payload);
    return { success: true, message: 'READ-ONLY MODE - Message not sent' };
  },

  // Create webhook for real-time updates
  async createWebhook({ target_url, events }) {
    return makeApiCall('post', '/webhooks', { target_url, events });
  },

  // List webhooks
  async listWebhooks() {
    return makeApiCall('get', '/webhooks');
  },

  // Delete webhook
  async deleteWebhook(webhookId) {
    return makeApiCall('delete', `/webhooks/${webhookId}`);
  },

  // =============================
  // CONVERSATION MANAGEMENT METHODS
  // =============================

  // Get conversation messages
  async getConversationMessages(conversationId) {
    try {
      const data = await makeApiCall('get', `/conversations/${conversationId}/messages`);
      return data;
    } catch (error) {
      console.error(`Failed to get messages for conversation ${conversationId}:`, error.message);
      return { results: [] };
    }
  },

  // Update conversation
  async updateConversation(conversationId, updateData) {
    try {
      const data = await makeApiCall('patch', `/conversations/${conversationId}`, updateData);
      return data;
    } catch (error) {
      console.error(`Failed to update conversation ${conversationId}:`, error.message);
      throw error;
    }
  },

  // Send message (enhanced version)
  async sendMessage(contactId, messageData) {
    try {
      const data = await makeApiCall('post', '/messages', messageData);
      return data;
    } catch (error) {
      console.error(`Failed to send message to contact ${contactId}:`, error.message);
      throw error;
    }
  },

  // Get comprehensive analytics from all data sources
  async getComprehensiveAnalytics({ start_date, end_date, inbox_id } = {}) {
    try {
      // Fetch all data in parallel
      const [conversations, contacts, users, files] = await Promise.all([
        this.fetchConversations({ limit: 1000, status: 'all', inbox_id }),
        this.fetchContacts({ limit: 1000 }),
        this.fetchUsers({ limit: 1000 }),
        this.fetchFiles({ limit: 1000 })
      ]);

      // Calculate analytics
      const analytics = this.calculateAnalytics(conversations, contacts, users, files);
      return analytics;
    } catch (error) {
      console.error('Failed to get comprehensive analytics:', error);
      return { error: 'Failed to fetch analytics data' };
    }
  },

  // Calculate analytics from fetched data
  calculateAnalytics(conversations, contacts, users, files) {
    const convItems = conversations?.results || conversations || [];
    const contactItems = contacts?.results || contacts || [];
    const userItems = users?.results || users || [];
    const fileItems = files?.results || files || [];

    // Conversation analytics
    const totalConversations = convItems.length;
    const openConversations = convItems.filter(c => c.status === 'open').length;
    const closedConversations = convItems.filter(c => c.status === 'done').length; // Super Chat uses 'done' not 'closed'
    const pendingConversations = convItems.filter(c => c.status === 'pending').length;
    const snoozedConversations = convItems.filter(c => c.snoozed_until !== null).length;

    // Channel analytics
    const channelTypes = convItems.reduce((acc, conv) => {
      const type = conv.channel?.type || 'unknown';
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {});

    // Inbox analytics
    const inboxDistribution = convItems.reduce((acc, conv) => {
      const inboxName = conv.inbox?.name || 'unknown';
      acc[inboxName] = (acc[inboxName] || 0) + 1;
      return acc;
    }, {});

    // Contact analytics
    const totalContacts = contactItems.length;
    const activeContacts = convItems.length; // Contacts with conversations
    const contactsWithNames = contactItems.filter(c => c.first_name || c.last_name || c.handles?.some(h => h.value)).length;

    // User analytics
    const totalUsers = userItems.length;
    const supervisors = userItems.filter(u => u.role === 'supervisor').length;
    const agents = userItems.filter(u => u.role === 'agent').length;
    const admins = userItems.filter(u => u.role === 'admin').length;

    // File analytics
    const totalFiles = fileItems.length;
    const imageFiles = fileItems.filter(f => f.mime_type?.includes('image')).length;
    const documentFiles = fileItems.filter(f => f.mime_type?.includes('pdf') || f.mime_type?.includes('doc')).length;
    const recentFiles = fileItems.filter(f => {
      const fileDate = new Date(f.created_at || f.updated_at);
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      return fileDate > weekAgo;
    }).length;

    // Time-based analytics
    const today = new Date();
    const todayConversations = convItems.filter(c => {
      const convDate = new Date(c.created_at || c.updated_at);
      return convDate.toDateString() === today.toDateString();
    }).length;

    const weekConversations = convItems.filter(c => {
      const convDate = new Date(c.created_at || c.updated_at);
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      return convDate > weekAgo;
    }).length;

    return {
      conversations: {
        total: totalConversations,
        open: openConversations,
        closed: closedConversations,
        pending: pendingConversations,
        snoozed: snoozedConversations,
        today: todayConversations,
        this_week: weekConversations,
        by_status: {
          open: openConversations,
          done: closedConversations,
          pending: pendingConversations,
          snoozed: snoozedConversations
        }
      },
      channels: {
        total_types: Object.keys(channelTypes).length,
        distribution: channelTypes,
        live_chat: channelTypes.live_chat || 0,
        facebook_messenger: channelTypes.facebook_messenger || 0,
        whatsapp: channelTypes.whatsapp || 0
      },
      inboxes: {
        total: Object.keys(inboxDistribution).length,
        distribution: inboxDistribution,
        central: inboxDistribution.Central || 0,
        ali: inboxDistribution.Ali || 0
      },
      contacts: {
        total: totalContacts,
        active: activeContacts,
        with_names: contactsWithNames,
        engagement_rate: totalContacts > 0 ? (activeContacts / totalContacts * 100).toFixed(2) : 0,
        avg_conversations_per_contact: totalContacts > 0 ? (totalConversations / totalContacts).toFixed(2) : 0
      },
      users: {
        total: totalUsers,
        supervisors: supervisors,
        agents: agents,
        admins: admins,
        active_rate: totalUsers > 0 ? ((supervisors + agents + admins) / totalUsers * 100).toFixed(2) : 0
      },
      files: {
        total: totalFiles,
        images: imageFiles,
        documents: documentFiles,
        recent: recentFiles,
        recent_rate: totalFiles > 0 ? (recentFiles / totalFiles * 100).toFixed(2) : 0
      },
      summary: {
        total_interactions: totalConversations + totalContacts,
        overall_engagement: totalContacts > 0 ? ((activeContacts + totalConversations) / (totalContacts * 2) * 100).toFixed(2) : 0,
        conversations_per_day: todayConversations,
        conversations_per_week: weekConversations
      }
    };
  },

  // Calculate average response time
  calculateAverageResponseTime(conversations) {
    const responseTimes = conversations
      .filter(c => c.first_response_at && c.created_at)
      .map(c => new Date(c.first_response_at) - new Date(c.created_at));
    
    if (responseTimes.length === 0) return 0;
    
    const avgMs = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
    return Math.round(avgMs / (1000 * 60)); // Convert to minutes
  },

  // Sync conversations to local database
  async syncConversationsToLocal(conversations) {
    const items = Array.isArray(conversations?.results) ? conversations.results : (Array.isArray(conversations) ? conversations : []);
    const saved = [];
    
    for (const conv of items) {
      try {
        const doc = await this.syncConversationToLocal(conv);
        if (doc) saved.push(doc.chatId);
      } catch (error) {
        console.error(`Failed to sync conversation ${conv.id}:`, error.message);
      }
    }
    
    return { synced: saved.length, chatIds: saved };
  },

  // Sync single conversation to local
  async syncConversationToLocal(externalConversation) {
    const chatId = externalConversation.id || externalConversation.conversation_id;
    if (!chatId) return null;

    // Get contact details if available
    let contactInfo = {};
    if (externalConversation.contacts && externalConversation.contacts.length > 0) {
      const contactId = externalConversation.contacts[0].id;
      try {
        const contactResponse = await this.fetchContactDetails(contactId);
        if (contactResponse) {
          contactInfo = contactResponse;
        }
      } catch (error) {
        console.log(`Failed to fetch contact details for ${contactId}:`, error.message);
      }
    }

    // Map Super Chat status to our status
    let mappedStatus = 'new';
    switch (externalConversation.status) {
      case 'open':
        mappedStatus = 'open';
        break;
      case 'done':
        mappedStatus = 'closed';
        break;
      case 'pending':
        mappedStatus = 'pending';
        break;
      default:
        mappedStatus = 'new';
    }

    // Get customer name from contact handles or contact info
    let customerName = 'Unknown';
    if (contactInfo.handles && contactInfo.handles.length > 0) {
      customerName = contactInfo.handles[0].value || 'Unknown';
    } else if (contactInfo.first_name || contactInfo.last_name) {
      customerName = `${contactInfo.first_name || ''} ${contactInfo.last_name || ''}`.trim() || 'Unknown';
    }

    const base = {
      chatId,
      customerId: externalConversation.contacts?.[0]?.id || 'unknown',
      customerName: customerName,
      customerPhone: contactInfo.phone || null,
      customerEmail: contactInfo.email || null,
      status: mappedStatus,
      source: 'super_chat',
      externalData: externalConversation,
      lastActivity: new Date(externalConversation.updated_at || externalConversation.created_at),
      priority: 'medium',
      tags: externalConversation.labels || [],
      notes: '',
      channel: externalConversation.channel?.type || 'unknown',
      inbox: externalConversation.inbox?.name || 'unknown',
      snoozedUntil: externalConversation.snoozed_until ? new Date(externalConversation.snoozed_until) : null,
      timeWindow: externalConversation.time_window?.state || 'closed',
      assignedUsers: externalConversation.assigned_users || []
    };

    const existing = await SuperChat.findOne({ chatId });
    if (existing) {
      // Update existing
      Object.assign(existing, base);
      existing.lastActivity = new Date();
      await existing.save();
      return existing;
    }
    
    // Create new
    const created = await SuperChat.create(base);
    return created;
  },

  // Fetch contact details by ID
  async fetchContactDetails(contactId) {
    try {
      const data = await makeApiCall('get', `/contacts/${contactId}`);
      return data;
    } catch (error) {
      console.error(`Failed to fetch contact ${contactId}:`, error.message);
      return null;
    }
  },

  // Update conversation status (READ-ONLY for now)
  async updateConversation(conversationId, payload) {
    // READ-ONLY: Don't actually update yet
    console.log('📝 READ-ONLY MODE: Would update conversation:', conversationId, payload);
    return { success: true, message: 'READ-ONLY MODE - Status not updated' };
  },

  // Export conversation (READ-ONLY for now)
  async exportConversation(conversationId) {
    // READ-ONLY: Don't actually export yet
    console.log('📝 READ-ONLY MODE: Would export conversation:', conversationId);
    return { success: true, message: 'READ-ONLY MODE - Export not created' };
  },
};


