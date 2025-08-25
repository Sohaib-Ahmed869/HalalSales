const SuperChatWebhookService = require('../services/superChatWebhookService');
const superChatService = require('../services/superChatService');

class SuperChatConversationController {
  constructor() {
    this.webhookService = new SuperChatWebhookService();
  }

  // =============================
  // WEBHOOK MANAGEMENT
  // =============================

  async createWebhook(req, res) {
    try {
      const { target_url, events } = req.body;
      
      if (!target_url) {
        return res.status(400).json({
          success: false,
          message: 'target_url is required'
        });
      }

      const webhook = await this.webhookService.createWebhook(target_url, events);
      
      res.json({
        success: true,
        data: webhook,
        message: 'Webhook created successfully'
      });
      
    } catch (error) {
      console.error('❌ Failed to create webhook:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to create webhook',
        error: error.message
      });
    }
  }

  async listWebhooks(req, res) {
    try {
      const webhooks = await this.webhookService.listWebhooks();
      
      res.json({
        success: true,
        data: webhooks,
        message: `Found ${webhooks.length} webhooks`
      });
      
    } catch (error) {
      console.error('❌ Failed to list webhooks:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to list webhooks',
        error: error.message
      });
    }
  }

  async deleteWebhook(req, res) {
    try {
      const { webhookId } = req.params;
      
      const success = await this.webhookService.deleteWebhook(webhookId);
      
      if (success) {
        res.json({
          success: true,
          message: 'Webhook deleted successfully'
        });
      } else {
        res.status(404).json({
          success: false,
          message: 'Webhook not found'
        });
      }
      
    } catch (error) {
      console.error('❌ Failed to delete webhook:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to delete webhook',
        error: error.message
      });
    }
  }

  // =============================
  // DIRECT SUPERCHAT API ENDPOINTS (Real-time data)
  // =============================

  async getConversationsDirect(req, res) {
    try {
      const { limit = 20, page = 1, status, priority, search, after, before, inbox_id } = req.query;
      
      console.log('📋 Fetching conversations directly from SuperChat API...');
      
      const conversations = await superChatService.fetchConversations({
        limit: parseInt(limit),
        page: parseInt(page),
        status,
        priority,
        search,
        after,
        before,
        inbox_id
      });
      
      res.json({
        success: true,
        data: conversations,
        message: `Found ${conversations.results?.length || 0} conversations`
      });
      
    } catch (error) {
      console.error('❌ Failed to fetch conversations from SuperChat API:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch conversations',
        error: error.message
      });
    }
  }

  async getConversationWithMessages(req, res) {
    try {
      const { conversationId } = req.params;
      
      console.log(`📋 Fetching conversation ${conversationId} directly from SuperChat API...`);
      
      const conversation = await superChatService.getConversation(conversationId);
      
      if (!conversation) {
        return res.status(404).json({
          success: false,
          message: 'Conversation not found'
        });
      }
      
      res.json({
        success: true,
        data: conversation,
        message: 'Conversation fetched successfully'
      });
      
    } catch (error) {
      console.error(`❌ Failed to get conversation ${conversationId}:`, error);
      res.status(500).json({
        success: false,
        message: 'Failed to get conversation',
        error: error.message
      });
    }
  }

  // =============================
  // CONVERSATION LISTING (LIKE SUPERCHAT UI)
  // =============================

  async getAllConversations(req, res) {
    try {
      const { 
        status, 
        inbox_id, 
        channel_type, 
        search, 
        limit = 50, 
        offset = 0,
        sort = 'newest' // newest, oldest, unread
      } = req.query;

      console.log('🚀 Getting all conversations with filters...');
      
      // Get conversations from webhook service (stored messages)
      let conversations = await this.webhookService.getAllConversations();
      
      // Apply filters
      if (status) {
        conversations = conversations.filter(c => c.status === status);
      }
      
      if (inbox_id) {
        conversations = conversations.filter(c => c.inbox?.id === inbox_id);
      }
      
      if (channel_type) {
        conversations = conversations.filter(c => c.channel?.type === channel_type);
      }
      
      // Apply search (we'll implement this later)
      // if (search) {
      //   conversations = await this.webhookService.searchConversations(search, { status, inbox_id, channel_type });
      // }
      
      // Apply sorting
      switch (sort) {
        case 'newest':
          conversations.sort((a, b) => new Date(b.last_message_at || b.updated_at) - new Date(a.last_message_at || a.updated_at));
          break;
        case 'oldest':
          conversations.sort((a, b) => new Date(a.last_message_at || a.updated_at) - new Date(b.last_message_at || b.updated_at));
          break;
        case 'unread':
          // Sort by unread status first, then by time
          conversations.sort((a, b) => {
            const aUnread = a.unread_count || 0;
            const bUnread = b.unread_count || 0;
            if (aUnread !== bUnread) return bUnread - aUnread;
            return new Date(b.last_message_at || b.updated_at) - new Date(a.last_message_at || a.updated_at);
          });
          break;
      }
      
      // Apply pagination
      const total = conversations.length;
      const paginatedConversations = conversations.slice(offset, offset + parseInt(limit));
      
      // Enhance conversations with message previews and counts
      const enhancedConversations = paginatedConversations.map(conv => {
        return {
          ...conv,
          message_count: conv.message_count || 0,
          unread_count: conv.unread_count || 0,
          last_message: conv.last_message,
          contact_name: `${conv.contact?.first_name || ''} ${conv.contact?.last_name || ''}`.trim() || 'Unknown Contact',
          channel_name: conv.channel?.name || conv.channel?.type || 'Unknown Channel',
          inbox_name: conv.inbox?.name || 'Unknown Inbox'
        };
      });

      res.json({
        success: true,
        data: {
          conversations: enhancedConversations,
          pagination: {
            total,
            limit: parseInt(limit),
            offset: parseInt(offset),
            has_more: offset + parseInt(limit) < total
          },
          filters: {
            status,
            inbox_id,
            channel_type,
            search,
            sort
          }
        },
        message: `Found ${total} conversations`
      });
      
    } catch (error) {
      console.error('❌ Failed to get conversations:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get conversations',
        error: error.message
      });
    }
  }

  // =============================
  // CONVERSATION DETAILS & MESSAGES
  // =============================

  async getConversationDetails(req, res) {
    try {
      const { conversationId } = req.params;
      
      const conversation = await this.webhookService.getConversationById(conversationId);
      
      if (!conversation) {
        return res.status(400).json({
          success: false,
          message: 'Conversation not found'
        });
      }

      // Get messages for this conversation
      const messages = await this.webhookService.getConversationMessages(conversationId);
      
      // Get contact details
      const contact = conversation.contact;
      const channel = conversation.channel;
      const inbox = conversation.inbox;
      
      const conversationDetails = {
        ...conversation,
        contact_details: {
          id: contact?.id,
          name: `${contact?.first_name || ''} ${contact?.last_name || ''}`.trim() || 'Unknown Contact',
          email: contact?.email,
          phone: contact?.phone,
          avatar: contact?.avatar,
          custom_attributes: contact?.custom_attributes || {}
        },
        channel_details: {
          id: channel?.id,
          name: channel?.name || channel?.type,
          type: channel?.type,
          status: channel?.status,
          settings: channel?.settings || {}
        },
        inbox_details: {
          id: inbox?.id,
          name: inbox?.name,
          type: inbox?.type
        },
        messages: messages.results,
        message_count: messages.total,
        unread_count: conversation.unread_count || 0
      };

      res.json({
        success: true,
        data: conversationDetails,
        message: 'Conversation details retrieved successfully'
      });
      
    } catch (error) {
      console.error('❌ Failed to get conversation details:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get conversation details',
        error: error.message
      });
    }
  }

  async getConversationMessages(req, res) {
    try {
      const { conversationId } = req.params;
      const { limit = 100, offset = 0 } = req.query;
      
      const messages = await this.webhookService.getConversationMessages(
        conversationId, 
        parseInt(limit), 
        parseInt(offset)
      );
      
      res.json({
        success: true,
        data: messages,
        message: `Retrieved ${messages.results.length} messages`
      });
      
    } catch (error) {
      console.error('❌ Failed to get conversation messages:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get conversation messages',
        error: error.message
      });
    }
  }

  // =============================
  // SEND MESSAGES (REPLY FUNCTIONALITY)
  // =============================

  async sendMessage(req, res) {
    try {
      const { conversationId } = req.params;
      const { content, message_type = 'text' } = req.body;
      
      if (!content) {
        return res.status(400).json({
          success: false,
          message: 'Message content is required'
        });
      }

      // Get conversation details to find channel and contact
      const conversation = this.webhookService.getConversationById(conversationId);
      
      if (!conversation) {
        return res.status(404).json({
          success: false,
          message: 'Conversation not found'
        });
      }

      // Prepare message data for SuperChat API
      const messageData = {
        from: { channel_id: conversation.channel.id },
        to: { contact_id: conversation.contact.id },
        conversation_id: conversationId,
        content: {
          type: message_type,
          text: content
        }
      };

      console.log('📤 Sending message via SuperChat API:', messageData);
      
      // Send message via SuperChat API
      const response = await superChatService.sendMessage(conversation.contact.id, messageData);
      
      // Store the sent message locally
      this.webhookService.storeMessage(conversationId, {
        id: `temp_${Date.now()}`, // Temporary ID until webhook confirms
        direction: 'outbound',
        content: { type: message_type, text: content },
        sender: { type: 'user', user_id: 'current_user' },
        recipient: { type: 'contact', contact_id: conversation.contact.id },
        created_at: new Date().toISOString(),
        metadata: { pending_confirmation: true }
      });

      res.json({
        success: true,
        data: response,
        message: 'Message sent successfully'
      });
      
    } catch (error) {
      console.error('❌ Failed to send message:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to send message',
        error: error.message
      });
    }
  }

  // =============================
  // CONVERSATION MANAGEMENT
  // =============================

  async updateConversationStatus(req, res) {
    try {
      const { conversationId } = req.params;
      const { status, assigned_to, labels, snoozed_until } = req.body;
      
      const conversation = this.webhookService.getConversationById(conversationId);
      
      if (!conversation) {
        return res.status(404).json({
          success: false,
          message: 'Conversation not found'
        });
      }

      // Update conversation via SuperChat API
      const updateData = {};
      if (status) updateData.status = status;
      if (assigned_to) updateData.assigned_to = assigned_to;
      if (labels) updateData.labels = labels;
      if (snoozed_until) updateData.snoozed_until = snoozed_until;

      const response = await superChatService.updateConversation(conversationId, updateData);
      
      // Update local storage
      Object.assign(conversation, updateData);
      this.webhookService.storeConversation(conversation);

      res.json({
        success: true,
        data: response,
        message: 'Conversation updated successfully'
      });
      
    } catch (error) {
      console.error('❌ Failed to update conversation:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to update conversation',
        error: error.message
      });
    }
  }

  async assignConversation(req, res) {
    try {
      const { conversationId } = req.params;
      const { user_id } = req.body;
      
      if (!user_id) {
        return res.status(400).json({
          success: false,
          message: 'user_id is required'
        });
      }

      const response = await superChatService.updateConversation(conversationId, {
        assigned_to: user_id
      });
      
      // Update local storage
      const conversation = this.webhookService.getConversationById(conversationId);
      if (conversation) {
        conversation.assigned_to = user_id;
        this.webhookService.storeConversation(conversation);
      }

      res.json({
        success: true,
        data: response,
        message: 'Conversation assigned successfully'
      });
      
    } catch (error) {
      console.error('❌ Failed to assign conversation:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to assign conversation',
        error: error.message
      });
    }
  }

  // =============================
  // WEBHOOK RECEIVER (FOR REAL-TIME MESSAGES)
  // =============================

  async receiveWebhook(req, res) {
    try {
      const eventData = req.body;
      
      console.log('📨 Received webhook:', eventData.event);
      
      // Process the webhook event
      await this.webhookService.handleWebhookEvent(eventData);
      
      // Always return 200 to acknowledge receipt
      res.status(200).json({ success: true, message: 'Webhook received' });
      
    } catch (error) {
      console.error('❌ Error processing webhook:', error);
      // Still return 200 to prevent webhook retries
      res.status(200).json({ success: false, message: 'Webhook processed with errors' });
    }
  }

  // =============================
  // UTILITY METHODS
  // =============================



  async getConversationStats(req, res) {
    try {
      // Get stats from webhook service (which queries MongoDB)
      const stats = await this.webhookService.getConversationStats();
      
      // Add additional calculated stats
      const additionalStats = {
        ...stats,
        average_messages_per_conversation: stats.total_conversations > 0 ? 
          (stats.total_messages / stats.total_conversations).toFixed(2) : 0
      };
      
      res.json({
        success: true,
        data: additionalStats,
        message: 'Conversation statistics retrieved successfully'
      });
      
    } catch (error) {
      console.error('❌ Failed to get conversation stats:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get conversation stats',
        error: error.message
      });
    }
  }

  async searchConversations(req, res) {
    try {
      const { query, filters } = req.query;
      
      const conversations = await this.webhookService.searchConversations(query, filters);
      
      res.json({
        success: true,
        data: conversations,
        message: `Found ${conversations.length} matching conversations`
      });
      
    } catch (error) {
      console.error('❌ Failed to search conversations:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to search conversations',
        error: error.message
      });
    }
  }
}

module.exports = SuperChatConversationController;
