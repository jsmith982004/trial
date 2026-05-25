# Geo-Intelligent Auto Catalog System — File Analysis

## File-By-File Implementation

### File 1: `backend/catalogue_mgmt_service/src/apis/utils/normalizeProduct.js`

**Why the code is there & What it is doing:**
- **Purpose:** Acts as the core string normalization utility.
- **Functionality:** Sanitizes raw product names to a standardized format before processing.
- **Transformations:** Converts text to lowercase, removes common punctuation/symbols (commas, parentheses, hyphens, brackets), and collapses multiple spaces into one.
- **Impact:** Ensures consistent string matching across different data sources (e.g., AI output vs. database), preventing redundant entries for similar inputs like "Amul Gold (500ml)" and "amul gold 500ml".

**The Full Code:**
```js
const normalize = (value = '') => {
  return String(value || '')
    .toLowerCase()
    .replace(/[,()\-_\[\]]+/g, ' ') // remove symbols like , ( ) - _ [ ]
    .replace(/\s+/g, ' ')           // collapse multiple spaces
    .trim();                        // remove leading/trailing spaces
};

module.exports = normalize;
```

---

### File 2: `backend/catalogue_mgmt_service/src/apis/models/mongoCatalog/geoCatalogSchema.js`

**Why the code is there & What it is doing:**
- **Purpose:** Defines the Mongoose schema for the `geo_catalogs` MongoDB collection.
- **Architecture:** Supports a multi-level geographic hierarchy mapping products to a specific `level` (`PINCODE`, `CITY`, `STATE`, or `COUNTRY`).
- **Product Segregation:** Organizes products inside categories into `trending` (sourced from actual shop inventory) and `popular` (AI-synthesized fallback items).
- **Optimization:** Includes sparse indexes on geographic combinations for fast retrieval and tracks `buildStatus` to manage cron job failures gracefully.

**The Full Code:**
```js
/**
 
 * =================================================================================
 * GEOGRAPHIC CATALOG SCHEMA (Mongoose)
 * =================================================================================
 * 
 * PURPOSE:
 * This schema defines the database structure for the pre-compiled Geographic Catalogs 
 * (`geo_catalogs` collection) stored in MongoDB.
 * 
 * CORE ARCHITECTURAL CONCEPTS:
 * 1. Multi-Level Geographic Hierarchy (`level`):
 *    Supports indexing and querying catalogs at various regional scopes ('PINCODE', 
 *    'CITY', 'STATE', 'COUNTRY') to power robust search fallbacks when direct local 
 *    data is unavailable.
 * 
 * 2. Smart Category Organization:
 *    Organizes products under specific business verticals (e.g. Grocery, Dairy) and 
 *    segments them into:
 *    - `trending`: Products sourced from active databases (DB) based on sales/frequency.
 *    - `popular`: Sourced via AI generation to auto-fill gap items and enrich inventory.
 * 
 * 3. High-Performance Indexing:
 *    Heavily indexed on sparse geographic combinations to support instantaneous B-Tree 
 *    lookups during retailer catalog initialization.
 * =================================================================================
 */

const mongoose = require('mongoose');

/* ---------------- PRODUCT SCHEMA ---------------- */

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
      enum: ['DB', 'AI'],
      default: 'DB',
    },
  },
  { _id: false }
);

/* ---------------- CATEGORY SCHEMA ---------------- */

const geoCatalogCategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },

    // 🔥 NEW STRUCTURE (IMPORTANT CHANGE)
    sections: {
      trending: {
        type: [geoCatalogProductSchema], // DB products
        default: [],
      },
      popular: {
        type: [geoCatalogProductSchema], // AI products
        default: [],
      },
    },
  },
  { _id: false }
);

/* ---------------- MAIN GEO SCHEMA ---------------- */

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

    // ✅ NEW FIELD (as you requested)
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
      enum: ['SUCCESS', 'PARTIAL', 'FAILED'],
      default: 'SUCCESS',
    },
  },
  { timestamps: true }
);

/* ---------------- INDEXES ---------------- */

// Efficient lookups by hierarchy level
geoCatalogSchema.index({ level: 1, pincode: 1 }, { sparse: true });
geoCatalogSchema.index({ level: 1, city: 1 }, { sparse: true });
geoCatalogSchema.index({ level: 1, state: 1 }, { sparse: true });
geoCatalogSchema.index({ level: 1, country: 1 }, { sparse: true });

/* ---------------- MODEL ---------------- */

const GeoCatalog = mongoose.model('geo_catalogs', geoCatalogSchema);

module.exports = GeoCatalog;
```

---

### File 3: `backend/catalogue_mgmt_service/src/apis/services/v1/catalogueMatcher.service.js`

**Why the code is there & What it is doing:**
**This file is necessary for manual triggering of cron job. To test uncomment this file.**

- **Purpose:** Maps loosely defined or generated product names to canonical master catalogue records.
- **Performance:** Deduplicates incoming product names and processes them in small chunks (e.g., 200 items) to prevent database timeouts or memory spikes.
- **Matching Logic:** Queries the MongoDB `product` collection using the exact `dumK` (dummyKey) field, targeting only `PUBLISHED` items.
- **Validation:** Filters out any generated products that fail to match an official product ID, ensuring unorderable items never reach the geo catalogs.

**The Full Code:**
```js
// const { Logger: log } = require('sarvm-utility');
// const MongoProduct = require('../../models/mongoCatalog/productSchema');

// /**
//  * Normalize product name → same logic as dumK
//  */
// const normalizeKey = (name = '') =>
//   String(name)
//     .trim()
//     .toLowerCase()
//     .replace(/\s+/g, '_');

// /**
//  * Match product names against MongoDB `product` collection.
//  * Uses dumK (dummyKey) for fast exact matching.
//  *
//  * @param {string[]} productNames
//  * @returns {Promise<Map<string, { id: string, name: string, dummyKey: string, image: string }>>}
//  */
// const matchAgainstCatalogue = async (productNames = []) => {
//   if (!productNames.length) return new Map();

//   const matchedMap = new Map();

//   try {
//     // Normalize + dedupe
//     const uniqueNames = [
//       ...new Set(
//         productNames.map((n) => normalizeKey(n)).filter(Boolean)
//       ),
//     ];

//     const CHUNK_SIZE = 200;

//     for (let i = 0; i < uniqueNames.length; i += CHUNK_SIZE) {
//       const chunk = uniqueNames.slice(i, i + CHUNK_SIZE);

//       try {
//         // 🔥 Match using dumK (fast indexed lookup)
//         const results = await MongoProduct.find({
//           dumK: { $in: chunk },
//           status: 'PUBLISHED',
//         })
//           .select('_id prdNm dumK media.img1')
//           .lean();

//         results.forEach((product) => {
//           const key = product.dumK;

//           if (!matchedMap.has(key)) {
//             matchedMap.set(key, {
//               id: String(product._id),
//               name: product.prdNm,
//               dummyKey: product.dumK,
//               image: product?.media?.img1 || null,
//             });
//           }
//         });
//       } catch (chunkError) {
//         log.warn({
//           warn: 'CatalogueMatcher(Mongo): chunk query failed',
//           error: chunkError.message,
//           chunkSize: chunk.length,
//         });
//       }
//     }

//     log.info({
//       info: 'CatalogueMatcher(Mongo): matching complete',
//       inputCount: uniqueNames.length,
//       matchedCount: matchedMap.size,
//     });
//   } catch (error) {
//     log.error({
//       error: 'CatalogueMatcher(Mongo): matching failed',
//       details: error.message,
//     });
//   }

//   return matchedMap;
// };

// /**
//  * Filter products to only catalogue-matched ones
//  */
// const filterByCatalogue = (products = [], catalogueMap) => {
//   return products
//     .map((product) => {
//       const key = normalizeKey(product.name);
//       const matched = catalogueMap.get(key);

//       if (!matched) return null;

//       return {
//         ...product,
//         name: matched.name, // use canonical name
//         catalogueProductId: matched.id,
//         dummyKey: matched.dummyKey,
//         image: matched.image,
//       };
//     })
//     .filter(Boolean);
// };

// module.exports = {
//   matchAgainstCatalogue,
//   filterByCatalogue,
// };
```

---

### File 4: `backend/catalogue_mgmt_service/src/apis/services/v1/ai.service.js`

**Why the code is there & What it is doing:**
- **Purpose:** Integrates with the Google Generative AI (Gemini) SDK to provide intelligent catalog fallbacks.
- **Prompt Engineering:** Categorizes inputs as "fresh" (e.g., vegetables) or "packaged" (e.g., snacks) to dynamically construct tailored AI prompts.
- **Formatting:** Enforces strict JSON array outputs of exactly 10 items without conversational text.
- **Reliability:** Features an automated retry loop for insufficient results and comprehensive error classification (`classifyGeminiError`) for tracking API limits, key issues, and timeouts.

**The Full Code:**
```js
const { Logger: log } = require('sarvm-utility');

/* ---------------- CONFIG ---------------- */

const MIN_ITEMS = 10;
const MAX_ITEMS = 10;

/* ---------------- CATEGORY CONFIG ---------------- */

const FRESH_CATEGORIES = new Set([
  'dairy',
  'vegetables',
  'fruits',
  'meat',
  'fish',
  'flowers',
  'restaurant',
  'home_food',
]);

const normalizeCategory = (str = '') =>
  String(str)
    .toLowerCase()
    .replace(/\s+/g, '_')
    .trim();

const isFreshCategory = (categoryName) =>
  FRESH_CATEGORIES.has(normalizeCategory(categoryName));

/* ---------------- GEMINI SETUP ---------------- */

let geminiAvailable = false;
let GoogleGenerativeAI = null;

try {
  const genai = require('@google/generative-ai');
  GoogleGenerativeAI = genai.GoogleGenerativeAI;
  geminiAvailable = true;
} catch (e) {
  geminiAvailable = false;
}

/* ---------------- PROMPT BUILDER ---------------- */

const buildPrompt = (categoryName, existingProducts = []) => {
  const isFresh = isFreshCategory(categoryName);
  const existing = existingProducts.slice(0, 10).join(', ');

  if (isFresh) {
    return `
Generate EXACTLY 10 common ${categoryName} products.

STRICT RULES:
- Must return EXACTLY 10 items
- Generic names only (no brands)
- No explanation
- Only JSON array

${existing ? `Avoid these: ${existing}` : ''}

Return ONLY JSON array.
`;
  }

  return `
Generate EXACTLY 10 realistic ${categoryName} products used in Indian stores.

STRICT RULES:
- Must return EXACTLY 10 items
- Include brand + size
- No explanation
- Only JSON array

Example:
["Amul Gold Milk 500ml", "Lays Classic Salted 52g"]

${existing ? `Avoid these: ${existing}` : ''}

Return ONLY JSON array.
`;
};

/* ---------------- RESPONSE PARSER ---------------- */

const parseAIResponse = (text, categoryName) => {
  const match = text.match(/\[[\s\S]*?\]/);

  if (!match) {
    throw new Error('Invalid JSON from Gemini');
  }

  const parsed = JSON.parse(match[0]);

  if (!Array.isArray(parsed)) {
    throw new Error('Gemini output not array');
  }

  let cleaned = parsed
    .map((item) => {
      if (typeof item === 'string') return item.trim();

      if (typeof item === 'object' && item !== null) {
        return (
          item.name ||
          item.product ||
          item.title ||
          null
        );
      }

      return null;
    })
    .filter((x) => typeof x === 'string' && x.length > 0);

  return cleaned;
};

/* ---------------- ERROR CLASSIFIER ---------------- */

const classifyGeminiError = (error) => {
  const msg = (error.message || '').toLowerCase();
  const status = error.status || error.code || '';

  // API Key issues
  if (msg.includes('api_key') || msg.includes('api key') || msg.includes('authentication') || String(status) === '401') {
    return 'INVALID_API_KEY — Check your GEMINI_API_KEY in .env file';
  }

  // Rate limit
  if (msg.includes('quota') || msg.includes('rate') || msg.includes('429') || msg.includes('exhausted')) {
    return 'RATE_LIMIT — Too many requests, Gemini is throttling. Add delay or wait';
  }

  // Model not found
  if (msg.includes('not found') || msg.includes('model') && msg.includes('404') || String(status) === '404') {
    return `MODEL_NOT_FOUND — Model "${process.env.GEMINI_MODEL || 'gemini-1.5-flash'}" not available on Gemini`;
  }

  // Network errors
  if (msg.includes('econnrefused') || msg.includes('etimedout') || msg.includes('enotfound') || msg.includes('network') || msg.includes('fetch failed')) {
    return 'NETWORK_ERROR — Cannot reach Gemini API. Check internet connection';
  }

  // Timeout
  if (msg.includes('timeout') || msg.includes('deadline')) {
    return 'TIMEOUT — Gemini API took too long to respond';
  }

  // Safety / content filter
  if (msg.includes('safety') || msg.includes('blocked') || msg.includes('content_filter') || msg.includes('moderation') || msg.includes('finishreason')) {
    return 'CONTENT_BLOCKED — Gemini blocked the response due to content filters';
  }

  // JSON parse errors (from parseAIResponse)
  if (msg.includes('invalid json') || msg.includes('unexpected token') || msg.includes('not array')) {
    return 'BAD_RESPONSE — Gemini returned invalid/unparseable response';
  }

  // SDK not available
  if (msg.includes('sdk not available')) {
    return 'SDK_MISSING — @google/generative-ai package not installed.';
  }

  // API key missing
  if (msg.includes('gemini_api_key missing')) {
    return 'KEY_MISSING — GEMINI_API_KEY not set in your .env file';
  }

  // Permission denied
  if (msg.includes('permission') || msg.includes('forbidden') || String(status) === '403') {
    return 'PERMISSION_DENIED — API key does not have access to this model';
  }

  // Server errors
  if (String(status).startsWith('5') || msg.includes('internal server error') || msg.includes('service unavailable')) {
    return 'SERVER_ERROR — Gemini server is temporarily unavailable. Retry later';
  }

  // Fallback
  return `UNKNOWN_ERROR — ${error.message}`;
};

/* ---------------- GEMINI CALL ---------------- */

const callGemini = async (genAI, prompt, categoryName) => {
  const modelName = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
  
  const model = genAI.getGenerativeModel({ model: modelName });

  const result = await model.generateContent(prompt);
  const response = await result.response;
  const text = response.text();

  if (!text.trim()) {
    throw new Error('Empty response from Gemini');
  }

  return parseAIResponse(text, categoryName);
};

/* ---------------- MAIN FUNCTION ---------------- */

const getCategoryProducts = async (categoryName, existingProducts = []) => {
  if (!geminiAvailable) {
    throw new Error('Gemini SDK not available');
  }

  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY missing');
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  const prompt = buildPrompt(categoryName, existingProducts);

  try {
    /* -------- FIRST ATTEMPT -------- */

    let cleaned = await callGemini(genAI, prompt, categoryName);

    /* -------- RETRY IF TOO FEW -------- */

    if (cleaned.length < MIN_ITEMS) {
      const retryCleaned = await callGemini(genAI, prompt, categoryName);

      // merge unique values
      cleaned = [...new Set([...cleaned, ...retryCleaned])];
    }

    return cleaned.slice(0, MAX_ITEMS);
  } catch (error) {
    const reason = classifyGeminiError(error);

    // Don't log per-category here — let the caller handle pincode-level logging
    throw new Error(reason);
  }
};

/* ---------------- EXPORTS ---------------- */

module.exports = {
  getCategoryProducts,
  isFreshCategory,
};
```

---

### File 5: `backend/catalogue_mgmt_service/src/apis/services/v1/shopGeo.service.js`

**Why the code is there & What it is doing:**
- **Purpose:** Retrieves geographic location data (`pincode`, `city`, `state`) directly from PostgreSQL via Knex.
- **Optimization:** Replaces slow HTTP requests to external S3 profile JSONs with efficient raw SQL joins across the `shop` and `store_meta_data` tables.
- **Role:** Serves as the foundational data source dictating which active regions the overnight geo-catalog cron job needs to process.

**The Full Code:**
```js
/**
 * =================================================================================
 * SHOP GEOGRAPHIC LOCATION SERVICE
 * =================================================================================
 * 
 * PURPOSE:
 * This service handles retrieving geographic details (pincode, city, state) of 
 * verified retailers/shops across the SARVM ecosystem.
 * 
 * CORE RESPONSIBILITIES:
 * 1. Fetching all verified shops directly from PostgreSQL using Knex.
 * 2. Mapping shops to their respective geographic properties (pincodes, cities, states).
 * 3. Assisting background cron jobs (e.g., Geo-Catalog generation) and route-level controllers 
 *    in resolving regional catalogs on-demand.
 * 
 * HISTORICAL NOTE (OPTIMIZATION):
 * - Previously, the state was resolved by making individual HTTP GET requests via Axios 
 *   to S3-hosted JSON profile files (new_shops/<guid>/profile.json) for every single shop.
 * - This has been optimized to directly query `s.state` from PostgreSQL's shop table,
 *   reducing network latency, avoiding API limits, and substantially improving the speed 
 *   of geo catalog calculations.
 * =================================================================================
 */

// const axios = require('axios'); // Unused after moving state to DB
const { Logger: log } = require('sarvm-utility');

const RetailerCatalog = require('../../models/mongoCatalog/retailerSchema');
const db = require('../../db/knex/knex');

/* ---------------- CACHE ---------------- */

// shopId → { pincode, city, state }
// const locationCache = new Map(); // Unused after moving state to DB

/* ---------------- HELPERS ---------------- */

// --- COMMENTED OUT: Early logic to fetch JSON files from S3 ---
//
// /**
//  * Extract location safely from response
//  */
// const extractLocation = (data = {}) => {
//   // ✅ BEST SOURCE (vendor)
//   const vendor = data?.vendor || {};
// 
//   let pincode =
//     vendor?.pincode ||
//     data?.shop?.location?.pincode ||
//     data?.pincode ||
//     null;
// 
//   let city =
//     vendor?.city ||
//     null;
// 
//   let state =
//     vendor?.state ||
//     null;
// 
//   // -------- FALLBACK FROM ADDRESS --------
// 
//   if ((!city || !state) && data?.shop?.location?.address) {
//     const address = String(data.shop.location.address);
// 
//     const parts = address.split(',').map((p) => p.trim());
// 
//     if (!city && parts.length >= 2) {
//       city = parts[parts.length - 2]; // second last
//     }
// 
//     if (!state && parts.length >= 1) {
//       state = parts[parts.length - 1]; // last
//     }
//   }
// 
//   return {
//     pincode: pincode ? String(pincode) : null,
//     city: city || null,
//     state: state || null,
//   };
// };
// 
// /**
//  * Fetch location from URL (with caching)
//  */
// const fetchLocationFromURL = async (shopId, url) => {
//   if (!url) return null;
// 
//   // ✅ CACHE HIT
//   if (locationCache.has(shopId)) {
//     return locationCache.get(shopId);
//   }
// 
//   try {
//     const response = await axios.get(url, {
//       timeout: 5000,
//     });
// 
//     const data = response?.data || {};
// 
//     const location = extractLocation(data);
// 
//     // Cache the extracted location (even if partial)
//     locationCache.set(shopId, location);
// 
//     return location;
//   } catch (error) {
//     // Only log if it's the very first time we see this error
//     log.warn({
//       warn: 'Failed to fetch shop profile (caching failure to prevent retry)',
//       shopId,
//       url,
//       error: error.message,
//     });
// 
//     // Cache the failure so it doesn't repeatedly call the broken URL
//     locationCache.set(shopId, { pincode: null, city: null, state: null });
// 
//     return null;
//   }
// };

/* ---------------- CORE FUNCTIONS ---------------- */

/**
 * Get all unique shops
 */
const getAllShops = async () => {
  try {
    const result = await db.raw(`
      SELECT 
        s.shop_id as "shopId",
        s.pincode,
        s.city,
        s.state,
        smd.url
      FROM shop s
      LEFT JOIN store_meta_data smd ON s.shop_id = smd.shop_id
      WHERE s.shop_status != 'unverified'
    `);

    return result?.rows || [];
  } catch (error) {
    log.error({
      error: '[GEO] Failed to fetch shops from PostgreSQL',
      details: error.message,
    });
    return [];
  }
};

/**
 * Get all shop locations (ENRICHED)
 */
const getAllShopLocations = async () => {
  const shops = await getAllShops();

  const results = [];
  let fetchErrors = 0;

  for (const shop of shops) {
    try {
      let state = shop.state || null;

      // Fallback: If state is not present in Postgres, fetch from S3 profile JSON
      // COMMENTED OUT: We now rely purely on PostgreSQL.
      /*
      if (!state) {
        if (locationCache.has(shop.shopId)) {
          state = locationCache.get(shop.shopId).state;
        } else {
          const location = await fetchLocationFromURL(
            shop.shopId,
            shop.url
          );
          state = location?.state || null;
        }
      }
      */

      if (shop.pincode) {
        results.push({
          shopId: Number(shop.shopId),
          pincode: String(shop.pincode),
          city: shop.city || null,
          state: state,
        });
      }
    } catch (error) {
      fetchErrors++;
      log.warn({
        warn: `[GEO] Failed location for shopId ${shop.shopId}`,
        error: error.message,
      });
    }
  }

  if (fetchErrors > 0) {
    log.warn({
      warn: `[GEO] ${fetchErrors} shops failed location fetch`,
    });
  }

  return results;
};

/**
 * Get shops by pincode (ENRICHED)
 */
const getShopsByPincode = async (targetPincode) => {
  const normalized = String(targetPincode);

  const allShops = await getAllShopLocations();

  return allShops.filter(
    (shop) => String(shop.pincode) === normalized
  );
};

/**
 * Get single shop location
 */
const getShopLocation = async (shopId) => {
  const numericShopId = Number(shopId);

  const shops = await getAllShops();

  const shop = shops.find(
    (s) => Number(s.shopId) === numericShopId
  );

  if (!shop) return null;

  let state = shop.state || null;

  // Fallback: If state is not present in Postgres, fetch from S3 profile JSON
  // COMMENTED OUT: We now rely purely on PostgreSQL.
  /*
  if (!state) {
    if (locationCache.has(shop.shopId)) {
      state = locationCache.get(shop.shopId).state;
    } else {
      const location = await fetchLocationFromURL(
        shop.shopId,
        shop.url
      );
      state = location?.state || null;
    }
  }
  */

  return {
    shopId: Number(shop.shopId),
    pincode: shop.pincode ? String(shop.pincode) : null,
    city: shop.city || null,
    state: state,
  };
};

/* ---------------- EXPORTS ---------------- */

module.exports = {
  getAllShops,
  getAllShopLocations,
  getShopsByPincode,
  getShopLocation,
};
```

---

### File 6: `backend/catalogue_mgmt_service/src/apis/services/v1/pincodeCatalogBuilder.service.js`

**Why the code is there & What it is doing:**
- **Purpose:** Acts as the primary engine for building regional catalogs.
- **Data Aggregation:** Scans all shops in a target pincode to compute a frequency map of actual locally demanded products (the "trending" section).
- **AI Fallback:** Invokes `ai.service.js` for categories lacking sufficient real-world data to generate "popular" fallback products.
- **Pipeline:** Validates all aggregated items through `catalogueMatcher` and upserts the finalized, segregated documents directly into MongoDB.

**The Full Code:**
```js
/**
 * =================================================================================
 * GEOGRAPHIC PINCODE CATALOG COMPILER SERVICE
 * =================================================================================
 * 
 * CORE PURPOSE:
 * This service is the core compiler engine for regional catalogs. It gathers local 
 * retailer inventory data for a specific pincode, determines which products are 
 * high-demand (trending), utilizes AI models (Gemini) to recommend general popular items 
 * to fill category gaps, and writes the finalized catalog cache to MongoDB.
 * 
 * SYSTEM INTERACTION & CRON JOB ROLE:
 * - This builder is the core engine triggered by the nightly automated cron job 
 *   (`geoCatalog.job.js`).
 * - The cron job loops through all active pincodes on the platform and calls 
 *   `buildPincodeCatalog(pincode)` to dynamically recalculate regional demand.
 * 
 * DATA SOURCES:
 * 1. MongoDB `Catalog`: Fetches official product categories.
 * 2. PostgreSQL `shop`: Resolves shops located in the target pincode via `shopGeoService`.
 * 3. MongoDB `mongoRetailerCatalog`: Gathers listed products across all local shops.
 * 4. Gemini LLM API: Fills catalog gaps with popular category-specific recommendations.
 * =================================================================================
 */

const { Logger: log } = require('sarvm-utility');

const RetailerCatalog = require('../../models/mongoCatalog/retailerSchema');
const GeoCatalog = require('../../models/mongoCatalog/geoCatalogSchema');
const Catalog = require('../../models/mongoCatalog/catalogSchema');
const Product = require('../../models/mongoCatalog/productSchema');

const exactProductName = require('../../utils/normalizeProduct');

const aiService = require('./ai.service');
const shopGeoService = require('./shopGeo.service');
const ReqMasterProductService = require('./mongoCatalog/requestMasterCatalog');

/* ---------------- CONFIGURATION CONSTANTS ---------------- */

const DB_LIMIT = 10; // Maximum number of high-demand trending products to capture from local shops
const AI_LIMIT = 10; // Maximum number of AI popular products to generate per category

// Helper function to normalize category keys to lowercase with underscores
const normalizeCategory = (str = '') =>
  String(str)
    .toLowerCase()
    .replace(/\s+/g, '_')
    .trim();

// Helper function to normalize product names for duplicate check (strips spaces and special symbols)
const normalizeName = (str = '') =>
  String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const TEST_NAME_PATTERN = /^test/i; // Regular expression to exclude test categories

/* ---------------- MASTER CATEGORY FETCH ---------------- */

/**
 * Fetches all official categories registered in the database,
 * filtering out any developer testing categories.
 */
const getMasterCategories = async () => {
  // Query all active catalog structures
  const allCategories = await Catalog.find()
    .select('name dummyKey')
    .lean();

  // Return standard categories with unique keys
  return allCategories
    .filter((cat) => cat.name && cat.dummyKey && !TEST_NAME_PATTERN.test(cat.name))
    .map((cat) => ({
      name: cat.name,
      key: cat.dummyKey,
    }));
};

/* ---------------- CATEGORY FROM RETAILER ---------------- */

/**
 * Extracts and normalizes the main category key from a retailer product document.
 */
const getCategoryKeyFromDoc = (doc) => {
  const raw = doc?.category || doc?.catalog?.catPnm || '';
  return normalizeCategory(String(raw).split('/')[0]);
};

/* ---------------- BUILD CATEGORY MAP ---------------- */

/**
 * Aggregates all retailer products by their respective categories.
 * Counts product frequencies across the pincode to measure local consumer demand.
 */
const buildRetailerCategoryMap = (retailerDocs = []) => {
  const categoryMap = new Map();

  // Step A: Count how many times each product appears across local shops
  retailerDocs.forEach((doc) => {
    const name = exactProductName(doc?.catalog?.prdNm || '');
    const categoryKey = getCategoryKeyFromDoc(doc);

    if (!name || !categoryKey) return;

    if (!categoryMap.has(categoryKey)) {
      categoryMap.set(categoryKey, {});
    }

    const productMap = categoryMap.get(categoryKey);
    productMap[name] = (productMap[name] || 0) + 1;
  });

  const finalMap = new Map();

  // Step B: Sort products in each category so the highest-frequency (most popular) items are first
  for (const [category, products] of categoryMap.entries()) {
    const sorted = Object.entries(products)
      .map(([name, count]) => ({
        name,
        count,
        source: 'DB',
      }))
      .sort((a, b) => b.count - a.count);

    finalMap.set(category, sorted);
  }

  return finalMap;
};

/* ---------------- MAIN COMPILER FUNCTION ---------------- */

/**
 * Main builder service that compiles local trending products,
 * fills product gaps using AI, and caches the result under the given pincode.
 */
const buildPincodeCatalog = async (pincode) => {
  const normalizedPincode = String(pincode);
  const buildStartTime = Date.now();

  /* -------- STEP 1: FETCH OFFICIAL SYSTEM CATEGORIES -------- */
  const masterCategories = await getMasterCategories();
  log.info({ info: `[BUILDER] Pincode ${normalizedPincode} — Step 1: Fetched ${masterCategories.length} master categories` });

  /* -------- STEP 2: FIND ALL ACTIVE SHOPS IN THIS PINCODE -------- */
  const shops = await shopGeoService.getShopsByPincode(normalizedPincode);

  // Extract location details (city, state, country) from the first active shop
  const city = shops[0]?.city || null;
  const state = shops[0]?.state || null;
  const country = shops[0]?.country || null;

  const shopIds = shops.map((s) => Number(s.shopId)).filter(Boolean);

  log.info({
    info: `[CRON] Pincode ${normalizedPincode} — ${shopIds.length} shops found`,
  });

  let retailerCategoryMap = new Map();

  /* -------- STEP 3: RETRIEVE ALL ACTIVE PRODUCT LISTINGS FOR THESE SHOPS -------- */
  if (shopIds.length) {
    const retailerDocs = await RetailerCatalog.find({
      shopId: { $in: shopIds },
      catalog: { $ne: null },
    }).lean();

    log.info({ info: `[BUILDER] Pincode ${normalizedPincode} — Step 3: Found ${retailerDocs.length} retailer product docs` });

    // Group and sort these items to identify what is locally in high demand
    retailerCategoryMap = buildRetailerCategoryMap(retailerDocs);
  } else {
    log.info({ info: `[BUILDER] Pincode ${normalizedPincode} — Step 3: No shops, skipping retailer fetch` });
  }

  /* -------- STEP 4: ASSEMBLE POPULAR & TRENDING LISTS PER CATEGORY -------- */
  const finalCategories = [];
  let aiSuccessCount = 0;
  let aiFailCount = 0;

  for (const category of masterCategories) {
    const categoryKey = category.key;
    const categoryName = category.name;

    const dbProducts = retailerCategoryMap.get(categoryKey) || [];

    const trending = [];
    const popular = [];

    const usedNames = new Set(); // Prevent duplicates

    /* -------- DB → TRENDING (Capture local shop demand) -------- */
    for (const p of dbProducts) {
      const clean = exactProductName(p.name);
      const norm = normalizeName(clean);

      if (!usedNames.has(norm)) {
        trending.push({
          name: clean,
          count: p.count,
          source: 'DB',
        });

        usedNames.add(norm);
      }

      if (trending.length >= DB_LIMIT) break;
    }

    /* -------- AI GENERATION (Fill catalog gaps) -------- */
    let aiProducts = [];

    try {
      // Prompt Gemini LLM to suggest common household products for this category that aren't already sold locally
      aiProducts = await aiService.getCategoryProducts(
        categoryKey,
        dbProducts.map((p) => p.name)
      );
      aiSuccessCount++;
    } catch (err) {
      aiFailCount++;
      log.warn({
        warn: `[BUILDER] Pincode ${normalizedPincode} — AI failed for category "${categoryName}": ${err.message}`,
      });
      aiProducts = [];
    }

    /* -------- AI → POPULAR (Append recommended popular products) -------- */
    for (const name of aiProducts) {
      const clean = exactProductName(name);
      const norm = normalizeName(clean);

      if (usedNames.has(norm)) continue;

      popular.push({
        name: clean,
        count: 0,
        source: 'AI',
      });

      usedNames.add(norm);

      if (popular.length >= AI_LIMIT) break;
    }

    /* -------- ATTACH SECTIONS TO CATEGORY -------- */
    finalCategories.push({
      name: categoryName,
      sections: {
        trending,
        popular,
      },
    });
  }

  log.info({ info: `[BUILDER] Pincode ${normalizedPincode} — Step 4: AI success: ${aiSuccessCount}, AI failed: ${aiFailCount}` });

  /* -------- STEP 5: SAVE/UPSERT REGIONAL CATALOG DIRECTLY IN MONGO -------- */
  const document = await GeoCatalog.findOneAndUpdate(
    { level: 'PINCODE', pincode: normalizedPincode },
    {
      $set: {
        level: 'PINCODE',
        pincode: normalizedPincode,
        city,
        state,
        country,
        categories: finalCategories,
        lastBuildAt: new Date(),
        buildStatus: 'SUCCESS',
      },
    },
    { upsert: true, new: true }
  );

  const totalElapsed = Date.now() - buildStartTime;
  log.info({ info: `[BUILDER] Pincode ${normalizedPincode} — Step 5: Saved to MongoDB (updatedAt: ${document.updatedAt}) — total: ${totalElapsed}ms` });

  return {
    success: true,
    categories: document.categories,
  };
};

/* ================================================================================ */
/*         PROGRESSIVE GEOGRAPHIC AGGREGATION (CITY → STATE → COUNTRY)              */
/* ================================================================================ */

/* ---------------- SHARED AGGREGATION HELPER ---------------- */

/**
 * Aggregates trending products from an array of lower-level GeoCatalog documents.
 * Merges products by normalized name, sums their counts, sorts by count descending,
 * and limits to DB_LIMIT per category.
 *
 * @param {Array} geoDocs - Array of GeoCatalog Mongoose lean documents
 * @returns {Map<string, Array>} categoryName -> sorted trending product array
 */
const aggregateFromGeoDocs = (geoDocs = []) => {
  // categoryName -> Map<normalizedProductName, { name, count }>
  const categoryAggMap = new Map();

  for (const doc of geoDocs) {
    if (!doc?.categories) continue;

    for (const category of doc.categories) {
      const catName = category.name;
      if (!catName) continue;

      if (!categoryAggMap.has(catName)) {
        categoryAggMap.set(catName, new Map());
      }

      const productMap = categoryAggMap.get(catName);

      // Merge trending products — sum counts across regions
      const trendingProducts = category.sections?.trending || [];
      for (const product of trendingProducts) {
        const norm = normalizeName(product.name);
        if (!norm) continue;

        if (productMap.has(norm)) {
          const existing = productMap.get(norm);
          existing.count += (product.count || 0);
        } else {
          productMap.set(norm, {
            name: product.name,
            count: product.count || 0,
          });
        }
      }
    }
  }

  // Convert to sorted arrays (highest count first), capped at DB_LIMIT
  const result = new Map();
  for (const [catName, productMap] of categoryAggMap.entries()) {
    const sorted = Array.from(productMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, DB_LIMIT)
      .map((p) => ({ name: p.name, count: p.count, source: 'DB' }));

    result.set(catName, sorted);
  }

  return result;
};

/* ---------------- CITY LEVEL COMPILER ---------------- */

/**
 * WHAT THIS DOES:
 * Builds the higher-level CITY catalog without querying the raw SQL shop tables again.
 * Instead, it finds all previously built PINCODE catalogs for this specific city and 
 * merges their trending products together. 
 * 
 * WHY WE DO THIS:
 * 1. Performance: Saves thousands of redundant DB queries.
 * 2. Fallback: If a user searches in a pincode that has no shops, they will fall back 
 *    to this exact City catalog.
 */
const buildCityCatalog = async (cityName) => {
  log.info({ info: `[CRON] Building CITY catalog for: ${cityName}` });

  // Fetch all PINCODE catalogs for this city
  const pincodeDocs = await GeoCatalog.find({ level: 'PINCODE', city: cityName }).lean();

  if (!pincodeDocs.length) {
    log.warn({ warn: `[CRON] No PINCODE catalogs found for city: ${cityName}, skipping` });
    return { success: false };
  }

  const state = pincodeDocs[0]?.state || null;

  // Aggregate trending products across all pincodes in this city
  const aggregatedMap = aggregateFromGeoDocs(pincodeDocs);

  // Build final categories with fresh AI popular products
  const finalCategories = [];

  for (const [categoryName, trendingProducts] of aggregatedMap.entries()) {
    const usedNames = new Set(trendingProducts.map((p) => normalizeName(p.name)));

    let aiProducts = [];
    try {
      aiProducts = await aiService.getCategoryProducts(
        normalizeCategory(categoryName),
        trendingProducts.map((p) => p.name)
      );
    } catch (err) {
      aiProducts = [];
    }

    const popular = [];
    for (const name of aiProducts) {
      const clean = exactProductName(name);
      const norm = normalizeName(clean);
      if (usedNames.has(norm)) continue;
      popular.push({ name: clean, count: 0, source: 'AI' });
      usedNames.add(norm);
      if (popular.length >= AI_LIMIT) break;
    }

    finalCategories.push({
      name: categoryName,
      sections: { trending: trendingProducts, popular },
    });
  }

  // Save/upsert CITY catalog in MongoDB
  const document = await GeoCatalog.findOneAndUpdate(
    { level: 'CITY', city: cityName },
    {
      $set: {
        level: 'CITY',
        pincode: null,
        city: cityName,
        state,
        country: 'India',
        categories: finalCategories,
        lastBuildAt: new Date(),
        buildStatus: 'SUCCESS',
      },
    },
    { upsert: true, new: true }
  );

  return { success: true, categories: document.categories };
};

/* ---------------- STATE LEVEL COMPILER ---------------- */

/**
 * WHAT THIS DOES:
 * Builds the STATE catalog by merging all previously built CITY catalogs for this state.
 * Just like City, it aggregates trending products upward from the city level, and then 
 * queries the Gemini AI for state-level popular product recommendations.
 */
const buildStateCatalog = async (stateName) => {
  log.info({ info: `[CRON] Building STATE catalog for: ${stateName}` });

  // Fetch all CITY catalogs for this state
  const cityDocs = await GeoCatalog.find({ level: 'CITY', state: stateName }).lean();

  if (!cityDocs.length) {
    log.warn({ warn: `[CRON] No CITY catalogs found for state: ${stateName}, skipping` });
    return { success: false };
  }

  // Aggregate trending products across all cities in this state
  const aggregatedMap = aggregateFromGeoDocs(cityDocs);

  const finalCategories = [];

  for (const [categoryName, trendingProducts] of aggregatedMap.entries()) {
    const usedNames = new Set(trendingProducts.map((p) => normalizeName(p.name)));

    let aiProducts = [];
    try {
      aiProducts = await aiService.getCategoryProducts(
        normalizeCategory(categoryName),
        trendingProducts.map((p) => p.name)
      );
    } catch (err) {
      aiProducts = [];
    }

    const popular = [];
    for (const name of aiProducts) {
      const clean = exactProductName(name);
      const norm = normalizeName(clean);
      if (usedNames.has(norm)) continue;
      popular.push({ name: clean, count: 0, source: 'AI' });
      usedNames.add(norm);
      if (popular.length >= AI_LIMIT) break;
    }

    finalCategories.push({
      name: categoryName,
      sections: { trending: trendingProducts, popular },
    });
  }

  // Save/upsert STATE catalog in MongoDB
  const document = await GeoCatalog.findOneAndUpdate(
    { level: 'STATE', state: stateName },
    {
      $set: {
        level: 'STATE',
        pincode: null,
        city: null,
        state: stateName,
        country: 'India',
        categories: finalCategories,
        lastBuildAt: new Date(),
        buildStatus: 'SUCCESS',
      },
    },
    { upsert: true, new: true }
  );

  return { success: true, categories: document.categories };
};

/* ---------------- COUNTRY LEVEL COMPILER ---------------- */

/**
 * WHAT THIS DOES:
 * The ultimate top-level aggregation. It merges all STATE catalogs into a single, 
 * unified COUNTRY catalog (India). This acts as the final fallback mechanism for 
 * any user opening the app in a region completely unsupported by local shops.
 */
const buildCountryCatalog = async () => {
  log.info({ info: '[CRON] Building COUNTRY catalog for: India' });

  // Fetch all STATE catalogs
  const stateDocs = await GeoCatalog.find({ level: 'STATE' }).lean();

  if (!stateDocs.length) {
    log.warn({ warn: '[CRON] No STATE catalogs found, skipping COUNTRY build' });
    return { success: false };
  }

  // Aggregate trending products across all states
  const aggregatedMap = aggregateFromGeoDocs(stateDocs);

  const finalCategories = [];

  for (const [categoryName, trendingProducts] of aggregatedMap.entries()) {
    const usedNames = new Set(trendingProducts.map((p) => normalizeName(p.name)));

    let aiProducts = [];
    try {
      aiProducts = await aiService.getCategoryProducts(
        normalizeCategory(categoryName),
        trendingProducts.map((p) => p.name)
      );
    } catch (err) {
      aiProducts = [];
    }

    const popular = [];
    for (const name of aiProducts) {
      const clean = exactProductName(name);
      const norm = normalizeName(clean);
      if (usedNames.has(norm)) continue;
      popular.push({ name: clean, count: 0, source: 'AI' });
      usedNames.add(norm);
      if (popular.length >= AI_LIMIT) break;
    }

    finalCategories.push({
      name: categoryName,
      sections: { trending: trendingProducts, popular },
    });
  }

  // Save/upsert COUNTRY catalog in MongoDB
  const document = await GeoCatalog.findOneAndUpdate(
    { level: 'COUNTRY', country: 'India' },
    {
      $set: {
        level: 'COUNTRY',
        pincode: null,
        city: null,
        state: null,
        country: 'India',
        categories: finalCategories,
        lastBuildAt: new Date(),
        buildStatus: 'SUCCESS',
      },
    },
    { upsert: true, new: true }
  );

  return { success: true, categories: document.categories };
};

module.exports = {
  buildPincodeCatalog,
  buildCityCatalog,
  buildStateCatalog,
  buildCountryCatalog,
};
```

---

### File 7: `backend/catalogue_mgmt_service/src/apis/services/v1/geoHierarchy.service.js`

**Why the code is there & What it is doing:**
**This file is necessary for manual triggering of cron job. To test uncomment this file.**

- **Purpose:** Establishes the core fallback resolution logic to guarantee catalog availability.
- **Flow:** Searches MongoDB sequentially, starting at the `PINCODE` level.
- **Fallback Chain:** If a specific local catalog is missing or empty, it systematically broadens the search scope (`CITY` -> `STATE` -> `COUNTRY`).
- **Impact:** Ensures the frontend and new merchants always receive the most granular and robust catalog data available without returning empty states.

**The Full Code:**
```js
// /**
//  * =================================================================================
//  * GEOGRAPHIC HIERARCHICAL RESOLVER SERVICE
//  * =================================================================================
//  * 
//  * CORE PURPOSE:
//  * Provides dynamic, on-demand geographic catalog resolution with a correct 
//  * hierarchical fallback strategy (Pincode -> City -> State -> Country).
//  * It resolves the local neighborhood demand catalogs for given geographic 
//  * parameters and integrates them with a specific shop's active inventory 
//  * using fuzzy string similarity matching.
//  * 
//  * FALLBACK LOGIC:
//  * - Level 1: Attempts to find a direct PINCODE level catalog.
//  * - Level 2: If no pincode, falls back to the aggregated CITY level catalog.
//  * - Level 3: If no city, falls back to the aggregated STATE level catalog.
//  * - Level 4: If no state, falls back to the COUNTRY level (India).
//  * =================================================================================
//  */
// 
// const { Logger: log } = require('sarvm-utility');
// const stringSimilarity = require('string-similarity');
// 
// const GeoCatalog = require('../../models/mongoCatalog/geoCatalogSchema');
// const RetailerCatalog = require('../../models/mongoCatalog/retailerSchema');
// const { getMasterCatalogSet } = require('./masterCatalog.service');
// 
// ---------------- HELPERS ----------------
// 
// const normalize = (str = '') =>
//   String(str)
//     .toLowerCase()
//     .replace(/[^a-z0-9]/g, '')
//     .trim();
// 
// const normalizeCategory = (str = '') =>
//   String(str)
//     .toLowerCase()
//     .replace(/\s+/g, '_')
//     .trim();
// 
// ---------------- FUZZY MATCH ----------------
// 
// const getBestMatch = (target, candidates, threshold) => {
//   if (!candidates.length) return null;
// 
//   const names = candidates.map((c) => c.name);
// 
//   const { bestMatch, bestMatchIndex } =
//     stringSimilarity.findBestMatch(target, names);
// 
//   if (bestMatch.rating >= threshold) {
//     return candidates[bestMatchIndex];
//   }
// 
//   return null;
// };
// 
// ---------------- BUILD SHOP CATEGORY MAP ----------------
// 
// const buildShopCategoryMap = (retailerDocs = []) => {
//   const map = new Map();
// 
//   retailerDocs.forEach((doc) => {
//     const categoryRaw =
//       doc?.category ||
//       doc?.catalog?.catPnm ||
//       '';
// 
//     const category = normalizeCategory(
//       String(categoryRaw).split('/')[0]
//     );
// 
//     const name = String(doc?.catalog?.prdNm || '').trim();
// 
//     if (!category || !name) return;
// 
//     if (!map.has(category)) {
//       map.set(category, []);
//     }
// 
//     map.get(category).push({
//       name,
//       source: 'SHOP',
//     });
//   });
// 
//   return map;
// };
// 
// ---------------- FILTER GEO PRODUCTS ----------------
// 
// const filterGeoProducts = (geoProducts = [], masterSet) => {
//   return geoProducts.filter((p) =>
//     masterSet.has(normalize(p.name))
//   );
// };
// 
// ---------------- MERGE LOGIC ----------------
// 
// const mergeCategoryProducts = (shopProducts = [], geoSections = {}) => {
//   const trending = geoSections.trending || [];
//   const popular = geoSections.popular || [];
// 
//   const usedRetailer = new Set();
// 
//   const matched = [];
//   const retailerOnly = [];
// 
//   // -------- STEP 1: TRENDING (priority) --------
// 
//   for (const geoProduct of trending) {
//     const match = getBestMatch(
//       geoProduct.name,
//       shopProducts,
//       0.5
//     );
// 
//     if (match) {
//       const key = normalize(match.name);
// 
//       if (!usedRetailer.has(key)) {
//         matched.push({
//           ...match,
//           source: 'TRENDING_MATCH',
//           isCommon: true,
//           count: geoProduct.count || 0,
//         });
// 
//         usedRetailer.add(key);
//       }
//     }
//   }
// 
//   // -------- STEP 2: POPULAR (AI) --------
// 
//   for (const geoProduct of popular) {
//     const match = getBestMatch(
//       geoProduct.name,
//       shopProducts,
//       0.4
//     );
// 
//     if (match) {
//       const key = normalize(match.name);
// 
//       if (!usedRetailer.has(key)) {
//         matched.push({
//           ...match,
//           source: 'POPULAR_MATCH',
//           isCommon: true,
//           count: geoProduct.count || 0,
//         });
// 
//         usedRetailer.add(key);
//       }
//     }
//   }
// 
//   // -------- STEP 3: REMAINING RETAILER --------
// 
//   for (const shopProduct of shopProducts) {
//     const key = normalize(shopProduct.name);
// 
//     if (!usedRetailer.has(key)) {
//       retailerOnly.push({
//         name: shopProduct.name,
//         source: 'SHOP',
//         isCommon: false,
//       });
//     }
//   }
// 
//   return {
//     finalProducts: [...matched, ...retailerOnly],
//     debug: {
//       common: matched,
//       retailer: retailerOnly,
//     },
//   };
// };
// 
// ---------------- MAIN FUNCTION ----------------
// 
// const getGeoCatalogWithFallback = async ({
//   shopId,
//   pincode,
//   city,
//   state,
//   country,
// }) => {
//   try {
//     // -------- STEP 1: FETCH GEO CATALOG (SMART FALLBACK) --------
// 
//     let geoCatalog = null;
// 
//     // 1. PINCODE Level Lookup
//     if (pincode) {
//       geoCatalog = await GeoCatalog.findOne({
//         level: 'PINCODE',
//         pincode: String(pincode),
//       })
//         .sort({ updatedAt: -1 })
//         .lean();
//     }
// 
//     // 2. CITY Level Lookup (Fallback if no pincode found)
//     if (!geoCatalog && city) {
//       geoCatalog = await GeoCatalog.findOne({
//         level: 'CITY',
//         city: { $regex: new RegExp(`^${city}$`, 'i') },
//       })
//         .sort({ updatedAt: -1 })
//         .lean();
//     }
// 
//     // 3. STATE Level Lookup (Fallback if no city found)
//     if (!geoCatalog && state) {
//       geoCatalog = await GeoCatalog.findOne({
//         level: 'STATE',
//         state: { $regex: new RegExp(`^${state}$`, 'i') },
//       })
//         .sort({ updatedAt: -1 })
//         .lean();
//     }
// 
//     // 4. COUNTRY Level Lookup (Fallback if no state found)
//     if (!geoCatalog && country) {
//       geoCatalog = await GeoCatalog.findOne({
//         level: 'COUNTRY',
//         country: { $regex: new RegExp(`^${country}$`, 'i') },
//       })
//         .sort({ updatedAt: -1 })
//         .lean();
//     }
// 
//     if (!geoCatalog) return null;
// 
//     // -------- STEP 2: NO SHOP → RETURN RAW --------
// 
//     if (!shopId) return geoCatalog;
// 
//     // -------- STEP 3: MASTER CATALOG --------
// 
//     const masterSet = await getMasterCatalogSet();
// 
//     // -------- STEP 4: FETCH SHOP PRODUCTS --------
// 
//     const retailerDocs = await RetailerCatalog.find({
//       shopId: Number(shopId),
//       catalog: { $ne: null },
//     }).lean();
// 
//     if (!retailerDocs.length) {
//       return geoCatalog;
//     }
// 
//     const shopCategoryMap = buildShopCategoryMap(retailerDocs);
// 
//     // -------- STEP 5: PROCESS CATEGORY --------
// 
//     const finalCategories = [];
// 
//     geoCatalog.categories.forEach((geoCategory) => {
//       const categoryName = normalizeCategory(geoCategory.name);
// 
//       if (!shopCategoryMap.has(categoryName)) return;
// 
//       const shopProducts = shopCategoryMap.get(categoryName);
// 
//       const geoProducts = [
//         ...(geoCategory.sections?.trending || []),
//         ...(geoCategory.sections?.popular || []),
//       ];
// 
//       const filteredGeoProducts = filterGeoProducts(
//         geoProducts,
//         masterSet
//       );
// 
//       const { finalProducts, debug } = mergeCategoryProducts(
//         shopProducts,
//         geoCategory.sections
//       );
// 
//       finalCategories.push({
//         name: geoCategory.name,
//         products: finalProducts,
//         debug, // 👈 visible in API for testing
//       });
//     });
// 
//     return {
//       ...geoCatalog,
//       categories: finalCategories,
//     };
//   } catch (error) {
//     log.error({
//       error: 'Error in getGeoCatalogWithFallback',
//       details: error.message,
//     });
//     throw error;
//   }
// };
// 
// module.exports = {
//   getGeoCatalogWithFallback,
// };
```

---

### File 8: `backend/catalogue_mgmt_service/src/apis/services/v1/masterCatalog.service.js`

**Why the code is there & What it is doing:**
**This file is necessary for manual triggering of cron job. To test uncomment this file.**

- **Purpose:** Interfaces directly with the central master catalog in the PostgreSQL database.
- **Role:** Represents the canonical truth for all valid, active products within the SARVM ecosystem.
- **Validation:** Provides robust query functions to filter out inactive products and verify that generated AI suggestions correspond to real, provisioned SKUs.

**The Full Code:**
```js
// /**
//  * ============================================================================
//  * MASTER CATALOG SERVICE
//  * ============================================================================
//  *
//  * CORE PURPOSE:
//  * This service manages, normalizes, and caches the official standard product
//  * directory for the SARVM platform. It is used to verify and filter product
//  * recommendations, ensuring only recognized products are served to users.
//  *
//  * CORE FEATURES:
//  * 1. Caching: Caches the product set in-memory (RAM) with a 1-hour TTL (Time-To-Live)
//  *    to prevent expensive database or network calls on every request.
//  * 2. Normalization: Standardizes product names (removes spaces, symbols, and casing)
//  *    to allow exact matches regardless of typos or character variations.
//  *
//  * PRIMARY USAGE:
//  * Imported and utilized by geoHierarchy.service.js to validate/filter trending
//  * and popular items in geo-localized catalogs.
//  * ============================================================================
//  */
// 
// const axios = require('axios');
// const { Logger: log } = require('sarvm-utility');
// 
// const MasterCatalog = require('../../models/mongoCatalog/requestMasterCatalogSchema');
// const Product = require('../../models/mongoCatalog/productSchema');
// 
// /* ---------------- CACHE ---------------- */
// 
// let masterSetCache = null;
// let lastFetchTime = null;
// 
// const CACHE_TTL = 1000 * 60 * 60; // 1 hour
// 
// /* ---------------- HELPERS ---------------- */
// 
// const normalize = (str = '') =>
//   String(str)
//     .toLowerCase()
//     .replace(/[^a-z0-9]/g, '')
//     .trim();
// 
// /**
//  * Extract product names from master catalog JSON
//  */
// const extractProductNames = (data = {}) => {
//   const products = [];
// 
//   try {
//     /**
//      * Your JSON structure (based on your URL):
//      * data.catalog -> array
//      */
// 
//     const catalog = data?.catalog || [];
// 
//     catalog.forEach((item) => {
//       if (item?.prdNm) {
//         products.push(item.prdNm);
//       }
// 
//       // If nested structure exists
//       if (item?.products && Array.isArray(item.products)) {
//         item.products.forEach((p) => {
//           if (p?.prdNm) {
//             products.push(p.prdNm);
//           }
//         });
//       }
//     });
//   } catch (err) {
//     log.error({
//       error: 'Error extracting product names',
//       details: err.message,
//     });
//   }
// 
//   return products;
// };
// 
// const buildMasterSet = (productNames = []) => {
//   const masterSet = new Set();
// 
//   productNames.forEach((name) => {
//     const normalized = normalize(name);
//     if (normalized) {
//       masterSet.add(normalized);
//     }
//   });
// 
//   return masterSet;
// };
// 
// /* ---------------- MAIN FUNCTION ---------------- */
// 
// const getMasterCatalogSet = async () => {
//   try {
//     /* -------- STEP 1: RETURN CACHE -------- */
// 
//     if (
//       masterSetCache &&
//       lastFetchTime &&
//       Date.now() - lastFetchTime < CACHE_TTL
//     ) {
//       return masterSetCache;
//     }
// 
//     log.info({
//       info: 'Fetching master catalog...',
//     });
// 
//     /* -------- STEP 2: FETCH MASTER PRODUCTS FROM MONGO -------- */
// 
//     const masterProducts = await Product.find({
//       status: { $ne: 'DELETED' },
//     })
//       .select('prdNm')
//       .lean();
// 
//     const mongoProductNames = masterProducts
//       .map((product) => product?.prdNm)
//       .filter(Boolean);
// 
//     if (mongoProductNames.length > 0) {
//       const masterSet = buildMasterSet(mongoProductNames);
// 
//       masterSetCache = masterSet;
//       lastFetchTime = Date.now();
// 
//       log.info({
//         info: 'Master catalog loaded from product collection',
//         totalProducts: masterSet.size,
//       });
// 
//       return masterSet;
//     }
// 
//     /* -------- STEP 3: FALLBACK TO ACTIVE MASTER RECORD -------- */
// 
//     const masterDoc = await MasterCatalog.findOne({
//       active: true,
//     }).lean();
// 
//     if (!masterDoc?.url) {
//       log.warn({
//         warn: 'No active master catalog found',
//       });
// 
//       return new Set();
//     }
// 
//     const url = masterDoc.url;
// 
//     /* -------- STEP 4: FETCH JSON FROM URL -------- */
// 
//     const response = await axios.get(url, {
//       timeout: 5000,
//     });
// 
//     const data = response?.data || {};
// 
//     /* -------- STEP 5: EXTRACT PRODUCT NAMES -------- */
// 
//     const productNames = extractProductNames(data);
// 
//     /* -------- STEP 6: BUILD SET -------- */
// 
//     const masterSet = buildMasterSet(productNames);
// 
//     /* -------- STEP 7: CACHE -------- */
// 
//     masterSetCache = masterSet;
//     lastFetchTime = Date.now();
// 
//     log.info({
//       info: 'Master catalog loaded',
//       totalProducts: masterSet.size,
//     });
// 
//     return masterSet;
//   } catch (error) {
//     log.error({
//       error: 'Failed to load master catalog',
//       details: error.message,
//     });
// 
//     /* -------- FALLBACK -------- */
// 
//     return masterSetCache || new Set();
//   }
// };
// 
// /* ---------------- OPTIONAL: FORCE REFRESH ---------------- */
// 
// const refreshMasterCatalog = async () => {
//   masterSetCache = null;
//   lastFetchTime = null;
// 
//   return getMasterCatalogSet();
// };
// 
// module.exports = {
//   getMasterCatalogSet,
//   refreshMasterCatalog,
// };
// 
```

---

### File 9: `backend/catalogue_mgmt_service/src/apis/services/v1/popularProduct.service.js`

**Why the code is there & What it is doing:**
- **Purpose:** Analyzes transactional data, shop inventories, or existing databases to generate ranked lists of popular products.
- **Role in Pipeline:** Populates the foundational, DB-sourced "trending" section of the geo-catalog before AI steps in to fill gaps.
- **Abstraction:** Encapsulates complex SQL/NoSQL aggregations into a clean interface for controllers and cron jobs.

**The Full Code:**
```js
/**
 * ============================================================================
 * POPULAR PRODUCT SERVICE (The Popularity & Matching Engine)
 * ============================================================================
 * 
 * CORE PURPOSE:
 * This service contains the core business logic, matching algorithms, and 
 * data aggregation pipelines for missing trending products.
 * 
 * WHAT IT DOES:
 * 1. Missing Items Aggregation: Scans geo-catalogs to find trending regional items 
 *    that do not exist in the platform's Master Product Catalogue, preparing 
 *    them for the Admin Panel review list.
 * 2. Fuzzy Text Matching: Runs string-similarity scoring algorithms (minimum 30% match) 
 *    to help admins spot and link similar items, preventing accidental duplicates.
 * 3. Spelling Corrections: Updates typos in product names across multiple geofenced 
 *    pincode files at once.
 * 4. Request Ticket Filing: Delegates missing item registrations to the smart 
 *    request ticket manager.
 * ============================================================================
 */

const { Logger: log } = require('sarvm-utility');
const stringSimilarity = require('string-similarity');
const GeoCatalog = require('../../models/mongoCatalog/geoCatalogSchema');
const Product = require('../../models/mongoCatalog/productSchema');
const ReqMasterProductService = require('./mongoCatalog/requestMasterCatalog');
const ReqMasterProduct = require('../../models/mongoCatalog/requestMasterCatalogSchema');

const normalize = (str = '') =>
    String(str).toLowerCase().replace(/[^a-z0-9]/g, '').trim();

/**
 * Step 1: Get all popular products from geo_catalogs
 * Step 2: Get all product names from products collection
 * Step 3: Filter out exact matches
 * Step 4: Apply search + pagination
 */
const getUnmatchedPopularProducts = async (page = 1, pageSize = 10, search = '') => {
    try {
        // Fetch ALL geo_catalog documents
        const geoDocs = await GeoCatalog.find({}).lean();

        // Fetch ALL product names from products collection
        const allProducts = await Product.find({ st: { $ne: 'DELETED' } })
            .select('prdNm')
            .lean();

        const masterSet = new Set(
            allProducts.map((p) => normalize(p.prdNm)).filter(Boolean)
        );

        // Fetch ALL requested products for geo_catalog to exclude them from the list
        const requestedProducts = await ReqMasterProduct.find({ retailerName: 'geo_catalog' })
            .select('productName')
            .lean();

        const requestedSet = new Set(
            requestedProducts.map((p) => normalize(p.productName)).filter(Boolean)
        );

        // Extract popular products from all geo docs, all categories
        // Group by normalized product name to avoid duplicates across pincodes
        const productMap = new Map();

        geoDocs.forEach((doc) => {
            const pincode = doc.pincode || '';
            const city = doc.city || '';
            const state = doc.state || '';

            (doc.categories || []).forEach((cat) => {
                const popularProducts = cat.sections?.popular || [];

                popularProducts.forEach((prod) => {
                    const normalizedName = normalize(prod.name);
                    // Only include if NOT in master product collection AND NOT already requested
                    if (!masterSet.has(normalizedName) && !requestedSet.has(normalizedName)) {
                        if (!productMap.has(normalizedName)) {
                            productMap.set(normalizedName, {
                                productName: prod.name,
                                categoryName: cat.name,
                                locations: [],
                                source: prod.source || 'AI',
                                count: prod.count || 0,
                            });
                        }
                        const entry = productMap.get(normalizedName);
                        // Track all locations for this product
                        const locKey = `${pincode}_${city}_${state}`;
                        const alreadyAdded = entry.locations.some(
                            (l) => `${l.pincode}_${l.city}_${l.state}` === locKey
                        );
                        if (!alreadyAdded) {
                            entry.locations.push({ pincode, city, state });
                        }
                        entry.count += prod.count || 0;
                    }
                });
            });
        });

        // Convert map to array
        const uniqueProducts = Array.from(productMap.values()).map((item) => ({
            productName: item.productName,
            categoryName: item.categoryName,
            pincode: item.locations.map((l) => l.pincode).filter(Boolean).join(', '),
            city: item.locations.map((l) => l.city).filter(Boolean).join(', '),
            state: [...new Set(item.locations.map((l) => l.state).filter(Boolean))].join(', '),
            locationCount: item.locations.length,
            source: item.source,
            count: item.count,
        }));

        // Apply search filter
        let filtered = uniqueProducts;
        if (search && search.trim()) {
            const s = search.toLowerCase().trim();
            filtered = uniqueProducts.filter(
                (item) =>
                    item.productName.toLowerCase().includes(s) ||
                    item.pincode.toLowerCase().includes(s) ||
                    item.city.toLowerCase().includes(s) ||
                    item.state.toLowerCase().includes(s)
            );
        }

        // Pagination
        const total = filtered.length;
        const totalPages = Math.ceil(total / pageSize);
        const start = (page - 1) * pageSize;
        const paginated = filtered.slice(start, start + pageSize);

        return {
            products: paginated,
            total,
            totalPages,
            currentPage: page,
            pageSize,
        };
    } catch (error) {
        log.error({ error: 'Error in getUnmatchedPopularProducts', details: error.message });
        throw error;
    }
};

/**
 * Find products from products collection with >=30% name similarity
 */
const getSimilarProducts = async (name, page = 1, pageSize = 10) => {
    try {
        const allProducts = await Product.find({ st: { $ne: 'DELETED' } })
            .select('prdNm dumK catPnm')
            .lean();

        const similarProducts = [];

        allProducts.forEach((product) => {
            if (!product.prdNm) return;
            const similarity = stringSimilarity.compareTwoStrings(
                name.toLowerCase(),
                product.prdNm.toLowerCase()
            );
            if (similarity >= 0.3) {
                similarProducts.push({
                    _id: product._id,
                    productName: product.prdNm,
                    dummyKey: product.dumK,
                    categoryPath: product.catPnm || '',
                    similarity: Math.round(similarity * 100),
                });
            }
        });

        // Sort by similarity descending
        similarProducts.sort((a, b) => b.similarity - a.similarity);

        const total = similarProducts.length;
        const totalPages = Math.ceil(total / pageSize);
        const start = (page - 1) * pageSize;
        const paginated = similarProducts.slice(start, start + pageSize);

        return {
            products: paginated,
            total,
            totalPages,
            currentPage: page,
            pageSize,
        };
    } catch (error) {
        log.error({ error: 'Error in getSimilarProducts', details: error.message });
        throw error;
    }
};

/**
 * Update old product name with new name in geo_catalogs wherever it exists
 */
const updateProductInGeoCatalog = async (oldName, newName, pincode, city, state) => {
    try {
        // Update across ALL geo_catalog documents (no pincode filter)
        // so the product gets updated everywhere it appears
        const geoDocs = await GeoCatalog.find({});

        let updateCount = 0;

        for (const doc of geoDocs) {
            let modified = false;

            (doc.categories || []).forEach((cat) => {
                ['trending', 'popular'].forEach((section) => {
                    const products = cat.sections?.[section] || [];
                    products.forEach((prod) => {
                        if (normalize(prod.name) === normalize(oldName)) {
                            prod.name = newName;
                            modified = true;
                            updateCount++;
                        }
                    });
                });
            });

            if (modified) {
                doc.markModified('categories');
                await doc.save();
            }
        }

        return {
            success: true,
            message: 'Product updated',
            updatedCount: updateCount,
        };
    } catch (error) {
        log.error({ error: 'Error in updateProductInGeoCatalog', details: error.message });
        throw error;
    }
};

/**
 * Send request to add new product using existing requestMasterCatalog service
 */
const sendAddProductRequest = async (productName, category) => {
    try {
        const result = await ReqMasterProductService.createGeoCatalogRequestIfMissing({
            productName,
            category: category || 'uncategorized',
        });

        if (!result.created) {
            return {
                success: true,
                message: 'A request for this product has already been submitted',
                data: result,
            };
        }

        return {
            success: true,
            message: 'Request to add new product is send',
            data: result,
        };
    } catch (error) {
        log.error({ error: 'Error in sendAddProductRequest', details: error.message });
        throw error;
    }
};

module.exports = {
    getUnmatchedPopularProducts,
    getSimilarProducts,
    updateProductInGeoCatalog,
    sendAddProductRequest,
};
```

---

### File 10: `backend/catalogue_mgmt_service/src/apis/services/v1/unverifiedShopSync.service.js`

**Why the code is there & What it is doing:**
- **Purpose:** Manages catalog provisioning for new, unverified, or bulk-imported merchants (e.g., Google Maps imports).
- **Problem Solved:** Eliminates the "cold start" problem by preventing digital storefronts from appearing empty upon registration.
- **Automation:** Uses `shopGeo.service.js` to find a new shop's location and automatically clones the appropriate hierarchical catalog into their personal `customcatalogs` collection.

**The Full Code:**
```js
/**
 * =================================================================================
 * UNVERIFIED SHOP CATALOG SYNC SERVICE
 * =================================================================================
 * This service is responsible for dynamically generating and updating the profile catalogs 
 * (profile.json) of unverified, Google-imported shops using neighborhood intelligence.
 *
 * KEY WORKFLOW & PIPELINE:
 * 1. FETCH UNVERIFIED SHOPS: Queries PostgreSQL (`shop` & `store_meta_data` tables) 
 *    to retrieve all shops flagged as 'unverified', along with their location meta 
 *    (pincode, city) and mapped categories.
 * 
 * 2. GEO CATALOG RESOLUTION: For each shop, it resolves the neighborhood demand catalog 
 *    (GeoCatalog from MongoDB) using a prioritized geographic fallback:
 *      Level 1: Exact PINCODE match
 *      Level 2: City-wide aggregation
 *      Level 3: State-wide aggregation
 *      Level 4: Country-wide (India) fallback catalog
 * 
 * 3. PRODUCT FUZZY MATCHING: Iterates through the shop's relevant categories, fetches 
 *    the regional "trending" and "popular" items, and matches them to active master 
 *    products in MongoDB using fuzzy string-similarity thresholds:
 *      - Trending products match with a near-exact threshold (95%)
 *      - Popular products match with a relaxed, fuzzy threshold (50%)
 * 
 * 4. S3 PROFILE UPDATE: Compiles the matched products into a structured catalog object, 
 *    constructs a new profile JSON schema, and uploads it directly to S3 (AWS or MinIO) 
 *    under the key `new_shops/<guid>/profile.json`.
 * =================================================================================
 */

const { Logger: log } = require('sarvm-utility');
const stringSimilarity = require('string-similarity');
const path = require('path');
const fs = require('fs');

const db = require('../../db/knex/knex');
const GeoCatalog = require('../../models/mongoCatalog/geoCatalogSchema');
const Product = require('../../models/mongoCatalog/productSchema');
const { uniqueS3Key, uploadProfileToS3 } = require('../../../common/libs/JsonToS3/JsonToS3');

/* ==================== CONSTANTS ==================== */

const POPULAR_THRESHOLD = 0.5;   // 50% fuzzy match for popular products
const TRENDING_THRESHOLD = 0.95; // near-exact match for trending products

// [Commented: Stored locally previously, now using S3 instead]
// const LOCAL_STORAGE_BASE = path.resolve(
//   __dirname,
//   '..', '..', '..', '..', '..', '..', // up to backend/
//   'retailer_service', 'local_storage', 'new_shops', 'unverified'
// );

/* ==================== HELPERS ==================== */

const sanitizeString = (str) => {
  if (str) {
    return str
      .replace(/-+/g, ' ')
      .replace(/_+/g, ' ')
      .replace(/\/+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .join('_')
      .toLowerCase();
  }
  return null;
};

const normalizeCategory = (str = '') =>
  String(str).toLowerCase().replace(/\s+/g, '_').trim();

/**
 * Parse state from the shop_meta_data URL.
 * URL pattern: .../new_shops/<guid>/profile.json
 * We fetch the JSON and extract vendor.state or fallback from address.
 */
const extractStateFromUrl = async (url) => {
  if (!url) return null;
  try {
    const axios = require('axios');
    const response = await axios.get(url, { timeout: 5000 });
    const data = response?.data || {};

    // Try vendor.state first
    let state = data?.vendor?.state || null;

    // Fallback: parse from shop.location.address (last comma-separated part)
    if (!state && data?.shop?.location?.address) {
      const parts = String(data.shop.location.address).split(',').map(p => p.trim());
      if (parts.length >= 1) {
        state = parts[parts.length - 1];
      }
    }

    return state;
  } catch (err) {
    log.warn({ warn: `[UNVERIFIED_SYNC] Could not fetch state from URL: ${url}`, error: err.message });
    return null;
  }
};

/* ==================== STEP 1: FETCH UNVERIFIED SHOPS FROM POSTGRES ==================== */

const fetchUnverifiedShops = async () => {
  log.info({ info: '[UNVERIFIED_SYNC] Step 1: Fetching unverified shops from Postgres...' });

  const shops = await db.raw(`
    SELECT 
      s.shop_id,
      s.shop_name,
      s.pincode,
      s.city,
      s.guid,
      smd.url,
      smd.categories
    FROM shop s
    LEFT JOIN store_meta_data smd ON s.shop_id = smd.shop_id
    WHERE s.shop_status = 'unverified'
  `);

  const rows = shops?.rows || [];
  log.info({ info: `[UNVERIFIED_SYNC] Found ${rows.length} unverified shops` });
  return rows;
};

/* ==================== STEP 2: GEO CATALOG FALLBACK LOOKUP ==================== */

const findGeoCatalog = async ({ pincode, city, state }) => {
  let geoCatalog = null;
  let matchedBy = null;

  // Level 1: Try exact PINCODE match
  if (pincode) {
    geoCatalog = await GeoCatalog.findOne({
      level: 'PINCODE',
      pincode: String(pincode),
    }).sort({ updatedAt: -1 }).lean();

    if (geoCatalog) matchedBy = 'PINCODE';
  }

  // Level 2: Fallback to aggregated CITY catalog
  if (!geoCatalog && city) {
    geoCatalog = await GeoCatalog.findOne({
      level: 'CITY',
      city: { $regex: new RegExp(`^${city}$`, 'i') },
    }).sort({ updatedAt: -1 }).lean();

    if (geoCatalog) matchedBy = 'CITY';
  }

  // Level 3: Fallback to aggregated STATE catalog
  if (!geoCatalog && state) {
    geoCatalog = await GeoCatalog.findOne({
      level: 'STATE',
      state: { $regex: new RegExp(`^${state}$`, 'i') },
    }).sort({ updatedAt: -1 }).lean();

    if (geoCatalog) matchedBy = 'STATE';
  }

  // Level 4: Final fallback to COUNTRY catalog (India)
  if (!geoCatalog) {
    geoCatalog = await GeoCatalog.findOne({
      level: 'COUNTRY',
      country: 'India',
    }).lean();

    if (geoCatalog) matchedBy = 'COUNTRY';
  }

  return { geoCatalog, matchedBy };
};

/* ==================== STEP 3: MATCH PRODUCTS FROM MONGO ==================== */

/**
 * For a given geo product name, find the best matching product in the
 * master products collection using fuzzy string matching.
 */
const findProductInMaster = async (geoProductName, threshold) => {
  if (!geoProductName) return null;

  try {
    // First: try exact match by sanitized dummy key
    const dumK = sanitizeString(geoProductName);
    let product = await Product.findOne({ dumK }).lean();
    if (product) return product;

    // Second: try case-insensitive regex on prdNm
    product = await Product.findOne({
      prdNm: { $regex: new RegExp(`^${geoProductName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
    }).lean();
    if (product) return product;

    // Third: fuzzy match - fetch candidates from same approximate name
    const words = geoProductName.split(/\s+/);
    const firstWord = words[0];
    if (!firstWord || firstWord.length < 2) return null;

    const candidates = await Product.find({
      prdNm: { $regex: new RegExp(firstWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
      status: { $ne: 'DELETED' },
    }).limit(50).lean();

    if (!candidates.length) return null;

    const candidateNames = candidates.map(c => c.prdNm || '');
    const { bestMatch, bestMatchIndex } = stringSimilarity.findBestMatch(geoProductName, candidateNames);

    if (bestMatch.rating >= threshold) {
      return candidates[bestMatchIndex];
    }

    return null;
  } catch (err) {
    log.warn({ warn: `[UNVERIFIED_SYNC] Error matching product: ${geoProductName}`, error: err.message });
    return null;
  }
};

/* ==================== STEP 4: BUILD PROFILE JSON ==================== */

/**
 * Format a matched product into the profile.json product structure
 * (same as addProductToCategory in the existing code).
 */
const formatProduct = (product) => ({
  id: product?._id?.toString(),
  productAtrributes: product?.prdAtr || null,
  quantity: product?.qty || null,
  price: product?.prc || null,
  logistics: product?.log || null,
  geography: product?.geo || null,
  prdNm: product?.prdNm || null,
  media: product?.media || null,
  dumK: product?.dumK || null,
  catPnm: product?.catPnm || null,
  catPid: product?.catPid || null,
  grd: product?.grd || 0,
  b2b: product?.b2b || false,
  b2c: product?.b2c || false,
  brd: product?.brd || false,
  status: 'pending',
  pub: product?.pub || false,
  veg: product?.veg || '',
  ctdBy: product?.ctdBy || null,
  updBy: product?.updBy || null,
  popularity: product?.popularity || false,
  __v: product?.__v || 0,
});

/**
 * Build the catalog array for the profile.json.
 * Creates an "All" top-level entry + individual category entries.
 */
const buildCatalog = (matchedProductsByCategory) => {
  const catalog = [];
  const allProducts = [];

  for (const [categoryName, products] of Object.entries(matchedProductsByCategory)) {
    if (!products.length) continue;

    const formattedProducts = products.map(formatProduct);
    allProducts.push(...formattedProducts);

    // Build individual category block
    catalog.push({
      id: sanitizeString(categoryName),
      name: categoryName,
      key: sanitizeString(categoryName),
      image: null,
      checked: true,
      categories: [
        {
          name: 'all',
          products: formattedProducts,
        },
      ],
    });
  }

  // Prepend "All" category
  if (allProducts.length > 0) {
    catalog.unshift({
      id: 'all',
      name: 'All',
      key: 'all',
      image: null,
      checked: true,
      categories: [
        {
          name: 'all',
          products: allProducts,
        },
      ],
    });
  }

  return catalog;
};

/* ==================== STEP 5: UPLOAD TO S3 (PREVIOUSLY LOCAL STORAGE) ==================== */

// [Commented: Saved locally previously, now uploading to S3]
// const saveProfileJsonLocally = (shopId, guid, profileJson) => {
//   try {
//     if (!fs.existsSync(LOCAL_STORAGE_BASE)) {
//       fs.mkdirSync(LOCAL_STORAGE_BASE, { recursive: true });
//     }
//     const filePath = path.join(LOCAL_STORAGE_BASE, `${shopId}_${guid || 'no_guid'}.json`);
//     fs.writeFileSync(filePath, JSON.stringify(profileJson, null, 2), 'utf-8');
//     log.info({ info: `[UNVERIFIED_SYNC] Saved profile.json for shop ${shopId} at ${filePath}` });
//     return filePath;
//   } catch (err) {
//     log.error({ error: `[UNVERIFIED_SYNC] Failed to save profile.json for shop ${shopId}`, details: err.message });
//     return null;
//   }
// };

/* ==================== MAIN ORCHESTRATOR ==================== */

const syncUnverifiedShops = async () => {
  const logs = [];
  const logEntry = (shopId, level, message) => {
    const entry = { shopId, level, message, timestamp: new Date().toISOString() };
    logs.push(entry);
    if (level === 'error') {
      log.error({ error: `[UNVERIFIED_SYNC] Shop ${shopId}: ${message}` });
    } else {
      log.info({ info: `[UNVERIFIED_SYNC] Shop ${shopId}: ${message}` });
    }
  };

  try {
    /* -------- STEP 1: Fetch unverified shops -------- */
    const shops = await fetchUnverifiedShops();

    if (!shops.length) {
      logEntry('N/A', 'info', 'No unverified shops found. Nothing to do.');
      return { success: true, totalShops: 0, processed: 0, failed: 0, logs };
    }

    let processed = 0;
    let failed = 0;

    for (const shop of shops) {
      const shopId = shop.shop_id;
      try {
        logEntry(shopId, 'info', `Processing shop: ${shop.shop_name || 'Unknown'}`);

        /* -------- Parse categories -------- */
        let shopCategories = [];
        try {
          if (typeof shop.categories === 'string') {
            shopCategories = JSON.parse(shop.categories);
          } else if (Array.isArray(shop.categories)) {
            shopCategories = shop.categories;
          }
        } catch (parseErr) {
          logEntry(shopId, 'warn', `Could not parse categories: ${parseErr.message}`);
        }

        // Filter out "All" and "Services" – they are meta-categories
        const relevantCategories = shopCategories.filter(
          cat => cat && !['all', 'services'].includes(cat.toLowerCase())
        );

        if (!relevantCategories.length) {
          logEntry(shopId, 'warn', 'No relevant categories found for this shop. Skipping.');
          failed++;
          continue;
        }

        logEntry(shopId, 'info', `Shop categories: [${relevantCategories.join(', ')}]`);

        /* -------- Extract state from URL -------- */
        let state = null;
        if (shop.url) {
          state = await extractStateFromUrl(shop.url);
          logEntry(shopId, 'info', `Extracted state from URL: ${state || 'N/A'}`);
        }

        /* -------- Find GeoCatalog -------- */
        const { geoCatalog, matchedBy } = await findGeoCatalog({
          pincode: shop.pincode,
          city: shop.city,
          state,
        });

        if (!geoCatalog) {
          logEntry(shopId, 'warn', `No GeoCatalog found (pincode: ${shop.pincode}, city: ${shop.city}, state: ${state}). Skipping.`);
          failed++;
          continue;
        }

        logEntry(shopId, 'info', `GeoCatalog matched by: ${matchedBy} (pincode: ${geoCatalog.pincode}, city: ${geoCatalog.city})`);

        /* -------- Match products per category -------- */
        const matchedProductsByCategory = {};
        let totalMatched = 0;

        for (const shopCategory of relevantCategories) {
          const normalizedShopCat = normalizeCategory(shopCategory);

          // Find the matching category in GeoCatalog
          const geoCategory = geoCatalog.categories.find(
            gc => normalizeCategory(gc.name) === normalizedShopCat
          );

          if (!geoCategory) {
            logEntry(shopId, 'info', `  Category "${shopCategory}" not found in GeoCatalog. Skipping.`);
            continue;
          }

          const trending = geoCategory.sections?.trending || [];
          const popular = geoCategory.sections?.popular || [];

          logEntry(shopId, 'info', `  Category "${shopCategory}": ${trending.length} trending, ${popular.length} popular products in GeoCatalog`);

          const categoryProducts = [];
          const usedProductIds = new Set();

          /* ---- Trending: near-exact match ---- */
          for (const trendingItem of trending) {
            if (!trendingItem.name) continue;

            const matchedProduct = await findProductInMaster(trendingItem.name, TRENDING_THRESHOLD);
            if (matchedProduct && !usedProductIds.has(matchedProduct._id.toString())) {
              categoryProducts.push(matchedProduct);
              usedProductIds.add(matchedProduct._id.toString());
              logEntry(shopId, 'info', `    [TRENDING] "${trendingItem.name}" → MATCHED → "${matchedProduct.prdNm}"`);
            } else if (!matchedProduct) {
              logEntry(shopId, 'info', `    [TRENDING] "${trendingItem.name}" → NO MATCH`);
            }
          }

          /* ---- Popular: fuzzy match (50%) ---- */
          for (const popularItem of popular) {
            if (!popularItem.name) continue;

            const matchedProduct = await findProductInMaster(popularItem.name, POPULAR_THRESHOLD);
            if (matchedProduct && !usedProductIds.has(matchedProduct._id.toString())) {
              categoryProducts.push(matchedProduct);
              usedProductIds.add(matchedProduct._id.toString());
              logEntry(shopId, 'info', `    [POPULAR]  "${popularItem.name}" → MATCHED → "${matchedProduct.prdNm}"`);
            } else if (!matchedProduct) {
              logEntry(shopId, 'info', `    [POPULAR]  "${popularItem.name}" → NO MATCH`);
            }
          }

          if (categoryProducts.length > 0) {
            matchedProductsByCategory[shopCategory] = categoryProducts;
            totalMatched += categoryProducts.length;
          }
        }

        logEntry(shopId, 'info', `Total matched products: ${totalMatched}`);

        if (totalMatched === 0) {
          logEntry(shopId, 'warn', 'No products matched for any category. Skipping file generation.');
          failed++;
          continue;
        }

        /* -------- Build profile.json -------- */
        const catalog = buildCatalog(matchedProductsByCategory);

        const profileJson = {
          shop: {
            id: shopId,
            name: shop.shop_name || null,
          },
          vendor: {
            shopid: shopId,
            guid: shop.guid || null,
            pincode: shop.pincode || null,
            city: shop.city || null,
            state: state || null,
            categories: shopCategories,
          },
          catalog,
        };

        /* -------- Upload to S3 -------- */
        const uniqueKey = uniqueS3Key('new_shops', shop.guid);
        let uploadSuccess = false;
        try {
          const result = await uploadProfileToS3(uniqueKey, profileJson);
          if (result) {
            uploadSuccess = true;
          }
        } catch (uploadErr) {
          logEntry(shopId, 'error', `S3 Upload Error: ${uploadErr.message}`);
        }

        if (uploadSuccess) {
          logEntry(shopId, 'info', `✅ Profile JSON uploaded successfully to S3 under key: ${uniqueKey}`);
          processed++;
        } else {
          logEntry(shopId, 'error', 'Failed to upload profile JSON to S3.');
          failed++;
        }
      } catch (shopError) {
        logEntry(shopId, 'error', `Unexpected error: ${shopError.message} | ErrorType: ${shopError.name} | Stack: ${shopError.stack?.split('\n').slice(0, 3).join(' -> ')}`);
        failed++;
      }
    }

    log.info({ info: `[UNVERIFIED_SYNC] Completed. Processed: ${processed}, Failed: ${failed}, Total: ${shops.length}` });

    return {
      success: true,
      totalShops: shops.length,
      processed,
      failed,
      logs,
    };
  } catch (error) {
    log.error({ error: '[UNVERIFIED_SYNC] Fatal error during sync', details: error.message });
    return {
      success: false,
      error: error.message,
      logs,
    };
  }
};

module.exports = {
  syncUnverifiedShops,
};

```

---

### File 11: `backend/catalogue_mgmt_service/src/apis/controllers/v1/popularProduct.js`

**Why the code is there & What it is doing:**
- **Purpose:** Serves as the HTTP interface for popular product functionalities.
- **Operations:** Parses incoming queries, validates pagination/category parameters, and delegates logic to `popularProduct.service.js`.
- **Response Handling:** Maps processed datasets into standardized JSON APIs and converts server exceptions into clean `500 Internal Server Error` responses.

**The Full Code:**
```js
const { Logger: log } = require('sarvm-utility');
const PopularProductService = require('../../services/v1/popularProduct.service');

const getUnmatchedPopularProducts = async (page, pageSize, search) => {
    log.info({ info: 'PopularProductController :: getUnmatchedPopularProducts' });
    return PopularProductService.getUnmatchedPopularProducts(page, pageSize, search);
};

const getSimilarProducts = async (name, page, pageSize) => {
    log.info({ info: 'PopularProductController :: getSimilarProducts' });
    return PopularProductService.getSimilarProducts(name, page, pageSize);
};

const updateProductInGeoCatalog = async (oldName, newName, pincode, city, state) => {
    log.info({ info: 'PopularProductController :: updateProductInGeoCatalog' });
    return PopularProductService.updateProductInGeoCatalog(oldName, newName, pincode, city, state);
};

const sendAddProductRequest = async (productName, category) => {
    log.info({ info: 'PopularProductController :: sendAddProductRequest' });
    return PopularProductService.sendAddProductRequest(productName, category);
};

module.exports = {
    getUnmatchedPopularProducts,
    getSimilarProducts,
    updateProductInGeoCatalog,
    sendAddProductRequest,
};
```

---

### File 12: `backend/catalogue_mgmt_service/src/apis/controllers/v1/geo.js`

**Why the code is there & What it is doing:**
- **Purpose:** The primary Express controller for HTTP interactions with the Geographic Catalog System.
- **Key Endpoints:** Contains handlers to test catalog builds by Pincode/shopId, force-apply catalogs to specific shops, and instantly trigger the cron job on demand.
- **Flow:** Parses HTTP request bodies, invokes underlying services, and formats the finalized output for the frontend UI.

**The Full Code:**
```js
/**
 * =================================================================================
 * GEOGRAPHIC CATALOG & SHOP SYNC CONTROLLER
 * =================================================================================
 *
 * PURPOSE:
 * It is build for manualt testing of the pincode catalog builder, rather than running whole cron job again we can test for particular pinocde through this.
 * This controller handles HTTP endpoints for regional catalog generation and shop
 * data synchronization within the SARVM backend catalogue management service.
 *
 * CORE ENDPOINTS / RESPONSIBILITIES:
 * 1. Pincode Catalog Testing: Triggering manual compilation of trending/popular items for a pincode.
 * 2. Shop Catalog Resolution: Resolving individual shop locations and initializing geographic catalogs.
 * 3. Fallback Geo-Catalog Retrieval: Resolving regional catalogs using layered fallback logic (Pincode -> City -> State).
 * 4. Job Orchestration: Manually running the geo-catalog compiler background tasks.
 * 5. Unverified Shop Sync: Triggering sync routines for Google-imported, unverified shop templates.
 * =================================================================================

// Code disabled
const { Logger: log } = require('sarvm-utility');
// 
// const { buildPincodeCatalog } = require('../../services/v1/pincodeCatalogBuilder.service');
// const {
//   getGeoCatalogWithFallback,
// } = require('../../services/v1/geoHierarchy.service');
// 
// const shopGeoService = require('../../services/v1/shopGeo.service');
// const { runGeoCatalogJobOnce } = require('../../../jobs/geoCatalog.job');
// const { syncUnverifiedShops } = require('../../services/v1/unverifiedShopSync.service');
// 
// /* ---------------- HELPER: COUNT PRODUCTS ---------------- */
// 
// const getTotalProducts = (categories = []) => {
//   return categories.reduce((count, cat) => {
//     const trending = cat.sections?.trending || [];
//     const popular = cat.sections?.popular || [];
// 
//     return count + trending.length + popular.length;
//   }, 0);
// };
// 
// /* ---------------- TEST PINCODE ---------------- */
// 
// const testPincodeCatalog = async (req, res) => {
//   try {
//     const { pincode } = req.body;
// 
//     if (!pincode) {
//       return res.status(400).json({
//         success: false,
//         message: 'pincode is required',
//       });
//     }
// 
//     const result = await buildPincodeCatalog(pincode);
// 
//     return res.status(200).json({
//       success: true,
//       pincode: String(pincode),
//       categoryCount: result.categories.length,
//       totalProducts: getTotalProducts(result.categories),
//       categories: result.categories,
//     });
//   } catch (error) {
//     log.error({
//       error: 'Error in testPincodeCatalog',
//       details: error.message,
//     });
// 
//     return res.status(500).json({
//       success: false,
//       message: 'Internal server error',
//     });
//   }
// };
// 
// /* ---------------- TEST SHOP ---------------- */
// 
// const testShopCatalog = async (req, res) => {
//   try {
//     const { shopId } = req.body;
// 
//     if (!shopId) {
//       return res.status(400).json({
//         success: false,
//         message: 'shopId is required',
//       });
//     }
// 
//     const location = await shopGeoService.getShopLocation(Number(shopId));
// 
//     if (!location?.pincode) {
//       return res.status(404).json({
//         success: false,
//         message: 'Pincode not found for shop',
//       });
//     }
// 
//     const result = await buildPincodeCatalog(location.pincode);
// 
//     return res.status(200).json({
//       success: true,
//       shopId: Number(shopId),
//       pincode: location.pincode,
//       categoryCount: result.categories.length,
//       totalProducts: getTotalProducts(result.categories),
//       categories: result.categories,
//     });
//   } catch (error) {
//     log.error({
//       error: 'Error in testShopCatalog',
//       details: error.message,
//     });
// 
//     return res.status(500).json({
//       success: false,
//       message: 'Internal server error',
//     });
//   }
// };
// 
// /* ---------------- GET GEO CATALOG ---------------- */
// 
// const getResolvedGeoCatalog = async (req, res) => {
//   try {
//     const { shopId, pincode } = req.query;
// 
//     const location = shopId
//       ? await shopGeoService.getShopLocation(Number(shopId))
//       : null;
// 
//     const catalog = await getGeoCatalogWithFallback({
//       shopId: shopId ? Number(shopId) : null,
//       pincode: pincode || location?.pincode,
//       city: location?.city,
//       state: location?.state,
//       country: location?.country,
//     });
// 
//     if (!catalog) {
//       log.warn({ warn: 'No geo catalog found in DB, returning sample for local testing' });
//       return res.status(200).json({
//         success: true,
//         catalog: {
//           level: 'PINCODE',
//           pincode: pincode || 'MOCK',
//           categories: [
//             {
//               name: 'Sample Demand',
//               sections: {
//                 trending: [{ name: 'Bisleri Mineral Water,1 ltr', count: 100 }],
//                 popular: [{ name: 'Coca Cola Can,300 ml', count: 50 }]
//               }
//             }
//           ]
//         }
//       });
//     }
// 
//     return res.status(200).json({
//       success: true,
//       catalog,
//     });
//   } catch (error) {
//     log.error({
//       error: 'Error in getResolvedGeoCatalog',
//       details: error.message,
//     });
// 
//     // Even on error, return a success with mock data if we are in local development
//     return res.status(200).json({
//       success: true,
//       catalog: {
//         level: 'PINCODE',
//         pincode: 'LOCAL_MOCK',
//         categories: []
//       }
//     });
//   }
// };
// 
// /* ---------------- MANUAL CRON TRIGGER ---------------- */
// 
// const triggerCronManually = async (req, res) => {
//   try {
//     log.info({ info: 'Manual geo cron trigger started' });
// 
//     runGeoCatalogJobOnce();
// 
//     return res.status(202).json({
//       success: true,
//       message: 'Geo catalog cron job triggered successfully',
//     });
//   } catch (error) {
//     log.error({
//       error: 'Error triggering cron manually',
//       details: error.message,
//     });
// 
//     return res.status(500).json({
//       success: false,
//       message: 'Failed to trigger cron job',
//     });
//   }
// };
// 
// /* ---------------- SYNC UNVERIFIED SHOPS ---------------- */
// 
// const syncUnverifiedShopsHandler = async (req, res) => {
//   try {
//     log.info({ info: '[UNVERIFIED_SYNC] API triggered' });
// 
//     const result = await syncUnverifiedShops();
// 
//     return res.status(200).json({
//       success: result.success,
//       totalShops: result.totalShops || 0,
//       processed: result.processed || 0,
//       failed: result.failed || 0,
//       logs: result.logs || [],
//       error: result.error || null,
//     });
//   } catch (error) {
//     log.error({
//       error: 'Error in syncUnverifiedShopsHandler',
//       details: error.message,
//     });
// 
//     return res.status(500).json({
//       success: false,
//       message: 'Internal server error during unverified shop sync',
//       error: error.message,
//     });
//   }
// };
// 
// /* ---------------- EXPORTS ---------------- */
// 
// module.exports = {
//   testPincodeCatalog,
//   testShopCatalog,
//   getResolvedGeoCatalog,
//   triggerCronManually,
//   syncUnverifiedShopsHandler,
// };
```

---

### File 13: `backend/catalogue_mgmt_service/src/apis/routes/v1/geo.js`

**Why the code is there & What it is doing:**
- **Purpose:** Responsible for Express routing configurations specific to the geographic catalog feature.
- **Wiring:** Binds controller functions to specific HTTP verbs and paths (e.g., `POST /test/pincode`, `GET /catalog`) under the `/v1/geo/` prefix.

**The Full Code:**
```js
/**
 * =================================================================================
 * GEOGRAPHIC CATALOG EXPRESS ROUTER
 * =================================================================================
 *
 * PURPOSE:
 * Exposes geographic catalog generation and shop synchronization endpoints to
 * the HTTP server.
 *
 * CRON JOB NOTE:
 * Specifically used for manual testing and verification.
 * - This file is NOT used or required by the background cron job to run. The nightly
 *   cron scheduler (in geoCatalog.job.js) runs entirely independently on a separate
 *   system timer thread.
 *
 * CORE ROUTES:
 * 1. Manual Testing (Phase 1):
 *    - POST `/test/pincode`: Instantly compiles/inspects a catalog for a single pincode.
 *    - POST `/test/shop`: Resolves a shop's location and builds the corresponding pincode catalog.
 * 2. Production API (Phase 2):
 *    - GET `/catalog`: Resolves and returns regional catalogs dynamically.
 * 3. Administrative Triggers (Phase 2 & 3):
 *    - POST `/cron/trigger`: Manually triggers the full geo-catalog compiler immediately.
 *    - POST `/sync/unverified`: Manually triggers synchronization for unverified shops.
 * =================================================================================
 */

const express = require('express');
const { Logger: log } = require('sarvm-utility');

const GeoController = require('../../controllers/v1/geo');

const router = express.Router();

/*
// Phase 1 — test endpoints
router.post('/test/pincode', async (req, res, next) => {
  log.info({ info: 'Geo route :: test pincode catalog' });
  return GeoController.testPincodeCatalog(req, res, next);
});

router.post('/test/shop', async (req, res, next) => {
  log.info({ info: 'Geo route :: test shop catalog' });
  return GeoController.testShopCatalog(req, res, next);
});

// // Phase 2 — production endpoints
// router.post('/apply', async (req, res, next) => {
//   log.info({ info: 'Geo route :: apply geo catalog' });
//   return GeoController.applyGeoCatalog(req, res, next);
// });

router.get('/catalog', async (req, res, next) => {
  log.info({ info: 'Geo route :: get resolved geo catalog' });
  return GeoController.getResolvedGeoCatalog(req, res, next);
});

// Phase 2 — manual cron trigger for testing
router.post('/cron/trigger', async (req, res, next) => {
  log.info({ info: 'Geo route :: manual cron trigger' });
  return GeoController.triggerCronManually(req, res, next);
});

// Phase 3 — sync unverified shops (temporary test endpoint)
router.post('/sync/unverified', async (req, res, next) => {
  log.info({ info: 'Geo route :: sync unverified shops' });
  return GeoController.syncUnverifiedShopsHandler(req, res, next);
});
*/

module.exports = router;
```

---

### File 14: `backend/catalogue_mgmt_service/src/jobs/geoCatalog.job.js`

**Why the code is there & What it is doing:**
- **Purpose:** Defines the automated background cron scheduler powered by `node-cron`, set to run nightly at 2:00 AM IST.
- **Architecture:** Executes a resilient "Progressive Pipeline" that sequentially builds catalogs from Pincode up to Country level.
- **Fault Tolerance:** Enforces intentional delays (`GEO_CRON_PINCODE_DELAY_MS`) to prevent API throttling and wraps execution in granular `try/catch` blocks so failures in single regions do not halt the entire process.

**The Full Code:**
```js
/**
 * =================================================================================
 * GEOGRAPHIC CATALOG CRON SCHEDULER
 * =================================================================================
 * 
 * CORE PURPOSE:
 * This job executes automatically every night at 2:00 AM IST to rebuild and refresh 
 * the entire geographic catalog hierarchy (Pincode -> City -> State -> Country) 
 * across the platform.
 * 
 * EXECUTION FLOW (The Progressive Pipeline):
 * 1. PINCODE PHASE: Iterates through all unique pincodes active in the PostgreSQL shop 
 *    database. Calls the builder to fetch local retailer products, rank them by demand, 
 *    generate AI popular items, and cache them in MongoDB.
 * 2. CITY PHASE: Iterates through all unique cities. Instead of querying raw shops, 
 *    it aggregates the already-built PINCODE catalogs, grouping them to create the CITY catalog.
 * 3. STATE PHASE: Aggregates the newly built CITY catalogs into STATE catalogs.
 * 4. COUNTRY PHASE: Aggregates the STATE catalogs to build a single national catalog.
 * 
 * FAULT TOLERANCE:
 * The job is wrapped in individual `try...catch` blocks for every region. If one 
 * specific pincode or state fails (e.g. due to AI rate limits or DB timeout), 
 * the job logs the error and gracefully skips to the next region without crashing.
 * =================================================================================
 */

const cron = require('node-cron');
const { Logger: log } = require('sarvm-utility');

const shopGeoService = require('../apis/services/v1/shopGeo.service');
const {
  buildPincodeCatalog,
  buildCityCatalog,
  buildStateCatalog,
  buildCountryCatalog,
} = require('../apis/services/v1/pincodeCatalogBuilder.service');
const GeoCatalog = require('../apis/models/mongoCatalog/geoCatalogSchema');
const { syncUnverifiedShops } = require('../apis/services/v1/unverifiedShopSync.service');

let isStarted = false;
let isRunning = false;
let cronTask = null;

/* ---------------- HELPERS ---------------- */

const DELAY_MS = parseInt(process.env.GEO_CRON_PINCODE_DELAY_MS, 10) || 2000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------- MAIN JOB ---------------- */

const runGeoCatalogJobOnce = async () => {
  if (isRunning) {
    log.warn({ warn: '[CRON] Job already running, skipping' });
    return;
  }

  isRunning = true;

  try {
    /* -------- STEP 1: GET ALL PINCODES -------- */

    log.info({ info: '[CRON] Job started — fetching all shop locations...' });

    const shopLocations = await shopGeoService.getAllShopLocations();

    log.info({ info: `[CRON] Fetched ${shopLocations.length} shop locations` });

    const pincodes = [
      ...new Set(
        shopLocations.map((s) => s?.pincode).filter(Boolean)
      ),
    ];

    if (!pincodes.length) {
      log.warn({ warn: '[CRON] No pincodes found, nothing to process' });
      return;
    }

    log.info({ info: `[CRON] Found ${pincodes.length} unique pincodes — starting processing...` });

    /* -------- STEP 2: PROCESS EACH PINCODE (NEVER STOP ON ERROR) -------- */

    let newBuilds = 0;
    let retried = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < pincodes.length; i++) {
      const pincode = String(pincodes[i]);
      const startTime = Date.now();

      try {
        const existingDoc = await GeoCatalog.findOne({
          level: 'PINCODE',
          pincode,
        }).lean();

        if (!existingDoc) {
          /* ---- NEW PINCODE: full build ---- */
          log.info({ info: `[CRON] [${i + 1}/${pincodes.length}] Pincode ${pincode} — building catalog (NEW)` });
          await buildPincodeCatalog(pincode);
          newBuilds++;

        } else {
          /* ---- EXISTING: ALWAYS REBUILD (to fetch fresh shop products) ---- */
          log.info({ info: `[CRON] [${i + 1}/${pincodes.length}] Pincode ${pincode} — updating catalog (EXISTING, last updated: ${existingDoc.updatedAt || 'never'})` });
          await buildPincodeCatalog(pincode);
          retried++;
        }

        const elapsed = Date.now() - startTime;
        log.info({ info: `[CRON] [${i + 1}/${pincodes.length}] Pincode ${pincode} — SUCCESS (${elapsed}ms)` });

      } catch (error) {
        failed++;
        const elapsed = Date.now() - startTime;
        log.error({
          error: `[CRON] Pincode ${pincode} — FAILED after ${elapsed}ms (skipping to next)`,
          errorName: error.name,
          message: error.message,
          stack: error.stack,
        });
        // Don't stop — continue to the next pincode
      }

      /* -------- DELAY BEFORE NEXT PINCODE -------- */
      if (i < pincodes.length - 1) {
        await delay(DELAY_MS);
      }
    }

    /* -------- STEP 3: RE-DISCOVER NEW PINCODES -------- */
    /* In case new shops registered while the job was running */

    try {
      const freshLocations = await shopGeoService.getAllShopLocations();
      const freshPincodes = [
        ...new Set(
          freshLocations.map((s) => s?.pincode).filter(Boolean)
        ),
      ];

      const existingPincodeSet = new Set(pincodes);
      const newPincodes = freshPincodes.filter((p) => !existingPincodeSet.has(p));

      if (newPincodes.length > 0) {
        log.info({ info: `[CRON] Discovered ${newPincodes.length} NEW pincodes — processing...` });

        for (let i = 0; i < newPincodes.length; i++) {
          const pincode = String(newPincodes[i]);

          try {
            log.info({ info: `[CRON] [NEW ${i + 1}/${newPincodes.length}] Pincode ${pincode} — building catalog` });
            await buildPincodeCatalog(pincode);
            newBuilds++;
          } catch (error) {
            failed++;
            log.error({
              error: `[CRON] NEW Pincode ${pincode} — FAILED (skipping)`,
              message: error.message,
            });
          }

          if (i < newPincodes.length - 1) {
            await delay(DELAY_MS);
          }
        }
      }
    } catch (rediscoverError) {
      log.warn({
        warn: '[CRON] Failed to re-discover new pincodes',
        message: rediscoverError.message,
      });
    }

    /* -------- STEP 4: PROCESS CITY CATALOGS -------- */
    /* Aggregate PINCODE catalogs into CITY-level catalogs */

    const cities = [...new Set(shopLocations.map((s) => s?.city).filter(Boolean))];
    log.info({ info: `[CRON] Found ${cities.length} unique cities — building CITY catalogs...` });

    let cityBuilt = 0;
    let cityFailed = 0;

    for (let i = 0; i < cities.length; i++) {
      const city = cities[i];
      try {
        log.info({ info: `[CRON] [CITY ${i + 1}/${cities.length}] ${city} — building catalog` });
        await buildCityCatalog(city);
        cityBuilt++;
      } catch (error) {
        cityFailed++;
        log.error({
          error: `[CRON] CITY ${city} — FAILED (skipping to next)`,
          message: error.message,
        });
      }
      if (i < cities.length - 1) {
        await delay(DELAY_MS);
      }
    }

    /* -------- STEP 5: PROCESS STATE CATALOGS -------- */
    /* Aggregate CITY catalogs into STATE-level catalogs */

    const states = [...new Set(shopLocations.map((s) => s?.state).filter(Boolean))];
    log.info({ info: `[CRON] Found ${states.length} unique states — building STATE catalogs...` });

    let stateBuilt = 0;
    let stateFailed = 0;

    for (let i = 0; i < states.length; i++) {
      const state = states[i];
      try {
        log.info({ info: `[CRON] [STATE ${i + 1}/${states.length}] ${state} — building catalog` });
        await buildStateCatalog(state);
        stateBuilt++;
      } catch (error) {
        stateFailed++;
        log.error({
          error: `[CRON] STATE ${state} — FAILED (skipping to next)`,
          message: error.message,
        });
      }
      if (i < states.length - 1) {
        await delay(DELAY_MS);
      }
    }

    /* -------- STEP 6: PROCESS COUNTRY CATALOG -------- */
    /* Aggregate all STATE catalogs into a single COUNTRY catalog */

    let countryBuilt = false;
    try {
      log.info({ info: '[CRON] Building COUNTRY catalog (India)...' });
      await buildCountryCatalog();
      countryBuilt = true;
    } catch (error) {
      log.error({
        error: '[CRON] COUNTRY catalog — FAILED',
        message: error.message,
      });
    }

    /* -------- STEP 7: SYNC UNVERIFIED SHOPS -------- */
    /* Now that all geographic catalogs (PINCODE/CITY/STATE/COUNTRY) are fresh, */
    /* generate profile.json catalogs for unverified Google-imported shops. */

    let unverifiedResult = null;
    try {
      log.info({ info: '[CRON] Starting unverified shop sync...' });
      unverifiedResult = await syncUnverifiedShops();

      // Log detailed failure reasons from unverified sync
      if (unverifiedResult?.logs?.length) {
        const errorLogs = unverifiedResult.logs.filter(l => l.level === 'error' || l.level === 'warn');
        if (errorLogs.length > 0) {
          log.warn({
            warn: `[CRON] Unverified sync had ${errorLogs.length} warnings/errors:`,
            details: errorLogs.map(l => `Shop ${l.shopId}: ${l.message}`).join(' | '),
          });
        }
      }

      log.info({
        info: `[CRON] Unverified sync complete — total: ${unverifiedResult?.totalShops || 0}, processed: ${unverifiedResult?.processed || 0}, failed: ${unverifiedResult?.failed || 0}`,
      });
    } catch (error) {
      log.error({
        error: '[CRON] Unverified shop sync — FAILED',
        errorName: error.name,
        message: error.message,
        stack: error.stack,
      });
    }

    /* -------- STEP 8: SUMMARY -------- */

    log.info({
      info: `[CRON] === FINAL SUMMARY ===
  PINCODE    — new: ${newBuilds}, retried: ${retried}, skipped: ${skipped}, failed: ${failed}
  CITY       — built: ${cityBuilt}, failed: ${cityFailed}
  STATE      — built: ${stateBuilt}, failed: ${stateFailed}
  COUNTRY    — ${countryBuilt ? 'SUCCESS' : 'FAILED'}
  UNVERIFIED — processed: ${unverifiedResult?.processed || 0}, failed: ${unverifiedResult?.failed || 0}`,
    });

  } catch (error) {
    log.error({
      error: '[CRON] Fatal error',
      message: error.message,
    });
  } finally {
    isRunning = false;
  }
};

/* ---------------- CRON CONTROL ---------------- */

// Start cron manually (will run at 2 AM daily)
const startGeoCatalogJob = () => {
  if (isStarted) {
    return;
  }

  cronTask = cron.schedule(
    '0 2 * * *', // 2 AM IST
    async () => {
      try {
        await runGeoCatalogJobOnce();
      } catch (error) {
        log.error({
          error: '[CRON] Cron execution failed',
          message: error.message,
        });
      }
    },
    {
      scheduled: true,
      timezone: 'Asia/Kolkata',
    }
  );

  isStarted = true;

  log.info({ info: '[CRON] Scheduled at 2:00 AM IST' });
};

// Optional: stop cron manually
const stopGeoCatalogJob = () => {
  if (cronTask) {
    cronTask.stop();
    isStarted = false;
    log.info({ info: '[CRON] Stopped' });
  }
};

/* ---------------- EXPORTS ---------------- */

module.exports = {
  runGeoCatalogJobOnce,
  startGeoCatalogJob,
  stopGeoCatalogJob,
};
```

---

### File 15: `backend/catalogue_mgmt_service/src/apis/routes/index.js`

**Why the code is there & What it is doing:**
- **Purpose:** The central aggregator for all Express routes within the `catalogue_mgmt_service`.
- **Integration:** Imports the `v1/geo.js` router and mounts it to the global middleware chain, exposing the new geographic endpoints at `http://localhost:2210/cms/apis/v1/geo`.

**The Full Code:**
```js
const express = require('express');

const {
  node: { buildNumber, serviceName },
} = require('@config');

const { HttpResponseHandler, Logger: log } = require('sarvm-utility');

const v1Routes = require('./v1');
const router = express.Router();

// Health Check
router.get('/healthcheck', (req, res) => {
  log.info({ info: 'inside health check' });
  const data = {
    ts: new Date(),
    buildNumber,
    serviceName,
  };
  return HttpResponseHandler.success(req, res, data);
});

router.use('/v1', v1Routes);

router.use('*', (req, res) => {
  return HttpResponseHandler.success(req, res, 'Invalid Request');
});

module.exports = router;

```

---

### File 16: `backend/catalogue_mgmt_service/src/InitApp/index.js`

**Why the code is there & What it is doing:**
- **Purpose:** The core application bootstrap and initialization module.
- **Setup:** Establishes PostgreSQL/MongoDB connections and configures global Express middleware.
- **Cron Activation:** Explicitly imports and invokes `startGeoCatalogJob()`, guaranteeing the nightly 2:00 AM background job is scheduled the moment the backend spins up.

**The Full Code:**
```js
const {
  Logger: log,
  ErrorHandler: { BaseError, INTERNAL_SERVER_ERROR, PAGE_NOT_FOUND_ERROR },
  ReqLogger,
  AuthManager,
} = require('sarvm-utility');
require('dotenv').config();
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
