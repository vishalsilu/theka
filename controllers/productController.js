import Product from "../models/Product.js";
import Category from "../models/Category.js";
import Collection from "../models/Collection.js";
import { redisClient } from "../config/redis.js";
import Order from "../models/Order.js";
import { deleteFromCloudinary } from "../config/cloudinary.js";

// --- Cache Invalidation Helper ---
const normalizeCacheId = (value) => {
    if (value === undefined || value === null) return "";
    return String(value);
};

const normalizeCacheName = (value) => {
    if (value === undefined || value === null) return "";
    return String(value).trim().toLowerCase();
};

const safeRedisDel = async (...keys) => {
    const flattened = keys.flat(Infinity).filter(Boolean).map(String);
    if (!flattened.length) return;
    return await redisClient.del(...flattened);
};

const buildProductCacheKeys = ({ collectionId, categoryId, collectionName, categoryName } = {}) => {
    const keys = ["products:all", "products:featured"];
    const normalizedCollectionId = normalizeCacheId(collectionId);
    const normalizedCategoryId = normalizeCacheId(categoryId);
    const normalizedCollectionName = normalizeCacheName(collectionName);
    const normalizedCategoryName = normalizeCacheName(categoryName);

    if (normalizedCategoryId) keys.push(`products:category:${normalizedCategoryId}`);
    if (normalizedCollectionId) keys.push(`products:collection:${normalizedCollectionId}`);
    if (normalizedCollectionName) keys.push(`collectionProducts:${normalizedCollectionName}:lite`);
    if (normalizedCollectionName && normalizedCategoryName) {
        keys.push(`products:${normalizedCollectionName}:${normalizedCategoryName}:lite`);
    }

    return keys;
};

const invalidateProductCache = async (...args) => {
    const payloads = [];

    if (args.length === 1 && typeof args[0] === 'object' && !Array.isArray(args[0])) {
        payloads.push(args[0]);
    } else if (args.length >= 2 && (typeof args[0] !== 'object' || Array.isArray(args[0]))) {
        payloads.push({ categoryId: args[0], collectionId: args[1] });
    } else {
        payloads.push(...args.filter((arg) => typeof arg === 'object' && !Array.isArray(arg)));
    }

    const keys = new Set(["products:all", "products:featured"]);

    payloads.forEach((payload) => {
        buildProductCacheKeys(payload).forEach((key) => {
            if (key) keys.add(key);
        });
    });

    const toDelete = Array.from(keys).filter(Boolean);
    await safeRedisDel(toDelete);

    // Also sweep any product list caches that may still be stale.
    for await (const listKey of redisClient.scanIterator({ MATCH: "products:category:*" })) {
        await safeRedisDel(listKey);
    }
    for await (const listKey of redisClient.scanIterator({ MATCH: "products:collection:*" })) {
        await safeRedisDel(listKey);
    }
    for await (const listKey of redisClient.scanIterator({ MATCH: "products:*:*:lite" })) {
        await safeRedisDel(listKey);
    }
    for await (const listKey of redisClient.scanIterator({ MATCH: "collectionProducts:*" })) {
        await safeRedisDel(listKey);
    }
    for await (const listKey of redisClient.scanIterator({ MATCH: "dynamicFilters:*" })) {
        await safeRedisDel(listKey);
    }
};
// Helper to extract characters for custom SKU generation
const getFirstMidLast = (str) => {
    if (!str || typeof str !== 'string') return 'XXX';
    const cleanStr = str.replace(/\s+/g, '').toUpperCase();
    if (cleanStr.length === 0) return 'XXX';
    if (cleanStr.length === 1) return `${cleanStr[0]}XX`;
    if (cleanStr.length === 2) return `${cleanStr[0]}${cleanStr[1]}X`;
    
    const first = cleanStr[0];
    const last = cleanStr[cleanStr.length - 1];
    const midIndex = Math.floor(cleanStr.length / 2);
    const mid = cleanStr[midIndex];
    
    return `${first}${mid}${last}`;
};

// Cloudinary image URL extractor
const getFileUrl = (file) => {
    if (!file) return '';
    return file.path || file.secure_url || file.url || file.location || '';
};

const parseFormFieldToArray = (field) => {
    if (field === undefined || field === null) return [];
    if (Array.isArray(field)) return field;
    return String(field).split(',').map((item) => item.trim()).filter(Boolean);
};

const buildUploadMappings = (req) => {
    const files = [];
    if (req.files) {
        if (Array.isArray(req.files)) {
            files.push(...req.files);
        } else if (req.files.images) {
            files.push(...req.files.images);
        } else {
            files.push(...Object.values(req.files).flat());
        }
    }

    const variantIndexes = parseFormFieldToArray(req.body.imageVariantIndex || req.body['imageVariantIndex[]']);
    const tokens = parseFormFieldToArray(req.body.imageToken || req.body['imageToken[]']);
    const byToken = {};
    const byVariantIndex = {};

    files.forEach((file, idx) => {
        const url = getFileUrl(file);
        if (!url) return;
        const token = tokens[idx];
        const variantIndex = Number(variantIndexes[idx] ?? 0);
        if (token) byToken[token] = url;
        if (!byVariantIndex[variantIndex]) byVariantIndex[variantIndex] = [];
        byVariantIndex[variantIndex].push(url);
    });

    return { byToken, byVariantIndex };
};

const resolveOrderedImages = (variant = {}, byToken = {}) => {
    const rawImages = Array.isArray(variant.images) ? variant.images : [];
    return rawImages.map((image) => {
        if (typeof image !== 'string') return null;
        return image.startsWith('__NEWFILE__') ? (byToken[image] || null) : image;
    }).filter(Boolean);
};

const combineVariantImages = (variant = {}, existingVariant = {}, index, byToken, byVariantIndex) => {
    const orderedImages = resolveOrderedImages(variant, byToken);
    const fallbackNewImages = byVariantIndex[index] || [];
    const sourceImages = orderedImages.length > 0 ? orderedImages : Array.isArray(variant.images) ? variant.images : existingVariant?.images || [];
    return [...sourceImages, ...fallbackNewImages.filter((url) => !sourceImages.includes(url))];
};

// --- Main Controller Action ---

export const createProduct = async (req, res) => {
    try {
        let productData = { ...req.body };
console.log(productData);

        // 1. Parse JSON strings safely from multi-part FormData payload
        const fieldsToParse = ['variants', 'discount', 'collectionInfo', 'categoryInfo', 'timeline'];
        fieldsToParse.forEach(field => {
            const value = productData[field];
            if (typeof value === 'string') {
                if (value.trim() === 'undefined' || value.trim() === 'null' || !value.trim()) {
                    productData[field] = field === 'variants' ? [] : null;
                } else {
                    try {
                        productData[field] = JSON.parse(value);
                    } catch (parseErr) {
                        throw new Error(`Invalid JSON structure inside field "${field}": ${parseErr.message}`);
                    }
                }
            }
        });
                     
        // Resolve Reference IDs safely
        const resolveReferenceInfo = async (info, Model, fieldName) => {
            console.log(info);
            
            if (!info || (!info.id && !info.name)) {
                throw new Error(`Missing required ${fieldName}. Please select a valid category and collection.`);
            }

            let record = null;
            if (info.id) {
                try {
                    record = await Model.findById(info.id).lean();
                } catch (err) {
                    // Ignore cast failure and fall back to lookup by name
                }
            }
            if (!record && info.name) {
                record = await Model.findOne({ name: info.name }).lean();
            }
            if (!record) {
                throw new Error(`Invalid ${fieldName}: unable to resolve ${fieldName} by id or name.`);
            }
            return { id: record._id, name: record.name };
        };
console.log(productData.collectionInfo, productData.categoryInfo, "HAHAHA");


        productData.collectionInfo = await resolveReferenceInfo(productData.collectionInfo, Collection, 'collectionInfo');
        productData.categoryInfo = await resolveReferenceInfo(productData.categoryInfo, Category, 'categoryInfo');

        // 2. Capture nested attributes to satisfy Mongoose 'required: true' limits
        const firstVariant = productData.variants?.[0] || {};
        const firstSizeInfo = firstVariant.sizes?.[0] || {};

        productData.fit = (productData.fit || firstVariant.fit || firstSizeInfo.fit || "Regular").trim();
        productData.pattern = (productData.pattern || firstVariant.pattern || firstSizeInfo.pattern || "Solid").trim();
        productData.fabric = (productData.fabric || firstVariant.fabric || firstSizeInfo.fabric || "Cotton").trim();
        productData.sizeType = (productData.sizeType || firstVariant.sizeType || "Alpha").trim();

        // 3. Construct Uniform Engineered SKU Identifier
        const collectionName = productData.collectionInfo?.name || "";
        const categoryName = productData.categoryInfo?.name || "";

        const collectionPart = getFirstMidLast(collectionName); 
        const categoryPart = getFirstMidLast(categoryName);   
        
        const fitLetter = productData.fit[0]?.toUpperCase() || 'X';
        const patternLetter = productData.pattern[0]?.toUpperCase() || 'X';
        const fabricLetter = productData.fabric[0]?.toUpperCase() || 'X';
        const attributesPart = `${fitLetter}${patternLetter}${fabricLetter}`;

        const randomTail = Math.floor(100000 + Math.random() * 900000);
        const generatedSkuId = `${collectionPart}-${categoryPart}-${attributesPart}-${randomTail}`;
        
        productData.id = generatedSkuId;
        productData.sku = generatedSkuId;

        // =========================================================================
        // 4. UPDATED: Preserve explicit variant image order and map new uploads into slots
        // =========================================================================
        const baseId = Math.floor(Date.now() / 1000);
        const { byToken: uploadedByToken, byVariantIndex: uploadedByVariantIndex } = buildUploadMappings(req);

        if (productData.variants && productData.variants.length > 0) {
            productData.variants = productData.variants.map((variant, index) => {
                let updatedVariant = { ...variant };
                updatedVariant.id = Number(`${baseId.toString().slice(-5)}${index}`);
                updatedVariant.images = combineVariantImages(updatedVariant, {}, index, uploadedByToken, uploadedByVariantIndex);

                if (updatedVariant.images.length === 0) {
                    updatedVariant.images = ["https://placehold.co/600x600?text=No+Image+Available"];
                }

                return updatedVariant;
            });
        } else {
            const fallbackImages = uploadedByVariantIndex[0] || [];
            productData.variants = [{
                id: baseId,
                color: "Default",
                images: fallbackImages.length ? fallbackImages : ["https://placehold.co/600x600?text=No+Image+Available"],
                isDefault: true,
                sizes: []
            }];
        }

        // 6. Save Product Document smoothly to MongoDB Atlas
        const newProduct = new Product(productData);
        await newProduct.save();

        // 7. Evict Redis Caching keys if clean function exists
        if (typeof invalidateProductCache === 'function') {
            const payload = {
                categoryId: normalizeCacheId(newProduct.categoryInfo?.id || newProduct.categoryInfo?._id),
                collectionId: normalizeCacheId(newProduct.collectionInfo?.id || newProduct.collectionInfo?._id),
                categoryName: newProduct.categoryInfo?.name,
                collectionName: newProduct.collectionInfo?.name,
                productId: newProduct.id
            };
            await invalidateProductCache(payload);
        }

        return res.status(201).json({ success: true, data: newProduct });

    } catch (error) {
        console.error("=== ❌ CREATE PRODUCT REJECTION ===");
        console.error(error);

        // Formats database validation faults into readable JSON structures instead of [object Object]
        if (error.name === "ValidationError") {
            const structuralErrors = Object.keys(error.errors).reduce((acc, key) => {
                acc[key] = error.errors[key].message;
                return acc;
            }, {});
            
            return res.status(400).json({
                success: false,
                message: "Database Schema Validation Failure",
                errors: structuralErrors
            });
        }

        return res.status(500).json({ 
            success: false, 
            message: error.message || "Internal server process error" 
        });
    }
};
// --- GET PRODUCTS BY COLLECTION (LEAN FETCH) ---
export const getProductsByCollection = async (req, res) => {
    try {
        const { type } = req.params;
        const cacheKey = `collectionProducts:${type.toLowerCase()}:lite`;

        const cached = await redisClient.get(cacheKey);
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (Array.isArray(parsed)) {
                    if (parsed.length > 0) {
                        return res.status(200).json(parsed);
                    }
                    await redisClient.del(cacheKey);
                }
            } catch (err) {
                console.warn('Invalid products-by-collection cache value, refreshing from DB:', err?.message || err);
                await redisClient.del(cacheKey);
            }
        }

        const productsRaw = await Product.find(
            { "collectionInfo.name": { $regex: new RegExp(`^${type}$`, 'i') } },
            {
                name: 1, id: 1, price: 1, discount: 1, fabric: 1,
                pattern: 1, fit: 1, salesCount: 1, isTrending: 1, createdAt: 1,
                variants: 1, categoryInfo: 1
            }
        ).lean();

        const products = productsRaw.map(product => {
            const originalPrice = product.price || 0;
            const discValue = product.discount?.value || 0;
            const discType = product.discount?.type || 'none';

            // Price Calculation Logic
            let salePrice = originalPrice;
            let discountDisplay = null;
            if (discType === 'percentage' && discValue > 0) {
                salePrice = originalPrice - (originalPrice * (discValue / 100));
                discountDisplay = `-${discValue}%`;
            } else if (discType === 'amount' && discValue > 0) {
                salePrice = Math.max(0, originalPrice - discValue);
                discountDisplay = `-₹${discValue.toLocaleString('en-IN')}`;
            }

            const defaultVariant = product.variants?.find(v => v.isDefault) || product.variants?.[0];

            const variants = (product.variants || []).map((variant, index) => ({
                id: variant.id ?? variant._id ?? `${product.id}-${index}`,
                color: variant.color,
                images: variant.images,
                sizes: variant.sizes || [],
                inStock: (variant.sizes || []).some(s => s.stock > 0),
                thumbnail: variant.images?.[0] || null
            }));

            return {
                id: product.id,
                name: product.name,
                price: originalPrice,
                salePrice,
                discountDisplay,
                type: type,
                category: product.categoryInfo?.name,
                // Filtering Attributes
                fabric: product.fabric,
                pattern: product.pattern,
                fit: product.fit,
                // Detailed variant-level payload
                variants,
                color: variants.map(v => v.color).filter(c => c !== null),
                size: [...new Set(variants.flatMap(v => v.sizes.map(s => s.size)))],
                // Inventory Status
                inStock: variants.some(v => v.inStock),
                thumbnail: defaultVariant?.images?.[0] || null,
                salesCount: product.salesCount,
                createdAt: product.createdAt
            };
        });

        // Only cache non-empty results to avoid Upstash stale empty arrays
        if (products.length > 0) {
            try {
                await redisClient.setEx(cacheKey, 10800, JSON.stringify(products));
            } catch (err) {
                console.warn('[getProductsByCollection] Redis cache write failed:', err?.message);
            }
        }
        res.status(200).json(products);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// --- GET PRODUCTS BY CATEGORY (LEAN FETCH) ---
export const getProductsByCategory = async (req, res) => {
    try {
        const { type, category } = req.params;

        const cacheKey = `products:${type.toLowerCase()}:${category.toLowerCase()}:lite`;

        const cached = await redisClient.get(cacheKey);
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (Array.isArray(parsed)) {
                    if (parsed.length > 0) {
                        return res.status(200).json(parsed);
                    }
                    await redisClient.del(cacheKey);
                }
            } catch (err) {
                console.warn('Invalid products-by-category cache value, refreshing from DB:', err?.message || err);
                await redisClient.del(cacheKey);
            }
        }

        const productsRaw = await Product.find(
            {
                "collectionInfo.name": { $regex: new RegExp(`^${type}$`, 'i') },
                "categoryInfo.name": { $regex: new RegExp(`^${category}$`, 'i') }
            },
            {
                name: 1, id: 1, price: 1, discount: 1, fabric: 1,
                pattern: 1, fit: 1, salesCount: 1, isTrending: 1, createdAt: 1,
                variants: 1
            }
        ).lean();

        const products = productsRaw.map(product => {
            const originalPrice = product.price || 0;
            const discValue = product.discount?.value || 0;
            const discType = product.discount?.type || 'none';

            let salePrice = originalPrice;
            let discountDisplay = null;

            if (discType === 'percentage' && discValue > 0) {
                salePrice = originalPrice - (originalPrice * (discValue / 100));
                discountDisplay = `-${discValue}%`;
            } else if (discType === 'amount' && discValue > 0) {
                salePrice = Math.max(0, originalPrice - discValue);
                discountDisplay = `-₹${discValue.toLocaleString('en-IN')}`;
            }

            const defaultVariant = product.variants?.find(v => v.isDefault) || product.variants?.[0];

            const variants = (product.variants || []).map((variant, index) => ({
                id: variant.id ?? variant._id ?? `${product.id}-${index}`,
                color: variant.color,
                images: variant.images,
                sizes: variant.sizes || [],
                inStock: (variant.sizes || []).some(s => s.stock > 0),
                thumbnail: variant.images?.[0] || null
            }));

            return {
                id: product.id,
                name: product.name,
                price: originalPrice,
                type: type,
                salePrice,
                discountDisplay,
                fabric: product.fabric,
                pattern: product.pattern,
                fit: product.fit,
                variants,
                color: variants.map(v => v.color).filter(c => c !== null),
                size: [...new Set(variants.flatMap(v => v.sizes.map(s => s.size)))],
                inStock: variants.some(v => v.inStock),
                thumbnail: defaultVariant?.images?.[0] || null,
                salesCount: product.salesCount,
                createdAt: product.createdAt
            };
        });

        // Only cache non-empty results to avoid Upstash stale empty arrays
        if (products.length > 0) {
            try {
                await redisClient.setEx(cacheKey, 10800, JSON.stringify(products));
            } catch (err) {
                console.warn('[getProductsByCategory] Redis cache write failed:', err?.message);
            }
        }

        res.status(200).json(products);
    } catch (error) {
        console.log(error);

        res.status(500).json({ error: "Internal Server Error" });
    }
};


export const removeReview = async (req, res) => {
  try {
    // 1. Correct capitalization mapping from your frontend Axios payload
    const { orderId, productId, userId, id } = req.body; 

    if (!userId) return res.status(401).json({ error: "Not authorized" });
    if (!productId || !id) return res.status(400).json({ error: "Missing required fields" });

    // 2. Clear the review from the Product collection array
    const productUpdate = await Product.findOneAndUpdate(
      { id: productId }, 
      { 
        $pull: { 
          reviews: { 
            _id: id,       
            userId: userId 
          } 
        } 
      },
      { new: true }
    ).lean(); // Use .lean() for faster, cleaner property reading

    if (!productUpdate) {
      return res.status(404).json({ error: "Product not found or review already removed" });
    }

    // 3. Reset the checked review state flag on the companion Order
    if (orderId) {
      await Order.findOneAndUpdate(
        { 
          orderId, 
          $or: [{ userId: userId }, { reqUserRole: "Admin" }] 
        },
        { 
          $set: { "items.$[elem].reviewed": { isReviewed: false, review: {} } } 
        },
        { 
          arrayFilters: [{ "elem.productId": productId }],
          new: true
        }
      );
    }

    // 4. COMPREHENSIVE REDIS CACHE INVALIDATION PIPELINE
    const keysToInvalidate = [
      `order:detail:${orderId}`,
      `orders:user:${userId}`,
      `product:detail:${productId}`,                 // Clear by direct Object ID
      `product:detail:${productUpdate.id}`,          // Clear by custom numeric String ID fallback
      "products:all",
      "products:featured"
    ];

    // Dynamically flush out matching category and collection listings
    if (productUpdate.categoryInfo?.name || productUpdate.categoryInfo?.id) {
      const catName = String(productUpdate.categoryInfo.name || '').toLowerCase();
      const catId = productUpdate.categoryInfo.id;
      if (catName) keysToInvalidate.push(`products:category:${catId}`);
      
      // Also invalidate category combinations if you use them
      if (productUpdate.collectionInfo?.name) {
        const collName = String(productUpdate.collectionInfo.name).toLowerCase();
        keysToInvalidate.push(`products:${collName}:${catName}:lite`);
      }
    }

    if (productUpdate.collectionInfo?.name || productUpdate.collectionInfo?.id) {
      const collName = String(productUpdate.collectionInfo.name || '').toLowerCase();
      const collId = productUpdate.collectionInfo.id;
      if (collId) keysToInvalidate.push(`products:collection:${collId}`);
      if (collName) keysToInvalidate.push(`collectionProducts:${collName}:lite`);
    }

    // Execute multi-key extraction deletion safely
    await safeRedisDel(keysToInvalidate);

    return res.status(200).json({ success: true, message: "Review removed and cache refreshed successfully" });
  } catch (error) {
    console.error("Review Deletion Cache Failure:", error);
    return res.status(500).json({ error: error.message });
  }
};


export const removeReviewAdmin = async (req, res) => {
  try {
    const { id } = req.body; // Only the Review Subdocument _id is needed from the frontend

    if (!id) return res.status(400).json({ error: "Missing review ID" });

    // 1. Fetch the product and extract review info before pulling it
    // This gives us the target productId, the review author's userId, and categories for cache clearing
    const targetProduct = await Product.findOne({ "reviews._id": id });
    
    if (!targetProduct) {
      return res.status(404).json({ error: "Review not found or already removed from product" });
    }

    // Extract values dynamically from the located database record
    const productId = targetProduct._id; 
    const customProductId = targetProduct.id; // Custom numeric String ID fallback if used
    const reviewData = targetProduct.reviews.find(r => String(r._id) === String(id));
    const userId = reviewData?.userId;

    // 2. Perform the atomic pull to eliminate the review
    const productUpdate = await Product.findByIdAndUpdate(
      productId,
      { $pull: { reviews: { _id: id } } },
      { new: true }
    ).lean();

    // 3. Find the companion Order and reset the flag (since we didn't have orderId)
    let derivedOrderId = null;
    if (userId) {
      const companionOrder = await Order.findOneAndUpdate(
        { 
          userId: userId, 
          "items.productId": productId 
        },
        { 
          $set: { "items.$[elem].reviewed": { isReviewed: false, review: {} } } 
        },
        { 
          arrayFilters: [{ "elem.productId": productId }],
          new: true
        }
      ).lean();

      if (companionOrder) {
        derivedOrderId = companionOrder.orderId;
      }
    }

    // 4. COMPREHENSIVE REDIS CACHE INVALIDATION PIPELINE
    const keysToInvalidate = [
      "products:all",
      "products:featured",
      `product:detail:${productId}`,
      `product:detail:${customProductId}`
    ];

    // Only append user and order keys if they were successfully derived from the query pipeline
    if (userId) keysToInvalidate.push(`orders:user:${userId}`);
    if (derivedOrderId) keysToInvalidate.push(`order:detail:${derivedOrderId}`);

    // Dynamically clear matching category and collection listings
    if (productUpdate.categoryInfo?.name || productUpdate.categoryInfo?.id) {
      const catName = String(productUpdate.categoryInfo.name || '').toLowerCase();
      const catId = productUpdate.categoryInfo.id;
      if (catId) keysToInvalidate.push(`products:category:${catId}`);
      
      if (productUpdate.collectionInfo?.name) {
        const collName = String(productUpdate.collectionInfo.name).toLowerCase();
        keysToInvalidate.push(`products:${collName}:${catName}:lite`);
      }
    }

    if (productUpdate.collectionInfo?.name || productUpdate.collectionInfo?.id) {
      const collName = String(productUpdate.collectionInfo.name || '').toLowerCase();
      const collId = productUpdate.collectionInfo.id;
      if (collId) keysToInvalidate.push(`products:collection:${collId}`);
      if (collName) keysToInvalidate.push(`collectionProducts:${collName}:lite`);
    }

    // Execute multi-key extraction deletion safely
    await safeRedisDel(keysToInvalidate);

    return res.status(200).json({ success: true, message: "Review removed successfully by Admin" });
  } catch (error) {
    console.error("Admin Review Deletion Failure:", error);
    return res.status(500).json({ error: error.message });
  }
};
// --- GET SPECIFIC PRODUCT (FULL FETCH) ---
export const getSpecificProduct = async (req, res) => {
    try {
        const { id } = req.params;
        const cacheKey = `product:detail:${id}`;

        const cachedProduct = await redisClient.get(cacheKey);
        if (cachedProduct) return res.status(200).json({ success: true, data: JSON.parse(cachedProduct) });

        const product = await Product.findOne({ id: id })
            .populate('categoryInfo.id')
            .populate('collectionInfo.id');

        if (!product) return res.status(404).json({ message: "Product not found" });

        await redisClient.setEx(cacheKey, 3600, JSON.stringify(product));
        res.status(200).json({ success: true, data: product });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// --- UPDATE PRODUCT ---
export const updateProduct = async (req, res) => {
    // console.log(req.params);
    
    try {
        const { id } = req.params;
        console.log('UPDATE: id', id);
        console.log('UPDATE: req.body keys', Object.keys(req.body));
        console.log('UPDATE: req.files', (req.files || []).map(file => ({ fieldname: file.fieldname, originalname: file.originalname, path: file.path, url: getFileUrl(file) })));
        let updateData = { ...req.body };
        

        const product = await Product.findOne({ id: id });
        
      
        
        if (!product) return res.status(404).json({ message: "Product not found" });

        // Parse JSON strings, including timeline data from multipart form payloads
        const fieldsToParse = ['variants', 'discount', 'collectionInfo', 'categoryInfo', 'timeline'];
        fieldsToParse.forEach(field => {
            if (typeof updateData[field] === 'string') {
                const value = updateData[field].trim();
                if (value === '' || value === 'undefined' || value === 'null') {
                    updateData[field] = field === 'variants' ? [] : null;
                } else {
                    try {
                        updateData[field] = JSON.parse(value);
                    } catch (parseErr) {
                        throw new Error(`Invalid JSON structure inside field "${field}": ${parseErr.message}`);
                    }
                }
            }
        });

        const { byToken: uploadedByToken, byVariantIndex: uploadedByVariantIndex } = buildUploadMappings(req);

        // Preserve existing top-level data when it is not included in the update payload
        const preserveFields = ['sizeType', 'fabric', 'pattern', 'fit', 'collectionInfo', 'categoryInfo', 'discount', 'deal'];
        preserveFields.forEach((field) => {
            if (updateData[field] === undefined && product[field] !== undefined) {
                updateData[field] = product[field];
            }
        });

        const existingVariants = product.variants || [];
        const payloadVariants = Array.isArray(updateData.variants) ? updateData.variants : existingVariants.map((variant) => ({
            id: variant.id,
            color: variant.color,
            sizes: variant.sizes || [],
            isDefault: variant.isDefault,
            images: variant.images || []
        }));

        updateData.variants = payloadVariants.map((variant, index) => {
            const updatedVariant = { ...variant };
            const existingVariant = existingVariants.find(v => String(v.id) === String(variant.id));
            const orderedImages = resolveOrderedImages(updatedVariant, uploadedByToken);
            const fallbackNewImages = uploadedByVariantIndex[index] || [];
            const sourceImages = orderedImages.length > 0 ? orderedImages : Array.isArray(updatedVariant.images) ? updatedVariant.images : existingVariant?.images || [];
            updatedVariant.images = [...sourceImages, ...fallbackNewImages.filter((url) => !sourceImages.includes(url))];
            return updatedVariant;
        });

        const updatedProduct = await Product.findOneAndUpdate(
            { id: id },
            { $set: updateData },
            { new: true, runValidators: true }
        );
        console.log('UPDATE: updatedProduct', updatedProduct);

        // Invalidate individual product detail cache immediately
        await safeRedisDel(`product:detail:${id}`);

        // Remove any images that existed previously but are not present in the updated product.
        try {
            const oldImages = Array.isArray(product?.variants)
                ? product.variants.flatMap(v => (v.images || []))
                : [];

            const newImages = Array.isArray(updatedProduct?.variants)
                ? updatedProduct.variants.flatMap(v => (v.images || []))
                : [];

            const imagesToDelete = oldImages.filter((img) => img && !newImages.includes(img));
            for (const img of imagesToDelete) {
                try {
                    await deleteFromCloudinary(img);
                } catch (err) {
                    console.warn('Failed to delete old product image from Cloudinary:', img, err?.message || err);
                }
            }
        } catch (err) {
            console.warn('Error computing product image deletions:', err?.message || err);
        }

        // Safe variables configuration to prevent null-pointer crashes
        const oldCachePayload = {
            categoryId: normalizeCacheId(product?.categoryInfo?.id || product?.categoryInfo?._id),
            collectionId: normalizeCacheId(product?.collectionInfo?.id || product?.collectionInfo?._id),
            categoryName: product?.categoryInfo?.name,
            collectionName: product?.collectionInfo?.name
        };

        const newCachePayload = {
            categoryId: normalizeCacheId(updatedProduct?.categoryInfo?.id || updatedProduct?.categoryInfo?._id),
            collectionId: normalizeCacheId(updatedProduct?.collectionInfo?.id || updatedProduct?.collectionInfo?._id),
            categoryName: updatedProduct?.categoryInfo?.name,
            collectionName: updatedProduct?.collectionInfo?.name
        };

        // Wipe out the old cache entries and always clear global aggregator list caches.
        await invalidateProductCache(oldCachePayload, newCachePayload);

        res.status(200).json({ success: true, data: updatedProduct });
      
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// --- DELETE PRODUCT ---
export const deleteProduct = async (req, res) => {
    try {
        const { id } = req.params;
        const deletedProduct = await Product.findOneAndDelete({ id: id });

        if (!deletedProduct) return res.status(404).json({ message: "Product not found" });

        // Delete product images from Cloudinary
        try {
            const imgs = Array.isArray(deletedProduct.variants)
                ? deletedProduct.variants.flatMap(v => (v.images || []))
                : [];
            for (const img of imgs) {
                try {
                    await deleteFromCloudinary(img);
                } catch (err) {
                    console.warn('Failed to delete Cloudinary image for deleted product:', img, err?.message || err);
                }
            }
        } catch (err) {
            console.warn('Error deleting Cloudinary images for product:', err?.message || err);
        }

        // Invalidate individual product detail cache
        await safeRedisDel(`product:detail:${id}`);
        const delPayload = {
            categoryId: normalizeCacheId(deletedProduct.categoryInfo?.id || deletedProduct.categoryInfo?._id),
            collectionId: normalizeCacheId(deletedProduct.collectionInfo?.id || deletedProduct.collectionInfo?._id),
            categoryName: deletedProduct.categoryInfo?.name,
            collectionName: deletedProduct.collectionInfo?.name,
            productId: deletedProduct.id
        };

        await invalidateProductCache(delPayload);

        res.status(200).json({ success: true, message: "Product deleted" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// --- GET FEATURED PRODUCTS ---
export const getFeaturedProducts = async (req, res) => {
    try {
        const cacheKey = "products:featured";
        const cached = await redisClient.get(cacheKey);
        if (cached) return res.status(200).json(JSON.parse(cached));

        const featuredProducts = await Product.find({ isFeatured: true }, {
            name: 1, id: 1, price: 1, discount: 1, fabric: 1,
            pattern: 1, fit: 1, salesCount: 1, isTrending: 1, createdAt: 1,
            variants: 1, categoryInfo: 1 , collectionInfo: 1
        }).lean();


        const products = featuredProducts.map(product => {
            const originalPrice = product.price || 0;
            const discValue = product.discount?.value || 0;
            const discType = product.discount?.type || 'none';

            let salePrice = originalPrice;
            let discountDisplay = null;

            if (discType === 'percentage' && discValue > 0) {
                salePrice = originalPrice - (originalPrice * (discValue / 100));
                discountDisplay = `-${discValue}%`;
            } else if (discType === 'amount' && discValue > 0) {
                salePrice = Math.max(0, originalPrice - discValue);
                discountDisplay = `-₹${discValue.toLocaleString('en-IN')}`;
            }

            const defaultVariant = product.variants?.find(v => v.isDefault) || product.variants?.[0];

            return {
                id: product.id,
                name: product.name,
                price: originalPrice,
                type: product.collectionInfo.name,
                trending : product.isTrending,
                category : product.categoryInfo.name,
                salePrice,
                discountDisplay,
                fabric: product.fabric,
                pattern: product.pattern,
                fit: product.fit,
                color: (product.variants || []).map(v => v?.color).filter(c => c !== null),
                size: [...new Set((product.variants || []).flatMap(v => (v?.sizes || []).map(s => s.size)))],
                inStock: (product.variants || []).some(v => (v?.sizes || []).some(s => s.stock > 0)),
                thumbnail: defaultVariant?.images?.[0] || null,
                salesCount: product.salesCount,
                createdAt: product.createdAt
            };
        });

        await redisClient.setEx(cacheKey, 3600, JSON.stringify(products));
        res.status(200).json(products);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};


export const getAllProducts = async (req, res) => {
    try {
        const cacheKey = "products:all";
        const cached = await redisClient.get(cacheKey);
        if (cached) return res.status(200).json(JSON.parse(cached));

        const productsRaw = await Product.find({})
            .select("name id price discount fabric pattern fit salesCount isTrending createdAt variants type description categoryInfo collectionInfo isFeatured sizeType deal" ) 
            .lean();

        // 2. Transform data shapes safely for your frontend layout components
        const products = productsRaw.map(product => {
            const originalPrice = product.price || 0;
            const discValue = product.discount?.value || 0;
            const discType = product.discount?.type || 'none';

            let salePrice = originalPrice;
            let discountDisplay = null;

            // Handle your regional Indian Rupee (₹) calculations cleanly
            if (discType === 'percentage' && discValue > 0) {
                salePrice = originalPrice - (originalPrice * (discValue / 100));
                discountDisplay = `-${discValue}%`;
            } else if (discType === 'amount' && discValue > 0) {
                salePrice = Math.max(0, originalPrice - discValue);
                discountDisplay = `-₹${discValue.toLocaleString('en-IN')}`;
            }

            const variantsArray = product.variants || [];
            const defaultVariant = variantsArray.find(v => v.isDefault) || variantsArray[0];

            const stockLevelCount = variantsArray.reduce((total, variant) => {
                const sizeStockSum = (variant?.sizes || []).reduce((sum, s) => sum + (s.stock || 0), 0);
                return total + sizeStockSum;
            }, 0);

            return {
                id: product.id || product._id, // Fallback to Mongo's _id if a custom id string isn't generated
                name: product.name,
                price: originalPrice,
                type: product.type || "Standard", // FIXED: Pulls direct from schema or falls back cleanly
                salePrice: Math.round(salePrice), // Clean pricing integer
                discountDisplay,
                fabric: product.fabric,
                pattern: product.pattern,
                fit: product.fit,
                color: variantsArray.map(v => v?.color).filter(Boolean),
                size: [...new Set(variantsArray.flatMap(v => (v?.sizes || []).map(s => s.size)))],
                inStock: variantsArray.some(v => (v?.sizes || []).some(s => s.stock > 0)),
                thumbnail: defaultVariant?.images?.[0] || null,
                level: stockLevelCount > 20 ? "high" : stockLevelCount > 0 ? "low" : "out",
                salesCount: product.salesCount || 0,
                isTrending: product.isTrending || false,
                createdAt: product.createdAt,
                description: product.description || null,
                category: product.categoryInfo?.name || null,
                collection: product.collectionInfo?.name || null,
                variants : variantsArray,
                isFeatured: product.isFeatured || false,
                discount: product.discount || null,
                sizeType: product.sizeType ,
                deal : product.deal || null // Include full variant details for your frontend to utilize as needed
            };
        });

         await redisClient.setEx(cacheKey, 3600, JSON.stringify(products));

        // 3. Return configured master array to populate your store grids
        return res.status(200).json(products);

    } catch (error) {
        console.error("Error in getAllProducts:", error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};