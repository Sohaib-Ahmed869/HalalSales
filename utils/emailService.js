// utils/emailService.js
const nodemailer = require("nodemailer");
const config = require("../config/config");
const { logEmail } = require("./emailLogger");
const fs = require("fs");
const path = require("path");

// Validate configuration
if (!config.email.user || !config.email.password) {
  console.error('❌ EMAIL CONFIGURATION ERROR: Missing EMAIL_USER or EMAIL_PASSWORD');
  throw new Error('Email configuration is incomplete. Please check your .env file.');
}

// Create reusable transporter with connection pooling
const transporter = nodemailer.createTransport({
  host: config.email.host,
  port: config.email.port,
  secure: config.email.secure,
  auth: {
    user: config.email.user,
    pass: config.email.password,
  },
  // Connection pooling
  pool: true,
  maxConnections: 5,      // Allow up to 5 concurrent connections
  maxMessages: 100,       // Max messages per connection
  rateDelta: 1000,        // 1 second between messages
  rateLimit: 3,           // 3 emails per second max

  // Timeouts
  connectionTimeout: 10000,
  greetingTimeout: 5000,
  socketTimeout: 15000,

  // Debugging (only in development)
  debug: process.env.NODE_ENV === 'development',
  logger: process.env.NODE_ENV === 'development',
});

// Verify transporter on startup
transporter.verify(function (error, success) {
  if (error) {
    console.error('❌ SMTP connection verification failed:', error.message);
  } else {
    console.log('✅ SMTP server is ready to send emails');
    console.log(`   Host: ${config.email.host}:${config.email.port}`);
    console.log(`   User: ${config.email.user}`);
  }
});

/**
 * Send an email with optional attachments
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} [options.cc] - CC recipient email
 * @param {string} [options.bcc] - BCC recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.text - Plain text email body
 * @param {string} [options.html] - HTML email body (optional)
 * @param {Array} [options.attachments] - Email attachments
 * @param {string} [options.emailType] - Type of email (invoice, invoice_apology, etc.)
 * @param {string} [options.relatedInvoice] - Related invoice ID
 * @param {string} [options.relatedCustomer] - Related customer ID
 * @param {string} [options.customerCardCode] - Customer card code
 * @param {string} [options.sentBy] - User ID who sent the email
 * @param {string} [options.sentByName] - Name of user who sent the email
 * @param {Object} [options.metadata] - Additional metadata
 * @returns {Promise<Object>} Nodemailer response
 */
async function sendEmail({
  to,
  cc,
  bcc,
  subject,
  text,
  html,
  attachments,
  emailType = "general",
  relatedInvoice = null,
  relatedCustomer = null,
  customerCardCode = null,
  sentBy = null,
  sentByName = null,
  metadata = {}
}) {
  const maxRetries = 3;
  let lastError = null;
  let info = null;

  try {
    console.log(`📧 Sending email to: ${to}`);

    // Validate attachments
    if (attachments && Array.isArray(attachments)) {
      for (let i = 0; i < attachments.length; i++) {
        const attachment = attachments[i];

        if (attachment.content && Buffer.isBuffer(attachment.content)) {
          console.log(`   Attachment ${i + 1}: ${attachment.filename} (${attachment.content.length} bytes)`);

          // Validate PDF
          if (attachment.contentType === "application/pdf") {
            if (attachment.content.length < 1000) {
              console.warn(`⚠ Warning: PDF attachment ${i + 1} is very small (${attachment.content.length} bytes)`);
            }

            const header = attachment.content.slice(0, 4).toString();
            if (header !== "%PDF") {
              console.warn(`⚠ Warning: PDF attachment ${i + 1} doesn't have valid PDF header`);
              const debugPath = path.join(__dirname, `../invalid-attachment-${Date.now()}.bin`);
              fs.writeFileSync(debugPath, attachment.content);
              console.log(`   Saved invalid attachment to ${debugPath}`);
            }
          }
        }
      }
    }

    // Prepare mail options
    const mailOptions = {
      from: `"${config.email.senderName}" <${config.email.user}>`,
      to,
      subject,
      text,
    };

    if (cc) mailOptions.cc = cc;
    if (bcc) mailOptions.bcc = bcc;
    if (html) mailOptions.html = html;

    if (attachments && Array.isArray(attachments)) {
      mailOptions.attachments = attachments.map((attachment) => ({
        filename: attachment.filename || "document.pdf",
        content: attachment.content,
        contentType: attachment.contentType || "application/pdf",
        encoding: "binary",
      }));
    }

    // Retry logic - use the SHARED transporter
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`   [Attempt ${attempt}/${maxRetries}] Sending...`);

        // Use the shared transporter (with connection pooling)
        info = await transporter.sendMail(mailOptions);

        console.log(`   ✅ Sent successfully: ${info.messageId}`);
        lastError = null;
        break; // Success - exit retry loop

      } catch (sendError) {
        lastError = sendError;
        console.error(`   ❌ Attempt ${attempt}/${maxRetries} failed: ${sendError.message}`);

        if (attempt < maxRetries) {
          const waitTime = attempt * 2000; // 2s, 4s, 6s
          console.log(`   ⏳ Waiting ${waitTime}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    // If all retries failed, throw
    if (lastError) {
      throw lastError;
    }

    // Log email to database and S3 (async, non-blocking)
    logEmail({
      to: Array.isArray(to) ? to : [to],
      cc: cc ? (Array.isArray(cc) ? cc : [cc]) : [],
      bcc: bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : [],
      subject,
      text,
      html,
      attachments: attachments || [],
      emailType,
      relatedInvoice,
      relatedCustomer,
      customerCardCode,
      status: "sent",
      messageId: info.messageId,
      sentBy,
      sentByName,
      metadata,
    }).catch((logError) => {
      console.error("⚠ Error logging email (non-blocking):", logError.message);
    });

    return info;

  } catch (error) {
    console.error(`❌ Failed to send email to ${to}:`, error.message);

    // Log failed email attempt (async, non-blocking)
    logEmail({
      to: Array.isArray(to) ? to : [to],
      cc: cc ? (Array.isArray(cc) ? cc : [cc]) : [],
      bcc: bcc ? (Array.isArray(bcc) ? bcc : [bcc]) : [],
      subject,
      text,
      html,
      attachments: attachments || [],
      emailType,
      relatedInvoice,
      relatedCustomer,
      customerCardCode,
      status: "failed",
      error: error.message,
      sentBy,
      sentByName,
      metadata,
    }).catch((logError) => {
      console.error("⚠ Error logging failed email (non-blocking):", logError.message);
    });

    throw new Error(`Failed to send email after ${maxRetries} attempts: ${error.message}`);
  }
}

module.exports = {
  sendEmail,
};