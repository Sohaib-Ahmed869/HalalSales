const mongoose = require('mongoose');
const crypto = require('crypto');
const SuperChat = require('../models/SuperChat');
const SuperChatAssignment = require('../models/SuperChatAssignment');
const User = require('../models/User');
const config = require('../services/superChatConfig');
const superChatService = require('../services/superChatService');
const analyticsService = require('../services/superChatAnalyticsService');
const batchAnalyticsService = require('../services/superChatBatchAnalyticsService');

function buildChatFilters(query) {
  const filters = {};
  if (query.status) filters.status = query.status;
  if (query.priority) filters.priority = query.priority;
  if (query.assignedTo) filters.assignedTo = new mongoose.Types.ObjectId(query.assignedTo);
  if (query.customerPhone) filters.customerPhone = query.customerPhone;
  if (query.customerEmail) filters.customerEmail = query.customerEmail;
  if (query.startDate || query.endDate) {
    filters.createdAt = {};
    if (query.startDate) filters.createdAt.$gte = new Date(query.startDate);
    if (query.endDate) filters.createdAt.$lte = new Date(query.endDate);
  }
  if (query.search) {
    filters.$or = [
      { customerName: { $regex: query.search, $options: 'i' } },
      { customerPhone: { $regex: query.search, $options: 'i' } },
      { customerEmail: { $regex: query.search, $options: 'i' } },
    ];
  }
  return filters;
}

function paginate(query) {
  const page = Math.max(parseInt(query.page || '1', 10), 1);
  const limit = Math.min(Math.max(parseInt(query.limit || '20', 10), 1), 100);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

async function getTeamAgentIds(managerId) {
  const agents = await User.find({ role: 'sales_agent', manager: managerId }).select('_id');
  return agents.map(a => a._id);
}

function verifyWebhookSignature(req) {
  if (!config.webhook.secret) return true; // allow if not configured
  try {
    const payloadString = JSON.stringify(req.body || {});
    const expected = crypto.createHmac('sha256', config.webhook.secret).update(payloadString).digest('hex');
    const provided = req.header('x-superchat-signature');
    return provided && provided === expected;
  } catch (_) {
    return false;
  }
}

const superChatController = {
  // =============================
  // Core listing with RBAC
  // =============================
  async getAllChats(req, res) {
    try {
      const { page, limit, skip } = paginate(req.query);
      const filters = buildChatFilters(req.query);

      if (req.user.role === 'sales_agent') {
        filters.assignedTo = req.user._id;
      } else if (req.user.role === 'sales_manager') {
        const agentIds = await getTeamAgentIds(req.user._id);
        filters.assignedTo = { $in: agentIds };
      }

      const [chats, total] = await Promise.all([
        SuperChat.find(filters)
          .sort({ lastActivity: -1 })
          .skip(skip)
          .limit(limit)
          .populate('assignedTo', 'firstName lastName email')
          .populate('assignedBy', 'firstName lastName email'),
        SuperChat.countDocuments(filters),
      ]);

      res.json({ success: true, data: { chats, pagination: { page, limit, total, pages: Math.ceil(total / limit) } } });
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to fetch chats', error: e.message });
    }
  },

  async getMyChats(req, res) {
    try {
      const { page, limit, skip } = paginate(req.query);
      const filters = buildChatFilters(req.query);
      filters.assignedTo = req.user._id;
      const [chats, total] = await Promise.all([
        SuperChat.find(filters).sort({ lastActivity: -1 }).skip(skip).limit(limit),
        SuperChat.countDocuments(filters),
      ]);
      res.json({ success: true, data: { chats, pagination: { page, limit, total, pages: Math.ceil(total / limit) } } });
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to fetch my chats', error: e.message });
    }
  },

  async getTeamChats(req, res) {
    try {
      const managerId = req.params.teamId || req.user._id;
      const { page, limit, skip } = paginate(req.query);
      const filters = buildChatFilters(req.query);
      const agentIds = await getTeamAgentIds(managerId);
      filters.assignedTo = { $in: agentIds };
      const [chats, total] = await Promise.all([
        SuperChat.find(filters).sort({ lastActivity: -1 }).skip(skip).limit(limit),
        SuperChat.countDocuments(filters),
      ]);
      res.json({ success: true, data: { chats, pagination: { page, limit, total, pages: Math.ceil(total / limit) } } });
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to fetch team chats', error: e.message });
    }
  },

  async getChatById(req, res) {
    try {
      const chat = await SuperChat.findOne({ chatId: req.params.chatId })
        .populate('assignedTo', 'firstName lastName email')
        .populate('assignedBy', 'firstName lastName email');
      if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

      if (req.user.role === 'sales_agent' && String(chat.assignedTo) !== String(req.user._id)) {
        return res.status(403).json({ success: false, message: 'Forbidden' });
      }
      if (req.user.role === 'sales_manager') {
        const team = await getTeamAgentIds(req.user._id);
        if (!team.map(String).includes(String(chat.assignedTo))) {
          return res.status(403).json({ success: false, message: 'Forbidden' });
        }
      }
      res.json({ success: true, data: chat });
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to fetch chat', error: e.message });
    }
  },

  async assignChat(req, res) {
    try {
      const { agentId, notes, priority } = req.body;
      const chat = await SuperChat.findOne({ chatId: req.params.chatId });
      if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

      chat.assignedTo = agentId;
      chat.assignedBy = req.user._id;
      if (priority) chat.priority = priority;
      chat.status = 'assigned';
      chat.lastActivity = new Date();
      await chat.save();

      await SuperChatAssignment.updateMany({ chat: chat._id, active: true }, { $set: { active: false, unassignedAt: new Date() } });
      await SuperChatAssignment.create({ chat: chat._id, assignedTo: agentId, assignedBy: req.user._id, notes, active: true });

      res.json({ success: true, data: { chat } });
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to assign chat', error: e.message });
    }
  },

  async sendMessage(req, res) {
    try {
      const { content, attachments, priority, tags } = req.body;
      const chat = await SuperChat.findOne({ chatId: req.params.chatId });
      if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

      chat.messages.push({ messageId: String(Date.now()), sender: 'agent', content, attachments, timestamp: new Date(), read: true });
      if (priority) chat.priority = priority;
      if (tags?.length) chat.tags = Array.from(new Set([...(chat.tags || []), ...tags]));
      chat.lastActivity = new Date();
      await chat.save();

      // Send message via Super Chat API
      try { 
        await superChatService.sendMessage(chat.customerId, { content, attachments }); 
      } catch (apiError) {
        console.error('Failed to send message via API:', apiError.message);
      }

      res.json({ success: true, data: { message: chat.messages[chat.messages.length - 1], chat } });
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to send message', error: e.message });
    }
  },

  async updateChatStatus(req, res) {
    try {
      const { status, notes, satisfaction } = req.body;
      const chat = await SuperChat.findOne({ chatId: req.params.chatId });
      if (!chat) return res.status(404).json({ success: false, message: 'Chat not found' });

      chat.status = status || chat.status;
      if (typeof satisfaction === 'number') chat.satisfaction = satisfaction;
      if (notes) chat.notes = notes;
      chat.lastActivity = new Date();
      await chat.save();

      // Update status locally since Super Chat doesn't have this endpoint
      try { 
        await superChatService.updateConversation(req.params.chatId, { status }); 
      } catch (apiError) {
        console.error('Failed to update status via API:', apiError.message);
      }

      res.json({ success: true, data: chat });
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to update status', error: e.message });
    }
  },

  // =============================
  // Analytics & Dashboard
  // =============================
  async getAnalytics(req, res) {
    try {
      const data = await analyticsService.overview({ startDate: req.query.startDate, endDate: req.query.endDate, user: req.user });
      res.json({ success: true, data });
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to get analytics', error: e.message });
    }
  },

  async getDashboardAnalytics(req, res) {
    try {
      console.log('🚀 Controller: Getting dashboard analytics...');
      
      // Use the new analytics service
      const dashboardData = await analyticsService.getDashboardAnalytics();
      
      res.json({ 
        success: true, 
        data: dashboardData,
        message: 'Dashboard analytics generated successfully',
        warnings: []
      });
    } catch (e) {
      console.error('❌ Controller: Failed to get dashboard analytics:', e);
      res.status(500).json({ 
        success: false, 
        message: 'Failed to get dashboard analytics', 
        error: e.message 
      });
    }
  },

  async getTimeTrends(req, res) {
    try {
      // Get comprehensive analytics from Super Chat API
      const analytics = await superChatService.getComprehensiveAnalytics({
        start_date: req.query.startDate,
        end_date: req.query.endDate,
        inbox_id: req.query.inboxId
      });
      
      // Extract conversation trends
      const trends = {
        total_conversations: analytics.conversations?.total || 0,
        open_conversations: analytics.conversations?.open || 0,
        closed_conversations: analytics.conversations?.closed || 0,
        reply_rate: analytics.conversations?.reply_rate || 0,
        avg_response_time: analytics.conversations?.avg_response_time_minutes || 0
      };
      
      res.json({ success: true, data: trends });
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to get time trends', error: e.message });
    }
  },

  async getWorkloadDistribution(req, res) {
    try {
      // Get comprehensive analytics from Super Chat API
      const analytics = await superChatService.getComprehensiveAnalytics({
        start_date: req.query.startDate,
        end_date: req.query.endDate,
        inbox_id: req.query.inboxId
      });
      
      // Extract workload distribution
      const workload = {
        open: analytics.conversations?.open || 0,
        closed: analytics.conversations?.closed || 0,
        pending: analytics.conversations?.pending || 0,
        total: analytics.conversations?.total || 0,
        users: analytics.users?.total || 0,
        active_users: analytics.users?.active || 0
      };
      
      res.json({ success: true, data: workload });
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to get workload distribution', error: e.message });
    }
  },

  async getCustomerInsights(req, res) {
    try {
      // Get comprehensive analytics from Super Chat API
      const analytics = await superChatService.getComprehensiveAnalytics({
        start_date: req.query.startDate,
        end_date: req.query.endDate,
        inbox_id: req.query.inboxId
      });
      
      const insights = {
        total_contacts: analytics.contacts?.total || 0,
        active_contacts: analytics.contacts?.active || 0,
        engagement_rate: analytics.contacts?.engagement_rate || 0,
        total_conversations: analytics.conversations?.total || 0,
        reply_rate: analytics.conversations?.reply_rate || 0,
        avg_response_time: analytics.conversations?.avg_response_time_minutes || 0,
        files_shared: analytics.files?.total || 0,
        recent_files: analytics.files?.recent || 0
      };
      
      res.json({ success: true, data: insights });
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to get customer insights', error: e.message });
    }
  },

  async getPerformanceComparison(req, res) {
    try {
      // Get comprehensive analytics from Super Chat API
      const analytics = await superChatService.getComprehensiveAnalytics({
        start_date: req.query.startDate,
        end_date: req.query.endDate,
        inbox_id: req.query.inboxId
      });
      
      const performance = {
        conversations: analytics.conversations || {},
        contacts: analytics.contacts || {},
        users: analytics.users || {},
        files: analytics.files || {},
        summary: analytics.summary || {}
      };
      
      res.json({ success: true, data: performance });
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to get performance comparison', error: e.message });
    }
  },

  async getAgentPerformance(req, res) {
    try {
      const { agentId } = req.params;
      
      // Get comprehensive analytics and filter by agent
      const analytics = await superChatService.getComprehensiveAnalytics({
        start_date: req.query.startDate,
        end_date: req.query.endDate,
        inbox_id: req.query.inboxId
      });
      
      // For now, return general performance metrics
      // In the future, we can filter conversations by assigned agent
      const performance = {
        total_conversations: analytics.conversations?.total || 0,
        replied_conversations: analytics.conversations?.replied || 0,
        reply_rate: analytics.conversations?.reply_rate || 0,
        avg_response_time: analytics.conversations?.avg_response_time_minutes || 0,
        note: 'Agent-specific filtering will be implemented in next phase'
      };
      
      res.json({ success: true, data: performance });
    } catch (e) {
      res.status(500).json({ success: false, message: 'Failed to get agent performance', error: e.message });
    }
  },

  // =============================
  // Admin helpers
  // =============================
  async testApiConnection(req, res) {
    const hc = await superChatService.healthCheck();
    res.json({ success: true, data: { connected: hc.externalApi === true, details: hc } });
  },

  async syncChats(req, res) {
    try {
      console.log('🔄 Starting Super Chat sync...');
      
      // First get inboxes to understand the structure
      const inboxes = await superChatService.fetchInboxes();
      console.log(`📊 Found ${inboxes.results?.length || 0} inboxes`);
      
      // Then fetch conversations (this is the main data!)
      const conversations = await superChatService.fetchConversations({ page: 1, limit: 100 });
      console.log(`📝 Found ${conversations.results?.length || 0} conversations`);
      
      // Also fetch contacts for reference
      const contacts = await superChatService.fetchContacts({ page: 1, limit: 100 });
      console.log(`👥 Found ${contacts.results?.length || 0} contacts`);
      
      // Sync conversations to local database
      const result = await superChatService.syncConversationsToLocal(conversations);
      console.log(`✅ Synced ${result.synced} conversations`);
      
      res.json({ 
        success: true, 
        data: { 
          synced: result.synced, 
          chatIds: result.chatIds,
          total_conversations: conversations.results?.length || 0,
          total_contacts: contacts.results?.length || 0,
          inboxes: inboxes.results?.length || 0
        } 
      });
    } catch (e) {
      console.error('❌ Sync failed:', e);
      res.status(500).json({ success: false, message: 'Sync failed', error: e.message });
    }
  },

  async createWebhook(req, res) {
    try {
      const { target_url, events } = req.body;
      const data = await superChatService.createWebhook({ target_url, events: events || config.webhook.events });
      res.json({ success: true, data });
    } catch (e) {
      res.status(500).json({ success: false, message: 'Create webhook failed', error: e.message });
    }
  },

  async listWebhooks(req, res) {
    try {
      const data = await superChatService.listWebhooks();
      res.json({ success: true, data });
    } catch (e) {
      res.status(500).json({ success: false, message: 'List webhooks failed', error: e.message });
    }
  },

  async deleteWebhook(req, res) {
    try {
      const { webhookId } = req.params;
      const data = await superChatService.deleteWebhook(webhookId);
      res.json({ success: true, data });
    } catch (e) {
      res.status(500).json({ success: false, message: 'Delete webhook failed', error: e.message });
    }
  },

  async healthCheck(req, res) {
    const hc = await superChatService.healthCheck();
    res.json({ success: true, data: { status: 'healthy', externalApi: hc.externalApi } });
  },

  // =============================
  // Webhook handling
  // =============================
  async handleWebhook(req, res) {
    try {
      if (!verifyWebhookSignature(req)) return res.status(401).json({ error: 'Invalid signature' });
      const payload = req.body;
      
      console.log('📥 Webhook received:', payload.event);
      
      switch (payload.event) {
        case 'message_inbound':
          await superChatController.processInboundMessage(payload.data);
          break;
        case 'message_outbound':
          await superChatController.processOutboundMessage(payload.data);
          break;
        case 'contact_created':
          await superChatController.processContactCreated(payload.data);
          break;
        case 'contact_updated':
          await superChatController.processContactUpdated(payload.data);
          break;
        case 'conversation_opened':
          await superChatController.processConversationOpened(payload.data);
          break;
        case 'conversation_done':
          await superChatController.processConversationDone(payload.data);
          break;
        case 'conversation_snoozed':
          await superChatController.processConversationSnoozed(payload.data);
          break;
        case 'note_created':
          await superChatController.processNoteCreated(payload.data);
          break;
        case 'message_failed':
          await superChatController.processMessageFailed(payload.data);
          break;
        default:
          console.log(`ℹ️  Unhandled event type: ${payload.event}`);
      }
      
      res.json({ success: true, message: 'Webhook processed' });
    } catch (e) {
      console.error('❌ Webhook processing error:', e);
      res.status(500).json({ error: 'Webhook processing failed' });
    }
  },

  async processInboundMessage(data) {
    const { conversation_id, contact, message, timestamp } = data;
    let chat = await SuperChat.findOne({ chatId: conversation_id });
    if (!chat) {
      chat = await SuperChat.create({
        chatId: conversation_id,
        customerId: contact?.id || 'unknown',
        customerName: contact?.name || 'Unknown',
        customerPhone: contact?.phone,
        customerEmail: contact?.email,
        status: 'new',
        source: 'super_chat',
        externalData: data,
      });
    }
    chat.messages.push({ messageId: message?.id || String(Date.now()), sender: 'customer', content: message?.content || message?.text || '', timestamp: new Date(timestamp || Date.now()), read: false });
    chat.lastActivity = new Date();
    await chat.save();
  },

  async processOutboundMessage(data) {
    const { conversation_id, message, timestamp } = data;
    const chat = await SuperChat.findOne({ chatId: conversation_id });
    if (!chat) return;
    chat.messages.push({ messageId: message?.id || String(Date.now()), sender: 'agent', content: message?.content || message?.text || '', timestamp: new Date(timestamp || Date.now()), read: true });
    chat.lastActivity = new Date();
    await chat.save();
  },

  async processContactCreated(data) {
    const { contact } = data;
    await SuperChat.updateMany({ customerId: contact?.id }, { $set: { customerName: contact?.name, customerPhone: contact?.phone, customerEmail: contact?.email } });
  },

  async processContactUpdated(data) { return superChatController.processContactCreated(data); },

  async processConversationOpened(data) {
    const { conversation_id, contact } = data;
    let chat = await SuperChat.findOne({ chatId: conversation_id });
    if (!chat) {
      chat = await SuperChat.create({
        chatId: conversation_id,
        customerId: contact?.id || 'unknown',
        customerName: contact?.name || 'Unknown',
        customerPhone: contact?.phone,
        customerEmail: contact?.email,
        status: 'in_progress',
        source: 'super_chat',
        externalData: data,
      });
    }
    chat.status = 'in_progress';
    chat.lastActivity = new Date();
    await chat.save();
  },

  async processConversationDone(data) {
    const { conversation_id } = data;
    const chat = await SuperChat.findOne({ chatId: conversation_id });
    if (!chat) return;
    chat.status = 'resolved';
    chat.lastActivity = new Date();
    await chat.save();
  },

  async processConversationSnoozed(data) {
    const { conversation_id } = data;
    const chat = await SuperChat.findOne({ chatId: conversation_id });
    if (!chat) return;
    chat.status = 'assigned';
    chat.lastActivity = new Date();
    await chat.save();
  },

  async processNoteCreated(data) {
    const { conversation_id, note } = data;
    const chat = await SuperChat.findOne({ chatId: conversation_id });
    if (!chat) return;
    chat.notes = [chat.notes, note?.content || note?.text].filter(Boolean).join('\n');
    chat.lastActivity = new Date();
    await chat.save();
  },

  async processMessageFailed(_data) { /* no-op for now */ },

  // =============================
  // DIRECT SUPER CHAT API METHODS (Real-time data)
  // =============================
  
  async getConversationsDirect(req, res) {
    try {
      const { page = 1, limit = 20, status, inbox_id, search } = req.query;
      
      // Apply RBAC filtering
      let filters = {};
      if (status) filters.status = status;
      if (inbox_id) filters.inbox_id = inbox_id;
      if (search) filters.search = search;
      
      // Get conversations directly from Super Chat API
      const conversations = await superChatService.fetchConversations({ 
        page: parseInt(page), 
        limit: parseInt(limit),
        ...filters
      });
      
      res.json({ 
        success: true, 
        data: conversations,
        message: 'Real-time data from Super Chat API'
      });
    } catch (e) {
      res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch conversations from Super Chat API', 
        error: e.message 
      });
    }
  },

  async getContactsDirect(req, res) {
    try {
      const { page = 1, limit = 20, search } = req.query;
      
      const contacts = await superChatService.fetchContacts({ 
        page: parseInt(page), 
        limit: parseInt(limit),
        search
      });
      
      res.json({ 
        success: true, 
        data: contacts,
        message: 'Real-time data from Super Chat API'
      });
    } catch (e) {
      res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch contacts from Super Chat API', 
        error: e.message 
      });
    }
  },

  async getUsersDirect(req, res) {
    try {
      const { page = 1, limit = 20, role } = req.query;
      
      const users = await superChatService.fetchUsers({ 
        page: parseInt(page), 
        limit: parseInt(limit),
        role
      });
      
      res.json({ 
        success: true, 
        data: users,
        message: 'Real-time data from Super Chat API'
      });
    } catch (e) {
      res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch users from Super Chat API', 
        error: e.message 
      });
    }
  },

  async getInboxesDirect(req, res) {
    try {
      const { page = 1, limit = 20 } = req.query;
      
      const inboxes = await superChatService.fetchInboxes({ 
        page: parseInt(page), 
        limit: parseInt(limit)
      });
      
      res.json({ 
        success: true, 
        data: inboxes,
        message: 'Real-time data from Super Chat API'
      });
    } catch (e) {
      res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch inboxes from Super Chat API', 
        error: e.message 
      });
    }
  },

  async getFilesDirect(req, res) {
    try {
      const { page = 1, limit = 20, type } = req.query;
      
      const files = await superChatService.fetchFiles({ 
        page: parseInt(page), 
        limit: parseInt(limit),
        type
      });
      
      res.json({ 
        success: true, 
        data: files,
        message: 'Real-time data from Super Chat API'
      });
    } catch (e) {
      res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch files from Super Chat API', 
        error: e.message 
      });
    }
  },

  // =============================
  // ENHANCED CONVERSATION ENDPOINTS (With messages & contacts)
  // =============================
  
  async getConversationWithMessages(req, res) {
    try {
      const { conversationId } = req.params;
      
      // Get conversation details
      const conversation = await superChatService.getConversation(conversationId);
      
      if (!conversation) {
        return res.status(404).json({ 
          success: false, 
          message: 'Conversation not found' 
        });
      }
      
      // Get contact details for each contact
      const enrichedContacts = [];
      if (conversation.contacts && conversation.contacts.length > 0) {
        for (const contactRef of conversation.contacts) {
          try {
            const contactDetails = await superChatService.fetchContactDetails(contactRef.id);
            enrichedContacts.push({
              id: contactRef.id,
              url: contactRef.url,
              ...contactDetails
            });
          } catch (error) {
            console.log(`Failed to fetch contact ${contactRef.id}:`, error.message);
            enrichedContacts.push(contactRef);
          }
        }
      }
      
      // Enrich conversation with contact details
      const enrichedConversation = {
        ...conversation,
        contacts: enrichedContacts
      };
      
      res.json({ 
        success: true, 
        data: enrichedConversation,
        message: 'Complete conversation with contact details'
      });
    } catch (e) {
      res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch conversation details', 
        error: e.message 
      });
    }
  },

  async getConversationsWithContacts(req, res) {
    try {
      const { page = 1, limit = 20, status, inbox_id, search } = req.query;
      
      // Get conversations
      const conversations = await superChatService.fetchConversations({ 
        page: parseInt(page), 
        limit: parseInt(limit),
        status,
        inbox_id,
        search
      });
      
      // Enrich with contact details (first contact only for performance)
      const enrichedConversations = [];
      for (const conv of conversations.results || []) {
        try {
          if (conv.contacts && conv.contacts.length > 0) {
            const contactId = conv.contacts[0].id;
            const contactDetails = await superChatService.fetchContactDetails(contactId);
            
            enrichedConversations.push({
              ...conv,
              contactDetails: {
                id: contactId,
                ...contactDetails
              }
            });
          } else {
            enrichedConversations.push(conv);
          }
        } catch (error) {
          console.log(`Failed to enrich conversation ${conv.id}:`, error.message);
          enrichedConversations.push(conv);
        }
      }
      
      res.json({ 
        success: true, 
        data: {
          ...conversations,
          results: enrichedConversations
        },
        message: 'Conversations with contact details'
      });
    } catch (e) {
      res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch conversations with contacts', 
        error: e.message 
      });
    }
  },

  // =============================
  // COMPLETE CONVERSATION SYSTEM
  // =============================
  
  async getConversationMessages(req, res) {
    try {
      const { conversationId } = req.params;
      
      // Get conversation details
      const conversation = await superChatService.getConversation(conversationId);
      
      if (!conversation) {
        return res.status(404).json({ 
          success: false, 
          message: 'Conversation not found' 
        });
      }
      
      // Get contact details for each contact
      const enrichedContacts = [];
      if (conversation.contacts && conversation.contacts.length > 0) {
        for (const contactRef of conversation.contacts) {
          try {
            const contactDetails = await superChatService.fetchContactDetails(contactRef.id);
            enrichedContacts.push({
              id: contactRef.id,
              url: contactRef.url,
              ...contactDetails
            });
          } catch (error) {
            console.log(`Failed to fetch contact ${contactRef.id}:`, error.message);
            enrichedContacts.push(contactRef);
          }
        }
      }
      
      // Create conversation view with messages
      const conversationView = {
        id: conversation.id,
        status: conversation.status,
        channel: conversation.channel,
        inbox: conversation.inbox,
        labels: conversation.labels || [],
        assigned_users: conversation.assigned_users || [],
        snoozed_until: conversation.snoozed_until,
        time_window: conversation.time_window,
        created_at: conversation.created_at,
        updated_at: conversation.updated_at,
        contacts: enrichedContacts,
        messages: [], // Super Chat doesn't provide messages via API
        message_count: 0,
        last_message: null,
        customer_info: enrichedContacts[0] || null,
        metadata: {
          source: 'super_chat',
          api_url: conversation.url,
          last_sync: new Date().toISOString()
        }
      };
      
      res.json({ 
        success: true, 
        data: conversationView,
        message: 'Conversation details (messages available via webhooks)',
        note: 'Messages are delivered via webhooks in real-time, not via API'
      });
    } catch (e) {
      res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch conversation messages', 
        error: e.message 
      });
    }
  },

  async getConversationHistory(req, res) {
    try {
      const { conversationId } = req.params;
      const { page = 1, limit = 50 } = req.query;
      
      // Get conversation details
      const conversation = await superChatService.getConversation(conversationId);
      
      if (!conversation) {
        return res.status(404).json({ 
          success: false, 
          message: 'Conversation not found' 
        });
      }
      
      // Get contact details
      let contactDetails = null;
      if (conversation.contacts && conversation.contacts.length > 0) {
        try {
          const contactId = conversation.contacts[0].id;
          contactDetails = await superChatService.fetchContactDetails(contactId);
        } catch (error) {
          console.log(`Failed to fetch contact details:`, error.message);
        }
      }
      
      // Create conversation history view
      const history = {
        conversation: {
          id: conversation.id,
          status: conversation.status,
          channel: conversation.channel,
          inbox: conversation.inbox,
          created_at: conversation.created_at,
          updated_at: conversation.updated_at
        },
        customer: contactDetails ? {
          id: contactDetails.id,
          name: `${contactDetails.first_name || ''} ${contactDetails.last_name || ''}`.trim() || 'Unknown',
          phone: contactDetails.phone,
          email: contactDetails.email,
          handles: contactDetails.handles || []
        } : null,
        messages: [], // Will be populated from webhook data
        summary: {
          total_messages: 0,
          customer_messages: 0,
          agent_messages: 0,
          first_message: null,
          last_message: null,
          response_time_minutes: 0
        }
      };
      
      res.json({ 
        success: true, 
        data: history,
        message: 'Conversation history structure',
        note: 'Messages are populated via webhooks in real-time'
      });
    } catch (e) {
      res.status(500).json({ 
        success: false, 
        message: 'Failed to fetch conversation history', 
        error: e.message 
      });
    }
  },

  async getInboxAnalytics(req, res) {
    try {
      console.log('🚀 Getting inbox analytics...');
      
      // Get all inboxes first
      let inboxes = { results: [] };
      try {
        inboxes = await superChatService.fetchInboxes({ limit: 1000 });
      } catch (error) {
        console.error('❌ Failed to fetch inboxes:', error.message);
        return res.status(500).json({
          success: false,
          message: 'Failed to fetch inboxes',
          error: error.message
        });
      }

      const inboxItems = inboxes?.results || [];
      console.log(`📊 Found ${inboxItems.length} inboxes`);

      // Get conversations for each inbox to calculate counts
      const inboxAnalytics = [];
      
      for (const inbox of inboxItems) {
        try {
          console.log(`🔄 Processing inbox: ${inbox.name} (${inbox.id})`);
          
          // Get conversations for this specific inbox
          const conversations = await superChatService.fetchConversations({ 
            inbox_id: inbox.id, 
            limit: 1000 
          });
          
          const convItems = conversations?.results || [];
          
          // Calculate metrics for this inbox
          const totalConversations = convItems.length;
          const openConversations = convItems.filter(c => c.status === 'open').length;
          const resolvedConversations = convItems.filter(c => c.status === 'done').length;
          
          // Channel distribution for this inbox
          const channelStats = convItems.reduce((acc, conv) => {
            const type = conv.channel?.type || 'unknown';
            acc[type] = (acc[type] || 0) + 1;
            return acc;
          }, {});
          
          inboxAnalytics.push({
            id: inbox.id,
            name: inbox.name,
            total_conversations: totalConversations,
            open_conversations: openConversations,
            resolved_conversations: resolvedConversations,
            channels: channelStats,
            channel_count: Object.keys(channelStats).length
          });
          
          console.log(`  ✅ ${inbox.name}: ${totalConversations} conversations (${openConversations} open, ${resolvedConversations} resolved)`);
          
        } catch (error) {
          console.error(`❌ Error processing inbox ${inbox.name}:`, error.message);
          // Add inbox with error status
          inboxAnalytics.push({
            id: inbox.id,
            name: inbox.name,
            total_conversations: 0,
            open_conversations: 0,
            resolved_conversations: 0,
            channels: {},
            channel_count: 0,
            error: error.message
          });
        }
      }

      // Calculate summary stats
      const totalInboxes = inboxAnalytics.length;
      const totalConversations = inboxAnalytics.reduce((sum, inbox) => sum + inbox.total_conversations, 0);
      const totalOpenConversations = inboxAnalytics.reduce((sum, inbox) => sum + inbox.open_conversations, 0);
      const totalResolvedConversations = inboxAnalytics.reduce((sum, inbox) => sum + inbox.resolved_conversations, 0);

      const response = {
        success: true,
        data: {
          summary: {
            total_inboxes: totalInboxes,
            total_conversations: totalConversations,
            total_open_conversations: totalOpenConversations,
            total_resolved_conversations: totalResolvedConversations
          },
          inboxes: inboxAnalytics
        },
        message: `Successfully fetched analytics for ${totalInboxes} inboxes`
      };

      console.log('✅ Inbox analytics completed successfully');
      res.json(response);
      
    } catch (error) {
      console.error('❌ Failed to get inbox analytics:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get inbox analytics',
        error: error.message
      });
    }
  },

  async getUsersAnalytics(req, res) {
    try {
      console.log('🚀 Getting users analytics...');
      
      // Function to fetch all users with pagination
      const fetchAllUsers = async () => {
        let allUsers = [];
        let nextCursor = null;
        let pageCount = 0;
        
        do {
          pageCount++;
          const params = { limit: 100 }; // Use 100 per page for efficiency
          if (nextCursor) {
            params.after = nextCursor;
          }
          
          console.log(`  📄 Page ${pageCount}: Fetching users...`);
          const response = await superChatService.fetchUsers(params);
          
          if (response.results && Array.isArray(response.results)) {
            allUsers = allUsers.concat(response.results);
         
          }
          
          // Check for next page
          nextCursor = response.pagination?.next_cursor || null;
          
          
          
        } while (nextCursor);
        
        return allUsers;
      };
      
      // Fetch all users
      const allUsers = await fetchAllUsers();
      console.log(`📊 Found ${allUsers.length} total users`);
      
      // Calculate user statistics
      const userStats = allUsers.reduce((acc, user) => {
        const role = user.role || 'unknown';
        if (!acc[role]) {
          acc[role] = { count: 0, users: [] };
        }
        acc[role].count++;
        acc[role].users.push({
          id: user.id,
          name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Unnamed User',
          email: user.email || 'No email',
          phone: user.phone || 'No phone',
          role: user.role || 'unknown'
        });
        return acc;
      }, {});
      
      // Get conversations assigned to each user
      const userConversationStats = [];
      
      for (const user of allUsers) {
        try {
         
          // Get conversations assigned to this user
          const conversations = await superChatService.fetchConversations({ 
            assigned_user_id: user.id, 
            limit: 1000 
          });
          
          const convItems = conversations?.results || [];
          
          // Calculate metrics for this user
          const totalAssigned = convItems.length;
          const openAssigned = convItems.filter(c => c.status === 'open').length;
          const resolvedAssigned = convItems.filter(c => c.status === 'done').length;
          
          // Channel distribution for this user
          const channelStats = convItems.reduce((acc, conv) => {
            const type = conv.channel?.type || 'unknown';
            acc[type] = (acc[type] || 0) + 1;
            return acc;
          }, {});
          
          userConversationStats.push({
            id: user.id,
            name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Unnamed User',
            email: user.email || 'No email',
            phone: user.phone || 'No phone',
            role: user.role || 'unknown',
            total_assigned: totalAssigned,
            open_assigned: openAssigned,
            resolved_assigned: resolvedAssigned,
            channels: channelStats,
            channel_count: Object.keys(channelStats).length,
            resolution_rate: totalAssigned > 0 ? (resolvedAssigned / totalAssigned * 100).toFixed(2) : 0
          });
          
         
          
        } catch (error) {
         
          // Add user with error status
          userConversationStats.push({
            id: user.id,
            name: `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Unnamed User',
            email: user.email || 'No email',
            phone: user.phone || 'No phone',
            role: user.role || 'unknown',
            total_assigned: 0,
            open_assigned: 0,
            resolved_assigned: 0,
            channels: {},
            channel_count: 0,
            resolution_rate: 0,
            error: error.message
          });
        }
      }

      // Calculate summary stats
      const totalUsers = allUsers.length;
      const totalAssignedConversations = userConversationStats.reduce((sum, user) => sum + user.total_assigned, 0);
      const totalOpenConversations = userConversationStats.reduce((sum, user) => sum + user.open_assigned, 0);
      const totalResolvedConversations = userConversationStats.reduce((sum, user) => sum + user.resolved_assigned, 0);

      const response = {
        success: true,
        data: {
          summary: {
            total_users: totalUsers,
            total_assigned_conversations: totalAssignedConversations,
            total_open_conversations: totalOpenConversations,
            total_resolved_conversations: totalResolvedConversations
          },
          users_by_role: userStats,
          user_performance: userConversationStats
        },
        message: `Successfully fetched analytics for ${totalUsers} users`
      };


      res.json(response);
      
    } catch (error) {
      console.error('❌ Failed to get users analytics:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get users analytics',
        error: error.message
      });
    }
  },

  async getChannelsAnalytics(req, res) {
    try {
      const channelsResponse = await superChatService.fetchChannels();

    if (!channelsResponse || !Array.isArray(channelsResponse.results)) {
      throw new Error('Invalid response from Superchat API while fetching channels');
    }

    // Map to a clean list if needed
    const channels = channelsResponse.results.map(channel => ({
      id: channel.id,
      type: channel.type,
      name: channel.name || null,
      inbox_id: channel.inbox?.id || null,
      inbox_name: channel.inbox?.name || null,
      created_at: channel.created_at || null,
      status: channel.status || null
    }));

    const response = {
      success: true,
      data: {
        total_channels: channels.length,
        channels
      },
      message: `Successfully fetched ${channels.length} channels`
    };
      res.json(response);
      
    } catch (error) {
      console.error('❌ Failed to get channels analytics:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get channels analytics',
        error: error.message
      });
    }
  },

  async getContactsAnalytics(req, res) {
    try {
      console.log('🚀 Getting contacts analytics...');
      
      // Function to fetch all contacts with pagination
      const fetchAllContacts = async () => {
        let allContacts = [];
        let nextCursor = null;
        let pageCount = 0;
        
        do {
          pageCount++;
          const params = { limit: 100 }; // Use 100 per page for efficiency
          if (nextCursor) {
            params.after = nextCursor;
          }
          
          console.log(`  📄 Page ${pageCount}: Fetching contacts...`);
          const response = await superChatService.fetchContacts(params);
          
          if (response.results && Array.isArray(response.results)) {
            allContacts = allContacts.concat(response.results);
            console.log(`    ✅ Got ${response.results.length} contacts (Total: ${allContacts.length})`);
          }
          
          // Check for next page
          nextCursor = response.pagination?.next_cursor || null;
          
          
          
        } while (nextCursor);
        
        console.log(`✅ Completed fetching contacts: ${allContacts.length} total contacts from ${pageCount} pages`);
        return allContacts;
      };
      
      // Fetch all contacts
      const allContacts = await fetchAllContacts();
      console.log(`📊 Found ${allContacts.length} total contacts`);
      
      // Analyze contacts
      const contactStats = {
        total_contacts: allContacts.length,
        with_names: 0,
        with_emails: 0,
        with_phones: 0,
        with_custom_attributes: 0
      };
      
      const contactDetails = allContacts.map(contact => {
        const hasName = !!(contact.first_name || contact.last_name);
        const hasEmail = !!(contact.handles && contact.handles.some(h => h.type === 'email'));
        const hasPhone = !!(contact.handles && contact.handles.some(h => h.type === 'phone'));
        const hasCustomAttributes = !!(contact.custom_attributes && Object.keys(contact.custom_attributes).length > 0);
        
        if (hasName) contactStats.with_names++;
        if (hasEmail) contactStats.with_emails++;
        if (hasPhone) contactStats.with_phones++;
        if (hasCustomAttributes) contactStats.with_custom_attributes++;
        
        return {
          id: contact.id,
          name: `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || 'Unnamed Contact',
          email: contact.handles?.find(h => h.type === 'email')?.value || 'No email',
          phone: contact.handles?.find(h => h.type === 'phone')?.value || 'No phone',
          gender: contact.gender || 'Not specified',
          has_custom_attributes: hasCustomAttributes,
          custom_attributes: contact.custom_attributes || {},
          created_at: contact.created_at,
          updated_at: contact.updated_at
        };
      });
      
      // Get conversations for each contact to calculate engagement
      const contactEngagement = [];
      
      for (const contact of allContacts.slice(0, 100)) { // Limit to first 100 for performance
        try {
          console.log(`🔄 Processing contact: ${contact.first_name} ${contact.last_name} (${contact.id})`);
          
          // Get conversations for this contact
          const conversations = await superChatService.fetchConversations({ 
            contact_id: contact.id, 
            limit: 1000 
          });
          
          const convItems = conversations?.results || [];
          
          contactEngagement.push({
            id: contact.id,
            name: `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || 'Unnamed Contact',
            total_conversations: convItems.length,
            last_conversation: convItems.length > 0 ? convItems[0].updated_at : null,
            engagement_level: convItems.length === 0 ? 'None' : 
                             convItems.length === 1 ? 'Low' : 
                             convItems.length <= 5 ? 'Medium' : 'High'
          });
          
          console.log(`  ✅ ${contact.first_name} ${contact.last_name}: ${convItems.length} conversations`);
          
        } catch (error) {
          console.error(`❌ Error processing contact ${contact.first_name} ${contact.last_name}:`, error.message);
          contactEngagement.push({
            id: contact.id,
            name: `${contact.first_name || ''} ${contact.last_name || ''}`.trim() || 'Unnamed Contact',
            total_conversations: 0,
            last_conversation: null,
            engagement_level: 'Unknown',
            error: error.message
          });
        }
      }

      const response = {
        success: true,
        data: {
          summary: contactStats,
          contact_details: contactDetails,
          contact_engagement: contactEngagement
        },
        message: `Successfully fetched analytics for ${allContacts.length} contacts`
      };

      console.log('✅ Contacts analytics completed successfully');
      res.json(response);
      
    } catch (error) {
      console.error('❌ Failed to get contacts analytics:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get contacts analytics',
        error: error.message
      });
    }
  },

  async getConversationsAnalytics(req, res) {
    try {
      console.log('🚀 Getting conversations analytics...');
      
      // Function to fetch all conversations with pagination
      const fetchAllConversations = async () => {
        let allConversations = [];
        let nextCursor = null;
        let pageCount = 0;
        
        do {
          pageCount++;
          const params = { limit: 100 }; // Use 100 per page for efficiency
          if (nextCursor) {
            params.after = nextCursor;
          }
          
          console.log(`  📄 Page ${pageCount}: Fetching conversations...`);
          const response = await superChatService.fetchConversations(params);
          
          if (response.results && Array.isArray(response.results)) {
            allConversations = allConversations.concat(response.results);
            console.log(`    ✅ Got ${response.results.length} conversations (Total: ${allConversations.length})`);
          }
          
          // Check for next page
          nextCursor = response.pagination?.next_cursor || null;
          
          
        } while (nextCursor);
        
        console.log(`✅ Completed fetching conversations: ${allConversations.length} total conversations from ${pageCount} pages`);
        return allConversations;
      };
      
      // Fetch all conversations
      const allConversations = await fetchAllConversations();
      console.log(`📊 Found ${allConversations.length} total conversations`);
      
      // Analyze conversations
      const conversationStats = {
        total_conversations: allConversations.length,
        by_status: {},
        by_channel: {},
        by_inbox: {},
        by_assigned_user: {}
      };
      
      // Status analysis
      allConversations.forEach(conv => {
        const status = conv.status || 'unknown';
        const channelType = conv.channel?.type || 'unknown';
        const inboxName = conv.inbox?.name || 'unknown';
        const assignedUsers = conv.assigned_users || [];
        
        // Count by status
        conversationStats.by_status[status] = (conversationStats.by_status[status] || 0) + 1;
        
        // Count by channel
        conversationStats.by_channel[channelType] = (conversationStats.by_channel[channelType] || 0) + 1;
        
        // Count by inbox
        conversationStats.by_inbox[inboxName] = (conversationStats.by_inbox[inboxName] || 0) + 1;
        
        // Count by assigned user
        if (assignedUsers.length > 0) {
          assignedUsers.forEach(userId => {
            conversationStats.by_assigned_user[userId] = (conversationStats.by_assigned_user[userId] || 0) + 1;
          });
        }
      });
      
      // Time-based analysis
      const today = new Date();
      const todayConversations = allConversations.filter(c => {
        const convDate = new Date(c.created_at || c.updated_at);
        return convDate.toDateString() === today.toDateString();
      }).length;
      
      const weekConversations = allConversations.filter(c => {
        const convDate = new Date(c.created_at || c.updated_at);
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        return convDate > weekAgo;
      }).length;
      
      const monthConversations = allConversations.filter(c => {
        const convDate = new Date(c.created_at || c.updated_at);
        const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        return convDate > monthAgo;
      }).length;
      
      // Response time analysis
      const responseTimes = allConversations
        .filter(c => c.first_response_at && c.created_at)
        .map(c => new Date(c.first_response_at) - new Date(c.created_at));
      
      const avgResponseTime = responseTimes.length > 0 
        ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length / (1000 * 60))
        : 0;
      
      // Convert stats to arrays for easier consumption
      const statusBreakdown = Object.entries(conversationStats.by_status).map(([status, count]) => ({
        status,
        count,
        percentage: ((count / allConversations.length) * 100).toFixed(2)
      }));
      
      const channelBreakdown = Object.entries(conversationStats.by_channel).map(([channel, count]) => ({
        channel,
        count,
        percentage: ((count / allConversations.length) * 100).toFixed(2)
      }));
      
      const inboxBreakdown = Object.entries(conversationStats.by_inbox).map(([inbox, count]) => ({
        inbox,
        count,
        percentage: ((count / allConversations.length) * 100).toFixed(2)
      }));

      const response = {
        success: true,
        data: {
          summary: {
            total_conversations: allConversations.length,
            today_conversations: todayConversations,
            week_conversations: weekConversations,
            month_conversations: monthConversations,
            avg_response_time_minutes: avgResponseTime
          },
          status_breakdown: statusBreakdown,
          channel_breakdown: channelBreakdown,
          inbox_breakdown: inboxBreakdown,
          assigned_user_breakdown: conversationStats.by_assigned_user
        },
        message: `Successfully fetched analytics for ${allConversations.length} conversations`
      };

      console.log('✅ Conversations analytics completed successfully');
      res.json(response);
      
    } catch (error) {
      console.error('❌ Failed to get conversations analytics:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get conversations analytics',
        error: error.message
      });
    }
  },

  // =============================
  // CONVERSATION MANAGEMENT ENDPOINTS
  // =============================

  async getConversationWithMessages(req, res) {
    try {
      const { conversationId } = req.params;
      console.log(`🚀 Getting conversation ${conversationId} with messages...`);
      
      // Get conversation details
      const conversation = await superChatService.getConversation(conversationId);
      
      if (!conversation) {
        return res.status(404).json({
          success: false,
          message: 'Conversation not found'
        });
      }
      
      // Get messages for this conversation
      const messages = await superChatService.getConversationMessages(conversationId);
      
      const response = {
        success: true,
        data: {
          conversation: {
            id: conversation.id,
            status: conversation.status,
            channel: conversation.channel,
            inbox: conversation.inbox,
            contacts: conversation.contacts,
            assigned_users: conversation.assigned_users,
            labels: conversation.labels,
            snoozed_until: conversation.snoozed_until,
            created_at: conversation.created_at,
            updated_at: conversation.updated_at
          },
          messages: messages?.results || []
        },
        message: 'Conversation with messages retrieved successfully'
      };
      
      res.json(response);
      
    } catch (error) {
      console.error('❌ Failed to get conversation with messages:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get conversation with messages',
        error: error.message
      });
    }
  },

  async sendMessageToConversation(req, res) {
    try {
      const { conversationId } = req.params;
      const { message, message_type = 'text' } = req.body;
      
      if (!message) {
        return res.status(400).json({
          success: false,
          message: 'Message content is required'
        });
      }
      
      console.log(`🚀 Sending message to conversation ${conversationId}...`);
      
      // Get conversation to find contact and channel
      const conversation = await superChatService.getConversation(conversationId);
      
      if (!conversation) {
        return res.status(404).json({
          success: false,
          message: 'Conversation not found'
        });
      }
      
      // Extract contact ID and channel ID from conversation
      const contactId = conversation.contacts?.[0]?.id;
      const channelId = conversation.channel?.id;
      
      if (!contactId || !channelId) {
        return res.status(400).json({
          success: false,
          message: 'Conversation missing contact or channel information'
        });
      }
      
      // Send message using SuperChat API
      const messageResponse = await superChatService.sendMessage(contactId, {
        channel_id: channelId,
        type: message_type,
        content: message_type === 'text' ? { text: message } : { media_url: message }
      });
      
      // Update conversation status if needed
      if (conversation.status === 'open') {
        await superChatService.updateConversation(conversationId, {
          status: 'pending',
          last_activity: new Date().toISOString()
        });
      }
      
      const response = {
        success: true,
        data: {
          message_id: messageResponse.id || 'pending',
          conversation_id: conversationId,
          status: 'sent',
          timestamp: new Date().toISOString()
        },
        message: 'Message sent successfully'
      };
      
      res.json(response);
      
    } catch (error) {
      console.error('❌ Failed to send message:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to send message',
        error: error.message
      });
    }
  },

  async updateConversationStatus(req, res) {
    try {
      const { conversationId } = req.params;
      const { status, assigned_user_id, labels, snoozed_until } = req.body;
      
      console.log(`🚀 Updating conversation ${conversationId} status...`);
      
      // Validate status
      const validStatuses = ['open', 'pending', 'resolved', 'closed', 'snoozed'];
      if (status && !validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
        });
      }
      
      // Update conversation
      const updateData = {};
      if (status) updateData.status = status;
      if (assigned_user_id) updateData.assigned_users = [assigned_user_id];
      if (labels) updateData.labels = labels;
      if (snoozed_until) updateData.snoozed_until = snoozed_until;
      
      updateData.updated_at = new Date().toISOString();
      
      const updatedConversation = await superChatService.updateConversation(conversationId, updateData);
      
      const response = {
        success: true,
        data: {
          conversation_id: conversationId,
          updated_fields: Object.keys(updateData),
          conversation: updatedConversation
        },
        message: 'Conversation updated successfully'
      };
      
      res.json(response);
      
    } catch (error) {
      console.error('❌ Failed to update conversation status:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to update conversation status',
        error: error.message
      });
    }
  },

  async assignConversation(req, res) {
    try {
      const { conversationId } = req.params;
      const { user_id } = req.body;
      
      if (!user_id) {
        return res.status(400).json({
          success: false,
          message: 'User ID is required for assignment'
        });
      }
      
      console.log(`🚀 Assigning conversation ${conversationId} to user ${user_id}...`);
      
      // Update conversation assignment
      const updatedConversation = await superChatService.updateConversation(conversationId, {
        assigned_users: [user_id],
        updated_at: new Date().toISOString()
      });
      
      const response = {
        success: true,
        data: {
          conversation_id: conversationId,
          assigned_user_id: user_id,
          conversation: updatedConversation
        },
        message: 'Conversation assigned successfully'
      };
      
      res.json(response);
      
    } catch (error) {
      console.error('❌ Failed to assign conversation:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to assign conversation',
        error: error.message
      });
    }
  },

  async getOpenConversations(req, res) {
    try {
      const { limit = 50, page = 1, inbox_id, channel_type } = req.query;
      
      console.log('🚀 Getting open conversations...');
      
      // Build filters
      const filters = { status: 'open' };
      if (inbox_id) filters.inbox_id = inbox_id;
      if (channel_type) filters.channel_type = channel_type;
      
      // Get open conversations
      const conversations = await superChatService.fetchConversations({
        status: 'open',
        limit: parseInt(limit),
        page: parseInt(page),
        inbox_id: filters.inbox_id,
        channel_type: filters.channel_type
      });
      
      const response = {
        success: true,
        data: {
          conversations: conversations.results || [],
          pagination: conversations.pagination || {},
          filters: filters
        },
        message: `Retrieved ${conversations.results?.length || 0} open conversations`
      };
      
      res.json(response);
      
    } catch (error) {
      console.error('❌ Failed to get open conversations:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get open conversations',
        error: error.message
      });
    }
  },

  // =============================
  // BATCH ANALYTICS ENDPOINTS (For 10M+ records)
  // =============================

  async getChannelsAnalyticsBatch(req, res) {
    try {
      const { batchSize = 1000, maxBatches = null } = req.query;
      
      console.log('🚀 Getting batch channels analytics...');
      
      const result = await batchAnalyticsService.getChannelsAnalyticsBatch({
        batchSize: parseInt(batchSize),
        maxBatches: maxBatches ? parseInt(maxBatches) : null
      });
      
      res.json(result);
      
    } catch (error) {
      console.error('❌ Failed to get batch channels analytics:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get batch channels analytics',
        error: error.message
      });
    }
  },

  async getContactsAnalyticsBatch(req, res) {
    try {
      const { batchSize = 1000, maxBatches = null } = req.query;
      
      console.log('🚀 Getting batch contacts analytics...');
      
      const result = await batchAnalyticsService.getContactsAnalyticsBatch({
        batchSize: parseInt(batchSize),
        maxBatches: maxBatches ? parseInt(maxBatches) : null
      });
      
      res.json(result);
      
    } catch (error) {
      console.error('❌ Failed to get batch contacts analytics:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get batch contacts analytics',
        error: error.message
      });
    }
  },

  async getUsersAnalyticsBatch(req, res) {
    try {
      const { batchSize = 1000, maxBatches = null } = req.query;
      
      console.log('🚀 Getting batch users analytics...');
      
      const result = await batchAnalyticsService.getUsersAnalyticsBatch({
        batchSize: parseInt(batchSize),
        maxBatches: maxBatches ? parseInt(maxBatches) : null
      });
      
      res.json(result);
      
    } catch (error) {
      console.error('❌ Failed to get batch users analytics:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get batch users analytics',
        error: error.message
      });
    }
  },
};

module.exports = superChatController;


