const mongoose = require('mongoose');

const superChatContactSchema = new mongoose.Schema({
  // SuperChat contact ID
  contact_id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  // Basic contact information
  first_name: {
    type: String,
    default: ''
  },
  
  last_name: {
    type: String,
    default: ''
  },
  
  email: {
    type: String,
    default: '',
    index: true
  },
  
  phone: {
    type: String,
    default: '',
    index: true
  },
  
  // Contact identifier (usually phone number or email)
  identifier: {
    type: String,
    default: '',
    index: true
  },
  
  // Profile picture URL
  avatar: {
    type: String,
    default: ''
  },
  
  // Custom attributes from SuperChat
  custom_attributes: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  
  // Additional attributes from SuperChat
  additional_attributes: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  
  // Activity tracking
  last_activity_at: {
    type: Date,
    index: true
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
  
  // Metadata for batch processing
  metadata: {
    batch_sync: {
      type: Boolean,
      default: false
    },
    synced_at: {
      type: Date,
      default: Date.now
    },
    original_data: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  }
}, {
  timestamps: true
});

// Indexes for better performance
superChatContactSchema.index({ contact_id: 1 });
superChatContactSchema.index({ email: 1 });
superChatContactSchema.index({ phone: 1 });
superChatContactSchema.index({ identifier: 1 });
superChatContactSchema.index({ first_name: 1, last_name: 1 });
superChatContactSchema.index({ last_activity_at: -1 });
superChatContactSchema.index({ created_at: -1 });
superChatContactSchema.index({ 'metadata.batch_sync': 1 });

// Virtual for full name
superChatContactSchema.virtual('full_name').get(function() {
  return `${this.first_name} ${this.last_name}`.trim();
});

// Pre-save middleware to update updated_at
superChatContactSchema.pre('save', function(next) {
  this.updated_at = new Date();
  next();
});

// Static methods
superChatContactSchema.statics.findByIdentifier = function(identifier) {
  return this.findOne({ 
    $or: [
      { identifier: identifier },
      { email: identifier },
      { phone: identifier }
    ]
  });
};

superChatContactSchema.statics.searchContacts = function(searchTerm, limit = 20) {
  return this.find({
    $or: [
      { first_name: { $regex: searchTerm, $options: 'i' } },
      { last_name: { $regex: searchTerm, $options: 'i' } },
      { email: { $regex: searchTerm, $options: 'i' } },
      { phone: { $regex: searchTerm, $options: 'i' } }
    ]
  }).limit(limit);
};

module.exports = mongoose.model('SuperChatContact', superChatContactSchema);
