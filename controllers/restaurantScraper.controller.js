// controllers/restaurantScraper.controller.js
const Restaurant = require('../models/Restaurant');
const axios = require('axios');

const SCRAPER_BASE_URL = process.env.SCRAPER_BASE_URL || 'http://localhost:3000';

const restaurantScraperController = {
  /**
   * Get all restaurants for a postal code with pagination
   */
  getRestaurantsByPostalCode: async (req, res) => {
    try {
      const { postalCode } = req.params;
      const {
        page = 1,
        limit = 20,
        search = '',
        sortBy = 'scraped_at',
        sortOrder = 'desc'
      } = req.query;

      // Validate postal code format
      console.log('Validating postal code:', postalCode);
      if (!postalCode.match(/^(?:0[1-9]|[1-8][0-9]|9[0-6])[0-9]{3}$/)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid French postal code format'
        });
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

      // Build search query
      let query = { postal_code: postalCode };
      if (search) {
        query.$or = [
          { name: { $regex: search, $options: 'i' } },
          { 'menu_items.title': { $regex: search, $options: 'i' } },
          { 'contact_info.email': { $regex: search, $options: 'i' } }
        ];
      }

      // Get restaurants with pagination
      const [restaurants, total] = await Promise.all([
        Restaurant.find(query)
          .sort(sort)
          .skip(skip)
          .limit(parseInt(limit))
          .lean(),
        Restaurant.countDocuments(query)
      ]);

      // Calculate statistics
      const stats = await Restaurant.aggregate([
        { $match: { postal_code: postalCode } },
        {
          $group: {
            _id: null,
            totalRestaurants: { $sum: 1 },
            totalMenuItems: { $sum: '$menu_items_count' },
            avgMenuItems: { $avg: '$menu_items_count' },
            restaurantsWithContact: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $ne: ['$contact_info.email', 'N/A'] },
                      { $ne: ['$contact_info.phone', 'N/A'] }
                    ]
                  },
                  1,
                  0
                ]
              }
            },
            latestScrape: { $max: '$scraped_at' },
            oldestScrape: { $min: '$scraped_at' }
          }
        }
      ]);

      const statistics = stats[0] || {
        totalRestaurants: 0,
        totalMenuItems: 0,
        avgMenuItems: 0,
        restaurantsWithContact: 0,
        latestScrape: null,
        oldestScrape: null
      };

      res.json({
        success: true,
        data: {
          restaurants,
          pagination: {
            currentPage: parseInt(page),
            totalPages: Math.ceil(total / parseInt(limit)),
            totalItems: total,
            itemsPerPage: parseInt(limit),
            hasNext: skip + parseInt(limit) < total,
            hasPrev: parseInt(page) > 1
          },
          statistics: {
            ...statistics,
            contactRate: statistics.totalRestaurants > 0
              ? Math.round((statistics.restaurantsWithContact / statistics.totalRestaurants) * 100)
              : 0
          },
          filters: {
            postalCode,
            search,
            sortBy,
            sortOrder
          }
        }
      });

    } catch (error) {
      console.error('Error fetching restaurants:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching restaurants',
        error: error.message
      });
    }
  },

  /**
   * Get detailed restaurant information
   */
  getRestaurantDetails: async (req, res) => {
    try {
      const { restaurantId } = req.params;

      const restaurant = await Restaurant.findById(restaurantId).lean();

      if (!restaurant) {
        return res.status(404).json({
          success: false,
          message: 'Restaurant not found'
        });
      }

      // Calculate additional metrics
      const menuItemsWithPrices = restaurant.menu_items.filter(
        item => item.price !== 'N/A' && item.price.match(/\d+[,\.]\d+/)
      );

      const priceRange = {
        min: 0,
        max: 0,
        average: 0
      };

      if (menuItemsWithPrices.length > 0) {
        const prices = menuItemsWithPrices.map(item => {
          const priceMatch = item.price.match(/(\d+)[,\.](\d+)/);
          return priceMatch ? parseFloat(`${priceMatch[1]}.${priceMatch[2]}`) : 0;
        }).filter(price => price > 0);

        if (prices.length > 0) {
          priceRange.min = Math.min(...prices);
          priceRange.max = Math.max(...prices);
          priceRange.average = prices.reduce((sum, price) => sum + price, 0) / prices.length;
        }
      }

      res.json({
        success: true,
        data: {
          ...restaurant,
          analytics: {
            menuItemsWithPrices: menuItemsWithPrices.length,
            priceRange,
            contactCompleteness: {
              email: restaurant.contact_info.email !== 'N/A',
              phone: restaurant.contact_info.phone !== 'N/A',
              address: restaurant.contact_info.address !== 'N/A'
            }
          }
        }
      });

    } catch (error) {
      console.error('Error fetching restaurant details:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching restaurant details',
        error: error.message
      });
    }
  },

  /**
   * Start scraping for a postal code
   */
  startScraping: async (req, res) => {
    try {
      const { postalCode, maxRestaurants = 10 } = req.body;

      console.log('Received scrape request for postal code:', postalCode, 'with maxRestaurants:', maxRestaurants);
      // Validate postal code
      if (!postalCode || !postalCode.match(/^(?:0[1-9]|[1-8][0-9]|9[0-6])[0-9]{3}$/)) {
        return res.status(400).json({
          success: false,
          message: 'Valid French postal code is required'
        });
      }

      // Call the scraper service
      const scraperResponse = await axios.post(`${SCRAPER_BASE_URL}/scrape`, {
        postal_code: postalCode,
        max_restaurants: parseInt(maxRestaurants)
      }, {
        timeout: 300000 // 5 minutes timeout
      });

      if (scraperResponse.data.success) {
        // Save restaurants to database
        const restaurants = scraperResponse.data.restaurants;
        const savedRestaurants = [];

        for (const restaurantData of restaurants) {
          try {
            const restaurant = await Restaurant.findOneAndUpdate(
              { url: restaurantData.url },
              {
                ...restaurantData,
                postal_code: postalCode,
                last_updated: new Date()
              },
              {
                upsert: true,
                new: true,
                setDefaultsOnInsert: true
              }
            );
            savedRestaurants.push(restaurant);
          } catch (saveError) {
            console.error('Error saving restaurant:', saveError);
          }
        }

        res.json({
          success: true,
          message: 'Scraping completed successfully',
          data: {
            postalCode,
            totalFound: scraperResponse.data.total_found,
            newRestaurants: scraperResponse.data.new_restaurants,
            failedRestaurants: scraperResponse.data.failed_restaurants,
            savedToDatabase: savedRestaurants.length,
            restaurants: savedRestaurants
          }
        });
      } else {
        throw new Error(scraperResponse.data.error || 'Scraping failed');
      }

    } catch (error) {
      console.error('Error starting scraping:', error);

      if (error.code === 'ECONNREFUSED') {
        return res.status(503).json({
          success: false,
          message: 'Scraper service is not available',
          error: 'Please ensure the scraper service is running on the configured port'
        });
      }

      res.status(500).json({
        success: false,
        message: 'Error starting scraping process',
        error: error.message
      });
    }
  },

  /**
   * Get scraping job status (for the scraper health check)
   */
  getScraperStatus: async (req, res) => {
    try {
      const healthResponse = await axios.get(`${SCRAPER_BASE_URL}/health`, {
        timeout: 5000
      });

      res.json({
        success: true,
        data: {
          scraperOnline: true,
          scraperInfo: healthResponse.data,
          databaseStats: await getDatabaseStats()
        }
      });

    } catch (error) {
      console.error('Error checking scraper status:', error);
      res.json({
        success: true,
        data: {
          scraperOnline: false,
          error: error.message,
          databaseStats: await getDatabaseStats()
        }
      });
    }
  },

  /**
   * Test scraping with limited restaurants
   */
  testScraping: async (req, res) => {
    try {
      const { postalCode } = req.params;

      const testResponse = await axios.get(`${SCRAPER_BASE_URL}/test/${postalCode}`, {
        timeout: 60000 // 1 minute timeout for test
      });

      res.json({
        success: true,
        data: testResponse.data
      });

    } catch (error) {
      console.error('Error testing scraper:', error);
      res.status(500).json({
        success: false,
        message: 'Error testing scraper',
        error: error.message
      });
    }
  },

  // In restaurantScraperController.js - Update the getScrapingDashboard method

  getScrapingDashboard: async (req, res) => {
    try {
      const { days = 7 } = req.query;
      const sinceDate = new Date();
      sinceDate.setDate(sinceDate.getDate() - parseInt(days));

      // Get comprehensive statistics
      const [
        totalStats,
        recentStats,
        postalCodeStats,
        dailyStats,
        availablePostalCodes // ADD THIS NEW QUERY
      ] = await Promise.all([
        // Total statistics - FIX THE UNIQUE POSTAL CODES COUNT
        Restaurant.aggregate([
          {
            $group: {
              _id: null,
              totalRestaurants: { $sum: 1 },
              totalMenuItems: { $sum: '$menu_items_count' },
              avgMenuItems: { $avg: '$menu_items_count' },
              uniquePostalCodes: { $addToSet: '$postal_code' }, // This collects unique postal codes
              restaurantsWithContact: {
                $sum: {
                  $cond: [
                    {
                      $or: [
                        { $ne: ['$contact_info.email', 'N/A'] },
                        { $ne: ['$contact_info.phone', 'N/A'] }
                      ]
                    },
                    1,
                    0
                  ]
                }
              }
            }
          }
        ]),

        // Recent statistics
        Restaurant.aggregate([
          { $match: { scraped_at: { $gte: sinceDate } } },
          {
            $group: {
              _id: null,
              recentRestaurants: { $sum: 1 },
              recentMenuItems: { $sum: '$menu_items_count' }
            }
          }
        ]),

        // Postal code breakdown
        Restaurant.aggregate([
          {
            $group: {
              _id: '$postal_code',
              count: { $sum: 1 },
              totalMenuItems: { $sum: '$menu_items_count' },
              lastScrape: { $max: '$scraped_at' }
            }
          },
          { $sort: { count: -1 } },
          { $limit: 10 }
        ]),

        // Daily statistics for the last week
        Restaurant.aggregate([
          { $match: { scraped_at: { $gte: sinceDate } } },
          {
            $group: {
              _id: {
                $dateToString: {
                  format: '%Y-%m-%d',
                  date: '$scraped_at'
                }
              },
              count: { $sum: 1 },
              menuItems: { $sum: '$menu_items_count' }
            }
          },
          { $sort: { _id: 1 } }
        ]),

        // ADD THIS: Get all available postal codes with their restaurant counts
        Restaurant.aggregate([
          {
            $group: {
              _id: '$postal_code',
              restaurantCount: { $sum: 1 },
              totalMenuItems: { $sum: '$menu_items_count' },
              lastScrape: { $max: '$scraped_at' },
              avgMenuItems: { $avg: '$menu_items_count' }
            }
          },
          { $sort: { restaurantCount: -1 } }
        ])
      ]);

      const totalData = totalStats[0] || {};
      const recentData = recentStats[0] || {};

      res.json({
        success: true,
        data: {
          overview: {
            totalRestaurants: totalData.totalRestaurants || 0,
            totalMenuItems: totalData.totalMenuItems || 0,
            avgMenuItems: Math.round(totalData.avgMenuItems || 0),
            uniquePostalCodes: totalData.uniquePostalCodes ? totalData.uniquePostalCodes.length : 0, // FIX: Get the length
            contactRate: totalData.totalRestaurants > 0
              ? Math.round((totalData.restaurantsWithContact / totalData.totalRestaurants) * 100)
              : 0,
            recentActivity: {
              restaurants: recentData.recentRestaurants || 0,
              menuItems: recentData.recentMenuItems || 0,
              period: `Last ${days} days`
            }
          },
          postalCodeBreakdown: postalCodeStats,
          dailyActivity: dailyStats,
          availablePostalCodes: availablePostalCodes, // ADD THIS TO RESPONSE
          scraperStatus: await getScraperHealthStatus()
        }
      });

    } catch (error) {
      console.error('Error fetching scraping dashboard:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching dashboard data',
        error: error.message
      });
    }
  }
};

// Helper functions
async function getDatabaseStats() {
  try {
    const stats = await Restaurant.aggregate([
      {
        $group: {
          _id: null,
          totalRestaurants: { $sum: 1 },
          totalMenuItems: { $sum: '$menu_items_count' },
          uniquePostalCodes: { $addToSet: '$postal_code' }
        }
      }
    ]);

    return {
      totalRestaurants: stats[0]?.totalRestaurants || 0,
      totalMenuItems: stats[0]?.totalMenuItems || 0,
      uniquePostalCodes: stats[0]?.uniquePostalCodes?.length || 0
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function getScraperHealthStatus() {
  try {
    const response = await axios.get(`${SCRAPER_BASE_URL}/health`, { timeout: 5000 });
    return {
      online: true,
      status: response.data
    };
  } catch (error) {
    return {
      online: false,
      error: error.message
    };
  }
}

module.exports = restaurantScraperController;