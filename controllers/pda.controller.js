const axios = require('axios');
const mongoose = require('mongoose');
const PDA_ScrapeJob = require('../models/PDA_ScrapeJob');
const PDA_Supplier = require('../models/PDA_Supplier');
const PDA_RFQ = require('../models/PDA_RFQ');
const { generateRFQContent } = require('../utils/openaiService');
const { sendEmail } = require('../utils/emailService');

exports.initiateScrape = async (req, res) => {
    try {
        const { searchTerm, numSuppliers, europeanOnly } = req.body;

        // Validation
        if (!searchTerm || !numSuppliers) {
            return res.status(400).json({
                success: false,
                message: 'searchTerm and numSuppliers are required',
            });
        }

        if (numSuppliers < 1 || numSuppliers > 100) {
            return res.status(400).json({
                success: false,
                message: 'numSuppliers must be between 1 and 100',
            });
        }

        // Generate session ID
        const sessionId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Create scrape job in database
        const scrapeJob = new PDA_ScrapeJob({
            sessionId,
            searchTerm,
            numSuppliers,
            europeanOnly: europeanOnly || false,
            status: 'in_progress',  // SET IT HERE ONCE
            startedAt: new Date(),   // SET IT HERE ONCE
            createdBy: req.user._id,
        });

        await scrapeJob.save();
        await scrapeJob.addLog('info', 'Scrape job created and initiated');

        // Call Python API to start scraping - FIRE AND FORGET
        const pythonApiUrl = process.env.PYTHON_API_URL || 'http://localhost:8000';

        // Fire-and-forget: Don't wait for the scraping to complete
        setImmediate(() => {
            axios.post(
                `${pythonApiUrl}/scrape`,
                {
                    product: searchTerm,
                    num_suppliers: numSuppliers,
                    european_only: europeanOnly || false,
                    session_id: sessionId
                },
                {
                    timeout: 300000, // 5 minutes timeout for scraping
                }
            ).then(async (response) => {
                // REMOVE THE STATUS UPDATE - Just log success
                console.log(`✓ Scraping initiated for session: ${sessionId}`);
                const job = await PDA_ScrapeJob.findById(scrapeJob._id);
                if (job) {
                    await job.addLog('info', 'Python scraper started successfully');
                }
            }).catch(async (apiError) => {
                // Update job status on failure ONLY
                const job = await PDA_ScrapeJob.findById(scrapeJob._id);
                if (job) {
                    await job.addLog('error', `Failed to start Python scraper: ${apiError.message}`);
                    job.status = 'failed';
                    job.error = apiError.message;
                    await job.save();
                    console.error(`✗ Scraping failed for session: ${sessionId} - ${apiError.message}`);
                }
            });
        });

        // REMOVE THESE LINES - They're duplicates and overwrite the webhook update
        // scrapeJob.status = 'in_progress';
        // scrapeJob.startedAt = new Date();
        // await scrapeJob.save();
        // await scrapeJob.addLog('info', 'Scraping request initiated');

        // Return immediately - don't wait for scraping to complete
        return res.status(200).json({
            success: true,
            message: 'Scraping job initiated successfully',
            data: {
                jobId: scrapeJob._id,
                sessionId: scrapeJob.sessionId,
                searchTerm: scrapeJob.searchTerm,
                status: scrapeJob.status,
            },
        });

    } catch (error) {
        console.error('Error initiating scrape:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message,
        });
    }
};

exports.scrapeWebhook = async (req, res) => {
    try {
        const { session_id, status, result } = req.body;

        console.log(`Received webhook for session ${session_id}: ${status}`);
        console.log('Webhook result:', result); // ADD THIS

        // Find the scrape job
        const scrapeJob = await PDA_ScrapeJob.findOne({ sessionId: session_id });

        if (!scrapeJob) {
            console.error(`Scrape job not found for session ${session_id}`);
            return res.status(404).json({
                success: false,
                message: 'Scrape job not found',
            });
        }

        console.log(`Found job: ${scrapeJob._id}, current status: ${scrapeJob.status}`); // ADD THIS

        if (status === 'completed' && result.success) {
            console.log('Processing completed webhook...'); // ADD THIS

            // Update job status
            scrapeJob.status = 'completed';
            scrapeJob.completedAt = new Date();
            scrapeJob.progress = 100;
            scrapeJob.totalSuppliersFound = result.inserted_count || result.total_suppliers || 0;
            scrapeJob.sources = result.sources || [];
            await scrapeJob.addLog('info', `Scraping completed: ${scrapeJob.totalSuppliersFound} suppliers found`);
            await scrapeJob.save(); // ADD THIS - Save immediately

            console.log(`✓ Job status updated to 'completed'`); // ADD THIS

            // Fetch suppliers from Python MongoDB and save to Node MongoDB
            try {
                console.log('Starting to fetch suppliers from Python MongoDB...'); // ADD THIS

                const mongoose = require('mongoose');
                const pythonMongoUrl = process.env.MONGO_URI || process.env.PYTHON_MONGO_URL;

                if (!pythonMongoUrl) {
                    throw new Error('MongoDB URL not configured');
                }

                console.log(`Connecting to Python MongoDB at: ${pythonMongoUrl.substring(0, 20)}...`); // ADD THIS

                // Create a separate connection to read from Python's collection
                const pythonConnection = await mongoose.createConnection(pythonMongoUrl, {
                    useNewUrlParser: true,
                    useUnifiedTopology: true,
                }).asPromise();

                console.log('✓ Connected to Python MongoDB'); // ADD THIS

                // Access Python's scraped_suppliers collection
                const ScrapedSupplier = pythonConnection.model(
                    'ScrapedSupplier',
                    new mongoose.Schema({}, { strict: false }),
                    'scraped_suppliers'
                );

                console.log(`Searching for suppliers with session_id: ${session_id}`); // ADD THIS

                // Find all suppliers from this session
                const suppliers = await ScrapedSupplier.find({
                    'metadata.scrape_session_id': session_id
                }).lean();

                console.log(`Found ${suppliers.length} suppliers from Python MongoDB`);

                if (suppliers.length > 0) {
                    // Save each supplier to Node MongoDB
                    const savedSuppliers = [];
                    for (const supplier of suppliers) {
                        try {
                            const newSupplier = new PDA_Supplier({
                                scrapeJobId: scrapeJob._id,
                                sessionId: session_id,
                                searchTerm: scrapeJob.searchTerm,
                                supplierName: supplier.supplier_name || supplier.company_name || 'Unknown',
                                country: supplier.country,
                                scrapedFrom: supplier.scraped_from || supplier.metadata?.source || 'unknown',
                                contactInfo: supplier.contact_info || {},
                                rawData: supplier,
                            });

                            await newSupplier.save();
                            savedSuppliers.push(newSupplier);
                        } catch (supplierError) {
                            console.error(`Error saving supplier: ${supplierError.message}`);
                        }
                    }

                    await scrapeJob.addLog('info', `Saved ${savedSuppliers.length} suppliers to database`);
                    console.log(`✓ Saved ${savedSuppliers.length} suppliers to Node MongoDB`);
                } else {
                    await scrapeJob.addLog('warning', 'No suppliers found in Python MongoDB');
                    console.log('⚠ No suppliers found in Python MongoDB'); // ADD THIS
                }

                // Close the Python connection
                await pythonConnection.close();
                console.log('✓ Python MongoDB connection closed'); // ADD THIS

            } catch (fetchError) {
                console.error('Error fetching suppliers from Python MongoDB:', fetchError);
                await scrapeJob.addLog('error', `Failed to fetch suppliers: ${fetchError.message}`);
                // Don't fail the webhook response even if supplier fetch fails
            }

            return res.status(200).json({
                success: true,
                message: 'Webhook processed successfully',
            });
        } else {
            console.log('Processing failed webhook...'); // ADD THIS

            // Scraping failed
            scrapeJob.status = 'failed';
            scrapeJob.completedAt = new Date();
            scrapeJob.error = result.error || 'Unknown error';
            await scrapeJob.addLog('error', `Scraping failed: ${scrapeJob.error}`);
            await scrapeJob.save();

            console.log(`✓ Job status updated to 'failed'`); // ADD THIS

            return res.status(200).json({
                success: true,
                message: 'Webhook processed (job failed)',
            });
        }
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).json({
            success: false,
            message: 'Error processing webhook',
            error: error.message,
        });
    }
};

// Get scrape job status and logs
exports.getJobStatus = async (req, res) => {
    try {
        const { jobId } = req.params;

        const scrapeJob = await PDA_ScrapeJob.findById(jobId)
            .populate('createdBy', 'firstName lastName email');

        if (!scrapeJob) {
            return res.status(404).json({
                success: false,
                message: 'Scrape job not found',
            });
        }

        // Check authorization
        if (req.user.role !== 'admin' && req.user.role !== 'superAdmin' &&
            scrapeJob.createdBy._id.toString() !== req.user._id.toString()) {
            return res.status(403).json({
                success: false,
                message: 'Not authorized to view this job',
            });
        }

        res.status(200).json({
            success: true,
            data: scrapeJob,
        });
    } catch (error) {
        console.error('Error getting job status:', error);
        res.status(500).json({
            success: false,
            message: 'Error retrieving job status',
            error: error.message,
        });
    }
};

// Get all scrape jobs for user
exports.getAllJobs = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        let query = {};

        // Role-based filtering
        if (req.user.role !== 'admin' && req.user.role !== 'superAdmin') {
            query.createdBy = req.user._id;
        }

        // Status filter
        if (req.query.status) {
            query.status = req.query.status;
        }

        // Search term filter
        if (req.query.searchTerm) {
            query.searchTerm = { $regex: req.query.searchTerm, $options: 'i' };
        }

        const jobs = await PDA_ScrapeJob.find(query)
            .populate('createdBy', 'firstName lastName email')
            .skip(skip)
            .limit(limit)
            .sort({ createdAt: -1 });

        const total = await PDA_ScrapeJob.countDocuments(query);

        res.status(200).json({
            success: true,
            count: jobs.length,
            total,
            page,
            pages: Math.ceil(total / limit),
            data: jobs,
        });
    } catch (error) {
        console.error('Error getting jobs:', error);
        res.status(500).json({
            success: false,
            message: 'Error retrieving jobs',
            error: error.message,
        });
    }
};

// Get suppliers for a job
exports.getJobSuppliers = async (req, res) => {
    try {
        const { jobId } = req.params;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        // Verify job exists and user has access
        const scrapeJob = await PDA_ScrapeJob.findById(jobId);

        if (!scrapeJob) {
            return res.status(404).json({
                success: false,
                message: 'Scrape job not found',
            });
        }

        if (req.user.role !== 'admin' && req.user.role !== 'superAdmin' &&
            scrapeJob.createdBy.toString() !== req.user._id.toString()) {
            return res.status(403).json({
                success: false,
                message: 'Not authorized to view this job',
            });
        }

        // Get suppliers
        const query = { scrapeJobId: jobId, isActive: true };

        // Filter by contact availability
        if (req.query.hasContact === 'true') {
            query['$or'] = [
                { 'contactInfo.email': { $exists: true, $ne: null, $ne: '' } },
                { 'contactInfo.phone': { $exists: true, $ne: null, $ne: '' } },
            ];
        }

        const suppliers = await PDA_Supplier.find(query)
            .skip(skip)
            .limit(limit)
            .sort({ createdAt: -1 });

        const total = await PDA_Supplier.countDocuments(query);

        res.status(200).json({
            success: true,
            count: suppliers.length,
            total,
            page,
            pages: Math.ceil(total / limit),
            data: suppliers,
        });
    } catch (error) {
        console.error('Error getting suppliers:', error);
        res.status(500).json({
            success: false,
            message: 'Error retrieving suppliers',
            error: error.message,
        });
    }
};

// Get suppliers by search term
exports.getSuppliersBySearchTerm = async (req, res) => {
    try {
        const { searchTerm } = req.params;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        const query = {
            searchTerm: { $regex: searchTerm, $options: 'i' },
            isActive: true,
        };

        // Filter by contact availability
        if (req.query.hasContact === 'true') {
            query['$or'] = [
                { 'contactInfo.email': { $exists: true, $ne: null, $ne: '' } },
                { 'contactInfo.phone': { $exists: true, $ne: null, $ne: '' } },
            ];
        }

        const suppliers = await PDA_Supplier.find(query)
            .populate('scrapeJobId', 'sessionId createdAt')
            .skip(skip)
            .limit(limit)
            .sort({ createdAt: -1 });

        const total = await PDA_Supplier.countDocuments(query);

        res.status(200).json({
            success: true,
            count: suppliers.length,
            total,
            page,
            pages: Math.ceil(total / limit),
            searchTerm,
            data: suppliers,
        });
    } catch (error) {
        console.error('Error getting suppliers by search term:', error);
        res.status(500).json({
            success: false,
            message: 'Error retrieving suppliers',
            error: error.message,
        });
    }
};

// Generate and send RFQ to suppliers
exports.generateAndSendRFQ = async (req, res) => {
    try {
        const {
            supplierIds,
            supplierEmails,
            items,
            quotationDueDate,
            deliveryBy,
            packagingRequirements,
            paymentTermsPreference,
            otherNotes,
            contactEmail,
            contactPhone,
        } = req.body;

        // Validation
        if (!supplierIds || !Array.isArray(supplierIds) || supplierIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'At least one supplier is required',
            });
        }

        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'At least one item is required',
            });
        }

        if (!quotationDueDate) {
            return res.status(400).json({
                success: false,
                message: 'Quotation due date is required',
            });
        }

        // Get suppliers
        const suppliers = await PDA_Supplier.find({
            _id: { $in: supplierIds },
            isActive: true,
        });

        if (suppliers.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No valid suppliers found',
            });
        }

        // MODIFY: Filter suppliers with email (from DB or manually provided)
        const suppliersWithEmail = suppliers.filter(s =>
            s.contactInfo?.email || (supplierEmails && supplierEmails[s._id.toString()])
        );

        if (suppliersWithEmail.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'None of the selected suppliers have email addresses',
            });
        }


        // Get search term from first supplier (they should all be from same search)
        const searchTerm = suppliers[0].searchTerm;
        const scrapeJobId = suppliers[0].scrapeJobId;

        // Generate RFQ content using OpenAI
        console.log('Generating RFQ content with AI...');
        const rfqContent = await generateRFQContent({
            items,
            searchTerm,
            packagingRequirements,
            paymentTermsPreference,
            otherNotes,
        });

        // Create RFQ record
        const rfq = new PDA_RFQ({
            scrapeJobId,
            searchTerm,
            subject: rfqContent.subject,
            body: rfqContent.body,
            items,
            quotationDueDate: new Date(quotationDueDate),
            deliveryBy: deliveryBy ? new Date(deliveryBy) : null,
            contactEmail: contactEmail || req.user.email,
            contactPhone,
            packagingRequirements,
            paymentTermsPreference,
            otherNotes,
            createdBy: req.user._id,
            generatedBy: 'ai',
            aiModel: 'gpt-4o-mini',
            suppliers: [],
        });

        await rfq.save();

        // Send emails to each supplier
        const sendResults = [];

        for (const supplier of suppliersWithEmail) {
            try {
                // GET EMAIL: Use DB email or manually provided email
                const supplierEmail = supplier.contactInfo?.email ||
                    (supplierEmails && supplierEmails[supplier._id.toString()]);

                if (!supplierEmail) {
                    console.log(`Skipping ${supplier.supplierName} - no email`);
                    continue;
                }

                // Personalize the email
                const personalizedBody = rfqContent.body.replace(
                    '[Supplier Name]',
                    supplier.supplierName
                );

                const emailInfo = await sendEmail({
                    to: supplierEmail, // USE THE EMAIL WE DETERMINED ABOVE
                    subject: rfqContent.subject,
                    text: personalizedBody,
                    html: personalizedBody.replace(/\n/g, '<br>'),
                    emailType: 'rfq',
                    sentBy: req.user._id,
                    sentByName: `${req.user.firstName} ${req.user.lastName}`,
                    metadata: {
                        rfqNumber: rfq.rfqNumber,
                        supplierId: supplier._id,
                        searchTerm,
                    },
                });

                // Add supplier to RFQ record
                rfq.suppliers.push({
                    supplierId: supplier._id,
                    supplierName: supplier.supplierName,
                    supplierEmail: supplierEmail, // SAVE THE EMAIL USED
                    status: 'sent',
                    sentAt: new Date(),
                    emailMessageId: emailInfo.messageId,
                });

                // Update supplier record with the email if it was manually provided
                if (!supplier.contactInfo?.email && supplierEmail) {
                    supplier.contactInfo = supplier.contactInfo || {};
                    supplier.contactInfo.email = supplierEmail;
                }

                supplier.rfqsSent.push(rfq._id);
                supplier.lastRFQSentAt = new Date();
                await supplier.save();

                sendResults.push({
                    supplierId: supplier._id,
                    supplierName: supplier.supplierName,
                    email: supplierEmail,
                    status: 'sent',
                });

                console.log(`✓ RFQ sent to ${supplier.supplierName} at ${supplierEmail}`);
            } catch (emailError) {
                console.error(`✗ Failed to send RFQ to ${supplier.supplierName}:`, emailError);

                const supplierEmail = supplier.contactInfo?.email ||
                    (supplierEmails && supplierEmails[supplier._id.toString()]);

                rfq.suppliers.push({
                    supplierId: supplier._id,
                    supplierName: supplier.supplierName,
                    supplierEmail: supplierEmail,
                    status: 'failed',
                    sentAt: new Date(),
                });

                sendResults.push({
                    supplierId: supplier._id,
                    supplierName: supplier.supplierName,
                    email: supplierEmail,
                    status: 'failed',
                    error: emailError.message,
                });
            }
        }

        // Update RFQ status
        rfq.status = 'sent';
        await rfq.save();

        res.status(201).json({
            success: true,
            message: `RFQ sent to ${sendResults.filter(r => r.status === 'sent').length} suppliers`,
            data: {
                rfq: {
                    _id: rfq._id,
                    rfqNumber: rfq.rfqNumber,
                    subject: rfq.subject,
                    dateIssued: rfq.dateIssued,
                    quotationDueDate: rfq.quotationDueDate,
                },
                sendResults,
            },
        });
    } catch (error) {
        console.error('Error generating and sending RFQ:', error);
        res.status(500).json({
            success: false,
            message: 'Error generating and sending RFQ',
            error: error.message,
        });
    }
};

// Get all RFQs
exports.getAllRFQs = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        let query = {};

        // Role-based filtering
        if (req.user.role !== 'admin' && req.user.role !== 'superAdmin') {
            query.createdBy = req.user._id;
        }

        // Status filter
        if (req.query.status) {
            query.status = req.query.status;
        }

        // Search term filter
        if (req.query.searchTerm) {
            query.searchTerm = { $regex: req.query.searchTerm, $options: 'i' };
        }

        const rfqs = await PDA_RFQ.find(query)
            .populate('createdBy', 'firstName lastName email')
            .populate('scrapeJobId', 'sessionId searchTerm')
            .skip(skip)
            .limit(limit)
            .sort({ dateIssued: -1 });

        const total = await PDA_RFQ.countDocuments(query);

        res.status(200).json({
            success: true,
            count: rfqs.length,
            total,
            page,
            pages: Math.ceil(total / limit),
            data: rfqs,
        });
    } catch (error) {
        console.error('Error getting RFQs:', error);
        res.status(500).json({
            success: false,
            message: 'Error retrieving RFQs',
            error: error.message,
        });
    }
};

// Get single RFQ
exports.getRFQById = async (req, res) => {
    try {
        const { rfqId } = req.params;

        const rfq = await PDA_RFQ.findById(rfqId)
            .populate('createdBy', 'firstName lastName email')
            .populate('scrapeJobId', 'sessionId searchTerm')
            .populate('suppliers.supplierId');

        if (!rfq) {
            return res.status(404).json({
                success: false,
                message: 'RFQ not found',
            });
        }

        // Check authorization
        if (req.user.role !== 'admin' && req.user.role !== 'superAdmin' &&
            rfq.createdBy._id.toString() !== req.user._id.toString()) {
            return res.status(403).json({
                success: false,
                message: 'Not authorized to view this RFQ',
            });
        }

        res.status(200).json({
            success: true,
            data: rfq,
        });
    } catch (error) {
        console.error('Error getting RFQ:', error);
        res.status(500).json({
            success: false,
            message: 'Error retrieving RFQ',
            error: error.message,
        });
    }
};

exports.getRFQResponses = async (req, res) => {
    try {
        const { rfqId } = req.params;

        const rfq = await PDA_RFQ.findById(rfqId)
            .populate('createdBy', 'firstName lastName email')
            .populate('scrapeJobId', 'sessionId searchTerm')
            .populate('suppliers.supplierId');

        if (!rfq) {
            return res.status(404).json({
                success: false,
                message: 'RFQ not found',
            });
        }

        // Check authorization
        if (req.user.role !== 'admin' && req.user.role !== 'superAdmin' &&
            rfq.createdBy._id.toString() !== req.user._id.toString()) {
            return res.status(403).json({
                success: false,
                message: 'Not authorized to view this RFQ',
            });
        }

        // Get suppliers who have responded
        const responses = rfq.suppliers.filter(s => s.status === 'responded');

        res.status(200).json({
            success: true,
            data: {
                rfq: {
                    _id: rfq._id,
                    rfqNumber: rfq.rfqNumber,
                    subject: rfq.subject,
                    dateIssued: rfq.dateIssued,
                },
                totalSuppliers: rfq.suppliers.length,
                totalResponses: responses.length,
                responses,
            },
        });
    } catch (error) {
        console.error('Error getting RFQ responses:', error);
        res.status(500).json({
            success: false,
            message: 'Error retrieving RFQ responses',
            error: error.message,
        });
    }
};

// Manually mark response as received
exports.markRFQResponse = async (req, res) => {
    try {
        const { rfqId, supplierId } = req.params;
        const { quotedPrice, deliveryTime, notes, attachments } = req.body;

        const rfq = await PDA_RFQ.findById(rfqId);

        if (!rfq) {
            return res.status(404).json({
                success: false,
                message: 'RFQ not found',
            });
        }

        // Find the supplier in the RFQ
        const supplierIndex = rfq.suppliers.findIndex(
            s => s.supplierId.toString() === supplierId
        );

        if (supplierIndex === -1) {
            return res.status(404).json({
                success: false,
                message: 'Supplier not found in this RFQ',
            });
        }

        // Update supplier response
        rfq.suppliers[supplierIndex].status = 'responded';
        rfq.suppliers[supplierIndex].respondedAt = new Date();
        rfq.suppliers[supplierIndex].response = {
            quotedPrice,
            deliveryTime,
            notes,
            attachments: attachments || [],
            receivedAt: new Date(),
        };

        await rfq.save();

        res.status(200).json({
            success: true,
            message: 'Response recorded successfully',
            data: rfq.suppliers[supplierIndex],
        });
    } catch (error) {
        console.error('Error marking RFQ response:', error);
        res.status(500).json({
            success: false,
            message: 'Error recording response',
            error: error.message,
        });
    }
};

exports.getAllSuppliers = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        let query = { isActive: true };

        // Role-based filtering (if not admin, only show own suppliers)
        if (req.user.role !== 'admin' && req.user.role !== 'superAdmin') {
            // Find all jobs created by this user
            const userJobs = await PDA_ScrapeJob.find({ createdBy: req.user._id }).select('_id');
            const jobIds = userJobs.map(job => job._id);
            query.scrapeJobId = { $in: jobIds };
        }

        // Filter by contact availability
        if (req.query.hasContact) {
            if (req.query.hasContact === 'email') {
                query['contactInfo.email'] = { $exists: true, $ne: null, $ne: '' };
            } else if (req.query.hasContact === 'phone') {
                query['$or'] = [
                    { 'contactInfo.phone': { $exists: true, $ne: null, $ne: '' } },
                    { 'rawData.contact_phone': { $exists: true, $ne: null } },
                ];
            } else if (req.query.hasContact === 'true') {
                query['$or'] = [
                    { 'contactInfo.email': { $exists: true, $ne: null, $ne: '' } },
                    { 'contactInfo.phone': { $exists: true, $ne: null, $ne: '' } },
                    { 'rawData.contact_phone': { $exists: true, $ne: null } },
                ];
            }
        }

        // Filter by country
        if (req.query.country) {
            query.country = req.query.country;
        }

        // Filter by source
        if (req.query.source) {
            query.scrapedFrom = req.query.source;
        }

        // Get suppliers
        const suppliers = await PDA_Supplier.find(query)
            .populate('scrapeJobId', 'sessionId searchTerm createdAt')
            .skip(skip)
            .limit(limit)
            .sort({ createdAt: -1 });

        const total = await PDA_Supplier.countDocuments(query);

        // Calculate stats
        const statsQuery = req.user.role !== 'admin' && req.user.role !== 'superAdmin'
            ? { isActive: true, scrapeJobId: query.scrapeJobId }
            : { isActive: true };

        const stats = {
            total: await PDA_Supplier.countDocuments(statsQuery),
            withEmail: await PDA_Supplier.countDocuments({
                ...statsQuery,
                'contactInfo.email': { $exists: true, $ne: null, $ne: '' }
            }),
            withPhone: await PDA_Supplier.countDocuments({
                ...statsQuery,
                '$or': [
                    { 'contactInfo.phone': { $exists: true, $ne: null, $ne: '' } },
                    { 'rawData.contact_phone': { $exists: true, $ne: null } },
                ]
            }),
            countries: (await PDA_Supplier.distinct('country', statsQuery)).length,
        };

        res.status(200).json({
            success: true,
            count: suppliers.length,
            total,
            page,
            pages: Math.ceil(total / limit),
            stats,
            data: suppliers,
        });
    } catch (error) {
        console.error('Error getting all suppliers:', error);
        res.status(500).json({
            success: false,
            message: 'Error retrieving suppliers',
            error: error.message,
        });
    }
};

module.exports = exports;