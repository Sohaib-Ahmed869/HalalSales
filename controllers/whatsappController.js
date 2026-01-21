const { handleIncomingWhatsAppMessage } = require('../services/whatsappService');
/**
 * Webhook endpoint for incoming WhatsApp messages
 * POST /api/whatsapp/webhook
 */
exports.whatsappWebhook = async (req, res) => {
    try {
        console.log('📥 WhatsApp Webhook Received:', req.body);

        // Twilio sends data as form-urlencoded
        const webhookData = req.body;

        // Handle the message asynchronously
        handleIncomingWhatsAppMessage(webhookData)
            .then(result => {
                console.log('✅ WhatsApp message handled:', result);
            })
            .catch(error => {
                console.error('❌ Error handling WhatsApp:', error);
            });

        // Respond immediately to Twilio (must respond within 15 seconds)
        res.status(200).send('');

    } catch (error) {
        console.error('Error in WhatsApp webhook:', error);
        res.status(500).send('');
    }
};

/**
 * Webhook verification (for Twilio sandbox setup)
 * GET /api/whatsapp/webhook
 */
exports.verifyWebhook = (req, res) => {
    console.log('📋 WhatsApp Webhook Verification');
    res.status(200).send('Webhook verified');
};