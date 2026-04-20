# Geo-Intelligent Auto Catalog System — Full Implementation

## Core Design Principle

> **Generated top products are kept internally, but the visible/output list is the catalogue-matched subset only.**

This means:

1. Build nearby-shop frequency products from real registered shops
2. Generate category-wise candidates using Gemini AI (category-aware: fresh vs packaged)
3. Keep that full generated result internally
4. **Match generated items against the master catalogue (Postgres `product` table)**
5. **Return only matched catalogue products to frontend**

Because of this, **frontend does not need changes** — backend always returns valid catalogue products.

---

## Rollout Plan

This implementation is split into **2 phases**.

### Phase 1: Testing Only For Single Pincode `560100`

Purpose:

- prove the aggregation logic works
- validate category grouping
- validate top-product generation from nearby shops
- validate catalogue matching (only master-catalogue products in output)
- validate Mongo insert into `geo_catalogs`
- validate `POST /geo/test/pincode`

In this phase:

- only run catalog build for `560100`
- use `retailercatalog` as primary source
- use fallback mock category data if real data is too low
- **do not depend on Gemini** (use static fallback in `ai.service.js`)
- **match all generated products against master catalogue before returning**

Main entrypoint for this phase:

- `buildPincodeCatalog('560100')`
- API:
  - `POST http://localhost:2210/cms/apis/v1/geo/test/pincode`

Expected result:

- one `geo_catalogs` document with `level = PINCODE`
- `pincode = 560100`
- multiple categories
- multiple products inside each category
- **every returned product name exists in the master catalogue**
- internal `_rawGeneratedProducts` kept for debugging but NOT sent to frontend

### Phase 2: Full Production-Style Implementation

Purpose:

- expand from single pincode to all pincodes
- add hierarchy fallback:
  - `PINCODE -> CITY -> STATE -> COUNTRY`
- add nightly cron at `2:00 AM` (**one pincode at a time, sequential**)
- apply geo catalog to shops using `/geo/apply`
- generate top products using a hybrid of:
  - common nearby-shop products from DB (frequency counts)
  - Gemini AI suggested products (**category-aware**)
- **match ALL generated products against master catalogue before storing/returning**

Category-aware Gemini generation:

- **Fresh/local categories** (dairy, vegetables, fruits): common generic names like `tomato`, `bhindi`, `okra`, `paneer`
- **Packaged categories** (snacks, beverages, personal care): brand/company-specific names like `Lays Classic Salted`, `Bikaji Bhujia`, `Colgate MaxFresh`

In this phase:

- cron runs every day at `2 AM`
- **processes one pincode at a time** (sequential, not parallel) to avoid overloading Gemini API
- all shop pincodes are processed
- city/state/country catalogs are rebuilt after pincode generation
- Gemini is not standalone source of truth
- final top-product list is a merged list of:
  - nearby real shop frequency products
  - Gemini-suggested high-likelihood category products
- **Before output, every product is matched against master catalogue**
- **Only catalogue-matched products appear in API response and stored document**

---

## What To Test First

Test order should be:

1. local DB connections (Postgres + MongoDB)
2. `POST /geo/test/pincode` for `560100`
3. Verify Mongo `geo_catalogs` insert
4. Verify returned products exist in master catalogue
5. `POST /geo/test/shop` for a known shopId
6. `POST /geo/apply`
7. Mongo `customcatalog` insert verification
8. Manual cron trigger via `POST /geo/cron/trigger`
9. Nightly cron execution
10. Gemini integration (Phase 2)

---

## File-By-File Implementation

### File 1: `backend/catalogue_mgmt_service/src/apis/utils/normalizeProduct.js`

**Action: EDIT existing file (replace contents)**

What this code does:

- keeps retailer product names exactly as stored in source data
- removes only leading/trailing whitespace
- does not change casing, units, punctuation, or numbers

```js
const exactProductName = (value = '') => String(value || '').trim();

module.exports = exactProductName;
```

---

### File 2: `backend/catalogue_mgmt_service/src/apis/models/mongoCatalog/geoCatalogSchema.js`

**Action: EDIT existing file (replace contents)**

What this code does:

- Mongo collection `geo_catalogs`
- stores multiple categories in one document
- stores both `matchedProducts` (catalogue-verified) and raw `products`
- supports hierarchy levels: `PINCODE`, `CITY`, `STATE`, `COUNTRY`

```js
const mongoose = require('mongoose');

const geoCatalogProductSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    count: {
      type: Number,
      default: 0,
      min: 0,
    },
    catalogueProductId: {
      type: String,
      default: null,
    },
    source: {
      type: String,
      enum: ['DB', 'AI', 'FALLBACK'],
      default: 'DB',
    },
  },
  { _id: false },
);

const geoCatalogCategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    products: {
      type: [geoCatalogProductSchema],
      default: [],
    },
  },
  { _id: false },
);

const geoCatalogSchema = new mongoose.Schema(
  {
    level: {
      type: String,
      required: true,
      enum: ['PINCODE', 'CITY', 'STATE', 'COUNTRY'],
    },
    pincode: {
      type: String,
      default: null,
      index: true,
    },
    city: {
      type: String,
      default: null,
    },
    state: {
      type: String,
      default: null,
    },
    country: {
      type: String,
      default: null,
    },
    categories: {
      type: [geoCatalogCategorySchema],
      default: [],
    },
    lastBuildAt: {
      type: Date,
      default: null,
    },
    buildStatus: {
      type: String,
      enum: ['SUCCESS', 'PARTIAL', 'FALLBACK', 'FAILED'],
      default: 'SUCCESS',
    },
  },
  { timestamps: true },
);

geoCatalogSchema.index({ level: 1, pincode: 1 }, { sparse: true });
geoCatalogSchema.index({ level: 1, city: 1 }, { sparse: true });
geoCatalogSchema.index({ level: 1, state: 1 }, { sparse: true });
geoCatalogSchema.index({ level: 1, country: 1 }, { sparse: true });

const GeoCatalog = mongoose.model('geo_catalogs', geoCatalogSchema);

module.exports = GeoCatalog;
```

---

### File 3: `backend/catalogue_mgmt_service/src/apis/services/v1/catalogueMatcher.service.js`

**Action: CREATE new file**

What this code does:

- **This is the critical new piece** — matches generated product names against the master catalogue
- Queries the Postgres `product` table via Objection.js model
- Uses case-insensitive `ILIKE` matching
- Returns only products that exist in the catalogue
- Attaches the matched catalogue product ID to each result

Why this exists:

- Frontend should never show raw generated names directly
- Only products existing in our catalogue should be returned
- This is the filter between "generated internally" and "shown to user"

```js
const { Logger: log } = require('sarvm-utility');
const MongoProduct = require('../../models/mongoCatalog/productSchema');

/**
 * Normalize string for matching
 */
const normalize = (str = '') =>
  String(str).trim().toLowerCase();

/**
 * Match product names against MongoDB product collection
 *
 * @param {string[]} productNames
 * @returns {Promise<Map<string, { id: string, name: string }>>}
 */
const matchAgainstCatalogue = async (productNames = []) => {
  if (!productNames.length) return new Map();

  const matchedMap = new Map();

  try {
    // Step 1: Normalize & dedupe input
    const uniqueNames = [
      ...new Set(productNames.map((n) => normalize(n)).filter(Boolean)),
    ];

    // Step 2: Build regex queries (partial match)
    const regexQueries = uniqueNames.map((name) => ({
      prdNm: { $regex: name, $options: 'i' },
    }));

    // Step 3: Query MongoDB once
    const results = await MongoProduct.find({
      $or: regexQueries,
    })
      .select('_id prdNm')
      .lean()
      .exec();

    // Step 4: Build map
    results.forEach((product) => {
      const key = normalize(product.prdNm);

      if (!matchedMap.has(key)) {
        matchedMap.set(key, {
          id: product._id,
          name: product.prdNm,
        });
      }
    });

    log.info({
      info: 'Mongo CatalogueMatcher complete',
      inputCount: uniqueNames.length,
      matchedCount: matchedMap.size,
    });
  } catch (error) {
    log.error({
      error: 'Mongo CatalogueMatcher failed',
      details: error.message,
    });
  }

  return matchedMap;
};

/**
 * Filter products using matched catalogue map
 */
const filterByCatalogue = (products = [], catalogueMap) => {
  return products
    .map((product) => {
      const normalizedName = normalize(product.name);

      // Find closest match (partial)
      let matched = null;

      for (const [key, value] of catalogueMap.entries()) {
        if (
          key.includes(normalizedName) ||
          normalizedName.includes(key)
        ) {
          matched = value;
          break;
        }
      }

      if (!matched) return null;

      return {
        ...product,
        name: matched.name, // use Mongo product name
        catalogueProductId: matched.id,
      };
    })
    .filter(Boolean);
};

module.exports = {
  matchAgainstCatalogue,
  filterByCatalogue,
};
```

---

### File 4: `backend/catalogue_mgmt_service/src/apis/services/v1/ai.service.js`

**Action: EDIT existing file (replace contents)**

What this code does:

- Phase 1: provides static fallback product lists (mock, no API call)
- Phase 2: calls Gemini API for **category-aware** product suggestions
  - Fresh/local categories → common/generic names (tomato, paneer, curd)
  - Packaged categories → brand-specific names (Lays Classic Salted, Bisleri Water)
- All generated names go through catalogue matching before being shown

Phase 2 Gemini environment variables needed in `.lcl.env`:
```
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-2.0-flash
```

```js
const { Logger: log } = require('sarvm-utility');

// ─── PHASE 1: Static fallback catalog ────────────────────────────────

const FRESH_CATEGORIES = new Set([
  'dairy', 'vegetables', 'fruits', 'meat', 'fish', 'seafood',
  'eggs', 'poultry', 'fresh produce', 'organic', 'farm fresh',
]);

const fallbackCatalog = {
  dairy: [
    'Amul Gold Milk 500ml', 'Mother Dairy Curd 400g', 'Amul Butter 100g',
    'Amul Paneer 200g', 'Amul Cheese Slice', 'Nandini Ghee 1L',
    'Amul Buttermilk 200ml', 'Amul Kool Chocolate', 'Milky Mist Cream 200ml',
    'Nestle Yogurt 100g',
  ],
  snacks: [
    'Lays Classic Salted 52g', 'Parle-G Biscuits 250g', 'Haldiram Namkeen 200g',
    'Kurkure Masala Munch 90g', 'Bikaji Bhujia 200g', 'Britannia Good Day 250g',
    'Too Yumm Veggie Stix', 'Act II Popcorn 70g', 'Parle Monaco 200g',
    'Bingo Mad Angles 72g',
  ],
  beverages: [
    'Bisleri Water 1L', 'Coca Cola 750ml', 'Tropicana Orange Juice 1L',
    'Tata Tea Gold 500g', 'Nescafe Classic 50g', 'Red Bull 250ml',
    'Thums Up 750ml', 'Amul Lassi 200ml', 'Nescafe Cold Coffee 200ml',
    'Lipton Iced Tea 350ml',
  ],
  staples: [
    'India Gate Basmati Rice 5kg', 'Aashirvaad Atta 10kg', 'Tata Toor Dal 1kg',
    'Tata Moong Dal 1kg', 'Tata Salt 1kg', 'Madhur Sugar 1kg',
    'Fortune Sunflower Oil 1L', 'Maggi Poha 500g', 'Sooji Rava 500g',
    'MTR Rava Idli Mix 500g',
  ],
  vegetables: [
    'Tomato', 'Onion', 'Potato', 'Bhindi (Okra)', 'Brinjal',
    'Capsicum', 'Carrot', 'Cauliflower', 'Cabbage', 'Green Chilli',
  ],
  fruits: [
    'Banana', 'Apple', 'Mango', 'Grapes', 'Papaya',
    'Watermelon', 'Pomegranate', 'Orange', 'Guava', 'Sapota (Chiku)',
  ],
  bakery: [
    'Britannia Bread White', 'Amul Butter Bun', 'Britannia Rusk 300g',
    'Monginis Cake Slice', 'Britannia Muffin Chocolate', 'Pav 6 Pack',
    'Parle Khari 200g', 'Britannia Toast', 'Harvest Gold Brown Bread',
    'Britannia Good Day Cookies 250g',
  ],
  personal_care: [
    'Dove Soap 100g', 'Head & Shoulders Shampoo 180ml', 'Colgate MaxFresh 150g',
    'Garnier Face Wash 100ml', 'Dettol Body Wash 250ml', 'Nivea Deo 150ml',
    'Ponds Talc 300g', 'Vaseline Lotion 200ml', 'Oral-B Toothbrush',
    'Parachute Hair Oil 200ml',
  ],
};

/**
 * Determine if a category should use fresh/local product names or brand/packaged names.
 */
const isFreshCategory = (categoryName) => {
  const normalized = String(categoryName || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return FRESH_CATEGORIES.has(normalized);
};

/**
 * Phase 1: Get static fallback products for given categories.
 */
const getFallbackProducts = (categories = []) => {
  const resolved = {};

  categories.forEach((categoryName) => {
    const key = String(categoryName || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '_');

    if (fallbackCatalog[key]) {
      resolved[categoryName] = fallbackCatalog[key];
    }
  });

  if (!Object.keys(resolved).length) {
    return fallbackCatalog;
  }

  return resolved;
};

// ─── PHASE 2: Gemini API Integration ─────────────────────────────────

let geminiAvailable = false;
let GoogleGenerativeAI = null;

// Try to load Gemini SDK (install @google/generative-ai for Phase 2)
try {
  const geminiModule = require('@google/generative-ai');
  GoogleGenerativeAI = geminiModule.GoogleGenerativeAI;
  geminiAvailable = true;
} catch (e) {
  // Gemini SDK not installed — Phase 1 mode, use fallback only
  geminiAvailable = false;
}

/**
 * Phase 2: Call Gemini to get category-aware product suggestions.
 *
 * For FRESH categories: returns common generic product names (e.g., "Tomato", "Paneer")
 * For PACKAGED categories: returns brand-specific names (e.g., "Lays Classic Salted 52g")
 *
 * @param {string} categoryName
 * @param {string[]} existingProducts - products already found from DB, to avoid duplicates
 * @returns {Promise<string[]>} Array of suggested product names
 */
const getGeminiCategoryProducts = async (categoryName, existingProducts = []) => {
  if (!geminiAvailable || !process.env.GEMINI_API_KEY) {
    log.info({ info: `AI Service: Gemini not available for category "${categoryName}", using fallback` });
    const fallback = getFallbackProducts([categoryName]);
    return fallback[categoryName] || fallback[categoryName?.replace(/\s+/g, '_')] || [];
  }

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.0-flash' });

    const isFresh = isFreshCategory(categoryName);
    const existingList = existingProducts.slice(0, 20).join(', ');

    let prompt;
    if (isFresh) {
      prompt = `You are a product catalog expert for Indian retail stores.
For the category "${categoryName}", give me 15 common product names that Indian grocery stores typically sell.
Since this is a fresh/local/unpackaged category, use common generic names (e.g., "Tomato", "Onion", "Paneer", "Curd").
Do NOT use brand names for this category.
${existingList ? `These products are already found: ${existingList}. Suggest DIFFERENT products not in this list.` : ''}
Return ONLY a valid JSON array of short product name strings. No explanations.`;
    } else {
      prompt = `You are a product catalog expert for Indian retail stores.
For the category "${categoryName}", give me 15 commonly sold products in Indian retail/grocery stores.
Since this is a packaged/branded category, use specific brand names and pack sizes where relevant (e.g., "Lays Classic Salted 52g", "Parle-G 250g", "Colgate MaxFresh 150g").
${existingList ? `These products are already found: ${existingList}. Suggest DIFFERENT products not in this list.` : ''}
Return ONLY a valid JSON array of short product name strings. No explanations.`;
    }

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();

    // Extract JSON array from response
    const jsonMatch = responseText.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) {
      log.warn({ warn: `AI Service: Gemini returned non-JSON for category "${categoryName}"` });
      return getFallbackProducts([categoryName])[categoryName] || [];
    }

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) {
      return getFallbackProducts([categoryName])[categoryName] || [];
    }

    log.info({
      info: `AI Service: Gemini returned ${parsed.length} products for "${categoryName}" (${isFresh ? 'fresh' : 'packaged'})`,
    });

    return parsed.map((name) => String(name).trim()).filter(Boolean);
  } catch (error) {
    log.error({
      error: `AI Service: Gemini call failed for category "${categoryName}"`,
      details: error.message,
    });
    // Fallback on any error
    return getFallbackProducts([categoryName])[categoryName] || [];
  }
};

module.exports = {
  normalizeNames: (names = [], normalizer) => names.map((name) => normalizer(name)).filter(Boolean),
  getFallbackProducts,
  getGeminiCategoryProducts,
  isFreshCategory,
};
```

---

### File 5: `backend/catalogue_mgmt_service/src/apis/services/v1/shopGeo.service.js`

**Action: CREATE new file**

What this code does:

- resolves shop location metadata (pincode/city/state/country) for grouping
- fetches from RMS APIs, falls back to local Mongo collections

```js
const axios = require('axios');
const mongoose = require('mongoose');
const { Logger: log } = require('sarvm-utility');

const RetailerCatalog = require('../../models/mongoCatalog/retailerSchema');
const { loadBalancer, system_token } = require('@config');

const chunkArray = (items = [], size = 100) => {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

const normalizeRecord = (record = {}) => {
  const shopId = Number(record.shopId || record.shop_id || record.id);
  if (!shopId) return null;

  return {
    shopId,
    pincode: record.pincode ? String(record.pincode) : null,
    city: record.city || record.locality || null,
    state: record.state || record.region || null,
    country: record.country || 'India',
    locality: record.locality || null,
    latitude: record.latitude || record.lat || record.location?.latitude || null,
    longitude: record.longitude || record.lon || record.location?.longitude || null,
  };
};

const fetchFromRemote = async (shopIds = []) => {
  if (!shopIds.length || !loadBalancer) return [];

  try {
    const response = await axios({
      method: 'get',
      url: `${loadBalancer}/rms/apis/v2/shop/getPGShopDetails/${shopIds.join(',')}`,
      timeout: 4000,
      headers: { Authorization: `Bearer ${system_token}` },
    });
    return (response?.data?.data || []).map(normalizeRecord).filter(Boolean);
  } catch (error) {
    log.warn({ warn: 'Geo shop remote lookup failed', error: error.message });
    return [];
  }
};

const fetchFromLocalCollections = async (shopIds = []) => {
  if (!shopIds.length || !mongoose.connection?.db) return [];

  const candidateCollections = ['shops', 'shopdetails', 'shopdetail', 'shop_meta', 'shopmeta', 'shopmetadata'];

  try {
    const existingCollections = await mongoose.connection.db.listCollections().toArray();
    const collectionNames = new Set(existingCollections.map((c) => c.name));
    const records = [];

    for (const collectionName of candidateCollections) {
      if (!collectionNames.has(collectionName)) continue;

      const collection = mongoose.connection.db.collection(collectionName);
      const docs = await collection
        .find({ $or: [{ shopId: { $in: shopIds } }, { shop_id: { $in: shopIds } }] })
        .toArray();

      docs.forEach((doc) => {
        const normalized = normalizeRecord(doc);
        if (normalized) records.push(normalized);
      });
    }
    return records;
  } catch (error) {
    log.warn({ warn: 'Geo shop local collection lookup failed', error: error.message });
    return [];
  }
};

const dedupeByShopId = (records = []) => {
  const map = new Map();
  records.forEach((record) => {
    if (!record?.shopId || map.has(record.shopId)) return;
    map.set(record.shopId, record);
  });
  return Array.from(map.values());
};

const getShopLocations = async (shopIds = []) => {
  const normalizedIds = [...new Set(shopIds.map((id) => Number(id)).filter(Boolean))];
  const allRecords = [];

  for (const chunk of chunkArray(normalizedIds)) {
    const remoteRecords = await fetchFromRemote(chunk);
    const missingIds = chunk.filter(
      (id) => !remoteRecords.some((r) => Number(r.shopId) === Number(id)),
    );
    const localRecords = missingIds.length ? await fetchFromLocalCollections(missingIds) : [];
    allRecords.push(...remoteRecords, ...localRecords);
  }

  return dedupeByShopId(allRecords);
};

const getAllRetailerShopIds = async () => {
  const shopIds = await RetailerCatalog.distinct('shopId', { shopId: { $ne: null } });
  return shopIds.map((id) => Number(id)).filter(Boolean);
};

const getAllShopLocations = async () => getShopLocations(await getAllRetailerShopIds());

const getShopsByPincode = async (pincode) => {
  const records = await getAllShopLocations();
  return records.filter((r) => String(r.pincode) === String(pincode));
};

const getShopLocation = async (shopId) => {
  const [record] = await getShopLocations([shopId]);
  return record || null;
};

module.exports = {
  getAllRetailerShopIds,
  getAllShopLocations,
  getShopLocations,
  getShopLocation,
  getShopsByPincode,
};
```

---

### File 6: `backend/catalogue_mgmt_service/src/apis/services/v1/pincodeCatalogBuilder.service.js`

**Action: CREATE new file**

What this code does:

- **This is the core builder** for Phase 1 and Phase 2
- Takes a pincode → finds shops → finds retailer products → groups by category → counts frequency
- Merges Gemini/fallback suggestions
- **Matches ALL products against master catalogue before storing/returning**
- Only catalogue-matched products appear in the final output

Key flow:

1. Shop lookup by pincode
2. Retailer product fetch from MongoDB
3. Extract product names and categories, count frequency
4. For each category: get Gemini/fallback suggestions
5. Merge DB products + AI products
6. **Match entire merged list against master catalogue (Postgres)**
7. **Keep only matched products**
8. Store result in `geo_catalogs`
9. Return catalogue-matched products

```js
const { Types } = require('mongoose');
const { Logger: log } = require('sarvm-utility');

const RetailerCatalog = require('../../models/mongoCatalog/retailerSchema');
const GeoCatalog = require('../../models/mongoCatalog/geoCatalogSchema');
const MongoProduct = require('../../models/mongoCatalog/productSchema');
const MongoCategory = require('../../models/mongoCatalog/categorySchema');
const exactProductName = require('../../utils/normalizeProduct');
const aiService = require('./ai.service');
const shopGeoService = require('./shopGeo.service');
const { matchAgainstCatalogue, filterByCatalogue } = require('./catalogueMatcher.service');

const TOP_PRODUCTS_LIMIT = parseInt(process.env.TOP_PRODUCTS_LIMIT || '10', 10);
const GEMINI_BASE_SCORE = 25;

// ─── Helpers ─────────────────────────────────────────────────────────

const getCategoryName = (retailerDoc, productDoc) => {
  const catalog = retailerDoc?.catalog || {};
  const rawCategory =
    retailerDoc?.category ||
    catalog?.category ||
    catalog?.catPnm ||
    productDoc?.catPnm ||
    '';

  const firstSegment = Array.isArray(rawCategory) ? rawCategory[0] : String(rawCategory).split('/')[0];

  return String(firstSegment || '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
};

const getCategorySeedList = async () => {
  try {
    const [productCategories, mongoCategories] = await Promise.all([
      MongoProduct.aggregate([
        { $project: { category: { $arrayElemAt: [{ $split: ['$catPnm', '/'] }, 0] } } },
        { $match: { category: { $nin: [null, ''] } } },
        { $group: { _id: '$category' } },
        { $project: { _id: 0, name: { $toLower: '$_id' } } },
      ]),
      MongoCategory.aggregate([
        { $project: { name: { $toLower: '$name' } } },
        { $match: { name: { $nin: [null, ''] } } },
        { $group: { _id: '$name' } },
        { $project: { _id: 0, name: '$_id' } },
      ]),
    ]);

    return [
      ...new Set(
        [...productCategories, ...mongoCategories]
          .map((item) => item?.name)
          .filter(Boolean)
          .map((item) => item.replace(/[_-]+/g, ' ').trim().toLowerCase()),
      ),
    ];
  } catch (error) {
    log.warn({ warn: 'getCategorySeedList failed', error: error.message });
    return [];
  }
};

// ─── Fallback builder ────────────────────────────────────────────────

const buildFallbackCategories = async () => {
  const categorySeeds = await getCategorySeedList();
  const fallback = aiService.getFallbackProducts(categorySeeds);

  return Object.entries(fallback).map(([name, products]) => ({
    name,
    products: products.slice(0, TOP_PRODUCTS_LIMIT).map((productName, index) => ({
      name: exactProductName(productName),
      count: Math.max(1, TOP_PRODUCTS_LIMIT - index),
      source: 'FALLBACK',
    })),
  }));
};

// ─── Gemini/AI merge into categories ─────────────────────────────────

const mergeAIProductsIntoCategories = async (categories = []) => {
  const mergedCategories = [];

  for (const category of categories) {
    const dbProducts = category.products || [];
    const dbNames = new Set(dbProducts.map((p) => String(p.name).trim().toLowerCase()));
    const existingNames = dbProducts.map((p) => p.name);

    let suggestedProducts = [];
    try {
      // Phase 2: real Gemini call; Phase 1: falls back to static list
      suggestedProducts = await aiService.getGeminiCategoryProducts(category.name, existingNames);
    } catch (error) {
      log.warn({ warn: `AI merge failed for category "${category.name}"`, error: error.message });
      const fallback = aiService.getFallbackProducts([category.name]);
      suggestedProducts = fallback[category.name] || fallback[category.name?.replace(/\s+/g, '_')] || [];
    }

    const aiRankedProducts = suggestedProducts
      .map((name) => exactProductName(name))
      .filter(Boolean)
      .filter((name) => !dbNames.has(String(name).trim().toLowerCase()))
      .slice(0, TOP_PRODUCTS_LIMIT)
      .map((name, index) => ({
        name,
        count: Math.max(1, GEMINI_BASE_SCORE - index * 5),
        source: 'AI',
      }));

    const finalProducts = [...dbProducts, ...aiRankedProducts]
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
      .slice(0, TOP_PRODUCTS_LIMIT * 2); // Keep more before catalogue filtering

    mergedCategories.push({
      ...category,
      products: finalProducts,
    });
  }

  return mergedCategories;
};

// ─── Catalogue matching step ─────────────────────────────────────────

const applyCatalogueMatching = async (categories = []) => {
  // Collect ALL product names across all categories
  const allProductNames = [];
  categories.forEach((cat) => {
    (cat.products || []).forEach((p) => {
      allProductNames.push(p.name);
    });
  });

  // Match all at once against master catalogue
  const catalogueMap = await matchAgainstCatalogue(allProductNames);

  log.info({
    info: 'Catalogue matching complete',
    totalGenerated: allProductNames.length,
    totalMatched: catalogueMap.size,
  });

  // Filter each category's products
  return categories.map((category) => ({
    ...category,
    products: filterByCatalogue(category.products, catalogueMap).slice(0, TOP_PRODUCTS_LIMIT),
  }));
};

// ─── Category count mapper ───────────────────────────────────────────

const mapCountsToCategories = (categoryProductCounts) =>
  Object.entries(categoryProductCounts)
    .map(([name, products]) => ({
      name,
      products: Object.entries(products)
        .map(([productName, count]) => ({ name: productName, count, source: 'DB' }))
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
        .slice(0, TOP_PRODUCTS_LIMIT),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

// ─── Main builder ────────────────────────────────────────────────────

const buildPincodeCatalog = async (pincode) => {
  const normalizedPincode = String(pincode);

  log.info({ info: `Building geo catalog for pincode: ${normalizedPincode}` });

  let shops = [];
  try {
    shops = await shopGeoService.getShopsByPincode(normalizedPincode);
  } catch (error) {
    log.error({ error: `Shop lookup failed for pincode ${normalizedPincode}`, details: error.message });
    shops = [];
  }

  const shopIds = shops.map((shop) => Number(shop.shopId)).filter(Boolean);

  let categories = [];
  let usedFallback = false;
  let buildStatus = 'SUCCESS';

  if (shopIds.length) {
    try {
      const retailerProducts = await RetailerCatalog.find({
        shopId: { $in: shopIds },
        catalog: { $ne: null },
      })
        .lean()
        .exec();

      const productIds = retailerProducts
        .map((item) => item?.catalog?._id)
        .filter((id) => Types.ObjectId.isValid(id))
        .map((id) => new Types.ObjectId(id));

      const masterProducts = productIds.length
        ? await MongoProduct.find({ _id: { $in: productIds } })
            .select('_id catPnm prdNm')
            .lean()
            .exec()
        : [];

      const productMap = new Map(masterProducts.map((p) => [String(p._id), p]));
      const categoryProductCounts = {};

      retailerProducts.forEach((retailerDoc) => {
        const masterProduct = productMap.get(String(retailerDoc?.catalog?._id));
        const productName = exactProductName(retailerDoc?.catalog?.prdNm || masterProduct?.prdNm || '');
        const categoryName = getCategoryName(retailerDoc, masterProduct);

        if (!productName || !categoryName) return;

        categoryProductCounts[categoryName] = categoryProductCounts[categoryName] || {};
        categoryProductCounts[categoryName][productName] =
          (categoryProductCounts[categoryName][productName] || 0) + 1;
      });

      categories = mapCountsToCategories(categoryProductCounts);

      // Merge AI/Gemini suggestions
      categories = await mergeAIProductsIntoCategories(categories);

      // ★ CRITICAL: Match against master catalogue — only keep verified products
      categories = await applyCatalogueMatching(categories);

      const uniqueProducts = categories.reduce((count, cat) => count + cat.products.length, 0);
      if (categories.length < 2 || uniqueProducts < 5) {
        usedFallback = true;
        buildStatus = 'PARTIAL';
        const fallbackCategories = await buildFallbackCategories();
        // Also catalogue-match fallback products
        const matchedFallback = await applyCatalogueMatching(fallbackCategories);
        categories = [...categories, ...matchedFallback];
      }
    } catch (error) {
      log.error({ error: `Retailer aggregation failed for pincode ${normalizedPincode}`, details: error.message });
      usedFallback = true;
      buildStatus = 'FALLBACK';
      categories = await buildFallbackCategories();
      categories = await applyCatalogueMatching(categories);
    }
  } else {
    usedFallback = true;
    buildStatus = 'FALLBACK';
    categories = await buildFallbackCategories();
    categories = await applyCatalogueMatching(categories);
  }

  // Remove empty categories (no catalogue matches)
  categories = categories.filter((cat) => cat.products && cat.products.length > 0);

  const primaryLocation = shops[0] || {};

  const document = await GeoCatalog.findOneAndUpdate(
    { level: 'PINCODE', pincode: normalizedPincode },
    {
      $set: {
        level: 'PINCODE',
        pincode: normalizedPincode,
        city: primaryLocation.city || null,
        state: primaryLocation.state || null,
        country: primaryLocation.country || 'India',
        categories,
        lastBuildAt: new Date(),
        buildStatus,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  log.info({
    info: 'Geo pincode catalog built',
    pincode: normalizedPincode,
    categories: categories.length,
    totalProducts: categories.reduce((c, cat) => c + cat.products.length, 0),
    usedFallback,
    buildStatus,
  });

  return {
    success: true,
    usedFallback,
    buildStatus,
    shopCount: shopIds.length,
    categories: document.categories,
    document,
  };
};

module.exports = {
  buildPincodeCatalog,
};
```

---

### File 7: `backend/catalogue_mgmt_service/src/apis/services/v1/geoHierarchy.service.js`

**Action: CREATE new file**

What this code does:

- Phase 2 service for hierarchy rebuild and apply
- Rebuilds `CITY`, `STATE`, `COUNTRY` level catalogs by aggregating `PINCODE` documents
- Provides fallback resolution: `PINCODE → CITY → STATE → COUNTRY`
- `/geo/apply` — applies geo catalog products to a shop's `customcatalog`

```js
const { Logger: log } = require('sarvm-utility');

const GeoCatalog = require('../../models/mongoCatalog/geoCatalogSchema');
const CustomCatalog = require('../../models/mongoCatalog/customCatalogSchema');
const RetailerCatalog = require('../../models/mongoCatalog/retailerSchema');
const shopGeoService = require('./shopGeo.service');

const aggregateCategories = (documents = []) => {
  const categoryMap = new Map();

  documents.forEach((document) => {
    (document?.categories || []).forEach((category) => {
      const categoryName = String(category?.name || '').trim().toLowerCase();
      if (!categoryName) return;

      if (!categoryMap.has(categoryName)) {
        categoryMap.set(categoryName, new Map());
      }

      const productMap = categoryMap.get(categoryName);

      (category?.products || []).forEach((product) => {
        const productName = String(product?.name || '').trim().toLowerCase();
        if (!productName) return;

        productMap.set(productName, {
          count: (productMap.get(productName)?.count || 0) + Number(product?.count || 0),
          catalogueProductId: product.catalogueProductId || productMap.get(productName)?.catalogueProductId || null,
          source: product.source || 'DB',
        });
      });
    });
  });

  return Array.from(categoryMap.entries())
    .map(([name, productMap]) => ({
      name,
      products: Array.from(productMap.entries())
        .map(([productName, data]) => ({
          name: productName,
          count: data.count,
          catalogueProductId: data.catalogueProductId,
          source: data.source,
        }))
        .sort((l, r) => r.count - l.count || l.name.localeCompare(r.name))
        .slice(0, 10),
    }))
    .sort((l, r) => l.name.localeCompare(r.name));
};

const upsertGeoLevel = async (filter, payload) =>
  GeoCatalog.findOneAndUpdate(filter, { $set: payload }, { upsert: true, new: true, setDefaultsOnInsert: true });

const rebuildHierarchyCatalogs = async () => {
  const pincodeCatalogs = await GeoCatalog.find({ level: 'PINCODE' }).lean().exec();
  const shopLocations = await shopGeoService.getAllShopLocations();
  const locationByPincode = new Map();

  shopLocations.forEach((location) => {
    if (location?.pincode && !locationByPincode.has(String(location.pincode))) {
      locationByPincode.set(String(location.pincode), location);
    }
  });

  const cityGroups = new Map();
  const stateGroups = new Map();
  const countryGroups = new Map();

  pincodeCatalogs.forEach((catalog) => {
    const location = locationByPincode.get(String(catalog.pincode)) || catalog;

    if (location?.city) {
      const key = String(location.city).toLowerCase();
      cityGroups.set(key, [...(cityGroups.get(key) || []), catalog]);
    }
    if (location?.state) {
      const key = String(location.state).toLowerCase();
      stateGroups.set(key, [...(stateGroups.get(key) || []), catalog]);
    }
    if (location?.country) {
      const key = String(location.country).toLowerCase();
      countryGroups.set(key, [...(countryGroups.get(key) || []), catalog]);
    }
  });

  for (const [, documents] of cityGroups.entries()) {
    const source = locationByPincode.get(String(documents[0].pincode)) || documents[0];
    await upsertGeoLevel(
      { level: 'CITY', city: source.city },
      { level: 'CITY', city: source.city, state: source.state || null, country: source.country || 'India', categories: aggregateCategories(documents), lastBuildAt: new Date(), buildStatus: 'SUCCESS' },
    );
  }

  for (const [, documents] of stateGroups.entries()) {
    const source = locationByPincode.get(String(documents[0].pincode)) || documents[0];
    await upsertGeoLevel(
      { level: 'STATE', state: source.state },
      { level: 'STATE', state: source.state, country: source.country || 'India', categories: aggregateCategories(documents), lastBuildAt: new Date(), buildStatus: 'SUCCESS' },
    );
  }

  for (const [, documents] of countryGroups.entries()) {
    const source = locationByPincode.get(String(documents[0].pincode)) || documents[0];
    await upsertGeoLevel(
      { level: 'COUNTRY', country: source.country || 'India' },
      { level: 'COUNTRY', country: source.country || 'India', categories: aggregateCategories(documents), lastBuildAt: new Date(), buildStatus: 'SUCCESS' },
    );
  }

  log.info({
    info: 'Geo hierarchy rebuilt',
    pincodes: pincodeCatalogs.length,
    cities: cityGroups.size,
    states: stateGroups.size,
    countries: countryGroups.size,
  });
};

const getGeoCatalogWithFallback = async ({ pincode, city, state, country }) => {
  if (pincode) {
    const doc = await GeoCatalog.findOne({ level: 'PINCODE', pincode: String(pincode) }).sort({ updatedAt: -1 }).lean().exec();
    if (doc) return doc;
  }
  if (city) {
    const doc = await GeoCatalog.findOne({ level: 'CITY', city }).sort({ updatedAt: -1 }).lean().exec();
    if (doc) return doc;
  }
  if (state) {
    const doc = await GeoCatalog.findOne({ level: 'STATE', state }).sort({ updatedAt: -1 }).lean().exec();
    if (doc) return doc;
  }
  if (country) {
    return GeoCatalog.findOne({ level: 'COUNTRY', country }).sort({ updatedAt: -1 }).lean().exec();
  }
  return null;
};

const applyGeoCatalogToShop = async ({ shopId, pincode }) => {
  const numericShopId = Number(shopId);
  const location = (await shopGeoService.getShopLocation(numericShopId)) || {};
  const catalog = await getGeoCatalogWithFallback({
    pincode: pincode || location.pincode,
    city: location.city,
    state: location.state,
    country: location.country || 'India',
  });

  if (!catalog) {
    return { success: false, message: 'No geo catalog found for the supplied hierarchy' };
  }

  const retailerDoc = await RetailerCatalog.findOne({ shopId: numericShopId }).select('retailerId guid').lean().exec();
  const operations = [];

  catalog.categories.forEach((category) => {
    (category.products || []).forEach((product) => {
      operations.push({
        updateOne: {
          filter: {
            shopId: numericShopId,
            productId: `geo-${catalog.level}-${category.name}-${product.name}`,
          },
          update: {
            $set: {
              shopId: numericShopId,
              retailerId: retailerDoc?.retailerId || '',
              guid: retailerDoc?.guid || '',
              retailerName: 'Geo Catalog Auto Apply',
              productId: `geo-${catalog.level}-${category.name}-${product.name}`,
              productName: product.name,
              productNameStatus: 'UNVERIFIED',
              productDescriptionStatus: 'NEW',
              productImageStatus: 'NEW',
              description: `Auto-added from ${catalog.level} geo catalog`,
              category: category.name,
              subCategory: category.name,
              requestFlag: false,
              updateStatus: 'NEW',
            },
          },
          upsert: true,
        },
      });
    });
  });

  if (operations.length) {
    await CustomCatalog.bulkWrite(operations, { ordered: false });
  }

  return {
    success: true,
    level: catalog.level,
    categories: catalog.categories.length,
    insertedProducts: operations.length,
  };
};

module.exports = {
  rebuildHierarchyCatalogs,
  getGeoCatalogWithFallback,
  applyGeoCatalogToShop,
};
```

---

### File 8: `backend/catalogue_mgmt_service/src/apis/controllers/v1/geo.js`

**Action: CREATE new file**

What this code does:

- Exposes all geo service methods as HTTP endpoints
- Includes error handling that returns proper JSON error responses
- Includes manual cron trigger endpoint for testing

```js
const { Logger: log } = require('sarvm-utility');

const { buildPincodeCatalog } = require('../../services/v1/pincodeCatalogBuilder.service');
const {
  applyGeoCatalogToShop,
  getGeoCatalogWithFallback,
  rebuildHierarchyCatalogs,
} = require('../../services/v1/geoHierarchy.service');
const shopGeoService = require('../../services/v1/shopGeo.service');

// ─── Phase 1: Test pincode catalog ───────────────────────────────────

const testPincodeCatalog = async (req, res, next) => {
  try {
    const { pincode } = req.body;

    if (!pincode) {
      return res.status(400).json({ success: false, message: 'pincode is required in request body' });
    }

    const result = await buildPincodeCatalog(pincode);

    return res.status(200).json({
      success: true,
      pincode: String(pincode),
      buildStatus: result.buildStatus,
      usedFallback: result.usedFallback,
      shopCount: result.shopCount,
      categoryCount: result.categories.length,
      totalProducts: result.categories.reduce((c, cat) => c + (cat.products || []).length, 0),
      categories: result.categories,
    });
  } catch (error) {
    log.error({ error: 'Error in testPincodeCatalog', details: error.message, stack: error.stack });
    return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
};

// ─── Phase 1: Test shop catalog (resolves pincode from shopId) ───────

const testShopCatalog = async (req, res, next) => {
  try {
    const { shopId } = req.body;

    if (!shopId) {
      return res.status(400).json({ success: false, message: 'shopId is required in request body' });
    }

    const location = await shopGeoService.getShopLocation(Number(shopId));

    if (!location?.pincode) {
      return res.status(404).json({
        success: false,
        message: `Pincode not found for shopId ${shopId}. Shop may not have geo metadata.`,
      });
    }

    const result = await buildPincodeCatalog(location.pincode);

    return res.status(200).json({
      success: true,
      shopId: Number(shopId),
      pincode: location.pincode,
      city: location.city || null,
      state: location.state || null,
      buildStatus: result.buildStatus,
      usedFallback: result.usedFallback,
      shopCount: result.shopCount,
      categoryCount: result.categories.length,
      totalProducts: result.categories.reduce((c, cat) => c + (cat.products || []).length, 0),
      categories: result.categories,
    });
  } catch (error) {
    log.error({ error: 'Error in testShopCatalog', details: error.message, stack: error.stack });
    return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
};

// ─── Phase 2: Apply geo catalog to a shop ────────────────────────────

const applyGeoCatalog = async (req, res, next) => {
  try {
    const { shopId, pincode } = req.body;

    if (!shopId) {
      return res.status(400).json({ success: false, message: 'shopId is required in request body' });
    }

    const result = await applyGeoCatalogToShop({ shopId, pincode });
    return res.status(200).json(result);
  } catch (error) {
    log.error({ error: 'Error in applyGeoCatalog', details: error.message, stack: error.stack });
    return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
};

// ─── Phase 2: Get resolved geo catalog (with fallback) ───────────────

const getResolvedGeoCatalog = async (req, res, next) => {
  try {
    const { shopId, pincode } = req.query;
    const location = shopId ? await shopGeoService.getShopLocation(Number(shopId)) : null;
    const catalog = await getGeoCatalogWithFallback({
      pincode: pincode || location?.pincode,
      city: location?.city,
      state: location?.state,
      country: location?.country,
    });

    if (!catalog) {
      return res.status(404).json({ success: false, message: 'No geo catalog found for given parameters' });
    }

    return res.status(200).json({ success: true, catalog });
  } catch (error) {
    log.error({ error: 'Error in getResolvedGeoCatalog', details: error.message, stack: error.stack });
    return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
};

// ─── Phase 2: Manual cron trigger for testing ────────────────────────

const triggerCronManually = async (req, res, next) => {
  try {
    const { runGeoCatalogJobOnce } = require('../.././../jobs/geoCatalog.job');

    // Run asynchronously — respond immediately
    res.status(202).json({
      success: true,
      message: 'Geo catalog cron job triggered. Check server logs for progress.',
    });

    // Execute in background
    runGeoCatalogJobOnce()
      .then(() => log.info({ info: 'Manual cron trigger completed successfully' }))
      .catch((error) => log.error({ error: 'Manual cron trigger failed', details: error.message }));
  } catch (error) {
    log.error({ error: 'Error triggering cron', details: error.message });
    return res.status(500).json({ success: false, message: 'Internal server error', error: error.message });
  }
};

module.exports = {
  testPincodeCatalog,
  testShopCatalog,
  applyGeoCatalog,
  getResolvedGeoCatalog,
  triggerCronManually,
};
```

---

### File 9: `backend/catalogue_mgmt_service/src/apis/routes/v1/geo.js`

**Action: CREATE new file**

What this code does:

- Mounts all geo endpoints under `/geo`
- All routes use proper logging

Final URLs (base: `http://localhost:2210/cms/apis/v1`):

| Method | URL | Purpose | Phase |
|--------|-----|---------|-------|
| POST | `/geo/test/pincode` | Build catalog for one pincode | 1 |
| POST | `/geo/test/shop` | Build catalog by shopId | 1 |
| POST | `/geo/apply` | Apply geo catalog to shop | 2 |
| GET | `/geo/catalog` | Get catalog with fallback | 2 |
| POST | `/geo/cron/trigger` | Manually trigger cron job | 2 |

```js
const express = require('express');
const { Logger: log } = require('sarvm-utility');

const GeoController = require('../../controllers/v1/geo');

const router = express.Router();

// Phase 1 — test endpoints
router.post('/test/pincode', async (req, res, next) => {
  log.info({ info: 'Geo route :: test pincode catalog' });
  return GeoController.testPincodeCatalog(req, res, next);
});

router.post('/test/shop', async (req, res, next) => {
  log.info({ info: 'Geo route :: test shop catalog' });
  return GeoController.testShopCatalog(req, res, next);
});

// Phase 2 — production endpoints
router.post('/apply', async (req, res, next) => {
  log.info({ info: 'Geo route :: apply geo catalog' });
  return GeoController.applyGeoCatalog(req, res, next);
});

router.get('/catalog', async (req, res, next) => {
  log.info({ info: 'Geo route :: get resolved geo catalog' });
  return GeoController.getResolvedGeoCatalog(req, res, next);
});

// Phase 2 — manual cron trigger for testing
router.post('/cron/trigger', async (req, res, next) => {
  log.info({ info: 'Geo route :: manual cron trigger' });
  return GeoController.triggerCronManually(req, res, next);
});

module.exports = router;
```

---

### File 10: `backend/catalogue_mgmt_service/src/jobs/geoCatalog.job.js`

**Action: CREATE new file in new `jobs` directory**

What this code does:

- Runs full geo-catalog generation nightly at `2:00 AM IST`
- **Processes ONE pincode at a time** (sequential) to avoid overloading Gemini API rate limits
- Adds proper error handling per pincode — one failure does not stop the whole job
- Rebuilds hierarchy after all pincodes
- Includes delay between pincodes (configurable)

Cron schedule: `0 2 * * *` → minute 0, hour 2, every day

```js
const cron = require('node-cron');
const { Logger: log } = require('sarvm-utility');

const shopGeoService = require('../apis/services/v1/shopGeo.service');
const { buildPincodeCatalog } = require('../apis/services/v1/pincodeCatalogBuilder.service');
const { rebuildHierarchyCatalogs } = require('../apis/services/v1/geoHierarchy.service');

let isStarted = false;
let isRunning = false;

// Delay helper to avoid overloading APIs
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Configurable delay between pincode builds (ms)
const PINCODE_DELAY_MS = parseInt(process.env.GEO_CRON_PINCODE_DELAY_MS || '2000', 10);

/**
 * Run the full geo catalog job once.
 * Processes ONE pincode at a time (sequential, not parallel).
 * Each pincode may call Gemini API, so we space them out.
 */
const runGeoCatalogJobOnce = async () => {
  if (isRunning) {
    log.warn({ warn: 'Geo catalog job already running, skipping this invocation' });
    return;
  }

  isRunning = true;
  const startTime = Date.now();

  try {
    log.info({ info: 'Geo catalog job started' });

    const shopLocations = await shopGeoService.getAllShopLocations();
    const pincodes = [...new Set(shopLocations.map((shop) => shop?.pincode).filter(Boolean))];

    log.info({ info: `Geo catalog job: processing ${pincodes.length} pincodes sequentially` });

    let successCount = 0;
    let failCount = 0;

    // Process ONE pincode at a time
    for (let i = 0; i < pincodes.length; i++) {
      const pincode = pincodes[i];

      try {
        log.info({ info: `Geo catalog job: processing pincode ${pincode} (${i + 1}/${pincodes.length})` });
        await buildPincodeCatalog(pincode);
        successCount++;
      } catch (error) {
        failCount++;
        log.error({
          error: `Geo catalog job: failed for pincode ${pincode}`,
          details: error.message,
        });
        // Continue to next pincode — don't stop the whole job
      }

      // Delay between pincodes to avoid API rate limits
      if (i < pincodes.length - 1) {
        await delay(PINCODE_DELAY_MS);
      }
    }

    // Rebuild hierarchy after all pincodes are processed
    try {
      await rebuildHierarchyCatalogs();
      log.info({ info: 'Geo catalog job: hierarchy rebuild complete' });
    } catch (error) {
      log.error({ error: 'Geo catalog job: hierarchy rebuild failed', details: error.message });
    }

    const durationSeconds = Math.round((Date.now() - startTime) / 1000);

    log.info({
      info: 'Geo catalog job completed',
      pincodesProcessed: pincodes.length,
      successCount,
      failCount,
      durationSeconds,
    });
  } catch (error) {
    log.error({ error: 'Geo catalog job fatal error', details: error.message, stack: error.stack });
  } finally {
    isRunning = false;
  }
};

/**
 * Schedule the nightly cron job.
 * Runs at 2:00 AM IST every day.
 */
const startGeoCatalogJob = () => {
  if (isStarted) return;

  cron.schedule(
    '0 2 * * *',
    async () => {
      try {
        await runGeoCatalogJobOnce();
      } catch (error) {
        log.error({ error: 'Geo catalog cron failed', details: error.message });
      }
    },
    {
      scheduled: true,
      timezone: 'Asia/Kolkata',
    },
  );

  isStarted = true;
  log.info({ info: 'Geo catalog cron job scheduled at 2:00 AM IST' });
};

module.exports = {
  startGeoCatalogJob,
  runGeoCatalogJobOnce,
};
```

---

### File 11: `backend/catalogue_mgmt_service/src/apis/routes/v1/index.js`

**Action: EDIT existing file**

What to change: Add the geo router import and mount it.

Add this import near the top (after existing imports):

```js
const geoRouter = require('./geo');
```

Add this line in the router.use section:

```js
router.use('/geo', geoRouter);
```

Full updated file:

```js
const express = require('express');
const router = express.Router();

const categoryRouter = require('./category');
const productRouter = require('./product');
const publishRouter = require('./publish');
const catalogRoutere = require('./catalog');
const metaDataRoutere = require('./metaData/index');
const DataTree = require('./DataTree');
const requestMasterCatalog = require('./requestMasterCatalog');
const customCatalog = require('./customCatalog');
const geoRouter = require('./geo');

const retailerCatalogRouter = require('./retailerCatalog/index');
const bulkUpdateCatalog = require('./BulkUpdateProduct');

router.use('/customCatalog', customCatalog);
router.use('/geo', geoRouter);
router.use('/newProductReq', requestMasterCatalog);
router.use('/catalog', catalogRoutere);
router.use('/category', categoryRouter);
router.use('/product', productRouter);
router.use('/publish', publishRouter);
router.use('/metadata', metaDataRoutere);
router.use('/retailercatalog', retailerCatalogRouter);
router.use('/bulkupdate', bulkUpdateCatalog);
router.use('/dataTree', DataTree);

module.exports = router;
```

---

### File 12: `backend/catalogue_mgmt_service/src/InitApp/index.js`

**Action: EDIT existing file**

What to change: Add cron job startup after DB connections.

Add this import near the top:

```js
const { startGeoCatalogJob } = require('../jobs/geoCatalog.job');
```

Add this line after `Mongo.connect()`:

```js
startGeoCatalogJob();
```

Full updated file:

```js
const {
  Logger: log,
  ErrorHandler: { BaseError, INTERNAL_SERVER_ERROR, PAGE_NOT_FOUND_ERROR },
  ReqLogger,
  AuthManager,
} = require('sarvm-utility');
const express = require('express');
const cors = require('cors');
const IP = require('ip');
const cuid = require('cuid');
const _ = require('lodash');
const createNamespace = require('cls-hooked').createNamespace;
const config = require('../config');
const sessionName = config.session_name;
const session = createNamespace(sessionName);
const SqlDb = require('@db/SQL');
const { Mongo } = require('@db/index');
const consumer = require('../common/aws/index');
const { startGeoCatalogJob } = require('../jobs/geoCatalog.job');

const init = async (app) => {
  app.use(AuthManager.decodeAuthToken);
  app.use((req, res, next) => {
    session.run(() => {
      res.locals.sessionId = _.isUndefined(req.headers.sessionid) ? cuid() : req.headers.sessionid;

      try {
        res.locals.clientIp = _.isUndefined(req.headers.clientip)
          ? _.get(req, 'headers.x-forwarded-for', _.get(req, 'headers.X-Forwarded-For', IP.address()))
          : req.headers.clientip;
      } catch (err) {
        console.log(err);
      }

      session.set('sessionId', res.locals.sessionId);
      session.set('clientIp', res.locals.clientIp);
      next();
    });
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(
    express.urlencoded({
      limit: '1mb',
      extended: true,
    }),
  );
  app.use(cors());

  if (!config.isTest) {
    app.use(ReqLogger);
  }

  const dbConnection = new SqlDb();
  dbConnection.connect();
  Mongo.connect((err) => {
    if (err) return console.error(err);
  });

  // Start nightly geo catalog cron job
  startGeoCatalogJob();

  // consumer.start()
};

module.exports = init;
```

---

### File 13: `backend/catalogue_mgmt_service/src/apis/models/mongoCatalog/retailerSchema.js`

**Action: VERIFY existing file has `shopId` index**

The existing file should have `retailer_Catalog.index({ shopId: 1 })`. If not, add it. This makes pincode product queries fast.

---

### File 14: `backend/catalogue_mgmt_service/src/apis/models/mongoCatalog/customCatalogSchema.js`

**Action: VERIFY existing file has `UNVERIFIED` enum**

Ensure `productNameStatus` includes `'UNVERIFIED'` in its enum. This is needed for `/geo/apply`.

---

### File 15: `.lcl.env` additions for Phase 2

**Action: EDIT existing `.lcl.env`**

Add these lines at the bottom:

```env
# Gemini AI (Phase 2)
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-2.0-flash

# Geo Cron Configuration
GEO_CRON_PINCODE_DELAY_MS=2000
```

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    BUILD PINCODE CATALOG                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. getShopsByPincode(pincode)                                 │
│     └─> shopIds[]                                              │
│                                                                 │
│  2. RetailerCatalog.find({ shopId: { $in: shopIds } })         │
│     └─> retailerProducts[]                                     │
│                                                                 │
│  3. Group by category, count product name frequency             │
│     └─> { dairy: { "Amul Gold Milk": 120, ... }, ... }         │
│                                                                 │
│  4. For each category: getGeminiCategoryProducts()              │
│     ├─ Fresh category → generic names (Tomato, Paneer)         │
│     └─ Packaged category → brand names (Lays, Parle-G)        │
│                                                                 │
│  5. Merge DB products + AI products (hybrid ranked list)        │
│     └─> DB products score by real frequency                     │
│     └─> AI products score by synthetic declining score          │
│                                                                 │
│  ★ 6. matchAgainstCatalogue(allProductNames)                   │
│     └─> Query Postgres `product` table                         │
│     └─> Only keep products that exist in catalogue             │
│                                                                 │
│  7. Store in geo_catalogs (MongoDB)                             │
│                                                                 │
│  8. Return catalogue-matched products only                      │
│     └─> Frontend shows ONLY valid catalogue products           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Postman Testing Guide

### Prerequisites

1. MongoDB running locally on port `27017`
2. PostgreSQL running locally on port `5432` with database `cms`
3. Backend started: `cd backend/catalogue_mgmt_service && npm run lcl`

Expected base URL: `http://localhost:2210/cms/apis/v1`

### Authorization Header

All requests need the system token:

```
Authorization: Bearer <your_system_token_from_env>
```

---

### TEST 1: Health Check

**When to test:** First, to verify backend is running.

```
GET http://localhost:2210/cms/apis/healthcheck
```

Expected: `200 OK` with `ts`, `buildNumber`, `serviceName`.

---

### TEST 2: Build Catalog by Pincode (Phase 1 — Primary Test)

**When to test:** After health check passes and both DBs are connected.

```
POST http://localhost:2210/cms/apis/v1/geo/test/pincode
Content-Type: application/json

{
  "pincode": "560100"
}
```

**What to verify in response:**

| Field | Expected |
|-------|----------|
| `success` | `true` |
| `pincode` | `"560100"` |
| `buildStatus` | `"SUCCESS"`, `"PARTIAL"`, or `"FALLBACK"` |
| `categoryCount` | `>= 1` |
| `totalProducts` | `>= 1` |
| `categories[].products[].name` | Each name must exist in your Postgres `product` table |
| `categories[].products[].catalogueProductId` | Non-null if catalogue matched |
| `categories[].products[].source` | `"DB"`, `"AI"`, or `"FALLBACK"` |

**How to verify catalogue matching actually worked:**

Take any product name from the response, e.g., `"Amul Gold Milk 500ml"`.
Run this SQL in your Postgres `cms` database:

```sql
SELECT id, name FROM product WHERE LOWER(name) = LOWER('Amul Gold Milk 500ml') AND status = 'ACTIVE';
```

The product **must exist**. If a generated product does NOT exist in the master catalogue, it will NOT appear in the API response.

---

### TEST 3: Build Catalog by ShopId (Phase 1 — Alternate Test)

**When to test:** If you know a valid shopId in your system.

```
POST http://localhost:2210/cms/apis/v1/geo/test/shop
Content-Type: application/json

{
  "shopId": 1234
}
```

**What to verify:** Same as TEST 2, plus:

| Field | Expected |
|-------|----------|
| `shopId` | `1234` |
| `pincode` | Auto-resolved from shop metadata |
| `city` | Auto-resolved |
| `state` | Auto-resolved |

---

### TEST 4: Verify Mongo Document (After TEST 2 or 3)

**When to test:** After a successful build.

Open MongoDB shell or Compass:

```js
db.geo_catalogs.find({ level: "PINCODE", pincode: "560100" }).pretty()
```

**Verify:**

- `categories` array exists and is non-empty
- Each category has `products` array
- Each product has `name`, `count`, `source`, `catalogueProductId`
- `buildStatus` is `"SUCCESS"` or `"PARTIAL"`
- `lastBuildAt` is a recent timestamp

---

### TEST 5: Get Catalog with Fallback (Phase 2)

**When to test:** After pincode document exists.

```
GET http://localhost:2210/cms/apis/v1/geo/catalog?pincode=560100
```

Or by shopId:

```
GET http://localhost:2210/cms/apis/v1/geo/catalog?shopId=1234
```

**Verify:**

- Returns the matching document
- Falls back through PINCODE → CITY → STATE → COUNTRY

---

### TEST 6: Apply Geo Catalog to Shop (Phase 2)

**When to test:** After TEST 4 confirms a geo_catalogs document exists.

```
POST http://localhost:2210/cms/apis/v1/geo/apply
Content-Type: application/json

{
  "shopId": 1234,
  "pincode": "560100"
}
```

**Expected response:**

```json
{
  "success": true,
  "level": "PINCODE",
  "categories": 5,
  "insertedProducts": 32
}
```

**Verify in MongoDB:**

```js
db.customcatalogs.find({ shopId: 1234 }).pretty()
```

Check:
- Products inserted
- `productNameStatus` = `"UNVERIFIED"`
- `category` and `subCategory` filled

---

### TEST 7: Manual Cron Trigger (Phase 2)

**When to test:** After all above tests pass, to test the full cron flow.

```
POST http://localhost:2210/cms/apis/v1/geo/cron/trigger
Content-Type: application/json
```

**Expected response:**

```json
{
  "success": true,
  "message": "Geo catalog cron job triggered. Check server logs for progress."
}
```

**Important:** This returns `202 Accepted` immediately. The job runs in the background. Check server logs for:

```
Geo catalog job: processing pincode 560100 (1/N)
Geo catalog job: processing pincode 560101 (2/N)
...
Geo catalog job completed - pincodesProcessed: N, successCount: X, failCount: Y
Geo catalog job: hierarchy rebuild complete
```

**Verify hierarchy after job completes:**

```js
db.geo_catalogs.find({ level: "PINCODE" }).count()
db.geo_catalogs.find({ level: "CITY" }).count()
db.geo_catalogs.find({ level: "STATE" }).count()
db.geo_catalogs.find({ level: "COUNTRY" }).count()
```

---

## API Test Sequence Summary

Follow this exact order:

| Step | API | Purpose | Phase |
|------|-----|---------|-------|
| 1 | `GET /healthcheck` | Verify backend running | 1 |
| 2 | `POST /v1/geo/test/pincode` | Build catalog for `560100` | 1 |
| 3 | MongoDB check | Verify `geo_catalogs` document | 1 |
| 4 | SQL check | Verify returned products exist in catalogue | 1 |
| 5 | `POST /v1/geo/test/shop` | Build by shopId | 1 |
| 6 | `GET /v1/geo/catalog` | Fetch with fallback | 2 |
| 7 | `POST /v1/geo/apply` | Apply to shop | 2 |
| 8 | MongoDB check | Verify `customcatalogs` | 2 |
| 9 | `POST /v1/geo/cron/trigger` | Run full cron | 2 |
| 10 | MongoDB check | Verify hierarchy docs | 2 |

---

## Phase 2 Changes After Phase 1 Implementation

After Phase 1 is working and tested, make these changes for Phase 2:

### 1. Install Gemini SDK

```bash
cd backend/catalogue_mgmt_service
npm install @google/generative-ai
```

### 2. Add Gemini API Key to `.lcl.env`

```env
GEMINI_API_KEY=your_actual_gemini_api_key
GEMINI_MODEL=gemini-2.0-flash
```

### 3. Verify `ai.service.js` auto-switches

The `ai.service.js` file already has Phase 2 Gemini code. It checks:

```js
if (!geminiAvailable || !process.env.GEMINI_API_KEY) {
  // Use fallback (Phase 1 behavior)
}
```

Once the SDK is installed and the API key is set, it automatically switches to real Gemini calls. **No code changes needed.**

### 4. Enable the cron job

The cron is already initialized in `InitApp/index.js`. It runs at 2 AM IST. To test manually:

```
POST http://localhost:2210/cms/apis/v1/geo/cron/trigger
```

### 5. Configure delay between pincodes

In `.lcl.env`:

```env
GEO_CRON_PINCODE_DELAY_MS=2000
```

This adds 2-second delay between processing each pincode, preventing Gemini API rate limit issues.

---

## Frontend

**No frontend changes are needed.**

Because the backend already returns only catalogue-matched products, the frontend receives valid product data. The existing `geo-catalog-test` page and any future integration will work as-is.

If you still want the test page for manual validation:

- Route: `/geo-catalog-test`
- Already configured in `app-routing.module.ts`:

```ts
{
  path: 'geo-catalog-test',
  loadChildren: () => import('./pages/geo-catalog-test/geo-catalog-test.module').then(m => m.GeoCatalogTestPageModule)
}
```

---

## New Files Summary

| File | Action | Phase |
|------|--------|-------|
| `src/apis/utils/normalizeProduct.js` | Edit | 1 |
| `src/apis/models/mongoCatalog/geoCatalogSchema.js` | Edit | 1 |
| `src/apis/services/v1/catalogueMatcher.service.js` | **CREATE** | 1 |
| `src/apis/services/v1/ai.service.js` | Edit | 1+2 |
| `src/apis/services/v1/shopGeo.service.js` | Create | 1 |
| `src/apis/services/v1/pincodeCatalogBuilder.service.js` | Create | 1 |
| `src/apis/services/v1/geoHierarchy.service.js` | Create | 2 |
| `src/apis/controllers/v1/geo.js` | Create | 1+2 |
| `src/apis/routes/v1/geo.js` | Create | 1+2 |
| `src/apis/routes/v1/index.js` | Edit (add geo route) | 1 |
| `src/jobs/geoCatalog.job.js` | **CREATE** | 2 |
| `src/InitApp/index.js` | Edit (add cron startup) | 2 |
| `.lcl.env` | Edit (add Gemini + cron vars) | 2 |

---

## Error Handling Summary

| Layer | Error | Handling |
|-------|-------|----------|
| Shop lookup | Remote API timeout | Falls back to local MongoDB collections |
| Shop lookup | No shops found for pincode | Uses fallback categories |
| Retailer query | MongoDB query error | Logs error, uses fallback categories |
| Catalogue matching | Postgres query fails for chunk | Skips that chunk, continues with others |
| Catalogue matching | No matches found | Returns empty categories (valid response) |
| Gemini API | SDK not installed | Auto-falls back to static list |
| Gemini API | API key missing | Auto-falls back to static list |
| Gemini API | Rate limit / timeout | Falls back to static list for that category |
| Gemini API | Invalid JSON response | Falls back to static list for that category |
| Cron job | One pincode fails | Logs error, continues to next pincode |
| Cron job | Already running | Skips second invocation (guard flag) |
| Cron job | Hierarchy rebuild fails | Logs error, pincode data still saved |
| Controller | Any unhandled error | Returns `500` with JSON error message |
