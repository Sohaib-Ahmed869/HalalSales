const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

// Import routes
const authRoutes = require("./routes/auth.routes");
const customerRoutes = require("./routes/customer.routes");
const prestashopRoutes = require("./routes/prestashop.routes");
const productRoutes = require("./routes/product.routes");
const itemRoutes = require("./routes/item.routes");
const salesOrderRoutes = require("./routes/salesOrders.routes");
const invoiceRoutes = require("./routes/invoice.routes");
const desktimeRoutes = require("./routes/desktime.routes");
const callDataRoutes = require("./routes/callData.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const customerJourneyRoutes = require("./routes/journey.routes");
const recommendationRoutes = require("./routes/recommendations.routes");
// const superChatRoutes = require("./routes/superChat.routes"); // REMOVED - conflicts with new routes
const prestashopSyncService = require("./services/prestashopSyncService");
const customerTargetRoutes = require("./routes/customerTarget.routes");
const salesManagerRoutes = require("./routes/salesManager.routes");
const scraperRoutes = require("./routes/scraper.routes");
const dealsRoutes = require("./routes/deals.routes");
const menuRoutes = require("./routes/menu.routes");
const leadRoutes = require("./routes/lead.routes");
const lead2Routes = require("./routes/lead2.routes");
const taskRoutes = require("./routes/task.routes");
const QuotationRoutes = require("./routes/quotation.routes");
const salesAgentJourneyRoutes = require("./routes/salesAgentJourney.routes");
const applicationUsageRoutes = require("./routes/applicationUsage.routes");
const CartRoutes = require("./routes/carts.routes");
const SalesManagerDashboardRoutes = require("./routes/salesManagerDashboardRoutes");
const notificationRoutes = require("./routes/notification.routes");
const restaurantMatcherRoutes = require("./routes/restaurantMatcher.routes");
const jobLogRoutes = require("./routes/jobLog.routes");
const postalCodeScrapingRoutes = require("./routes/postalCodeScraping.routes");
const chatbotRoutes = require('./routes/chatbot.routes');
const productAnalyticsRoutes = require('./routes/productAnalytics.routes')
const restaurantScraperRoutes = require("./routes/restaurantScraper.routes");
const conversationRoutes = require("./routes/conversation.routes");
const contactImportRoutes = require("./routes/contactImport.routes");
const menuMatchRoutes = require("./routes/menuMatch.routes");
const orderPdfRoutes = require("./routes/orderPdf.routes");
const deliveryNoteRoutes = require("./routes/deliveryNoteRoutes");
const deliveryNotePdfRoutes = require('./routes/deliveryNotePdfRoutes');
const invoicePdfRoutes = require("./routes/invoicePdfRoutes");
// const vendorEmailRoutes = require('./routes/vendorEmailRoutes');
const config = require("./services/config");
const desktimeJob = require("./jobs/desktimeJob");
const { linkDocumentsToAgents } = require("./migrateAgentReferences");
const { syncFromFeb21 } = require("./jobs/hubspotJob");
const { fetchCallsFromMay2UntilToday } = require("./jobs/mayScript");
const targetScheduler = require("./services/targetScheduler");
require('./jobs/updateRestaurantAnalysis');
const SuperChatCronService = require('./services/superChatCronService');
// const rfqRoutes = require('./routes/rfqRoutes'); // RFQ routes
// Initialize express app
const app = express();

// Schedule jobs/
//syncFromFeb21();
async function someFunction() {
  const result = await fetchCallsFromMay2UntilToday();
  console.log(`Found ${result.totalCalls} calls`);
}

// someFunction();
// Environment variables
const PORT = process.env.PORT || 5000;
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://127.0.0.1:27017/salesHalal";
const NODE_ENV = process.env.NODE_ENV || "development";

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  cors({
    origin: [
      "http://localhost:5174",
      "http://localhost:5173",
      "http://halalfoodsales.s3-website.eu-north-1.amazonaws.com",
      "https://sales.foodservices.live",
    ],
  })
);
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(helmet());

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
  console.log(`Created uploads directory at: ${uploadsDir}`);
} else {
  console.log(`Uploads directory exists at: ${uploadsDir}`);
}

// Logging
if (NODE_ENV === "development") {
  app.use(morgan("dev"));
} else {
  app.use(morgan("combined"));
}

// Connect to MongoDB
// Connect to MongoDB
mongoose
  .connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    // // Initial sync on startup if enabled
    // if (config.prestashop.syncOnStartup) {
    //   prestashopSyncService.syncMenusFromAPI();
    // }

    // // Schedule periodic syncs if enabled
    // if (config.prestashop.enableScheduledSync) {
    //   prestashopSyncService.scheduleSync(config.prestashop.syncInterval);
    // }
    console.log("✅ Connected to MongoDB");

    // 🎯 ADD THIS: Initialize the target scheduler after database connection
    try {
      targetScheduler.initializeScheduler();
      console.log("🎯 Target scheduler initialized and running");
    } catch (error) {
      console.error("❌ Error initializing target scheduler:", error);
    }

    // 📅 Initialize SuperChat cron jobs
    try {
      const superChatCronService = new SuperChatCronService();
      superChatCronService.startDailySync();
      superChatCronService.startHourlyIncrementalSync();
      superChatCronService.startAllJobs();
      console.log("📅 SuperChat cron jobs initialized and running");
    } catch (error) {
      console.error("❌ Error initializing SuperChat cron jobs:", error);
    }
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  });


// Routes
app.use("/api/auth", authRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/prestashop", prestashopRoutes);
app.use("/api/products", productRoutes);
app.use("/api/items", itemRoutes);
app.use("/api/sales-orders", salesOrderRoutes);
app.use("/api/translation", require('./routes/translation.routes'));
app.use("/api/invoices", invoiceRoutes);
app.use("/api/desktime", desktimeRoutes);
app.use("/api/call-data", callDataRoutes);
app.use("/api/restaurant-matcher", restaurantMatcherRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/customer-journey", customerJourneyRoutes);
app.use("/api/recommendations", recommendationRoutes);
app.use("/api/restaurant-scraper", restaurantScraperRoutes);
app.use("/api/conversations", conversationRoutes);


// Legacy analytics routes (keep for backward compatibility if needed)
// app.use("/api/super-chat-analytics-old", superChatAnalyticsRoutes);
app.use("/api/customer-targets", customerTargetRoutes);
app.use("/api/sales-manager", salesManagerRoutes);
app.use("/api/scraper", scraperRoutes);
app.use("/api/deals", dealsRoutes);
app.use("/api/menu", menuRoutes); // Menu routes
app.use("/api/quotations", QuotationRoutes); // Quotation routes
app.use("/api/leads", leadRoutes); // Lead routes
app.use("/api/leads2", lead2Routes); // Lead2 routes
app.use("/api/tasks", taskRoutes); // Task routes
app.use("/api/sales-agent-journey", salesAgentJourneyRoutes); // Sales agent journey routes
app.use("/api/application-usage", applicationUsageRoutes); // Application usage routes
app.use("/api/carts", CartRoutes); // Cart routes
app.use("/api/sales-manager-dashboard", SalesManagerDashboardRoutes); // Sales manager dashboard routes
app.use("/api/notifications", notificationRoutes);
app.use("/api/jobs", jobLogRoutes); // Job logs routes
app.use("/api/postal-code-scraping", postalCodeScrapingRoutes); // Postal code scraping routes
app.use('/api/chatbot', chatbotRoutes);
app.use('/api/product-analytics', productAnalyticsRoutes);
app.use("/api/contact-import", contactImportRoutes); // Contact import routes
// app.use('/api/rfq', rfqRoutes); // RFQ routes
app.use('/api/menu-match', menuMatchRoutes); // Menu matching routes
app.use("/api/order-pdf", orderPdfRoutes);
app.use("/api/delivery-notes", deliveryNoteRoutes);
app.use("/api/delivery-note-pdf", deliveryNotePdfRoutes);
app.use("/api/invoice-pdf", invoicePdfRoutes);
// app.use('/api/vendor-email', vendorEmailRoutes);
// Health check route
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    message: "Internal Server Error",
    error: NODE_ENV === "development" ? err.message : "Something went wrong",
  });
});

// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Handle unhandled promise rejections
process.on("unhandledRejection", (err) => {
  console.error("Unhandled Promise Rejection:", err);
  // Don't crash the server in production
  if (NODE_ENV === "development") {
    process.exit(1);
  }
});

// 🎯 ADD THIS: Graceful shutdown handlers
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully");
  try {
    targetScheduler.stopScheduler();
    console.log("🎯 Target scheduler stopped");
  } catch (error) {
    console.error("Error stopping target scheduler:", error);
  }
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down gracefully");
  try {
    targetScheduler.stopScheduler();
    console.log("🎯 Target scheduler stopped");
  } catch (error) {
    console.error("Error stopping target scheduler:", error);
  }
  process.exit(0);
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (err) => {
  console.error("Unhandled Promise Rejection:", err);
  // Don't crash the server in production
  if (NODE_ENV === "development") {
    process.exit(1);
  }
});
