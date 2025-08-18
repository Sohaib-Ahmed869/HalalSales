const SuperChatBatchService = require('../services/superChatBatchService');

class SuperChatBatchController {
  constructor() {
    this.batchService = new SuperChatBatchService();
  }

  // =============================
  // BATCH PROCESSING ENDPOINTS
  // =============================

  async runContactsBatch(req, res) {
    try {
      console.log('🚀 Starting contacts batch processing...');
      
      const result = await this.batchService.batchFetchContacts();
      
      res.json({
        success: true,
        data: result,
        message: `Contacts batch completed: ${result.total_fetched} fetched, ${result.new_stored} new, ${result.updated} updated`
      });
      
    } catch (error) {
      console.error('❌ Contacts batch processing failed:', error);
      res.status(500).json({
        success: false,
        message: 'Contacts batch processing failed',
        error: error.message
      });
    }
  }

  async runConversationsBatch(req, res) {
    try {
      console.log('🚀 Starting conversations batch processing...');
      
      const result = await this.batchService.batchFetchConversations();
      
      res.json({
        success: true,
        data: result,
        message: `Conversations batch completed: ${result.total_fetched} fetched, ${result.new_stored} new, ${result.updated} updated`
      });
      
    } catch (error) {
      console.error('❌ Conversations batch processing failed:', error);
      res.status(500).json({
        success: false,
        message: 'Conversations batch processing failed',
        error: error.message
      });
    }
  }

  async runFullBatchSync(req, res) {
    try {
      console.log('🚀 Starting full batch sync (contacts + conversations)...');
      
      const result = await this.batchService.runFullBatchSync();
      
      res.json({
        success: true,
        data: result,
        message: `Full batch sync completed in ${result.duration_seconds} seconds`
      });
      
    } catch (error) {
      console.error('❌ Full batch sync failed:', error);
      res.status(500).json({
        success: false,
        message: 'Full batch sync failed',
        error: error.message
      });
    }
  }

  // =============================
  // DATA RETRIEVAL ENDPOINTS
  // =============================

  async getContacts(req, res) {
    try {
      const { limit = 100, offset = 0, search = '' } = req.query;
      
      const result = await this.batchService.getStoredContacts(
        parseInt(limit),
        parseInt(offset),
        search
      );
      
      res.json({
        success: true,
        data: result,
        message: `Retrieved ${result.results.length} contacts`
      });
      
    } catch (error) {
      console.error('❌ Failed to get contacts:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get contacts',
        error: error.message
      });
    }
  }

  async getConversations(req, res) {
    try {
      const { limit = 100, offset = 0, status = '', search = '' } = req.query;
      
      const result = await this.batchService.getStoredConversations(
        parseInt(limit),
        parseInt(offset),
        status,
        search
      );
      
      res.json({
        success: true,
        data: result,
        message: `Retrieved ${result.results.length} conversations`
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

  async getDataStats(req, res) {
    try {
      const stats = await this.batchService.getStoredDataStats();
      
      res.json({
        success: true,
        data: stats,
        message: 'Data statistics retrieved successfully'
      });
      
    } catch (error) {
      console.error('❌ Failed to get data stats:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get data stats',
        error: error.message
      });
    }
  }

  // =============================
  // CONTACT SPECIFIC ENDPOINTS
  // =============================

  async getContactById(req, res) {
    try {
      const { contactId } = req.params;
      
      const SuperChatContact = require('../models/SuperChatContact');
      const contact = await SuperChatContact.findOne({ contact_id: contactId });
      
      if (!contact) {
        return res.status(404).json({
          success: false,
          message: 'Contact not found'
        });
      }
      
      res.json({
        success: true,
        data: contact,
        message: 'Contact retrieved successfully'
      });
      
    } catch (error) {
      console.error('❌ Failed to get contact:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get contact',
        error: error.message
      });
    }
  }

  async searchContacts(req, res) {
    try {
      const { q, limit = 20 } = req.query;
      
      if (!q || q.length < 2) {
        return res.status(400).json({
          success: false,
          message: 'Search query must be at least 2 characters'
        });
      }
      
      const SuperChatContact = require('../models/SuperChatContact');
      const contacts = await SuperChatContact.searchContacts(q, parseInt(limit));
      
      res.json({
        success: true,
        data: {
          results: contacts,
          total: contacts.length,
          query: q
        },
        message: `Found ${contacts.length} contacts matching "${q}"`
      });
      
    } catch (error) {
      console.error('❌ Failed to search contacts:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to search contacts',
        error: error.message
      });
    }
  }

  // =============================
  // CONVERSATION SPECIFIC ENDPOINTS
  // =============================

  async getConversationById(req, res) {
    try {
      const { conversationId } = req.params;
      
      const SuperChatConversation = require('../models/SuperChatConversation');
      const conversation = await SuperChatConversation.findOne({ conversation_id: conversationId });
      
      if (!conversation) {
        return res.status(404).json({
          success: false,
          message: 'Conversation not found'
        });
      }
      
      res.json({
        success: true,
        data: conversation,
        message: 'Conversation retrieved successfully'
      });
      
    } catch (error) {
      console.error('❌ Failed to get conversation:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get conversation',
        error: error.message
      });
    }
  }
}

module.exports = SuperChatBatchController;
