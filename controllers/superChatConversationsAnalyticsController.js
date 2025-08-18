const SuperChatConversation = require('../models/SuperChatConversation');
const SuperChatMessage = require('../models/SuperChatMessage');

class SuperChatConversationsAnalyticsController {
  
  // =============================
  // CONVERSATIONS OVERVIEW ANALYTICS
  // =============================

  async getConversationsOverview(req, res) {
    try {
      const totalConversations = await SuperChatConversation.countDocuments();
      const openConversations = await SuperChatConversation.countDocuments({ status: 'open' });
      const doneConversations = await SuperChatConversation.countDocuments({ status: 'done' });
      const snoozedConversations = await SuperChatConversation.countDocuments({ status: 'snoozed' });
      
      // Conversations in last 24 hours
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const conversationsLast24h = await SuperChatConversation.countDocuments({
        created_at: { $gte: yesterday }
      });
      
      // Conversations in last 7 days
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const conversationsLast7Days = await SuperChatConversation.countDocuments({
        created_at: { $gte: sevenDaysAgo }
      });
      
      // Average messages per conversation
      const totalMessages = await SuperChatMessage.countDocuments();
      const avgMessagesPerConvo = totalConversations > 0 ? (totalMessages / totalConversations).toFixed(2) : 0;
      
      // Active conversations (with messages in last 24h)
      const activeConversations = await SuperChatConversation.countDocuments({
        last_message_at: { $gte: yesterday }
      });

      res.json({
        success: true,
        data: {
          total_conversations: totalConversations,
          status_breakdown: {
            open: openConversations,
            done: doneConversations,
            snoozed: snoozedConversations
          },
          status_percentages: {
            open_percentage: totalConversations > 0 ? Math.round((openConversations / totalConversations) * 100) : 0,
            done_percentage: totalConversations > 0 ? Math.round((doneConversations / totalConversations) * 100) : 0,
            snoozed_percentage: totalConversations > 0 ? Math.round((snoozedConversations / totalConversations) * 100) : 0
          },
          activity_metrics: {
            conversations_last_24h: conversationsLast24h,
            conversations_last_7_days: conversationsLast7Days,
            active_conversations: activeConversations,
            avg_messages_per_conversation: parseFloat(avgMessagesPerConvo)
          }
        },
        message: 'Conversations overview analytics retrieved successfully'
      });

    } catch (error) {
      console.error('❌ Failed to get conversations overview:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get conversations overview analytics',
        error: error.message
      });
    }
  }

  // =============================
  // CONVERSATIONS VOLUME TRENDS
  // =============================

  async getConversationsVolumeTrend(req, res) {
    try {
      const { days = 30 } = req.query;
      const daysNum = parseInt(days);
      
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysNum);
      
      // Daily conversations creation trend
      const dailyVolume = await SuperChatConversation.aggregate([
        {
          $match: {
            created_at: { $gte: startDate }
          }
        },
        {
          $group: {
            _id: {
              year: { $year: '$created_at' },
              month: { $month: '$created_at' },
              day: { $dayOfMonth: '$created_at' }
            },
            new_conversations: { $sum: 1 },
            avg_messages: { $avg: '$message_count' }
          }
        },
        {
          $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 }
        }
      ]);

      // Format for frontend charts
      const formattedData = dailyVolume.map(item => ({
        date: `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(2, '0')}`,
        new_conversations: item.new_conversations,
        avg_messages: Math.round(item.avg_messages || 0)
      }));

      res.json({
        success: true,
        data: {
          period: `${daysNum} days`,
          daily_volume: formattedData,
          total_new_conversations: dailyVolume.reduce((sum, item) => sum + item.new_conversations, 0)
        },
        message: 'Conversations volume trend retrieved successfully'
      });

    } catch (error) {
      console.error('❌ Failed to get conversations volume trend:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get conversations volume trend',
        error: error.message
      });
    }
  }

  // =============================
  // CONVERSATIONS BY CHANNEL
  // =============================

  async getConversationsByChannel(req, res) {
    try {
      const channelBreakdown = await SuperChatConversation.aggregate([
        {
          $group: {
            _id: '$channel.type',
            count: { $sum: 1 },
            open_count: {
              $sum: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] }
            },
            done_count: {
              $sum: { $cond: [{ $eq: ['$status', 'done'] }, 1, 0] }
            }
          }
        },
        {
          $sort: { count: -1 }
        }
      ]);

      const formattedData = channelBreakdown.map(item => ({
        channel_type: item._id || 'Unknown',
        total_conversations: item.count,
        open_conversations: item.open_count,
        done_conversations: item.done_count,
        completion_rate: item.count > 0 ? Math.round((item.done_count / item.count) * 100) : 0
      }));

      res.json({
        success: true,
        data: {
          channel_breakdown: formattedData,
          total_channels: channelBreakdown.length
        },
        message: 'Conversations by channel retrieved successfully'
      });

    } catch (error) {
      console.error('❌ Failed to get conversations by channel:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get conversations by channel',
        error: error.message
      });
    }
  }

  // =============================
  // RESPONSE TIME ANALYTICS
  // =============================

  async getResponseTimeAnalytics(req, res) {
    try {
      // Get conversations with message activity
      const conversationsWithMessages = await SuperChatConversation.find({
        message_count: { $gt: 1 }
      }).select('conversation_id created_at last_message_at message_count');

      let totalResponseTime = 0;
      let conversationsWithResponseTime = 0;
      const responseTimeRanges = {
        under_1h: 0,
        '1h_to_6h': 0,
        '6h_to_24h': 0,
        over_24h: 0
      };

      conversationsWithMessages.forEach(conv => {
        if (conv.last_message_at && conv.created_at) {
          const responseTime = (new Date(conv.last_message_at) - new Date(conv.created_at)) / (1000 * 60 * 60); // hours
          
          if (responseTime > 0) {
            totalResponseTime += responseTime;
            conversationsWithResponseTime++;
            
            if (responseTime < 1) responseTimeRanges.under_1h++;
            else if (responseTime < 6) responseTimeRanges['1h_to_6h']++;
            else if (responseTime < 24) responseTimeRanges['6h_to_24h']++;
            else responseTimeRanges.over_24h++;
          }
        }
      });

      const avgResponseTime = conversationsWithResponseTime > 0 ? 
        (totalResponseTime / conversationsWithResponseTime).toFixed(2) : 0;

      res.json({
        success: true,
        data: {
          average_response_time_hours: parseFloat(avgResponseTime),
          response_time_distribution: responseTimeRanges,
          conversations_analyzed: conversationsWithResponseTime
        },
        message: 'Response time analytics retrieved successfully'
      });

    } catch (error) {
      console.error('❌ Failed to get response time analytics:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get response time analytics',
        error: error.message
      });
    }
  }

  // =============================
  // BUSIEST CONVERSATIONS
  // =============================

  async getBusiestConversations(req, res) {
    try {
      const { limit = 10 } = req.query;
      
      const busiestConversations = await SuperChatConversation.find({
        message_count: { $gt: 0 }
      })
      .sort({ message_count: -1 })
      .limit(parseInt(limit))
      .select('conversation_id status message_count unread_count contact last_message_at');

      const formattedConversations = busiestConversations.map(conv => ({
        conversation_id: conv.conversation_id,
        status: conv.status,
        message_count: conv.message_count || 0,
        unread_count: conv.unread_count || 0,
        contact_name: conv.contact ? `${conv.contact.first_name} ${conv.contact.last_name}`.trim() : 'Unknown',
        contact_email: conv.contact?.email || 'No email',
        last_message_at: conv.last_message_at,
        days_since_last_message: conv.last_message_at ? 
          Math.floor((new Date() - new Date(conv.last_message_at)) / (1000 * 60 * 60 * 24)) : 
          null
      }));

      res.json({
        success: true,
        data: {
          busiest_conversations: formattedConversations,
          total_returned: formattedConversations.length
        },
        message: 'Busiest conversations retrieved successfully'
      });

    } catch (error) {
      console.error('❌ Failed to get busiest conversations:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get busiest conversations',
        error: error.message
      });
    }
  }

  // =============================
  // CONVERSATION COMPLETION RATE
  // =============================

  async getCompletionRate(req, res) {
    try {
      const { days = 30 } = req.query;
      const daysNum = parseInt(days);
      
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysNum);
      
      const completionStats = await SuperChatConversation.aggregate([
        {
          $match: {
            created_at: { $gte: startDate }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            completed: {
              $sum: { $cond: [{ $eq: ['$status', 'done'] }, 1, 0] }
            },
            open: {
              $sum: { $cond: [{ $eq: ['$status', 'open'] }, 1, 0] }
            },
            snoozed: {
              $sum: { $cond: [{ $eq: ['$status', 'snoozed'] }, 1, 0] }
            }
          }
        }
      ]);

      const stats = completionStats[0] || { total: 0, completed: 0, open: 0, snoozed: 0 };
      const completionRate = stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0;

      res.json({
        success: true,
        data: {
          period: `${daysNum} days`,
          completion_rate_percentage: completionRate,
          breakdown: {
            total_conversations: stats.total,
            completed: stats.completed,
            open: stats.open,
            snoozed: stats.snoozed
          }
        },
        message: 'Conversation completion rate retrieved successfully'
      });

    } catch (error) {
      console.error('❌ Failed to get completion rate:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get completion rate',
        error: error.message
      });
    }
  }
}

module.exports = SuperChatConversationsAnalyticsController;
