// routes/recommendations.js
const express = require("express");
const router = express.Router();
const { auth, checkRole } = require("../middleware/auth");
const {
  getRecommendations,
  getUpsellFlags,
  getCustomerUpsellFlags,
} = require("../controllers/recommendations.controller");

/**
 * @route   GET /api/recommendations
 * @desc    Get personalized recommendations based on user role
 * @access  Private (Sales Agents, Sales Managers, Admin)
 */
router.get("/", auth, getRecommendations);

/**
 * @route   GET /api/recommendations/upsell
 * @desc    Customers whose Uber Eats menu sells something they don't buy from us (upsell flags)
 * @access  Private (Sales Agents: their customers; Sales Managers, Admin: everyone, ?agent= filter)
 */
router.get("/upsell", auth, checkRole(["admin", "sales_manager", "sales_agent"]), getUpsellFlags);

/**
 * @route   GET /api/recommendations/upsell/:cardCode
 * @desc    One customer's upsell flags, with the menu items and the products to offer
 * @access  Private (Sales Agents: their customers only)
 */
router.get("/upsell/:cardCode", auth, checkRole(["admin", "sales_manager", "sales_agent"]), getCustomerUpsellFlags);

module.exports = router;
