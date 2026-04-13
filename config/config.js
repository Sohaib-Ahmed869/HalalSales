// config/config.js
// Add this to your existing config file

module.exports = {
  // Other configurations...
  mongodb: {
    uri: process.env.MONGODB_URI,
    options: {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    },
  },
  // Email configuration
  email: {
    host: process.env.EMAIL_HOST,
    port: parseInt(process.env.EMAIL_PORT, 10) || 587,
    // FIX: Read EMAIL_SECURE from env, not calculate from port
    secure: process.env.EMAIL_SECURE === 'true', // ← CHANGED
    user: process.env.EMAIL_USER,
    password: process.env.EMAIL_PASSWORD,
    senderName: process.env.EMAIL_SENDER_NAME || "Halal Food Service",
  },
  openai: {
    apiKey: process.env.NEW_OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-4o',
  },
  // RFQ Configuration
  rfq: {
    defaultQuotationDueDays: parseInt(process.env.RFQ_DUE_DAYS) || 7,
    defaultDeliveryDays: parseInt(process.env.RFQ_DELIVERY_DAYS) || 14,
    maxVendorsPerRFQ: parseInt(process.env.RFQ_MAX_VENDORS) || 20,
    minVendorsPerRFQ: parseInt(process.env.RFQ_MIN_VENDORS) || 3,
  },

  // Company Information
  company: {
    name: 'Halal Foods',
    address: 'Paris, France',
    phone: process.env.COMPANY_PHONE || '+33 1 XX XX XX XX',
    email: process.env.COMPANY_EMAIL || 'contact@halalfoods.fr',
    website: process.env.COMPANY_WEBSITE || 'www.halalfoods.fr',
  },

  // File Upload Configuration
  upload: {
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024, // 10MB
    allowedFileTypes: ['application/pdf', 'image/jpeg', 'image/png'],
  },

};
