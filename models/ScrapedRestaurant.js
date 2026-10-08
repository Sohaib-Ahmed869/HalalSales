const mongoose = require("mongoose");
const Schema = mongoose.Schema;

// Read-only view of the `restaurants` collection filled by the postal-code
// scraper (Postal Scraping pages): the potential customers on the Sales map.
// Only the fields the map reads are declared; nothing here writes to it.
const ScrapedRestaurantSchema = new Schema(
  {
    name: String,
    url: String,
    postal_code: String,
    menu_items_count: Number,
    contact_info: {
      email: String,
      phone: String,
      address: String,
    },
    status: String,
    scraped_at: Date,
  },
  { collection: "restaurants", strict: false }
);

// The scraped data has no coordinates, so each restaurant's address is
// geocoded once and the pin kept here (never written into `restaurants`).
const ScrapedRestaurantGeoSchema = new Schema({
  restaurantId: { type: Schema.Types.ObjectId, required: true, unique: true },
  lat: Number,
  lng: Number,
  status: { type: String, enum: ["ok", "failed"], default: "ok" },
  source: String,
  confidence: String,
  geocodedAt: { type: Date, default: Date.now },
});

module.exports = {
  ScrapedRestaurant: mongoose.models.ScrapedRestaurant || mongoose.model("ScrapedRestaurant", ScrapedRestaurantSchema),
  ScrapedRestaurantGeo: mongoose.model("ScrapedRestaurantGeo", ScrapedRestaurantGeoSchema),
};
