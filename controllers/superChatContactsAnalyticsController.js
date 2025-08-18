const SuperChatContact = require('../models/SuperChatContact');

class SuperChatContactsAnalyticsController {
  
  // =============================
  // CONTACTS OVERVIEW ANALYTICS
  // =============================

  async getContactsOverview(req, res) {
    try {
      const totalContacts = await SuperChatContact.countDocuments();
      
      // Contacts created in last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const newContactsLast30Days = await SuperChatContact.countDocuments({
        created_at: { $gte: thirtyDaysAgo }
      });
      
      // Contacts created in last 7 days
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      const newContactsLast7Days = await SuperChatContact.countDocuments({
        created_at: { $gte: sevenDaysAgo }
      });
      
      // Contacts with email vs phone
      const contactsWithEmail = await SuperChatContact.countDocuments({
        email: { $exists: true, $ne: '' }
      });
      const contactsWithPhone = await SuperChatContact.countDocuments({
        phone: { $exists: true, $ne: '' }
      });
      
      // Contacts with recent activity (last 7 days)
      const activeContactsLast7Days = await SuperChatContact.countDocuments({
        last_activity_at: { $gte: sevenDaysAgo }
      });

      res.json({
        success: true,
        data: {
          total_contacts: totalContacts,
          new_contacts_last_30_days: newContactsLast30Days,
          new_contacts_last_7_days: newContactsLast7Days,
          contacts_with_email: contactsWithEmail,
          contacts_with_phone: contactsWithPhone,
          active_contacts_last_7_days: activeContactsLast7Days,
          email_percentage: totalContacts > 0 ? Math.round((contactsWithEmail / totalContacts) * 100) : 0,
          phone_percentage: totalContacts > 0 ? Math.round((contactsWithPhone / totalContacts) * 100) : 0
        },
        message: 'Contacts overview analytics retrieved successfully'
      });

    } catch (error) {
      console.error('❌ Failed to get contacts overview:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get contacts overview analytics',
        error: error.message
      });
    }
  }

  // =============================
  // CONTACTS GROWTH TRENDS
  // =============================

  async getContactsGrowthTrend(req, res) {
    try {
      const { days = 30 } = req.query;
      const daysNum = parseInt(days);
      
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - daysNum);
      
      // Daily contacts creation trend
      const dailyGrowth = await SuperChatContact.aggregate([
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
            count: { $sum: 1 }
          }
        },
        {
          $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 }
        }
      ]);

      // Format for frontend charts
      const formattedData = dailyGrowth.map(item => ({
        date: `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(2, '0')}`,
        count: item.count
      }));

      res.json({
        success: true,
        data: {
          period: `${daysNum} days`,
          daily_growth: formattedData,
          total_new_contacts: dailyGrowth.reduce((sum, item) => sum + item.count, 0)
        },
        message: 'Contacts growth trend retrieved successfully'
      });

    } catch (error) {
      console.error('❌ Failed to get contacts growth trend:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get contacts growth trend',
        error: error.message
      });
    }
  }

  // =============================
  // CONTACTS ENGAGEMENT METRICS
  // =============================

  async getContactsEngagement(req, res) {
    try {
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

      // Activity breakdown
      const activeLastWeek = await SuperChatContact.countDocuments({
        last_activity_at: { $gte: sevenDaysAgo }
      });
      
      const activeLastMonth = await SuperChatContact.countDocuments({
        last_activity_at: { $gte: thirtyDaysAgo }
      });
      
      const totalContacts = await SuperChatContact.countDocuments();
      const inactiveContacts = totalContacts - activeLastMonth;

      res.json({
        success: true,
        data: {
          engagement_breakdown: {
            active_last_week: activeLastWeek,
            active_last_month: activeLastMonth,
            inactive: inactiveContacts,
            total: totalContacts
          },
          engagement_percentages: {
            active_week_percentage: totalContacts > 0 ? Math.round((activeLastWeek / totalContacts) * 100) : 0,
            active_month_percentage: totalContacts > 0 ? Math.round((activeLastMonth / totalContacts) * 100) : 0,
            inactive_percentage: totalContacts > 0 ? Math.round((inactiveContacts / totalContacts) * 100) : 0
          }
        },
        message: 'Contacts engagement metrics retrieved successfully'
      });

    } catch (error) {
      console.error('❌ Failed to get contacts engagement:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get contacts engagement metrics',
        error: error.message
      });
    }
  }

  // =============================
  // TOP CONTACTS BY ACTIVITY
  // =============================

  async getTopActiveContacts(req, res) {
    try {
      const { limit = 10 } = req.query;
      const superChatService = require('../services/superChatService');
      
      console.log('🔍 Fetching contacts from SuperChat API...');
      
      // Get contacts directly from SuperChat API - just show what we have
      const contactsResponse = await superChatService.fetchContacts({ 
        limit: parseInt(limit) 
      });
      
      const allContacts = contactsResponse?.results || [];
      console.log(`📊 Found ${allContacts.length} contacts from SuperChat API`);
      
      // Format contacts with the data we have
      const formattedContacts = allContacts.map(contact => {
        // Extract contact name
        const firstName = contact.first_name || '';
        const lastName = contact.last_name || '';
        const name = `${firstName} ${lastName}`.trim() || 'Unknown Contact';
        
        // Extract contact handles (email, phone, live_chat, etc.)
        const handles = contact.handles || [];
        const emailHandle = handles.find(h => h.type === 'email');
        const phoneHandle = handles.find(h => h.type === 'phone');
        const liveChatHandle = handles.find(h => h.type === 'live_chat');
        
        // Use the best available identifier for name if no first/last name
        let displayName = name;
        if (displayName === 'Unknown Contact') {
          if (liveChatHandle?.value) {
            displayName = liveChatHandle.value;
          } else if (emailHandle?.value) {
            displayName = emailHandle.value.split('@')[0];
          } else if (phoneHandle?.value) {
            displayName = phoneHandle.value;
          }
        }
        
        return {
          id: contact.id,
          name: displayName,
          email: emailHandle?.value || 'No email',
          phone: phoneHandle?.value || 'No phone',
          last_activity: contact.updated_at || contact.created_at,
          days_since_activity: contact.updated_at ? 
            Math.floor((new Date() - new Date(contact.updated_at)) / (1000 * 60 * 60 * 24)) : 
            null,
          handles: handles.map(h => `${h.type}: ${h.value}`).join(', ') || 'No handles'
        };
      });

      // Sort by most recent update and return
      const topContacts = formattedContacts
        .sort((a, b) => {
          if (!a.last_activity) return 1;
          if (!b.last_activity) return -1;
          return new Date(b.last_activity) - new Date(a.last_activity);
        });

      console.log(`✅ Returning ${topContacts.length} contacts`);

      res.json({
        success: true,
        data: {
          top_contacts: topContacts,
          total_returned: topContacts.length
        },
        message: 'Top active contacts retrieved successfully'
      });

    } catch (error) {
      console.error('❌ Failed to get top active contacts:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get top active contacts',
        error: error.message
      });
    }
  }

  // =============================
  // CONTACTS BY CHANNEL/SOURCE
  // =============================

  async getContactsBySource(req, res) {
    try {
      // Group contacts by custom attributes that might indicate source
      const sourceBreakdown = await SuperChatContact.aggregate([
        {
          $group: {
            _id: '$custom_attributes.source',
            count: { $sum: 1 }
          }
        },
        {
          $sort: { count: -1 }
        }
      ]);

      // Also check by identifier pattern (email vs phone)
      const emailContacts = await SuperChatContact.countDocuments({
        identifier: { $regex: '@', $options: 'i' }
      });
      
      const phoneContacts = await SuperChatContact.countDocuments({
        identifier: { $regex: '^\\+?[0-9]', $options: 'i' }
      });

      const formattedSourceData = sourceBreakdown.map(item => ({
        source: item._id || 'Unknown',
        count: item.count
      }));

      res.json({
        success: true,
        data: {
          source_breakdown: formattedSourceData,
          identifier_types: {
            email_based: emailContacts,
            phone_based: phoneContacts
          }
        },
        message: 'Contacts by source retrieved successfully'
      });

    } catch (error) {
      console.error('❌ Failed to get contacts by source:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get contacts by source',
        error: error.message
      });
    }
  }
}

module.exports = SuperChatContactsAnalyticsController;
