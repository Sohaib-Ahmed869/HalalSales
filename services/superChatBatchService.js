const axios = require('axios');
const config = require('./superChatConfig');
const SuperChatContact = require('../models/SuperChatContact');
const SuperChatConversation = require('../models/SuperChatConversation');

class SuperChatBatchService {
  constructor() {
    this.apiConfig = {
      baseURL: config.api.baseUrl,
      timeout: config.api.timeoutMs || 30000,
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': config.api.apiKey
      }
    };
  }

  // =============================
  // API HELPER METHODS
  // =============================

  async makeApiCall(method, url, data = null, params = null) {
    try {
      const axiosConfig = {
        method,
        url: `${this.apiConfig.baseURL}${url}`,
        headers: this.apiConfig.headers,
        timeout: this.apiConfig.timeout
      };
      
      if (data) axiosConfig.data = data;
      if (params) axiosConfig.params = params;
      
      const response = await axios(axiosConfig);
      return response.data;
    } catch (error) {
      console.error(`❌ API call failed ${method.toUpperCase()} ${url}:`, error.response?.data || error.message);
      throw error;
    }
  }

  async fetchAllPaginated(endpoint, itemsPerPage = 100) {
    let allItems = [];
    let after = null;
    let hasMore = true;
    let page = 1;

    console.log(`🔄 Starting batch fetch from ${endpoint}...`);

    while (hasMore) {
      try {
        console.log(`📄 Fetching page ${page} (limit: ${itemsPerPage})...`);
        
        const params = { limit: itemsPerPage };
        if (after) params.after = after;

        const response = await this.makeApiCall('get', endpoint, null, params);
        
        const items = response.results || response.data || [];
        allItems = allItems.concat(items);
        
        console.log(`✅ Page ${page}: ${items.length} items fetched (total so far: ${allItems.length})`);
        
        // Check if there are more pages
        if (response.next_cursor) {
          after = response.next_cursor;
          hasMore = true;
        } else if (response.pagination && response.pagination.has_more) {
          after = response.pagination.next_cursor;
          hasMore = response.pagination.has_more;
        } else {
          hasMore = false;
        }
        
        page++;
        
        // Add delay to respect rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        console.error(`❌ Error fetching page ${page}:`, error.message);
        hasMore = false;
      }
    }

    console.log(`✅ Batch fetch completed: ${allItems.length} total items from ${endpoint}`);
    return allItems;
  }

  // =============================
  // CONTACTS BATCH PROCESSING
  // =============================

  async batchFetchContacts() {
    try {
      console.log('🚀 Starting contacts batch processing...');
      
      const contacts = await this.fetchAllPaginated('/contacts');
      
      console.log(`💾 Storing ${contacts.length} contacts in MongoDB...`);
      
      let stored = 0;
      let updated = 0;
      
      for (const contact of contacts) {
        try {
          const contactDoc = {
            contact_id: contact.id,
            first_name: contact.first_name || '',
            last_name: contact.last_name || '',
            email: contact.email || '',
            phone: contact.phone || '',
            avatar: contact.avatar || '',
            custom_attributes: contact.custom_attributes || {},
            additional_attributes: contact.additional_attributes || {},
            identifier: contact.identifier || '',
            created_at: contact.created_at || new Date(),
            updated_at: new Date(),
            last_activity_at: contact.last_activity_at,
            metadata: {
              batch_sync: true,
              synced_at: new Date(),
              original_data: contact
            }
          };

          const result = await SuperChatContact.findOneAndUpdate(
            { contact_id: contact.id },
            contactDoc,
            { upsert: true, new: true }
          );

          if (result.isNew) {
            stored++;
          } else {
            updated++;
          }

        } catch (error) {
          console.error(`❌ Error storing contact ${contact.id}:`, error.message);
        }
      }

      console.log(`✅ Contacts batch processing completed:`);
      console.log(`   📊 Total fetched: ${contacts.length}`);
      console.log(`   🆕 New contacts stored: ${stored}`);
      console.log(`   🔄 Existing contacts updated: ${updated}`);
      
      return {
        total_fetched: contacts.length,
        new_stored: stored,
        updated: updated,
        success: true
      };

    } catch (error) {
      console.error('❌ Contacts batch processing failed:', error.message);
      throw error;
    }
  }

  // =============================
  // CONVERSATIONS BATCH PROCESSING
  // =============================

  async batchFetchConversations() {
    try {
      console.log('🚀 Starting conversations batch processing...');
      
      const conversations = await this.fetchAllPaginated('/conversations');
      
      console.log(`💾 Storing ${conversations.length} conversations in MongoDB...`);
      
      let stored = 0;
      let updated = 0;
      
      for (const conversation of conversations) {
        try {
          const conversationDoc = {
            conversation_id: conversation.id,
            status: conversation.status || 'open',
            channel: conversation.channel || {},
            inbox: conversation.inbox || {},
            contact: conversation.contact || {},
            assigned_users: conversation.assigned_users || [],
            labels: conversation.labels || [],
            snoozed_until: conversation.snoozed_until,
            time_window: conversation.time_window || {},
            priority: conversation.priority || 'medium',
            message_count: conversation.message_count || 0,
            unread_count: conversation.unread_count || 0,
            last_message: conversation.last_message || null,
            last_message_at: conversation.last_message_at || new Date(),
            created_at: conversation.created_at || new Date(),
            updated_at: new Date(),
            metadata: {
              batch_sync: true,
              synced_at: new Date(),
              original_data: conversation
            }
          };

          const result = await SuperChatConversation.findOneAndUpdate(
            { conversation_id: conversation.id },
            conversationDoc,
            { upsert: true, new: true }
          );

          if (result.isNew) {
            stored++;
          } else {
            updated++;
          }

        } catch (error) {
          console.error(`❌ Error storing conversation ${conversation.id}:`, error.message);
        }
      }

      console.log(`✅ Conversations batch processing completed:`);
      console.log(`   📊 Total fetched: ${conversations.length}`);
      console.log(`   🆕 New conversations stored: ${stored}`);
      console.log(`   🔄 Existing conversations updated: ${updated}`);
      
      return {
        total_fetched: conversations.length,
        new_stored: stored,
        updated: updated,
        success: true
      };

    } catch (error) {
      console.error('❌ Conversations batch processing failed:', error.message);
      throw error;
    }
  }

  // =============================
  // FULL BATCH SYNC
  // =============================

  async runFullBatchSync() {
    try {
      console.log('🚀 Starting full batch sync (contacts + conversations)...');
      const startTime = new Date();

      const contactsResult = await this.batchFetchContacts();
      const conversationsResult = await this.batchFetchConversations();

      const endTime = new Date();
      const duration = Math.round((endTime - startTime) / 1000);

      const summary = {
        started_at: startTime,
        completed_at: endTime,
        duration_seconds: duration,
        contacts: contactsResult,
        conversations: conversationsResult,
        success: true
      };

      console.log(`🎉 Full batch sync completed in ${duration} seconds!`);
      console.log('📊 Summary:', JSON.stringify(summary, null, 2));

      return summary;

    } catch (error) {
      console.error('❌ Full batch sync failed:', error.message);
      throw error;
    }
  }

  // =============================
  // GET STORED DATA
  // =============================

  async getStoredContacts(limit = 100, offset = 0, search = '') {
    try {
      let query = {};
      
      if (search) {
        query.$or = [
          { first_name: { $regex: search, $options: 'i' } },
          { last_name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } },
          { phone: { $regex: search, $options: 'i' } }
        ];
      }

      const contacts = await SuperChatContact.find(query)
        .sort({ created_at: -1 })
        .skip(offset)
        .limit(limit);

      const total = await SuperChatContact.countDocuments(query);

      return {
        results: contacts,
        total,
        pagination: {
          limit,
          offset,
          has_more: offset + contacts.length < total
        }
      };

    } catch (error) {
      console.error('❌ Error getting stored contacts:', error.message);
      throw error;
    }
  }

  async getStoredConversations(limit = 100, offset = 0, status = '', search = '') {
    try {
      let query = {};
      
      if (status) {
        query.status = status;
      }
      
      if (search) {
        query.$or = [
          { 'contact.first_name': { $regex: search, $options: 'i' } },
          { 'contact.last_name': { $regex: search, $options: 'i' } },
          { 'contact.email': { $regex: search, $options: 'i' } }
        ];
      }

      const conversations = await SuperChatConversation.find(query)
        .sort({ last_message_at: -1 })
        .skip(offset)
        .limit(limit);

      const total = await SuperChatConversation.countDocuments(query);

      return {
        results: conversations,
        total,
        pagination: {
          limit,
          offset,
          has_more: offset + conversations.length < total
        }
      };

    } catch (error) {
      console.error('❌ Error getting stored conversations:', error.message);
      throw error;
    }
  }

  async getStoredDataStats() {
    try {
      const contactsCount = await SuperChatContact.countDocuments();
      const conversationsCount = await SuperChatConversation.countDocuments();
      const openConversations = await SuperChatConversation.countDocuments({ status: 'open' });
      const doneConversations = await SuperChatConversation.countDocuments({ status: 'done' });

      return {
        contacts: {
          total: contactsCount
        },
        conversations: {
          total: conversationsCount,
          open: openConversations,
          done: doneConversations,
          snoozed: conversationsCount - openConversations - doneConversations
        }
      };

    } catch (error) {
      console.error('❌ Error getting stored data stats:', error.message);
      throw error;
    }
  }
}

module.exports = SuperChatBatchService;
