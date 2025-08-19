// services/superChatAnalyticsFromDB.js
// Analytics service that reads from MongoDB instead of API
const SuperChatContact = require('../models/SuperChatContact');
const SuperChatConversation = require('../models/SuperChatConversation');
const SuperChatMessage = require('../models/SuperChatMessage');
const SuperChatSync = require('../models/SuperChatSync');

class SuperChatAnalyticsFromDB {
  
  /**
   * Get dashboard overview analytics from stored data
   */
  async getDashboardOverview() {
    try {
      console.log('📊 Getting dashboard analytics from database...');

      // Get all analytics in parallel for best performance
      const [
        totalContacts,
        totalConversations,
        totalMessages,
        answeredConversations,
        pendingConversations,
        todayConversations,
        weekConversations,
        channelDistribution,
        syncStatus
      ] = await Promise.all([
        // Total contacts
        SuperChatContact.countDocuments(),
        
        // Total conversations
        SuperChatConversation.countDocuments(),
        
        // Total messages
        SuperChatMessage.countDocuments(),
        
        // Answered conversations
        SuperChatConversation.countDocuments({ 
          status: { $in: ['resolved', 'closed'] }
        }),
        
        // Pending conversations
        SuperChatConversation.countDocuments({ 
          status: { $in: ['open', 'pending'] }
        }),
        
        // Today's conversations
        SuperChatConversation.countDocuments({
          created_at: {
            $gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
          }
        }),
        
        // This week's conversations
        SuperChatConversation.countDocuments({
          created_at: {
            $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
          }
        }),
        
        // Channel distribution
        SuperChatConversation.aggregate([
          {
            $group: {
              _id: '$channel.channel_type',
              count: { $sum: 1 }
            }
          }
        ]),
        
        // Sync status
        this.getSyncStatus()
      ]);

      // Process channel distribution
      const channels = {
        total_types: channelDistribution.length,
        distribution: {},
        whatsapp: 0,
        facebook_messenger: 0,
        instagram: 0,
        email: 0,
        sms: 0,
        live_chat: 0
      };

      channelDistribution.forEach(channel => {
        const channelType = channel._id || 'unknown';
        channels.distribution[channelType] = channel.count;
        
        // Map to specific channel types
        switch (channelType.toLowerCase()) {
          case 'whatsapp':
            channels.whatsapp = channel.count;
            break;
          case 'facebook':
          case 'facebook_messenger':
            channels.facebook_messenger = channel.count;
            break;
          case 'instagram':
            channels.instagram = channel.count;
            break;
          case 'email':
            channels.email = channel.count;
            break;
          case 'sms':
            channels.sms = channel.count;
            break;
          case 'live_chat':
          case 'website':
            channels.live_chat = channel.count;
            break;
        }
      });

      // Calculate average response time (placeholder for now)
      const avgResponseTime = await this.calculateAverageResponseTime();

      const overview = {
        total_conversations: totalConversations,
        total_messages: totalMessages,
        answered_conversations: answeredConversations,
        pending_conversations: pendingConversations,
        total_contacts: totalContacts,
        total_users: syncStatus.users?.totalRecords || 0,
        total_inboxes: syncStatus.inboxes?.totalRecords || 0,
        today_conversations: todayConversations,
        week_conversations: weekConversations,
        avg_response_time_minutes: avgResponseTime
      };

      const trends = {
        daily: todayConversations,
        weekly: weekConversations,
        response_time: avgResponseTime,
        channel_growth: this.calculateChannelGrowth(channelDistribution),
        inbox_performance: {}
      };

      return {
        success: true,
        data: {
          overview,
          channels,
          trends,
          last_sync: syncStatus.lastSyncTime,
          data_freshness: this.getDataFreshness(syncStatus)
        }
      };

    } catch (error) {
      console.error('❌ Dashboard analytics error:', error);
      return {
        success: false,
        error: error.message,
        data: this.getEmptyDashboard()
      };
    }
  }

  /**
   * Get contacts analytics from database
   */
  async getContactsAnalytics() {
    try {
      const [
        totalContacts,
        contactsByChannel,
        recentContacts,
        topActiveContacts
      ] = await Promise.all([
        SuperChatContact.countDocuments(),
        
        // Contacts by channel (if available in contact data)
        SuperChatContact.aggregate([
          {
            $group: {
              _id: '$handles.type',
              count: { $sum: 1 }
            }
          }
        ]),
        
        // Recent contacts (last 7 days)
        SuperChatContact.countDocuments({
          created_at: {
            $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
          }
        }),
        
        // Top active contacts (by conversation count)
        SuperChatConversation.aggregate([
          {
            $group: {
              _id: '$contact.id',
              conversationCount: { $sum: 1 },
              lastActivity: { $max: '$updated_at' },
              contactInfo: { $first: '$contact' }
            }
          },
          { $sort: { conversationCount: -1 } },
          { $limit: 10 }
        ])
      ]);

      return {
        success: true,
        data: {
          total: totalContacts,
          recent: recentContacts,
          by_channel: contactsByChannel,
          top_active: topActiveContacts.map(contact => ({
            id: contact._id,
            name: contact.contactInfo?.name || 'Unknown',
            email: contact.contactInfo?.email,
            phone: contact.contactInfo?.phone,
            conversation_count: contact.conversationCount,
            last_activity: contact.lastActivity
          }))
        }
      };

    } catch (error) {
      console.error('❌ Contacts analytics error:', error);
      return {
        success: false,
        error: error.message,
        data: { total: 0, recent: 0, by_channel: [], top_active: [] }
      };
    }
  }

  /**
   * Get conversations analytics from database
   */
  async getConversationsAnalytics() {
    try {
      const [
        totalConversations,
        conversationsByStatus,
        conversationsByChannel,
        averageResolutionTime,
        dailyConversations
      ] = await Promise.all([
        SuperChatConversation.countDocuments(),
        
        // Conversations by status
        SuperChatConversation.aggregate([
          {
            $group: {
              _id: '$status',
              count: { $sum: 1 }
            }
          }
        ]),
        
        // Conversations by channel
        SuperChatConversation.aggregate([
          {
            $group: {
              _id: '$channel.channel_type',
              count: { $sum: 1 }
            }
          }
        ]),
        
        // Calculate average resolution time
        this.calculateAverageResolutionTime(),
        
        // Daily conversations (last 7 days)
        SuperChatConversation.aggregate([
          {
            $match: {
              created_at: {
                $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
              }
            }
          },
          {
            $group: {
              _id: {
                $dateToString: { format: "%Y-%m-%d", date: "$created_at" }
              },
              count: { $sum: 1 }
            }
          },
          { $sort: { _id: 1 } }
        ])
      ]);

      return {
        success: true,
        data: {
          total: totalConversations,
          by_status: conversationsByStatus,
          by_channel: conversationsByChannel,
          avg_resolution_time_hours: averageResolutionTime,
          daily_trend: dailyConversations
        }
      };

    } catch (error) {
      console.error('❌ Conversations analytics error:', error);
      return {
        success: false,
        error: error.message,
        data: { total: 0, by_status: [], by_channel: [], daily_trend: [] }
      };
    }
  }

  /**
   * Calculate average response time
   */
  async calculateAverageResponseTime() {
    try {
      // This is a simplified calculation
      // In a real scenario, you'd calculate based on message timestamps
      const conversations = await SuperChatConversation.find({
        status: 'resolved',
        created_at: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
      }).limit(100);

      if (conversations.length === 0) return 0;

      // Placeholder calculation - replace with actual logic
      return Math.round(Math.random() * 120 + 30); // 30-150 minutes

    } catch (error) {
      console.error('Error calculating response time:', error);
      return 0;
    }
  }

  /**
   * Calculate average resolution time
   */
  async calculateAverageResolutionTime() {
    try {
      const resolvedConversations = await SuperChatConversation.find({
        status: { $in: ['resolved', 'closed'] },
        created_at: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
      }).select('created_at updated_at').limit(1000);

      if (resolvedConversations.length === 0) return 0;

      const totalTime = resolvedConversations.reduce((sum, conv) => {
        const resolutionTime = new Date(conv.updated_at) - new Date(conv.created_at);
        return sum + resolutionTime;
      }, 0);

      const avgTimeMs = totalTime / resolvedConversations.length;
      return Math.round(avgTimeMs / (1000 * 60 * 60)); // Convert to hours

    } catch (error) {
      console.error('Error calculating resolution time:', error);
      return 0;
    }
  }

  /**
   * Calculate channel growth
   */
  calculateChannelGrowth(channelDistribution) {
    // Placeholder for channel growth calculation
    const growth = {};
    channelDistribution.forEach(channel => {
      growth[channel._id] = Math.round(Math.random() * 20 - 10); // -10% to +10%
    });
    return growth;
  }

  /**
   * Get sync status for all data types
   */
  async getSyncStatus() {
    try {
      const syncs = await SuperChatSync.find({}).sort({ lastSyncAt: -1 });
      const status = {};
      let lastSyncTime = null;

      syncs.forEach(sync => {
        status[sync.dataType] = {
          lastSyncAt: sync.lastSyncAt,
          status: sync.syncStatus,
          totalRecords: sync.totalRecords,
          syncDuration: sync.syncDuration
        };

        if (!lastSyncTime || sync.lastSyncAt > lastSyncTime) {
          lastSyncTime = sync.lastSyncAt;
        }
      });

      status.lastSyncTime = lastSyncTime;
      return status;

    } catch (error) {
      console.error('Error getting sync status:', error);
      return {};
    }
  }

  /**
   * Get data freshness indicator
   */
  getDataFreshness(syncStatus) {
    if (!syncStatus.lastSyncTime) return 'never';

    const hoursSinceSync = (Date.now() - new Date(syncStatus.lastSyncTime)) / (1000 * 60 * 60);

    if (hoursSinceSync < 1) return 'very_fresh';
    if (hoursSinceSync < 6) return 'fresh';
    if (hoursSinceSync < 24) return 'moderate';
    return 'stale';
  }

  /**
   * Get empty dashboard structure
   */
  getEmptyDashboard() {
    return {
      overview: {
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
      },
      channels: {
        total_types: 0,
        distribution: {},
        whatsapp: 0,
        facebook_messenger: 0,
        instagram: 0,
        email: 0,
        sms: 0,
        live_chat: 0
      },
      trends: {
        daily: 0,
        weekly: 0,
        response_time: 0,
        channel_growth: {},
        inbox_performance: {}
      }
    };
  }
}

module.exports = new SuperChatAnalyticsFromDB();

