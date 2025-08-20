# SuperChat User Analytics System

## 🎯 Overview

The SuperChat User Analytics System provides comprehensive performance metrics for sales managers and agents by pulling data directly from SuperChat APIs. This system **does not rely on webhooks** - instead, it fetches all data through direct API calls to ensure complete coverage.

## 🚀 Key Features

- **No Webhook Dependency**: Pulls data directly from SuperChat APIs
- **Real-time Data**: Fetches fresh data on every request
- **Comprehensive Metrics**: Covers all aspects of user performance
- **Performance Insights**: Provides actionable recommendations
- **Team Comparison**: Leaderboards and performance rankings
- **Trend Analysis**: Historical performance tracking

## 📊 Available Endpoints

### 1. User Overview
```
GET /api/super-chat-user-analytics/overview?dateRange=7d
```
**Purpose**: Get comprehensive analytics for all users
**Query Parameters**:
- `dateRange`: Time period (1d, 7d, 30d, 90d)

**Response Structure**:
```json
{
  "success": true,
  "data": {
    "overview": {
      "total_users": 15,
      "active_users": 12,
      "total_conversations": 150,
      "total_messages": 450
    },
    "user_metrics": [...],
    "top_performers": [...],
    "activity_trends": [...],
    "response_time_analytics": {...},
    "workload_distribution": [...],
    "productivity_metrics": {...}
  }
}
```

### 2. Individual User Analytics
```
GET /api/super-chat-user-analytics/user/:userId?dateRange=7d
```
**Purpose**: Get detailed analytics for a specific user
**Path Parameters**:
- `userId`: SuperChat user ID

### 3. Top Performers Leaderboard
```
GET /api/super-chat-user-analytics/top-performers?dateRange=7d&limit=10
```
**Purpose**: Get ranked list of top-performing users
**Query Parameters**:
- `dateRange`: Time period
- `limit`: Number of users to return (default: 10)

### 4. Response Time Analytics
```
GET /api/super-chat-user-analytics/response-times?dateRange=7d
```
**Purpose**: Get comprehensive response time metrics for all users

### 5. Workload Distribution
```
GET /api/super-chat-user-analytics/workload?dateRange=7d
```
**Purpose**: Analyze how workload is distributed across the team

### 6. Productivity Metrics
```
GET /api/super-chat-user-analytics/productivity?dateRange=7d
```
**Purpose**: Get productivity scores and insights for all users

### 7. Activity Trends
```
GET /api/super-chat-user-analytics/trends?dateRange=7d
```
**Purpose**: Track activity patterns over time

### 8. Performance Comparison
```
GET /api/super-chat-user-analytics/performance-comparison?dateRange=7d&metric=productivity_score
```
**Purpose**: Compare users based on specific metrics
**Query Parameters**:
- `metric`: Metric to compare (productivity_score, resolution_rate, response_rate, etc.)

### 9. Improvement Recommendations
```
GET /api/super-chat-user-analytics/improvements?dateRange=7d
```
**Purpose**: Get actionable insights for team improvement

## 🔍 Metrics Calculated

### User Performance Metrics
- **Total Conversations**: Number of conversations assigned to user
- **Active Conversations**: Currently open conversations
- **Resolved Conversations**: Successfully closed conversations
- **Total Messages Sent**: Outbound messages from user
- **Total Messages Received**: Inbound messages to user's conversations
- **Average Response Time**: Time to first response (minutes)
- **Response Rate**: Percentage of conversations with responses
- **Resolution Rate**: Percentage of conversations resolved
- **Workload Score**: Combined metric of active conversations and message volume
- **Productivity Score**: Overall performance rating (0-100)

### Team Analytics
- **Top Performers**: Ranked list by productivity score
- **Response Time Distribution**: Breakdown by time ranges
- **Workload Distribution**: Low, Medium, High, Very High categories
- **Activity Trends**: Daily conversation and message patterns
- **Performance Comparison**: User rankings by various metrics
- **Improvement Areas**: Identified coaching opportunities

## 📈 Data Sources

The system pulls data from these SuperChat API endpoints:

1. **`/users`**: Get all team members
2. **`/conversations`**: Get all conversations with pagination
3. **`/conversations/{id}`**: Get detailed conversation data including messages

## ⚡ Performance Considerations

- **Pagination Handling**: Automatically fetches all pages using cursor-based pagination
- **Date Filtering**: Filters data by specified date range to reduce API calls
- **Caching**: 5-minute cache for repeated requests
- **Parallel Processing**: Fetches users, conversations, and messages concurrently

## 🎨 Frontend Integration

### Example Dashboard Component
```javascript
// React component example
const UserAnalyticsDashboard = () => {
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchAnalytics = async () => {
      try {
        const response = await fetch('/api/super-chat-user-analytics/overview?dateRange=7d', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await response.json();
        setAnalytics(data.data);
      } catch (error) {
        console.error('Failed to fetch analytics:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchAnalytics();
  }, []);

  if (loading) return <div>Loading analytics...</div>;

  return (
    <div className="analytics-dashboard">
      <div className="overview-cards">
        <div className="card">
          <h3>Total Users</h3>
          <p>{analytics.overview.total_users}</p>
        </div>
        <div className="card">
          <h3>Active Users</h3>
          <p>{analytics.overview.active_users}</p>
        </div>
        <div className="card">
          <h3>Total Conversations</h3>
          <p>{analytics.overview.total_conversations}</p>
        </div>
      </div>
      
      <div className="top-performers">
        <h3>Top Performers</h3>
        {analytics.top_performers.map((user, index) => (
          <div key={user.user_id} className="performer">
            <span className="rank">#{index + 1}</span>
            <span className="name">{user.user_name}</span>
            <span className="score">{user.productivity_score}%</span>
          </div>
        ))}
      </div>
    </div>
  );
};
```

### Example API Calls
```javascript
// Get user overview
const overview = await fetch('/api/super-chat-user-analytics/overview?dateRange=7d');

// Get specific user analytics
const userAnalytics = await fetch('/api/super-chat-user-analytics/user/user123?dateRange=30d');

// Get top performers
const topPerformers = await fetch('/api/super-chat-user-analytics/top-performers?limit=5');

// Get productivity insights
const productivity = await fetch('/api/super-chat-user-analytics/productivity?dateRange=7d');
```

## 🔧 Configuration

### Environment Variables
```bash
SUPER_CHAT_API_KEY=your_superchat_api_key
SUPER_CHAT_BASE_URL=https://api.superchat.com/v1.0
```

### Authentication
All endpoints require authentication with role-based access:
- **Admin**: Full access to all endpoints
- **Sales Manager**: Access to all analytics endpoints
- **Sales Agent**: Limited access (can view own metrics)

## 📊 Sample Response Data

### User Metrics Example
```json
{
  "user_id": "user_123",
  "user_name": "John Doe",
  "user_email": "john@company.com",
  "user_role": "sales_agent",
  "total_conversations": 45,
  "active_conversations": 8,
  "resolved_conversations": 37,
  "total_messages_sent": 120,
  "total_messages_received": 95,
  "avg_response_time_minutes": 15,
  "fastest_response_minutes": 2,
  "slowest_response_minutes": 45,
  "response_rate": 95,
  "resolution_rate": 82,
  "avg_conversation_duration_hours": 2,
  "workload_score": 28,
  "productivity_score": 87,
  "last_activity": "2024-01-15T10:30:00Z",
  "performance_trend": [...]
}
```

### Top Performers Example
```json
{
  "rank": 1,
  "user_id": "user_456",
  "user_name": "Jane Smith",
  "productivity_score": 94,
  "total_conversations": 67,
  "resolution_rate": 91,
  "avg_response_time_minutes": 8
}
```

## 🚨 Error Handling

The system provides comprehensive error handling:

```json
{
  "success": false,
  "message": "Failed to retrieve user analytics",
  "error": "API rate limit exceeded",
  "data": {
    // Empty data structure for graceful degradation
  }
}
```

## 🔄 Data Refresh

- **Real-time**: Data is fetched fresh on every request
- **No Caching**: Ensures most up-to-date information
- **API Limits**: Respects SuperChat API rate limits
- **Fallback**: Provides empty data structures on errors

## 📱 Mobile Considerations

- **Responsive Design**: All endpoints return mobile-friendly data structures
- **Optimized Payloads**: Minimal data transfer for mobile devices
- **Progressive Loading**: Support for pagination and lazy loading

## 🎯 Best Practices

1. **Date Range Selection**: Use appropriate date ranges (7d for weekly, 30d for monthly)
2. **Error Handling**: Always check `success` field before using data
3. **Loading States**: Show loading indicators during API calls
4. **Caching**: Implement client-side caching for frequently accessed data
5. **Real-time Updates**: Refresh data periodically for live dashboards

## 🔍 Troubleshooting

### Common Issues

1. **401 Unauthorized**: Check authentication token and user role
2. **Empty Data**: Verify SuperChat API key and permissions
3. **Slow Response**: Large date ranges may take longer to process
4. **API Errors**: Check SuperChat API status and rate limits

### Debug Information
All responses include:
- `data_source`: Indicates data comes from SuperChat API
- `timestamp`: When the data was fetched
- `message`: Human-readable status message

## 🚀 Future Enhancements

- **Real-time Updates**: WebSocket integration for live data
- **Advanced Filtering**: More granular date and user filters
- **Export Functionality**: CSV/PDF export of analytics data
- **Custom Metrics**: User-defined performance indicators
- **Integration APIs**: Connect with other business systems

---

## 📞 Support

For questions or issues with the User Analytics System:
1. Check the SuperChat API documentation
2. Verify your API key and permissions
3. Review the error messages in the response
4. Check server logs for detailed error information

The system is designed to be robust and provide actionable insights for sales team management without relying on webhook infrastructure.
