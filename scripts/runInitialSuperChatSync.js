#!/usr/bin/env node
// scripts/runInitialSuperChatSync.js
// Script to run initial full SuperChat data synchronization

require('dotenv').config();
const mongoose = require('mongoose');
const superChatFullSyncService = require('../services/superChatFullSyncService');

async function runInitialSync() {
  console.log('🚀 Starting Initial SuperChat Data Synchronization');
  console.log('=' .repeat(60));
  
  try {
    // Connect to MongoDB
    const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/salesHalal";
    console.log('📡 Connecting to MongoDB...');
    
    await mongoose.connect(MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    
    console.log('✅ Connected to MongoDB');
    
    // Check if SuperChat API key is configured
    if (!process.env.SUPER_CHAT_API_KEY) {
      console.error('❌ SUPERCHAT_API_KEY not found in environment variables');
      process.exit(1);
    }
    
    console.log('✅ SuperChat API key found');
    console.log('');
    
    // Start full synchronization
    const startTime = Date.now();
    const results = await superChatFullSyncService.runFullSync();
    const endTime = Date.now();
    const totalDuration = Math.round((endTime - startTime) / 1000);
    
    // Display results
    console.log('');
    console.log('🎉 SYNCHRONIZATION COMPLETED!');
    console.log('=' .repeat(60));
    console.log(`⏱️  Total Duration: ${totalDuration} seconds`);
    console.log('');
    console.log('📊 Results Summary:');
    console.log(`   📞 Contacts: ${results.contacts?.totalRecords || 0} records`);
    console.log(`   💬 Conversations: ${results.conversations?.totalRecords || 0} records`);
    console.log(`   👥 Users: ${results.metadata?.users?.totalRecords || 0} records`);
    console.log(`   📺 Channels: ${results.metadata?.channels?.totalRecords || 0} records`);
    console.log(`   📥 Inboxes: ${results.metadata?.inboxes?.totalRecords || 0} records`);
    console.log('');
    
    // Check for any errors
    const hasErrors = !results.contacts?.success || 
                     !results.conversations?.success ||
                     !results.metadata?.users?.success ||
                     !results.metadata?.channels?.success ||
                     !results.metadata?.inboxes?.success;
    
    if (hasErrors) {
      console.log('⚠️  Some synchronizations had errors:');
      if (!results.contacts?.success) {
        console.log(`   ❌ Contacts: ${results.contacts?.error}`);
      }
      if (!results.conversations?.success) {
        console.log(`   ❌ Conversations: ${results.conversations?.error}`);
      }
      if (!results.metadata?.users?.success) {
        console.log(`   ❌ Users: ${results.metadata?.users?.error}`);
      }
      if (!results.metadata?.channels?.success) {
        console.log(`   ❌ Channels: ${results.metadata?.channels?.error}`);
      }
      if (!results.metadata?.inboxes?.success) {
        console.log(`   ❌ Inboxes: ${results.metadata?.inboxes?.error}`);
      }
    } else {
      console.log('✅ All synchronizations completed successfully!');
    }
    
    console.log('');
    console.log('🎯 Next Steps:');
    console.log('1. Check analytics dashboard: GET /api/super-chat-analytics/dashboard/overview');
    console.log('2. Set up cron jobs for regular updates');
    console.log('3. Monitor sync status: GET /api/super-chat-analytics/sync/status');
    console.log('');
    console.log('📅 Recommended Schedule:');
    console.log('   - Full sync: Daily at 2 AM');
    console.log('   - Quick sync: Every 6 hours');
    console.log('   - Incremental updates: Every hour via webhooks');
    
  } catch (error) {
    console.error('❌ Synchronization failed:', error);
    console.error('');
    console.error('🔧 Troubleshooting:');
    console.error('1. Check SUPERCHAT_API_KEY in .env file');
    console.error('2. Verify MongoDB connection');
    console.error('3. Check SuperChat API status');
    console.error('4. Review logs for specific errors');
    
    process.exit(1);
  } finally {
    // Close MongoDB connection
    await mongoose.disconnect();
    console.log('📡 Disconnected from MongoDB');
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Received SIGINT, shutting down gracefully...');
  await mongoose.disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
  await mongoose.disconnect();
  process.exit(0);
});

// Run the script
if (require.main === module) {
  runInitialSync().catch(console.error);
}

module.exports = runInitialSync;
