// controllers/superChatUserAnalytics.controller.js
const superChatUserAnalyticsService = require('../services/superChatUserAnalyticsService');

const superChatUserAnalyticsController = {
  /**
   * Get comprehensive user activity analytics for all users
   * GET /api/super-chat-user-analytics/overview
   */
  getUserOverview: async (req, res) => {
    try {
      const { dateRange = '7d' } = req.query;
      
      const result = await superChatUserAnalyticsService.getUserActivityAnalytics(null, dateRange);
      
      res.json({
        success: result.success,
        data: result.data,
        message: result.success 
          ? 'User analytics retrieved successfully'
          : `Analytics error: ${result.error}`,
        data_source: 'superchat_api',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('User overview error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve user analytics',
        error: error.message
      });
    }
  },

  /**
   * Get analytics for a specific user
   * GET /api/super-chat-user-analytics/user/:userId
   */
  getUserAnalytics: async (req, res) => {
    try {
      const { userId } = req.params;
      const { dateRange = '7d' } = req.query;
      
      const result = await superChatUserAnalyticsService.getUserActivityAnalytics(userId, dateRange);
      
      if (!result.success) {
        return res.status(404).json({
          success: false,
          message: 'User not found or analytics unavailable',
          error: result.error
        });
      }
      
      res.json({
        success: true,
        data: result.data,
        message: 'User analytics retrieved successfully',
        data_source: 'superchat_api',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('User analytics error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve user analytics',
        error: error.message
      });
    }
  },

  /**
   * Get top performers leaderboard
   * GET /api/super-chat-user-analytics/top-performers
   */
  getTopPerformers: async (req, res) => {
    try {
      const { dateRange = '7d', limit = 10 } = req.query;
      
      const result = await superChatUserAnalyticsService.getUserActivityAnalytics(null, dateRange);
      
      if (!result.success) {
        return res.status(500).json({
          success: false,
          message: 'Failed to retrieve top performers',
          error: result.error
        });
      }
      
      const topPerformers = result.data.top_performers.slice(0, parseInt(limit));
      
      res.json({
        success: true,
        data: {
          top_performers: topPerformers,
          total_users: result.data.overview.total_users,
          date_range: result.data.overview.date_range
        },
        message: `Top ${topPerformers.length} performers retrieved successfully`,
        data_source: 'superchat_api',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('Top performers error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve top performers',
        error: error.message
      });
    }
  },

  /**
   * Get response time analytics for all users
   * GET /api/super-chat-user-analytics/response-times
   */
  getResponseTimeAnalytics: async (req, res) => {
    try {
      const { dateRange = '7d' } = req.query;
      
      const result = await superChatUserAnalyticsService.getUserActivityAnalytics(null, dateRange);
      
      if (!result.success) {
        return res.status(500).json({
          success: false,
          message: 'Failed to retrieve response time analytics',
          error: result.error
        });
      }
      
      res.json({
        success: true,
        data: {
          response_time_analytics: result.data.response_time_analytics,
          user_breakdown: result.data.user_metrics.map(user => ({
            user_id: user.user_id,
            user_name: user.user_name,
            avg_response_time_minutes: user.avg_response_time_minutes,
            fastest_response_minutes: user.fastest_response_minutes,
            slowest_response_minutes: user.slowest_response_minutes
          }))
        },
        message: 'Response time analytics retrieved successfully',
        data_source: 'superchat_api',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('Response time analytics error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve response time analytics',
        error: error.message
      });
    }
  },

  /**
   * Get workload distribution analytics
   * GET /api/super-chat-user-analytics/workload
   */
  getWorkloadAnalytics: async (req, res) => {
    try {
      const { dateRange = '7d' } = req.query;
      
      const result = await superChatUserAnalyticsService.getUserActivityAnalytics(null, dateRange);
      
      if (!result.success) {
        return res.status(500).json({
          success: false,
          message: 'Failed to retrieve workload analytics',
          error: result.error
        });
      }
      
      res.json({
        success: true,
        data: {
          workload_distribution: result.data.workload_distribution,
          overview: {
            total_users: result.data.overview.total_users,
            active_users: result.data.overview.active_users,
            avg_workload_score: Math.round(
              result.data.user_metrics.reduce((sum, user) => sum + user.workload_score, 0) / 
              result.data.user_metrics.length
            )
          }
        },
        message: 'Workload analytics retrieved successfully',
        data_source: 'superchat_api',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('Workload analytics error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve workload analytics',
        error: error.message
      });
    }
  },

  /**
   * Get productivity metrics and insights
   * GET /api/super-chat-user-analytics/productivity
   */
  getProductivityAnalytics: async (req, res) => {
    try {
      const { dateRange = '7d' } = req.query;
      
      const result = await superChatUserAnalyticsService.getUserActivityAnalytics(null, dateRange);
      
      if (!result.success) {
        return res.status(500).json({
          success: false,
          message: 'Failed to retrieve productivity analytics',
          error: result.error
        });
      }
      
      res.json({
        success: true,
        data: {
          productivity_metrics: result.data.productivity_metrics,
          user_productivity: result.data.user_metrics.map(user => ({
            user_id: user.user_id,
            user_name: user.user_name,
            productivity_score: user.productivity_score,
            resolution_rate: user.resolution_rate,
            response_rate: user.response_rate,
            avg_response_time_minutes: user.avg_response_time_minutes
          }))
        },
        message: 'Productivity analytics retrieved successfully',
        data_source: 'superchat_api',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('Productivity analytics error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve productivity analytics',
        error: error.message
      });
    }
  },

  /**
   * Get activity trends over time
   * GET /api/super-chat-user-analytics/trends
   */
  getActivityTrends: async (req, res) => {
    try {
      const { dateRange = '7d' } = req.query;
      
      const result = await superChatUserAnalyticsService.getUserActivityAnalytics(null, dateRange);
      
      if (!result.success) {
        return res.status(500).json({
          success: false,
          message: 'Failed to retrieve activity trends',
          error: result.error
        });
      }
      
      res.json({
        success: true,
        data: {
          activity_trends: result.data.activity_trends,
          response_time_analytics: result.data.response_time_analytics,
          overview: {
            total_conversations: result.data.overview.total_conversations,
            total_messages: result.data.overview.total_messages,
            active_users: result.data.overview.active_users
          }
        },
        message: 'Activity trends retrieved successfully',
        data_source: 'superchat_api',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('Activity trends error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve activity trends',
        error: error.message
      });
    }
  },

  /**
   * Get detailed user performance comparison
   * GET /api/super-chat-user-analytics/performance-comparison
   */
  getPerformanceComparison: async (req, res) => {
    try {
      const { dateRange = '7d', metric = 'productivity_score' } = req.query;
      
      const result = await superChatUserAnalyticsService.getUserActivityAnalytics(null, dateRange);
      
      if (!result.success) {
        return res.status(500).json({
          success: false,
          message: 'Failed to retrieve performance comparison',
          error: result.error
        });
      }
      
      // Sort users by the specified metric
      const sortedUsers = result.data.user_metrics
        .filter(user => user[metric] !== undefined)
        .sort((a, b) => b[metric] - a[metric])
        .map((user, index) => ({
          rank: index + 1,
          user_id: user.user_id,
          user_name: user.user_name,
          [metric]: user[metric],
          total_conversations: user.total_conversations,
          resolution_rate: user.resolution_rate,
          response_rate: user.response_rate
        }));
      
      res.json({
        success: true,
        data: {
          comparison_metric: metric,
          user_rankings: sortedUsers,
          metric_summary: {
            highest: sortedUsers[0]?.[metric] || 0,
            lowest: sortedUsers[sortedUsers.length - 1]?.[metric] || 0,
            average: Math.round(
              sortedUsers.reduce((sum, user) => sum + user[metric], 0) / sortedUsers.length
            )
          }
        },
        message: 'Performance comparison retrieved successfully',
        data_source: 'superchat_api',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('Performance comparison error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve performance comparison',
        error: error.message
      });
    }
  },

  /**
   * Get user improvement recommendations
   * GET /api/super-chat-user-analytics/improvements
   */
  getImprovementRecommendations: async (req, res) => {
    try {
      const { dateRange = '7d' } = req.query;
      
      const result = await superChatUserAnalyticsService.getUserActivityAnalytics(null, dateRange);
      
      if (!result.success) {
        return res.status(500).json({
          success: false,
          message: 'Failed to retrieve improvement recommendations',
          error: result.error
        });
      }
      
      const recommendations = {
        improvement_areas: result.data.productivity_metrics.improvement_areas,
        best_practices: result.data.productivity_metrics.best_practices,
        low_performers: result.data.user_metrics
          .filter(user => user.productivity_score < 60)
          .map(user => ({
            user_id: user.user_id,
            user_name: user.user_name,
            productivity_score: user.productivity_score,
            areas_for_improvement: this.getUserImprovementAreas(user)
          })),
        coaching_opportunities: this.identifyCoachingOpportunities(result.data.user_metrics)
      };
      
      res.json({
        success: true,
        data: recommendations,
        message: 'Improvement recommendations retrieved successfully',
        data_source: 'superchat_api',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('Improvement recommendations error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to retrieve improvement recommendations',
        error: error.message
      });
    }
  },

  /**
   * Get user improvement areas for a specific user
   */
  getUserImprovementAreas(user) {
    const areas = [];
    
    if (user.response_rate < 80) {
      areas.push('Improve response rate - currently at ' + user.response_rate + '%');
    }
    if (user.resolution_rate < 70) {
      areas.push('Increase conversation resolution rate - currently at ' + user.resolution_rate + '%');
    }
    if (user.avg_response_time_minutes > 60) {
      areas.push('Reduce average response time - currently ' + user.avg_response_time_minutes + ' minutes');
    }
    if (user.total_conversations < 10) {
      areas.push('Increase conversation volume - currently handling ' + user.total_conversations + ' conversations');
    }
    
    return areas.length > 0 ? areas : ['No specific areas identified - maintain current performance'];
  },

  /**
   * Identify coaching opportunities across the team
   */
  identifyCoachingOpportunities(userMetrics) {
    const opportunities = [];
    
    // Find users who need response time coaching
    const slowResponders = userMetrics.filter(u => u.avg_response_time_minutes > 60);
    if (slowResponders.length > 0) {
      opportunities.push({
        type: 'response_time_coaching',
        users_count: slowResponders.length,
        description: `${slowResponders.length} users have average response times over 60 minutes`,
        users: slowResponders.map(u => ({ id: u.user_id, name: u.user_name }))
      });
    }
    
    // Find users who need resolution rate coaching
    const lowResolvers = userMetrics.filter(u => u.resolution_rate < 60);
    if (lowResolvers.length > 0) {
      opportunities.push({
        type: 'resolution_rate_coaching',
        users_count: lowResolvers.length,
        description: `${lowResolvers.length} users have resolution rates below 60%`,
        users: lowResolvers.map(u => ({ id: u.user_id, name: u.user_name }))
      });
    }
    
    // Find users who need volume coaching
    const lowVolume = userMetrics.filter(u => u.total_conversations < 5);
    if (lowVolume.length > 0) {
      opportunities.push({
        type: 'volume_coaching',
        users_count: lowVolume.length,
        description: `${lowVolume.length} users are handling very few conversations`,
        users: lowVolume.map(u => ({ id: u.user_id, name: u.user_name }))
      });
    }
    
    return opportunities;
  }
};

module.exports = superChatUserAnalyticsController;
