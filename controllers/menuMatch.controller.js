const MenuMatch = require('../models/MenuMatch');
const RestaurantAssignment = require('../models/RestaurantAssignment');
const Restaurant = require('../models/Restaurant');
const Item = require('../models/item');
const MenuMatchingService = require('../utils/menuMatchingService');

exports.startMenuMatching = async (req, res) => {
    try {
        const { assignmentId } = req.params;
        const userId = req.user.id;

        const assignment = await RestaurantAssignment.findById(assignmentId)
            .populate('restaurant');

        if (!assignment) {
            return res.status(404).json({
                success: false,
                message: 'Restaurant assignment not found'
            });
        }


        console.log('Assignment found:', assignment);
        const restaurant = await Restaurant.findById(assignment.restaurant);

        if (!restaurant || !restaurant.menu_items || restaurant.menu_items.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No menu items found for this restaurant'
            });
        }

        console.log(`Starting menu matching for restaurant: ${restaurant.name}, Menu items count: ${restaurant.menu_items.length}`);

        // Check if matching already exists
        let menuMatch = await MenuMatch.findOne({ restaurantAssignment: assignmentId });

        if (menuMatch && menuMatch.status === 'completed') {
            return res.json({
                success: true,
                message: 'Menu matching already completed',
                data: menuMatch
            });
        }

        console.log('Existing menu match record:', menuMatch);

        // Create or update menu match record
        if (!menuMatch) {
            menuMatch = new MenuMatch({
                restaurantAssignment: assignmentId,
                restaurant: restaurant._id,
                createdBy: userId,
                status: 'in_progress'
            });
        } else {
            menuMatch.status = 'in_progress';
        }

        await menuMatch.save();

        console.log('Menu match record saved, starting matching process...');

        // Around line 50, replace from "Start matching process" to before "res.json":
        const startTime = Date.now();
        const matchResults = await MenuMatchingService.matchMenuWithInventory(
            restaurant.menu_items
        );

        // Store the new structure
        menuMatch.menuAnalysis = matchResults.menuAnalysis;
        menuMatch.salesOpportunities = matchResults.salesOpportunities;
        menuMatch.packagingOpportunities = matchResults.packagingOpportunities;
        menuMatch.executiveSummary = matchResults.executiveSummary;
        menuMatch.detailedMatches = matchResults.detailedMatches;

        menuMatch.matchingMetadata = {
            totalRestaurantItems: restaurant.menu_items.length,
            categoriesFound: matchResults.menuAnalysis.categories.length,
            opportunitiesIdentified: matchResults.salesOpportunities.length,
            processingTime: Date.now() - startTime,
            aiModel: 'hybrid-v2',
            matchingDate: new Date(),
            version: '2.0'
        };
        menuMatch.status = 'completed';
        menuMatch.updatedAt = new Date();

        await menuMatch.save();

        // ADD THESE LINES
        const populatedMatch = await MenuMatch.findById(menuMatch._id)
            .populate('detailedMatches.matchedItems.inventoryItem')
            .populate('createdBy', 'firstName lastName');

        res.json({
            success: true,
            message: 'Menu matching completed',
            data: populatedMatch
        });

    } catch (error) {
        console.error('Error in menu matching:', error);
        res.status(500).json({
            success: false,
            message: 'Error processing menu matching',
            error: error.message
        });
    }
};

exports.getMenuMatch = async (req, res) => {
    try {
        const { assignmentId } = req.params;

        const menuMatch = await MenuMatch.findOne({ restaurantAssignment: assignmentId })
            .populate('matches.matchedInventoryItem')
            .populate('matches.reviewedBy', 'firstName lastName')
            .populate('createdBy', 'firstName lastName');

        if (!menuMatch) {
            return res.status(404).json({
                success: false,
                message: 'Menu match not found'
            });
        }

        res.json({
            success: true,
            data: menuMatch
        });
    } catch (error) {
        console.error('Error fetching menu match:', error);
        res.status(500).json({
            success: false,
            message: 'Error fetching menu match',
            error: error.message
        });
    }
};

exports.updateMatchStatus = async (req, res) => {
    try {
        const { assignmentId, matchIndex } = req.params;
        const { status, inventoryItemId, notes } = req.body;
        const userId = req.user.id;

        const menuMatch = await MenuMatch.findOne({ restaurantAssignment: assignmentId });

        if (!menuMatch) {
            return res.status(404).json({
                success: false,
                message: 'Menu match not found'
            });
        }

        if (!menuMatch.matches[matchIndex]) {
            return res.status(404).json({
                success: false,
                message: 'Match not found'
            });
        }

        menuMatch.matches[matchIndex].status = status;
        if (inventoryItemId) {
            menuMatch.matches[matchIndex].matchedInventoryItem = inventoryItemId;
            menuMatch.matches[matchIndex].matchType = 'manual';
        }
        if (notes) {
            menuMatch.matches[matchIndex].notes = notes;
        }
        menuMatch.matches[matchIndex].reviewedBy = userId;
        menuMatch.matches[matchIndex].reviewedAt = new Date();
        menuMatch.updatedAt = new Date();

        await menuMatch.save();

        const updated = await MenuMatch.findById(menuMatch._id)
            .populate('matches.matchedInventoryItem')
            .populate('matches.reviewedBy', 'firstName lastName');

        res.json({
            success: true,
            message: 'Match updated successfully',
            data: updated
        });
    } catch (error) {
        console.error('Error updating match:', error);
        res.status(500).json({
            success: false,
            message: 'Error updating match',
            error: error.message
        });
    }
};