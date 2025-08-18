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

// =============================
// BATCH PROCESSING FUNCTIONS
// =============================

// Process channels directly from channels endpoint
async function processChannelsInBatches(batchSize = 100, maxBatches = null) {
  let nextCursor = null;
  let batchCount = 0;
  let totalProcessed = 0;
  
  // Initialize counters
  const channelStats = {};
  const channelDetails = {};
  
  console.log(`🚀 Starting channels processing with batch size: ${batchSize}`);
  
  do {
    batchCount++;
    
    // Check if we've reached max batches
    if (maxBatches && batchCount > maxBatches) {
      console.log(`⚠️ Reached maximum batch limit: ${maxBatches}`);
      break;
    }
    
    const params = { limit: batchSize };
    if (nextCursor) {
      params.after = nextCursor;
    }
    
    try {
      console.log(`  📄 Batch ${batchCount}: Processing ${batchSize} channels...`);
      const response = await makeApiCall('get', '/channels', null, params);
      
      if (response.results && Array.isArray(response.results)) {
        const batchChannels = response.results;
        totalProcessed += batchChannels.length;
        
        // Process batch immediately
        batchChannels.forEach(channel => {
          const channelType = channel.type || 'unknown';
          const channelId = channel.id || 'unknown';
          
          // Aggregate stats by channel type
          if (!channelStats[channelType]) {
            channelStats[channelType] = {
              total_channels: 0,
              active_channels: 0,
              inactive_channels: 0
            };
          }
          
          channelStats[channelType].total_channels++;
          
          if (channel.status === 'active') channelStats[channelType].active_channels++;
          if (channel.status === 'inactive') channelStats[channelType].inactive_channels++;
          
          // Track individual channel details
          channelDetails[channelId] = {
            id: channelId,
            type: channelType,
            name: channel.name || 'Unnamed Channel',
            status: channel.status || 'unknown',
            created_at: channel.created_at,
            updated_at: channel.updated_at,
            settings: channel.settings || {},
            metadata: channel.metadata || {}
          };
        });
        
        console.log(`    ✅ Processed batch ${batchCount}: ${batchChannels.length} channels (Total: ${totalProcessed})`);
        
        // Clear batch from memory
        batchChannels.length = 0;
      }
      
      // Check for next page
      nextCursor = response.pagination?.next_cursor || null;
      
      // Add delay to prevent rate limiting
      if (nextCursor) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
    } catch (error) {
      console.error(`❌ Error in channels batch ${batchCount}:`, error.message);
      // Continue with next batch
      nextCursor = null;
    }
    
  } while (nextCursor);
  
  console.log(`✅ Completed channels processing: ${totalProcessed} channels from ${batchCount} batches`);
  return { channelStats, channelDetails, totalProcessed, batchCount };
}

// Process contacts in batches
async function processContactsInBatches(batchSize = 1000, maxBatches = null) {
  let nextCursor = null;
  let batchCount = 0;
  let totalProcessed = 0;
  
  // Initialize counters
  const contactStats = {
    total_contacts: 0,
    with_names: 0,
    with_emails: 0,
    with_phones: 0,
    with_custom_attributes: 0
  };
  
  const contactDetails = [];
  
  console.log(`🚀 Starting contacts batch processing with batch size: ${batchSize}`);
  
  do {
    batchCount++;
    
    if (maxBatches && batchCount > maxBatches) {
      console.log(`⚠️ Reached maximum batch limit: ${maxBatches}`);
      break;
    }
    
    const params = { limit: batchSize };
    if (nextCursor) {
      params.after = nextCursor;
    }
    
    try {
      console.log(`  📄 Batch ${batchCount}: Processing ${batchSize} contacts...`);
      const response = await makeApiCall('get', '/contacts', null, params);
      
      if (response.results && Array.isArray(response.results)) {
        const batchContacts = response.results;
        totalProcessed += batchContacts.length;
        
        // Process batch immediately
        batchContacts.forEach(contact => {
          const hasName = !!(contact.first_name || contact.last_name);
          const hasEmail = !!(contact.handles && contact.handles.some(h => h.type === 'email'));
          const hasPhone = !!(contact.handles && contact.handles.some(h => h.type === 'phone'));
          const hasCustomAttributes = !!(contact.custom_attributes && Object.keys(contact.custom_attributes).length > 0);
          
          if (hasName) contactStats.with_names++;
          if (hasEmail) contactStats.with_emails++;
          if (hasPhone) contactStats.with_phones++;
          if (hasCustomAttributes) contactStats.with_custom_attributes++;
          
          contactDetails.push({
            id: contact.id,
            name: `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || 'Unnamed Contact',
            email: contact.handles?.find(h => h.type === 'email')?.value || 'No email',
            phone: contact.handles?.find(h => h.type === 'phone')?.value || 'No phone',
            gender: contact.gender || 'Not specified',
            has_custom_attributes: hasCustomAttributes,
            custom_attributes: contact.custom_attributes || {},
            created_at: contact.created_at,
            updated_at: contact.updated_at
          });
        });
        
        console.log(`    ✅ Processed batch ${batchCount}: ${batchContacts.length} contacts (Total: ${totalProcessed})`);
        
        // Clear batch from memory
        batchContacts.length = 0;
      }
      
      nextCursor = response.pagination?.next_cursor || null;
      
      if (nextCursor) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
    } catch (error) {
      console.error(`❌ Error in contacts batch ${batchCount}:`, error.message);
      nextCursor = null;
    }
    
  } while (nextCursor);
  
  contactStats.total_contacts = totalProcessed;
  console.log(`✅ Completed contacts batch processing: ${totalProcessed} contacts from ${batchCount} batches`);
  return { contactStats, contactDetails, totalProcessed, batchCount };
}

// Process users in batches
async function processUsersInBatches(batchSize = 1000, maxBatches = null) {
  let nextCursor = null;
  let batchCount = 0;
  let totalProcessed = 0;
  
  // Initialize counters
  const userStats = {};
  const userDetails = [];
  
  console.log(`🚀 Starting users batch processing with batch size: ${batchSize}`);
  
  do {
    batchCount++;
    
    if (maxBatches && batchCount > maxBatches) {
      console.log(`⚠️ Reached maximum batch limit: ${maxBatches}`);
      break;
    }
    
    const params = { limit: batchSize };
    if (nextCursor) {
      params.after = nextCursor;
    }
    
    try {
      console.log(`  📄 Batch ${batchCount}: Processing ${batchSize} users...`);
      const response = await makeApiCall('get', '/users', null, params);
      
      if (response.results && Array.isArray(response.results)) {
        const batchUsers = response.results;
        totalProcessed += batchUsers.length;
        
        // Process batch immediately
        batchUsers.forEach(user => {
          const role = user.role || 'unknown';
          
          if (!userStats[role]) {
            userStats[role] = { count: 0, users: [] };
          }
          
          userStats[role].count++;
          
          userDetails.push({
            id: user.id,
            name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Unnamed User',
            email: user.email || 'No email',
            phone: user.phone || 'No phone',
            role: user.role || 'unknown'
          });
        });
        
        console.log(`    ✅ Processed batch ${batchCount}: ${batchUsers.length} users (Total: ${totalProcessed})`);
        
        // Clear batch from memory
        batchUsers.length = 0;
      }
      
      nextCursor = response.pagination?.next_cursor || null;
      
      if (nextCursor) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
    } catch (error) {
      console.error(`❌ Error in users batch ${batchCount}:`, error.message);
      nextCursor = null;
    }
    
  } while (nextCursor);
  
  console.log(`✅ Completed users batch processing: ${totalProcessed} users from ${batchCount} batches`);
  return { userStats, userDetails, totalProcessed, batchCount };
}

module.exports = {
  // =============================
  // BATCH ANALYTICS METHODS
  // =============================
  
  async getChannelsAnalyticsBatch(options = {}) {
    const {
      batchSize = 100,
      maxBatches = null, // Set to limit processing for testing
      enableProgressLogging = true
    } = options;
    
    try {
      console.log('🚀 Starting batch channels analytics...');
      
      const startTime = Date.now();
      const result = await processChannelsInBatches(batchSize, maxBatches);
      const processingTime = Date.now() - startTime;
      
      // Convert to arrays for easier consumption
      const channelTypeStats = Object.entries(result.channelStats).map(([type, stats]) => ({
        type,
        ...stats,
        active_rate: stats.total_channels > 0 ? (stats.active_channels / stats.total_channels * 100).toFixed(2) : 0
      }));
      
      const individualChannelStats = Object.values(result.channelDetails);
      
      const totalChannels = Object.keys(result.channelDetails).length;
      const totalChannelTypes = Object.keys(result.channelStats).length;
      const totalActiveChannels = Object.values(result.channelStats).reduce((sum, stats) => sum + stats.active_channels, 0);
      const totalInactiveChannels = Object.values(result.channelStats).reduce((sum, stats) => sum + stats.inactive_channels, 0);
      
      return {
        success: true,
        data: {
          summary: {
            total_channels: totalChannels,
            total_channel_types: totalChannelTypes,
            total_active_channels: totalActiveChannels,
            total_inactive_channels: totalInactiveChannels,
            processing_time_ms: processingTime,
            batches_processed: result.batchCount
          },
          channels_by_type: channelTypeStats,
          individual_channels: individualChannelStats
        },
        message: `Successfully processed ${result.totalProcessed} channels across ${totalChannelTypes} types in ${result.batchCount} batches (${processingTime}ms)`
      };
      
    } catch (error) {
      console.error('❌ Failed to get batch channels analytics:', error);
      throw error;
    }
  },
  
  async getContactsAnalyticsBatch(options = {}) {
    const {
      batchSize = 1000,
      maxBatches = null,
      enableProgressLogging = true
    } = options;
    
    try {
      console.log('🚀 Starting batch contacts analytics...');
      
      const startTime = Date.now();
      const result = await processContactsInBatches(batchSize, maxBatches);
      const processingTime = Date.now() - startTime;
      
      return {
        success: true,
        data: {
          summary: {
            ...result.contactStats,
            processing_time_ms: processingTime,
            batches_processed: result.batchCount
          },
          contact_details: result.contactDetails,
          processing_info: {
            total_processed: result.totalProcessed,
            batches_processed: result.batchCount,
            processing_time_ms: processingTime
          }
        },
        message: `Successfully processed ${result.totalProcessed} contacts in ${result.batchCount} batches (${processingTime}ms)`
      };
      
    } catch (error) {
      console.error('❌ Failed to get batch contacts analytics:', error);
      throw error;
    }
  },
  
  async getUsersAnalyticsBatch(options = {}) {
    const {
      batchSize = 1000,
      maxBatches = null,
      enableProgressLogging = true
    } = options;
    
    try {
      console.log('🚀 Starting batch users analytics...');
      
      const startTime = Date.now();
      const result = await processUsersInBatches(batchSize, maxBatches);
      const processingTime = Date.now() - startTime;
      
      return {
        success: true,
        data: {
          summary: {
            total_users: result.totalProcessed,
            processing_time_ms: processingTime,
            batches_processed: result.batchCount
          },
          users_by_role: result.userStats,
          user_details: result.userDetails,
          processing_info: {
            total_processed: result.totalProcessed,
            batches_processed: result.batchCount,
            processing_time_ms: processingTime
          }
        },
        message: `Successfully processed ${result.totalProcessed} users in ${result.batchCount} batches (${processingTime}ms)`
      };
      
    } catch (error) {
      console.error('❌ Failed to get batch users analytics:', error);
      throw error;
    }
  }
};
