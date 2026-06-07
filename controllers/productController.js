import mongoose from "mongoose";
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

const parseBooleanValue = (value) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
};

const safeRedisDel = async (...keys) => {
    const flattened = keys.flat(Infinity).filter(Boolean).map(String);
    if (!flattened.length) return;
    return await redisClient.del(...flattened);
};

const setNoStoreHeaders = (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
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
        if (typeof productData.isFeatured === 'string') {
            productData.isFeatured = parseBooleanValue(productData.isFeatured);
        }
        if (typeof productData.taxable === 'string') {
            productData.taxable = parseBooleanValue(productData.taxable);
        }
                     
        // Resolve Reference IDs safely
        const resolveReferenceInfo = async (info, Model, fieldName) => {
            
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

        // 7. Evict Redis cache keys for products immediately when a new product is created
        await safeRedisDel("products:featured", "products:all");
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

        await redisClient.setEx(cacheKey, 10800, JSON.stringify(products));
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

        await redisClient.setEx(cacheKey, 10800, JSON.stringify(products));

        res.status(200).json(products);
    } catch (error) {

        res.status(500).json({ error: "Internal Server Error" });
    }
};


export const removeReview = async (req, res) => {
  try {
    // 1. Correct capitalization mapping from your frontend Axios payload
    const { orderId, productId, userId, id } = req.body; 

    if (!userId) return res.status(401).json({ error: "Not authorized" });
    if (!productId || !id) return res.status(400).json({ error: "Missing required fields" });

    // 2. Load the review and its images before deletion
    const productDoc = await Product.findOne({ id: productId }).lean();
    if (!productDoc) {
      return res.status(404).json({ error: "Product not found" });
    }

    const reviewToDelete = productDoc.reviews?.find((review) => String(review._id) === String(id) && String(review.userId) === String(userId));
    if (!reviewToDelete) {
      return res.status(404).json({ error: "Review not found or not authorized to delete" });
    }

    const reviewImages = Array.isArray(reviewToDelete.images) ? reviewToDelete.images : [];

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

    await Promise.allSettled(reviewImages.map(deleteFromCloudinary));

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

        // 4. Invalidate product detail + list caches using shared helpers

        try {
            // Ensure both detail keys (custom id and mongo _id) are removed
            const detailKeys = [
                `product:detail:${productId}`,
                `product:detail:${productUpdate.id}`,
                `product:detail:${productUpdate._id}`
            ].filter(Boolean).map(String);
            await safeRedisDel(detailKeys);

            // Invalidate broader list caches (category/collection/global)
            await invalidateProductCache({
                categoryId: normalizeCacheId(productUpdate.categoryInfo?.id || productUpdate.categoryInfo?._id),
                collectionId: normalizeCacheId(productUpdate.collectionInfo?.id || productUpdate.collectionInfo?._id),
                categoryName: productUpdate.categoryInfo?.name,
                collectionName: productUpdate.collectionInfo?.name,
                productId: productUpdate.id
            });

            // Also clear order/user-specific caches if present
            if (orderId) await safeRedisDel(`order:detail:${orderId}`).catch(() => {});
            if (userId) await safeRedisDel(`orders:user:${userId}`).catch(() => {});
            // Sweep any product detail keys that may have been cached under alternate forms
            try {
                const pidStr = String(productUpdate.id || productId || '');
                const mongoIdStr = String(productUpdate._id || '');
                for await (const key of redisClient.scanIterator({ MATCH: `product:detail:*${pidStr}*` })) {
                    await safeRedisDel(key).catch(() => {});
                }
                if (mongoIdStr) {
                    for await (const key of redisClient.scanIterator({ MATCH: `product:detail:*${mongoIdStr}*` })) {
                        await safeRedisDel(key).catch(() => {});
                    }
                }
            } catch (sweepErr) {
                console.warn('Error sweeping product detail keys after review removal:', sweepErr?.message || sweepErr);
            }
        } catch (err) {
            console.warn('Error invalidating caches after review removal:', err?.message || err);
        }

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
    const reviewImages = Array.isArray(reviewData?.images) ? reviewData.images : [];

    // 2. Perform the atomic pull to eliminate the review
    const productUpdate = await Product.findByIdAndUpdate(
      productId,
      { $pull: { reviews: { _id: id } } },
      { new: true }
    ).lean();

    if (reviewImages.length) {
      await Promise.allSettled(reviewImages.map(deleteFromCloudinary));
    }

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

        // 4. Invalidate product detail + list caches using shared helpers
        try {
            // Ensure both detail keys (mongo _id and custom id) are removed
            await safeRedisDel(`product:detail:${productId}`, `product:detail:${customProductId}`);

            // Invalidate category/collection and global list caches
            await invalidateProductCache({
                categoryId: normalizeCacheId(productUpdate.categoryInfo?.id || productUpdate.categoryInfo?._id),
                collectionId: normalizeCacheId(productUpdate.collectionInfo?.id || productUpdate.collectionInfo?._id),
                categoryName: productUpdate.categoryInfo?.name,
                collectionName: productUpdate.collectionInfo?.name,
                productId: productUpdate.id
            });

            if (userId) await safeRedisDel(`orders:user:${userId}`).catch(() => {});
            if (derivedOrderId) await safeRedisDel(`order:detail:${derivedOrderId}`).catch(() => {});
            // Additional sweep for alternate product detail cache keys
            try {
                const pidStr = String(productUpdate?.id || customProductId || '');
                const mongoIdStr = String(productId || '');
                for await (const key of redisClient.scanIterator({ MATCH: `product:detail:*${pidStr}*` })) {
                    await safeRedisDel(key).catch(() => {});
                }
                if (mongoIdStr) {
                    for await (const key of redisClient.scanIterator({ MATCH: `product:detail:*${mongoIdStr}*` })) {
                        await safeRedisDel(key).catch(() => {});
                    }
                }
            } catch (sweepErr) {
                console.warn('Error sweeping product detail keys after admin review removal:', sweepErr?.message || sweepErr);
            }
        } catch (err) {
            console.warn('Error invalidating caches after admin review removal:', err?.message || err);
        }

    return res.status(200).json({ success: true, message: "Review removed successfully by Admin" });
  } catch (error) {
    console.error("Admin Review Deletion Failure:", error);
    return res.status(500).json({ error: error.message });
  }
};

export const addProductReview = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Login required to submit a review." });
    }

    const { id } = req.params;
    const query = [{ id }];
    if (mongoose.Types.ObjectId.isValid(id)) {
      query.push({ _id: id });
    }
    const product = await Product.findOne({ $or: query });
    if (!product) return res.status(404).json({ error: "Product not found" });

    const rating = Number(req.body.rating || req.body.rate || 0);
    const title = String(req.body.title || '').trim();
    const comment = String(req.body.comment || '').trim();
    const variant = String(req.body.variant || '').trim();

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: "Rating must be between 1 and 5." });
    }
    if (!comment) {
      return res.status(400).json({ error: "Review comment is required." });
    }

    const uploadedImages = (req.files || []).map(getFileUrl).filter(Boolean);

    const review = {
      user: `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || req.user.email || 'Anonymous',
      userId: req.user.id,
      orderId: null,
      productId: product.id || String(product._id),
      variant,
      title,
      comment,
      images: uploadedImages,
      rating,
      date: new Date().toISOString().split('T')[0]
    };

    product.reviews = product.reviews || [];
    product.reviews.push(review);
    await product.save();

    const savedReview = product.reviews[product.reviews.length - 1];

    await safeRedisDel(`product:detail:${product.id}`, `product:detail:${product._id}`);
    await invalidateProductCache({
      collectionId: product.collectionInfo?.id,
      categoryId: product.categoryInfo?.id,
      collectionName: product.collectionInfo?.name,
      categoryName: product.categoryInfo?.name
    });

    return res.status(201).json({ success: true, review: savedReview });
  } catch (error) {
    console.error('Add Product Review Failure:', error);
    return res.status(500).json({ error: error.message });
  }
};

export const updateProductReview = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: "Login required to update a review." });
    }

    const { id, reviewId } = req.params;
    const query = [{ id }];
    if (mongoose.Types.ObjectId.isValid(id)) {
      query.push({ _id: id });
    }

    const product = await Product.findOne({ $or: query });
    if (!product) return res.status(404).json({ error: "Product not found" });

    const review = product.reviews?.find((rev) => String(rev._id) === String(reviewId));
    if (!review) {
      return res.status(404).json({ error: "Review not found" });
    }

    if (String(review.userId) !== String(req.user.id) && req.user.role !== 'Admin') {
      return res.status(403).json({ error: "Not authorized to update this review." });
    }

    const rating = Number(req.body.rating || req.body.rate || review.rating || 0);
    const title = String(req.body.title || review.title || '').trim();
    const comment = String(req.body.comment || review.comment || '').trim();
    const variant = String(req.body.variant || review.variant || '').trim();
        // Handle removed images (sent as JSON string or comma-separated list)
        let removedImages = [];
        if (req.body.removedImages) {
            try {
                if (typeof req.body.removedImages === 'string') {
                    removedImages = JSON.parse(req.body.removedImages);
                } else {
                    removedImages = req.body.removedImages;
                }
            } catch (err) {
                // fallback to comma-separated
                removedImages = String(req.body.removedImages).split(',').map(s => s.trim()).filter(Boolean);
            }
        }

        // New uploaded files to add to the review
        const uploadedImages = (req.files || []).map(getFileUrl).filter(Boolean);
    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: "Rating must be between 1 and 5." });
    }
    if (!comment) {
      return res.status(400).json({ error: "Review comment is required." });
    }

        review.title = title;
        review.comment = comment;
        review.rating = rating;
        review.variant = variant;

        // Remove any images the user asked to remove (and delete from Cloudinary)
        if (Array.isArray(removedImages) && removedImages.length) {
            try {
                await Promise.allSettled(removedImages.map(deleteFromCloudinary));
            } catch (err) {
                console.warn('Failed to delete some images from Cloudinary during review update:', err?.message || err);
            }
            review.images = Array.isArray(review.images) ? review.images.filter(img => !removedImages.includes(img)) : [];
        }

        // Append newly uploaded images (if any), keep unique and cap at 5
        if (uploadedImages.length) {
            const before = Array.isArray(review.images) ? review.images : [];
            const merged = [...before, ...uploadedImages].filter(Boolean);
            // remove duplicates while preserving order
            review.images = Array.from(new Set(merged)).slice(0, 5);
        }

    await product.save();

    await safeRedisDel(`product:detail:${product.id}`, `product:detail:${product._id}`);
    await invalidateProductCache({
      collectionId: product.collectionInfo?.id,
      categoryId: product.categoryInfo?.id,
      collectionName: product.collectionInfo?.name,
      categoryName: product.categoryInfo?.name
    });

    return res.status(200).json({ success: true, review });
  } catch (error) {
    console.error('Update Product Review Failure:', error);
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

        const query = [{ id }];
        if (mongoose.Types.ObjectId.isValid(id)) {
            query.push({ _id: id });
        }

        const product = await Product.findOne({ $or: query })
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
    
    try {
        const { id } = req.params;
        let updateData = { ...req.body };
        
        const product = await Product.findOne({ id: id });
        
      
        
        if (!product) return res.status(404).json({ message: "Product not found" });

        // Parse JSON strings and boolean strings from multipart form payloads
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
        if (typeof updateData.isFeatured === 'string') {
            updateData.isFeatured = parseBooleanValue(updateData.isFeatured);
        }
        if (typeof updateData.taxable === 'string') {
            updateData.taxable = parseBooleanValue(updateData.taxable);
        }

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

        // Invalidate individual product detail cache immediately
        await safeRedisDel(`product:detail:${id}`);
        await safeRedisDel("products:featured", "products:all");

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
        await safeRedisDel("products:featured", "products:all");
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
        setNoStoreHeaders(res);
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
        setNoStoreHeaders(res);
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