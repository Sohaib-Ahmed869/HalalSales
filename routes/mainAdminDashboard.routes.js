// routes/dashboardRoutes.js
const express = require("express");
const router = express.Router();
const dashboardController = require("../controllers/mainAdminDashboard.controller");
const { auth, checkRole } = require("../middleware/auth");

// All dashboard routes require auth + admin role
router.use(auth);
router.use(checkRole(["admin"]));

// ─── KPI Summary ────────────────────────────────────────────
// GET /api/dashboard/summary?fromDate=2026-03-10&toDate=2026-03-18
// Defaults to current week. Returns order/invoice/quotation KPIs with % change vs previous period.
router.get("/summary", dashboardController.getSummary);

// ─── Charts ─────────────────────────────────────────────────
// GET /api/dashboard/sales-chart?fromDate=...&toDate=...
// Daily order + invoice counts and values for line/bar charts.
router.get("/sales-chart", dashboardController.getSalesChart);

// GET /api/dashboard/hourly-distribution?fromDate=...&toDate=...
// 24-hour heatmap data showing when orders/invoices are placed.
router.get("/hourly-distribution", dashboardController.getHourlyDistribution);

// ─── Rankings ───────────────────────────────────────────────
// GET /api/dashboard/top-customers?limit=10&fromDate=...&toDate=...
router.get("/top-customers", dashboardController.getTopCustomers);

// GET /api/dashboard/top-items?limit=15&source=orders&fromDate=...&toDate=...
// source can be "orders" or "invoices"
router.get("/top-items", dashboardController.getTopItems);

// ─── Revenue Breakdown ─────────────────────────────────────
// GET /api/dashboard/revenue-breakdown?fromDate=...&toDate=...
// By payment method, tag (POS/delivery), and top customers.
router.get("/revenue-breakdown", dashboardController.getRevenueBreakdown);

// ─── Team ───────────────────────────────────────────────────
// GET /api/dashboard/team-performance?fromDate=...&toDate=...
// Per-agent orders, revenue, quotations, target achievement.
router.get("/team-performance", dashboardController.getTeamPerformance);

// GET /api/dashboard/team-logins
// Login activity summary and per-user last login.
router.get("/team-logins", dashboardController.getTeamLogins);

// ─── Item Analytics ─────────────────────────────────────────
// GET /api/dashboard/item-analytics
// Catalog stats: totals, avg prices per list, stock health, categories.
router.get("/item-analytics", dashboardController.getItemAnalytics);

// ─── SAP Sync Health ────────────────────────────────────────
// GET /api/dashboard/sync-status
router.get("/sync-status", dashboardController.getSyncStatus);

// ─── Drill-down Lists (for side-drawer "View All") ─────────
// GET /api/dashboard/invoices?page=1&limit=20&fromDate=...&toDate=...&search=...&paymentStatus=...&tag=...&cardCode=...
router.get("/invoices", dashboardController.getInvoices);

// GET /api/dashboard/invoice/:docEntry
router.get("/invoice/:docEntry", dashboardController.getInvoiceDetail);

// GET /api/dashboard/orders?page=1&limit=20&fromDate=...&toDate=...&status=...&salesAgent=...&syncStatus=...&search=...
router.get("/orders", dashboardController.getOrders);

// GET /api/dashboard/quotations?page=1&limit=20&fromDate=...&toDate=...&approvalStatus=...&salesAgent=...&search=...
router.get("/quotations", dashboardController.getQuotations);

module.exports = router;