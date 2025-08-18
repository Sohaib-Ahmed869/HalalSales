const axios = require('axios');
const config = require('./superChatConfig');
const SuperChatMessage = require('../models/SuperChatMessage');
const SuperChatConversation = require('../models/SuperChatConversation');

// MongoDB models for persistent storage

class SuperChatWebhookService {
  constructor() {
    this.webhooks = [];
  }

  // =============================
  // WEBHOOK MANAGEMENT
  // =============================

  async createWebhook(targetUrl, events = ['message_inbound', 'message_outbound', 'conversation_created']) {
    try {
      console.log('🔗 Creating webhook for:', targetUrl);
      
      const webhookData = {
        name: 'HalalSales Integration Webhook',
        target_url: targetUrl,
        events: events
      };

      const response = await this.makeApiCall('post', '/webhooks', webhookData);
      
      if (response.id) {
        this.webhooks.push(response);
        console.log('✅ Webhook created successfully:', response.id);
        return response;
      }
      
      throw new Error('Failed to create webhook');
      
    } catch (error) {
      console.error('❌ Failed to create webhook:', error.message);
      throw error;
    }
  }

  async listWebhooks() {
    try {
      const response = await this.makeApiCall('get', '/webhooks');
      this.webhooks = response.results || [];
      return this.webhooks;
    } catch (error) {
      console.error('❌ Failed to list webhooks:', error.message);
      return [];
    }
  }

  async deleteWebhook(webhookId) {
    try {
      await this.makeApiCall('delete', `/webhooks/${webhookId}`);
      this.webhooks = this.webhooks.filter(w => w.id !== webhookId);
      console.log('✅ Webhook deleted:', webhookId);
      return true;
    } catch (error) {
      console.error('❌ Failed to delete webhook:', error.message);
      return false;
    }
  }

  // =============================
  // MESSAGE STORAGE & RETRIEVAL
  // =============================

  async storeMessage(conversationId, messageData) {
    try {
      console.log(`🔍 DEBUG: Starting storeMessage for conversation ${conversationId}`);
      console.log(`🔍 DEBUG: Message data received:`, JSON.stringify(messageData, null, 2));
      
      // Extract the actual message content from SuperChat's format
      let messageContent = '';
      let messageType = 'text';
      
      if (messageData.content) {
        if (typeof messageData.content === 'string') {
          messageContent = messageData.content;
        } else if (messageData.content.text) {
          // SuperChat's actual format: content.text
          messageContent = messageData.content.text;
          messageType = messageData.content.type || 'text';
        } else if (messageData.content.body) {
          // Your test format: content.body
          messageContent = messageData.content.body;
          messageType = messageData.content.type || 'text';
        } else if (messageData.content.subject) {
          // Email messages: use subject as content
          messageContent = messageData.content.subject;
          messageType = messageData.content.type || 'email';
        } else if (messageData.content.html) {
          // Email HTML content: extract text or use as-is
          messageContent = messageData.content.html.substring(0, 500) + '...'; // Truncate HTML
          messageType = messageData.content.type || 'email';
        }
      }
      
      console.log(`🔍 DEBUG: Extracted content: "${messageContent}"`);
      console.log(`🔍 DEBUG: Channel data:`, JSON.stringify(messageData.channel, null, 2));
      console.log(`🔍 DEBUG: Inbox data:`, JSON.stringify(messageData.inbox, null, 2));
      
      // Create or update message in MongoDB
      const messageDoc = {
        message_id: messageData.id,
        conversation_id: conversationId,
        content: messageContent,
        content_type: messageType,
        direction: messageData.direction || 'inbound',
        status: messageData.status || 'received',
        sender: messageData.sender,
        recipient: messageData.recipient,
        channel: messageData.channel,
        inbox: messageData.inbox,
        in_reply_to: messageData.in_reply_to,
        url: messageData.url,
        metadata: messageData.metadata || {},
        created_at: messageData.created_at || new Date(),
        updated_at: new Date()
      };
      
      console.log(`🔍 DEBUG: Final message document:`, JSON.stringify(messageDoc, null, 2));
      
      // Use upsert to avoid duplicates
      const savedMessage = await SuperChatMessage.findOneAndUpdate(
        { message_id: messageData.id },
        messageDoc,
        { upsert: true, new: true }
      );
      
      console.log(`✅ Successfully stored message in MongoDB:`, savedMessage._id);
      console.log(`💾 Stored message in MongoDB - conversation ${conversationId}:`, messageData.id);
      console.log(`   Content: "${messageContent}"`);
      
      // Update conversation's last message and count
      await this.updateConversationStats(conversationId);
      
    } catch (error) {
      console.error('❌ Failed to store message in MongoDB:', error.message);
      console.error('❌ Full error:', error);
      throw error;
    }
  }

  async storeConversation(conversationData) {
    try {
      const conversationId = conversationData.id;
      
      console.log(`🔍 DEBUG: Starting storeConversation for ${conversationId}`);
      console.log(`🔍 DEBUG: Conversation data received:`, JSON.stringify(conversationData, null, 2));
      
      const conversationDoc = {
        conversation_id: conversationId,
        status: conversationData.status || 'open',
        channel: conversationData.channel,
        inbox: conversationData.inbox,
        contact: conversationData.contact,
        assigned_users: conversationData.assigned_users || [],
        labels: conversationData.labels || [],
        snoozed_until: conversationData.snoozed_until,
        time_window: conversationData.time_window,
        priority: conversationData.priority || 'medium',
        metadata: conversationData.metadata || {},
        created_at: conversationData.created_at || new Date(),
        updated_at: new Date(),
        last_message_at: conversationData.last_message_at || new Date()
      };
      
      console.log(`🔍 DEBUG: Final conversation document:`, JSON.stringify(conversationDoc, null, 2));
      
      // Use upsert to avoid duplicates
      const savedConversation = await SuperChatConversation.findOneAndUpdate(
        { conversation_id: conversationId },
        conversationDoc,
        { upsert: true, new: true }
      );
      
      console.log(`✅ Successfully stored conversation in MongoDB:`, savedConversation._id);
      console.log(`💾 Stored conversation in MongoDB:`, conversationId);
      
    } catch (error) {
      console.error('❌ Failed to store conversation in MongoDB:', error.message);
      console.error('❌ Full conversation error:', error);
      throw error;
    }
  }

  async getConversationMessages(conversationId, limit = 100, offset = 0) {
    try {
      const messages = await SuperChatMessage.find({ conversation_id: conversationId })
        .sort({ created_at: 1 })
        .skip(offset)
        .limit(limit);
      
      const total = await SuperChatMessage.countDocuments({ conversation_id: conversationId });
      
      return {
        results: messages,
        total,
        pagination: {
          limit,
          offset,
          has_more: offset + limit < total
        }
      };
    } catch (error) {
      console.error('❌ Failed to get conversation messages from MongoDB:', error.message);
      return {
        results: [],
        total: 0,
        pagination: { limit, offset, has_more: false }
      };
    }
  }

  async getAllConversations() {
    try {
      const conversations = await SuperChatConversation.find()
        .sort({ last_message_at: -1 });
      
      return conversations;
    } catch (error) {
      console.error('❌ Failed to get conversations from MongoDB:', error.message);
      return [];
    }
  }

  async getConversationById(conversationId) {
    try {
      const conversation = await SuperChatConversation.findOne({ conversation_id: conversationId });
      return conversation;
    } catch (error) {
      console.error('❌ Failed to get conversation from MongoDB:', error.message);
      return null;
    }
  }

  async updateConversationStats(conversationId) {
    try {
      // Get message count
      const messageCount = await SuperChatMessage.countDocuments({ conversation_id: conversationId });
      
      // Get unread count (inbound messages)
      const unreadCount = await SuperChatMessage.countDocuments({ 
        conversation_id: conversationId, 
        direction: 'inbound',
        'metadata.read': { $ne: true }
      });
      
      // Get last message
      const lastMessage = await SuperChatMessage.findOne({ conversation_id: conversationId })
        .sort({ created_at: -1 });
      
      // Update conversation stats
      await SuperChatConversation.findOneAndUpdate(
        { conversation_id: conversationId },
        {
          message_count: messageCount,
          unread_count: unreadCount,
          last_message: lastMessage ? {
            content: lastMessage.content,
            direction: lastMessage.direction,
            created_at: lastMessage.created_at
          } : null,
          last_message_at: lastMessage ? lastMessage.created_at : new Date()
        }
      );
      
    } catch (error) {
      console.error('❌ Failed to update conversation stats:', error.message);
    }
  }

  // =============================
  // WEBHOOK EVENT HANDLERS
  // =============================

  async handleWebhookEvent(eventData) {
    try {
      const event = eventData.event;
      console.log(`📨 Processing webhook event: ${event}`);
      
      switch (event) {
        case 'message_inbound':
        case 'message_outbound':
        case 'message.received':  // Add SuperChat's actual event name
          await this.handleMessageEvent(eventData);
          break;
          
        case 'conversation_created':
        case 'conversation_opened':
        case 'conversation_done':
        case 'conversation_snoozed':
          await this.handleConversationEvent(eventData);
          break;
          
        case 'contact_created':
        case 'contact_updated':
          await this.handleContactEvent(eventData);
          break;
          
        case 'note_created':
          await this.handleNoteEvent(eventData);
          break;
          
        default:
          console.log(`⚠️ Unknown event type: ${event}`);
      }
      
    } catch (error) {
      console.error('❌ Error handling webhook event:', error);
    }
  }

  async handleMessageEvent(eventData) {
    // Handle both your test format and SuperChat's actual format
    const message = eventData.message || eventData.data;
    
    if (message && message.conversation_id) {
      // Store the message with the correct conversation ID
      await this.storeMessage(message.conversation_id, {
        id: message.id,
        direction: message.direction,
        content: message.content,
        sender: message.from,
        recipient: message.to,
        channel: {
          id: message.to?.channel_id || 'unknown',
          type: 'whatsapp', // Extract from channel_id or set default
          name: 'WhatsApp' // Set default name
        },
        inbox: message.inbox || { id: 'default', name: 'Default', type: 'unknown' },
        created_at: message.created_at,
        status: message.status,
        in_reply_to: message.in_reply_to,
        url: message.url,
        metadata: {
          url: message.url,
          updated_at: message.updated_at
        }
      });
      
      console.log(`✅ Processed ${message.direction} message:`, message.id);
      
      // Also store conversation info if available
      if (message.from && message.from.id) {
        await this.storeConversation({
          id: message.conversation_id,
          status: 'open',
          channel: { 
            id: message.to?.channel_id || 'unknown', 
            type: 'whatsapp', 
            name: 'WhatsApp' 
          },
          inbox: { id: 'default', name: 'Default', type: 'unknown' },
          contact: { 
            id: message.from.id, 
            identifier: message.from.identifier,
            first_name: 'Contact',
            last_name: '',
            email: '',
            phone: message.from.identifier
          },
          created_at: message.created_at,
          updated_at: message.updated_at
        });
      }
    } else {
      console.log('⚠️ Message missing conversation_id or invalid format:', message);
    }
  }

  async handleConversationEvent(eventData) {
    const conversation = eventData.conversation;
    
    if (conversation) {
      await this.storeConversation({
        id: conversation.id,
        status: conversation.status,
        channel: conversation.channel,
        inbox: conversation.inbox,
        contact: conversation.contacts?.[0],
        created_at: conversation.created_at,
        updated_at: conversation.updated_at,
        snoozed_until: conversation.snoozed_until,
        labels: conversation.labels || [],
        assigned_users: conversation.assigned_users || []
      });
      
      console.log(`✅ Processed conversation event: ${eventData.event} for conversation ${conversation.id}`);
    }
  }

  handleContactEvent(eventData) {
    const contact = eventData.contact;
    
    if (contact) {
      console.log(`✅ Processed contact event: ${eventData.event} for contact ${contact.id}`);
      // Store contact info if needed for future use
    }
  }

  handleNoteEvent(eventData) {
    const note = eventData.note;
    
    if (note) {
      console.log(`✅ Processed note event: ${eventData.event} for note ${note.id}`);
      // Store note info if needed for future use
    }
  }

  // =============================
  // CONVERSATION EXPORT (FOR BACKFILL)
  // =============================

  async exportConversation(conversationId) {
    try {
      console.log(`📤 Exporting conversation: ${conversationId}`);
      
      const response = await this.makeApiCall('post', '/conversation_exports', {
        conversation_id: conversationId
      });
      
      return response;
      
    } catch (error) {
      console.error('❌ Failed to export conversation:', error.message);
      throw error;
    }
  }

  async getExportStatus(exportId) {
    try {
      const response = await this.makeApiCall('get', `/conversation_exports/${exportId}`);
      return response;
      
    } catch (error) {
      console.error('❌ Failed to get export status:', error.message);
      throw error;
    }
  }

  async downloadTranscript(exportId) {
    try {
      const response = await this.makeApiCall('get', `/conversation_exports/${exportId}/download`);
      return response;
      
    } catch (error) {
      console.error('❌ Failed to download transcript:', error.message);
      throw error;
    }
  }

  // =============================
  // UTILITY METHODS
  // =============================

  async makeApiCall(method, url, data = null, params = null) {
    const headers = {
      'Content-Type': 'application/json',
      'X-API-KEY': config.api.apiKey,
    };
    
    const axiosConfig = {
      method,
      url: `${config.api.baseUrl}${url}`,
      headers,
      timeout: config.api.timeoutMs
    };
    
    if (data) axiosConfig.data = data;
    if (params) axiosConfig.params = params;
    
    const response = await axios(axiosConfig);
    return response.data;
  }

  // Get conversation statistics
  async getConversationStats() {
    try {
      const totalConversations = await SuperChatConversation.countDocuments();
      const totalMessages = await SuperChatMessage.countDocuments();
      
      // Get conversations by status
      const conversationsByStatus = await SuperChatConversation.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]);
      
      // Get messages by direction
      const messagesByDirection = await SuperChatMessage.aggregate([
        { $group: { _id: '$direction', count: { $sum: 1 } } }
      ]);
      
      // Convert to object format
      const statusStats = conversationsByStatus.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {});
      
      const directionStats = messagesByDirection.reduce((acc, item) => {
        acc[item._id] = item.count;
        return acc;
      }, {});
      
      return {
        total_conversations: totalConversations,
        total_messages: totalMessages,
        conversations_by_status: statusStats,
        messages_by_direction: directionStats
      };
    } catch (error) {
      console.error('❌ Failed to get conversation stats:', error.message);
      throw error;
    }
  }

  // Search conversations
  async searchConversations(query, filters = {}) {
    try {
      let searchQuery = {};
      
      // Apply filters
      if (filters.status) {
        searchQuery.status = filters.status;
      }
      
      if (filters.inbox_id) {
        searchQuery['inbox.id'] = filters.inbox_id;
      }
      
      if (filters.channel_type) {
        searchQuery['channel.type'] = filters.channel_type;
      }
      
      // Apply search query for contact name
      if (query) {
        searchQuery.$or = [
          { 'contact.first_name': { $regex: query, $options: 'i' } },
          { 'contact.last_name': { $regex: query, $options: 'i' } },
          { 'contact.email': { $regex: query, $options: 'i' } }
        ];
      }
      
      const conversations = await SuperChatConversation.find(searchQuery)
        .sort({ last_message_at: -1 })
        .limit(100);
      
      return conversations;
    } catch (error) {
      console.error('❌ Failed to search conversations:', error.message);
      throw error;
    }
  }
}

module.exports = SuperChatWebhookService;
