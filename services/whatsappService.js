const twilio = require('twilio');
const Vendor = require('../models/Vendor');
const RFQ = require('../models/RFQ');
const Item = require('../models/item');
const { parseRFQResponseWithAI } = require('./aiService');
const { generateRFQPDF } = require('../utils/pdfGenerator1');
const fs = require('fs');
const path = require('path');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioWhatsAppNumber = process.env.TWILIO_WHATSAPP_NUMBER;

// Validate Twilio configuration on startup
if (!accountSid || !authToken || !twilioWhatsAppNumber) {
    console.error('⚠️ TWILIO CONFIGURATION MISSING!');
    console.error('Please set the following in .env:');
    console.error('- TWILIO_ACCOUNT_SID');
    console.error('- TWILIO_AUTH_TOKEN');
    console.error('- TWILIO_WHATSAPP_NUMBER (e.g., whatsapp:+14155238886)');
}

const client = twilio(accountSid, authToken);

// Chat history management
const CHAT_HISTORY_DIR = path.join(__dirname, '../chat_history');
const CHAT_EXPIRY_TIME = 60 * 60 * 1000; // 1 hour in milliseconds

/**
 * Initialize chat history directory
 */
async function initChatHistory() {
    try {
        if (!fs.existsSync(CHAT_HISTORY_DIR)) {
            fs.mkdirSync(CHAT_HISTORY_DIR, { recursive: true });
            console.log('✅ Chat history directory created');
        }
    } catch (error) {
        console.error('⚠️ Error creating chat history directory:', error.message);
    }
}

// Initialize on startup
initChatHistory().catch(err => console.error('Init error:', err));

/**
 * Get chat history for a phone number
 */
async function getChatHistory(phoneNumber) {
    try {
        const sanitizedPhone = phoneNumber.replace(/[^0-9]/g, '');
        const filePath = path.join(CHAT_HISTORY_DIR, `${sanitizedPhone}.json`);

        if (!fs.existsSync(filePath)) {
            return { messages: [], lastUpdated: Date.now() };
        }

        const data = fs.readFileSync(filePath, 'utf8');
        const history = JSON.parse(data);

        // Check if history has expired
        const now = Date.now();
        if (now - history.lastUpdated > CHAT_EXPIRY_TIME) {
            await clearChatHistory(phoneNumber);
            return { messages: [], lastUpdated: now };
        }

        return history;
    } catch (error) {
        console.error('⚠️ Error reading chat history:', error.message);
        return { messages: [], lastUpdated: Date.now() };
    }
}

/**
 * Save chat history for a phone number
 */
async function saveChatHistory(phoneNumber, message, direction) {
    try {
        const sanitizedPhone = phoneNumber.replace(/[^0-9]/g, '');
        const filePath = path.join(CHAT_HISTORY_DIR, `${sanitizedPhone}.json`);

        let history = await getChatHistory(phoneNumber);

        history.messages.push({
            direction,
            message,
            timestamp: new Date().toISOString()
        });

        history.lastUpdated = Date.now();

        // Keep only last 20 messages
        if (history.messages.length > 20) {
            history.messages = history.messages.slice(-20);
        }

        fs.writeFileSync(filePath, JSON.stringify(history, null, 2));
    } catch (error) {
        console.error('⚠️ Error saving chat history:', error.message);
    }
}

/**
 * Clear chat history for a phone number
 */
async function clearChatHistory(phoneNumber) {
    try {
        const sanitizedPhone = phoneNumber.replace(/[^0-9]/g, '');
        const filePath = path.join(CHAT_HISTORY_DIR, `${sanitizedPhone}.json`);

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`🗑️ Cleared expired chat history for ${sanitizedPhone}`);
        }
    } catch (error) {
        console.error('⚠️ Error clearing chat history:', error.message);
    }
}

/**
 * Clean up expired chat histories (run periodically)
 */
async function cleanupExpiredChats() {
    try {
        if (!fs.existsSync(CHAT_HISTORY_DIR)) {
            return;
        }

        const files = fs.readdirSync(CHAT_HISTORY_DIR);
        const now = Date.now();

        for (const file of files) {
            if (file.endsWith('.json')) {
                try {
                    const filePath = path.join(CHAT_HISTORY_DIR, file);
                    const data = fs.readFileSync(filePath, 'utf8');
                    const history = JSON.parse(data);

                    if (now - history.lastUpdated > CHAT_EXPIRY_TIME) {
                        fs.unlinkSync(filePath);
                        console.log(`🗑️ Cleaned up expired chat: ${file}`);
                    }
                } catch (err) {
                    console.error(`⚠️ Error processing ${file}:`, err.message);
                }
            }
        }
    } catch (error) {
        console.error('⚠️ Error cleaning up expired chats:', error.message);
    }
}

// Run cleanup every 30 minutes
setInterval(cleanupExpiredChats, 30 * 60 * 1000);

/**
 * Check for inappropriate language
 */
function containsInappropriateLanguage(message) {
    const inappropriateWords = [
        'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'damn',
        'idiot', 'stupid', 'moron', 'dumb', 'retard'
    ];

    const messageLower = message.toLowerCase();
    return inappropriateWords.some(word => messageLower.includes(word));
}

/**
 * Send RFQ to vendor via WhatsApp using the Meta Cloud API + AI outbound agent.
 * This helper used to call Twilio — it now delegates to the conversational
 * WhatsApp AI agent (Meta Cloud API) so all WhatsApp RFQ traffic goes through
 * a single code path. The legacy Twilio helpers below are kept only for
 * non-RFQ general-chat use cases.
 */
async function sendRFQViaWhatsApp(rfqId, vendorCode) {
    console.log(`📱 [Meta] Sending RFQ ${rfqId} to vendor ${vendorCode} via WhatsApp Business`);
    const whatsappOutboundAgent = require('../agents/whatsappOutboundAgent');
    const result = await whatsappOutboundAgent.sendRFQ({
        rfqId,
        vendorCodes: [vendorCode],
    });

    const vendorResult = result?.results?.[0];
    if (!vendorResult || !vendorResult.success) {
        const err = new Error(vendorResult?.error || 'WhatsApp send failed');
        err.details = vendorResult;
        throw err;
    }

    return {
        success: true,
        messageId: vendorResult.messageId,
        vendorName: vendorResult.vendorName,
        phoneNumber: vendorResult.vendorCode,
    };
}

/**
 * Handle incoming WhatsApp messages (webhook)
 */
async function handleIncomingWhatsAppMessage(webhookData) {
    try {
        const {
            From: senderNumber,
            To: recipientNumber,
            Body: messageBody,
            MessageSid: messageSid,
            MediaUrl0: mediaUrl,
            NumMedia: numMedia
        } = webhookData;

        console.log(`📥 Received WhatsApp from ${senderNumber}: ${messageBody}`);

        // Save incoming message to chat history (non-blocking)
        saveChatHistory(senderNumber, messageBody, 'incoming').catch(err =>
            console.error('Error saving history:', err.message)
        );

        // Find vendor by phone number
        const vendor = await findVendorByPhone(senderNumber);

        if (!vendor) {
            console.log('⚠️ Contact not found for phone:', senderNumber);

            // Handle as general customer
            const generalContact = {
                CardName: 'Customer',
                CardCode: 'GENERAL'
            };

            const generalResponse = await generateGeneralChatResponse(
                messageBody,
                generalContact,
                senderNumber
            );

            await sendWhatsAppMessage(senderNumber, generalResponse);
            saveChatHistory(senderNumber, generalResponse, 'outgoing').catch(err =>
                console.error('Error saving history:', err.message)
            );

            return { success: true, type: 'general_chat', reason: 'Unknown contact' };
        }

        console.log(`✅ Identified contact: ${vendor.CardName} (${vendor.CardCode})`);

        // Find active RFQ for this vendor
        const activeRFQ = await RFQ.findOne({
            'vendorsContacted.vendorCode': vendor.CardCode,
            'vendorsContacted.status': { $in: ['sent', 'opened'] },
            status: { $in: ['sent', 'in_progress'] }
        }).sort({ dateIssued: -1 });

        if (!activeRFQ) {
            console.log('⚠️ No active RFQ found for contact:', vendor.CardCode);

            // GENERAL CHAT - No active RFQ
            const generalResponse = await generateGeneralChatResponse(
                messageBody,
                vendor,
                senderNumber
            );

            await sendWhatsAppMessage(senderNumber, generalResponse);
            saveChatHistory(senderNumber, generalResponse, 'outgoing').catch(err =>
                console.error('Error saving history:', err.message)
            );

            return { success: true, type: 'general_chat' };
        }

        console.log(`📋 Found active RFQ: ${activeRFQ.rfqNumber}`);

        // Get vendor contact in RFQ
        const vendorContact = activeRFQ.vendorsContacted.find(
            v => v.vendorCode === vendor.CardCode
        );

        if (!vendorContact) {
            console.log('⚠️ Vendor contact not found in RFQ');
            return { success: false, reason: 'Vendor not in RFQ' };
        }

        // Initialize whatsappHistory if it doesn't exist
        if (!vendorContact.whatsappHistory) {
            vendorContact.whatsappHistory = [];
        }

        // Download media if present (for PDF quotations)
        let mediaContent = null;
        if (parseInt(numMedia) > 0 && mediaUrl) {
            console.log('📎 Downloading media attachment...');
            mediaContent = await downloadWhatsAppMedia(mediaUrl);
        }

        // STEP 1: Parse response using AI
        console.log('🤖 Analyzing message with AI...');
        const parsedResponse = await parseRFQResponseWithAI({
            rfqNumber: activeRFQ.rfqNumber,
            vendorName: vendor.CardName,
            vendorEmail: vendor.email,
            emailBody: messageBody,
            emailSubject: `WhatsApp Response - ${activeRFQ.rfqNumber}`,
            date: new Date(),
            pdfContent: mediaContent
        });

        console.log('🤖 AI Analysis Result:', {
            isValidResponse: parsedResponse.isValidResponse,
            responseType: parsedResponse.responseType,
            totalAmount: parsedResponse.totalQuotedAmount
        });

        // Add message to history (always store)
        vendorContact.whatsappHistory.push({
            direction: 'incoming',
            message: messageBody,
            timestamp: new Date(),
            messageSid: messageSid,
            mediaUrl: mediaUrl || null,
            parsedData: parsedResponse.isValidResponse ? parsedResponse : null
        });

        // STEP 2: Handle based on response type
        if (parsedResponse.isValidResponse && parsedResponse.responseType === 'quotation') {
            // ✅ QUOTATION RECEIVED - Store it
            console.log('✅ Valid quotation received via WhatsApp');

            vendorContact.status = 'responded';
            vendorContact.responseDate = new Date();
            vendorContact.quotationData = {
                quotedItems: parsedResponse.quotedItems || [],
                totalQuotedAmount: parsedResponse.totalQuotedAmount,
                currency: parsedResponse.currency || 'EUR',
                deliveryTimeInDays: parsedResponse.deliveryTimeInDays,
                paymentTerms: parsedResponse.paymentTerms,
                validityPeriod: parsedResponse.validityPeriod,
                additionalNotes: parsedResponse.additionalNotes,
                isValidQuotation: true,
                parsingStatus: 'success',
                source: 'whatsapp'
            };

            vendorContact.rawWhatsAppContent = {
                body: messageBody,
                receivedDate: new Date(),
                messageSid: messageSid,
                mediaUrl: mediaUrl || null,
                pdfContent: mediaContent
            };

            await activeRFQ.save();

            // Send confirmation
            const confirmationMessage =
                `✅ Thank you for your quotation for RFQ ${activeRFQ.rfqNumber}!\n\n` +
                `We have received your quote of ${parsedResponse.currency || 'EUR'} ${parsedResponse.totalQuotedAmount?.toLocaleString()}.\n\n` +
                `Our team will review it and get back to you soon.\n\n` +
                `Best regards,\nHalal Foods Team`;

            await sendWhatsAppMessage(senderNumber, confirmationMessage);
            saveChatHistory(senderNumber, confirmationMessage, 'outgoing').catch(err =>
                console.error('Error saving history:', err.message)
            );

            // Store outgoing confirmation
            vendorContact.whatsappHistory.push({
                direction: 'outgoing',
                message: confirmationMessage,
                timestamp: new Date()
            });

            await activeRFQ.save();

            return { success: true, type: 'quotation_received', rfqNumber: activeRFQ.rfqNumber };

        } else if (parsedResponse.responseType === 'question') {
            // ❓ QUESTION - Generate AI response
            console.log('❓ Contact has a question');

            await activeRFQ.save(); // Save the incoming message

            // Check if question is related to RFQ or general
            const isRFQRelated = await isQuestionRFQRelated(messageBody, activeRFQ);

            let aiResponse;
            if (isRFQRelated) {
                // RFQ-specific question
                aiResponse = await generateAIResponseToQuestion(
                    messageBody,
                    activeRFQ,
                    vendor
                );
            } else {
                // General question (don't mention RFQ)
                aiResponse = await generateGeneralChatResponse(
                    messageBody,
                    vendor,
                    senderNumber
                );
            }

            await sendWhatsAppMessage(senderNumber, aiResponse);
            saveChatHistory(senderNumber, aiResponse, 'outgoing').catch(err =>
                console.error('Error saving history:', err.message)
            );

            // Store outgoing message in history
            vendorContact.whatsappHistory.push({
                direction: 'outgoing',
                message: aiResponse,
                timestamp: new Date()
            });

            await activeRFQ.save();

            return { success: true, type: 'question_answered' };

        } else {
            // 🤷 UNCLEAR RESPONSE - Ask for clarification
            console.log('⚠️ Could not parse response clearly');

            await activeRFQ.save(); // Save the incoming message

            const clarificationMessage =
                `Thank you for your message regarding RFQ ${activeRFQ.rfqNumber}.\n\n` +
                `We didn't quite understand your response. Could you please provide:\n\n` +
                `1. Total quoted price\n` +
                `2. Delivery time\n` +
                `3. Payment terms\n\n` +
                `Or you can send your quotation as a PDF attachment.\n\n` +
                `If you have a question, please ask and we'll be happy to help!\n\n` +
                `Best regards,\nHalal Foods Team`;

            await sendWhatsAppMessage(senderNumber, clarificationMessage);
            saveChatHistory(senderNumber, clarificationMessage, 'outgoing').catch(err =>
                console.error('Error saving history:', err.message)
            );

            // Store outgoing message
            vendorContact.whatsappHistory.push({
                direction: 'outgoing',
                message: clarificationMessage,
                timestamp: new Date()
            });

            await activeRFQ.save();

            return { success: true, type: 'clarification_requested' };
        }

    } catch (error) {
        console.error('❌ Error handling WhatsApp message:', error);

        // Send error message to sender
        try {
            const errorMsg = "We encountered an error processing your message. Please try again or contact us at +33 1 79 64 84 05";
            await sendWhatsAppMessage(webhookData.From, errorMsg);
            saveChatHistory(webhookData.From, errorMsg, 'outgoing').catch(err =>
                console.error('Error saving history:', err.message)
            );
        } catch (sendError) {
            console.error('Failed to send error message:', sendError);
        }

        throw error;
    }
}

/**
 * Check if question is related to RFQ
 */
async function isQuestionRFQRelated(message, rfq) {
    const messageLower = message.toLowerCase();
    const rfqKeywords = [
        'rfq', 'quotation', 'quote', 'delivery', 'payment terms',
        'due date', 'specification', 'quantity', 'unit price',
        rfq.rfqNumber.toLowerCase()
    ];

    // Check for RFQ-related keywords
    const hasRFQKeyword = rfqKeywords.some(keyword => messageLower.includes(keyword));

    // Check for item names from RFQ
    const hasItemReference = rfq.items.some(item =>
        messageLower.includes(item.productName.toLowerCase())
    );

    return hasRFQKeyword || hasItemReference;
}

/**
 * Generate AI response for general chat
 */
async function generateGeneralChatResponse(message, contact, phoneNumber) {
    try {
        const messageLower = message.toLowerCase();

        // Get chat history for context
        const chatHistory = await getChatHistory(phoneNumber);
        const recentMessages = chatHistory.messages.slice(-5);

        // Check if this is first message
        const isFirstMessage = chatHistory.messages.length === 0;
        const greeting = isFirstMessage ? `Hello ${contact.CardName},\n\n` : '';

        // Check for inappropriate language
        if (containsInappropriateLanguage(message)) {
            return `${greeting}` +
                `We appreciate your message, but we kindly ask you to maintain a respectful tone in our communication.\n\n` +
                `If you have any concerns or issues, please feel free to share them professionally, and we'll be happy to assist you.\n\n` +
                `For immediate assistance, please call us at +33 1 79 64 84 05\n\n` +
                `Best regards,\nHalal Foods Team`;
        }

        // Check for location queries
        if (messageLower.includes('location') || messageLower.includes('address') ||
            messageLower.includes('where are you') || messageLower.includes('where is')) {
            return `${greeting}` +
                `📍 Our location:\n` +
                `32 rue raspail, Passage Ste Foix\n` +
                `93120 La Courneuve, France\n\n` +
                `You can visit us during business hours or contact us at:\n` +
                `📞 +33 1 79 64 84 05\n\n` +
                `Best regards,\nHalal Foods Team`;
        }

        // Check for delivery queries
        if (messageLower.includes('deliver') || messageLower.includes('delivery') ||
            messageLower.includes('shipping') || messageLower.includes('ship')) {

            if (messageLower.includes('when') || messageLower.includes('time') ||
                messageLower.includes('how long') || messageLower.includes('how soon')) {
                // Delivery time query
                return `${greeting}` +
                    `For delivery timeframes and scheduling, please contact our procurement team directly:\n\n` +
                    // `For delivery timeframes and scheduling, please contact our procurement team directly:\n\n` +
                    `📞 +33 1 79 64 84 05\n\n` +
                    `They will provide you with accurate delivery estimates based on your location and order details.\n\n` +
                    `Best regards,\nHalal Foods Team`;
            } else {
                // General delivery info
                return `${greeting}` +
                    `We offer two convenient options:\n\n` +
                    `🚚 *Delivery* - We can deliver to your location\n` +
                    `🏪 *Pick-up* - Collect your order from our location:\n` +
                    `   32 rue raspail, Passage Ste Foix\n` +
                    `   93120 La Courneuve, France\n\n` +
                    `To place an order and discuss delivery details, please call:\n` +
                    `📞 +33 1 79 64 84 05\n\n` +
                    `Best regards,\nHalal Foods Team`;
            }
        }

        // Check for ordering queries
        if (messageLower.includes('order') || messageLower.includes('purchase') ||
            messageLower.includes('buy') || messageLower.includes('place order')) {
            return `${greeting}` +
                `To place an order, please call our team:\n\n` +
                `📞 +33 1 79 64 84 05\n\n` +
                `Our team will assist you with:\n` +
                `• Product availability\n` +
                `• Pricing\n` +
                `• Order placement\n` +
                `• Delivery or pick-up arrangements\n\n` +
                `We look forward to serving you!\n\n` +
                `Best regards,\nHalal Foods Team`;
        }

        // Check for product queries
        const productKeywords = [
            'product', 'products', 'item', 'items', 'stock', 'available',
            'price', 'similar', 'alternative', 'offer', 'offered', 'sell',
            'selling', 'fries', 'chicken', 'meat', 'food', 'halal'
        ];

        const isProductQuery = productKeywords.some(keyword => messageLower.includes(keyword));

        if (isProductQuery) {
            // Extract search terms
            const searchTerms = message.toLowerCase()
                .replace(/what|are|the|for|do|you|have|any|offer|offered|selling|sell|can|i|get/gi, '')
                .trim()
                .split(' ')
                .filter(word => word.length > 2);

            const searchQuery = searchTerms.length > 0 ? searchTerms.join('|') : message;

            // Query ACTIVE items only
            const items = await Item.find({
                $and: [
                    {
                        $or: [
                            { ItemName: { $regex: searchQuery, $options: 'i' } },
                            { ForeignName: { $regex: searchQuery, $options: 'i' } }
                        ]
                    },
                    { Valid: 'tYES' },
                    { Frozen: { $ne: 'tYES' } }
                ]
            }).limit(15);

            if (items.length > 0) {
                let response = `${greeting}`;
                response += `Here are the products we offer:\n\n`;

                items.forEach((item, i) => {
                    const stockStatus = item.QuantityOnStock > 0 ? '✅ In Stock' : '⏳ Available on order';
                    response += `${i + 1}. *${item.ItemName}*\n`;
                    response += `   Status: ${stockStatus}\n`;
                    if (item.QuantityOnStock > 0) {
                        response += `   Stock: ${item.QuantityOnStock}\n`;
                    }
                    response += `\n`;
                });

                response += `To place an order or get pricing details:\n`;
                response += `📞 Call: +33 1 79 64 84 05\n\n`;
                response += `Best regards,\nHalal Foods Team`;

                return response;
            } else {
                return `${greeting}` +
                    `We don't currently have exact matches for "${searchTerms.join(' ')}" in our active inventory.\n\n` +
                    `Please call our team to check availability or discuss alternatives:\n` +
                    `📞 +33 1 79 64 84 05\n\n` +
                    `Best regards,\nHalal Foods Team`;
            }
        }

        // Check for greetings
        if (messageLower.match(/^(hello|hi|hey|bonjour|salam|salaam)/)) {
            return `${greeting}` +
                `Welcome to Halal Foods. How can we help you today?\n\n` +
                `You can ask about:\n` +
                `• Our products\n` +
                `• Placing an order\n` +
                `• Delivery options\n` +
                `• Our location\n\n` +
                `Or call us directly at:\n` +
                `📞 +33 1 79 64 84 05\n\n` +
                `Best regards,\nHalal Foods Team`;
        }

        // Check for thank you messages
        if (messageLower.match(/thank|thanks|merci|shukran/)) {
            return `${greeting}` +
                `You're welcome! 😊\n\n` +
                `Feel free to reach out anytime you need assistance.\n\n` +
                `📞 +33 1 79 64 84 05\n\n` +
                `Best regards,\nHalal Foods Team`;
        }

        // Default response
        let contextInfo = '';
        if (recentMessages.length > 0) {
            contextInfo = `\n\n(We've noted your previous messages and are here to continue helping you)`;
        }

        return `${greeting}` +
            `Thank you for your message.${contextInfo}\n\n` +
            `For assistance with:\n` +
            `• Product information\n` +
            `• Placing orders\n` +
            `• Delivery options\n` +
            `• Any other inquiries\n\n` +
            `Please call us at:\n` +
            `📞 +33 1 79 64 84 05\n\n` +
            `Or visit us at:\n` +
            `📍 32 rue raspail, Passage Ste Foix, 93120 La Courneuve, France\n\n` +
            `Best regards,\nHalal Foods Team`;

    } catch (error) {
        console.error('⚠️ Error generating general chat response:', error.message);
        return `Hello ${contact.CardName},\n\n` +
            `Thank you for your message. Please contact us at:\n` +
            `📞 +33 1 79 64 84 05\n\n` +
            `Best regards,\nHalal Foods Team`;
    }
}

/**
 * Send WhatsApp message
 */
async function sendWhatsAppMessage(to, body) {
    try {
        const message = await client.messages.create({
            from: twilioWhatsAppNumber,
            to: to,
            body: body
        });

        console.log(`✅ WhatsApp message sent: ${message.sid}`);
        return message;
    } catch (error) {
        console.error('❌ Error sending WhatsApp message:', error);
        throw error;
    }
}

/**
 * Generate RFQ WhatsApp message
 */
function generateRFQWhatsAppMessage(rfq, vendor) {
    const isFirstContact = !rfq.vendorsContacted.some(v => v.vendorCode === vendor.CardCode && v.whatsappSentDate);
    const greeting = isFirstContact ?
        `Hello ${vendor.CardName},\n\n` :
        ``;

    const message = `${greeting}` +
        `We are sending you a Request for Quotation:\n\n` +
        `📋 RFQ Number: ${rfq.rfqNumber}\n` +
        `📅 Quotation Due: ${new Date(rfq.quotationDueDate).toLocaleDateString('en-GB')}\n` +
        `🚚 Delivery By: ${new Date(rfq.deliveryBy).toLocaleDateString('en-GB')}\n\n` +
        `*Items Requested:*\n` +
        rfq.items.map((item, i) =>
            `${i + 1}. ${item.productName}\n   Qty: ${item.quantity} ${item.unit}\n   ${item.specifications || ''}`
        ).join('\n\n') +
        `\n\n` +
        `*Please provide:*\n` +
        `• Unit and total prices\n` +
        `• Delivery terms\n` +
        `• Payment terms\n` +
        `• Product availability\n\n` +
        `You can reply directly to this WhatsApp message with your quotation.\n\n` +
        `Best regards,\n` +
        `Halal Foods - Procurement Team\n` +
        `📞 +33 1 79 64 84 05`;

    return message;
}

/**
 * Format phone number for WhatsApp
 */
function formatPhoneForWhatsApp(phone) {
    let cleaned = phone.replace(/\D/g, '');

    if (cleaned.startsWith('0')) {
        cleaned = '33' + cleaned.substring(1);
    }

    if (!cleaned.startsWith('92') && !cleaned.startsWith('33') && !cleaned.startsWith('+')) {
        if (cleaned.length === 10 && cleaned.startsWith('3')) {
            cleaned = '92' + cleaned;
        } else if (cleaned.length === 9) {
            cleaned = '33' + cleaned;
        }
    }

    cleaned = cleaned.replace(/^\+/, '');

    return `whatsapp:+${cleaned}`;
}

/**
 * Find vendor by phone number
 */
async function findVendorByPhone(whatsappNumber) {
    const phoneNumber = whatsappNumber.replace('whatsapp:', '').replace('+', '');

    const vendors = await Vendor.find({
        phone: { $exists: true, $ne: null }
    });

    for (const vendor of vendors) {
        const vendorPhone = vendor.phone.replace(/\D/g, '');
        if (phoneNumber.includes(vendorPhone) || vendorPhone.includes(phoneNumber)) {
            return vendor;
        }
    }

    return null;
}

/**
 * Download WhatsApp media
 */
async function downloadWhatsAppMedia(mediaUrl) {
    try {
        const response = await client.request({
            method: 'GET',
            uri: mediaUrl
        });

        console.log('📎 Media downloaded');
        return null;
    } catch (error) {
        console.error('⚠️ Error downloading media:', error.message);
        return null;
    }
}

/**
 * Generate AI response to vendor question about RFQ
 */
async function generateAIResponseToQuestion(question, rfq, vendor) {
    const { generateQuestionResponse } = require('./aiService');

    try {
        const context = {
            rfqNumber: rfq.rfqNumber,
            items: rfq.items,
            quotationDueDate: rfq.quotationDueDate,
            deliveryBy: rfq.deliveryBy,
            paymentTerms: rfq.paymentTermsPreference,
            vendorName: vendor.CardName
        };

        const response = await generateQuestionResponse(question, context);
        return response;
    } catch (error) {
        console.error('⚠️ Error generating AI response:', error.message);
        return `Thank you for your question about RFQ ${rfq.rfqNumber}. Our team will get back to you shortly.\n\n` +
            `For urgent matters, please call us at +33 1 79 64 84 05\n\n` +
            `Best regards,\nHalal Foods Team`;
    }
}

module.exports = {
    sendRFQViaWhatsApp,
    handleIncomingWhatsAppMessage,
    sendWhatsAppMessage
};