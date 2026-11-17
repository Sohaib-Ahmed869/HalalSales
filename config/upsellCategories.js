// config/upsellCategories.js
//
// Upsell flags (services/upsell.js): what a customer's Uber Eats menu says they
// sell, against what they buy from us. One entry per product category:
//   menu      - words / phrases looked for in the titles of the store's menu items
//               and menu sections (French + English; case and accents ignored, whole
//               words only, a plural "s" / "x" on the last word is accepted);
//   menuNot   - a menu item that also has one of these words does not count
//               (e.g. "chicken burger" is no evidence for beef patties);
//   products  - which of our SAP items are this category: ItemsGroupCode(s) and
//               fragments of the item name (any one is enough), minus `not`
//               fragments. Matched on the item name, case and accents ignored.
// A customer is flagged for a category when their menu has it and they bought no
// item of the category in the last LOOKBACK_MONTHS. Suggested products are the
// category's active items, most bought by our customers first.
//
// SAP item groups (ItemsGroupCode) seen in the catalogue:
//   123 cans, 124 bottles / water, 125 desserts, 126 sauces, 127 tins / oil,
//   128 frozen sides / cheese / cream, 129 packaging / hygiene, 130 dry grocery /
//   spices / flour / rice / eggs, 131 chicken & poultry, 132 bread / buns /
//   tortillas, 133 beef / lamb / burgers / halal charcuterie.
//
// Edit freely: the table is read at start-up, nothing is stored.

// "Bought it" = an invoice line in the last N months.
const LOOKBACK_MONTHS = 6;
// Older purchases are only shown as "last bought on …" (a lapsed product).
const HISTORY_MONTHS = 24;
// Suggested products per flag.
const SUGGESTIONS_PER_FLAG = 3;
// Menu items shown as evidence per flag.
const EVIDENCE_PER_FLAG = 5;

// Words shared by several categories.
const BURGER = ["burger", "cheeseburger", "hamburger", "smash", "smashburger", "smash burger", "big mac", "bacon burger"];
const NOT_BEEF = ["chicken", "poulet", "fish", "poisson", "veggie", "vege", "vegetarien", "vegetarian", "vegan", "crispy", "tenders", "dessert"];
const KEBAB = ["kebab", "doner", "durum", "grec", "sandwich grec", "assiette kebab", "gyros"];
const NOT_DONER = ["seekh", "sheek", "shek", "seehk", "adana", "kofte", "kofta", "kefta", "lahmacun"]; // other kebabs
const TACOS = ["tacos", "taco", "french tacos", "o tacos"];
const WRAPS = ["wrap", "burrito", "fajita", "quesadilla", "durum"];
const WINGS = ["wings", "wing", "chicken wing", "ailes de poulet", "aile de poulet", "ailes", "ailette", "manchon", "hot wing"];
const TENDERS = ["tenders", "tender", "strips", "chicken strip", "goujon", "chicken finger", "fingers"];
const NUGGETS = ["nuggets", "nugget", "popcorn chicken", "chicken popcorn", "poulet popcorn", "popcorn poulet"];
const FRIED_CHICKEN = ["fried chicken", "poulet frit", "bucket", "pilon", "drumstick", "chicken crispy", "crispy chicken", "poulet croustillant"];
const FRIES = ["frites", "frite", "fries", "pommes frites", "french fries"];
const NO_FRIES = ["sans frite"]; // "Cheeseburger (sans frites)"
const PIZZA = ["pizza", "pizzas", "calzone"];
const SNACK_SAUCES = ["samourai", "algerienne", "andalouse", "biggy", "sauce blanche", "sauce barbecue", "sauce bbq", "bbq sauce", "ketchup", "mayonnaise", "mayo", "sauce burger", "sauce poivre"];
const INDIAN = ["tandoori", "tikka", "masala", "korma", "biryani", "butter chicken", "vindaloo", "madras", "balti"];

const CATEGORIES = [
  // ── Chicken ─────────────────────────────────────────────────────────
  { key: "chicken_tenders", label: "Chicken tenders / strips", kind: "chicken", menu: TENDERS, products: { groups: [131], name: ["TENDER", "STRIPS", "GOUJON", "FINGERS", "TENDERS"] } },
  { key: "chicken_wings", label: "Chicken wings", kind: "chicken", menu: WINGS, products: { groups: [131], name: ["AILE", "AILLE", "WING", "MANCHON"] } },
  { key: "chicken_nuggets", label: "Nuggets / popcorn chicken", kind: "chicken", menu: NUGGETS, products: { groups: [131], name: ["NUGGET", "POPCORN"] } },
  { key: "chicken_kebab", label: "Kebab meat (doner)", kind: "chicken", menu: KEBAB, menuNot: NOT_DONER, products: { groups: [131], name: ["KEBAB"], not: ["SEEKH", "ADANA", "KOFTE", "BOULE KEBAB AGNEAU"] } },
  { key: "chicken_burger", label: "Chicken burger fillets", kind: "chicken", menu: ["chicken burger", "burger poulet", "burger au poulet", "fillet burger", "chicken fillet burger", "spicy chicken burger", "zinger"], products: { groups: [131], name: ["CHICKEN BURGER", "FILLET BURGER", "STEAK DE POULET", "STEAK POULET"] } },
  { key: "cordon_bleu", label: "Cordon bleu / crousty", kind: "chicken", menu: ["cordon bleu", "crousty", "escalope panee", "escalope pane"], products: { groups: [131], name: ["CORDON", "CROUSTY", "ESCALOPE PANE", "ESCALOPINE"] } },
  { key: "fried_chicken", label: "Fried chicken pieces", kind: "chicken", menu: FRIED_CHICKEN, products: { groups: [131], name: ["PILON", "KFC", "CHICKEN FRIED", "SOUTHERN FRIED", "WING CRISPY"] } },
  { key: "chicken_fillet", label: "Chicken fillet / thigh (raw)", kind: "chicken", menu: ["escalope", "filet de poulet", "blanc de poulet", "poulet grille", "grilled chicken", "chicken breast", "emince de poulet", "eminces de poulet", "brochette de poulet", "brochettes de poulet", "cuisse de poulet", "poulet braise", "poulet yassa", "poulet mafe"], menuNot: ["pane", "panee", "kebab"], products: { groups: [131], name: ["FILET DE POULET", "FILET POULET", "AIGUILLET", "CUISSE", "FILET CUBE", "FILET 'CONGELE"], not: ["CURRY", "TANDOORI", "PAPRYKA", "KEBAB", "DINDE"] } },
  { key: "whole_chicken", label: "Whole chicken", kind: "chicken", menu: ["poulet roti", "poulet entier", "demi poulet", "1 2 poulet", "rotisserie"], products: { groups: [131], name: ["POULET ENTIER"] } },
  { key: "marinated_chicken", label: "Tandoori / tikka / curry chicken", kind: "chicken", menu: [...INDIAN, "curry", "poulet curry", "chicken curry"], menuNot: ["crevette", "legume", "agneau", "lamb", "boeuf", "beef", "poisson", "vegetarien", "paneer"], products: { groups: [131], name: ["TANDOORI", "TIKKA", "CURRY", "TEXMEX", "TEX MEX"], not: ["WINGS", "AILLES"] } },
  { key: "yakitori", label: "Yakitori", kind: "chicken", menu: ["yakitori", "tsukune"], products: { groups: [131], name: ["YAKITORI", "TSUKUNE"] } },
  { key: "fish", label: "Fish fillet / fish burger", kind: "chicken", menu: ["fish", "fish burger", "filet de poisson", "poisson pane", "fish and chip", "fish chip"], products: { groups: [131], name: ["FISH"] } },

  // ── Beef, lamb, charcuterie ─────────────────────────────────────────
  { key: "beef_patties", label: "Beef burger patties / smash", kind: "beef", menu: BURGER, menuNot: NOT_BEEF, products: { groups: [133], name: ["STEAK HACHE", "STEAKHACHE", "STEAK HACHEE", "SMASH", "PARAGON", "BURGER A L OIGNON", "STEAK PUR", "STEAK FACON"], not: ["VEGI"] } },
  { key: "minced_beef", label: "Minced beef (égrené)", kind: "beef", menu: ["bolognaise", "bolognese", "viande hachee", "chili con carne", "lasagne", "lasagnes", "boulette", "boulettes", "keema"], products: { groups: [133], name: ["EGRENEE", "VIANDE HACHEE", "BOULETTE"] } },
  { key: "steaks", label: "Steaks / beef cuts", kind: "beef", menu: ["entrecote", "faux filet", "cote de boeuf", "tomahawk", "t bone", "rumsteak", "bavette", "onglet", "ribeye", "tournedos"], products: { groups: [133], name: ["ENTRECOTE", "FAUX FILLET", "TOURNEDO", "RUMSTEAK", "TOMAHAWK", "BIFTECK", "TBONE", "COTES DE BOEUF"] } },
  { key: "lamb", label: "Lamb", kind: "beef", menu: ["agneau", "lamb", "mouton", "gigot", "cotelette", "cotelettes d agneau", "mechoui"], products: { groups: [133], name: ["AGNEAU", "MUTTON"] } },
  { key: "kofte", label: "Kofte / adana / seekh kebab", kind: "beef", menu: ["kofte", "kofta", "kefta", "adana", "seekh", "seekh kebab", "brochette kefta"], products: { groups: [128, 133], name: ["KOFTE", "ADANA", "SEEKH"] } },
  { key: "merguez", label: "Merguez", kind: "beef", menu: ["merguez"], products: { groups: [133], name: ["MERGUEZ"] } },
  { key: "bacon", label: "Halal bacon / lardons", kind: "beef", menu: ["bacon", "lardon", "lardons", "beef bacon"], products: { groups: [131, 133], name: ["BACON", "LARDINETTE"] } },
  { key: "pepperoni_chorizo", label: "Pepperoni / chorizo (halal)", kind: "beef", menu: ["pepperoni", "chorizo"], products: { groups: [131, 133], name: ["PEPPERONI", "CHORIZO"] } },
  { key: "turkey_ham", label: "Turkey / chicken ham (délice)", kind: "beef", menu: ["jambon", "jambon de dinde", "dinde fumee", "poulet fume", "delice de dinde"], products: { groups: [131], name: ["DELICE", "ROUGE DE VOLAILLE", "JAMBON"] } },

  // ── Bread ────────────────────────────────────────────────────────────
  { key: "burger_buns", label: "Burger buns", kind: "bread", menu: BURGER, products: { groups: [132], name: ["BUN", "AMERICANA", "BAPS", "BRIOCHE"], not: ["HOT DOG", "PANINI"] } },
  { key: "kebab_bread", label: "Kebab bread", kind: "bread", menu: KEBAB, menuNot: [...NOT_DONER, "durum", "tacos", "assiette"], products: { groups: [132], name: ["PAIN KEBAB"] } },
  { key: "tortillas", label: "Tortillas (tacos, wraps)", kind: "bread", menu: [...TACOS, ...WRAPS], products: { groups: [132], name: ["TORTILLA"] } },
  { key: "naan", label: "Naan bread", kind: "bread", menu: ["naan", "nan", "cheese naan", "garlic naan"], products: { groups: [132], name: ["NAN BREAD"] } },
  { key: "panini_bread", label: "Panini bread", kind: "bread", menu: ["panini"], products: { groups: [132], name: ["PANINI"] } },
  { key: "hot_dog_rolls", label: "Hot dog rolls", kind: "bread", menu: ["hot dog"], products: { groups: [132], name: ["HOT DOG"] } },

  // ── Fries & frozen sides ─────────────────────────────────────────────
  { key: "fries", label: "Fries", kind: "sides", menu: FRIES, menuNot: [...NO_FRIES, "patate douce", "sweet potato", "plantain"], products: { groups: [128], name: ["FRITES", "FRIES", "PRIVATE RESERVE", "CHICAGO 6", "CRISPY CHIPS"], not: ["DOUCE", "SAUCE"] } },
  { key: "sweet_potato_fries", label: "Sweet potato fries", kind: "sides", menu: ["patate douce", "patates douces", "sweet potato"], products: { groups: [128], name: ["DOUCE"] } },
  { key: "wedges", label: "Potatoes / wedges", kind: "sides", menu: ["potatoes", "potatoe", "wedges", "potato wedge", "rosti", "hash brown", "galette de pomme de terre"], products: { groups: [128], name: ["WEDGES", "POTATO DIPPERS", "TWISTERS", "ZIGGY", "ROSTI", "HASH BROWN", "POTATO POPS"] } },
  { key: "onion_rings", label: "Onion rings", kind: "sides", menu: ["onion ring", "rings", "oignon ring"], products: { groups: [128], name: ["ONION RINGS", "OIGNON RINGS"] } },
  { key: "mozzarella_sticks", label: "Mozzarella sticks", kind: "sides", menu: ["mozzarella stick", "mozza stick", "stick mozzarella", "sticks mozzarella", "stick mozza", "sticks mozza"], products: { groups: [128], name: ["MOZZARELLA STICKS"] } },
  { key: "camembert_bites", label: "Camembert bites", kind: "sides", menu: ["camembert bite", "bouchee camembert", "bouchees de camembert", "nugget camembert", "camembert pane", "croque camembert"], products: { groups: [128], name: ["CAMEMBERT"] } },
  { key: "jalapeno_poppers", label: "Cheddar jalapeño bites", kind: "sides", menu: ["jalapeno popper", "cheddar jalapeno", "jalapeno cheddar"], menuNot: ["frite", "chips", "tacos", "twister"], products: { groups: [128], name: ["CHEDDAR JALAPENOS"] } },
  { key: "samosa", label: "Samosas", kind: "sides", menu: ["samosa", "samoussa", "samossa"], products: { groups: [128, 131], name: ["SAMOSA", "SAMOSSA"] } },
  { key: "nems", label: "Nems / spring rolls", kind: "sides", menu: ["nem", "nems", "rouleau imperial", "spring roll"], menuNot: ["sauce"], products: { groups: [128], name: ["NEM"] } },
  { key: "pakora", label: "Chicken pakora", kind: "sides", menu: ["pakora", "bhaji"], products: { groups: [131], name: ["PAKORA"] } },

  // ── Cheese & dairy ───────────────────────────────────────────────────
  { key: "cheese_slices", label: "Cheese slices (burger)", kind: "cheese", menu: ["cheeseburger", "cheese burger", "double cheese", "triple cheese", "cheese bacon", "smash cheese"], products: { groups: [128], name: ["CHEDDAR SLICE", "BURGER SLICES", "FROMAGE TRANCHES", "EN TRANCHE", "EMMENTAL TRANCHE"] } },
  { key: "pizza_mozzarella", label: "Pizza mozzarella", kind: "cheese", menu: PIZZA, products: { groups: [128], name: ["MOZZ", "FIOR DI LATTE", "BELLA NAPOLI"], not: ["STICKS"] } },
  { key: "grated_cheese", label: "Grated emmental", kind: "cheese", menu: ["gratin", "gratine", "croque monsieur", "croque madame", "emmental"], products: { groups: [128], name: ["EMMENTAL RAPE"] } },
  { key: "cheese_sauce", label: "Cheese sauce (tacos / nachos)", kind: "cheese", menu: [...TACOS, "sauce fromagere", "sauce cheddar", "cheese sauce", "nachos", "sauce fromage"], products: { groups: [128], name: ["SAUCE CHEDDAR", "SAUCE TACOS", "SAUCE FROMAGE"] } },
  { key: "cream", label: "Cooking cream", kind: "cheese", menu: ["carbonara", "creme fraiche", "sauce creme", "a la creme", "sauce champignon", "alfredo"], products: { groups: [128], name: ["CREME LIQUID", "CREAM X", "DOUBLE CREAM", "CREME LIQUIDE"], not: ["ICE CREAM"] } },
  { key: "eggs", label: "Eggs", kind: "grocery", menu: ["oeuf", "oeufs", "egg", "eggs", "omelette", "omelet"], products: { groups: [130], name: ["OEUF"] } },

  // ── Sauces ───────────────────────────────────────────────────────────
  { key: "snack_sauces", label: "Snack sauces (algérienne, samouraï, biggy…)", kind: "sauces", menu: SNACK_SAUCES, menuNot: ["maki", "california", "sushi", "tartare"], products: { groups: [126], name: ["DELICIA", "NAWHALS", "COLONA", "BLANCHE", "SAMOURAI", "ALGERIAN", "BIGGY", "KETCHUP", "MAYO", "BARBACUE"], not: ["CHILLI", "PERI", "SOJA", "LEMON"] } },
  { key: "sweet_chili", label: "Sweet chili sauce", kind: "sauces", menu: ["sweet chili", "sweet chilli", "chili thai", "chilli thai", "sauce thai"], products: { groups: [126], name: ["SWEET CHILLI", "CHILLI THAI", "CHILI THAI"] } },
  { key: "peri_peri", label: "Peri peri sauce / marinade", kind: "sauces", menu: ["peri peri", "piri piri", "peri", "piri"], products: { groups: [126, 130], name: ["PERI"] } },
  { key: "soy_sauce", label: "Soy sauce", kind: "sauces", menu: ["sauce soja", "soy sauce", "teriyaki"], products: { groups: [126], name: ["SOJA"] } },
  { key: "indian_pastes", label: "Indian pastes & spices", kind: "sauces", menu: INDIAN, products: { groups: [130], name: ["PATAKS", "MASALA", "MADRAS", "TANDOORI"] } },
  { key: "pizza_sauce", label: "Pizza / tomato sauce", kind: "sauces", menu: PIZZA, products: { groups: [127], name: ["SAUCE TOMATE", "PIZZA SAUCE", "CONCENTRE DE TOMATE"] } },
  { key: "harissa", label: "Harissa", kind: "sauces", menu: ["harissa"], products: { groups: [127], name: ["HARISSA"] } },

  // ── Grocery & toppings ───────────────────────────────────────────────
  { key: "frying_oil", label: "Frying oil", kind: "grocery", menu: [...FRIES, ...NUGGETS, ...TENDERS, "wings", "fried chicken", "poulet frit", "beignet", "beignets", "friture"], menuNot: NO_FRIES, products: { groups: [127], name: ["HUILE", "AVR60", "PALMAX"], not: ["OLIVE"] } },
  { key: "breading", label: "Breading flour / batter", kind: "grocery", menu: FRIED_CHICKEN, products: { groups: [130], name: ["BREADING", "BATTERMIX", "FARINE", "SUPREME POUR"], not: ["T55"] } },
  { key: "rice", label: "Rice", kind: "grocery", menu: ["riz", "rice", "biryani", "riz cantonais", "basmati", "riz blanc"], products: { groups: [130], name: ["RIZ"], not: ["SUSHI"] } },
  { key: "sushi_rice", label: "Sushi rice", kind: "grocery", menu: ["sushi", "maki", "california roll", "chirashi", "temaki", "poke", "sashimi"], menuNot: ["burger"], products: { groups: [130], name: ["SUSHI RIZ"] } },
  { key: "panko", label: "Panko", kind: "grocery", menu: ["panko", "tempura", "katsu", "tonkatsu", "ebi fry"], products: { groups: [130], name: ["PANKO"] } },
  { key: "pasta", label: "Pasta", kind: "grocery", menu: ["pates", "pasta", "penne", "spaghetti", "tagliatelle", "carbonara", "linguine"], menuNot: ["pizza"], products: { groups: [130], name: ["PENNE", "SPAGHETTI"] } },
  { key: "couscous", label: "Couscous", kind: "grocery", menu: ["couscous"], products: { groups: [130], name: ["COUSCOUS"] } },
  { key: "fried_onions", label: "Crispy fried onions", kind: "grocery", menu: ["oignons frits", "oignon frit", "crispy onion", "oignons crispy"], products: { groups: [130], name: ["FRIED OIGNONS"] } },
  { key: "pickles", label: "Pickles / gherkins", kind: "grocery", menu: ["cornichon", "cornichons", "pickle", "pickles"], products: { groups: [130], name: ["CORNICHON", "PICKLE"] } },
  { key: "jalapenos", label: "Jalapeños", kind: "grocery", menu: ["jalapeno", "jalapenos"], menuNot: ["popper", "cheddar jalapeno", "jalapeno cheddar"], products: { groups: [127], name: ["JALAPENO"] } },
  { key: "olives", label: "Olives", kind: "grocery", menu: ["olive", "olives"], menuNot: ["huile"], products: { groups: [127], name: ["OLIVES"] } },
  { key: "tuna", label: "Tuna", kind: "grocery", menu: ["thon", "tuna"], products: { groups: [127], name: ["THUN", "THON"] } },
  { key: "mushrooms", label: "Mushrooms", kind: "grocery", menu: ["champignon", "champignons", "mushroom", "mushrooms"], products: { groups: [127], name: ["CHAMPIGNON"] } },
  { key: "sweetcorn", label: "Sweetcorn", kind: "grocery", menu: ["mais doux", "sweet corn", "sweetcorn"], products: { groups: [127], name: ["MAIS DOUX"] } },
  { key: "pineapple", label: "Pineapple slices", kind: "grocery", menu: ["ananas", "hawaienne", "pineapple"], menuNot: ["fanta", "jus", "oasis", "tropico", "juice", "smoothie", "milkshake", "boisson", "soda", "freez", "freeze", "nectar", "frais", "chantilly", "coco"], products: { groups: [127], name: ["ANANAS TRANCH"] } },
  { key: "milkshake", label: "Milkshake mix & syrups", kind: "grocery", menu: ["milkshake", "milk shake", "mojito", "limonade maison", "sirop"], menuNot: ["7up", "7 up", "schweppes", "dada", "freeze", "canette", "litchi", "fruits"], products: { groups: [128, 130], name: ["ICE CREAM MIX", "MONIN", "SIROP"] } },

  // ── Desserts ─────────────────────────────────────────────────────────
  { key: "tiramisu", label: "Tiramisu", kind: "desserts", menu: ["tiramisu"], products: { groups: [125], name: ["TIRAMISU"] } },
  { key: "almondy", label: "Almondy / Daim cake", kind: "desserts", menu: ["daim", "almondy", "tarte daim"], products: { groups: [125], name: ["ALMONDY"] } },
  { key: "cheesecake", label: "Cheesecake", kind: "desserts", menu: ["cheesecake", "cheese cake"], products: { groups: [100, 125], name: ["CHEESECAKE", "CHEESE CAKE", "CHEESCAKE"] } },
  { key: "brownie", label: "Brownie / chocolate cake", kind: "desserts", menu: ["brownie", "fondant au chocolat", "fondant chocolat", "moelleux au chocolat", "gateau au chocolat"], menuNot: ["haagen", "ben"], products: { groups: [125], name: ["BROWNIE", "CHOCOLATE FUDGE", "GATEAU CHOCOLATE", "GATUEAUX CHOCOLATE"] } },
  { key: "donuts", label: "Donuts", kind: "desserts", menu: ["donut", "donuts", "doughnut"], menuNot: ["poulet", "chicken", "cheesy", "cheddar", "fromage"], products: { groups: [125], name: ["DONUT"] } },
  { key: "ice_cream", label: "Ice cream tubs", kind: "desserts", menu: ["haagen", "haagen dazs", "ben jerry", "ben and jerry", "glace", "glaces", "ice cream", "creme glacee"], menuNot: ["the", "tea", "ice tea"], products: { groups: [125], name: ["HAAGEN", "BEN & JERRY", "BEN JERRY", "GLACE"] } },
  { key: "apple_pie", label: "Hot apple pie", kind: "desserts", menu: ["apple pie", "chausson aux pommes", "tarte aux pommes"], products: { groups: [125], name: ["APPLE PIE"] } },

  // ── Drinks ───────────────────────────────────────────────────────────
  { key: "coca_cola", label: "Coca-Cola", kind: "drinks", menu: ["coca", "coca cola", "coke"], products: { groups: [123, 124], name: ["COCA", "COKE"] } },
  { key: "fanta", label: "Fanta", kind: "drinks", menu: ["fanta"], products: { groups: [123, 124], name: ["FANTA"] } },
  { key: "sprite", label: "Sprite", kind: "drinks", menu: ["sprite"], products: { groups: [123, 124], name: ["SPRITE"] } },
  { key: "oasis", label: "Oasis", kind: "drinks", menu: ["oasis"], products: { groups: [123, 124], name: ["OASIS"] } },
  { key: "ice_tea", label: "Ice tea", kind: "drinks", menu: ["ice tea", "icetea", "lipton", "fuze tea", "fuze"], products: { groups: [123, 124], name: ["ICE TEA", "FUZE"] } },
  { key: "orangina", label: "Orangina", kind: "drinks", menu: ["orangina"], products: { groups: [123, 124], name: ["ORANGINA"] } },
  { key: "schweppes", label: "Schweppes", kind: "drinks", menu: ["schweppes"], products: { groups: [123, 124], name: ["SCHWEPPES"] } },
  { key: "seven_up", label: "7Up", kind: "drinks", menu: ["7up", "7 up", "seven up"], products: { groups: [123, 124], name: ["7UP"] } },
  { key: "pepsi", label: "Pepsi", kind: "drinks", menu: ["pepsi"], products: { groups: [123, 124], name: ["PEPSI"] } },
  { key: "tropico", label: "Tropico", kind: "drinks", menu: ["tropico"], products: { groups: [123, 124], name: ["TROPICO"] } },
  { key: "perrier", label: "Perrier", kind: "drinks", menu: ["perrier"], products: { groups: [123, 124], name: ["PERRIER"] } },
  { key: "san_pellegrino", label: "San Pellegrino", kind: "drinks", menu: ["san pellegrino", "pellegrino"], products: { groups: [124], name: ["PELEGRINO", "PELLEGRINO"] } },
  { key: "water", label: "Water", kind: "drinks", menu: ["eau", "eau minerale", "eau plate", "cristaline", "evian", "vittel", "water"], menuNot: ["coco", "gazeuse", "petillante"], products: { groups: [124], name: ["CRISTALINE", "EVIAN", "NESTLE", "EAU"], not: ["GAZEIFIEE"] } },
  { key: "red_bull", label: "Red Bull", kind: "drinks", menu: ["red bull", "redbull"], products: { groups: [123], name: ["REDBULL", "RED BULL"] } },
  { key: "capri_sun", label: "Capri-Sun", kind: "drinks", menu: ["capri sun", "capri sonne", "caprisun"], products: { groups: [123], name: ["CAPRI"] } },
  { key: "dr_pepper", label: "Dr Pepper", kind: "drinks", menu: ["dr pepper"], products: { groups: [123], name: ["DR PEPPER"] } },
  { key: "tango", label: "Tango", kind: "drinks", menu: ["tango"], menuNot: ["crepe"], products: { groups: [123], name: ["TANGO"] } },
  { key: "rubicon", label: "Rubicon", kind: "drinks", menu: ["rubicon"], products: { groups: [123], name: ["RUBICON"] } },
  { key: "miranda", label: "Miranda", kind: "drinks", menu: ["miranda"], products: { groups: [123, 124], name: ["MIRANDA"] } },
  { key: "minute_maid", label: "Minute Maid", kind: "drinks", menu: ["minute maid"], products: { groups: [123], name: ["MINUTE MAID"] } },
  { key: "hawai", label: "Hawaï", kind: "drinks", menu: ["hawai"], menuNot: ["sauce", "burger", "pizza", "freez", "freeze", "chill"], products: { groups: [123], name: ["HAWAI"] } },

  // ── Packaging ────────────────────────────────────────────────────────
  { key: "pizza_boxes", label: "Pizza boxes", kind: "packaging", menu: PIZZA, products: { groups: [129], name: ["BOITE PIZZA"] } },
  { key: "burger_boxes", label: "Burger boxes / wraps", kind: "packaging", menu: BURGER, products: { groups: [129], name: ["BOX BURGER", "BOITE BURGER", "BURGER WRAPS"] } },
  { key: "chicken_boxes", label: "Chicken boxes / buckets", kind: "packaging", menu: [...WINGS, ...TENDERS, "bucket", "fried chicken"], products: { groups: [129], name: ["BOX CHICKEN", "CHICKEN BUCKET"] } },
  { key: "kebab_boxes", label: "Kebab boxes", kind: "packaging", menu: KEBAB, menuNot: NOT_DONER, products: { groups: [129], name: ["BOX KEBAB"] } },
  { key: "tacos_boxes", label: "Tacos / wrap packaging", kind: "packaging", menu: [...TACOS, "wrap", "durum"], products: { groups: [129], name: ["WRAP TACOS", "TORTILLA WRAP"] } },
  { key: "fries_scoops", label: "Fries scoops / trays", kind: "packaging", menu: FRIES, menuNot: NO_FRIES, products: { groups: [129], name: ["CHIP SCOOP", "BARQUETTE FRITE"] } },
  { key: "sauce_pots", label: "Sauce pots", kind: "packaging", menu: [...SNACK_SAUCES, "sauces", "sauce au choix", "sauce supplementaire", "supplement sauce", "pot de sauce"], menuNot: ["maki", "california", "sushi", "tartare"], products: { groups: [129], name: ["POTS ET COUVERCLES SAUCE", "POT DE SAUCE"] } },
];

// Display order of the kinds (and their labels).
const KINDS = [
  { key: "chicken", label: "Chicken & fish" },
  { key: "beef", label: "Beef, lamb & charcuterie" },
  { key: "bread", label: "Bread" },
  { key: "sides", label: "Fries & sides" },
  { key: "cheese", label: "Cheese & dairy" },
  { key: "sauces", label: "Sauces" },
  { key: "grocery", label: "Grocery" },
  { key: "desserts", label: "Desserts" },
  { key: "drinks", label: "Drinks" },
  { key: "packaging", label: "Packaging" },
];

module.exports = { LOOKBACK_MONTHS, HISTORY_MONTHS, SUGGESTIONS_PER_FLAG, EVIDENCE_PER_FLAG, CATEGORIES, KINDS };
