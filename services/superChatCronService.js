const cron = require('node-cron');
const SuperChatBatchService = require('./superChatBatchService');
const superChatFullSyncService = require('./superChatFullSyncService');

class SuperChatCronService {
  constructor() {
    this.batchService = new SuperChatBatchService();
    this.fullSyncService = superChatFullSyncService;
    this.jobs = {};
  }

  // =============================
  // CRON JOB MANAGEMENT
  // =============================

  startDailySync() {
    // Schedule daily sync at midnight (00:00)
    const cronExpression = '0 0 * * *'; // Every day at 00:00
    
    console.log('📅 Scheduling daily SuperChat sync at midnight...');
    
    this.jobs.dailySync = cron.schedule(cronExpression, async () => {
      try {
        console.log('🌙 Starting scheduled daily SuperChat sync...');
        const startTime = new Date();
        
        const result = await this.fullSyncService.runFullSync();
        
        const endTime = new Date();
        const duration = Math.round((endTime - startTime) / 1000);
        
        console.log(`✅ Scheduled daily sync completed in ${duration} seconds`);
        console.log('📊 Sync summary:', JSON.stringify(result, null, 2));
        
        // Log to database or file if needed
        this.logSyncResult(result);
        
      } catch (error) {
        console.error('❌ Scheduled daily sync failed:', error.message);
        
        // Log error to database or file if needed
        this.logSyncError(error);
      }
    }, {
      scheduled: false, // Don't start immediately
      timezone: 'UTC' // Use UTC timezone
    });
    
    console.log('✅ Daily sync job scheduled for midnight UTC');
    return this.jobs.dailySync;
  }

  startHourlyIncrementalSync() {
    // Schedule incremental sync every hour for recent data
    const cronExpression = '0 * * * *'; // Every hour at minute 0
    
    console.log('📅 Scheduling hourly incremental SuperChat sync...');
    
    this.jobs.hourlySync = cron.schedule(cronExpression, async () => {
      try {
        console.log('⏰ Starting scheduled hourly incremental sync...');
        
        // Only sync recent conversations (last 24 hours)
        await this.syncRecentData();
        
        console.log('✅ Hourly incremental sync completed');
        
      } catch (error) {
        console.error('❌ Hourly incremental sync failed:', error.message);
      }
    }, {
      scheduled: false,
      timezone: 'UTC'
    });
    
    console.log('✅ Hourly incremental sync job scheduled');
    return this.jobs.hourlySync;
  }

  async syncRecentData() {
    try {
      // This could be optimized to only sync conversations updated in the last 24 hours
      // For now, we'll do a quick sync of recent conversations
      console.log('🔄 Syncing recent conversations...');
      
      // You could add date filters here to only sync recent data
      const result = await this.batchService.batchFetchConversations();
      
      console.log(`✅ Recent data sync: ${result.total_fetched} conversations processed`);
      return result;
      
    } catch (error) {
      console.error('❌ Recent data sync failed:', error.message);
      throw error;
    }
  }

  // =============================
  // JOB CONTROL
  // =============================

  startAllJobs() {
    console.log('🚀 Starting all SuperChat cron jobs...');
    
    Object.values(this.jobs).forEach(job => {
      if (job && typeof job.start === 'function') {
        job.start();
      }
    });
    
    console.log('✅ All SuperChat cron jobs started');
  }

  stopAllJobs() {
    console.log('🛑 Stopping all SuperChat cron jobs...');
    
    Object.values(this.jobs).forEach(job => {
      if (job && typeof job.stop === 'function') {
        job.stop();
      }
    });
    
    console.log('✅ All SuperChat cron jobs stopped');
  }

  getJobStatus() {
    const status = {};
    
    Object.keys(this.jobs).forEach(jobName => {
      const job = this.jobs[jobName];
      status[jobName] = {
        scheduled: job ? true : false,
        running: job && job.running ? true : false
      };
    });
    
    return status;
  }

  // =============================
  // LOGGING
  // =============================

  logSyncResult(result) {
    // You could store sync results in a database table for monitoring
    console.log('📝 Logging sync result to database...');
    
    // Example: Store in a SyncLog model
    /*
    const SyncLog = require('../models/SyncLog');
    const logEntry = new SyncLog({
      type: 'daily_sync',
      status: 'success',
      result: result,
      created_at: new Date()
    });
    await logEntry.save();
    */
  }

  logSyncError(error) {
    // Log errors for monitoring and debugging
    console.log('📝 Logging sync error to database...');
    
    // Example: Store error in a SyncLog model
    /*
    const SyncLog = require('../models/SyncLog');
    const logEntry = new SyncLog({
      type: 'daily_sync',
      status: 'error',
      error: {
        message: error.message,
        stack: error.stack
      },
      created_at: new Date()
    });
    await logEntry.save();
    */
  }

  // =============================
  // MANUAL TRIGGERS
  // =============================

  async triggerManualSync(syncType = 'full') {
    try {
      console.log(`🔧 Triggering manual ${syncType} sync...`);
      
      let result;
      switch (syncType) {
        case 'contacts':
          result = await this.batchService.batchFetchContacts();
          break;
        case 'conversations':
          result = await this.batchService.batchFetchConversations();
          break;
        case 'full':
        default:
          result = await this.batchService.runFullBatchSync();
          break;
      }
      
      console.log(`✅ Manual ${syncType} sync completed`);
      return result;
      
    } catch (error) {
      console.error(`❌ Manual ${syncType} sync failed:`, error.message);
      throw error;
    }
  }
}

module.exports = SuperChatCronService;
