const mongoose = require('mongoose');

const superChatConversationSchema = new mongoose.Schema({
  // SuperChat conversation ID
  conversation_id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  // Conversation status (open, done, snoozed)
  status: {
    type: String,
    default: 'open',
    enum: ['open', 'done', 'snoozed']
  },
  
  // Channel information
  channel: {
    id: { type: String },
    type: { type: String },
    name: { type: String },
    status: { type: String },
    settings: mongoose.Schema.Types.Mixed
  },
  
  // Inbox information
  inbox: {
    id: { type: String },
    name: { type: String },
    type: { type: String }
  },
  
  // Contact information
  contact: {
    id: { type: String },
    first_name: { type: String },
    last_name: { type: String },
    email: { type: String },
    phone: { type: String },
    avatar: { type: String },
    custom_attributes: mongoose.Schema.Types.Mixed
  },
  
  // Assigned users
  assigned_users: [{
    id: String,
    email: String,
    name: String
  }],
  
  // Labels
  labels: [{
    id: String,
    name: String
  }],
  
  // Snooze information
  snoozed_until: Date,
  
  // Time window
  time_window: {
    state: String,
    open_until: Date
  },
  
  // Last message information
  last_message: {
    content: String,
    direction: String,
    created_at: Date
  },
  
  // Message count
  message_count: {
    type: Number,
    default: 0
  },
  
  // Unread count
  unread_count: {
    type: Number,
    default: 0
  },
  
  // Priority
  priority: {
    type: String,
    enum: ['low', 'medium', 'high'],
    default: 'medium'
  },
  
  // Metadata
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  
  // Timestamps
  created_at: {
    type: Date,
    default: Date.now,
    index: true
  },
  
  updated_at: {
    type: Date,
    default: Date.now
  },
  
  last_message_at: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

// Indexes for better performance
superChatConversationSchema.index({ conversation_id: 1 });
superChatConversationSchema.index({ status: 1 });
superChatConversationSchema.index({ inbox_id: 1 });
superChatConversationSchema.index({ channel_type: 1 });
superChatConversationSchema.index({ assigned_users: 1 });
superChatConversationSchema.index({ last_message_at: -1 });
superChatConversationSchema.index({ created_at: -1 });

// Pre-save middleware to update updated_at
superChatConversationSchema.pre('save', function(next) {
  this.updated_at = new Date();
  next();
});

module.exports = mongoose.model('SuperChatConversation', superChatConversationSchema);
