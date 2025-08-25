const express = require('express');
const router = express.Router();
const SuperChatBatchController = require('../controllers/superChatBatchController');
const { auth, checkRole } = require('../middleware/auth');

// Initialize controller
const batchController = new SuperChatBatchController();

// =============================
// BATCH PROCESSING ROUTES
// =============================

// Run contacts batch processing
router.post('/batch/contacts', 
  auth, 
  checkRole(['admin']), 
  batchController.runContactsBatch.bind(batchController)
);

// Run conversations batch processing
router.post('/batch/conversations', 
  auth, 
  checkRole(['admin']), 
  batchController.runConversationsBatch.bind(batchController)
);

// Run full batch sync (contacts + conversations)
router.post('/batch/full-sync', 
  auth, 
  checkRole(['admin']), 
  batchController.runFullBatchSync.bind(batchController)
);

// =============================
// DATA RETRIEVAL ROUTES
// =============================

// Get all stored contacts with pagination and search
router.get('/contacts', 
  auth, 
  batchController.getContacts.bind(batchController)
);

// Get all stored conversations with pagination and filters
router.get('/conversations', 
  auth, 
  batchController.getConversations.bind(batchController)
);

// Get data statistics (counts)
router.get('/stats', 
  auth, 
  batchController.getDataStats.bind(batchController)
);

// =============================
// CONTACT SPECIFIC ROUTES
// =============================

// Search contacts (must come BEFORE :contactId route)
router.get('/contacts/search', 
  auth, 
  batchController.searchContacts.bind(batchController)
);

// Get specific contact by ID
router.get('/contacts/:contactId', 
  auth, 
  batchController.getContactById.bind(batchController)
);

// =============================
// CONVERSATION SPECIFIC ROUTES
// =============================

// Get specific conversation by ID
router.get('/conversations/:conversationId', 
  auth, 
  batchController.getConversationById.bind(batchController)
);

module.exports = router;
