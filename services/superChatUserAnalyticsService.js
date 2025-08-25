// services/superChatUserAnalyticsService.js
const superChatService = require('./superChatService');

class SuperChatUserAnalyticsService {

  /**
   * Get comprehensive user activity analytics
   * Pulls data directly from SuperChat APIs and computes metrics
   */
  async getUserActivityAnalytics(userId = null, dateRange = '7d') {
    try {
      console.log('📊 Fetching user activity analytics...');
      
      // Get date range
      const { startDate, endDate } = this.getDateRange(dateRange);
      
      // Fetch all required data
      const [users, conversations, messages] = await Promise.all([
        this.fetchAllUsers(),
        this.fetchAllConversations(startDate, endDate),
        this.fetchAllMessages(startDate, endDate)
      ]);

      // Compute user metrics
      const userMetrics = await this.computeUserMetrics(users, conversations, messages, userId, startDate, endDate);
      
      // Get top performers
      const topPerformers = this.getTopPerformers(userMetrics);
      
      // Get activity trends
      const activityTrends = this.getActivityTrends(conversations, messages, startDate, endDate);
      
      // Get response time analytics
      const responseTimeAnalytics = this.getResponseTimeAnalytics(conversations, messages);
      
      // Get workload distribution
      const workloadDistribution = this.getWorkloadDistribution(userMetrics);
      
      // Get productivity metrics
      const productivityMetrics = this.getProductivityMetrics(userMetrics, startDate, endDate);

              return {
          success: true,
          data: {
            overview: {
              total_users: users.length,
              active_users: userMetrics.filter(u => u.total_conversations > 0).length,
              total_conversations: conversations.length,
              total_messages: messages.length,
              date_range: { start: startDate, end: endDate },
              note: "⚠️ Conversations are not assigned to users in SuperChat. Metrics are based on inbox associations and conversation status."
            },
            user_metrics: userMetrics,
            top_performers: topPerformers,
            activity_trends: activityTrends,
            response_time_analytics: responseTimeAnalytics,
            workload_distribution: workloadDistribution,
            productivity_metrics: productivityMetrics
          }
        };

    } catch (error) {
      console.error('❌ User analytics error:', error);
      return {
        success: false,
        error: error.message,
        data: this.getEmptyUserAnalytics()
      };
    }
  }

  /**
   * Fetch all users from SuperChat API
   */
  async fetchAllUsers() {
    try {
      const users = [];
      let after = null;
      let hasMore = true;

      while (hasMore) {
        const response = await superChatService.fetchUsers({ after, limit: 100 });
        if (response.results && response.results.length > 0) {
          users.push(...response.results);
          after = response.pagination?.next_cursor;
          hasMore = !!after;
        } else {
          hasMore = false;
        }
      }

      console.log(`✅ Fetched ${users.length} users from SuperChat API`);
      return users;

    } catch (error) {
      console.error('❌ Failed to fetch users:', error);
      return [];
    }
  }

  /**
   * Fetch all conversations from SuperChat API
   */
  async fetchAllConversations(startDate, endDate) {
    try {
      const conversations = [];
      let after = null;
      let hasMore = true;

      while (hasMore) {
        const response = await superChatService.fetchConversations({ after, limit: 100 });
        if (response.results && response.results.length > 0) {
          // Filter by date range if specified
          const filteredConversations = response.results.filter(conv => {
            const convDate = new Date(conv.created_at);
            return convDate >= startDate && convDate <= endDate;
          });
          conversations.push(...filteredConversations);
          
          after = response.pagination?.next_cursor;
          hasMore = !!after;
        } else {
          hasMore = false;
        }
      }

      console.log(`✅ Fetched ${conversations.length} conversations from SuperChat API`);
      return conversations;

    } catch (error) {
      console.error('❌ Failed to fetch conversations:', error);
      return [];
    }
  }

  /**
   * Fetch all messages from SuperChat API
   */
  async fetchAllMessages(startDate, endDate) {
    try {
      const messages = [];
      
      // Get conversations first to fetch their messages
      const conversations = await this.fetchAllConversations(startDate, endDate);
      
      // Fetch messages for each conversation
      for (const conv of conversations) {
        try {
          const convMessages = await superChatService.getConversation(conv.id);
          if (convMessages.messages && convMessages.messages.length > 0) {
            // Filter messages by date range
            const filteredMessages = convMessages.messages.filter(msg => {
              const msgDate = new Date(msg.created_at);
              return msgDate >= startDate && msgDate <= endDate;
            });
            messages.push(...filteredMessages.map(msg => ({
              ...msg,
              conversation_id: conv.id
            })));
          }
        } catch (error) {
          console.warn(`⚠️ Failed to fetch messages for conversation ${conv.id}:`, error.message);
        }
      }

      console.log(`✅ Fetched ${messages.length} messages from SuperChat API`);
      return messages;

    } catch (error) {
      console.error('❌ Failed to fetch messages:', error);
      return [];
    }
  }

  /**
   * Compute comprehensive metrics for each user
   */
  async computeUserMetrics(users, conversations, messages, userId = null, startDate, endDate) {
    const userMetrics = [];

    for (const user of users) {
      // Since conversations are not assigned to users, we'll calculate metrics differently
      // We'll look at conversations in inboxes that might be associated with users
      const userInboxConversations = conversations.filter(conv => {
        // Check if conversation is in an inbox that might be associated with this user
        // This is a fallback since SuperChat doesn't assign conversations to users
        return conv.inbox && (
          conv.inbox.name?.toLowerCase().includes(user.first_name?.toLowerCase() || '') ||
          conv.inbox.name?.toLowerCase().includes(user.last_name?.toLowerCase() || '')
        );
      });

      // For now, since we can't determine user-conversation relationships,
      // we'll provide baseline metrics and explain the limitation
      const metrics = {
        user_id: user.id,
        user_name: user.name || `${user.first_name || ''} ${user.last_name || ''}`.trim(),
        user_email: user.email,
        user_role: user.role || 'agent',
        total_conversations: userInboxConversations.length,
        active_conversations: userInboxConversations.filter(c => c.status === 'open').length,
        resolved_conversations: userInboxConversations.filter(c => c.status === 'done').length,
        total_messages_sent: 0, // Can't determine without user assignment
        total_messages_received: 0, // Can't determine without user assignment
        avg_response_time_minutes: 0, // Can't calculate without user assignment
        fastest_response_minutes: 0,
        slowest_response_minutes: 0,
        response_rate: 0, // Can't calculate without user assignment
        resolution_rate: userInboxConversations.length > 0 ? 
          Math.round((userInboxConversations.filter(c => c.status === 'done').length / userInboxConversations.length) * 100) : 0,
        avg_conversation_duration_hours: 0, // Can't calculate without timestamps
        workload_score: this.calculateWorkloadScore(userInboxConversations, []),
        productivity_score: this.calculateProductivityScore(userInboxConversations, [], { average: 0 }),
        last_activity: this.getLastActivity(userInboxConversations, []),
        performance_trend: this.getPerformanceTrend(userInboxConversations, startDate, endDate),
        note: "Conversations not assigned to users in SuperChat. Metrics based on inbox associations."
      };

      userMetrics.push(metrics);
    }

    // Filter by specific user if requested
    if (userId) {
      return userMetrics.filter(u => u.user_id === userId);
    }

    return userMetrics;
  }

  /**
   * Calculate response times for a user
   */
  calculateResponseTimes(conversations, messages, userId) {
    const responseTimes = [];

    for (const conv of conversations) {
      const convMessages = messages.filter(m => m.conversation_id === conv.id);
      const inboundMessages = convMessages.filter(m => m.direction === 'inbound');
      const outboundMessages = convMessages.filter(m => 
        m.direction === 'outbound' && m.sender?.id === userId
      );

      if (inboundMessages.length > 0 && outboundMessages.length > 0) {
        const firstInbound = new Date(Math.min(...inboundMessages.map(m => new Date(m.created_at))));
        const firstResponse = new Date(Math.min(...outboundMessages.map(m => new Date(m.created_at))));
        const responseTime = (firstResponse - firstInbound) / (1000 * 60); // minutes
        responseTimes.push(responseTime);
      }
    }

    if (responseTimes.length === 0) {
      return { average: 0, fastest: 0, slowest: 0 };
    }

    return {
      average: Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length),
      fastest: Math.round(Math.min(...responseTimes)),
      slowest: Math.round(Math.max(...responseTimes))
    };
  }

  /**
   * Calculate response rate
   */
  calculateResponseRate(conversations, inboundMessages, userMessages) {
    const conversationsWithInbound = conversations.filter(conv => 
      inboundMessages.some(msg => msg.conversation_id === conv.id)
    );
    
    if (conversationsWithInbound.length === 0) return 0;
    
    const respondedConversations = conversationsWithInbound.filter(conv => 
      userMessages.some(msg => msg.conversation_id === conv.id)
    );
    
    return Math.round((respondedConversations.length / conversationsWithInbound.length) * 100);
  }

  /**
   * Calculate resolution rate
   */
  calculateResolutionRate(conversations) {
    if (conversations.length === 0) return 0;
    
    // SuperChat uses 'done' status for resolved conversations, not 'resolved'
    const resolved = conversations.filter(c => c.status === 'done').length;
    return Math.round((resolved / conversations.length) * 100);
  }

  /**
   * Calculate average conversation duration
   */
  calculateAvgConversationDuration(conversations) {
    const completedConversations = conversations.filter(c => 
      c.status === 'resolved' && c.created_at && c.updated_at
    );

    if (completedConversations.length === 0) return 0;

    const totalDuration = completedConversations.reduce((total, conv) => {
      const start = new Date(conv.created_at);
      const end = new Date(conv.updated_at);
      return total + (end - start);
    }, 0);

    return Math.round(totalDuration / (1000 * 60 * 60 * completedConversations.length)); // hours
  }

  /**
   * Calculate workload score
   */
  calculateWorkloadScore(conversations, messages) {
    const activeConversations = conversations.filter(c => c.status === 'open').length;
    const totalConversations = conversations.length;
    
    // Since we can't determine message volume without user assignments,
    // we'll base workload on conversation handling
    const conversationScore = activeConversations * 3; // 3 points per active conversation
    const volumeScore = totalConversations * 1; // 1 point per total conversation
    
    return Math.round(conversationScore + volumeScore);
  }

  /**
   * Calculate productivity score
   */
  calculateProductivityScore(conversations, messages, responseTimes) {
    const resolutionRate = this.calculateResolutionRate(conversations);
    
    // Since we can't calculate response rate and response time without user assignments,
    // we'll base productivity mainly on resolution rate and conversation handling
    if (conversations.length === 0) {
      return 0; // No conversations to handle
    }
    
    // Base score on resolution rate and conversation volume
    const volumeScore = Math.min(conversations.length * 2, 30); // Max 30 points for volume
    const resolutionScore = resolutionRate * 0.7; // 70% weight on resolution rate
    
    return Math.round(Math.min(resolutionScore + volumeScore, 100));
  }

  /**
   * Get last activity timestamp
   */
  getLastActivity(conversations, messages) {
    const allTimestamps = [
      ...conversations.map(c => new Date(c.updated_at)),
      ...messages.map(m => new Date(m.created_at))
    ].filter(t => !isNaN(t));

    if (allTimestamps.length === 0) return null;
    
    return new Date(Math.max(...allTimestamps));
  }

  /**
   * Get performance trend over time
   */
  getPerformanceTrend(conversations, startDate, endDate) {
    const days = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
    const trend = [];

    for (let i = 0; i < Math.min(days, 7); i++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + i);
      
      const dayConversations = conversations.filter(c => {
        const convDate = new Date(c.created_at);
        return convDate.toDateString() === date.toDateString();
      });

      trend.push({
        date: date.toISOString().split('T')[0],
        conversations: dayConversations.length,
        resolved: dayConversations.filter(c => c.status === 'resolved').length
      });
    }

    return trend;
  }

  /**
   * Get top performers
   */
  getTopPerformers(userMetrics) {
    return userMetrics
      .filter(u => u.total_conversations > 0)
      .sort((a, b) => b.productivity_score - a.productivity_score)
      .slice(0, 10)
      .map((user, index) => ({
        rank: index + 1,
        user_id: user.user_id,
        user_name: user.user_name,
        productivity_score: user.productivity_score,
        total_conversations: user.total_conversations,
        resolution_rate: user.resolution_rate,
        avg_response_time_minutes: user.avg_response_time_minutes
      }));
  }

  /**
   * Get activity trends
   */
  getActivityTrends(conversations, messages, startDate, endDate) {
    const days = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
    const trends = [];

    for (let i = 0; i < Math.min(days, 7); i++) {
      const date = new Date(startDate);
      date.setDate(date.getDate() + i);
      
      const dayConversations = conversations.filter(c => {
        const convDate = new Date(c.created_at);
        return convDate.toDateString() === date.toDateString();
      });

      const dayMessages = messages.filter(m => {
        const msgDate = new Date(m.created_at);
        return msgDate.toDateString() === date.toDateString();
      });

      trends.push({
        date: date.toISOString().split('T')[0],
        conversations: dayConversations.length,
        messages: dayMessages.length,
        active_users: new Set(dayConversations.map(c => c.assigned_to?.id || c.user?.id)).size
      });
    }

    return trends;
  }

  /**
   * Get response time analytics
   */
  getResponseTimeAnalytics(conversations, messages) {
    const allResponseTimes = [];
    
    for (const conv of conversations) {
      const convMessages = messages.filter(m => m.conversation_id === conv.id);
      const inboundMessages = convMessages.filter(m => m.direction === 'inbound');
      const outboundMessages = convMessages.filter(m => m.direction === 'outbound');

      if (inboundMessages.length > 0 && outboundMessages.length > 0) {
        const firstInbound = new Date(Math.min(...inboundMessages.map(m => new Date(m.created_at))));
        const firstResponse = new Date(Math.min(...outboundMessages.map(m => new Date(m.created_at))));
        const responseTime = (firstResponse - firstInbound) / (1000 * 60); // minutes
        allResponseTimes.push(responseTime);
      }
    }

    if (allResponseTimes.length === 0) {
      return {
        average: 0,
        median: 0,
        fastest: 0,
        slowest: 0,
        distribution: []
      };
    }

    const sorted = allResponseTimes.sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    return {
      average: Math.round(allResponseTimes.reduce((a, b) => a + b, 0) / allResponseTimes.length),
      median: Math.round(median),
      fastest: Math.round(Math.min(...allResponseTimes)),
      slowest: Math.round(Math.max(...allResponseTimes)),
      distribution: this.getResponseTimeDistribution(allResponseTimes)
    };
  }

  /**
   * Get response time distribution
   */
  getResponseTimeDistribution(responseTimes) {
    const distribution = [
      { range: '0-5 min', count: 0 },
      { range: '5-15 min', count: 0 },
      { range: '15-30 min', count: 0 },
      { range: '30-60 min', count: 0 },
      { range: '1-2 hours', count: 0 },
      { range: '2+ hours', count: 0 }
    ];

    responseTimes.forEach(time => {
      if (time <= 5) distribution[0].count++;
      else if (time <= 15) distribution[1].count++;
      else if (time <= 30) distribution[2].count++;
      else if (time <= 60) distribution[3].count++;
      else if (time <= 120) distribution[4].count++;
      else distribution[5].count++;
    });

    return distribution;
  }

  /**
   * Get workload distribution
   */
  getWorkloadDistribution(userMetrics) {
    const distribution = [
      { level: 'Low', count: 0, users: [] },
      { level: 'Medium', count: 0, users: [] },
      { level: 'High', count: 0, users: [] },
      { level: 'Very High', count: 0, users: [] }
    ];

    userMetrics.forEach(user => {
      if (user.workload_score <= 10) {
        distribution[0].count++;
        distribution[0].users.push({ id: user.user_id, name: user.user_name, score: user.workload_score });
      } else if (user.workload_score <= 25) {
        distribution[1].count++;
        distribution[1].users.push({ id: user.user_id, name: user.user_name, score: user.workload_score });
      } else if (user.workload_score <= 50) {
        distribution[2].count++;
        distribution[2].users.push({ id: user.user_id, name: user.user_name, score: user.workload_score });
      } else {
        distribution[3].count++;
        distribution[3].users.push({ id: user.user_id, name: user.user_name, score: user.workload_score });
      }
    });

    return distribution;
  }

  /**
   * Get productivity metrics
   */
  getProductivityMetrics(userMetrics, startDate, endDate) {
    const activeUsers = userMetrics.filter(u => u.total_conversations > 0);
    
    if (activeUsers.length === 0) {
      return {
        avg_productivity: 0,
        productivity_trend: 'stable',
        improvement_areas: [],
        best_practices: []
      };
    }

    const avgProductivity = Math.round(
      activeUsers.reduce((sum, user) => sum + user.productivity_score, 0) / activeUsers.length
    );

    const productivityTrend = this.getProductivityTrend(activeUsers, startDate, endDate);
    const improvementAreas = this.getImprovementAreas(activeUsers);
    const bestPractices = this.getBestPractices(activeUsers);

    return {
      avg_productivity: avgProductivity,
      productivity_trend: productivityTrend,
      improvement_areas: improvementAreas,
      best_practices: bestPractices
    };
  }

  /**
   * Get productivity trend
   */
  getProductivityTrend(users, startDate, endDate) {
    // Simple trend calculation based on recent vs older performance
    const recentUsers = users.filter(u => u.last_activity && new Date(u.last_activity) > startDate);
    const olderUsers = users.filter(u => u.last_activity && new Date(u.last_activity) <= startDate);

    if (recentUsers.length === 0 || olderUsers.length === 0) return 'stable';

    const recentAvg = recentUsers.reduce((sum, u) => sum + u.productivity_score, 0) / recentUsers.length;
    const olderAvg = olderUsers.reduce((sum, u) => sum + u.productivity_score, 0) / olderUsers.length;

    if (recentAvg > olderAvg * 1.1) return 'improving';
    if (recentAvg < olderAvg * 0.9) return 'declining';
    return 'stable';
  }

  /**
   * Get improvement areas
   */
  getImprovementAreas(users) {
    const areas = [];
    
    const avgResponseTime = users.reduce((sum, u) => sum + u.avg_response_time_minutes, 0) / users.length;
    const avgResolutionRate = users.reduce((sum, u) => sum + u.resolution_rate, 0) / users.length;
    
    if (avgResponseTime > 60) areas.push('Response time optimization needed');
    if (avgResolutionRate < 70) areas.push('Conversation resolution improvement');
    
    const lowProductivityUsers = users.filter(u => u.productivity_score < 60);
    if (lowProductivityUsers.length > 0) {
      areas.push(`${lowProductivityUsers.length} users need performance coaching`);
    }
    
    return areas;
  }

  /**
   * Get best practices
   */
  getBestPractices(users) {
    const practices = [];
    
    const topUsers = users
      .sort((a, b) => b.productivity_score - a.productivity_score)
      .slice(0, 3);
    
    topUsers.forEach((user, index) => {
      practices.push(`${user.user_name} (${user.productivity_score}% productivity) - ${this.getUserStrengths(user)}`);
    });
    
    return practices;
  }

  /**
   * Get user strengths
   */
  getUserStrengths(user) {
    const strengths = [];
    
    if (user.response_rate > 90) strengths.push('excellent response rate');
    if (user.resolution_rate > 80) strengths.push('high resolution rate');
    if (user.avg_response_time_minutes < 30) strengths.push('fast response times');
    if (user.total_conversations > 50) strengths.push('handles high volume');
    
    return strengths.length > 0 ? strengths.join(', ') : 'consistent performance';
  }

  /**
   * Get date range from string
   */
  getDateRange(range) {
    const endDate = new Date();
    const startDate = new Date();
    
    switch (range) {
      case '1d':
        startDate.setDate(endDate.getDate() - 1);
        break;
      case '7d':
        startDate.setDate(endDate.getDate() - 7);
        break;
      case '30d':
        startDate.setDate(endDate.getDate() - 30);
        break;
      case '90d':
        startDate.setDate(endDate.getDate() - 90);
        break;
      default:
        startDate.setDate(endDate.getDate() - 7);
    }
    
    return { startDate, endDate };
  }

  /**
   * Get empty analytics structure
   */
  getEmptyUserAnalytics() {
    return {
      overview: {
        total_users: 0,
        active_users: 0,
        total_conversations: 0,
        total_messages: 0,
        date_range: { start: new Date(), end: new Date() }
      },
      user_metrics: [],
      top_performers: [],
      activity_trends: [],
      response_time_analytics: {
        average: 0,
        median: 0,
        fastest: 0,
        slowest: 0,
        distribution: []
      },
      workload_distribution: [],
      productivity_metrics: {
        avg_productivity: 0,
        productivity_trend: 'stable',
        improvement_areas: [],
        best_practices: []
      }
    };
  }

}

module.exports = new SuperChatUserAnalyticsService();
