// routes/aiOutreach.routes.js — the AI WhatsApp outreach (hfs-intelligence), from HalalSales.
const express = require("express");
const { auth, checkRole } = require("../middleware/auth");
const ctrl = require("../controllers/aiOutreach.controller");

const router = express.Router();
const managers = checkRole(ctrl.MANAGERS);

// A lead's AI conversation (agents: their own leads only).
router.get("/leads/:leadId/conversation", auth, ctrl.getLeadConversation);
router.post("/leads/:leadId/takeover", auth, ctrl.takeoverLeadConversation);
router.post("/leads/:leadId/resume", auth, ctrl.resumeLeadConversation);

// A customer's AI conversations, for the customer page (agents: their own customers only).
router.get("/customers/:cardCode/conversation", auth, ctrl.getCustomerConversation);

// Any outreach conversation by thread, and assigning an account to an agent — admins and sales managers.
router.get("/threads/:threadId", auth, managers, ctrl.getThreadConversation);
router.post("/threads/:threadId/takeover", auth, managers, ctrl.takeoverThread);
router.post("/threads/:threadId/resume", auth, managers, ctrl.resumeThread);
router.post("/assign", auth, managers, ctrl.assignAccount);

// Batches — admins and sales managers.
router.get("/overview", auth, managers, ctrl.overview);
router.get("/batches/options", auth, managers, ctrl.batchOptions);
router.get("/batches", auth, managers, ctrl.listBatches);
router.post("/batches/preview", auth, managers, ctrl.previewBatch);
router.post("/batches", auth, managers, ctrl.createBatch);
router.get("/batches/:id", auth, managers, ctrl.batchReport);
router.post("/batches/:id/stop", auth, managers, ctrl.stopBatch);

// The October catalogue to the new Uber Eats prospects — admins and sales managers.
router.get("/catalogue", auth, managers, ctrl.listCatalogue);
router.post("/catalogue/preview", auth, managers, ctrl.previewCatalogue);
router.post("/catalogue", auth, managers, ctrl.createCatalogue);
router.get("/catalogue/:id", auth, managers, ctrl.catalogueReport);
router.post("/catalogue/:id/stop", auth, managers, ctrl.stopCatalogue);

// A lead's emails (campaigns, catalogue, AI replies) with their delivery/open/click events (agents: their own leads only).
router.get("/leads/:leadId/emails", auth, ctrl.getLeadEmails);

// Scheduled email campaigns (Amazon SES / Sendy) — admins and sales managers.
router.get("/email-campaigns/options", auth, managers, ctrl.emailCampaignOptions);
router.get("/email-campaigns/health", auth, managers, ctrl.emailCampaignHealth);
router.get("/email-campaigns/calendar", auth, managers, ctrl.emailCampaignCalendar);
router.get("/email-campaigns/sendy/lists", auth, managers, ctrl.emailCampaignSendyLists);
router.post("/email-campaigns/audience/preview", auth, managers, ctrl.previewEmailAudience);
router.post("/email-campaigns/plan", auth, managers, ctrl.planEmailCampaign);
router.post("/email-campaigns/test", auth, managers, ctrl.testEmailCampaign);
router.get("/email-campaigns", auth, managers, ctrl.listEmailCampaigns);
router.post("/email-campaigns", auth, managers, ctrl.createEmailCampaign);
router.get("/email-campaigns/:id", auth, managers, ctrl.getEmailCampaign);
router.patch("/email-campaigns/:id", auth, managers, ctrl.updateEmailCampaign);
router.delete("/email-campaigns/:id", auth, managers, ctrl.deleteEmailCampaign);
router.get("/email-campaigns/:id/kpis", auth, managers, ctrl.emailCampaignKpis);
router.get("/email-campaigns/:id/recipients", auth, managers, ctrl.emailCampaignRecipients);
router.get("/email-campaigns/:id/recipients/:messageId", auth, managers, ctrl.emailCampaignRecipient);
router.post("/email-campaigns/:id/schedule", auth, managers, ctrl.scheduleEmailCampaign);
router.post("/email-campaigns/:id/reschedule", auth, managers, ctrl.rescheduleEmailCampaign);
router.post("/email-campaigns/:id/pause", auth, managers, ctrl.pauseEmailCampaign);
router.post("/email-campaigns/:id/resume", auth, managers, ctrl.resumeEmailCampaign);
router.post("/email-campaigns/:id/cancel", auth, managers, ctrl.cancelEmailCampaign);
router.put("/email-campaigns/:id/waves/:index/sendy-list", auth, managers, ctrl.setEmailCampaignWaveList);
router.post("/email-campaigns/:id/waves/:index/sendy-confirm", auth, managers, ctrl.confirmEmailCampaignSendyWave);

module.exports = router;
