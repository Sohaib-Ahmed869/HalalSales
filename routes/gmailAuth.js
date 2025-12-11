const express = require('express');
const router = express.Router();
const gmailService = require('../services/gmailService');

/**
 * GET /api/gmail/auth-url
 * Get OAuth2 authorization URL
 */
router.get('/auth-url', (req, res) => {
    try {
        const authUrl = gmailService.getAuthUrl();
        res.json({
            success: true,
            authUrl,
            instructions: 'Visit this URL to authorize Gmail access, then use the code in /callback',
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * GET /api/gmail/callback?code=...
 * Exchange auth code for tokens
 */
router.get('/callback', async (req, res) => {
    try {
        const { code } = req.query;

        if (!code) {
            return res.status(400).json({
                success: false,
                error: 'No authorization code provided',
            });
        }

        const tokens = await gmailService.getTokenFromCode(code);

        res.json({
            success: true,
            message: 'Authorization successful!',
            instructions: 'Copy the refresh_token to your .env file as GMAIL_REFRESH_TOKEN',
            tokens: {
                refresh_token: tokens.refresh_token,
            },
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

module.exports = router;