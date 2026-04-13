// utils/bilingualFoodGlossary.js
// Bilingual French ↔ English glossary for food / meat / produce terms used in inventory.
// Used to expand inventory search queries so a user typing "chicken" matches "Poulet de Filet".
//
// Each entry is a group of synonymous/translated terms. When a query word matches any term in a
// group, all terms in that group are added to the search. Entries are case-insensitive.

const GLOSSARY = [
    // ── PROTEINS / MEAT ───────────────────────────────────────────────
    ['chicken', 'chickens', 'poulet', 'poulets', 'poule', 'volaille', 'volailles', 'poultry'],
    ['beef', 'boeuf', 'bœuf', 'viande de boeuf', 'bovin', 'bovine'],
    ['lamb', 'agneau', 'mouton', 'mutton'],
    ['veal', 'veau'],
    ['turkey', 'dinde', 'dindon'],
    ['duck', 'canard'],
    ['goose', 'oie'],
    ['rabbit', 'lapin'],
    ['goat', 'chèvre', 'chevre', 'cabri'],
    ['pork', 'porc'], // Noted for filtering: halal inventory typically excludes, but still translated.
    ['meat', 'viande', 'viandes'],

    // ── CUTS / PARTS ──────────────────────────────────────────────────
    ['filet', 'fillet', 'fillets', 'filets'],
    ['breast', 'breasts', 'poitrine', 'blanc'],
    ['thigh', 'thighs', 'cuisse', 'cuisses'],
    ['leg', 'legs', 'jambe', 'gigot', 'pilon', 'pilons'],
    ['wing', 'wings', 'aile', 'ailes', 'ailette', 'ailettes'],
    ['shoulder', 'shoulders', 'épaule', 'epaule', 'épaules'],
    ['loin', 'longe', 'aloyau'],
    ['rib', 'ribs', 'côte', 'cote', 'côtes', 'cotes', 'côtelette', 'cotelette'],
    ['neck', 'cou', 'collier'],
    ['liver', 'foie'],
    ['heart', 'hearts', 'coeur', 'cœur'],
    ['tongue', 'langue'],
    ['kidney', 'rognon', 'rognons'],
    ['tripe', 'tripes', 'gras-double'],
    ['minced', 'ground', 'hache', 'haché', 'hachée', 'hachés', 'hachée'],
    ['sliced', 'tranche', 'tranché', 'tranchée', 'tranches'],
    ['diced', 'cube', 'cubes', 'dés', 'des'],
    ['bone-in', 'avec os', 'avec-os'],
    ['boneless', 'désossé', 'desosse', 'désossée', 'sans os', 'sans-os'],
    ['skinless', 'sans peau'],

    // ── FISH / SEAFOOD ────────────────────────────────────────────────
    ['fish', 'poisson', 'poissons'],
    ['salmon', 'saumon'],
    ['tuna', 'thon'],
    ['cod', 'cabillaud', 'morue'],
    ['sardine', 'sardines'],
    ['mackerel', 'maquereau'],
    ['shrimp', 'prawn', 'prawns', 'crevette', 'crevettes'],
    ['mussel', 'mussels', 'moule', 'moules'],
    ['oyster', 'oysters', 'huître', 'huitre', 'huîtres', 'huitres'],
    ['octopus', 'poulpe', 'pieuvre'],
    ['squid', 'calamar', 'calmar', 'encornet'],

    // ── DAIRY / EGGS ──────────────────────────────────────────────────
    ['milk', 'lait'],
    ['cheese', 'fromage', 'fromages'],
    ['butter', 'beurre'],
    ['yogurt', 'yoghurt', 'yaourt', 'yaourts'],
    ['cream', 'crème', 'creme'],
    ['egg', 'eggs', 'oeuf', 'œuf', 'oeufs', 'œufs'],

    // ── GRAINS / STAPLES ──────────────────────────────────────────────
    ['rice', 'riz'],
    ['flour', 'farine'],
    ['bread', 'pain'],
    ['pasta', 'pâtes', 'pates'],
    ['wheat', 'blé', 'ble', 'froment'],
    ['semolina', 'semoule'],
    ['couscous'],
    ['oat', 'oats', 'avoine'],
    ['barley', 'orge'],
    ['corn', 'maïs', 'mais'],
    ['sugar', 'sucre'],
    ['salt', 'sel'],

    // ── LEGUMES ───────────────────────────────────────────────────────
    ['bean', 'beans', 'haricot', 'haricots'],
    ['lentil', 'lentils', 'lentille', 'lentilles'],
    ['chickpea', 'chickpeas', 'pois chiche', 'pois-chiche', 'pois chiches'],
    ['pea', 'peas', 'pois'],

    // ── VEGETABLES ────────────────────────────────────────────────────
    ['potato', 'potatoes', 'pomme de terre', 'pommes de terre', 'patate'],
    ['tomato', 'tomatoes', 'tomate', 'tomates'],
    ['onion', 'onions', 'oignon', 'oignons'],
    ['garlic', 'ail'],
    ['carrot', 'carrots', 'carotte', 'carottes'],
    ['pepper', 'peppers', 'poivron', 'poivrons'],
    ['chili', 'chilli', 'piment', 'piments'],
    ['lettuce', 'laitue', 'salade'],
    ['cucumber', 'concombre'],
    ['spinach', 'épinard', 'epinard', 'épinards', 'epinards'],
    ['cabbage', 'chou', 'choux'],
    ['broccoli', 'brocoli', 'brocolis'],
    ['cauliflower', 'chou-fleur', 'choufleur'],
    ['eggplant', 'aubergine', 'aubergines'],
    ['zucchini', 'courgette', 'courgettes'],
    ['mushroom', 'mushrooms', 'champignon', 'champignons'],

    // ── FRUITS ────────────────────────────────────────────────────────
    ['apple', 'apples', 'pomme', 'pommes'],
    ['orange', 'oranges'],
    ['banana', 'bananas', 'banane', 'bananes'],
    ['grape', 'grapes', 'raisin', 'raisins'],
    ['strawberry', 'strawberries', 'fraise', 'fraises'],
    ['lemon', 'lemons', 'citron', 'citrons'],
    ['lime', 'citron vert'],
    ['peach', 'peaches', 'pêche', 'peche', 'pêches'],
    ['pear', 'pears', 'poire', 'poires'],
    ['watermelon', 'pastèque', 'pasteque'],
    ['melon', 'melons'],
    ['pineapple', 'ananas'],
    ['mango', 'mangoes', 'mangue', 'mangues'],
    ['date', 'dates', 'datte', 'dattes'],
    ['fig', 'figs', 'figue', 'figues'],
    ['olive', 'olives'],

    // ── SPICES / HERBS ────────────────────────────────────────────────
    ['cinnamon', 'cannelle'],
    ['cumin'],
    ['turmeric', 'curcuma'],
    ['ginger', 'gingembre'],
    ['paprika'],
    ['saffron', 'safran'],
    ['coriander', 'cilantro', 'coriandre'],
    ['parsley', 'persil'],
    ['mint', 'menthe'],
    ['basil', 'basilic'],
    ['thyme', 'thym'],

    // ── OILS / FATS ───────────────────────────────────────────────────
    ['oil', 'oils', 'huile', 'huiles'],
    ['olive oil', 'huile d\'olive', 'huile olive'],
    ['sunflower', 'tournesol'],
    ['margarine'],

    // ── DRINKS ────────────────────────────────────────────────────────
    ['water', 'eau', 'eaux'],
    ['juice', 'juices', 'jus'],
    ['tea', 'thé', 'the'],
    ['coffee', 'café', 'cafe'],
    ['soda', 'soft drink', 'boisson', 'boissons'],

    // ── STATE / PROCESSING ───────────────────────────────────────────
    ['fresh', 'frais', 'fraîche', 'fraiche'],
    ['frozen', 'surgelé', 'surgele', 'congelé', 'congele', 'surgelée'],
    ['dried', 'séché', 'seche', 'sec', 'séchée', 'sechee'],
    ['smoked', 'fumé', 'fume', 'fumée', 'fumee'],
    ['canned', 'conserve', 'en conserve'],
    ['raw', 'cru', 'crue'],
    ['cooked', 'cuit', 'cuite'],
    ['halal'],
    ['organic', 'bio', 'biologique', 'biologiques'],
    ['kosher', 'casher', 'cacher'],

    // ── PACKAGING / UNITS ────────────────────────────────────────────
    ['bottle', 'bottles', 'bouteille', 'bouteilles'],
    ['box', 'boxes', 'boîte', 'boite', 'carton', 'cartons'],
    ['bag', 'bags', 'sac', 'sacs', 'sachet', 'sachets'],
    ['pack', 'pack', 'paquet', 'paquets'],
    ['tray', 'trays', 'plateau', 'plateaux', 'barquette', 'barquettes'],
    ['jar', 'jars', 'bocal', 'bocaux', 'pot', 'pots'],
    ['can', 'cans', 'boîte de conserve', 'canette', 'canettes'],
    ['kilogram', 'kilograms', 'kilo', 'kilos', 'kg'],
    ['gram', 'grams', 'gramme', 'grammes', 'g'],
    ['liter', 'liters', 'litre', 'litres', 'l'],
];

// Build a fast reverse index: lowercased term → group index
const TERM_TO_GROUP = new Map();
GLOSSARY.forEach((group, idx) => {
    group.forEach(term => {
        TERM_TO_GROUP.set(term.toLowerCase(), idx);
    });
});

/**
 * Given a word, return the full synonym group (including the original word) if known;
 * otherwise return [word] unchanged.
 */
function synonymsFor(word) {
    if (!word) return [];
    const key = word.toLowerCase();
    const idx = TERM_TO_GROUP.get(key);
    if (idx === undefined) return [word];
    return GLOSSARY[idx];
}

/**
 * Escape regex special chars.
 */
function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Tokenize a free-text search query into meaningful tokens.
 * Drops accents for matching robustness.
 */
function tokenize(query) {
    if (!query) return [];
    return String(query)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // strip diacritics for tokenization
        .toLowerCase()
        .split(/[\s,;/\-]+/)
        .map(t => t.trim())
        .filter(t => t.length >= 2);
}

/**
 * Build an $and-of-$or MongoDB query on text fields that matches when EVERY query token
 * (or one of its known synonyms in either language) appears in at least one of the given fields.
 *
 * Example: query "chicken filet"
 *   → AND(
 *       (chicken|poulet|poule|volaille|…),
 *       (filet|fillet)
 *     )
 *   and each clause is applied as regex against the `fields` array (ItemName, ForeignName, …).
 *
 * Falls back to a simple regex-on-single-field query when nothing tokenizes out of the input.
 */
function buildBilingualQuery(query, fields = ['ItemName', 'ForeignName', 'ItemCode']) {
    const tokens = tokenize(query);
    if (tokens.length === 0) {
        const fallback = escapeRegex(query || '');
        return {
            $or: fields.map(f => ({ [f]: { $regex: fallback, $options: 'i' } })),
        };
    }

    const andClauses = tokens.map(token => {
        const synonyms = synonymsFor(token);
        // Build a single regex alternation for this token so each $or per field matches any synonym.
        const alternation = synonyms.map(escapeRegex).join('|');
        return {
            $or: fields.map(f => ({ [f]: { $regex: alternation, $options: 'i' } })),
        };
    });

    return { $and: andClauses };
}

/**
 * Return the flat list of search terms (original + synonyms across all tokens) for a query.
 * Useful when you want to generate multiple keyword searches without building a Mongo query.
 */
function expandKeywords(query) {
    const tokens = tokenize(query);
    const terms = new Set();
    tokens.forEach(t => synonymsFor(t).forEach(s => terms.add(s)));
    if (tokens.length === 0 && query) terms.add(query);
    return Array.from(terms);
}

module.exports = {
    GLOSSARY,
    synonymsFor,
    tokenize,
    buildBilingualQuery,
    expandKeywords,
};
