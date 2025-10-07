const Item = require('../models/item');
const fs = require('fs').promises;
const path = require('path');

class InventoryCategorizer {
    constructor() {
        this.categoriesPath = path.join(__dirname, '../data/inventory-categories.json');
        this.categories = null;
    }

    async initialize() {
        try {
            const data = await fs.readFile(this.categoriesPath, 'utf8');
            this.categories = JSON.parse(data);
            console.log('✓ Loaded cached inventory categories');
        } catch (error) {
            console.log('Building inventory categories for first time...');
            await this.buildAndCacheCategories();
        }
    }

    async buildAndCacheCategories() {
        const items = await Item.find({ Valid: 'tYES' })
            .select('_id ItemCode ItemName ForeignName')
            .lean();

        const categories = {
            beverages: {
                sodas: { cola: [], fanta: [], sprite: [], other: [] },
                water: [],
                juices: [],
                energyDrinks: [],
                tea: []
            },
            cheese: {
                mozzarella: [],
                mascarpone: [],
                gorgonzola: [],
                pecorino: [],
                parmesan: [],
                cheddar: [],
                emmental: [],
                gouda: [],
                cream: [],
                other: []
            },
            proteins: {
                chicken: {
                    raw: [],
                    cooked: [],
                    breaded: [],
                    wings: [],
                    tenders: [],
                    kebab: []
                },
                beef: {
                    steakHache: [],
                    kebab: [],
                    cuts: []
                },
                lamb: {
                    kebab: [],
                    cuts: []
                },
                seafood: [],
                processed: []
            },
            asian: {
                rice: {
                    sushi: [],
                    basmati: [],
                    jasmine: [],
                    general: []
                },
                sauces: {
                    soy: [],
                    other: []
                },
                ingredients: {
                    springRolls: [],
                    samosas: [],
                    ginger: [],
                    noodles: []
                }
            },
            middleEastern: {
                spices: [],
                ingredients: []
            },
            dessertIngredients: {
                tiramisu: [],
                cheesecake: [],
                iceCream: [],
                cakes: [],
                toppings: []
            },
            packaging: {
                pizzaBoxes: [],
                burgerBoxes: [],
                kebabBoxes: [],
                takeoutContainers: [],
                wraps: [],
                bags: [],
                cups: [],
                cutlery: []
            },
            sauces: {
                delicia: [],
                nawhals: [],
                colona: [],
                other: []
            },
            breads: {
                burgerBuns: [],
                pizza: [],
                kebab: [],
                tortillas: [],
                naan: []
            },
            fries: {
                lambweston: [],
                bigBens: [],
                other: []
            },
            spices: [],
            oils: [],
            vegetables: {
                fresh: [],
                canned: [],
                frozen: []
            },
            riceAndPasta: {
                rice: [],
                pasta: [],
                couscous: []
            },
            cleaningSupplies: []
        };

        items.forEach(item => {
            const name = `${item.ItemName || ''} ${item.ForeignName || ''}`.toLowerCase();
            const itemData = {
                id: item._id.toString(),
                code: item.ItemCode,
                name: item.ItemName,
                searchText: name
            };

            this.categorizeItem(itemData, name, categories);
        });

        this.categories = categories;

        await fs.mkdir(path.dirname(this.categoriesPath), { recursive: true });
        await fs.writeFile(
            this.categoriesPath,
            JSON.stringify(categories, null, 2)
        );

        console.log('✓ Built and cached inventory categories');
    }


    categorizeItem(itemData, name, categories) {
        // ASIAN PRODUCTS FIRST - High priority
        if (name.match(/\b(sushi.*riz|kobasuki)\b/i)) {
            categories.asian.rice.sushi.push(itemData);
            categories.riceAndPasta.rice.push(itemData);
        } else if (name.match(/\b(jasmine|double.*dragon)\b/i)) {
            categories.asian.rice.jasmine.push(itemData);
            categories.riceAndPasta.rice.push(itemData);
        } else if (name.match(/\bbasmati\b/i)) {
            categories.asian.rice.basmati.push(itemData);
            categories.riceAndPasta.rice.push(itemData);
        } else if (name.match(/\b(nem|nems)\b/i)) {
            categories.asian.ingredients.springRolls.push(itemData);
        } else if (name.match(/\bsamossa\b/i)) {
            categories.asian.ingredients.samosas.push(itemData);
        } else if (name.match(/\bsauce.*soja|soy.*sauce\b/i)) {
            categories.asian.sauces.soy.push(itemData);
        } else if (name.match(/\bginger|gingembre\b/i) && !name.match(/ale/i)) {
            categories.asian.ingredients.ginger.push(itemData);
            categories.spices.push(itemData);
        }

        // BEVERAGES
        else if (name.match(/\bcoca.*cola\b/i)) {
            if (name.match(/zero|zéro|zēro/i)) {
                categories.beverages.sodas.cola.push({ ...itemData, variant: 'coca_cola_zero' });
            } else if (name.match(/light/i)) {
                categories.beverages.sodas.cola.push({ ...itemData, variant: 'coca_cola_light' });
            } else if (name.match(/vanilla|vanille/i)) {
                categories.beverages.sodas.cola.push({ ...itemData, variant: 'coca_cola_vanilla' });
            } else if (name.match(/cherry/i)) {
                categories.beverages.sodas.cola.push({ ...itemData, variant: 'coca_cola_cherry' });
            } else if (name.match(/framboise|raspberry/i)) {
                categories.beverages.sodas.cola.push({ ...itemData, variant: 'coca_cola_raspberry' });
            } else {
                categories.beverages.sodas.cola.push({ ...itemData, variant: 'coca_cola_regular' });
            }
        }
        else if (name.match(/\bfanta\b/i)) {
            if (name.match(/orange/i)) {
                categories.beverages.sodas.fanta.push({ ...itemData, variant: 'fanta_orange' });
            } else if (name.match(/exotic/i)) {
                categories.beverages.sodas.fanta.push({ ...itemData, variant: 'fanta_exotic' });
            } else if (name.match(/citron|lemon/i)) {
                categories.beverages.sodas.fanta.push({ ...itemData, variant: 'fanta_lemon' });
            } else if (name.match(/shokata/i)) {
                categories.beverages.sodas.fanta.push({ ...itemData, variant: 'fanta_shokata' });
            } else if (name.match(/tropical/i)) {
                categories.beverages.sodas.fanta.push({ ...itemData, variant: 'fanta_tropical' });
            } else if (name.match(/mango|mangue/i)) {
                categories.beverages.sodas.fanta.push({ ...itemData, variant: 'fanta_mango' });
            } else if (name.match(/grape|raisin/i)) {
                categories.beverages.sodas.fanta.push({ ...itemData, variant: 'fanta_grape' });
            } else if (name.match(/ananas|pineapple/i)) {
                categories.beverages.sodas.fanta.push({ ...itemData, variant: 'fanta_pineapple' });
            } else {
                categories.beverages.sodas.fanta.push({ ...itemData, variant: 'fanta_other' });
            }
        }
        else if (name.match(/\bsprite\b/i)) {
            categories.beverages.sodas.sprite.push(itemData);
        }
        else if (name.match(/\b(pepsi|7up|orangina|tango|ice.*cola|ice.*tea|schweppes|oasis|tropico)\b/i)) {
            categories.beverages.sodas.other.push(itemData);
        }
        else if (name.match(/\b(eau|water|evian|vittel|perrier|cristaline)\b/i) && !name.match(/sauce/i)) {
            categories.beverages.water.push(itemData);
        }
        else if (name.match(/\b(juice|jus|rubicon|maaza|capri.*sonne|sunkist|minute.*maid)\b/i)) {
            categories.beverages.juices.push(itemData);
        }
        else if (name.match(/\b(redbull|red.*bull|energy)\b/i)) {
            categories.beverages.energyDrinks.push(itemData);
        }
        else if (name.match(/\b(the|tea|lipton)\b/i) && !name.match(/ice.*tea/i)) {
            categories.beverages.tea.push(itemData);
        }
        // BEVERAGES - EXACT matching with variants
        // Coca-Cola variants
        else if (name.match(/\bcoca.*cola\b/i)) {
            if (name.match(/zero|zéro/i)) {
                categories.beverages.sodas.cola.push({ ...itemData, variant: 'coca_cola_zero' });
            } else if (name.match(/light/i)) {
                categories.beverages.sodas.cola.push({ ...itemData, variant: 'coca_cola_light' });
            } else if (name.match(/vanilla|vanille/i)) {
                categories.beverages.sodas.cola.push({ ...itemData, variant: 'coca_cola_vanilla' });
            } else if (name.match(/cherry/i)) {
                categories.beverages.sodas.cola.push({ ...itemData, variant: 'coca_cola_cherry' });
            } else if (name.match(/framboise|raspberry/i)) {
                categories.beverages.sodas.cola.push({ ...itemData, variant: 'coca_cola_raspberry' });
            } else {
                categories.beverages.sodas.cola.push({ ...itemData, variant: 'coca_cola_regular' });
            }
        }
        // Fanta variants
        else if (name.match(/\bfanta\b/i)) {
            if (name.match(/orange/i)) {
                categories.beverages.sodas.fanta.push({ ...itemData, variant: 'fanta_orange' });
            } else if (name.match(/exotic/i)) {
                categories.beverages.sodas.fanta.push({ ...itemData, variant: 'fanta_exotic' });
            } else if (name.match(/citron|lemon/i)) {
                categories.beverages.sodas.fanta.push({ ...itemData, variant: 'fanta_lemon' });
            } else if (name.match(/shokata/i)) {
                categories.beverages.sodas.fanta.push({ ...itemData, variant: 'fanta_shokata' });
            } else if (name.match(/tropical/i)) {
                categories.beverages.sodas.fanta.push({ ...itemData, variant: 'fanta_tropical' });
            } else if (name.match(/mango|mangue/i)) {
                categories.beverages.sodas.fanta.push({ ...itemData, variant: 'fanta_mango' });
            } else if (name.match(/grape|raisin/i)) {
                categories.beverages.sodas.fanta.push({ ...itemData, variant: 'fanta_grape' });
            } else if (name.match(/ananas|pineapple/i)) {
                categories.beverages.sodas.fanta.push({ ...itemData, variant: 'fanta_pineapple' });
            } else {
                categories.beverages.sodas.fanta.push({ ...itemData, variant: 'fanta_other' });
            }
        }
        // Sprite
        else if (name.match(/\bsprite\b/i)) {
            categories.beverages.sodas.sprite.push(itemData);
        }
        // Other sodas
        else if (name.match(/\b(pepsi|7up|orangina|tango|ice.*cola|ice.*tea|schweppes|oasis|tropico)\b/i)) {
            categories.beverages.sodas.other.push(itemData);
        }
        // Water
        else if (name.match(/\b(eau|water|evian|vittel|perrier|cristaline)\b/i) && !name.match(/sauce/i)) {
            categories.beverages.water.push(itemData);
        }
        // Juices
        else if (name.match(/\b(juice|jus|rubicon|maaza|capri.*sonne|sunkist|minute.*maid)\b/i)) {
            categories.beverages.juices.push(itemData);
        }
        // Energy drinks
        else if (name.match(/\b(redbull|red.*bull|energy)\b/i)) {
            categories.beverages.energyDrinks.push(itemData);
        }
        // Tea
        else if (name.match(/\b(the|tea|lipton)\b/i) && !name.match(/ice.*tea/i)) {
            categories.beverages.tea.push(itemData);
        }

        // CHEESE - All types
        else if (name.match(/\bmozzarella\b/i) && !name.match(/stick/i)) {
            categories.cheese.mozzarella.push(itemData);
            if (name.match(/tiramisu/i)) {
                categories.dessertIngredients.tiramisu.push({ ...itemData, ingredient: 'mozzarella' });
            }
        } else if (name.match(/\bmascarpone\b/i)) {
            categories.cheese.mascarpone.push(itemData);
            categories.dessertIngredients.tiramisu.push({ ...itemData, ingredient: 'mascarpone' });
        } else if (name.match(/\bgorgonzola\b/i)) {
            categories.cheese.gorgonzola.push(itemData);
        } else if (name.match(/\bpecorino\b/i)) {
            categories.cheese.pecorino.push(itemData);
        } else if (name.match(/\b(parmesan|parmigiano)\b/i)) {
            categories.cheese.parmesan.push(itemData);
        } else if (name.match(/\bcheddar\b/i)) {
            categories.cheese.cheddar.push(itemData);
        } else if (name.match(/\bemmental\b/i)) {
            categories.cheese.emmental.push(itemData);
        } else if (name.match(/\bgouda\b/i)) {
            categories.cheese.gouda.push(itemData);
        } else if (name.match(/\b(cream|creme|double.*cream|liquid.*cream)\b/i) && !name.match(/ice.*cream/i)) {
            categories.cheese.cream.push(itemData);
            categories.dessertIngredients.tiramisu.push({ ...itemData, ingredient: 'cream' });
        } else if (name.match(/\b(fromage|cheese|kiri|boursin|leerdammer)\b/i) && !name.match(/nacho|sauce/i)) {
            categories.cheese.other.push(itemData);
        }

        // CHICKEN PRODUCTS - Detailed categorization
        else if (name.match(/\b(poulet|chicken)\b/i)) {
            if (name.match(/\b(nugget|popcorn|tender|finger|goujons|strip)\b/i)) {
                categories.proteins.chicken.breaded.push(itemData);
            } else if (name.match(/\b(wing|aile|ailles)\b/i)) {
                categories.proteins.chicken.wings.push(itemData);
            } else if (name.match(/\b(tender|filet.*poulet|escalope|aiguillette)\b/i)) {
                categories.proteins.chicken.tenders.push(itemData);
            } else if (name.match(/\bkebab\b/i)) {
                categories.proteins.chicken.kebab.push(itemData);
            } else if (name.match(/\b(cuit|cooked|cube|marinee|tikka|tandoori|curry)\b/i)) {
                categories.proteins.chicken.cooked.push(itemData);
            } else {
                categories.proteins.chicken.raw.push(itemData);
            }
        }

        // BEEF PRODUCTS
        else if (name.match(/\b(boeuf|bouef|beef|steak)\b/i)) {
            if (name.match(/\b(hache|hachee|burger|smash)\b/i)) {
                categories.proteins.beef.steakHache.push(itemData);
            } else if (name.match(/\bkebab\b/i)) {
                categories.proteins.beef.kebab.push(itemData);
            } else {
                categories.proteins.beef.cuts.push(itemData);
            }
        }

        // LAMB PRODUCTS
        else if (name.match(/\b(agneau|lamb|mutton)\b/i)) {
            if (name.match(/\bkebab\b/i)) {
                categories.proteins.lamb.kebab.push(itemData);
            } else {
                categories.proteins.lamb.cuts.push(itemData);
            }
        }

        // SEAFOOD
        else if (name.match(/\b(fish|poisson|saumon|salmon|thon|tuna|crevette|shrimp|seafood)\b/i)) {
            categories.proteins.seafood.push(itemData);
        }

        // PROCESSED MEATS
        else if (name.match(/\b(saucisson|delice|pepperoni|bacon|jambon|mortadella|lardinette)\b/i)) {
            categories.proteins.processed.push(itemData);
        }

        // DESSERTS - Comprehensive
        else if (name.match(/\btiramisu\b/i)) {
            categories.dessertIngredients.tiramisu.push(itemData);
        } else if (name.match(/\b(cheesecake|cheese.*cake)\b/i)) {
            categories.dessertIngredients.cheesecake.push(itemData);
        } else if (name.match(/\b(haagen.*dazs|ice.*cream|gelato)\b/i)) {
            categories.dessertIngredients.iceCream.push(itemData);
        } else if (name.match(/\b(gateau|cake|tarte|brownie|donut|molten)\b/i)) {
            categories.dessertIngredients.cakes.push(itemData);
        }

        // PACKAGING - Detailed
        else if (name.match(/\b(boite|box).*pizza\b/i)) {
            const sizeMatch = name.match(/(\d+)\s*cm/i);
            categories.packaging.pizzaBoxes.push({
                ...itemData,
                size: sizeMatch ? sizeMatch[1] + 'cm' : 'standard'
            });
        } else if (name.match(/\b(boite|box).*(burger|sandwich)\b/i)) {
            categories.packaging.burgerBoxes.push(itemData);
        } else if (name.match(/\b(boite|box).*(kebab|wrap|tacos)\b/i)) {
            categories.packaging.kebabBoxes.push(itemData);
        } else if (name.match(/\b(boite.*micronde|container|bol.*kraft|box.*liner)\b/i)) {
            categories.packaging.takeoutContainers.push(itemData);
        } else if (name.match(/\b(wrap.*paper|aluminium.*wrap|tortilla.*wrap)\b/i)) {
            categories.packaging.wraps.push(itemData);
        } else if (name.match(/\b(sac|bag|sachet)(?!.*sauce)\b/i)) {
            categories.packaging.bags.push(itemData);
        } else if (name.match(/\b(gobelet|cup|verre.*plastique)\b/i)) {
            categories.packaging.cups.push(itemData);
        } else if (name.match(/\b(couverts|cutlery|cuillere|fourchette|knife|spoon|fork)\b/i)) {
            categories.packaging.cutlery.push(itemData);
        }

        // SAUCES - By brand
        else if (name.match(/\bdelicia\b/i)) {
            categories.sauces.delicia.push(itemData);
        } else if (name.match(/\bnawhals\b/i)) {
            categories.sauces.nawhals.push(itemData);
        } else if (name.match(/\bcolona\b/i)) {
            categories.sauces.colona.push(itemData);
        } else if (name.match(/\b(sauce|mayo|ketchup|mustard|moutarde)\b/i) && !name.match(/pot.*sauce/i)) {
            categories.sauces.other.push(itemData);
        }

        // BREADS
        else if (name.match(/\b(burger.*bun|buns|americana|pain.*burger)\b/i)) {
            categories.breads.burgerBuns.push(itemData);
        } else if (name.match(/\b(pizza.*base|pizza.*dough)\b/i)) {
            categories.breads.pizza.push(itemData);
        } else if (name.match(/\b(pain.*kebab|kebab.*bread)\b/i)) {
            categories.breads.kebab.push(itemData);
        } else if (name.match(/\b(tortilla|wrap)\b/i) && !name.match(/boite|box/i)) {
            categories.breads.tortillas.push(itemData);
        } else if (name.match(/\b(naan|nan.*bread)\b/i)) {
            categories.breads.naan.push(itemData);
        }

        // FRIES - By brand
        else if (name.match(/\blambweston\b/i)) {
            categories.fries.lambweston.push(itemData);
        } else if (name.match(/\bbig.*bens\b/i)) {
            categories.fries.bigBens.push(itemData);
        } else if (name.match(/\b(frites|fries|chip|potato)\b/i) && !name.match(/sweet|douce/i)) {
            categories.fries.other.push(itemData);
        }

        // SPICES
        else if (name.match(/\b(spice|epice|curry|cumin|paprika|pepper|poivre|salt|sel|masala|tandoori|peri.*peri|chilli|harissa)\b/i) && !name.match(/sauce/i)) {
            categories.spices.push(itemData);
        }

        // OILS
        else if (name.match(/\b(huile|oil)\b/i) && !name.match(/sauce/i)) {
            categories.oils.push(itemData);
        }

        // VEGETABLES
        else if (name.match(/\b(olive|oignon|onion|tomate|tomato|champignon|mais|corn|pepper|poivron|jalapeno)\b/i) && !name.match(/sauce|huile|oil/i)) {
            if (name.match(/\b(kg|fresh|frais)\b/i)) {
                categories.vegetables.fresh.push(itemData);
            } else if (name.match(/\b(4\/4|can|boite)\b/i)) {
                categories.vegetables.canned.push(itemData);
            } else {
                categories.vegetables.frozen.push(itemData);
            }
        }

        // RICE AND PASTA
        else if (name.match(/\b(riz|rice|basmati)\b/i)) {
            categories.riceAndPasta.rice.push(itemData);
        } else if (name.match(/\b(pasta|pate|spaghetti|penne|tagliatelle)\b/i)) {
            categories.riceAndPasta.pasta.push(itemData);
        } else if (name.match(/\bcouscous\b/i)) {
            categories.riceAndPasta.couscous.push(itemData);
        }

        // CLEANING SUPPLIES
        else if (name.match(/\b(cleaning|cleaner|detergent|bleach|javel|domestos|deepio|spray|gel.*hydro)\b/i)) {
            categories.cleaningSupplies.push(itemData);
        }
    }

    getAllProductVariants(basePath, productName) {
        // Get all size/variant options for a product
        const items = this.getCategory(basePath);
        const variants = items.filter(item => {
            const itemBase = item.name.toLowerCase().replace(/\d+\s*(ml|cl|l|g|kg|x|cm)/gi, '');
            const searchBase = productName.toLowerCase().replace(/\d+\s*(ml|cl|l|g|kg)/gi, '');
            return itemBase.includes(searchBase) || searchBase.includes(itemBase);
        }); 
        return variants;
    }

    getCategory(categoryPath) {
        const parts = categoryPath.split('.');
        let result = this.categories;
        for (const part of parts) {
            result = result[part];
            if (!result) return [];
        }
        // If result is an object with arrays, flatten it
        if (typeof result === 'object' && !Array.isArray(result)) {
            return Object.values(result).flat();
        }
        return Array.isArray(result) ? result : [];
    }

    findExactMatch(productName, category) {
        const items = this.getCategory(category);
        const searchTerm = productName.toLowerCase().trim();

        // Find exact brand/product match
        return items.find(item => {
            const itemName = item.name.toLowerCase();
            // Remove size/packaging info for comparison
            const cleanItemName = itemName.replace(/\d+\s*(ml|l|g|kg|x|cm|inch)/gi, '').trim();
            const cleanSearch = searchTerm.replace(/\d+\s*(ml|l|g|kg)/gi, '').trim();

            return cleanItemName.includes(cleanSearch) || cleanSearch.includes(cleanItemName);
        });
    }
}

module.exports = new InventoryCategorizer();