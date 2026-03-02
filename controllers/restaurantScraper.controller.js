// controllers/restaurantScraper.controller.js
const Restaurant = require('../models/Restaurant');
const RestaurantAssignment = require('../models/RestaurantAssignment');
const Task = require('../models/Task');
const User = require('../models/User');
const Lead = require('../models/Lead');
const Notification = require('../models/Notification');
const axios = require('axios');

const SCRAPER_BASE_URL = process.env.SCRAPER_BASE_URL || 'http://localhost:3000';

const restaurantScraperController = {
  /**
   * Get single restaurant details by ID
   */
  getRestaurantById: async (req, res) => {
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
      const menuItemsWithPrices = (restaurant.menu_items || []).filter(
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
              email: restaurant.contact_info?.email !== 'N/A',
              phone: restaurant.contact_info?.phone !== 'N/A',
              address: restaurant.contact_info?.address !== 'N/A'
            }
          }
        }
      });

    } catch (error) {
      console.error('Error fetching restaurant by ID:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching restaurant details',
        error: error.message
      });
    }
  },
  /**
 * Clean malformed postal codes
 */
  cleanPostalCodes: async (req, res) => {
    try {
      // Find all restaurants with BOM character in postal code
      const malformedRestaurants = await Restaurant.find({
        postal_code: { $regex: /[^\d]/ } // Contains non-digit characters
      });

      let updatedCount = 0;
      const errors = [];

      for (const restaurant of malformedRestaurants) {
        try {
          // Remove BOM and other non-digit characters, keep only digits
          const cleanPostalCode = restaurant.postal_code.replace(/[^\d]/g, '');

          // Validate it's a proper 5-digit French postal code
          if (cleanPostalCode.match(/^(?:0[1-9]|[1-8][0-9]|9[0-6])[0-9]{3}$/)) {
            restaurant.postal_code = cleanPostalCode;
            await restaurant.save();
            updatedCount++;
          } else {
            errors.push({
              restaurantId: restaurant._id,
              name: restaurant.name,
              oldPostalCode: restaurant.postal_code,
              cleanedCode: cleanPostalCode,
              error: 'Invalid postal code format after cleaning'
            });
          }
        } catch (error) {
          errors.push({
            restaurantId: restaurant._id,
            name: restaurant.name,
            error: error.message
          });
        }
      }

      res.json({
        success: true,
        data: {
          totalFound: malformedRestaurants.length,
          updated: updatedCount,
          errors: errors.length,
          errorDetails: errors
        }
      });

    } catch (error) {
      console.error('Error cleaning postal codes:', error);
      res.status(500).json({
        success: false,
        message: 'Error cleaning postal codes',
        error: error.message
      });
    }
  },
  /**
 * Assign restaurants to agents
 */
  assignRestaurants: async (req, res) => {
    try {
      const { restaurantIds, agentId, priority = 'medium' } = req.body;
      const assignedBy = req.user.id;

      // Validate agent exists and is a sales agent
      const agent = await User.findById(agentId);
      if (!agent || !['sales_agent', 'sales_manager'].includes(agent.role)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid agent selected'
        });
      }

      const assignments = [];
      const errors = [];
      const createdLeads = []; // NEW: Track created leads

      for (const restaurantId of restaurantIds) {
        try {
          // Check if restaurant is already assigned
          const existingAssignment = await RestaurantAssignment.findOne({ restaurant: restaurantId });
          if (existingAssignment) {
            errors.push({ restaurantId, error: 'Already assigned' });
            continue;
          }

          const restaurant = await Restaurant.findById(restaurantId);
          if (!restaurant) {
            errors.push({ restaurantId, error: 'Restaurant not found' });
            continue;
          }

          // Create assignment
          const assignment = new RestaurantAssignment({
            restaurant: restaurantId,
            assignedAgent: agentId,
            assignedBy,
            priority
          });
          await assignment.save();

          // NEW: Create Lead from restaurant data (only for halal-food-sales)
          let createdLead = null;

          console.log('Creating lead for restaurant:', restaurant.name);
          const Lead = require('../models/Lead');

          const leadData = {
            fullName: restaurant.name,
            email: restaurant.contact_info?.email !== 'N/A' ? restaurant.contact_info?.email : '',
            phoneNumber: restaurant.contact_info?.phone !== 'N/A' ? restaurant.contact_info?.phone : '',
            company: restaurant.name,
            status: 'new',
            tags: ['warm'], // Default tag for restaurant leads
            assignedTo: agentId,
            sourceType: 'restaurant_scraping',
            relatedRestaurant: restaurantId,
            relatedRestaurantAssignment: assignment._id,
            restaurantData: {
              name: restaurant.name,
              postalCode: restaurant.postal_code,
              menuItemsCount: restaurant.menu_items_count,
              contactInfo: {
                email: restaurant.contact_info?.email || 'N/A',
                phone: restaurant.contact_info?.phone || 'N/A',
                address: restaurant.contact_info?.address || 'N/A',
              },
              url: restaurant.url,
            },
            notes: `Auto-created from restaurant scraping on ${new Date().toISOString()}\nPostal Code: ${restaurant.postal_code}\nMenu Items: ${restaurant.menu_items_count}`,
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          createdLead = new Lead(leadData);
          await createdLead.save();
          createdLeads.push(createdLead);

          assignments.push(assignment);
        } catch (error) {
          errors.push({ restaurantId, error: error.message });
        }
      }

      if (assignments.length > 0) {
        const notification = new Notification({
          recipient: agentId,
          sender: assignedBy,
          type: 'restaurant_assigned',
          title: 'New Restaurants Assigned',
          message: `${assignments.length} restaurant${assignments.length > 1 ? 's have' : ' has'} been assigned to you. Please go to the Leads Management screen to view and manage these leads.`,
          relatedRestaurant: assignments[0]._id
        });
        await notification.save();
      }

      res.json({
        success: true,
        data: {
          assigned: assignments.length,
          errors: errors.length,
          assignments,
          createdLeads: createdLeads.length, // NEW: Return count of created leads
          errors
        }
      });

    } catch (error) {
      console.error('Error assigning restaurants:', error);
      res.status(500).json({
        success: false,
        message: 'Error assigning restaurants',
        error: error.message
      });
    }
  },

  /**
   * Get agent's assigned restaurants
   */
  getAgentRestaurants: async (req, res) => {
    try {
      const agentId = req.user.id;
      const { page = 1, limit = 20, status = 'all', priority = 'all' } = req.query;

      let query = { assignedAgent: agentId };
      if (status !== 'all') query.status = status;
      if (priority !== 'all') query.priority = priority;

      const skip = (parseInt(page) - 1) * parseInt(limit);

      const [assignments, total] = await Promise.all([
        RestaurantAssignment.find(query)
          .populate('restaurant')
          .populate('assignedBy', 'firstName lastName')
          .sort({ assignedAt: -1 })
          .skip(skip)
          .limit(parseInt(limit)),
        RestaurantAssignment.countDocuments(query)
      ]);

      res.json({
        success: true,
        data: {
          assignments,
          pagination: {
            currentPage: parseInt(page),
            totalPages: Math.ceil(total / parseInt(limit)),
            totalItems: total,
            itemsPerPage: parseInt(limit)
          }
        }
      });

    } catch (error) {
      console.error('Error fetching agent restaurants:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching assigned restaurants',
        error: error.message
      });
    }
  },

  /**
   * Update restaurant assignment status and notes
   */
  updateRestaurantAssignment: async (req, res) => {
    try {
      const { assignmentId } = req.params;
      const { status, notes, nextFollowUpDate } = req.body;
      const userId = req.user.id;

      const assignment = await RestaurantAssignment.findById(assignmentId);
      if (!assignment) {
        return res.status(404).json({
          success: false,
          message: 'Assignment not found'
        });
      }

      // Check if user is assigned agent or admin
      if (assignment.assignedAgent.toString() !== userId && req.user.role !== 'admin') {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to update this assignment'
        });
      }

      // Update fields
      if (status) assignment.status = status;
      if (nextFollowUpDate) assignment.nextFollowUpDate = nextFollowUpDate;
      if (notes) {
        assignment.notes.push({
          content: notes,
          addedBy: userId,
          type: 'general'
        });
      }

      assignment.contactAttempts += 1;
      assignment.lastContactDate = new Date();
      assignment.updatedAt = new Date();

      await assignment.save();

      res.json({
        success: true,
        data: assignment
      });

    } catch (error) {
      console.error('Error updating assignment:', error);
      res.status(500).json({
        success: false,
        message: 'Error updating assignment',
        error: error.message
      });
    }
  },
  getRestaurantsByPostalCode: async (req, res) => {
    try {
      const { postalCode } = req.params;
      const {
        page = 1,
        limit = 20,
        search = '',
        sortBy = 'scraped_at',
        sortOrder = 'desc',
        assignmentFilter = 'all'
      } = req.query;

      if (!postalCode.match(/^(?:0[1-9]|[1-8][0-9]|9[0-6])[0-9]{3}$/)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid French postal code format'
        });
      }

      const skip = (parseInt(page) - 1) * parseInt(limit);
      const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

      let query = { postal_code: postalCode };
      if (search) {
        query.$or = [
          { name: { $regex: search, $options: 'i' } },
          { 'menu_items.title': { $regex: search, $options: 'i' } },
          { 'contact_info.email': { $regex: search, $options: 'i' } }
        ];
      }

      // Apply assignment filter BEFORE querying
      if (assignmentFilter === 'assigned' || assignmentFilter === 'unassigned') {
        const assignedRestaurantIds = await RestaurantAssignment.distinct('restaurant');
        if (assignmentFilter === 'assigned') {
          query._id = { $in: assignedRestaurantIds };
        } else {
          query._id = { $nin: assignedRestaurantIds };
        }
      }

      const [restaurants, total, allAssignments] = await Promise.all([
        Restaurant.find(query)
          .sort(sort)
          .skip(skip)
          .limit(parseInt(limit))
          .lean(),
        Restaurant.countDocuments(query),
        RestaurantAssignment.find({ restaurant: { $in: await Restaurant.find(query).distinct('_id') } })
          .populate('assignedAgent', 'firstName lastName')
          .lean()
      ]);

      const assignmentMap = {};
      allAssignments.forEach(a => {
        assignmentMap[a.restaurant.toString()] = a;
      });

      const restaurantsWithAssignment = restaurants.map(r => ({
        ...r,
        assignment: assignmentMap[r._id.toString()] || null
      }));

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
          restaurants: restaurantsWithAssignment,
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
            sortOrder,
            assignmentFilter
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
  },
  /**
 * Assign postal codes to agents
 */
  assignPostalCodes: async (req, res) => {
    try {
      const { assignments } = req.body; // Array of { agentId, postalCodes: [] }
      const assignedBy = req.user.id;

      // Validate admin permission
      if (req.user.role !== 'admin') {
        return res.status(403).json({
          success: false,
          message: 'Only admins can assign postal codes'
        });
      }

      const results = [];
      const errors = [];

      for (const assignment of assignments) {
        try {
          const agent = await User.findById(assignment.agentId);
          if (!agent || !['sales_agent', 'sales_manager'].includes(agent.role)) {
            errors.push({ agentId: assignment.agentId, error: 'Invalid agent' });
            continue;
          }

          // Update agent's assigned postal codes
          agent.assignedPostalCodes = assignment.postalCodes;
          agent.lastPostalCodeAssignment = new Date();
          await agent.save();

          results.push({
            agentId: assignment.agentId,
            agentName: `${agent.firstName} ${agent.lastName}`,
            postalCodes: assignment.postalCodes
          });
        } catch (error) {
          errors.push({ agentId: assignment.agentId, error: error.message });
        }
      }

      res.json({
        success: true,
        data: { results, errors }
      });

    } catch (error) {
      console.error('Error assigning postal codes:', error);
      res.status(500).json({
        success: false,
        message: 'Error assigning postal codes',
        error: error.message
      });
    }
  },

  /**
   * Get postal code assignments
   */
  getPostalCodeAssignments: async (req, res) => {
    try {
      const agents = await User.find({
        role: { $in: ['sales_agent', 'sales_manager'] },
        deactivated: false
      }).select('firstName lastName email assignedPostalCodes lastPostalCodeAssignment');

      res.json({
        success: true,
        data: agents.filter(agent => agent.assignedPostalCodes && agent.assignedPostalCodes.length > 0)
      });

    } catch (error) {
      console.error('Error fetching postal code assignments:', error);
      res.status(500).json({
        success: false,
        message: 'Error fetching postal code assignments',
        error: error.message
      });
    }
  },

  /**
   * Auto-assign restaurants to agents
   */
  autoAssignRestaurants: async (req, res) => {
    try {
      const { restaurantsPerAgent } = req.body;
      const assignedBy = req.user.id;

      if (!restaurantsPerAgent || restaurantsPerAgent < 1) {
        return res.status(400).json({
          success: false,
          message: 'Valid number of restaurants per agent is required'
        });
      }

      // Get all agents with assigned postal codes
      const agents = await User.find({
        role: { $in: ['sales_agent', 'sales_manager'] },
        deactivated: false,
        assignedPostalCodes: { $exists: true, $ne: [] }
      });

      if (agents.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No agents with assigned postal codes found'
        });
      }

      const assignmentResults = [];
      const errors = [];

      for (const agent of agents) {
        try {
          // Get already assigned restaurant IDs for this agent
          const existingAssignments = await RestaurantAssignment.find({
            assignedAgent: agent._id
          }).select('restaurant');

          const assignedRestaurantIds = existingAssignments.map(a => a.restaurant.toString());

          // Find unassigned restaurants in agent's postal codes
          const unassignedRestaurants = await Restaurant.find({
            postal_code: { $in: agent.assignedPostalCodes },
            _id: { $nin: assignedRestaurantIds }
          })
            .sort({ scraped_at: -1 }) // Get most recently scraped first
            .limit(restaurantsPerAgent);

          if (unassignedRestaurants.length === 0) {
            errors.push({
              agentId: agent._id,
              agentName: `${agent.firstName} ${agent.lastName}`,
              error: 'No unassigned restaurants available in assigned postal codes'
            });
            continue;
          }

          // Create assignments
          const newAssignments = [];
          for (const restaurant of unassignedRestaurants) {
            const assignment = new RestaurantAssignment({
              restaurant: restaurant._id,
              assignedAgent: agent._id,
              assignedBy,
              priority: 'medium',
              assignmentType: 'auto'
            });
            await assignment.save();





            newAssignments.push({
              restaurantId: restaurant._id,
              restaurantName: restaurant.name,
              postalCode: restaurant.postal_code
            });
          }

          // Update agent's last assignment date
          agent.lastAutoAssignment = new Date();
          await agent.save();

          assignmentResults.push({
            agentId: agent._id,
            agentName: `${agent.firstName} ${agent.lastName}`,
            assignedCount: newAssignments.length,
            assignments: newAssignments
          });

        } catch (error) {
          errors.push({
            agentId: agent._id,
            agentName: `${agent.firstName} ${agent.lastName}`,
            error: error.message
          });
        }
      }

      //send notification to each agent about new assignments
      for (const result of assignmentResults) {
        if (result.assignedCount > 0) {
          const notification = new Notification({
            recipient: result.agentId,
            sender: assignedBy,
            type: 'restaurant_assigned',
            title: 'New Restaurants Auto-Assigned',
            message: `${result.assignedCount} restaurant${result.assignedCount > 1 ? 's have' : ' has'} been auto-assigned to you. Please go to the Leads Management screen to view and manage these leads.`,
            relatedRestaurant: result.assignments[0].restaurantId
          });
          await notification.save();
        }
      }

      res.json({
        success: true,
        data: {
          totalAgents: agents.length,
          totalAssigned: assignmentResults.reduce((sum, r) => sum + r.assignedCount, 0),
          results: assignmentResults,
          errors
        }
      });

    } catch (error) {
      console.error('Error auto-assigning restaurants:', error);
      res.status(500).json({
        success: false,
        message: 'Error auto-assigning restaurants',
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