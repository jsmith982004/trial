# Geo-Intelligent Auto Catalog System Full Code

## Rollout Plan

This implementation should be executed in **2 phases**.

### Phase 1: Testing Only For Single Pincode `560100`

Purpose:

- prove the aggregation logic works
- validate category grouping
- validate top-product generation
- validate Mongo insert into `geo_catalogs`
- validate `POST /geo/test/pincode`

In this phase:

- only run catalog build for `560100`
- use `retailercatalog` as primary source
- use fallback mock category data if real data is too low
- do not depend on Gemini

Main entrypoint for this phase:

- `buildPincodeCatalog('560100')`
- API:
  - `POST http://localhost:2210/cms/apis/geo/test/pincode`

Expected result:

- one `geo_catalogs` document with `level = PINCODE`
- `pincode = 560100`
- multiple categories
- multiple products inside each category

### Phase 2: Full Production-Style Implementation

Purpose:

- expand from single pincode to all pincodes
- add hierarchy fallback:
  - `PINCODE -> CITY -> STATE -> COUNTRY`
- add nightly cron at `2:00 AM`
- apply geo catalog to shops using `/geo/apply`
- optionally enrich fallback generation with Gemini API

In this phase:

- cron runs every day at `2 AM`
- all shop pincodes are processed
- city/state/country catalogs are rebuilt after pincode generation
- Gemini is used only for enrichment/fallback, not as primary source of truth

---

## What To Test First

Test order should be:

1. local DB connections
2. `POST /geo/test/pincode` for `560100`
3. Mongo `geo_catalogs` insert
4. `POST /geo/apply`
5. Mongo `customcatalog` insert
6. cron execution
7. Gemini integration

## `backend/catalogue_mgmt_service/src/apis/utils/normalizeProduct.js`

What this code does:

- normalizes retailer product names before counting frequency
- removes unit tokens like `500ml`, `1kg`, `200 g`
- removes punctuation and numbers
- makes product names comparable across shops

Use case:

- `"Amul Gold Milk 500ml"`
- `"Amul Gold Milk - 500 ML"`
- `"amul gold milk 0.5 l"`

All become:

- `"amul gold milk"`

```js
const UNIT_PATTERN =
  /\b\d+(?:\.\d+)?\s?(?:ml|l|ltr|litre|liter|g|gm|gram|grams|kg|kgs)\b|\b(?:ml|l|ltr|litre|liter|g|gm|gram|grams|kg|kgs)\b/gi;

const normalizeProduct = (value = '') =>
  String(value)
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(UNIT_PATTERN, ' ')
    .replace(/\b\d+(?:\.\d+)?\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

module.exports = normalizeProduct;
```

## `backend/catalogue_mgmt_service/src/apis/models/mongoCatalog/geoCatalogSchema.js`

What this code does:

- creates the new Mongo collection `geo_catalogs`
- stores multiple categories in one document
- stores multiple products inside each category
- supports hierarchy levels:
  - `PINCODE`
  - `CITY`
  - `STATE`
  - `COUNTRY`

Why this structure:

- one document per geo unit is easier to fetch
- fallback lookup becomes simple
- category-wise top products remain grouped
- indexes support fast pincode lookup

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

## `backend/catalogue_mgmt_service/src/apis/services/v1/ai.service.js`

What this code does:

- provides fallback product lists by category
- provides a common place to add AI-backed enrichment later
- in current version it is **mock-only**

Phase 1 behavior:

- no external API call
- fallback products are static

Phase 2 behavior:

- Gemini API can be added here
- Gemini should be used only if:
  - real source data is too sparse
  - category needs enriched candidate product names
  - normalization suggestions are needed

Suggested Phase 2 Gemini methods to add here:

- `getGeminiFallbackProducts(categoryName)`
- `normalizeNamesWithGemini(names)`
- `expandCategoryCandidates(categoryName, existingProducts)`

Gemini should **not** replace:

- `retailercatalog`
- `products`
- `categories`

Gemini should only assist fallback/enrichment.

```js
const fallbackCatalog = {
  dairy: [
    'milk',
    'curd',
    'butter',
    'paneer',
    'cheese',
    'ghee',
    'buttermilk',
    'flavoured milk',
    'cream',
    'yogurt',
  ],
  snacks: [
    'chips',
    'biscuits',
    'namkeen',
    'kurkure',
    'mixture',
    'cookies',
    'nachos',
    'popcorn',
    'cracker',
    'wafer',
  ],
  beverages: [
    'water',
    'soft drinks',
    'juice',
    'tea',
    'coffee',
    'energy drink',
    'soda',
    'lassi',
    'cold coffee',
    'iced tea',
  ],
  staples: [
    'rice',
    'atta',
    'toor dal',
    'moong dal',
    'salt',
    'sugar',
    'oil',
    'poha',
    'rava',
    'suji',
  ],
  bakery: [
    'bread',
    'bun',
    'rusk',
    'cake',
    'muffin',
    'pav',
    'khari',
    'toast',
    'brown bread',
    'cookies',
  ],
  personal_care: [
    'soap',
    'shampoo',
    'toothpaste',
    'face wash',
    'body wash',
    'deo',
    'talc',
    'moisturizer',
    'toothbrush',
    'hair oil',
  ],
};

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

module.exports = {
  normalizeNames: (names = [], normalizer) => names.map((name) => normalizer(name)).filter(Boolean),
  getFallbackProducts,
};
```

## `backend/catalogue_mgmt_service/src/apis/services/v1/shopGeo.service.js`

What this code does:

- resolves shop location metadata required for pincode grouping
- fetches real shop geo details from RMS APIs
- falls back to local Mongo collections if remote APIs are unavailable

Why this exists:

- `retailercatalog` itself does not store pincode/city/state/country
- pincode must be resolved from shop metadata

Main functions:

- `getShopLocations(shopIds)`
  - resolve shop -> pincode/city/state/country
- `getAllShopLocations()`
  - used by cron for all shops
- `getShopsByPincode(pincode)`
  - used by Phase 1 test flow
- `getShopLocation(shopId)`
  - used by `/geo/apply`

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

  if (!shopId) {
    return null;
  }

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
  if (!shopIds.length || !loadBalancer) {
    return [];
  }

  try {
    const response = await axios({
      method: 'get',
      url: `${loadBalancer}/rms/apis/v2/shop/getPGShopDetails/${shopIds.join(',')}`,
      timeout: 4000,
      headers: {
        Authorization: `Bearer ${system_token}`,
      },
    });

    return (response?.data?.data || []).map(normalizeRecord).filter(Boolean);
  } catch (error) {
    log.warn({ warn: 'Geo shop remote lookup failed, error: error.message' });
    return [];
  }
};

const fetchFromLocalCollections = async (shopIds = []) => {
  if (!shopIds.length || !mongoose.connection?.db) {
    return [];
  }

  const candidateCollections = ['shops', 'shopdetails', 'shopdetail', 'shop_meta', 'shopmeta', 'shopmetadata'];

  try {
    const existingCollections = await mongoose.connection.db.listCollections().toArray();
    const collectionNames = new Set(existingCollections.map((collection) => collection.name));
    const records = [];

    for (const collectionName of candidateCollections) {
      if (!collectionNames.has(collectionName)) {
        continue;
      }

      const collection = mongoose.connection.db.collection(collectionName);
      const docs = await collection
        .find({
          $or: [{ shopId: { $in: shopIds } }, { shop_id: { $in: shopIds } }],
        })
        .toArray();

      docs.forEach((doc) => {
        const normalized = normalizeRecord(doc);

        if (normalized) {
          records.push(normalized);
        }
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
    if (!record?.shopId || map.has(record.shopId)) {
      return;
    }

    map.set(record.shopId, record);
  });

  return Array.from(map.values());
};

const getShopLocations = async (shopIds = []) => {
  const normalizedIds = [...new Set(shopIds.map((shopId) => Number(shopId)).filter(Boolean))];
  const allRecords = [];

  for (const chunk of chunkArray(normalizedIds)) {
    const remoteRecords = await fetchFromRemote(chunk);
    const missingIds = chunk.filter(
      (shopId) => !remoteRecords.some((record) => Number(record.shopId) === Number(shopId)),
    );
    const localRecords = missingIds.length ? await fetchFromLocalCollections(missingIds) : [];

    allRecords.push(...remoteRecords, ...localRecords);
  }

  return dedupeByShopId(allRecords);
};

const getAllRetailerShopIds = async () => {
  const shopIds = await RetailerCatalog.distinct('shopId', { shopId: { $ne: null } });
  return shopIds.map((shopId) => Number(shopId)).filter(Boolean);
};

const getAllShopLocations = async () => getShopLocations(await getAllRetailerShopIds());

const getShopsByPincode = async (pincode) => {
  const records = await getAllShopLocations();
  return records.filter((record) => String(record.pincode) === String(pincode));
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

## `backend/catalogue_mgmt_service/src/apis/services/v1/pincodeCatalogBuilder.service.js`

What this code does:

- this is the main Phase 1 builder
- takes one pincode, for example `560100`
- finds all shops in that pincode
- finds all retailer catalog rows for those shops
- extracts product name and category
- normalizes names
- counts frequency
- returns top products category-wise
- stores the result in `geo_catalogs`

This file is the core of:

- `POST /geo/test/pincode`

Detailed flow:

1. shop lookup:
   - `shopGeoService.getShopsByPincode(pincode)`
2. retailer product fetch:
   - `RetailerCatalog.find({ shopId: { $in: shopIds } })`
3. name extraction:
   - `retailercatalog.catalog.prdNm`
4. category extraction:
   - `retailercatalog.category`
   - else first segment of `catalog.catPnm`
5. normalization:
   - `normalizeProduct()`
6. category grouping:
   - `{ dairy: { amul gold milk: 10 } }`
7. sort by descending count
8. take top N
9. store in Mongo
10. if too little real data:
   - use fallback categories from `ai.service.js`

Why fallback is needed:

- some pincodes may have low real catalog coverage
- Phase 1 still requires multiple categories and multiple products per category
- fallback helps validate the full flow end-to-end

Important Phase 1 rule:

- test only with `560100`

```js
const { Types } = require('mongoose');
const { Logger: log } = require('sarvm-utility');

const RetailerCatalog = require('../../models/mongoCatalog/retailerSchema');
const GeoCatalog = require('../../models/mongoCatalog/geoCatalogSchema');
const Product = require('../../models/mongoCatalog/productSchema');
const Category = require('../../models/mongoCatalog/categorySchema');
const normalizeProduct = require('../../utils/normalizeProduct');
const aiService = require('./ai.service');
const shopGeoService = require('./shopGeo.service');

const TOP_PRODUCTS_LIMIT = 10;

const getCategoryName = (retailerDoc, productDoc) => {
  const catalog = retailerDoc?.catalog || {};
  const rawCategory =
    retailerDoc?.category ||
    catalog?.category ||
    catalog?.catPnm ||
    productDoc?.catPnm ||
    '';

  return String(rawCategory)
    .split('/')[0]
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
};

const getCategorySeedList = async () => {
  const [productCategories, mongoCategories] = await Promise.all([
    Product.aggregate([
      {
        $project: {
          category: { $arrayElemAt: [{ $split: ['$catPnm', '/'] }, 0] },
        },
      },
      {
        $match: {
          category: { $nin: [null, ''] },
        },
      },
      {
        $group: {
          _id: '$category',
        },
      },
      {
        $project: {
          _id: 0,
          name: { $toLower: '$_id' },
        },
      },
    ]),
    Category.aggregate([
      {
        $project: {
          name: { $toLower: '$name' },
        },
      },
      {
        $match: {
          name: { $nin: [null, ''] },
        },
      },
      {
        $group: {
          _id: '$name',
        },
      },
      {
        $project: {
          _id: 0,
          name: '$_id',
        },
      },
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
};

const buildFallbackCategories = async () => {
  const categorySeeds = await getCategorySeedList();
  const fallback = aiService.getFallbackProducts(categorySeeds);

  return Object.entries(fallback).map(([name, products]) => ({
    name,
    products: products.slice(0, TOP_PRODUCTS_LIMIT).map((productName, index) => ({
      name: normalizeProduct(productName),
      count: Math.max(1, TOP_PRODUCTS_LIMIT - index),
    })),
  }));
};

const mapCountsToCategories = (categoryProductCounts) =>
  Object.entries(categoryProductCounts)
    .map(([name, products]) => ({
      name,
      products: Object.entries(products)
        .map(([productName, count]) => ({ name: productName, count }))
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
        .slice(0, TOP_PRODUCTS_LIMIT),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

const buildPincodeCatalog = async (pincode) => {
  const normalizedPincode = String(pincode);
  const shops = await shopGeoService.getShopsByPincode(normalizedPincode);
  const shopIds = shops.map((shop) => Number(shop.shopId)).filter(Boolean);

  let categories = [];
  let usedFallback = false;

  if (shopIds.length) {
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
      ? await Product.find({ _id: { $in: productIds } })
          .select('_id catPnm prdNm')
          .lean()
          .exec()
      : [];

    const productMap = new Map(masterProducts.map((product) => [String(product._id), product]));
    const categoryProductCounts = {};

    retailerProducts.forEach((retailerDoc) => {
      const masterProduct = productMap.get(String(retailerDoc?.catalog?._id));
      const productName = normalizeProduct(retailerDoc?.catalog?.prdNm || masterProduct?.prdNm || '');
      const categoryName = getCategoryName(retailerDoc, masterProduct);

      if (!productName || !categoryName) {
        return;
      }

      categoryProductCounts[categoryName] = categoryProductCounts[categoryName] || {};
      categoryProductCounts[categoryName][productName] =
        (categoryProductCounts[categoryName][productName] || 0) + 1;
    });

    categories = mapCountsToCategories(categoryProductCounts);

    const uniqueProducts = categories.reduce((count, category) => count + category.products.length, 0);
    if (categories.length < 2 || uniqueProducts < 5) {
      usedFallback = true;
      categories = await buildFallbackCategories();
    }
  } else {
    usedFallback = true;
    categories = await buildFallbackCategories();
  }

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
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    },
  );

  log.info({
    info: 'Geo pincode catalog built',
    pincode: normalizedPincode,
    categories: categories.length,
    usedFallback,
  });

  return {
    success: true,
    usedFallback,
    shopCount: shopIds.length,
    categories: document.categories,
    document,
  };
};

module.exports = {
  buildPincodeCatalog,
};
```

## `backend/catalogue_mgmt_service/src/apis/services/v1/geoHierarchy.service.js`

What this code does:

- this is the Phase 2 service
- rebuilds hierarchy catalogs above pincode level
- provides fallback resolution logic
- applies top products into `customcatalog`

This file handles:

- pincode -> city -> state -> country fallback
- `/geo/apply`
- hierarchy rebuild after cron execution

Detailed responsibilities:

### `rebuildHierarchyCatalogs()`

- reads all `PINCODE` docs from `geo_catalogs`
- groups them by city
- groups them by state
- groups them by country
- aggregates product counts
- writes merged documents for:
  - `CITY`
  - `STATE`
  - `COUNTRY`

### `getGeoCatalogWithFallback()`

Lookup order:

1. exact pincode
2. city
3. state
4. country

### `applyGeoCatalogToShop()`

- resolve best geo catalog
- flatten category products
- write them into `customcatalog`
- mark:
  - `productNameStatus = UNVERIFIED`

When to test this:

- only after `POST /geo/test/pincode` is working
- and after a matching `geo_catalogs` document exists

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

      if (!categoryName) {
        return;
      }

      if (!categoryMap.has(categoryName)) {
        categoryMap.set(categoryName, new Map());
      }

      const productMap = categoryMap.get(categoryName);

      (category?.products || []).forEach((product) => {
        const productName = String(product?.name || '').trim().toLowerCase();

        if (!productName) {
          return;
        }

        productMap.set(productName, (productMap.get(productName) || 0) + Number(product?.count || 0));
      });
    });
  });

  return Array.from(categoryMap.entries())
    .map(([name, productMap]) => ({
      name,
      products: Array.from(productMap.entries())
        .map(([productName, count]) => ({ name: productName, count }))
        .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
        .slice(0, 10),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
};

const upsertGeoLevel = async (filter, payload) =>
  GeoCatalog.findOneAndUpdate(
    filter,
    {
      $set: payload,
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    },
  );

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
      {
        level: 'CITY',
        city: source.city,
        state: source.state || null,
        country: source.country || 'India',
        categories: aggregateCategories(documents),
      },
    );
  }

  for (const [, documents] of stateGroups.entries()) {
    const source = locationByPincode.get(String(documents[0].pincode)) || documents[0];
    await upsertGeoLevel(
      { level: 'STATE', state: source.state },
      {
        level: 'STATE',
        state: source.state,
        country: source.country || 'India',
        categories: aggregateCategories(documents),
      },
    );
  }

  for (const [, documents] of countryGroups.entries()) {
    const source = locationByPincode.get(String(documents[0].pincode)) || documents[0];
    await upsertGeoLevel(
      { level: 'COUNTRY', country: source.country || 'India' },
      {
        level: 'COUNTRY',
        country: source.country || 'India',
        categories: aggregateCategories(documents),
      },
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
    const pincodeCatalog = await GeoCatalog.findOne({ level: 'PINCODE', pincode: String(pincode) })
      .sort({ updatedAt: -1 })
      .lean()
      .exec();

    if (pincodeCatalog) {
      return pincodeCatalog;
    }
  }

  if (city) {
    const cityCatalog = await GeoCatalog.findOne({ level: 'CITY', city })
      .sort({ updatedAt: -1 })
      .lean()
      .exec();

    if (cityCatalog) {
      return cityCatalog;
    }
  }

  if (state) {
    const stateCatalog = await GeoCatalog.findOne({ level: 'STATE', state })
      .sort({ updatedAt: -1 })
      .lean()
      .exec();

    if (stateCatalog) {
      return stateCatalog;
    }
  }

  if (country) {
    return GeoCatalog.findOne({ level: 'COUNTRY', country })
      .sort({ updatedAt: -1 })
      .lean()
      .exec();
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
    return {
      success: false,
      message: 'No geo catalog found for the supplied hierarchy',
    };
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

## `backend/catalogue_mgmt_service/src/apis/controllers/v1/geo.js`

What this code does:

- exposes service methods to HTTP routes
- keeps response shape API-friendly

Endpoints handled:

- `POST /geo/test/pincode`
- `POST /geo/apply`
- `GET /geo/catalog`

Testing note:

- for Postman validation, Phase 1 starts with `POST /geo/test/pincode`

```js
const { Logger: log } = require('sarvm-utility');

const { buildPincodeCatalog } = require('../../services/v1/pincodeCatalogBuilder.service');
const {
  applyGeoCatalogToShop,
  getGeoCatalogWithFallback,
} = require('../../services/v1/geoHierarchy.service');
const shopGeoService = require('../../services/v1/shopGeo.service');

const testPincodeCatalog = async (req, res, next) => {
  try {
    const { pincode } = req.body;
    const result = await buildPincodeCatalog(pincode);
    return res.status(200).json({
      success: true,
      usedFallback: result.usedFallback,
      categories: result.categories,
    });
  } catch (error) {
    log.error({ error: 'Error while testPincodeCatalog', details: error.message });
    next(error);
  }
};

const applyGeoCatalog = async (req, res, next) => {
  try {
    const { shopId, pincode } = req.body;
    const result = await applyGeoCatalogToShop({ shopId, pincode });
    return res.status(200).json(result);
  } catch (error) {
    log.error({ error: 'Error while applyGeoCatalog', details: error.message });
    next(error);
  }
};

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

    return res.status(200).json({
      success: true,
      catalog,
    });
  } catch (error) {
    log.error({ error: 'Error while getResolvedGeoCatalog', details: error.message });
    next(error);
  }
};

module.exports = {
  testPincodeCatalog,
  applyGeoCatalog,
  getResolvedGeoCatalog,
};
```

## Better API Testing Option: Test By `shopId`

Yes, this is a better testing flow.

Why:

- in real usage you usually know the `shopId`
- shop metadata can be used to resolve pincode automatically
- Postman can show:
  - resolved shop
  - resolved pincode
  - top products by category

Recommended approach:

1. send `shopId`
2. backend fetches shop geo details
3. backend extracts `pincode`
4. backend builds geo catalog for that pincode
5. response includes:
   - `shopId`
   - `pincode`
   - `categories`

Suggested new endpoint:

- `POST /geo/test/shop`

Suggested request body:

```json
{
  "shopId": 1234
}
```

Suggested response:

```json
{
  "success": true,
  "shopId": 1234,
  "pincode": "560100",
  "city": "Bengaluru",
  "state": "Karnataka",
  "categories": [
    {
      "name": "dairy",
      "products": [
        { "name": "amul gold milk", "count": 120 },
        { "name": "nandini milk", "count": 90 }
      ]
    }
  ]
}
```

This is useful for Postman because you do not need to manually know the pincode first.

## Add This In `backend/catalogue_mgmt_service/src/apis/controllers/v1/geo.js`

What this code does:

- accepts `shopId`
- resolves shop location
- gets pincode from shop metadata
- calls existing `buildPincodeCatalog()`
- returns top products

Add:

```js
const testShopCatalog = async (req, res, next) => {
  try {
    const { shopId } = req.body;
    const location = await shopGeoService.getShopLocation(Number(shopId));

    if (!location?.pincode) {
      return res.status(404).json({
        success: false,
        message: 'Pincode not found for the given shopId',
      });
    }

    const result = await buildPincodeCatalog(location.pincode);

    return res.status(200).json({
      success: true,
      shopId: Number(shopId),
      pincode: location.pincode,
      city: location.city || null,
      state: location.state || null,
      categories: result.categories,
      usedFallback: result.usedFallback,
    });
  } catch (error) {
    log.error({ error: 'Error while testShopCatalog', details: error.message });
    next(error);
  }
};
```

And export it:

```js
module.exports = {
  testPincodeCatalog,
  testShopCatalog,
  applyGeoCatalog,
  getResolvedGeoCatalog,
};
```

## `backend/catalogue_mgmt_service/src/apis/routes/v1/geo.js`

What this code does:

- creates the new `/geo` route group
- mounts geo APIs under CMS base path

Final URLs become:

- `POST http://localhost:2210/cms/apis/geo/test/pincode`
- `POST http://localhost:2210/cms/apis/geo/apply`
- `GET http://localhost:2210/cms/apis/geo/catalog`

```js
const express = require('express');
const { Logger: log } = require('sarvm-utility');

const GeoController = require('../../controllers/v1/geo');

const router = express.Router();

router.post('/test/pincode', async (req, res, next) => {
  log.info({ info: 'Geo route :: test pincode catalog' });
  return GeoController.testPincodeCatalog(req, res, next);
});

router.post('/apply', async (req, res, next) => {
  log.info({ info: 'Geo route :: apply geo catalog' });
  return GeoController.applyGeoCatalog(req, res, next);
});

router.get('/catalog', async (req, res, next) => {
  log.info({ info: 'Geo route :: get resolved geo catalog' });
  return GeoController.getResolvedGeoCatalog(req, res, next);
});

module.exports = router;
```

## Add This In `backend/catalogue_mgmt_service/src/apis/routes/v1/geo.js`

What this route does:

- allows Postman testing directly by `shopId`

Add:

```js
router.post('/test/shop', async (req, res, next) => {
  log.info({ info: 'Geo route :: test shop catalog' });
  return GeoController.testShopCatalog(req, res, next);
});
```

## `backend/catalogue_mgmt_service/src/jobs/geoCatalog.job.js`

What this code does:

- runs full geo-catalog generation every night at `2:00 AM`
- processes all shop pincodes
- rebuilds higher-level geo hierarchy catalogs after pincode generation

Cron schedule:

```txt
0 2 * * *
```

Meaning:

- minute `0`
- hour `2`
- every day

Phase behavior:

- Phase 1:
  - you do **not** need cron first
  - manually test with `POST /geo/test/pincode`
- Phase 2:
  - enable cron and let it generate all geo catalogs nightly

Order inside cron:

1. get all shops
2. collect all unique pincodes
3. build pincode catalog for each pincode
4. rebuild city/state/country hierarchy

Recommended production flow:

- 2 AM cron
- logs success/failure
- can later add metrics for:
  - processed pincodes
  - fallback-used pincodes
  - generated category counts

```js
const cron = require('node-cron');
const { Logger: log } = require('sarvm-utility');

const shopGeoService = require('../apis/services/v1/shopGeo.service');
const { buildPincodeCatalog } = require('../apis/services/v1/pincodeCatalogBuilder.service');
const { rebuildHierarchyCatalogs } = require('../apis/services/v1/geoHierarchy.service');

let isStarted = false;

const runGeoCatalogJobOnce = async () => {
  const shopLocations = await shopGeoService.getAllShopLocations();
  const pincodes = [...new Set(shopLocations.map((shop) => shop?.pincode).filter(Boolean))];

  for (const pincode of pincodes) {
    await buildPincodeCatalog(pincode);
  }

  await rebuildHierarchyCatalogs();

  log.info({
    info: 'Geo catalog job completed',
    pincodesProcessed: pincodes.length,
  });
};

const startGeoCatalogJob = () => {
  if (isStarted) {
    return;
  }

  cron.schedule(
    '0 2 * * *',
    async () => {
      try {
        await runGeoCatalogJobOnce();
      } catch (error) {
        log.error({ error: 'Geo catalog job failed', details: error.message });
      }
    },
    {
      scheduled: true,
      timezone: 'Asia/Kolkata',
    },
  );

  isStarted = true;
};

module.exports = {
  startGeoCatalogJob,
  runGeoCatalogJobOnce,
};
```

## `backend/catalogue_mgmt_service/src/apis/routes/v1/index.js`

What this code does:

- mounts the new geo routes into the main v1 route tree

Without this file update:

- `/geo/test/pincode` will not be reachable

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

## `backend/catalogue_mgmt_service/src/InitApp/index.js`

What this code does:

- starts DB connections
- starts the nightly geo cron job

Why update here:

- this is the app startup hook already used by the service
- best place to initialize recurring background jobs

```js
const {
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
const { startGeoCatalogJob } = require('../jobs/geoCatalog.job');
const consumer = require('../common/aws/index');

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
  await Mongo.connect();
  startGeoCatalogJob();

  // consumer.start()
};

module.exports = init;
```

## `backend/catalogue_mgmt_service/src/apis/models/mongoCatalog/retailerSchema.js`

What this code does:

- adds `shopId` index for faster pincode product fetch

Why important:

- Phase 1 builder queries `retailercatalog` by `shopId`
- cron job may query large shop lists
- this index reduces scan cost

```js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const retailer_Catalog = new Schema(
  {
    shopId: Number,
    retailerId: String,
    guid: String,
    url: String,
    catalog: Object,
    category: String,
  },
  {
    timestamps: true,
  },
);

retailer_Catalog.index({ shopId: 1 });

const retailerCatalog = mongoose.model('retailercatalog', retailer_Catalog);

module.exports = retailerCatalog;
```

## `backend/catalogue_mgmt_service/src/apis/models/mongoCatalog/customCatalogSchema.js`

What this code does:

- extends status enums to allow:
  - `UNVERIFIED`

Why needed:

- `/geo/apply` inserts auto-suggested products
- those product names are not manually approved yet
- requirement says they must be marked:
  - `productNameStatus = "UNVERIFIED"`

```js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const customCatalog = new Schema(
  {
    shopId: Number,
    retailerId: String,
    productName: String,
    productNameStatus: {
      type: String,
      default: 'NEW',
      enum: ['NEW', 'UNVERIFIED', 'ACCEPTED', 'REJECTED'],
    },
    productImage: String,
    productImageStatus: {
      type: String,
      default: 'NEW',
      enum: ['NEW', 'UNVERIFIED', 'ACCEPTED', 'REJECTED'],
    },
    description: {
      type: String,
      default: null,
    },
    productDescriptionStatus: {
      type: String,
      default: 'NEW',
      enum: ['NEW', 'UNVERIFIED', 'ACCEPTED', 'REJECTED'],
    },
    category: String,
    subCategory: String,
    productId: String,
    guid: String,
    retailerName: String,
    requestFlag: {
      type: Boolean,
      default: false,
    },
    updateStatus: {
      type: String,
      default: 'NEW',
      enum: ['NEW', 'APPROVED', 'REJECTED', 'UPDATED'],
    },
  },
  {
    timestamps: true,
  },
);

const requestCustomCatalog = mongoose.model('customCatalog', customCatalog);

module.exports = requestCustomCatalog;
```

## `backend/catalogue_mgmt_service/.lcl.env`

What this config does:

- makes backend run against local Postgres and Mongo
- gives safe local defaults for optional runtime config
- supports testing without production services

Phase 1 use:

- required for local backend startup

Phase 2 use:

- can later add Gemini variables here such as:

```env
GEMINI_API_KEY=your_key
GEMINI_MODEL=gemini-1.5-pro
```

```env
NODE_ENV=development
ENV=dev
BUILD_NUMBER=100

HOST=localhost
HOST_PORT=2210
HOST_SERVICE_NAME=cms

MONGO_DB_HOST=mongodb://127.0.0.1:27017/metadata
MONGO_DB_USER=household_app
MONGO_DB_PASSWORD=ITJKHjCzJgCZFJ8R
MONGO_DB_PORT=27017
MONGO_DB_CLUSTER=cluster0
MONGO_DB_DATABASE=metadata
MONGO_DB_COLLECTION=mastercatalogs

SQL_DB_HOST=localhost
SQL_DB_USER=postgres
SQL_DB_PASSWORD=omkar
SQL_DB_PORT=5432
SQL_DB_NAME=cms
SQL_DB_DIALECT=postgres
SQL_DB_NAME_META=meta

AWS_BUCKET=dev.sarvm.com
AWS_EXPIRATION=52000
LOAD_BALANCER=http://localhost
CDN_URL=https://uat-static.sarvm.ai
CATALOG_FOLDER=catalog_url
QUEUE_URL=http://localhost/queue
ENVIRONMENT=dev
MEDIA_S3=http://localhost/media
TOP_PRODUCTS_LIMIT=10
RADIUS=25
CITY_LAT_LON=[{"city":"Bengaluru","lat":12.9716,"lon":77.5946}]

SYSTEM_TOKEN=your_system_token_here
PINO_LOG_LEVEL='info'
```

## Gemini Phase 2 Add-On

This section is for the later implementation phase.

### Where Gemini should be integrated

Best file:

- `backend/catalogue_mgmt_service/src/apis/services/v1/ai.service.js`

Optional dedicated file if you want cleaner separation:

- `backend/catalogue_mgmt_service/src/apis/services/v1/gemini.service.js`

### What Gemini should do

Allowed use cases:

1. generate fallback products for categories with very low real data
2. suggest normalized product forms for noisy retailer names
3. suggest additional candidate products for categories with insufficient top items

Not allowed as primary source:

- do not use Gemini instead of `retailercatalog`
- do not use Gemini instead of `products`
- do not generate full catalogs blindly without real shop data

### Suggested Gemini flow

1. run normal aggregation from real data
2. check if category is below threshold
3. if below threshold:
   - call Gemini with category context
   - ask for 10 common retail products
4. normalize Gemini output
5. merge into fallback result
6. save into `geo_catalogs`

### Suggested Gemini method shape

```js
async function getGeminiFallbackProducts(categoryName, existingProducts = []) {
  // call Gemini
  // return array of product names
}
```

### Suggested Gemini prompt

```txt
Give me 10 common Indian retail product names for category "dairy".
Return only a JSON array of short product names.
Do not include explanation.
```

### When Gemini should run

- during fallback generation only
- not on every single product record
- ideally once per weak category, not per item

---

## Phase 1 Postman Testing

### Step 1: Start backend

Run:

```bash
cd backend/catalogue_mgmt_service
npm install
npm run lcl
```

Expected base URL:

```txt
http://localhost:2210/cms/apis
```

### Step 2: Test single pincode catalog build

Method:

- `POST`

URL:

```txt
http://localhost:2210/cms/apis/geo/test/pincode
```

Headers:

```txt
Content-Type: application/json
```

Body:

```json
{
  "pincode": "560100"
}
```

Expected response:

- `success = true`
- `categories` array exists
- more than one category exists
- each category has multiple products

### Step 3: Verify Mongo

Check collection:

- `geo_catalogs`

Find document:

```js
db.geo_catalogs.find({ level: "PINCODE", pincode: "560100" }).pretty()
```

Verify:

- `categories.length > 1`
- each category has `products`
- each product has:
  - `name`
  - `count`

### Step 4: If low real data

Expected behavior:

- fallback categories are inserted
- API still returns valid category/product structure

This is acceptable in Phase 1 because goal is to validate flow.

### Alternate Phase 1 Test: By `shopId`

This is the better manual test if you already have a valid shop.

Method:

- `POST`

URL:

```txt
http://localhost:2210/cms/apis/geo/test/shop
```

Headers:

```txt
Content-Type: application/json
```

Body:

```json
{
  "shopId": 1234
}
```

What backend will do:

1. fetch shop metadata
2. resolve pincode from shop
3. build geo catalog for that pincode
4. return top products

Expected response:

- `success = true`
- `shopId` returned
- `pincode` returned
- `categories` returned
- top products visible directly in Postman

This is a more practical validation flow than sending only raw pincode.

---

## Phase 2 Postman Testing

### Step 1: Apply geo catalog to a shop

Method:

- `POST`

URL:

```txt
http://localhost:2210/cms/apis/geo/apply
```

Headers:

```txt
Content-Type: application/json
```

Body:

```json
{
  "shopId": 1234,
  "pincode": "560100"
}
```

Expected response:

```json
{
  "success": true,
  "level": "PINCODE",
  "categories": 5,
  "insertedProducts": 32
}
```

### Step 2: Verify `customcatalog`

Mongo query:

```js
db.customcatalog.find({ shopId: 1234 }).pretty()
```

Verify:

- products inserted
- `productNameStatus = "UNVERIFIED"`
- `category` and `subCategory` filled

### Step 3: Fallback catalog lookup test

Optional endpoint:

- `GET http://localhost:2210/cms/apis/geo/catalog?pincode=560100`

Or:

- `GET http://localhost:2210/cms/apis/geo/catalog?shopId=1234`

Expected:

- if pincode-level doc exists, return PINCODE
- else fallback to CITY
- else STATE
- else COUNTRY

---

## Cron Testing

### Manual cron validation

Before waiting for `2 AM`, you should manually call the builder logic or temporarily invoke:

- `runGeoCatalogJobOnce()`

Expected outcome:

1. all pincodes processed
2. pincode docs created
3. city/state/country docs created

### Production cron expectation

At every `2:00 AM`:

1. job starts
2. fetches all shop locations
3. gets unique pincodes
4. builds pincode catalogs
5. rebuilds hierarchy catalogs
6. logs completion

### What to verify after 2 AM run

Mongo checks:

```js
db.geo_catalogs.find({ level: "PINCODE" }).count()
db.geo_catalogs.find({ level: "CITY" }).count()
db.geo_catalogs.find({ level: "STATE" }).count()
db.geo_catalogs.find({ level: "COUNTRY" }).count()
```

---

## API Test Sequence In Postman

Follow this exact order:

1. `POST /geo/test/shop`
   - best manual test if you know a valid `shopId`
2. `POST /geo/test/pincode`
   - direct pincode test for `560100`
3. Mongo `geo_catalogs` verification
   - confirm saved output
4. `GET /geo/catalog`
   - verify fetch and fallback path
5. `POST /geo/apply`
   - apply results to a shop
6. Mongo `customcatalog` verification
   - confirm `UNVERIFIED` rows inserted
7. cron/manual job validation
   - confirm hierarchy creation

---

## When To Test Which API

### Test `POST /geo/test/shop`

Use this first when:

- you know a valid `shopId`
- you want backend to automatically resolve pincode
- you want top products shown directly in Postman output

This is the most practical manual validation endpoint.

### Test `POST /geo/test/pincode`

Use this first when:

- backend is running
- Mongo is connected
- you want to validate only pincode `560100`

### Test `POST /geo/apply`

Use this only after:

- pincode catalog already exists
- or fallback hierarchy exists

### Test cron/manual hierarchy rebuild

Use this after:

- multiple pincode docs exist
- you are ready for Phase 2

---

## Frontend Phase Use

### Phase 1

Use:

- `geo-catalog-test` page only

Purpose:

- quickly display category/product output from `560100`
- simple manual validation UI

### Phase 2

Later you can:

- integrate geo-suggested products into retailer/admin flows
- add operational dashboard for geo catalog generation status
- add apply button for a selected shop

## `frontend/hha_web/src/app/lib/services/geo-catalog.service.ts`

What this code does:

- calls the local backend directly
- triggers Phase 1 pincode test API

Use this only for:

- manual feature validation
- test screen

Later in Phase 2 you can add:

- `applyGeoCatalog(shopId, pincode)`
- `getResolvedGeoCatalog(shopId, pincode)`

```ts
import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Injectable({
  providedIn: 'root',
})
export class GeoCatalogService {
  private readonly baseUrl = 'http://localhost:2210/cms/apis/geo';

  constructor(private http: HttpClient) {}

  runGeoTest() {
    return this.http.post<{ success: boolean; categories: any[] }>(`${this.baseUrl}/test/pincode`, {
      pincode: '560100',
    });
  }
}
```

## `frontend/hha_web/src/app/pages/geo-catalog-test/geo-catalog-test-routing.module.ts`

What this code does:

- gives the test screen its route module

```ts
import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

import { GeoCatalogTestPage } from './geo-catalog-test.page';

const routes: Routes = [
  {
    path: '',
    component: GeoCatalogTestPage,
  },
];

@NgModule({
  imports: [RouterModule.forChild(routes)],
  exports: [RouterModule],
})
export class GeoCatalogTestPageRoutingModule {}
```

## `frontend/hha_web/src/app/pages/geo-catalog-test/geo-catalog-test.module.ts`

What this code does:

- declares the test page
- wires Angular/Ionic module imports

```ts
import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { IonicModule } from '@ionic/angular';

import { GeoCatalogTestPageRoutingModule } from './geo-catalog-test-routing.module';
import { GeoCatalogTestPage } from './geo-catalog-test.page';

@NgModule({
  imports: [CommonModule, FormsModule, IonicModule, GeoCatalogTestPageRoutingModule],
  declarations: [GeoCatalogTestPage],
})
export class GeoCatalogTestPageModule {}
```

## `frontend/hha_web/src/app/pages/geo-catalog-test/geo-catalog-test.page.ts`

What this code does:

- triggers `runGeoTest()`
- shows loading state
- renders categories from API response

This is only a validation page.

```ts
import { Component } from '@angular/core';
import { GeoCatalogService } from '../../lib/services/geo-catalog.service';

@Component({
  selector: 'app-geo-catalog-test',
  templateUrl: './geo-catalog-test.page.html',
  styleUrls: ['./geo-catalog-test.page.scss'],
  standalone: false,
})
export class GeoCatalogTestPage {
  loading = false;
  categories: any[] = [];
  errorMessage = '';

  constructor(private geoCatalogService: GeoCatalogService) {}

  runGeoTest() {
    this.loading = true;
    this.errorMessage = '';

    this.geoCatalogService.runGeoTest().subscribe({
      next: (response) => {
        this.categories = response?.categories || [];
        this.loading = false;
      },
      error: (error) => {
        this.errorMessage = error?.error?.message || 'Failed to load geo catalog';
        this.loading = false;
      },
    });
  }
}
```

## `frontend/hha_web/src/app/pages/geo-catalog-test/geo-catalog-test.page.html`

What this code does:

- renders category headings
- renders product names and counts
- keeps validation simple for Phase 1

```html
<ion-header>
  <ion-toolbar color="success">
    <ion-title>Geo Catalog Test</ion-title>
  </ion-toolbar>
</ion-header>

<ion-content class="ion-padding">
  <ion-button expand="block" color="success" (click)="runGeoTest()" [disabled]="loading">
    {{ loading ? 'Running...' : 'Run Pincode 560100 Test' }}
  </ion-button>

  <ion-text color="danger" *ngIf="errorMessage">
    <p>{{ errorMessage }}</p>
  </ion-text>

  <ion-list *ngIf="categories.length">
    <ion-item-group *ngFor="let category of categories">
      <ion-item-divider color="light">
        <ion-label>{{ category.name }}</ion-label>
      </ion-item-divider>

      <ion-item *ngFor="let product of category.products">
        <ion-label>
          <h3>{{ product.name }}</h3>
          <p>Count: {{ product.count }}</p>
        </ion-label>
      </ion-item>
    </ion-item-group>
  </ion-list>
</ion-content>
```

## `frontend/hha_web/src/app/pages/geo-catalog-test/geo-catalog-test.page.scss`

What this code does:

- minor display cleanup

```scss
ion-item-divider {
  text-transform: capitalize;
}
```

## `frontend/hha_web/src/app/app-routing.module.ts`

What this code does:

- adds test route:
  - `/geo-catalog-test`

Add this route:

```ts
{
  path: 'geo-catalog-test',
  loadChildren: () => import('./pages/geo-catalog-test/geo-catalog-test.module').then(m => m.GeoCatalogTestPageModule)
}
```

## Run

```bash
cd backend/catalogue_mgmt_service
npm install
npm run lcl
```

```http
POST http://localhost:2210/cms/apis/geo/test/pincode
Content-Type: application/json

{
  "pincode": "560100"
}
```

## Quick Postman URLs

Phase 1:

```txt
POST http://localhost:2210/cms/apis/geo/test/shop
POST http://localhost:2210/cms/apis/geo/test/pincode
```

Phase 2:

```txt
POST http://localhost:2210/cms/apis/geo/apply
GET  http://localhost:2210/cms/apis/geo/catalog?pincode=560100
GET  http://localhost:2210/cms/apis/geo/catalog?shopId=1234
```

