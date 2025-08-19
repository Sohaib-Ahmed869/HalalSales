// services/superChatFullSyncService.js
const axios = require('axios');
const config = require('./superChatConfig');
const SuperChatContact = require('../models/SuperChatContact');
const SuperChatConversation = require('../models/SuperChatConversation');
const SuperChatMessage = require('../models/SuperChatMessage');
const SuperChatSync = require('../models/SuperChatSync');

class SuperChatFullSyncService {
  constructor() {
    this.apiKey = config.api.apiKey;
    this.baseUrl = config.api.baseUrl;
    this.batchSize = 100; // SuperChat API limit
    this.delayBetweenRequests = 100; // 100ms delay to avoid rate limits
  }

  /**
   * Create API client with proper headers
   */
  createApiClient() {
    return axios.create({
      baseURL: this.baseUrl,
      timeout: 30000, // 30 second timeout
      headers: {
        'X-API-KEY': this.apiKey,
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Fetch all data from a paginated SuperChat endpoint
   */
  async fetchAllDataPaginated(endpoint, dataType) {
    const api = this.createApiClient();
    let allResults = [];
    let nextCursor = null;
    let pageCount = 0;
    let apiCallCount = 0;

    console.log(`🔄 Starting full sync for ${dataType} from ${endpoint}`);

    // Update sync status to in_progress
    await this.updateSyncStatus(dataType, 'in_progress', {
      startTime: new Date(),
      apiCallCount: 0
    });

    try {
      do {
        pageCount++;
        apiCallCount++;

        const params = {
          limit: this.batchSize
        };

        if (nextCursor) {
          params.after = nextCursor;
        }

        console.log(`  📄 Page ${pageCount}: Fetching ${dataType}...`);

        const response = await api.get(endpoint, { params });
        
        if (response.data?.results && Array.isArray(response.data.results)) {
          allResults = allResults.concat(response.data.results);
          console.log(`    ✅ Got ${response.data.results.length} results (Total: ${allResults.length})`);
        }

        // Get next cursor for pagination
        nextCursor = response.data?.pagination?.next_cursor || null;

        // Update progress
        if (pageCount % 10 === 0) {
          await this.updateSyncStatus(dataType, 'in_progress', {
            pagesProcessed: pageCount,
            totalRecords: allResults.length,
            apiCallCount
          });
        }

        // Rate limiting delay
        if (nextCursor && this.delayBetweenRequests > 0) {
          await new Promise(resolve => setTimeout(resolve, this.delayBetweenRequests));
        }

      } while (nextCursor);

      console.log(`✅ Completed sync for ${dataType}: ${allResults.length} records from ${pageCount} pages`);
      return {
        success: true,
        data: allResults,
        totalPages: pageCount,
        totalRecords: allResults.length,
        apiCallCount
      };

    } catch (error) {
      console.error(`❌ Error syncing ${dataType}:`, error.message);
      await this.updateSyncStatus(dataType, 'failed', {
        errorMessage: error.message
      });
      
      return {
        success: false,
        error: error.message,
        data: allResults, // Return partial data
        totalPages: pageCount,
        totalRecords: allResults.length,
        apiCallCount
      };
    }
  }

  /**
   * Sync all contacts and store in database
   */
  async syncAllContacts() {
    console.log('📞 Starting full contacts sync...');
    
    const result = await this.fetchAllDataPaginated('/contacts', 'contacts');
    
    if (result.success && result.data.length > 0) {
      console.log(`💾 Storing ${result.data.length} contacts in database...`);
      
      // Clear existing contacts and insert new ones
      await SuperChatContact.deleteMany({});
      
      // Insert in batches to avoid memory issues
      const batchSize = 1000;
      for (let i = 0; i < result.data.length; i += batchSize) {
        const batch = result.data.slice(i, i + batchSize);
        const processedBatch = batch.map(contact => ({
          contact_id: contact.id,
          first_name: contact.first_name,
          last_name: contact.last_name,
          email: contact.email,
          phone: contact.phone,
          handles: contact.handles || [],
          custom_attributes: contact.custom_attributes || {},
          created_at: contact.created_at,
          updated_at: contact.updated_at
        }));
        
        await SuperChatContact.insertMany(processedBatch, { ordered: false });
        console.log(`    💾 Inserted batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(result.data.length/batchSize)}`);
      }

      await this.updateSyncStatus('contacts', 'completed', {
        endTime: new Date(),
        totalRecords: result.data.length,
        pagesProcessed: result.totalPages,
        apiCallCount: result.apiCallCount
      });

      console.log('✅ Contacts sync completed successfully');
    }

    return result;
  }

  /**
   * Sync all conversations and store in database
   */
  async syncAllConversations() {
    console.log('💬 Starting full conversations sync...');
    
    const result = await this.fetchAllDataPaginated('/conversations', 'conversations');
    
    if (result.success && result.data.length > 0) {
      console.log(`💾 Storing ${result.data.length} conversations in database...`);
      
      // Clear existing conversations and insert new ones
      await SuperChatConversation.deleteMany({});
      
      // Insert in batches
      const batchSize = 1000;
      for (let i = 0; i < result.data.length; i += batchSize) {
        const batch = result.data.slice(i, i + batchSize);
        const processedBatch = batch.map(conversation => ({
          conversation_id: conversation.id,
          status: conversation.status,
          channel: conversation.channel || {},
          inbox: conversation.inbox || {},
          contact: conversation.contact || {},
          assignee: conversation.assignee || null,
          message_count: conversation.message_count || 0,
          unread_count: conversation.unread_count || 0,
          last_message: conversation.last_message || {},
          last_message_at: conversation.last_message_at,
          created_at: conversation.created_at,
          updated_at: conversation.updated_at
        }));
        
        await SuperChatConversation.insertMany(processedBatch, { ordered: false });
        console.log(`    💾 Inserted batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(result.data.length/batchSize)}`);
      }

      await this.updateSyncStatus('conversations', 'completed', {
        endTime: new Date(),
        totalRecords: result.data.length,
        pagesProcessed: result.totalPages,
        apiCallCount: result.apiCallCount
      });

      console.log('✅ Conversations sync completed successfully');
    }

    return result;
  }

  /**
   * Sync users, channels, and inboxes (smaller datasets)
   */
  async syncMetadata() {
    console.log('🔧 Starting metadata sync (users, channels, inboxes)...');

    const results = {};

    // Sync users
    try {
      const usersResult = await this.fetchAllDataPaginated('/users', 'users');
      results.users = usersResult;
      await this.updateSyncStatus('users', usersResult.success ? 'completed' : 'failed', {
        endTime: new Date(),
        totalRecords: usersResult.totalRecords,
        errorMessage: usersResult.error
      });
    } catch (error) {
      console.error('❌ Users sync failed:', error.message);
      results.users = { success: false, error: error.message };
    }

    // Sync channels
    try {
      const channelsResult = await this.fetchAllDataPaginated('/channels', 'channels');
      results.channels = channelsResult;
      await this.updateSyncStatus('channels', channelsResult.success ? 'completed' : 'failed', {
        endTime: new Date(),
        totalRecords: channelsResult.totalRecords,
        errorMessage: channelsResult.error
      });
    } catch (error) {
      console.error('❌ Channels sync failed:', error.message);
      results.channels = { success: false, error: error.message };
    }

    // Sync inboxes
    try {
      const inboxesResult = await this.fetchAllDataPaginated('/inboxes', 'inboxes');
      results.inboxes = inboxesResult;
      await this.updateSyncStatus('inboxes', inboxesResult.success ? 'completed' : 'failed', {
        endTime: new Date(),
        totalRecords: inboxesResult.totalRecords,
        errorMessage: inboxesResult.error
      });
    } catch (error) {
      console.error('❌ Inboxes sync failed:', error.message);
      results.inboxes = { success: false, error: error.message };
    }

    return results;
  }

  /**
   * Run complete sync of all SuperChat data
   */
  async runFullSync() {
    console.log('🚀 Starting FULL SuperChat data synchronization...');
    const startTime = Date.now();

    const results = {
      contacts: null,
      conversations: null,
      metadata: null,
      totalTime: 0,
      startedAt: new Date()
    };

    try {
      // 1. Sync contacts
      results.contacts = await this.syncAllContacts();
      
      // 2. Sync conversations
      results.conversations = await this.syncAllConversations();
      
      // 3. Sync metadata (users, channels, inboxes)
      results.metadata = await this.syncMetadata();

      const endTime = Date.now();
      results.totalTime = endTime - startTime;
      results.completedAt = new Date();

      console.log(`🎉 FULL SYNC COMPLETED in ${Math.round(results.totalTime / 1000)}s`);
      console.log(`📊 Results:`);
      console.log(`   Contacts: ${results.contacts?.totalRecords || 0}`);
      console.log(`   Conversations: ${results.conversations?.totalRecords || 0}`);
      console.log(`   Users: ${results.metadata?.users?.totalRecords || 0}`);
      console.log(`   Channels: ${results.metadata?.channels?.totalRecords || 0}`);
      console.log(`   Inboxes: ${results.metadata?.inboxes?.totalRecords || 0}`);

      return results;

    } catch (error) {
      console.error('❌ Full sync failed:', error);
      results.error = error.message;
      return results;
    }
  }

  /**
   * Update sync status in database
   */
  async updateSyncStatus(dataType, status, metadata = {}) {
    try {
      const updateData = {
        dataType,
        syncStatus: status,
        lastSyncAt: new Date(),
        ...metadata
      };

      if (metadata.totalRecords) {
        updateData.totalRecords = metadata.totalRecords;
      }

      if (metadata.startTime && metadata.endTime) {
        updateData.syncDuration = new Date(metadata.endTime) - new Date(metadata.startTime);
      }

      await SuperChatSync.findOneAndUpdate(
        { dataType },
        updateData,
        { upsert: true, new: true }
      );

    } catch (error) {
      console.error(`Error updating sync status for ${dataType}:`, error);
    }
  }

  /**
   * Get sync status for all data types
   */
  async getSyncStatus() {
    try {
      const statuses = await SuperChatSync.find({}).sort({ lastSyncAt: -1 });
      return statuses.reduce((acc, status) => {
        acc[status.dataType] = {
          lastSyncAt: status.lastSyncAt,
          status: status.syncStatus,
          totalRecords: status.totalRecords,
          syncDuration: status.syncDuration,
          pagesProcessed: status.pagesProcessed,
          errorMessage: status.errorMessage
        };
        return acc;
      }, {});
    } catch (error) {
      console.error('Error getting sync status:', error);
      return {};
    }
  }
}

module.exports = new SuperChatFullSyncService();

