// controllers/conversation.controller.js
const MessageEvent = require("../models/MessageEvent");
const ContactEvent = require("../models/Contact");
const Customer = require("../models/Customer");
const User = require("../models/User");
const axios = require('axios');
const SUPERCHAT_API_KEY = process.env.SUPERCHAT_API_KEY;

const identifyAgentFromCustomer = async (customerIdentifier) => {
    try {
        if (!customerIdentifier) return null;

        // Clean the identifier for better matching
        const cleanIdentifier = customerIdentifier.toLowerCase().trim();

        // Find customer by phone or email with flexible matching
        const customer = await Customer.findOne({
            $or: [
                { phoneNumber: { $regex: cleanIdentifier, $options: 'i' } },
                { Email: { $regex: cleanIdentifier, $options: 'i' } },
                { additionalPhoneNumbers: { $in: [cleanIdentifier] } },
                { additionalEmails: { $in: [cleanIdentifier] } }
            ],
            assignedTo: { $exists: true, $ne: null }
        }).populate('assignedTo', 'firstName lastName email phone role');

        return customer;
    } catch (error) {
        console.error("Error identifying agent from customer:", error);
        return null;
    }
};

// Enhanced phone number matching with multiple strategies
const findCustomerByIdentifier = async (identifier) => {
    try {
        if (!identifier) return null;

        // Clean the identifier
        const cleanIdentifier = identifier.toLowerCase().trim();

        // Strategy 1: Direct match (exact as stored)
        let customer = await Customer.findOne({
            $or: [
                { phoneNumber: identifier },
                { Email: { $regex: `^${identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } },
                { additionalPhoneNumbers: { $in: [identifier] } },
                { additionalEmails: { $in: [cleanIdentifier] } }
            ],
            assignedTo: { $exists: true, $ne: null }
        }).populate('assignedTo', 'firstName lastName email phone role');

        if (customer) {
            console.log('✅ Found customer with direct match:', customer.CardCode);
            return customer;
        }

        // Strategy 2: Phone number variations matching
        if (/[\d\+\-\s\(\)]/.test(identifier)) {
            // Extract only digits
            const digitsOnly = identifier.replace(/\D/g, '');

            // Create multiple phone variations to search for
            const phoneVariations = [
                digitsOnly, // 923154486105
                `+${digitsOnly}`, // +923154486105
                `0${digitsOnly.slice(2)}`, // 03154486105 (if starts with 92)
                `${digitsOnly.slice(2)}`, // 3154486105 (remove country code)
            ];

            // If it starts with 92 and is long enough, add Pakistani local format
            if (digitsOnly.startsWith('92') && digitsOnly.length >= 11) {
                phoneVariations.push(`0${digitsOnly.slice(2)}`); // 03154486105
            }

            // If it starts with 923, convert to local format
            if (digitsOnly.startsWith('923') && digitsOnly.length === 12) {
                phoneVariations.push(`03${digitsOnly.slice(3)}`); // 03154486105
            }

            console.log('🔍 Searching for phone variations:', phoneVariations);

            // Search using regex for flexible matching
            for (const variation of phoneVariations) {
                if (variation.length >= 10) { // Only search meaningful phone numbers
                    customer = await Customer.findOne({
                        $or: [
                            { phoneNumber: { $regex: variation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } },
                            {
                                additionalPhoneNumbers: {
                                    $elemMatch: {
                                        $regex: variation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                                        $options: 'i'
                                    }
                                }
                            }
                        ],
                        assignedTo: { $exists: true, $ne: null }
                    }).populate('assignedTo', 'firstName lastName email phone role');

                    if (customer) {
                        console.log(`✅ Found customer with phone variation "${variation}":`, customer.CardCode);
                        return customer;
                    }
                }
            }

            // Strategy 3: Partial phone matching (contains the digits)
            customer = await Customer.findOne({
                $or: [
                    { phoneNumber: { $regex: digitsOnly.slice(-10), $options: 'i' } }, // Last 10 digits
                    {
                        additionalPhoneNumbers: {
                            $elemMatch: {
                                $regex: digitsOnly.slice(-10),
                                $options: 'i'
                            }
                        }
                    }
                ],
                assignedTo: { $exists: true, $ne: null }
            }).populate('assignedTo', 'firstName lastName email phone role');

            if (customer) {
                console.log(`✅ Found customer with partial phone match (last 10 digits):`, customer.CardCode);
                return customer;
            }
        }

        console.log('❌ No customer found for identifier:', identifier);
        return null;

    } catch (error) {
        console.error("Error finding customer by identifier:", error);
        return null;
    }
};

// Debug function to understand your message data structure
exports.debugMessageStructure = async (req, res) => {
    try {
        // Get a few sample messages to understand the structure
        const sampleMessages = await MessageEvent.find({})
            .limit(5)
            .lean();

        console.log('=== MESSAGE STRUCTURE DEBUG ===');
        console.log('Total messages in DB:', await MessageEvent.countDocuments());

        if (sampleMessages.length > 0) {
            console.log('\nSample message structure:');
            sampleMessages.forEach((msg, index) => {
                console.log(`\n--- Message ${index + 1} ---`);
                console.log('ID:', msg.id);
                console.log('Direction:', msg.message?.direction);
                console.log('From:', JSON.stringify(msg.message?.from, null, 2));
                console.log('To:', JSON.stringify(msg.message?.to, null, 2));
                console.log('Content type:', msg.message?.content?.type);
                console.log('Created at:', msg.message?.created_at);
            });
        }

        // Check what identifiers we're actually getting
        const identifierAnalysis = await MessageEvent.aggregate([
            {
                $project: {
                    fromIdentifier: '$message.from.identifier',
                    fromId: '$message.from.id',
                    fromName: '$message.from.name',
                    toIdentifier: {
                        $cond: [
                            { $isArray: '$message.to' },
                            { $arrayElemAt: ['$message.to.identifier', 0] },
                            '$message.to.identifier'
                        ]
                    },
                    toId: {
                        $cond: [
                            { $isArray: '$message.to' },
                            { $arrayElemAt: ['$message.to.id', 0] },
                            '$message.to.id'
                        ]
                    },
                    direction: '$message.direction'
                }
            },
            {
                $group: {
                    _id: {
                        fromIdentifier: '$fromIdentifier',
                        toIdentifier: '$toIdentifier',
                        direction: '$direction'
                    },
                    count: { $sum: 1 },
                    sampleFromId: { $first: '$fromId' },
                    sampleToId: { $first: '$toId' },
                    sampleFromName: { $first: '$fromName' }
                }
            },
            { $limit: 10 }
        ]);

        console.log('\n=== IDENTIFIER ANALYSIS ===');
        identifierAnalysis.forEach((item, index) => {
            console.log(`\n--- Group ${index + 1} (${item.count} messages) ---`);
            console.log('Direction:', item._id.direction);
            console.log('From Identifier:', item._id.fromIdentifier);
            console.log('To Identifier:', item._id.toIdentifier);
            console.log('Sample From ID:', item.sampleFromId);
            console.log('Sample To ID:', item.sampleToId);
            console.log('Sample From Name:', item.sampleFromName);
        });

        // Check contacts to see if we can link contact IDs to phone numbers
        const sampleContacts = await ContactEvent.find({})
            .limit(5)
            .lean();

        console.log('\n=== CONTACT STRUCTURE DEBUG ===');
        console.log('Total contacts in DB:', await ContactEvent.countDocuments());

        if (sampleContacts.length > 0) {
            sampleContacts.forEach((contact, index) => {
                console.log(`\n--- Contact ${index + 1} ---`);
                console.log('Contact ID:', contact.contact?.id);
                console.log('Name:', contact.contact?.first_name, contact.contact?.last_name);
                console.log('Handles:', JSON.stringify(contact.contact?.handles, null, 2));
            });
        }

        res.json({
            success: true,
            debug: {
                totalMessages: await MessageEvent.countDocuments(),
                totalContacts: await ContactEvent.countDocuments(),
                sampleMessages: sampleMessages.map(m => ({
                    id: m.id,
                    direction: m.message?.direction,
                    fromIdentifier: m.message?.from?.identifier,
                    fromId: m.message?.from?.id,
                    toIdentifier: Array.isArray(m.message?.to) ? m.message.to[0]?.identifier : m.message?.to?.identifier,
                    toId: Array.isArray(m.message?.to) ? m.message.to[0]?.id : m.message?.to?.id,
                    contentType: m.message?.content?.type
                })),
                identifierGroups: identifierAnalysis,
                sampleContacts: sampleContacts.map(c => ({
                    contactId: c.contact?.id,
                    name: `${c.contact?.first_name || ''} ${c.contact?.last_name || ''}`.trim(),
                    handles: c.contact?.handles
                }))
            }
        });

    } catch (error) {
        console.error("Error debugging message structure:", error);
        res.status(500).json({
            success: false,
            message: "Error debugging message structure",
            error: error.message
        });
    }
};

// Debug function to check date range and message existence
exports.debugDateRange = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;

        // Set default date range (last 30 days)
        const end = endDate ? new Date(endDate) : new Date();
        const start = startDate
            ? new Date(startDate)
            : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

        console.log('\n=== DATE RANGE DEBUG ===');
        console.log('Query start date:', req.query.startDate);
        console.log('Query end date:', req.query.endDate);
        console.log('Parsed start:', start);
        console.log('Parsed end:', end);
        console.log('Current date:', new Date());

        // Check total messages in database
        const totalMessages = await MessageEvent.countDocuments();
        console.log('Total messages in database:', totalMessages);

        if (totalMessages === 0) {
            return res.json({
                success: true,
                issue: "No messages found in database",
                debug: { totalMessages: 0 }
            });
        }

        // Get sample message dates
        const sampleMessages = await MessageEvent.find({})
            .sort({ 'message.created_at': -1 })
            .limit(10)
            .select('message.created_at message.direction message.from')
            .lean();

        console.log('\n=== SAMPLE MESSAGE DATES ===');
        sampleMessages.forEach((msg, index) => {
            console.log(`Message ${index + 1}:`, {
                created_at: msg.message.created_at,
                direction: msg.message.direction,
                from_id: msg.message.from?.id,
                from_identifier: msg.message.from?.identifier
            });
        });

        // Check date range of all messages
        const dateRange = await MessageEvent.aggregate([
            {
                $group: {
                    _id: null,
                    oldestMessage: { $min: '$message.created_at' },
                    newestMessage: { $max: '$message.created_at' },
                    totalCount: { $sum: 1 }
                }
            }
        ]);

        console.log('\n=== MESSAGE DATE RANGE ===');
        if (dateRange.length > 0) {
            console.log('Oldest message:', dateRange[0].oldestMessage);
            console.log('Newest message:', dateRange[0].newestMessage);
            console.log('Total messages:', dateRange[0].totalCount);
        }

        // Test with different date ranges
        const testRanges = [
            // Last 7 days
            {
                name: 'Last 7 days',
                start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
                end: new Date()
            },
            // Last 30 days
            {
                name: 'Last 30 days',
                start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
                end: new Date()
            },
            // Last 90 days
            {
                name: 'Last 90 days',
                start: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
                end: new Date()
            },
            // All time (no date filter)
            {
                name: 'All time',
                start: null,
                end: null
            }
        ];

        console.log('\n=== DATE RANGE TESTING ===');
        for (const range of testRanges) {
            let query = {};
            if (range.start && range.end) {
                query = {
                    'message.created_at': { $gte: range.start, $lte: range.end }
                };
            }

            const count = await MessageEvent.countDocuments(query);
            console.log(`${range.name}: ${count} messages`);

            if (count > 0) {
                // Test aggregation for this range
                const aggResult = await MessageEvent.aggregate([
                    { $match: query },
                    {
                        $addFields: {
                            customerIdentifier: {
                                $cond: [
                                    { $eq: ['$message.direction', 'inbound'] },
                                    '$message.from.identifier',
                                    {
                                        $cond: [
                                            { $isArray: '$message.to' },
                                            { $arrayElemAt: ['$message.to.identifier', 0] },
                                            '$message.to.identifier'
                                        ]
                                    }
                                ]
                            },
                            contactId: {
                                $cond: [
                                    { $eq: ['$message.direction', 'inbound'] },
                                    '$message.from.id',
                                    {
                                        $cond: [
                                            { $isArray: '$message.to' },
                                            { $arrayElemAt: ['$message.to.id', 0] },
                                            '$message.to.id'
                                        ]
                                    }
                                ]
                            }
                        }
                    },
                    {
                        $group: {
                            _id: {
                                direction: '$message.direction',
                                type: '$message.content.type',
                                identifier: '$customerIdentifier',
                                contactId: '$contactId'
                            },
                            count: { $sum: 1 }
                        }
                    },
                    { $limit: 5 }
                ]);

                console.log(`  Aggregation groups for ${range.name}:`, aggResult.length);
                if (aggResult.length > 0) {
                    console.log('  Sample groups:', aggResult.slice(0, 3));
                }
            }
        }

        // Test the specific message you showed me
        const specificMessage = await MessageEvent.findOne({
            'message.from.id': 'ct_HpLSvh07JvqC8Oxfv5p3J'
        });

        console.log('\n=== SPECIFIC MESSAGE TEST ===');
        if (specificMessage) {
            console.log('Found the specific message:', {
                id: specificMessage.id,
                created_at: specificMessage.message.created_at,
                from_id: specificMessage.message.from?.id,
                from_identifier: specificMessage.message.from?.identifier,
                direction: specificMessage.message.direction
            });

            // Check if this message falls within our date range
            const messageDate = new Date(specificMessage.message.created_at);
            const inRange = messageDate >= start && messageDate <= end;
            console.log('Message in current date range?', inRange);
            console.log('Message date:', messageDate);
            console.log('Search start:', start);
            console.log('Search end:', end);
        } else {
            console.log('Specific message not found');
        }

        res.json({
            success: true,
            debug: {
                dateRange: { start, end },
                totalMessages,
                sampleDates: sampleMessages.map(m => ({
                    created_at: m.message.created_at,
                    direction: m.message.direction
                })),
                overallDateRange: dateRange[0] || null,
                specificMessageFound: !!specificMessage,
                specificMessageDate: specificMessage?.message?.created_at || null
            }
        });

    } catch (error) {
        console.error("Error debugging date range:", error);
        res.status(500).json({
            success: false,
            message: "Error debugging date range",
            error: error.message
        });
    }
};

// Simplified stats function without date filter for testing
exports.getStatsAllTime = async (req, res) => {
    try {
        console.log('\n=== TESTING ALL TIME STATS ===');

        // Get ALL messages without date filter
        const messageStats = await MessageEvent.aggregate([
            // No date filter
            {
                $addFields: {
                    customerIdentifier: {
                        $cond: [
                            { $eq: ['$message.direction', 'inbound'] },
                            '$message.from.identifier',
                            {
                                $cond: [
                                    { $isArray: '$message.to' },
                                    { $arrayElemAt: ['$message.to.identifier', 0] },
                                    '$message.to.identifier'
                                ]
                            }
                        ]
                    },
                    contactId: {
                        $cond: [
                            { $eq: ['$message.direction', 'inbound'] },
                            '$message.from.id',
                            {
                                $cond: [
                                    { $isArray: '$message.to' },
                                    { $arrayElemAt: ['$message.to.id', 0] },
                                    '$message.to.id'
                                ]
                            }
                        ]
                    }
                }
            },
            {
                $group: {
                    _id: {
                        direction: '$message.direction',
                        type: '$message.content.type',
                        identifier: '$customerIdentifier',
                        contactId: '$contactId'
                    },
                    count: { $sum: 1 },
                    conversations: { $addToSet: '$message.conversation_id' }
                }
            }
        ]);

        console.log('All time message stats:', messageStats.length, 'groups');

        if (messageStats.length > 0) {
            console.log('Sample stats:', messageStats.slice(0, 5));
        }

        res.json({
            success: true,
            data: {
                totalGroups: messageStats.length,
                sampleGroups: messageStats.slice(0, 10),
                totalMessages: messageStats.reduce((sum, stat) => sum + stat.count, 0)
            }
        });

    } catch (error) {
        console.error("Error getting all time stats:", error);
        res.status(500).json({
            success: false,
            message: "Error getting all time stats",
            error: error.message
        });
    }
};

// ULTRA-OPTIMIZED VERSION - Addresses core bottlenecks
exports.getEnhancedConversationStats = async (req, res) => {
    try {
        const { startDate, endDate, agentId } = req.query;

        // SIMPLIFIED DATE HANDLING
        let dateQuery = {};
        if (startDate && endDate) {
            const start = new Date(startDate);
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);

            dateQuery = {
                'message.created_at': {
                    $gte: start.toISOString(),
                    $lte: end.toISOString()
                }
            };
        }

        // CRITICAL OPTIMIZATION 1: Single mega-aggregation pipeline to reduce database calls
        const [megaAggregation, customersWithAgents] = await Promise.all([
            MessageEvent.aggregate([
                { $match: dateQuery },
                {
                    $addFields: {
                        customerIdentifier: {
                            $cond: [
                                { $eq: ['$message.direction', 'inbound'] },
                                '$message.from.identifier',
                                {
                                    $cond: [
                                        { $isArray: '$message.to' },
                                        { $arrayElemAt: ['$message.to.identifier', 0] },
                                        '$message.to.identifier'
                                    ]
                                }
                            ]
                        },
                        contactId: {
                            $cond: [
                                { $eq: ['$message.direction', 'inbound'] },
                                '$message.from.id',
                                {
                                    $cond: [
                                        { $isArray: '$message.to' },
                                        { $arrayElemAt: ['$message.to.id', 0] },
                                        '$message.to.id'
                                    ]
                                }
                            ]
                        },
                        parsedDate: { $dateFromString: { dateString: '$message.created_at' } }
                    }
                },
                {
                    $facet: {
                        // Message stats
                        messageStats: [
                            {
                                $group: {
                                    _id: {
                                        direction: '$message.direction',
                                        type: '$message.content.type',
                                        identifier: '$customerIdentifier',
                                        contactId: '$contactId'
                                    },
                                    count: { $sum: 1 },
                                    conversations: { $addToSet: '$message.conversation_id' }
                                }
                            }
                        ],
                        // Daily trends
                        dailyTrends: [
                            {
                                $group: {
                                    _id: {
                                        date: { $dateToString: { format: '%Y-%m-%d', date: '$parsedDate' } },
                                        direction: '$message.direction'
                                    },
                                    count: { $sum: 1 }
                                }
                            },
                            { $sort: { '_id.date': 1 } }
                        ],
                        // Message types
                        messageTypes: [
                            {
                                $group: {
                                    _id: '$message.content.type',
                                    count: { $sum: 1 }
                                }
                            }
                        ],
                        // Total count
                        totalCount: [
                            { $count: "total" }
                        ]
                    }
                }
            ]),
            // Only fetch customers with agents in parallel
            Customer.find({
                assignedTo: { $exists: true, $ne: null }
            }).populate('assignedTo', 'firstName lastName email phone role').lean()
        ]);

        const messageStats = megaAggregation[0]?.messageStats || [];
        const dailyTrends = megaAggregation[0]?.dailyTrends || [];
        const messageTypes = megaAggregation[0]?.messageTypes || [];
        const testCount = megaAggregation[0]?.totalCount[0]?.total || 0;

        console.log(`Messages matching date filter: ${testCount}`);

        if (testCount === 0) {
            const totalCount = await MessageEvent.countDocuments();
            return res.json({
                success: true,
                data: {
                    overview: {
                        totalMessages: 0, totalConversations: 0, totalAgents: 0, totalCustomers: 0,
                        matchedMessages: 0, matchingRate: 0
                    },
                    agentStats: [], customerStats: [], dailyTrends: [], messageTypes: []
                },
                debug: {
                    issue: "Date filter excludes all messages",
                    dateFilter: dateQuery,
                    totalMessagesInDb: totalCount,
                    sampleMessageDates: []
                }
            });
        }

        // CRITICAL OPTIMIZATION 2: Build lookup maps with minimal iterations
        const phoneCleanRegex = /\D/g;
        const normalizePhone = (phone) => {
            if (!phone) return null;
            let cleaned = phone.replace(phoneCleanRegex, '');
            if (cleaned.startsWith('92') && cleaned.length > 10) {
                cleaned = '0' + cleaned.slice(2);
            }
            if (cleaned.startsWith('923') && cleaned.length === 12) {
                cleaned = '03' + cleaned.slice(3);
            }
            return cleaned;
        };

        // Ultra-fast customer lookup maps
        const customerByIdentifier = new Map();
        const customersByPhone = new Map(); // Separate map for phone lookups

        for (const customer of customersWithAgents) {
            // Email mapping
            if (customer.Email) {
                customerByIdentifier.set(customer.Email.toLowerCase().trim(), customer);
            }

            // Phone mapping with all variations
            const phones = [customer.phoneNumber, ...(customer.additionalPhoneNumbers || [])].filter(Boolean);
            for (const phone of phones) {
                const original = phone.trim();
                const normalized = normalizePhone(original);
                const digits = original.replace(phoneCleanRegex, '');

                customerByIdentifier.set(original, customer);
                customerByIdentifier.set(original.toLowerCase(), customer);
                if (normalized) customerByIdentifier.set(normalized, customer);
                if (digits) customersByPhone.set(digits, customer);

                // Store last 10 digits for partial matching
                if (digits.length >= 10) {
                    customersByPhone.set(digits.slice(-10), customer);
                }
            }

            // Additional emails
            if (customer.additionalEmails) {
                for (const email of customer.additionalEmails) {
                    if (email) customerByIdentifier.set(email.toLowerCase().trim(), customer);
                }
            }
        }

        // CRITICAL OPTIMIZATION 3: Eliminate contact mapping completely for first pass
        // Only use direct identifier matching for maximum speed
        const agentStats = new Map();
        const customerStats = new Map();
        let totalMessages = 0;
        const totalConversations = new Set();
        let matchedMessages = 0;

        // CRITICAL OPTIMIZATION 4: Single pass processing with pre-compiled lookups
        const messageTypeMap = new Map(messageTypes.map(t => [t._id, t.count]));

        for (const stat of messageStats) {
            const identifier = stat._id.identifier;
            totalMessages += stat.count;
            stat.conversations.forEach(conv => totalConversations.add(conv));

            let customer = null;

            // Fast lookup strategy - try exact matches first
            if (identifier) {
                customer = customerByIdentifier.get(identifier) ||
                    customerByIdentifier.get(identifier.toLowerCase().trim());

                // Phone number fallback
                if (!customer && /\d/.test(identifier)) {
                    const digits = identifier.replace(phoneCleanRegex, '');
                    customer = customersByPhone.get(digits) ||
                        customersByPhone.get(digits.slice(-10));
                }
            }

            if (customer?.assignedTo) {
                matchedMessages += stat.count;
                const agentId = customer.assignedTo._id.toString();

                // Agent stats initialization and update
                let agentStat = agentStats.get(agentId);
                if (!agentStat) {
                    agentStat = {
                        agent: customer.assignedTo,
                        totalMessages: 0, inboundMessages: 0, outboundMessages: 0,
                        emailMessages: 0, textMessages: 0, smsMessages: 0, mediaMessages: 0,
                        conversations: new Set(), customers: new Set()
                    };
                    agentStats.set(agentId, agentStat);
                }

                agentStat.totalMessages += stat.count;
                stat.conversations.forEach(conv => agentStat.conversations.add(conv));
                agentStat.customers.add(customer.CardCode);

                // Direction and type counting
                if (stat._id.direction === 'inbound') agentStat.inboundMessages += stat.count;
                if (stat._id.direction === 'outbound') agentStat.outboundMessages += stat.count;

                switch (stat._id.type) {
                    case 'email': agentStat.emailMessages += stat.count; break;
                    case 'text': agentStat.textMessages += stat.count; break;
                    case 'sms': agentStat.smsMessages += stat.count; break;
                    case 'media': agentStat.mediaMessages += stat.count; break;
                }

                // Customer stats
                let customerStat = customerStats.get(customer.CardCode);
                if (!customerStat) {
                    customerStat = {
                        customer: {
                            cardCode: customer.CardCode, cardName: customer.CardName,
                            email: customer.Email, phone: customer.phoneNumber
                        },
                        agent: customer.assignedTo,
                        totalMessages: 0, inboundMessages: 0, outboundMessages: 0,
                        conversations: new Set()
                    };
                    customerStats.set(customer.CardCode, customerStat);
                }

                customerStat.totalMessages += stat.count;
                stat.conversations.forEach(conv => customerStat.conversations.add(conv));

                if (stat._id.direction === 'inbound') customerStat.inboundMessages += stat.count;
                if (stat._id.direction === 'outbound') customerStat.outboundMessages += stat.count;
            }
        }

        console.log('Matching results:', {
            totalMessages, matchedMessages,
            matchingRate: `${((matchedMessages / totalMessages) * 100).toFixed(1)}%`,
            agentsFound: agentStats.size, customersMatched: customerStats.size
        });

        // CRITICAL OPTIMIZATION 5: Minimal data transformation
        const formattedAgentStats = [];
        for (const stat of agentStats.values()) {
            formattedAgentStats.push({
                ...stat,
                conversations: stat.conversations.size,
                customers: stat.customers.size
            });
        }

        const formattedCustomerStats = [];
        for (const stat of customerStats.values()) {
            formattedCustomerStats.push({
                ...stat,
                conversations: stat.conversations.size
            });
        }

        // Pre-calculated overview stats
        let inboundMessages = 0, outboundMessages = 0;
        for (const stat of messageStats) {
            if (stat._id.direction === 'inbound') inboundMessages += stat.count;
            else if (stat._id.direction === 'outbound') outboundMessages += stat.count;
        }

        const overview = {
            totalMessages,
            totalConversations: totalConversations.size,
            totalAgents: formattedAgentStats.length,
            totalCustomers: formattedCustomerStats.length,
            matchedMessages,
            matchingRate: totalMessages > 0 ? ((matchedMessages / totalMessages) * 100).toFixed(1) : 0,
            inboundMessages,
            outboundMessages,
            emailMessages: messageTypeMap.get('email') || 0,
            textMessages: messageTypeMap.get('text') || 0,
            smsMessages: messageTypeMap.get('sms') || 0,
            mediaMessages: messageTypeMap.get('media') || 0
        };

        // Sort only at the end
        formattedAgentStats.sort((a, b) => b.totalMessages - a.totalMessages);
        formattedCustomerStats.sort((a, b) => b.totalMessages - a.totalMessages);

        res.json({
            success: true,
            data: {
                overview,
                agentStats: formattedAgentStats,
                customerStats: formattedCustomerStats,
                dailyTrends,
                messageTypes,
                dateRange: Object.keys(dateQuery).length > 0 ? {
                    start: dateQuery['message.created_at']?.$gte,
                    end: dateQuery['message.created_at']?.$lte
                } : { start: null, end: null }
            },
            debug: {
                totalCustomersWithAgents: customersWithAgents.length,
                directIdentifierMappings: customerByIdentifier.size,
                contactIdMappings: 0, // Eliminated for speed
                messageStatsGroups: messageStats.length,
                dateFilter: dateQuery,
                messagesMatchingDateFilter: testCount,
                matchingResults: {
                    totalMessages, matchedMessages,
                    matchingRate: `${((matchedMessages / totalMessages) * 100).toFixed(1)}%`,
                    unmatchedCount: totalMessages - matchedMessages
                }
            }
        });

    } catch (error) {
        console.error("Error fetching enhanced conversation stats:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching enhanced conversation stats",
            error: error.message
        });
    }
};

// Get agent-specific conversation insights
exports.getAgentConversationInsights = async (req, res) => {
    try {
        const { agentId } = req.params;
        const { startDate, endDate } = req.query;

        // Validate agent
        const agent = await User.findById(agentId);
        if (!agent) {
            return res.status(404).json({
                success: false,
                message: "Agent not found"
            });
        }

        // Set date range
        const end = endDate ? new Date(endDate) : new Date();
        const start = startDate
            ? new Date(startDate)
            : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

        // Get agent's customers
        const agentCustomers = await Customer.find({
            assignedTo: agentId
        }).lean();

        if (agentCustomers.length === 0) {
            return res.json({
                success: true,
                data: {
                    agent: { id: agentId, name: `${agent.firstName} ${agent.lastName}` },
                    summary: { totalMessages: 0, totalConversations: 0, activeCustomers: 0 },
                    customerInsights: [],
                    messageTimeline: []
                }
            });
        }

        // Create identifier array for matching
        const customerIdentifiers = agentCustomers.flatMap(customer => [
            customer.phoneNumber,
            customer.Email,
            ...(customer.additionalPhoneNumbers || []),
            ...(customer.additionalEmails || [])
        ]).filter(Boolean).map(id => id.toLowerCase().trim());

        // Get conversation data for these identifiers
        const conversationData = await MessageEvent.aggregate([
            {
                $match: {
                    'message.created_at': { $gte: start, $lte: end },
                    $or: [
                        { 'message.from.identifier': { $in: customerIdentifiers } },
                        { 'message.to.identifier': { $in: customerIdentifiers } },
                        { 'message.to.0.identifier': { $in: customerIdentifiers } }
                    ]
                }
            },
            {
                $addFields: {
                    customerIdentifier: {
                        $cond: [
                            { $eq: ['$message.direction', 'inbound'] },
                            '$message.from.identifier',
                            {
                                $cond: [
                                    { $isArray: '$message.to' },
                                    { $arrayElemAt: ['$message.to.identifier', 0] },
                                    '$message.to.identifier'
                                ]
                            }
                        ]
                    }
                }
            },
            {
                $group: {
                    _id: '$customerIdentifier',
                    totalMessages: { $sum: 1 },
                    inboundMessages: { $sum: { $cond: [{ $eq: ['$message.direction', 'inbound'] }, 1, 0] } },
                    outboundMessages: { $sum: { $cond: [{ $eq: ['$message.direction', 'outbound'] }, 1, 0] } },
                    conversations: { $addToSet: '$message.conversation_id' },
                    firstMessage: { $min: '$message.created_at' },
                    lastMessage: { $max: '$message.created_at' },
                    messageTypes: { $addToSet: '$message.content.type' }
                }
            }
        ]);

        // Map conversation data to customers
        const customerMap = {};
        agentCustomers.forEach(customer => {
            const identifiers = [
                customer.phoneNumber,
                customer.Email,
                ...(customer.additionalPhoneNumbers || []),
                ...(customer.additionalEmails || [])
            ].filter(Boolean).map(id => id.toLowerCase().trim());

            identifiers.forEach(identifier => {
                customerMap[identifier] = customer;
            });
        });

        const customerInsights = conversationData.map(data => {
            const customer = customerMap[data._id?.toLowerCase()?.trim()];
            return {
                customer: customer ? {
                    cardCode: customer.CardCode,
                    cardName: customer.CardName,
                    email: customer.Email,
                    phone: customer.phoneNumber
                } : { identifier: data._id },
                metrics: {
                    totalMessages: data.totalMessages,
                    inboundMessages: data.inboundMessages,
                    outboundMessages: data.outboundMessages,
                    conversations: data.conversations.length,
                    firstContact: data.firstMessage,
                    lastContact: data.lastMessage,
                    messageTypes: data.messageTypes,
                    responseRate: data.outboundMessages > 0 ?
                        (data.inboundMessages / data.outboundMessages * 100).toFixed(2) : 0
                }
            };
        }).sort((a, b) => b.metrics.totalMessages - a.metrics.totalMessages);

        // Get daily message timeline
        const messageTimeline = await MessageEvent.aggregate([
            {
                $match: {
                    'message.created_at': { $gte: start, $lte: end },
                    $or: [
                        { 'message.from.identifier': { $in: customerIdentifiers } },
                        { 'message.to.identifier': { $in: customerIdentifiers } },
                        { 'message.to.0.identifier': { $in: customerIdentifiers } }
                    ]
                }
            },
            {
                $group: {
                    _id: {
                        date: { $dateToString: { format: '%Y-%m-%d', date: '$message.created_at' } },
                        direction: '$message.direction',
                        type: '$message.content.type'
                    },
                    count: { $sum: 1 }
                }
            },
            { $sort: { '_id.date': 1 } }
        ]);

        const summary = {
            totalMessages: conversationData.reduce((sum, d) => sum + d.totalMessages, 0),
            totalConversations: conversationData.reduce((sum, d) => sum + d.conversations.length, 0),
            activeCustomers: conversationData.length,
            averageMessagesPerCustomer: conversationData.length > 0 ?
                (conversationData.reduce((sum, d) => sum + d.totalMessages, 0) / conversationData.length).toFixed(2) : 0
        };

        res.json({
            success: true,
            data: {
                agent: {
                    id: agentId,
                    name: `${agent.firstName} ${agent.lastName}`,
                    email: agent.email,
                    role: agent.role
                },
                summary,
                customerInsights,
                messageTimeline,
                dateRange: { start, end }
            }
        });

    } catch (error) {
        console.error("Error fetching agent conversation insights:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching agent conversation insights",
            error: error.message
        });
    }
};

// Get all conversations with message counts and latest message
exports.getAllConversations = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        // Get filter parameters
        const { direction, status, search, startDate, endDate, agentId } = req.query;
        const query = {};

        // Apply filters
        if (direction && direction !== 'all') {
            query['message.direction'] = direction;
        }

        if (status && status !== 'all') {
            query['message.status'] = status;
        }

        // Agent filter - find user first, then match their phone/email
        if (agentId && agentId !== 'all') {
            try {
                const agent = await User.findById(agentId);
                if (agent) {
                    const identifiers = [agent.phone, agent.email].filter(Boolean);
                    if (identifiers.length > 0) {
                        query.$or = [
                            { 'message.from.identifier': { $in: identifiers } },
                            { 'message.to.identifier': { $in: identifiers } },
                            { 'message.to.0.identifier': { $in: identifiers } }
                        ];
                    }
                }
            } catch (agentError) {
                console.error("Error finding agent:", agentError);
            }
        }

        // Search in message content, contact name, or identifier
        if (search) {
            const searchQuery = {
                $or: [
                    { 'message.content.body': { $regex: search, $options: 'i' } },
                    { 'message.content.subject': { $regex: search, $options: 'i' } },
                    { 'message.from.name': { $regex: search, $options: 'i' } },
                    { 'message.from.identifier': { $regex: search, $options: 'i' } }
                ]
            };

            if (query.$or) {
                query.$and = [{ $or: query.$or }, searchQuery];
                delete query.$or;
            } else {
                query.$or = searchQuery.$or;
            }
        }

        // Date range filter
        if (startDate && endDate) {
            query['message.created_at'] = {
                $gte: new Date(startDate),
                $lte: new Date(endDate)
            };
        }

        // DEBUG: Check if we have any messages at all
        const totalMessages = await MessageEvent.countDocuments();
        console.log(`Total messages in database: ${totalMessages}`);
        console.log(`Query being used:`, JSON.stringify(query, null, 2));

        // If no messages, return early with debug info
        if (totalMessages === 0) {
            return res.json({
                success: true,
                data: [],
                debug: {
                    message: "No messages found in database. Have you sent data to the webhook endpoint?",
                    totalMessages: 0,
                    webhookEndpoint: "/api/conversations/webhook/message"
                },
                pagination: {
                    page,
                    limit,
                    total: 0,
                    pages: 0
                }
            });
        }

        // Aggregate conversations with message counts
        const conversations = await MessageEvent.aggregate([
            { $match: query },
            {
                $group: {
                    _id: '$message.conversation_id',
                    messageCount: { $sum: 1 },
                    latestMessage: { $max: '$message.created_at' },
                    lastMessagePreview: { $last: '$message.content.body' },
                    lastMessageSubject: { $last: '$message.content.subject' },
                    lastDirection: { $last: '$message.direction' },
                    lastStatus: { $last: '$message.status' },
                    contactId: { $last: '$message.from.id' },
                    contactIdentifier: { $last: '$message.from.identifier' },
                    contactName: { $last: '$message.from.name' },
                    // Collect unique participants (from and to identifiers)
                    participants: {
                        $addToSet: {
                            $cond: [
                                { $eq: ['$message.direction', 'outbound'] },
                                '$message.from.identifier',
                                {
                                    $cond: [
                                        { $isArray: '$message.to' },
                                        { $arrayElemAt: ['$message.to.identifier', 0] },
                                        '$message.to.identifier'
                                    ]
                                }
                            ]
                        }
                    }
                }
            },
            { $sort: { latestMessage: -1 } },
            { $skip: skip },
            { $limit: limit }
        ]);

        console.log(`Found ${conversations.length} conversations after aggregation`);

        // Get unique contact IDs that don't have names
        const contactIdsNeedingNames = conversations
            .filter(conv => !conv.contactName && conv.contactId)
            .map(conv => conv.contactId);

        // Fetch contact names from Contacts collection if needed
        let contactNameMap = {};
        if (contactIdsNeedingNames.length > 0) {
            const contacts = await ContactEvent.find({
                'contact.id': { $in: contactIdsNeedingNames }
            })
                .sort({ processedAt: -1 })
                .lean();

            // Create map of contact IDs to names (use latest contact event)
            contacts.forEach(c => {
                if (!contactNameMap[c.contact.id]) {
                    const firstName = c.contact.first_name || '';
                    const lastName = c.contact.last_name || '';
                    const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
                    contactNameMap[c.contact.id] = fullName || null;
                }
            });
        }

        // Identify agents for each conversation using User model
        const agentMap = {};
        const allParticipants = [...new Set(conversations.flatMap(conv => conv.participants))].filter(Boolean);

        if (allParticipants.length > 0) {
            const users = await User.find({
                $or: [
                    { phone: { $in: allParticipants } },
                    { email: { $in: allParticipants } }
                ],
                deactivated: false
            }).lean();

            users.forEach(user => {
                // Map both phone and email to this user
                if (user.phone) {
                    agentMap[user.phone] = {
                        id: user._id,
                        firstName: user.firstName,
                        lastName: user.lastName,
                        role: user.role,
                        email: user.email,
                        phone: user.phone
                    };
                }
                if (user.email) {
                    agentMap[user.email] = {
                        id: user._id,
                        firstName: user.firstName,
                        lastName: user.lastName,
                        role: user.role,
                        email: user.email,
                        phone: user.phone
                    };
                }
            });
        }

        // Get total count for pagination
        const totalConversations = await MessageEvent.distinct('message.conversation_id', query);

        res.json({
            success: true,
            data: conversations.map(conv => {
                // Find agent involved in this conversation
                const involvedAgent = conv.participants.find(p => agentMap[p]);
                const agentInfo = involvedAgent ? agentMap[involvedAgent] : null;

                return {
                    conversationId: conv._id,
                    messageCount: conv.messageCount,
                    latestMessage: conv.latestMessage,
                    preview: conv.lastMessagePreview || conv.lastMessageSubject || 'No preview',
                    direction: conv.lastDirection,
                    status: conv.lastStatus,
                    contact: {
                        id: conv.contactId,
                        identifier: conv.contactIdentifier,
                        // Use contact name from message, fallback to Contact collection, then identifier, then 'Unknown'
                        name: conv.contactName ||
                            (conv.contactId && contactNameMap[conv.contactId]) ||
                            conv.contactIdentifier ||
                            'Unknown'
                    },
                    agent: agentInfo
                };
            }),
            debug: {
                totalMessagesInDb: totalMessages,
                conversationsFound: conversations.length,
                queryUsed: query,
                contactsLookedUp: contactIdsNeedingNames.length,
                agentsFound: Object.keys(agentMap).length,
                participantsChecked: allParticipants.length
            },
            pagination: {
                page,
                limit,
                total: totalConversations.length,
                pages: Math.ceil(totalConversations.length / limit)
            }
        });
    } catch (error) {
        console.error("Error fetching conversations:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching conversations",
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

exports.getConversationById = async (req, res) => {
    try {
        const { conversationId } = req.params;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        // Get total message count
        const totalMessages = await MessageEvent.countDocuments({
            'message.conversation_id': conversationId
        });

        // Get paginated messages (newest first, then reverse for display)
        const messages = await MessageEvent.find({
            'message.conversation_id': conversationId
        })
            .sort({ 'message.created_at': -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        // Reverse to show oldest first in the current page
        messages.reverse();

        if (totalMessages === 0) {
            return res.status(404).json({
                success: false,
                message: "Conversation not found"
            });
        }

        // Get unique contact IDs from messages
        const contactIds = [...new Set(messages.map(m => m.message.from?.id).filter(Boolean))];

        // Fetch contact details
        const contacts = await ContactEvent.find({
            'contact.id': { $in: contactIds }
        })
            .sort({ processedAt: -1 })
            .lean();

        // Create contact map
        const contactMap = {};
        contacts.forEach(c => {
            if (!contactMap[c.contact.id]) {
                contactMap[c.contact.id] = c.contact;
            }
        });

        // Enrich messages with full contact info
        const enrichedMessages = messages.map(msg => ({
            ...msg,
            contactDetails: contactMap[msg.message.from?.id] || null
        }));

        res.json({
            success: true,
            data: {
                conversationId,
                messageCount: totalMessages,
                messages: enrichedMessages,
                participants: Object.values(contactMap),
                pagination: {
                    page,
                    limit,
                    total: totalMessages,
                    pages: Math.ceil(totalMessages / limit)
                }
            }
        });
    } catch (error) {
        console.error("Error fetching conversation:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching conversation details",
            error: error.message
        });
    }
};

// Get messages by contact
exports.getMessagesByContact = async (req, res) => {
    try {
        const { contactIdentifier } = req.params;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        // Find messages by contact identifier (email or phone)
        const messages = await MessageEvent.find({
            $or: [
                { 'message.from.identifier': contactIdentifier },
                { 'message.to.identifier': contactIdentifier },
                { 'message.to.0.identifier': contactIdentifier }
            ]
        })
            .sort({ 'message.created_at': -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        const totalCount = await MessageEvent.countDocuments({
            $or: [
                { 'message.from.identifier': contactIdentifier },
                { 'message.to.identifier': contactIdentifier },
                { 'message.to.0.identifier': contactIdentifier }
            ]
        });

        // Get contact details
        const contactEvents = await ContactEvent.findByHandle(contactIdentifier);
        const contact = contactEvents.length > 0 ? contactEvents[0].contact : null;

        res.json({
            success: true,
            data: {
                contact,
                messages,
                pagination: {
                    page,
                    limit,
                    total: totalCount,
                    pages: Math.ceil(totalCount / limit)
                }
            }
        });
    } catch (error) {
        console.error("Error fetching messages by contact:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching messages",
            error: error.message
        });
    }
};

// Save incoming message event from webhook
exports.saveMessageEvent = async (req, res) => {
    try {
        const eventData = req.body;

        // Validate required fields
        if (!eventData.id || !eventData.message || !eventData.event) {
            return res.status(400).json({
                success: false,
                message: "Missing required fields: id, message, and event"
            });
        }

        // Check if event already exists
        const existingEvent = await MessageEvent.findOne({ id: eventData.id });
        if (existingEvent) {
            return res.status(200).json({
                success: true,
                message: "Event already processed",
                data: existingEvent
            });
        }

        // Create new message event
        const messageEvent = new MessageEvent(eventData);
        await messageEvent.save();

        res.status(201).json({
            success: true,
            message: "Message event saved successfully",
            data: messageEvent
        });
    } catch (error) {
        console.error("Error saving message event:", error);
        res.status(500).json({
            success: false,
            message: "Error saving message event",
            error: error.message
        });
    }
};

// Save incoming contact event from webhook
exports.saveContactEvent = async (req, res) => {
    try {
        const eventData = req.body;

        // Validate required fields
        if (!eventData.id || !eventData.contact || !eventData.event) {
            return res.status(400).json({
                success: false,
                message: "Missing required fields: id, contact, and event"
            });
        }

        // Check if event already exists
        const existingEvent = await ContactEvent.findOne({ id: eventData.id });
        if (existingEvent) {
            return res.status(200).json({
                success: true,
                message: "Event already processed",
                data: existingEvent
            });
        }

        // Create new contact event
        const contactEvent = new ContactEvent(eventData);
        await contactEvent.save();

        res.status(201).json({
            success: true,
            message: "Contact event saved successfully",
            data: contactEvent
        });
    } catch (error) {
        console.error("Error saving contact event:", error);
        res.status(500).json({
            success: false,
            message: "Error saving contact event",
            error: error.message
        });
    }
};

// Get contact details
exports.getContactById = async (req, res) => {
    try {
        const { contactId } = req.params;

        const allContacts = await ContactEvent.countDocuments();
        console.log(`Total contacts in database: ${allContacts}`);

        // Get latest contact event
        const latestContact = await ContactEvent.findLatestByContactId(contactId);

        if (!latestContact) {
            return res.status(404).json({
                success: false,
                message: "Contact not found"
            });
        }

        // Get message count for this contact
        const messageCount = await MessageEvent.countDocuments({
            $or: [
                { 'message.from.id': contactId },
                { 'message.to.id': contactId }
            ]
        });

        // Get conversations involving this contact
        const conversations = await MessageEvent.distinct('message.conversation_id', {
            $or: [
                { 'message.from.id': contactId },
                { 'message.to.id': contactId }
            ]
        });

        res.json({
            success: true,
            data: {
                ...latestContact.toObject(),
                statistics: {
                    messageCount,
                    conversationCount: conversations.length
                }
            }
        });
    } catch (error) {
        console.error("Error fetching contact:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching contact details",
            error: error.message
        });
    }
};

// Search across messages and contacts
exports.searchConversations = async (req, res) => {
    try {
        const { query, type } = req.query;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        if (!query) {
            return res.status(400).json({
                success: false,
                message: "Search query is required"
            });
        }

        let results = {};

        // Search in messages
        if (!type || type === 'messages') {
            const messageResults = await MessageEvent.find({
                $text: { $search: query }
            })
                .sort({ 'message.created_at': -1 })
                .skip(skip)
                .limit(limit)
                .lean();

            const messageCount = await MessageEvent.countDocuments({
                $text: { $search: query }
            });

            results.messages = {
                data: messageResults,
                count: messageCount
            };
        }

        // Search in contacts
        if (!type || type === 'contacts') {
            const contactResults = await ContactEvent.find({
                $text: { $search: query }
            })
                .sort({ processedAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean();

            const contactCount = await ContactEvent.countDocuments({
                $text: { $search: query }
            });

            results.contacts = {
                data: contactResults,
                count: contactCount
            };
        }

        res.json({
            success: true,
            data: results,
            pagination: { page, limit }
        });
    } catch (error) {
        console.error("Error searching:", error);
        res.status(500).json({
            success: false,
            message: "Error performing search",
            error: error.message
        });
    }
};

exports.getConversationStats = async (req, res) => {
    try {
        // Overall statistics
        const stats = await MessageEvent.aggregate([
            {
                $group: {
                    _id: null,
                    totalMessages: { $sum: 1 },
                    totalConversations: { $addToSet: '$message.conversation_id' },
                    inboundMessages: {
                        $sum: { $cond: [{ $eq: ['$message.direction', 'inbound'] }, 1, 0] }
                    },
                    outboundMessages: {
                        $sum: { $cond: [{ $eq: ['$message.direction', 'outbound'] }, 1, 0] }
                    },
                    emailMessages: {
                        $sum: { $cond: [{ $eq: ['$message.content.type', 'email'] }, 1, 0] }
                    },
                    textMessages: {
                        $sum: { $cond: [{ $eq: ['$message.content.type', 'text'] }, 1, 0] }
                    },
                    smsMessages: {
                        $sum: { $cond: [{ $eq: ['$message.content.type', 'sms'] }, 1, 0] }
                    }
                }
            },
            {
                $project: {
                    _id: 0,
                    totalMessages: 1,
                    totalConversations: { $size: '$totalConversations' },
                    inboundMessages: 1,
                    outboundMessages: 1,
                    emailMessages: 1,
                    textMessages: 1,
                    smsMessages: 1
                }
            }
        ]);

        // Get agent statistics using User model
        const agents = await User.find({
            deactivated: false,
            role: { $in: ['sales_agent', 'data-tech_sales_agent'] }
        });

        const agentStats = [];

        for (const agent of agents) {
            const identifiers = [agent.phone, agent.email].filter(Boolean);

            const agentMessages = await MessageEvent.aggregate([
                {
                    $match: {
                        $or: [
                            { 'message.from.identifier': { $in: identifiers } },
                            { 'message.to.identifier': { $in: identifiers } }
                        ]
                    }
                },
                {
                    $group: {
                        _id: null,
                        totalMessages: { $sum: 1 },
                        inboundMessages: { $sum: { $cond: [{ $eq: ['$message.direction', 'inbound'] }, 1, 0] } },
                        outboundMessages: { $sum: { $cond: [{ $eq: ['$message.direction', 'outbound'] }, 1, 0] } },
                        conversations: { $addToSet: '$message.conversation_id' }
                    }
                }
            ]);

            const agentStat = agentMessages[0] || {
                totalMessages: 0,
                inboundMessages: 0,
                outboundMessages: 0,
                conversations: []
            };

            agentStats.push({
                agentId: agent._id,
                firstName: agent.firstName,
                lastName: agent.lastName,
                role: agent.role,
                email: agent.email,
                phone: agent.phone,
                ...agentStat,
                totalConversations: agentStat.conversations ? agentStat.conversations.length : 0
            });
        }

        // Get message trends (last 30 days)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const dailyStats = await MessageEvent.aggregate([
            {
                $match: {
                    'message.created_at': { $gte: thirtyDaysAgo }
                }
            },
            {
                $group: {
                    _id: {
                        date: { $dateToString: { format: '%Y-%m-%d', date: '$message.created_at' } },
                        direction: '$message.direction'
                    },
                    count: { $sum: 1 }
                }
            },
            {
                $sort: { '_id.date': 1 }
            }
        ]);

        // Get role-based statistics
        // Get role-based statistics - FIXED VERSION
        const roleStats = await MessageEvent.aggregate([
            {
                $addFields: {
                    identifier: {
                        $cond: [
                            { $eq: ['$message.direction', 'outbound'] },
                            '$message.from.identifier',
                            {
                                $cond: [
                                    { $isArray: '$message.to' },
                                    { $arrayElemAt: ['$message.to.identifier', 0] },
                                    '$message.to.identifier'
                                ]
                            }
                        ]
                    }
                }
            },
            {
                $lookup: {
                    from: 'users',
                    let: { identifier: '$identifier' },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $or: [
                                        { $eq: ['$phone', '$$identifier'] },
                                        { $eq: ['$email', '$$identifier'] }
                                    ]
                                },
                                deactivated: false
                            }
                        }
                    ],
                    as: 'user'
                }
            },
            {
                $unwind: { path: '$user', preserveNullAndEmptyArrays: true }
            },
            {
                $group: {
                    _id: '$user.role',
                    totalMessages: { $sum: 1 },
                    inboundMessages: { $sum: { $cond: [{ $eq: ['$message.direction', 'inbound'] }, 1, 0] } },
                    outboundMessages: { $sum: { $cond: [{ $eq: ['$message.direction', 'outbound'] }, 1, 0] } }
                }
            }
        ]);

        const contactCount = await ContactEvent.distinct('contact.id');

        res.json({
            success: true,
            data: {
                overview: {
                    ...stats[0],
                    totalContacts: contactCount.length
                },
                agentStats,
                roleStats,
                dailyTrends: dailyStats
            }
        });
    } catch (error) {
        console.error("Error fetching stats:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching statistics",
            error: error.message
        });
    }
};


// Get file info from Superchat API (returns metadata and CDN link)
exports.getMediaFile = async (req, res) => {
    try {
        const { fileId } = req.params;

        // Fetch file info from Superchat API
        const response = await axios.get(
            `https://api.superchat.com/v1.0/files/${fileId}`,
            {
                headers: {
                    'x-api-key': SUPERCHAT_API_KEY
                }
            }
        );

        // Return the file metadata and CDN link
        res.json({
            success: true,
            data: {
                id: response.data.id,
                name: response.data.name,
                mimeType: response.data.mime_type,
                cdnUrl: response.data.link.url,
                validUntil: response.data.link.valid_until,
                url: response.data.url
            }
        });
    } catch (error) {
        console.error("Error fetching media file info:", error);

        if (error.response?.status === 404) {
            return res.status(404).json({
                success: false,
                message: "Media file not found"
            });
        }

        if (error.response?.status === 401 || error.response?.status === 403) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized access to media file"
            });
        }

        res.status(500).json({
            success: false,
            message: "Error fetching media file info",
            error: error.message
        });
    }
};

// Remove the old getMediaFileInfo function since we're combining them
// NEW: Get media file info (metadata only)
exports.getMediaFileInfo = async (req, res) => {
    try {
        const { fileId } = req.params;

        const response = await axios.head(
            `https://api.superchat.com/v1.0/files/${fileId}`,
            {
                headers: {
                    'x-api-key': SUPERCHAT_API_KEY
                }
            }
        );

        res.json({
            success: true,
            data: {
                fileId,
                contentType: response.headers['content-type'],
                contentLength: response.headers['content-length'],
                lastModified: response.headers['last-modified']
            }
        });
    } catch (error) {
        console.error("Error fetching media info:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching media info",
            error: error.message
        });
    }
};

// Get all agents with their conversation statistics
exports.getAllAgentsWithStats = async (req, res) => {
    try {
        const { startDate, endDate } = req.query;

        // Build date query
        let dateQuery = {};
        if (startDate && endDate) {
            const start = new Date(startDate);
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            dateQuery = {
                'message.created_at': {
                    $gte: start.toISOString(),
                    $lte: end.toISOString()
                }
            };
        }

        // Get all active sales agents
        const agents = await User.find({
            deactivated: false,
            role: { $in: ['sales_agent', 'data-tech_sales_agent'] }
        }).lean();

        // Get customers assigned to each agent
        const agentStatsPromises = agents.map(async (agent) => {
            // Get assigned customers
            const assignedCustomers = await Customer.find({
                assignedTo: agent._id
            }).lean();

            // Build identifier arrays for matching
            const customerIdentifiers = assignedCustomers.flatMap(customer => [
                customer.phoneNumber,
                customer.Email,
                ...(customer.additionalPhoneNumbers || []),
                ...(customer.additionalEmails || [])
            ]).filter(Boolean).map(id => id.toLowerCase().trim());

            // Get message statistics
            const messageQuery = {
                ...dateQuery,
                $or: [
                    { 'message.from.identifier': { $in: customerIdentifiers } },
                    { 'message.to.identifier': { $in: customerIdentifiers } },
                    { 'message.to.0.identifier': { $in: customerIdentifiers } }
                ]
            };

            const messageStats = await MessageEvent.aggregate([
                { $match: messageQuery },
                {
                    $group: {
                        _id: null,
                        totalMessages: { $sum: 1 },
                        inboundMessages: {
                            $sum: { $cond: [{ $eq: ['$message.direction', 'inbound'] }, 1, 0] }
                        },
                        outboundMessages: {
                            $sum: { $cond: [{ $eq: ['$message.direction', 'outbound'] }, 1, 0] }
                        },
                        conversations: { $addToSet: '$message.conversation_id' }
                    }
                }
            ]);

            const stats = messageStats[0] || {
                totalMessages: 0,
                inboundMessages: 0,
                outboundMessages: 0,
                conversations: []
            };

            return {
                agent: {
                    id: agent._id,
                    firstName: agent.firstName,
                    lastName: agent.lastName,
                    email: agent.email,
                    phone: agent.phone,
                    role: agent.role
                },
                assignedCustomers: assignedCustomers.length,
                totalMessages: stats.totalMessages,
                messagesSent: stats.outboundMessages,
                messagesReceived: stats.inboundMessages,
                totalConversations: stats.conversations.length,
                customerDetails: assignedCustomers.map(c => ({
                    cardCode: c.CardCode,
                    cardName: c.CardName,
                    email: c.Email,
                    phone: c.phoneNumber
                }))
            };
        });

        const agentStats = await Promise.all(agentStatsPromises);

        // Sort by total messages descending
        agentStats.sort((a, b) => b.totalMessages - a.totalMessages);

        res.json({
            success: true,
            data: agentStats,
            dateRange: dateQuery['message.created_at'] || null
        });

    } catch (error) {
        console.error("Error fetching agents with stats:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching agent statistics",
            error: error.message
        });
    }
};

// Get agent's conversations with details
exports.getAgentConversations = async (req, res) => {
    try {
        const { agentId } = req.params;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 25;
        const skip = (page - 1) * limit;

        // Validate agent
        const agent = await User.findById(agentId);
        if (!agent) {
            return res.status(404).json({
                success: false,
                message: "Agent not found"
            });
        }

        // Get agent's customers
        const assignedCustomers = await Customer.find({
            assignedTo: agentId
        }).lean();

        if (assignedCustomers.length === 0) {
            return res.json({
                success: true,
                data: [],
                pagination: { page, limit, total: 0, pages: 0 }
            });
        }

        // Build identifier array
        const customerIdentifiers = assignedCustomers.flatMap(customer => [
            customer.phoneNumber,
            customer.Email,
            ...(customer.additionalPhoneNumbers || []),
            ...(customer.additionalEmails || [])
        ]).filter(Boolean).map(id => id.toLowerCase().trim());

        // Get conversations
        const conversations = await MessageEvent.aggregate([
            {
                $match: {
                    $or: [
                        { 'message.from.identifier': { $in: customerIdentifiers } },
                        { 'message.to.identifier': { $in: customerIdentifiers } },
                        { 'message.to.0.identifier': { $in: customerIdentifiers } }
                    ]
                }
            },
            {
                $addFields: {
                    customerIdentifier: {
                        $cond: [
                            { $eq: ['$message.direction', 'inbound'] },
                            '$message.from.identifier',
                            {
                                $cond: [
                                    { $isArray: '$message.to' },
                                    { $arrayElemAt: ['$message.to.identifier', 0] },
                                    '$message.to.identifier'
                                ]
                            }
                        ]
                    }
                }
            },
            {
                $group: {
                    _id: '$message.conversation_id',
                    messageCount: { $sum: 1 },
                    latestMessage: { $max: '$message.created_at' },
                    lastMessagePreview: { $last: '$message.content.body' },
                    lastMessageSubject: { $last: '$message.content.subject' },
                    lastDirection: { $last: '$message.direction' },
                    lastStatus: { $last: '$message.status' },
                    customerIdentifier: { $last: '$customerIdentifier' },
                    inboundCount: {
                        $sum: { $cond: [{ $eq: ['$message.direction', 'inbound'] }, 1, 0] }
                    },
                    outboundCount: {
                        $sum: { $cond: [{ $eq: ['$message.direction', 'outbound'] }, 1, 0] }
                    }
                }
            },
            { $sort: { latestMessage: -1 } },
            { $skip: skip },
            { $limit: limit }
        ]);

        // Map customer details
        const customerMap = {};
        assignedCustomers.forEach(customer => {
            const identifiers = [
                customer.phoneNumber,
                customer.Email,
                ...(customer.additionalPhoneNumbers || []),
                ...(customer.additionalEmails || [])
            ].filter(Boolean).map(id => id.toLowerCase().trim());

            identifiers.forEach(identifier => {
                customerMap[identifier] = customer;
            });
        });

        // Enrich conversations with customer data
        const enrichedConversations = conversations.map(conv => {
            const customer = customerMap[conv.customerIdentifier?.toLowerCase()?.trim()];
            return {
                conversationId: conv._id,
                messageCount: conv.messageCount,
                latestMessage: conv.latestMessage,
                preview: conv.lastMessagePreview || conv.lastMessageSubject || 'No preview',
                direction: conv.lastDirection,
                status: conv.lastStatus,
                inboundMessages: conv.inboundCount,
                outboundMessages: conv.outboundCount,
                customer: customer ? {
                    cardCode: customer.CardCode,
                    cardName: customer.CardName,
                    email: customer.Email,
                    phone: customer.phoneNumber
                } : {
                    identifier: conv.customerIdentifier
                }
            };
        });

        // Get total count
        const totalConversations = await MessageEvent.aggregate([
            {
                $match: {
                    $or: [
                        { 'message.from.identifier': { $in: customerIdentifiers } },
                        { 'message.to.identifier': { $in: customerIdentifiers } },
                        { 'message.to.0.identifier': { $in: customerIdentifiers } }
                    ]
                }
            },
            {
                $group: {
                    _id: '$message.conversation_id'
                }
            },
            { $count: 'total' }
        ]);

        const total = totalConversations[0]?.total || 0;

        res.json({
            success: true,
            data: enrichedConversations,
            agent: {
                id: agent._id,
                name: `${agent.firstName} ${agent.lastName}`,
                email: agent.email,
                role: agent.role
            },
            pagination: {
                page,
                limit,
                total,
                pages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error("Error fetching agent conversations:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching agent conversations",
            error: error.message
        });
    }
};

module.exports = exports;