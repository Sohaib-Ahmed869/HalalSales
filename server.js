const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const path = require('path');
const fs = require('fs');
const dns = require('dns');
require("dotenv").config();

// Node's default DNS resolver can fail SRV lookups (mongodb+srv://) on some
// Windows/ISP/router DNS setups even though the OS resolver works fine.
dns.setServers(['8.8.8.8', '1.1.1.1']);

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
const prestashopSyncService = require("./services/prestashopSyncService");
const config = require("./services/config");
const cartFetcherRoutes = require("./routes/cartFetcher.routes");
const truckRouteRoutes = require("./routes/truckRoute.routes");
const mapRoutes = require("./routes/map.routes");
const trackingRoutes = require("./routes/tracking.routes");
const trackingSocket = require("./services/trackingSocket");
const geotabSync = require("./services/geotabSync");
const adherenceService = require("./services/adherenceService");

// Initialize express app
const app = express();

// Environment variables
const PORT = process.env.PORT || 5000;
const MONGO_URI =
  process.env.MONGO_URI || "mongodb://127.0.0.1:27017/salesHalal";
const NODE_ENV = process.env.NODE_ENV || "development";

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
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
    // Live truck GPS from MyGeotab, and the evening planned-vs-actual report.
    geotabSync.start();
    adherenceService.startCron();
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
app.use("/api/invoices", invoiceRoutes);
app.use("/api/desktime", desktimeRoutes);
app.use("/api/call-data", callDataRoutes);
app.use('/api/dashboard', dashboardRoutes); 
app.use("/api/customer-journey", customerJourneyRoutes);
app.use("/api/recommendations", recommendationRoutes);
app.use("/api/cart-fetcher", cartFetcherRoutes);
app.use("/api/truck-routes", truckRouteRoutes);
app.use("/api/map", mapRoutes);
app.use("/api/tracking", trackingRoutes);

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
const httpServer = require("http").createServer(app);
trackingSocket.init(httpServer);
httpServer.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Handle unhandled promise rejections
process.on("unhandledRejection", (err) => {
  console.error("Unhandled Promise Rejection:", err);
  // Don't crash the server in production
  if (NODE_ENV === "development") {
    process.exit(1);
  }
});
