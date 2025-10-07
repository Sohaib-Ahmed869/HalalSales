const OpenAI = require('openai');
const Item = require('../models/item');
const inventoryCategorizer = require('./inventoryCategorizer');

const openai = new OpenAI({
    apiKey: process.env.NEW_OPENAI_API_KEY
});

class MenuMatchingService {
    static async matchMenuWithInventory(restaurantMenuItems) {
        try {
            // Initialize categorizer
            await inventoryCategorizer.initialize();

            console.log(`\n${'='.repeat(60)}`);
            console.log(`INTELLIGENT MENU ANALYSIS & SALES OPPORTUNITY ENGINE`);
            console.log(`${'='.repeat(60)}\n`);

            // STEP 1: Analyze and categorize restaurant menu
            const menuAnalysis = this.analyzeRestaurantMenu(restaurantMenuItems);
            console.log(`✓ Menu categorized into ${menuAnalysis.categories.length} categories`);

            // STEP 2: Identify sales opportunities
            const salesOpportunities = await this.identifySalesOpportunities(menuAnalysis);
            console.log(`✓ Found ${salesOpportunities.length} sales opportunities`);

            // STEP 3: Find packaging opportunities
            const packagingOpportunities = this.identifyPackagingOpportunities(menuAnalysis);
            console.log(`✓ Identified ${packagingOpportunities.length} packaging opportunities`);

            // STEP 4: Generate executive summary
            const executiveSummary = this.generateExecutiveSummary(
                menuAnalysis,
                salesOpportunities,
                packagingOpportunities
            );

            // STEP 5: Create detailed matches for reference
            const detailedMatches = this.createDetailedMatches(salesOpportunities);

            return {
                menuAnalysis,
                salesOpportunities,
                packagingOpportunities,
                executiveSummary,
                detailedMatches
            };

        } catch (error) {
            console.error('Error in menu matching:', error);
            throw error;
        }
    }

    static detectCuisineType(menuItems) {
        const allText = menuItems.map(i => `${i.title} ${i.description || ''}`).join(' ').toLowerCase();

        // Asian cuisine indicators
        if (allText.match(/\b(nem|bobun|phat.*thai|nouilles|sautées|wok|thai|chinoise|vermicelle|sushi|ramen|bao)\b/i)) {
            return 'asian';
        }

        // Italian indicators
        if (allText.match(/\b(pizza|pasta|risotto|tiramisu|burrata|focaccia|margherita|carbonara)\b/i)) {
            return 'italian';
        }

        // Middle Eastern indicators
        if (allText.match(/\b(kebab|shawarma|falafel|hummus|taboulé|mezze)\b/i)) {
            return 'middle_eastern';
        }

        // French indicators
        if (allText.match(/\b(tartare|confit|cassoulet|bouillabaisse)\b/i)) {
            return 'french';
        }

        // Default
        return 'general';
    }

    static analyzeRestaurantMenu(menuItems) {
        const categories = {
            beverages: [],
            pizzas: [],
            desserts: [],
            proteins: [],
            pastas: [],
            salads: [],
            appetizers: [],
            other: []
        };

        // DETECT CUISINE TYPE FIRST
        const cuisineType = this.detectCuisineType(menuItems);
        console.log(`Detected cuisine: ${cuisineType}`);

        const excludedKeywords = /wine|vin|chianti|docg|primitivo|lambrusco|cocktail|kombucha/i;


        const categoryKeywords = {
            beverages: /coca|cola|fanta|sprite|water|juice|drink|beverage/i,
            pizzas: /pizza|calzone|focaccia/i,
            desserts: /tiramisu|gelato|ice.*cream|dessert|dolce|sweet/i,
            proteins: /chicken|poulet|beef|boeuf|fish|salmon|seafood/i,
            pastas: /pasta|spaghetti|penne|tagliatelle|lasagna/i,
            salads: /salad|insalata|salade/i,
            appetizers: /starter|entree|antipasti|bruschetta/i
        };

        menuItems.forEach(item => {
            const fullText = `${item.title} ${item.description || ''}`.toLowerCase();
            let categorized = false;

            for (const [category, pattern] of Object.entries(categoryKeywords)) {
                if (pattern.test(fullText)) {
                    categories[category].push(item);
                    categorized = true;
                    break;
                }
            }

            if (!categorized) {
                categories.other.push(item);
            }
        });

        // Calculate summary
        const prices = menuItems
            .map(item => parseFloat(item.price?.replace(/[^\d.]/g, '')))
            .filter(p => !isNaN(p));

        return {
            categories: Object.entries(categories)
                .filter(([_, items]) => items.length > 0)
                .map(([name, items]) => ({
                    name,
                    items: items.map(i => ({
                        title: i.title,
                        description: i.description,
                        price: i.price,
                        frequency: 1
                    }))
                })),
            summary: {
                totalItems: menuItems.length,
                uniqueCategories: Object.values(categories).filter(arr => arr.length > 0).length,
                priceRange: {
                    min: prices.length ? Math.min(...prices) : 0,
                    max: prices.length ? Math.max(...prices) : 0,
                    avg: prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0
                }
            }
        };
    }

    static async identifySalesOpportunities(menuAnalysis) {
        const opportunities = [];

        for (const category of menuAnalysis.categories) {
            const categoryOpps = await this.analyzeGenericCategory(category);
            opportunities.push(...categoryOpps);
        }

        return opportunities;
    }

    static analyzeBeveragesWithExactMatching(items) {
        const opportunities = [];

        items.forEach(item => {
            const title = item.title.toLowerCase();
            let products = [];
            let productType = '';

            // Skip if it's a food item, not a beverage
            if (title.match(/pain|éclair|cookie|moelleux|rocher|sablé|torsade|viennoise/i)) {
                return; // Skip food items
            }

            // Coca-Cola variants - only match if it explicitly contains coca/cola
            if (title.match(/\bcoca\b|\bcola\b/i)) {
                const allColas = inventoryCategorizer.getCategory('beverages.sodas.cola');

                if (title.match(/\bzero\b|\bzéro\b/i)) {
                    products = allColas.filter(p => p.variant === 'coca_cola_zero');
                    productType = 'Coca-Cola Zero';
                } else if (title.match(/\bvanilla\b|\bvanille\b/i)) {
                    products = allColas.filter(p => p.variant === 'coca_cola_vanilla');
                    productType = 'Coca-Cola Vanilla';
                } else if (title.match(/\bcherry\b/i)) {
                    products = allColas.filter(p => p.variant === 'coca_cola_cherry');
                    productType = 'Coca-Cola Cherry';
                } else if (!title.match(/zero|vanilla|cherry|framboise|light/i)) {
                    // Regular Coca-Cola - only if no variant keywords
                    products = allColas.filter(p => p.variant === 'coca_cola_regular');
                    productType = 'Coca-Cola Regular';
                }
            }
            // Fanta variants
            else if (title.match(/\bfanta\b/i)) {
                const allFantas = inventoryCategorizer.getCategory('beverages.sodas.fanta');
                products = allFantas.slice(0, 3);
                productType = 'Fanta';
            }
            // Sprite
            else if (title.match(/\bsprite\b/i)) {
                products = inventoryCategorizer.getCategory('beverages.sodas.sprite').slice(0, 3);
                productType = 'Sprite';
            }
            // Tango
            else if (title.match(/\btango\b/i)) {
                products = inventoryCategorizer.getCategory('beverages.sodas.tango')?.slice(0, 3) || [];
                productType = 'Tango';
            }
            // Water
            else if (title.match(/\bwater\b|\beau\b|\bvittel\b|\bpellegrino\b|\bevian\b/i)) {
                products = inventoryCategorizer.getCategory('beverages.water').slice(0, 3);
                productType = 'Water';
            }
            // Juice
            else if (title.match(/\bjuice\b|\bjus\b/i)) {
                products = inventoryCategorizer.getCategory('beverages.juices').slice(0, 3);
                productType = 'Juice';
            }
            // Hot chocolate / Chocolate drinks
            else if (title.match(/\bchocolat\b|\bchocolate\b|\bhot.*chocolate\b/i) &&
                title.match(/\bdrink\b|\bboisson\b|\bhot\b|\bchaud\b/i)) {
                products = inventoryCategorizer.getCategory('beverages.hotDrinks.chocolate')?.slice(0, 3) || [];
                productType = 'Hot Chocolate';
            }

            if (products.length > 0) {
                opportunities.push({
                    category: 'Current Products - Beverages',
                    opportunityType: 'exact_match',
                    restaurantContext: {
                        menuItems: [item.title],
                        estimatedVolume: 'high',
                        pricePoint: item.price
                    },
                    recommendations: products.map((prod, idx) => ({
                        inventoryItem: prod.id,
                        productName: prod.name,
                        sizes: this.extractAllSizes(prod.name),
                        reasoning: `Exact match: ${productType} - ${products.length} size options available`,
                        priority: idx === 0 ? 'high' : 'medium'
                    })),
                    estimatedValue: 150,
                    notes: `Customer sells ${item.title}. We have ${products.length} size variants.`
                });
            }
        });

        return opportunities;
    }


    static async analyzeGenericCategory(category) {
        const opportunities = [];
        const items = category.items;

        // Special handling for beverages - needs exact variant matching
        if (category.name === 'beverages') {
            return this.analyzeBeveragesWithExactMatching(items);
        }

        // Special handling for "other" - needs better categorization
        if (category.name === 'other') {
            return this.analyzeOtherCategory(items);
        }

        // Define mapping between menu categories and inventory categories
        const categoryMappings = {
            pizzas: ['cheese.mozzarella', 'packaging.pizzaBoxes', 'sauces.delicia', 'sauces.nawhals'],
            desserts: ['dessertIngredients.tiramisu', 'dessertIngredients.cheesecake', 'dessertIngredients.iceCream', 'dessertIngredients.cakes'],
            proteins: ['proteins.chicken.raw', 'proteins.chicken.breaded', 'proteins.chicken.kebab', 'proteins.beef.steakHache', 'proteins.lamb.kebab', 'proteins.seafood'],
            pastas: ['riceAndPasta.pasta', 'sauces.delicia', 'sauces.nawhals', 'cheese.mozzarella'],
            salads: ['cheese.mozzarella', 'cheese.parmesan', 'cheese.pecorino', 'cheese.gorgonzola', 'vegetables.canned'],
            appetizers: ['proteins.chicken.breaded', 'proteins.chicken.wings', 'cheese.mozzarella']
        };

        const mappings = categoryMappings[category.name] || [];

        // Extract keywords from menu items to find more specific matches
        const keywords = this.extractKeywords(items);

        // Get relevant inventory based on mappings + keywords
        const relevantInventory = this.getRelevantInventory(mappings, keywords);

        if (relevantInventory.length === 0) {
            console.log(`No inventory found for ${category.name}`);
            return opportunities;
        }

        // Group products by type
        const groupedProducts = this.groupProductsByType(relevantInventory);

        // Create opportunities for each product group
        Object.entries(groupedProducts).forEach(([productType, products]) => {
            if (products.length === 0) return;

            const opportunity = {
                category: `Current Products - ${this.formatCategoryName(category.name)}`,
                opportunityType: 'exact_match',
                restaurantContext: {
                    menuItems: items.map(i => i.title),
                    estimatedVolume: items.length > 5 ? 'high' : items.length > 2 ? 'medium' : 'low',
                    pricePoint: items[0]?.price || 'N/A'
                },
                recommendations: products.slice(0, 5).map((prod, idx) => ({
                    inventoryItem: prod.id,
                    productName: prod.name,
                    sizes: this.extractAllSizes(prod.name),
                    reasoning: this.generateReasoning(productType, category.name, items),
                    priority: idx === 0 ? 'high' : 'medium'
                })),
                estimatedValue: this.estimateOrderValue(items.length, productType),
                notes: `${items.length} ${category.name} items on menu. ${this.generateNotes(productType, items)}`
            };

            opportunities.push(opportunity);
        });

        // Add packaging opportunities if relevant
        const packagingOpp = this.findPackagingForCategory(category.name, items);
        if (packagingOpp) {
            opportunities.push(packagingOpp);
        }

        return opportunities;
    }

    static analyzeOtherCategory(items) {
        const opportunities = [];

        // Recategorize items in "other" based on keywords
        const recategorized = {
            pizzas: [],
            burratina: [],
            proteins: []
        };

        items.forEach(item => {
            const text = item.title.toLowerCase();

            // These are actually pizzas
            if (text.match(/margherita|marinara|napoli|brooklyn|vegetariana|prosciutto.*funghi|polpetta/i)) {
                recategorized.pizzas.push(item);
            }
            // Burratina dishes need mozzarella
            else if (text.includes('burratina') || text.includes('caprese')) {
                recategorized.burratina.push(item);
            }
            // Skip wines, cocktails, drinks
            else if (text.match(/wine|vin|chianti|docg|primitivo|lambrusco|cocktail|kombucha|limonade|orangeade/i)) {
                // Skip these
            }
            // Other protein dishes
            else if (text.match(/polpetta|tonnara/i)) {
                recategorized.proteins.push(item);
            }
        });

        // Create opportunities for recategorized items
        if (recategorized.pizzas.length > 0) {
            const mozzarellas = inventoryCategorizer.getCategory('cheese.mozzarella');
            opportunities.push({
                category: 'Current Products - Pizza Items',
                opportunityType: 'exact_match',
                restaurantContext: {
                    menuItems: recategorized.pizzas.map(i => i.title),
                    estimatedVolume: 'high',
                    pricePoint: recategorized.pizzas[0]?.price
                },
                recommendations: mozzarellas.slice(0, 3).map((prod, idx) => ({
                    inventoryItem: prod.id,
                    productName: prod.name,
                    sizes: this.extractAllSizes(prod.name),
                    reasoning: `Essential cheese for ${recategorized.pizzas.length} pizza items`,
                    priority: idx === 0 ? 'high' : 'medium'
                })),
                estimatedValue: 250,
                notes: `${recategorized.pizzas.length} pizza items identified. High-volume mozzarella needed.`
            });
        }

        if (recategorized.burratina.length > 0) {
            const mozzarellas = inventoryCategorizer.getCategory('cheese.mozzarella');
            opportunities.push({
                category: 'Current Products - Burratina & Caprese',
                opportunityType: 'exact_match',
                restaurantContext: {
                    menuItems: recategorized.burratina.map(i => i.title),
                    estimatedVolume: 'medium',
                    pricePoint: recategorized.burratina[0]?.price
                },
                recommendations: mozzarellas.slice(0, 3).map((prod, idx) => ({
                    inventoryItem: prod.id,
                    productName: prod.name,
                    sizes: this.extractAllSizes(prod.name),
                    reasoning: `Fresh mozzarella for burratina/caprese dishes`,
                    priority: idx === 0 ? 'high' : 'medium'
                })),
                estimatedValue: 200,
                notes: `${recategorized.burratina.length} burratina/caprese items need premium mozzarella.`
            });
        }

        return opportunities;
    }


    static extractKeywords(items) {
        const allText = items.map(i => `${i.title} ${i.description || ''}`).join(' ').toLowerCase();

        const keywords = {
            proteins: [],
            cheese: [],
            sauce: [],
            beverage: []
        };

        // Proteins
        if (/chicken|poulet/i.test(allText)) keywords.proteins.push('chicken');
        if (/beef|boeuf/i.test(allText)) keywords.proteins.push('beef');
        if (/lamb|agneau/i.test(allText)) keywords.proteins.push('lamb');
        if (/fish|salmon|seafood/i.test(allText)) keywords.proteins.push('seafood');
        if (/kebab/i.test(allText)) keywords.proteins.push('kebab');

        // Cheese types
        if (/mozzarella/i.test(allText)) keywords.cheese.push('mozzarella');
        if (/mascarpone/i.test(allText)) keywords.cheese.push('mascarpone');
        if (/parmesan/i.test(allText)) keywords.cheese.push('parmesan');
        if (/cheddar/i.test(allText)) keywords.cheese.push('cheddar');
        if (/gorgonzola/i.test(allText)) keywords.cheese.push('gorgonzola');

        // Beverages
        if (/coca|cola/i.test(allText)) keywords.beverage.push('cola');
        if (/fanta/i.test(allText)) keywords.beverage.push('fanta');
        if (/sprite/i.test(allText)) keywords.beverage.push('sprite');

        // Sauces
        if (/sauce/i.test(allText)) keywords.sauce.push('sauce');

        return keywords;
    }

    static getRelevantInventory(mappings, keywords, cuisineType) {
        const inventory = [];

        // Get from mappings
        mappings.forEach(path => {
            const items = inventoryCategorizer.getCategory(path);
            inventory.push(...items.map(item => ({ ...item, source: path })));
        });

        if (cuisineType === 'asian') {
            // For Asian restaurants, focus on:
            // - Rice (not pasta)
            // - Soy sauce (not ketchup)
            // - Spring rolls
            // - Asian vegetables

            if (keywords.proteins.includes('chicken')) {
                // Raw chicken, not breaded/kebab
                inventory.push(...inventoryCategorizer.getCategory('proteins.chicken.raw').map(i => ({ ...i, source: 'chicken' })));
            }

            // Add rice
            inventory.push(...inventoryCategorizer.getCategory('riceAndPasta.rice').map(i => ({ ...i, source: 'rice' })));

            // Skip: kebabs, mozzarella, pizza ingredients
            return inventory;
        }

        // Get from keywords - more specific matching
        if (keywords.proteins.includes('chicken')) {
            inventory.push(...inventoryCategorizer.getCategory('proteins.chicken.raw').map(i => ({ ...i, source: 'chicken' })));
            inventory.push(...inventoryCategorizer.getCategory('proteins.chicken.breaded').map(i => ({ ...i, source: 'chicken' })));
            inventory.push(...inventoryCategorizer.getCategory('proteins.chicken.wings').map(i => ({ ...i, source: 'chicken' })));
            inventory.push(...inventoryCategorizer.getCategory('proteins.chicken.kebab').map(i => ({ ...i, source: 'chicken' })));
        }

        if (keywords.proteins.includes('beef')) {
            inventory.push(...inventoryCategorizer.getCategory('proteins.beef.steakHache').map(i => ({ ...i, source: 'beef' })));
            inventory.push(...inventoryCategorizer.getCategory('proteins.beef.kebab').map(i => ({ ...i, source: 'beef' })));
        }

        if (keywords.proteins.includes('lamb')) {
            inventory.push(...inventoryCategorizer.getCategory('proteins.lamb.kebab').map(i => ({ ...i, source: 'lamb' })));
            inventory.push(...inventoryCategorizer.getCategory('proteins.lamb.cuts').map(i => ({ ...i, source: 'lamb' })));
        }

        if (keywords.cheese.includes('mozzarella')) {
            inventory.push(...inventoryCategorizer.getCategory('cheese.mozzarella').map(i => ({ ...i, source: 'mozzarella' })));
        }

        if (keywords.cheese.includes('mascarpone')) {
            inventory.push(...inventoryCategorizer.getCategory('cheese.mascarpone').map(i => ({ ...i, source: 'mascarpone' })));
        }

        // Remove duplicates based on id
        const uniqueInventory = Array.from(
            new Map(inventory.map(item => [item.id, item])).values()
        );

        return uniqueInventory;
    }

    static groupProductsByType(products) {
        const groups = {};

        products.forEach(product => {
            const type = product.source || 'other';
            if (!groups[type]) groups[type] = [];
            groups[type].push(product);
        });

        return groups;
    }

    static generateReasoning(productType, categoryName, items) {
        const reasoningMap = {
            'chicken': `Essential chicken products for ${items.length} menu items`,
            'beef': `Beef products needed for ${items.length} menu items`,
            'lamb': `Lamb products for menu offerings`,
            'mozzarella': `Primary cheese for ${categoryName}`,
            'mascarpone': `Key ingredient for dessert preparation`,
            'cola': `Exact match for customer's beverage selection`,
            'fanta': `Exact match for customer's beverage selection`,
            'sauce': `Sauce products for menu items`,
            'packaging': `Packaging solution for takeout/delivery`
        };

        return reasoningMap[productType] || `Products for ${categoryName} category`;
    }

    static generateNotes(productType, items) {
        if (productType.includes('chicken') || productType.includes('beef') || productType.includes('lamb')) {
            return 'High-volume protein items - consider bulk pricing.';
        }
        if (productType.includes('mozzarella')) {
            return 'Multiple size options available for volume optimization.';
        }
        if (productType === 'sauce') {
            return 'Suggest 5L and 10L formats for operational efficiency.';
        }
        return 'Multiple options available.';
    }

    static findPackagingForCategory(categoryName, items) {
        const packagingMap = {
            pizzas: 'packaging.pizzaBoxes',
            proteins: 'packaging.takeoutContainers',
            salads: 'packaging.takeoutContainers',
            desserts: 'packaging.takeoutContainers'
        };

        const packagingPath = packagingMap[categoryName];
        if (!packagingPath) return null;

        const packaging = inventoryCategorizer.getCategory(packagingPath);
        if (packaging.length === 0) return null;

        return {
            category: `Packaging - ${this.formatCategoryName(categoryName)}`,
            opportunityType: 'packaging',
            restaurantContext: {
                menuItems: [`Packaging for ${items.length} ${categoryName} items`],
                estimatedVolume: items.length > 10 ? 'high' : 'medium',
                pricePoint: 'varies'
            },
            recommendations: packaging.slice(0, 5).map((pack, idx) => ({
                inventoryItem: pack.id,
                productName: pack.name,
                sizes: [pack.size || 'standard'],
                reasoning: `Packaging solution for ${categoryName}`,
                priority: idx === 0 ? 'high' : 'medium'
            })),
            estimatedValue: this.estimateOrderValue(items.length, 'packaging'),
            notes: `${packaging.length} packaging options available for ${categoryName}`
        };
    }

    static formatCategoryName(name) {
        return name.charAt(0).toUpperCase() + name.slice(1);
    }

    static estimateOrderValue(itemCount, category) {
        const baseValues = {
            beverage: 150,
            chicken: 300,
            beef: 350,
            lamb: 400,
            seafood: 300,
            mozzarella: 250,
            mascarpone: 200,
            sauce: 100,
            packaging: 50,
            pasta: 150
        };

        return (baseValues[category] || 100) * Math.min(itemCount, 5);
    }

    static analyzeBeverageOpportunities(beverageItems) {
        const opportunities = [];

        const beverageTypes = {
            cola: beverageItems.filter(i => /coca|cola/i.test(i.title)),
            fanta: beverageItems.filter(i => /fanta/i.test(i.title)),
            sprite: beverageItems.filter(i => /sprite/i.test(i.title)),
            water: beverageItems.filter(i => /water|eau/i.test(i.title))
        };

        // For each beverage type they sell, find ALL our variants
        Object.entries(beverageTypes).forEach(([type, items]) => {
            if (items.length === 0) return;

            let categoryPath;
            switch (type) {
                case 'cola':
                    categoryPath = 'beverages.sodas';
                    break;
                case 'water':
                    categoryPath = 'beverages.water';
                    break;
                default:
                    categoryPath = 'beverages.sodas';
            }

            const availableProducts = inventoryCategorizer.getCategory(categoryPath);

            // Find exact match first
            const exactMatch = availableProducts.find(p => {
                const pName = p.name.toLowerCase();
                return items.some(item => {
                    const itemName = item.title.toLowerCase();
                    if (type === 'cola') {
                        // Match regular Coca-Cola to regular, not flavored variants
                        return pName.includes('coca') &&
                            !pName.match(/zero|light|vanilla|cherry|framboise/i) &&
                            !itemName.match(/zero|light/i);
                    }
                    return pName.includes(itemName.replace(/\d+ml|\d+cl/gi, '').trim());
                });
            });

            // Get all size variants
            const sizeVariants = availableProducts.filter(p => {
                const baseName = p.name.toLowerCase().replace(/\d+\s*x\s*\d+\s*(ml|cl|l)/gi, '');
                const exactBaseName = exactMatch?.name.toLowerCase().replace(/\d+\s*x\s*\d+\s*(ml|cl|l)/gi, '');
                return baseName === exactBaseName;
            });

            opportunities.push({
                category: 'Current Products - Beverages',
                opportunityType: 'exact_match',
                restaurantContext: {
                    menuItems: items.map(i => i.title),
                    estimatedVolume: items.length > 3 ? 'high' : 'medium',
                    pricePoint: items[0]?.price
                },
                recommendations: [
                    {
                        inventoryItem: exactMatch?._id || exactMatch?.id,
                        productName: exactMatch?.name,
                        sizes: sizeVariants.map(v => this.extractSize(v.name)),
                        reasoning: `Exact match for ${type}. Customer currently sells this product.`,
                        priority: 'high'
                    },
                    ...sizeVariants.slice(1, 4).map(variant => ({
                        inventoryItem: variant._id || variant.id,
                        productName: variant.name,
                        sizes: [this.extractSize(variant.name)],
                        reasoning: `Alternative size option for higher volume/value`,
                        priority: 'medium'
                    }))
                ].filter(r => r.inventoryItem),
                estimatedValue: this.estimateOrderValue(items.length, 'beverage'),
                notes: `Customer sells ${items.length} ${type} items. Recommend full product line.`
            });
        });

        return opportunities;
    }

    static analyzePizzaOpportunities(pizzaItems) {
        const opportunities = [];

        if (pizzaItems.length === 0) return opportunities;

        // Pizzas always need mozzarella
        const mozzarellas = inventoryCategorizer.getCategory('cheese.mozzarella');

        if (mozzarellas.length > 0) {
            const mainMozzarella = mozzarellas[0];

            opportunities.push({
                category: 'Current Products - Pizza Ingredients',
                opportunityType: 'exact_match',
                restaurantContext: {
                    menuItems: pizzaItems.map(i => i.title),
                    estimatedVolume: pizzaItems.length > 10 ? 'high' : 'medium',
                    pricePoint: pizzaItems[0]?.price
                },
                recommendations: mozzarellas.slice(0, 3).map((moz, idx) => ({
                    inventoryItem: moz.id,
                    productName: moz.name,
                    sizes: this.extractAllSizes(moz.name),
                    reasoning: idx === 0 ? 'Primary cheese for pizza base' : 'Alternative size option',
                    priority: idx === 0 ? 'high' : 'medium'
                })),
                estimatedValue: this.estimateOrderValue(pizzaItems.length, 'pizza_ingredients'),
                notes: `Customer sells ${pizzaItems.length} pizza items. High-volume mozzarella needed.`
            });
        }

        // Pizza boxes
        const pizzaBoxes = inventoryCategorizer.getCategory('packaging.pizzaBoxes');
        if (pizzaBoxes.length > 0) {
            opportunities.push({
                category: 'Packaging - Pizza Boxes',
                opportunityType: 'packaging',
                restaurantContext: {
                    menuItems: ['Pizza packaging'],
                    estimatedVolume: 'high',
                    pricePoint: 'varies'
                },
                recommendations: pizzaBoxes.slice(0, 5).map(box => ({
                    inventoryItem: box.id,
                    productName: box.name,
                    sizes: [box.size || 'standard'],
                    reasoning: `Pizza box for ${box.size || 'standard size'} pizzas`,
                    priority: 'medium'
                })),
                estimatedValue: this.estimateOrderValue(pizzaItems.length, 'packaging'),
                notes: 'Multiple sizes available for different pizza formats'
            });
        }

        return opportunities;
    }

    static analyzeProteinOpportunities(proteinItems) {
        const opportunities = [];

        if (proteinItems.length === 0) return opportunities;

        // Categorize by protein type
        const chickenItems = proteinItems.filter(i => /chicken|poulet/i.test(i.title));
        const beefItems = proteinItems.filter(i => /beef|boeuf|burger/i.test(i.title));
        const lambItems = proteinItems.filter(i => /lamb|agneau/i.test(i.title));
        const seafoodItems = proteinItems.filter(i => /fish|salmon|seafood/i.test(i.title));

        // Chicken opportunities
        if (chickenItems.length > 0) {
            const chickenProducts = [
                ...inventoryCategorizer.getCategory('proteins.chicken.raw'),
                ...inventoryCategorizer.getCategory('proteins.chicken.breaded'),
                ...inventoryCategorizer.getCategory('proteins.chicken.wings')
            ].slice(0, 5);

            if (chickenProducts.length > 0) {
                opportunities.push({
                    category: 'Current Products - Chicken',
                    opportunityType: 'exact_match',
                    restaurantContext: {
                        menuItems: chickenItems.map(i => i.title),
                        estimatedVolume: chickenItems.length > 5 ? 'high' : 'medium',
                        pricePoint: chickenItems[0]?.price
                    },
                    recommendations: chickenProducts.map((prod, idx) => ({
                        inventoryItem: prod.id,
                        productName: prod.name,
                        sizes: this.extractAllSizes(prod.name),
                        reasoning: 'Chicken product for menu items',
                        priority: idx === 0 ? 'high' : 'medium'
                    })),
                    estimatedValue: this.estimateOrderValue(chickenItems.length, 'protein'),
                    notes: `${chickenItems.length} chicken items on menu`
                });
            }
        }

        // Beef opportunities
        if (beefItems.length > 0) {
            const beefProducts = [
                ...inventoryCategorizer.getCategory('proteins.beef.steakHache'),
                ...inventoryCategorizer.getCategory('proteins.beef.cuts')
            ].slice(0, 5);

            if (beefProducts.length > 0) {
                opportunities.push({
                    category: 'Current Products - Beef',
                    opportunityType: 'exact_match',
                    restaurantContext: {
                        menuItems: beefItems.map(i => i.title),
                        estimatedVolume: beefItems.length > 5 ? 'high' : 'medium',
                        pricePoint: beefItems[0]?.price
                    },
                    recommendations: beefProducts.map((prod, idx) => ({
                        inventoryItem: prod.id,
                        productName: prod.name,
                        sizes: this.extractAllSizes(prod.name),
                        reasoning: 'Beef product for menu items',
                        priority: idx === 0 ? 'high' : 'medium'
                    })),
                    estimatedValue: this.estimateOrderValue(beefItems.length, 'protein'),
                    notes: `${beefItems.length} beef items on menu`
                });
            }
        }

        return opportunities;
    }

    static analyzeDessertOpportunities(dessertItems) {
        const opportunities = [];

        // Check for Tiramisu
        const tiramisuItems = dessertItems.filter(i => /tiramisu/i.test(i.title));
        if (tiramisuItems.length > 0) {
            const tiramisuIngredients = inventoryCategorizer.getCategory('dessertIngredients.tiramisu');

            opportunities.push({
                category: 'Current Products - Desserts',
                opportunityType: 'exact_match',
                restaurantContext: {
                    menuItems: tiramisuItems.map(i => i.title),
                    estimatedVolume: 'medium',
                    pricePoint: tiramisuItems[0]?.price
                },
                recommendations: tiramisuIngredients.map(item => ({
                    inventoryItem: item.id,
                    productName: item.name,
                    sizes: this.extractAllSizes(item.name),
                    reasoning: `Essential ingredient for tiramisu production`,
                    priority: item.ingredient === 'mascarpone' ? 'high' : 'medium'
                })),
                estimatedValue: this.estimateOrderValue(tiramisuItems.length, 'dessert_ingredients'),
                notes: 'Customer makes tiramisu in-house. Offer full ingredient supply.'
            });

            // EXPANSION OPPORTUNITY: Suggest ready-made tiramisu
            const readyMadeTiramisu = inventoryCategorizer.getCategory('dessertIngredients.readyMade')
                .filter(i => /tiramisu/i.test(i.name));

            if (readyMadeTiramisu.length > 0) {
                opportunities.push({
                    category: 'Expansion Opportunities',
                    opportunityType: 'new_product',
                    restaurantContext: {
                        menuItems: ['Customer makes tiramisu'],
                        estimatedVolume: 'low',
                        pricePoint: 'premium'
                    },
                    recommendations: readyMadeTiramisu.map(item => ({
                        inventoryItem: item.id,
                        productName: item.name,
                        sizes: this.extractAllSizes(item.name),
                        reasoning: 'Ready-made alternative to save kitchen time',
                        priority: 'low'
                    })),
                    estimatedValue: 0,
                    notes: 'Optional: Suggest as labor-saving alternative or for testing new flavors'
                });
            }
        }

        return opportunities;
    }

    static identifyPackagingOpportunities(menuAnalysis) {
        const opportunities = [];
        const pizzaItems = menuAnalysis.categories.find(c => c.name === 'pizzas')?.items || [];

        if (pizzaItems.length > 0) {
            const pizzaBoxes = inventoryCategorizer.getCategory('packaging.pizzaBoxes');

            opportunities.push({
                menuItem: 'Pizza (all sizes)',
                packagingType: 'takeout',
                recommendedProducts: pizzaBoxes.map(box => ({
                    inventoryItem: box.id,
                    productName: box.name,
                    suitableFor: `${box.size} pizzas`,
                    specifications: this.extractPackagingSpecs(box.name)
                }))
            });
        }

        // Add more packaging opportunities for other categories

        return opportunities;
    }

    static generateExecutiveSummary(menuAnalysis, salesOpportunities, packagingOpportunities) {
        const highPriorityOpps = salesOpportunities.filter(o =>
            o.recommendations.some(r => r.priority === 'high')
        );

        const estimatedTotalValue = salesOpportunities.reduce((sum, opp) =>
            sum + (opp.estimatedValue || 0), 0
        );

        return {
            keyFindings: [
                `Restaurant operates ${menuAnalysis.summary.uniqueCategories} menu categories`,
                `${salesOpportunities.length} sales opportunities identified`,
                `${highPriorityOpps.length} high-priority product matches`,
                `${packagingOpportunities.length} packaging solutions available`
            ],
            topOpportunities: highPriorityOpps.slice(0, 5).map(opp =>
                `${opp.category}: ${opp.restaurantContext.menuItems.join(', ')}`
            ),
            estimatedTotalValue,
            recommendedActions: [
                'Present exact product matches first (beverages, ingredients)',
                'Discuss volume discounts for high-frequency items',
                'Introduce packaging solutions for takeout/delivery',
                'Suggest expansion products based on current menu strengths'
            ]
        };
    }

    static createDetailedMatches(salesOpportunities) {
        // Convert opportunities back to detailed matches for compatibility
        return salesOpportunities.flatMap(opp =>
            opp.restaurantContext.menuItems.map(menuItem => ({
                restaurantMenuItem: {
                    title: menuItem,
                    category: opp.category
                },
                matchedItems: opp.recommendations.map(rec => ({
                    inventoryItem: rec.inventoryItem,
                    matchType: opp.opportunityType,
                    confidence: rec.priority === 'high' ? 0.95 : rec.priority === 'medium' ? 0.80 : 0.65,
                    sizes: rec.sizes
                })),
                status: 'pending'
            }))
        );
    }

    // Helper methods
    static extractSize(productName) {
        const match = productName.match(/(\d+)\s*x\s*(\d+)\s*(ml|cl|l|g|kg)/i);
        return match ? `${match[1]}x${match[2]}${match[3]}` : 'standard';
    }

    static extractAllSizes(productName) {
        // Extract all size mentions
        const matches = productName.match(/\d+\s*(ml|cl|l|g|kg|cm|inch)/gi);
        return matches || ['standard'];
    }

    static extractPackagingSpecs(name) {
        const specs = [];
        const sizeMatch = name.match(/(\d+)\s*(cm|inch|pouces)/i);
        if (sizeMatch) specs.push(`Size: ${sizeMatch[1]}${sizeMatch[2]}`);

        const qtyMatch = name.match(/(\d+)\s*x/i);
        if (qtyMatch) specs.push(`Quantity: ${qtyMatch[1]} units`);

        return specs.join(', ') || 'See product details';
    }

    static estimateOrderValue(itemCount, category) {
        const baseValues = {
            beverage: 150,
            dessert_ingredients: 200,
            pizza_ingredients: 250,
            protein: 300,
            packaging: 50
        };

        return (baseValues[category] || 100) * Math.min(itemCount, 5);
    }
}

module.exports = MenuMatchingService;