// controllers/contactImport.controller.js
const ContactEvent = require("../models/Contact");
const csv = require('csv-parser');
const fs = require('fs');
const multer = require('multer');
const path = require('path');

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(process.cwd(), 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'contacts-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'text/csv' || path.extname(file.originalname).toLowerCase() === '.csv') {
            cb(null, true);
        } else {
            cb(new Error('Only CSV files are allowed'), false);
        }
    },
    limits: {
        fileSize: 50 * 1024 * 1024 // 50MB limit
    }
});

// Helper function to clean and validate phone numbers
const cleanPhoneNumber = (phone) => {
    if (!phone || typeof phone !== 'string') return null;

    // Remove all non-numeric characters except +
    let cleaned = phone.replace(/[^\d+]/g, '');

    // Handle scientific notation (like 2.1265E+11)
    if (phone.includes('E+')) {
        try {
            const number = parseFloat(phone);
            if (!isNaN(number)) {
                cleaned = number.toString();
            }
        } catch (e) {
            return null;
        }
    }

    // Ensure it starts with + for international format
    if (cleaned.length > 0 && !cleaned.startsWith('+')) {
        // Assume French number if starts with 33
        if (cleaned.startsWith('33')) {
            cleaned = '+' + cleaned;
        } else if (cleaned.length >= 10) {
            // Assume it needs country code
            cleaned = '+33' + cleaned;
        }
    }

    // Validate length (should be reasonable for phone numbers)
    if (cleaned.length < 8 || cleaned.length > 15) {
        return null;
    }

    return cleaned;
};

// Helper function to clean email
const cleanEmail = (email) => {
    if (!email || typeof email !== 'string') return null;

    const cleaned = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    return emailRegex.test(cleaned) ? cleaned : null;
};

// Helper function to parse gender
const parseGender = (gender) => {
    if (!gender || typeof gender !== 'string') return 'unknown';

    const cleaned = gender.toLowerCase().trim();

    // Handle German/French gender terms
    if (cleaned.includes('männlich') || cleaned.includes('male') || cleaned.includes('m')) {
        return 'male';
    } else if (cleaned.includes('weiblich') || cleaned.includes('female') || cleaned.includes('f')) {
        return 'female';
    }

    return 'unknown';
};

// Helper function to parse date
const parseDate = (dateString) => {
    if (!dateString || dateString.trim() === '') return null;

    try {
        const date = new Date(dateString);
        return isNaN(date.getTime()) ? null : date;
    } catch (e) {
        return null;
    }
};

// Helper function to generate contact ID if missing
const generateContactId = (firstName, lastName, phone, email) => {
    const base = [firstName, lastName, phone, email].filter(Boolean).join('_');
    return 'ct_' + Buffer.from(base).toString('base64').substring(0, 20);
};

// Import contacts from CSV file
exports.importContactsFromCSV = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "No CSV file uploaded"
            });
        }

        const filePath = req.file.path;
        const contacts = [];
        const errors = [];
        let processedRows = 0;
        let successfulImports = 0;
        let skippedRows = 0;

        // Read and process CSV - first detect the actual format
        let csvOptions = {
            skipEmptyLines: true,
            mapHeaders: ({ header }) => header.trim().toLowerCase().replace(/[^a-z0-9]/g, '_')
        };

        // Try to auto-detect separator by reading first line
        const firstLine = fs.readFileSync(filePath, 'utf8').split('\n')[0];
        if (firstLine.split('\t').length > firstLine.split(',').length) {
            csvOptions.separator = '\t';
        } else {
            csvOptions.separator = ',';
        }

        console.log(`Detected separator: ${csvOptions.separator === '\t' ? 'TAB' : 'COMMA'}`);
        console.log(`First line: ${firstLine}`);

        const stream = fs.createReadStream(filePath).pipe(csv(csvOptions));

        for await (const row of stream) {
            processedRows++;

            try {
                console.log(`Processing row ${processedRows}:`, row);

                // Map various possible column names
                const firstName = row.first_name || row.firstname || row['first name'] || '';
                const lastName = row.last_name || row.lastname || row['last name'] || '';
                const phone = row.phone || row.mobile || row.telephone || '';
                const email = row.email || row['e_mail_address'] || row['email_address'] || '';
                const gender = row.gender || '';
                const id = row.id || '';

                console.log(`Mapped data - Name: ${firstName} ${lastName}, Phone: ${phone}, Email: ${email}`);

                // Skip empty rows or rows with no meaningful data
                if (!firstName && !lastName && !phone && !email && !id) {
                    console.log(`Skipping empty row ${processedRows}`);
                    skippedRows++;
                    continue;
                }

                // Clean and prepare data
                const cleanedFirstName = firstName ? firstName.trim() : '';
                const cleanedLastName = lastName ? lastName.trim() : '';
                const cleanedPhone = cleanPhoneNumber(phone);
                const cleanedEmail = cleanEmail(email);
                const genderParsed = parseGender(gender);

                // Generate contact ID if missing or invalid
                let contactId = id && id.trim() ? id.trim() : null;
                if (!contactId || contactId.length < 3) {
                    contactId = generateContactId(cleanedFirstName, cleanedLastName, cleanedPhone, cleanedEmail);
                }

                // Skip if no valid contact method
                if (!cleanedPhone && !cleanedEmail && !cleanedFirstName && !cleanedLastName) {
                    console.log(`Skipping row ${processedRows} - no valid data`);
                    skippedRows++;
                    continue;
                }

                console.log(`Creating contact: ${cleanedFirstName} ${cleanedLastName} - Phone: ${cleanedPhone}, Email: ${cleanedEmail}`);

                // Build handles array
                const handles = [];
                let handleId = 1;

                if (cleanedPhone) {
                    handles.push({
                        id: `phone_${handleId++}`,
                        type: 'phone',
                        value: cleanedPhone
                    });
                }

                if (cleanedEmail) {
                    handles.push({
                        id: `email_${handleId++}`,
                        type: 'mail',
                        value: cleanedEmail
                    });
                }

                // Parse dates
                const lastMessageSent = parseDate(row.last_message_sent_at || row['last_message_sent_at']);
                const lastMessageReceived = parseDate(row.last_message_received_at || row['last_message_received_at']);

                // Build custom attributes for additional data
                const customAttributes = [];

                const labels = row.labels || row.label || '';
                if (labels && labels.trim()) {
                    customAttributes.push({
                        key: 'labels',
                        value: labels.trim()
                    });
                }

                const contactOwner = row.contact_owner || row['contact_owner'] || '';
                if (contactOwner && contactOwner.trim()) {
                    customAttributes.push({
                        key: 'contact_owner',
                        value: contactOwner.trim()
                    });
                }

                if (lastMessageSent) {
                    customAttributes.push({
                        key: 'last_message_sent_at',
                        value: lastMessageSent.toISOString()
                    });
                }

                if (lastMessageReceived) {
                    customAttributes.push({
                        key: 'last_message_received_at',
                        value: lastMessageReceived.toISOString()
                    });
                }

                // Check if contact already exists
                const existingContact = await ContactEvent.findOne({
                    'contact.id': contactId
                });

                if (existingContact) {
                    // Update existing contact
                    existingContact.contact.first_name = firstName || existingContact.contact.first_name;
                    existingContact.contact.last_name = lastName || existingContact.contact.last_name;
                    existingContact.contact.gender = gender !== 'unknown' ? gender : existingContact.contact.gender;
                    existingContact.contact.handles = handles.length > 0 ? handles : existingContact.contact.handles;
                    existingContact.contact.custom_attributes = customAttributes;
                    existingContact.contact.updated_at = new Date();
                    existingContact.event = 'contact_updated';
                    existingContact.processedAt = new Date();

                    await existingContact.save();
                } else {
                    // Create new contact
                    const contactEvent = new ContactEvent({
                        id: `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        contact: {
                            id: contactId,
                            first_name: cleanedFirstName || undefined,
                            last_name: cleanedLastName || undefined,
                            gender: genderParsed,
                            handles: handles,
                            custom_attributes: customAttributes,
                            created_at: new Date(),
                            updated_at: new Date()
                        },
                        event: 'contact_created',
                        processedAt: new Date(),
                        source: 'csv_import'
                    });

                    await contactEvent.save();
                    console.log(`Successfully created contact: ${contactId}`);
                }

                successfulImports++;

            } catch (error) {
                errors.push({
                    row: processedRows,
                    data: row,
                    error: error.message
                });
                console.error(`Error processing row ${processedRows}:`, error);
            }
        }

        // Clean up uploaded file
        fs.unlinkSync(filePath);

        res.json({
            success: true,
            message: "CSV import completed",
            data: {
                totalRows: processedRows,
                successfulImports: successfulImports,
                skippedRows: skippedRows,
                errors: errors.length,
                errorDetails: errors.slice(0, 10) // Only show first 10 errors
            }
        });

    } catch (error) {
        console.error("Error importing CSV:", error);

        // Clean up file if it exists
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

        res.status(500).json({
            success: false,
            message: "Error importing CSV file",
            error: error.message
        });
    }
};

// Validate CSV format before import
exports.validateCSVFormat = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "No CSV file uploaded"
            });
        }

        const filePath = req.file.path;
        const expectedHeaders = [
            'ID', 'Gender', 'First name', 'Last name', 'Phone',
            'E-Mail-address', 'Labels', 'Contact owner',
            'Last message sent at', 'Last message received at'
        ];

        let headers = [];
        let sampleRows = [];
        let rowCount = 0;

        const stream = fs.createReadStream(filePath)
            .pipe(csv({
                separator: '\t',
                skipEmptyLines: true
            }));

        for await (const row of stream) {
            if (rowCount === 0) {
                headers = Object.keys(row);
            }

            if (rowCount < 5) {
                sampleRows.push(row);
            }

            rowCount++;

            if (rowCount >= 5) break;
        }

        // Clean up file
        fs.unlinkSync(filePath);

        // Check header compatibility
        const headerMapping = {};
        const missingHeaders = [];

        expectedHeaders.forEach(expected => {
            const found = headers.find(h =>
                h.toLowerCase().includes(expected.toLowerCase().replace(/[^a-z]/g, ''))
            );
            if (found) {
                headerMapping[expected] = found;
            } else {
                missingHeaders.push(expected);
            }
        });

        res.json({
            success: true,
            data: {
                detectedHeaders: headers,
                expectedHeaders: expectedHeaders,
                headerMapping: headerMapping,
                missingHeaders: missingHeaders,
                sampleRows: sampleRows,
                isValid: missingHeaders.length === 0,
                recommendations: missingHeaders.length > 0 ?
                    `Missing headers: ${missingHeaders.join(', ')}. Please ensure your CSV has the correct column headers.` :
                    "CSV format looks good! You can proceed with the import."
            }
        });

    } catch (error) {
        console.error("Error validating CSV:", error);

        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

        res.status(500).json({
            success: false,
            message: "Error validating CSV file",
            error: error.message
        });
    }
};

// Get import statistics
exports.getImportStats = async (req, res) => {
    try {
        const stats = await ContactEvent.aggregate([
            {
                $group: {
                    _id: '$source',
                    count: { $sum: 1 },
                    latestImport: { $max: '$processedAt' }
                }
            },
            {
                $sort: { count: -1 }
            }
        ]);

        const totalContacts = await ContactEvent.distinct('contact.id');
        const recentImports = await ContactEvent.find({
            source: 'csv_import'
        })
            .sort({ processedAt: -1 })
            .limit(10)
            .select('contact.first_name contact.last_name processedAt')
            .lean();

        res.json({
            success: true,
            data: {
                totalUniqueContacts: totalContacts.length,
                importSources: stats,
                recentImports: recentImports
            }
        });

    } catch (error) {
        console.error("Error fetching import stats:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching import statistics",
            error: error.message
        });
    }
};

module.exports = { upload, ...exports };