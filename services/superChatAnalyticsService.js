const axios = require('axios');
const config = require('./superChatConfig');

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

// Function to fetch ALL data from paginated endpoints
async function fetchAllData(endpoint, params = {}) {
  try {
    console.log(`🔄 Fetching all data from ${endpoint}...`);
    let allResults = [];
    let nextCursor = null;
    let pageCount = 0;
    
    do {
      pageCount++;
      const requestParams = { ...params, limit: 100 }; // Use 100 per page for efficiency
      if (nextCursor) {
        requestParams.after = nextCursor;
      }
      
      console.log(`  📄 Page ${pageCount}: Fetching ${endpoint}...`);
      const response = await makeApiCall('get', endpoint, null, requestParams);
      
      if (response.results && Array.isArray(response.results)) {
        allResults = allResults.concat(response.results);
        console.log(`    ✅ Got ${response.results.length} results (Total: ${allResults.length})`);
      }
      
      // Check for next page
      nextCursor = response.pagination?.next_cursor || null;
      
    
      
    } while (nextCursor);
    
    console.log(`✅ Completed fetching ${endpoint}: ${allResults.length} total results from ${pageCount} pages`);
    return { results: allResults, total: allResults.length };
    
  } catch (error) {
    console.error(`❌ Error fetching all data from ${endpoint}:`, error.message);
    throw error;
  }
}

module.exports = {
  async getDashboardAnalytics() {
    try {
      console.log('🚀 Fetching SuperChat dashboard analytics (ALL DATA)...');
      
      // Fetch ALL data from all pages in parallel
      const [conversations, contacts, users, inboxes] = await Promise.allSettled([
        fetchAllData('/conversations'),
        fetchAllData('/contacts'),
        fetchAllData('/users'),
        fetchAllData('/inboxes')
      ]);

      // Extract data and handle errors
      const conversationsData = conversations.status === 'fulfilled' ? conversations.value : { results: [] };
      const contactsData = contacts.status === 'fulfilled' ? contacts.value : { results: [] };
      const usersData = users.status === 'fulfilled' ? users.value : { results: [] };
      const inboxesData = inboxes.status === 'fulfilled' ? inboxes.value : { results: [] };

      // Get error messages
      const conversationsError = conversations.status === 'rejected' ? `Conversations API failed: ${conversations.reason.message}` : null;
      const contactsError = contacts.status === 'rejected' ? `Contacts API failed: ${contacts.reason.message}` : null;
      const usersError = users.status === 'rejected' ? `Users API failed: ${users.reason.message}` : null;
      const inboxesError = inboxes.status === 'rejected' ? `Inboxes API failed: ${inboxes.reason.message}` : null;

      // Extract items from responses
      const convItems = conversationsData?.results || [];
      const contactItems = contactsData?.results || [];
      const userItems = usersData?.results || [];
      const inboxItems = inboxesData?.results || [];

      console.log(`📊 COMPLETE DATA FETCHED:`);
      console.log(`  - Conversations: ${convItems.length}`);
      console.log(`  - Contacts: ${contactItems.length}`);
      console.log(`  - Users: ${userItems.length}`);
      console.log(`  - Inboxes: ${inboxItems.length}`);

      // Calculate metrics
      const totalMessages = convItems.length; // Each conversation represents a message thread
      const answeredConversations = convItems.filter(c => c.status === 'done').length;
      const pendingConversations = convItems.filter(c => c.status === 'open').length;
      
      // Channel distribution
      const channelStats = convItems.reduce((acc, conv) => {
        const type = conv.channel?.type || 'unknown';
        acc[type] = (acc[type] || 0) + 1;
        return acc;
      }, {});
      
      // Inbox analytics
      const inboxStats = convItems.reduce((acc, conv) => {
        const inboxName = conv.inbox?.name || 'unknown';
        if (!acc[inboxName]) {
          acc[inboxName] = {
            name: inboxName,
            total: 0,
            open: 0,
            done: 0,
            channels: {}
          };
        }
        acc[inboxName].total++;
        
        if (conv.status === 'open') acc[inboxName].open++;
        if (conv.status === 'done') acc[inboxName].done++;
        
        const channelType = conv.channel?.type || 'unknown';
        acc[inboxName].channels[channelType] = (acc[inboxName].channels[channelType] || 0) + 1;
        
        return acc;
      }, {});
      
      // Agent performance
      const agentStats = {};
      convItems.forEach(conv => {
        if (conv.assigned_users && conv.assigned_users.length > 0) {
          conv.assigned_users.forEach(userId => {
            if (!agentStats[userId]) {
              agentStats[userId] = {
                id: userId,
                total_assigned: 0,
                resolved: 0,
                pending: 0,
                channels: {}
              };
            }
            agentStats[userId].total_assigned++;
            
            if (conv.status === 'done') agentStats[userId].resolved++;
            if (conv.status === 'open') agentStats[userId].pending++;
            
            const channelType = conv.channel?.type || 'unknown';
            agentStats[userId].channels[channelType] = (agentStats[userId].channels[channelType] || 0) + 1;
          });
        }
      });
      
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
      
      // Response time analytics
      const responseTimes = convItems
        .filter(c => c.first_response_at && c.created_at)
        .map(c => new Date(c.first_response_at) - new Date(c.created_at));
      
      const avgResponseTime = responseTimes.length > 0 
        ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length / (1000 * 60))
        : 0;

      const dashboardData = {
        overview: {
          total_conversations: convItems.length,
          total_messages: totalMessages,
          answered_conversations: answeredConversations,
          pending_conversations: pendingConversations,
          total_contacts: contactItems.length,
          total_users: userItems.length,
          total_inboxes: inboxItems.length,
          today_conversations: todayConversations,
          week_conversations: weekConversations,
          avg_response_time_minutes: avgResponseTime
        },
        channels: {
          total_types: Object.keys(channelStats).length,
          distribution: channelStats,
          live_chat: channelStats.live_chat || 0,
          facebook_messenger: channelStats.facebook_messenger || 0,
          whatsapp: channelStats.whatsapp || 0,
          sms: channelStats.sms || 0,
          email: channelStats.email || 0
        },
        inboxes: {
          total: Object.keys(inboxStats).length,
          details: Object.values(inboxStats).map(inbox => ({
            name: inbox.name,
            total_conversations: inbox.total,
            open_conversations: inbox.open,
            resolved_conversations: inbox.done,
            channels: inbox.channels
          }))
        },
        agents: {
          total_assigned: Object.keys(agentStats).length,
          performance: Object.values(agentStats).map(agent => ({
            id: agent.id,
            total_assigned: agent.total_assigned,
            resolved: agent.resolved,
            pending: agent.pending,
            resolution_rate: agent.total_assigned > 0 ? (agent.resolved / agent.total_assigned * 100).toFixed(2) : 0,
            channels: agent.channels
          }))
        },
        trends: {
          daily: todayConversations,
          weekly: weekConversations,
          response_time: avgResponseTime,
          channel_growth: channelStats,
          inbox_performance: inboxStats
        },
        api_status: {
          conversations: conversationsError ? 'failed' : 'working',
          contacts: contactsError ? 'failed' : 'working',
          users: usersError ? 'failed' : 'working',
          inboxes: inboxesError ? 'failed' : 'working'
        },
        api_errors: {
          conversations: conversationsError,
          contacts: contactsError,
          users: usersError,
          inboxes: inboxesError
        }
      };

      console.log('✅ Dashboard analytics generated successfully with COMPLETE data');
      return dashboardData;

    } catch (error) {
      console.error('❌ Error generating dashboard analytics:', error);
      throw error;
    }
  },

  async getOverview({ startDate, endDate, user }) {
    try {
      const dashboardData = await this.getDashboardAnalytics();
      return dashboardData.overview;
    } catch (error) {
      console.error('Error getting overview:', error);
    return {
        total_conversations: 0,
        total_messages: 0,
        answered_conversations: 0,
        pending_conversations: 0,
        total_contacts: 0,
        total_users: 0,
        total_inboxes: 0,
        today_conversations: 0,
        week_conversations: 0,
        avg_response_time_minutes: 0
      };
    }
  }
};


