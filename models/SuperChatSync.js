// models/SuperChatSync.js
const mongoose = require('mongoose');

const SuperChatSyncSchema = new mongoose.Schema({
  dataType: {
    type: String,
    required: true,
    enum: ['contacts', 'conversations', 'messages', 'channels', 'users', 'inboxes'],
    index: true
  },
  lastSyncAt: {
    type: Date,
    required: true,
    default: Date.now
  },
  totalRecords: {
    type: Number,
    default: 0
  },
  syncStatus: {
    type: String,
    enum: ['pending', 'in_progress', 'completed', 'failed'],
    default: 'pending',
    index: true
  },
  syncDuration: {
    type: Number, // milliseconds
    default: 0
  },
  pagesProcessed: {
    type: Number,
    default: 0
  },
  errorMessage: {
    type: String
  },
  syncMetadata: {
    startTime: Date,
    endTime: Date,
    lastCursor: String,
    apiCallCount: Number
  }
}, {
  timestamps: true
});

// Index for efficient queries
SuperChatSyncSchema.index({ dataType: 1, lastSyncAt: -1 });
SuperChatSyncSchema.index({ syncStatus: 1, lastSyncAt: -1 });

module.exports = mongoose.model('SuperChatSync', SuperChatSyncSchema);

