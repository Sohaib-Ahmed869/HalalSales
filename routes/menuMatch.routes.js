const express = require('express');
const router = express.Router();
const menuMatchController = require('../controllers/menuMatch.controller');
const { auth, checkRole } = require("../middleware/auth");
router.post('/assignment/:assignmentId/start', auth, menuMatchController.startMenuMatching);
router.get('/assignment/:assignmentId', auth, menuMatchController.getMenuMatch);
router.put('/assignment/:assignmentId/match/:matchIndex', auth, menuMatchController.updateMatchStatus);

module.exports = router;