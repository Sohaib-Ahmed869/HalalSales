const SuperChatContact = require('../models/SuperChatContact');
const SuperChatConversation = require('../models/SuperChatConversation');
const SuperChatMessage = require('../models/SuperChatMessage');

class SuperChatTotalAnalyticsController {
  
  // =============================
  // DASHBOARD OVERVIEW
  // =============================

  async getDashboardOverview(req, res) {
    try {
      // Get basic counts
      const totalContacts = await SuperChatContact.countDocuments();
      const totalConversations = await SuperChatConversation.countDocuments();
      const totalMessages = await SuperChatMessage.countDocuments();
      
      // Recent activity (last 24 hours)
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      
      const newContactsToday = await SuperChatContact.countDocuments({
        created_at: { $gte: yesterday }
      });
      
      const newConversationsToday = await SuperChatConversation.countDocuments({
        created_at: { $gte: yesterday }
      });
      
      const messagesLast24h = await SuperChatMessage.countDocuments({
        created_at: { $gte: yesterday }
      });
      
      // Active conversations
      const openConversations = await SuperChatConversation.countDocuments({ status: 'open' });
      const unresolvedConversations = await SuperChatConversation.countDocuments({
        status: { $in: ['open', 'snoozed'] }
      });
      
      // Response metrics
      const avgMessagesPerConvo = totalConversations > 0 ? 
        (totalMessages / totalConversations).toFixed(2) : 0;

      res.json({
        success: true,
        data: {
          totals: {
            contacts: totalContacts,
            conversations: totalConversations,
            messages: totalMessages
          },
          today_activity: {
            new_contacts: newContactsToday,
            new_conversations: newConversationsToday,
            messages_exchanged: messagesLast24h
          },
          conversation_status: {
            open: openConversations,
            unresolved: unresolvedConversations,
            resolution_rate: totalConversations > 0 ? 
              Math.round(((totalConversations - unresolvedConversations) / totalConversations) * 100) : 0
          },
          engagement_metrics: {
            avg_messages_per_conversation: parseFloat(avgMessagesPerConvo),
            total_engagement_score: Math.round((messagesLast24h / Math.max(openConversations, 1)) * 10) / 10
          }
        },
        message: 'Dashboard overview retrieved successfully'
      });

    } catch (error) {
      console.error('❌ Failed to get dashboard overview:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get dashboard overview',
        error: error.message
      });
    }
  }

  // =============================
  // WEEKLY ACTIVITY SUMMARY
  // =============================

  async getWeeklyActivitySummary(req, res) {
    try {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      
      // Get daily activity for the last 7 days
      const dailyActivity = await Promise.all([
        // Conversations daily
        SuperChatConversation.aggregate([
          {
            $match: { created_at: { $gte: sevenDaysAgo } }
          },
          {
            $group: {
              _id: {
                year: { $year: '$created_at' },
                month: { $month: '$created_at' },
                day: { $dayOfMonth: '$created_at' }
              },
              conversations: { $sum: 1 }
            }
          },
          { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
        ]),
        
        // Messages daily
        SuperChatMessage.aggregate([
          {
            $match: { created_at: { $gte: sevenDaysAgo } }
          },
          {
            $group: {
              _id: {
                year: { $year: '$created_at' },
                month: { $month: '$created_at' },
                day: { $dayOfMonth: '$created_at' }
              },
              messages: { $sum: 1 }
            }
          },
          { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
        ]),
        
        // Contacts daily
        SuperChatContact.aggregate([
          {
            $match: { created_at: { $gte: sevenDaysAgo } }
          },
          {
            $group: {
              _id: {
                year: { $year: '$created_at' },
                month: { $month: '$created_at' },
                day: { $dayOfMonth: '$created_at' }
              },
              contacts: { $sum: 1 }
            }
          },
          { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
        ])
      ]);

      // Create a map for easy lookup
      const conversationsMap = new Map();
      const messagesMap = new Map();
      const contactsMap = new Map();
      
      dailyActivity[0].forEach(item => {
        const dateKey = `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(2, '0')}`;
        conversationsMap.set(dateKey, item.conversations);
      });
      
      dailyActivity[1].forEach(item => {
        const dateKey = `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(2, '0')}`;
        messagesMap.set(dateKey, item.messages);
      });
      
      dailyActivity[2].forEach(item => {
        const dateKey = `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(2, '0')}`;
        contactsMap.set(dateKey, item.contacts);
      });

      // Generate 7 days of data
      const weeklyData = [];
      for (let i = 6; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        
        weeklyData.push({
          date: dateKey,
          conversations: conversationsMap.get(dateKey) || 0,
          messages: messagesMap.get(dateKey) || 0,
          contacts: contactsMap.get(dateKey) || 0
        });
      }

      res.json({
        success: true,
        data: {
          weekly_activity: weeklyData,
          week_totals: {
            conversations: weeklyData.reduce((sum, day) => sum + day.conversations, 0),
            messages: weeklyData.reduce((sum, day) => sum + day.messages, 0),
            contacts: weeklyData.reduce((sum, day) => sum + day.contacts, 0)
          }
        },
        message: 'Weekly activity summary retrieved successfully'
      });

    } catch (error) {
      console.error('❌ Failed to get weekly activity summary:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get weekly activity summary',
        error: error.message
      });
    }
  }

  // =============================
  // KEY PERFORMANCE INDICATORS
  // =============================

  async getKPIs(req, res) {
    try {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      // Growth metrics
      const contactsThisMonth = await SuperChatContact.countDocuments({
        created_at: { $gte: monthAgo }
      });
      
      const conversationsThisMonth = await SuperChatConversation.countDocuments({
        created_at: { $gte: monthAgo }
      });
      
      const messagesThisMonth = await SuperChatMessage.countDocuments({
        created_at: { $gte: monthAgo }
      });

      // Active conversations
      const activeConversations = await SuperChatConversation.countDocuments({
        last_message_at: { $gte: weekAgo }
      });
      
      const totalConversations = await SuperChatConversation.countDocuments();
      
      // Response rate (conversations with responses)
      const conversationsWithResponses = await SuperChatConversation.countDocuments({
        message_count: { $gt: 1 }
      });
      
      const responseRate = totalConversations > 0 ? 
        Math.round((conversationsWithResponses / totalConversations) * 100) : 0;

      // Customer satisfaction (based on conversation completion)
      const completedConversations = await SuperChatConversation.countDocuments({
        status: 'done'
      });
      
      const satisfactionScore = totalConversations > 0 ? 
        Math.round((completedConversations / totalConversations) * 100) : 0;

      res.json({
        success: true,
        data: {
          growth_kpis: {
            new_contacts_this_month: contactsThisMonth,
            new_conversations_this_month: conversationsThisMonth,
            messages_this_month: messagesThisMonth
          },
          engagement_kpis: {
            active_conversations: activeConversations,
            response_rate_percentage: responseRate,
            customer_satisfaction_score: satisfactionScore
          },
          operational_kpis: {
            total_conversations: totalConversations,
            conversations_with_responses: conversationsWithResponses,
            completed_conversations: completedConversations
          }
        },
        message: 'Key performance indicators retrieved successfully'
      });

    } catch (error) {
      console.error('❌ Failed to get KPIs:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get KPIs',
        error: error.message
      });
    }
  }

  // =============================
  // REAL-TIME ACTIVITY
  // =============================

  async getRealTimeActivity(req, res) {
    try {
      const last5Minutes = new Date(Date.now() - 5 * 60 * 1000);
      const lastHour = new Date(Date.now() - 60 * 60 * 1000);
      
      // Recent activity
      const recentMessages = await SuperChatMessage.countDocuments({
        created_at: { $gte: last5Minutes }
      });
      
      const messagesLastHour = await SuperChatMessage.countDocuments({
        created_at: { $gte: lastHour }
      });
      
      const newConversationsLastHour = await SuperChatConversation.countDocuments({
        created_at: { $gte: lastHour }
      });
      
      // Currently active (conversations with messages in last hour)
      const currentlyActive = await SuperChatConversation.countDocuments({
        last_message_at: { $gte: lastHour },
        status: 'open'
      });

      res.json({
        success: true,
        data: {
          real_time_metrics: {
            messages_last_5_minutes: recentMessages,
            messages_last_hour: messagesLastHour,
            new_conversations_last_hour: newConversationsLastHour,
            currently_active_conversations: currentlyActive
          },
          activity_level: recentMessages > 0 ? 'active' : messagesLastHour > 0 ? 'moderate' : 'quiet',
          last_updated: new Date().toISOString()
        },
        message: 'Real-time activity retrieved successfully'
      });

    } catch (error) {
      console.error('❌ Failed to get real-time activity:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get real-time activity',
        error: error.message
      });
    }
  }
}

module.exports = SuperChatTotalAnalyticsController;
