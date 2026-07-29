// config/config.js
// Add this to your existing config file

// Fixed mailbox for every RFQ: printed as the contact on the RFQ PDF/email and
// set as Reply-To on all outbound RFQ mail, so supplier replies always land in
// the shared inbox the inbound agent watches. Deliberately NOT env-driven and
// not editable from the UI — agents were entering personal addresses and the
// replies were never picked up.
const RFQ_CONTACT_EMAIL = 'halalfoods.services@gmail.com';

module.exports = {
  RFQ_CONTACT_EMAIL,
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

  // Company Information — single source of truth for all outbound emails + PDF.
  // Values come from .env. Where a value is missing we leave it EMPTY (not a
  // placeholder), so the email/PDF omits that line instead of printing fake info.
  company: {
    name: process.env.COMPANY_NAME || 'Halal Foods',
    legalName: process.env.COMPANY_LEGAL_NAME || process.env.COMPANY_NAME || 'Halal Foods',
    address: process.env.COMPANY_ADDRESS || '',
    phone: process.env.COMPANY_PHONE || '',
    // Fall back to the actual sending mailbox so the footer matches the From domain.
    email: process.env.COMPANY_EMAIL || process.env.EMAIL_USER || '',
    website: process.env.COMPANY_WEBSITE || '',
    // Who signs the emails — a real person reads far more human than "Procurement Team".
    signerName: process.env.COMPANY_SIGNER_NAME || '',
    signerTitle: process.env.COMPANY_SIGNER_TITLE || 'Procurement',
    vat: process.env.COMPANY_VAT || '',
  },

  // File Upload Configuration
  upload: {
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024, // 10MB
    allowedFileTypes: ['application/pdf', 'image/jpeg', 'image/png'],
  },

};
