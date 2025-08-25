const mongoose = require('mongoose');

const superChatMessageSchema = new mongoose.Schema({
  // SuperChat message ID
  message_id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  // Conversation ID (from SuperChat)
  conversation_id: {
    type: String,
    required: true,
    index: true
  },
  
  // Message content
  content: {
    type: String,
    required: true
  },
  
  // Content type (text, email, whats_app_template, generic_template)
  content_type: {
    type: String,
    default: 'text'
  },
  
  // Message direction (inbound, outbound)
  direction: {
    type: String,
    required: true,
    enum: ['inbound', 'outbound']
  },
  
  // Message status (sent, failed, received)
  status: {
    type: String,
    default: 'received'
  },
  
  // Sender information
  sender: {
    type: {
      type: String,
      enum: ['user', 'contact', 'channel']
    },
    id: { type: String },
    identifier: { type: String },
    email: { type: String }
  },
  
  // Recipient information
  recipient: {
    type: {
      type: String,
      enum: ['user', 'contact', 'channel']
    },
    id: { type: String },
    identifier: { type: String },
    email: { type: String }
  },
  
  // Channel information
  channel: {
    id: { type: String },
    type: { type: String },
    name: { type: String }
  },
  
  // Inbox information
  inbox: {
    id: { type: String },
    name: { type: String },
    type: { type: String }
  },
  
  // Reply information
  in_reply_to: {
    type: String,
    default: null
  },
  
  // Message URL from SuperChat
  url: String,
  
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
  }
}, {
  timestamps: true
});

// Indexes for better performance
superChatMessageSchema.index({ conversation_id: 1, created_at: -1 });
superChatMessageSchema.index({ message_id: 1 });
superChatMessageSchema.index({ direction: 1 });
superChatMessageSchema.index({ status: 1 });

// Pre-save middleware to update updated_at
superChatMessageSchema.pre('save', function(next) {
  this.updated_at = new Date();
  next();
});

module.exports = mongoose.model('SuperChatMessage', superChatMessageSchema);
