import mongoose from "mongoose";
import Product from "../models/Product.js";
import Category from "../models/Category.js";
import Collection from "../models/Collection.js";
import { redisClient } from "../config/redis.js";
import Order from "../models/Order.js";
import { deleteFromCloudinary } from "../config/cloudinary.js";

// ============================================================================
// --- CACHE INVALIDATION & DATA PARSING HELPERS ---
// ============================================================================

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

const parseDateValue = (value) => {
    if (value === undefined || value === null) return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === '' || normalized === 'null' || normalized === 'undefined') return null;
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid date value for sponsorUntil: ${JSON.stringify(value)}`);
    }
    return date;
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

// Extracted formatting helper for re-use
const formatProductsHelper = (productsRaw) => {
    return productsRaw.map(product => {
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

        const variantsArray = product.variants || [];
        const defaultVariant = variantsArray.find(v => v.isDefault) || variantsArray[0];

        const stockLevelCount = variantsArray.reduce((total, variant) => {
            const sizeStockSum = (variant?.sizes || []).reduce((sum, s) => sum + (s.stock || 0), 0);
            return total + sizeStockSum;
        }, 0);

        return {
            id: product.id || product._id, 
            name: product.name,
            price: originalPrice,
            type: product.type || "Standard", 
            salePrice: Math.round(salePrice), 
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
            deal : product.deal || null,
            sponsorPriority: product.sponsorPriority || null,
            sponsorUntil: product.sponsorUntil || null,
            isSponsored: product.isSponsored || false,
            status: product.status
        };
    });
};


// ============================================================================
// --- MAIN CONTROLLER ACTIONS ---
// ============================================================================


// --- CREATE PRODUCT ---
export const createProduct = async (req, res) => {
    try {
        let productData = { ...req.body };

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

        if (typeof productData.isFeatured === 'string') productData.isFeatured = parseBooleanValue(productData.isFeatured);
        if (typeof productData.taxable === 'string') productData.taxable = parseBooleanValue(productData.taxable);
        if (typeof productData.isSponsored === 'string') productData.isSponsored = parseBooleanValue(productData.isSponsored);
        
        // BUG FIX: Parse Dates Safely using helper to handle "null" string
        if (typeof productData.sponsorUntil !== 'undefined') {
            productData.sponsorUntil = parseDateValue(productData.sponsorUntil);
        }
        
        productData.status = productData.status || 'ACTIVE';

        const resolveReferenceInfo = async (info, Model, fieldName) => {
            if (!info || (!info.id && !info.name)) {
                throw new Error(`Missing required ${fieldName}. Please select a valid category and collection.`);
            }
            let record = null;
            if (info.id) {
                try { record = await Model.findById(info.id).lean(); } catch (err) {}
            }
            if (!record && info.name) record = await Model.findOne({ name: info.name }).lean();
            if (!record) throw new Error(`Invalid ${fieldName}: unable to resolve ${fieldName} by id or name.`);
            return { id: record._id, name: record.name };
        };

        productData.collectionInfo = await resolveReferenceInfo(productData.collectionInfo, Collection, 'collectionInfo');
        productData.categoryInfo = await resolveReferenceInfo(productData.categoryInfo, Category, 'categoryInfo');

        const firstVariant = productData.variants?.[0] || {};
        const firstSizeInfo = firstVariant.sizes?.[0] || {};

        productData.fit = (productData.fit || firstVariant.fit || firstSizeInfo.fit || "Regular").trim();
        productData.pattern = (productData.pattern || firstVariant.pattern || firstSizeInfo.pattern || "Solid").trim();
        productData.fabric = (productData.fabric || firstVariant.fabric || firstSizeInfo.fabric || "Cotton").trim();
        productData.sizeType = (productData.sizeType || firstVariant.sizeType || "Alpha").trim();

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

        const newProduct = new Product(productData);
        await newProduct.save();

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
                    if (parsed.length > 0) return res.status(200).json(parsed);
                    await redisClient.del(cacheKey);
                }
            } catch (err) {
                console.warn('Invalid products-by-collection cache value, refreshing from DB:', err?.message || err);
                await redisClient.del(cacheKey);
            }
        }

        const productsRaw = await Product.find(
            { 
                "collectionInfo.name": { $regex: new RegExp(`^${type}$`, 'i') },
                status: 'ACTIVE' 
            },
            {
                name: 1, id: 1, price: 1, discount: 1, fabric: 1,
                pattern: 1, fit: 1, salesCount: 1, isTrending: 1, createdAt: 1,
                variants: 1, categoryInfo: 1,
                isSponsored: 1, sponsorPriority: 1, sponsorUntil: 1
            }
        ).lean();

        const now = new Date();

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
                salePrice,
                discountDisplay,
                type: type,
                category: product.categoryInfo?.name,
                fabric: product.fabric,
                pattern: product.pattern,
                fit: product.fit,
                variants,
                color: variants.map(v => v.color).filter(c => c !== null),
                size: [...new Set(variants.flatMap(v => v.sizes.map(s => s.size)))],
                inStock: variants.some(v => v.inStock),
                thumbnail: defaultVariant?.images?.[0] || null,
                salesCount: product.salesCount,
                createdAt: product.createdAt,
                isSponsored: !!product.isSponsored,
                sponsorPriority: product.sponsorPriority || 0,
                sponsorUntil: product.sponsorUntil || null
            };
        });

        products.sort((a, b) => {
            const aActive = a.isSponsored && (!a.sponsorUntil || new Date(a.sponsorUntil) > now) ? 1 : 0;
            const bActive = b.isSponsored && (!b.sponsorUntil || new Date(b.sponsorUntil) > now) ? 1 : 0;
            if (aActive !== bActive) return bActive - aActive;
            if (a.sponsorPriority !== b.sponsorPriority) return b.sponsorPriority - a.sponsorPriority;
            return new Date(b.createdAt) - new Date(a.createdAt);
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

        // 🔥 THE FIX: Regex allows '-' or ' ' to be interchangeable.
        // It converts "t-shirt" into a regex that matches "t-shirt" OR "t shirt"
        // It converts "home-decor" into a regex that matches "home-decor" OR "home decor"
        const typeRegex = new RegExp(`^${type.replace(/-/g, '[- ]')}$`, 'i');
        const catRegex = new RegExp(`^${category.replace(/-/g, '[- ]')}$`, 'i');

        const cacheKey = `products:${type.toLowerCase()}:${category.toLowerCase()}:lite`;

        // Cache check
        const cached = await redisClient.get(cacheKey);
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                if (Array.isArray(parsed) && parsed.length > 0) return res.status(200).json(parsed);
                if (Array.isArray(parsed) && parsed.length === 0) await redisClient.del(cacheKey);
            } catch (err) {
                console.warn('Invalid cache, refreshing from DB:', err?.message);
                await redisClient.del(cacheKey);
            }
        }

        // DB Query using the new Regex
        const productsRaw = await Product.find(
            {
                "collectionInfo.name": { $regex: typeRegex },
                "categoryInfo.name": { $regex: catRegex },
                status: 'ACTIVE'
            },
            {
                name: 1, id: 1, price: 1, discount: 1, fabric: 1,
                pattern: 1, fit: 1, salesCount: 1, isTrending: 1, createdAt: 1,
                variants: 1,
                isSponsored: 1, sponsorPriority: 1, sponsorUntil: 1
            }
        ).lean();

        // Transformation Logic
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
                type: type, // Keeping original URL param
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
                createdAt: product.createdAt,
                isSponsored: !!product.isSponsored,
                sponsorPriority: product.sponsorPriority || 0,
                sponsorUntil: product.sponsorUntil || null
            };
        });

        // Sorting Logic
        const now2 = new Date();
        products.sort((a, b) => {
            const aActive = a.isSponsored && (!a.sponsorUntil || new Date(a.sponsorUntil) > now2) ? 1 : 0;
            const bActive = b.isSponsored && (!b.sponsorUntil || new Date(b.sponsorUntil) > now2) ? 1 : 0;
            if (aActive !== bActive) return bActive - aActive;
            if (a.sponsorPriority !== b.sponsorPriority) return b.sponsorPriority - a.sponsorPriority;
            return new Date(b.createdAt) - new Date(a.createdAt);
        });

        await redisClient.setEx(cacheKey, 10800, JSON.stringify(products));

        res.status(200).json(products);
    } catch (error) {
        console.error("ProductsByCategory Error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
};

// --- SET PRODUCT SPONSORSHIP ---
export const setProductSponsorship = async (req, res) => {
    try {
        const { id } = req.params; 
        const { isSponsored, sponsorPriority, sponsorUntil } = req.body;

        const update = {};
        if (typeof isSponsored !== 'undefined') {
            update.isSponsored = typeof isSponsored === 'string' ? parseBooleanValue(isSponsored) : !!isSponsored;
        }
        if (typeof sponsorPriority !== 'undefined') {
            update.sponsorPriority = sponsorPriority === '' || sponsorPriority === 'null' ? 0 : Number(sponsorPriority) || 0;
        }
        if (typeof sponsorUntil !== 'undefined') {
            update.sponsorUntil = parseDateValue(sponsorUntil);
        }

        const query = [{ id }];
        if (mongoose.Types.ObjectId.isValid(id)) query.push({ _id: id });

        const product = await Product.findOneAndUpdate({ $or: query }, { $set: update }, { new: true }).lean();
        if (!product) return res.status(200).json({ error: 'Product not found' });

        await safeRedisDel(`product:detail:${product._id}`, `product:detail:${product.id}`);
        await invalidateProductCache({
            categoryId: normalizeCacheId(product.categoryInfo?.id || product.categoryInfo?._id),
            collectionId: normalizeCacheId(product.collectionInfo?.id || product.collectionInfo?._id),
            categoryName: product.categoryInfo?.name,
            collectionName: product.collectionInfo?.name,
            productId: product.id
        });

        res.status(200).json({ success: true, data: product });
    } catch (error) {
        console.error('Set Sponsorship Failure:', error);
        res.status(500).json({ error: error.message });
    }
};

// --- REMOVE REVIEW ---
export const removeReview = async (req, res) => {
  try {
    const { orderId, productId, userId, id } = req.body; 

    if (!userId) return res.status(200).json({ error: "Not authorized" });
    if (!productId || !id) return res.status(400).json({ error: "Missing required fields" });

    const productDoc = await Product.findOne({ id: productId }).lean();
    if (!productDoc) return res.status(200).json({ error: "Product not found" });

    const reviewToDelete = productDoc.reviews?.find((review) => String(review._id) === String(id) && String(review.userId) === String(userId));
    if (!reviewToDelete) return res.status(200).json({ error: "Review not found or not authorized to delete" });

    const reviewImages = Array.isArray(reviewToDelete.images) ? reviewToDelete.images : [];

    const productUpdate = await Product.findOneAndUpdate(
      { id: productId }, 
      { $pull: { reviews: { _id: id, userId: userId } } },
      { new: true }
    ).lean();

    if (!productUpdate) return res.status(200).json({ error: "Product not found or review already removed" });

    await Promise.allSettled(reviewImages.map(deleteFromCloudinary));

    if (orderId) {
      await Order.findOneAndUpdate(
        { orderId, $or: [{ userId: userId }, { reqUserRole: "Admin" }] },
        { $set: { "items.$[elem].reviewed": { isReviewed: false, review: {} } } },
        { arrayFilters: [{ "elem.productId": productId }], new: true }
      );
    }

    try {
        const detailKeys = [
            `product:detail:${productId}`,
            `product:detail:${productUpdate.id}`,
            `product:detail:${productUpdate._id}`
        ].filter(Boolean).map(String);
        await safeRedisDel(detailKeys);

        await invalidateProductCache({
            categoryId: normalizeCacheId(productUpdate.categoryInfo?.id || productUpdate.categoryInfo?._id),
            collectionId: normalizeCacheId(productUpdate.collectionInfo?.id || productUpdate.collectionInfo?._id),
            categoryName: productUpdate.categoryInfo?.name,
            collectionName: productUpdate.collectionInfo?.name,
            productId: productUpdate.id
        });

        if (orderId) await safeRedisDel(`order:detail:${orderId}`).catch(() => {});
        if (userId) await safeRedisDel(`orders:user:${userId}`).catch(() => {});
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
        } catch (sweepErr) {}
    } catch (err) {}

    return res.status(200).json({ success: true, message: "Review removed and cache refreshed successfully" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// --- REMOVE REVIEW (ADMIN) ---
export const removeReviewAdmin = async (req, res) => {
  try {
    const { id } = req.body; 
    if (!id) return res.status(400).json({ error: "Missing review ID" });

    const targetProduct = await Product.findOne({ "reviews._id": id });
    if (!targetProduct) return res.status(200).json({ error: "Review not found or already removed from product" });

    const productId = targetProduct._id; 
    const customProductId = targetProduct.id;
    const reviewData = targetProduct.reviews.find(r => String(r._id) === String(id));
    const userId = reviewData?.userId;
    const reviewImages = Array.isArray(reviewData?.images) ? reviewData.images : [];

    const productUpdate = await Product.findByIdAndUpdate(
      productId,
      { $pull: { reviews: { _id: id } } },
      { new: true }
    ).lean();

    if (reviewImages.length) {
      await Promise.allSettled(reviewImages.map(deleteFromCloudinary));
    }

    let derivedOrderId = null;
    if (userId) {
      const companionOrder = await Order.findOneAndUpdate(
        { userId: userId, "items.productId": productId },
        { $set: { "items.$[elem].reviewed": { isReviewed: false, review: {} } } },
        { arrayFilters: [{ "elem.productId": productId }], new: true }
      ).lean();
      if (companionOrder) derivedOrderId = companionOrder.orderId;
    }

    try {
        await safeRedisDel(`product:detail:${productId}`, `product:detail:${customProductId}`);
        await invalidateProductCache({
            categoryId: normalizeCacheId(productUpdate.categoryInfo?.id || productUpdate.categoryInfo?._id),
            collectionId: normalizeCacheId(productUpdate.collectionInfo?.id || productUpdate.collectionInfo?._id),
            categoryName: productUpdate.categoryInfo?.name,
            collectionName: productUpdate.collectionInfo?.name,
            productId: productUpdate.id
        });

        if (userId) await safeRedisDel(`orders:user:${userId}`).catch(() => {});
        if (derivedOrderId) await safeRedisDel(`order:detail:${derivedOrderId}`).catch(() => {});
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
        } catch (sweepErr) {}
    } catch (err) {}

    return res.status(200).json({ success: true, message: "Review removed successfully by Admin" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// --- ADD PRODUCT REVIEW ---
export const addProductReview = async (req, res) => {
  try {
    if (!req.user) return res.status(200).json({ error: "Login required to submit a review." });

    const { id } = req.params;
    const query = [{ id }];
    if (mongoose.Types.ObjectId.isValid(id)) query.push({ _id: id });
    
    const product = await Product.findOne({ $or: query });
    if (!product) return res.status(200).json({ error: "Product not found" });

    const rating = Number(req.body.rating || req.body.rate || 0);
    const title = String(req.body.title || '').trim();
    const comment = String(req.body.comment || '').trim();
    const variant = String(req.body.variant || '').trim();

    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: "Rating must be between 1 and 5." });
    if (!comment) return res.status(400).json({ error: "Review comment is required." });

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
    return res.status(500).json({ error: error.message });
  }
};

// --- UPDATE PRODUCT REVIEW ---
export const updateProductReview = async (req, res) => {
  try {
    if (!req.user) return res.status(200).json({ error: "Login required to update a review." });

    const { id, reviewId } = req.params;
    const query = [{ id }];
    if (mongoose.Types.ObjectId.isValid(id)) query.push({ _id: id });

    const product = await Product.findOne({ $or: query });
    if (!product) return res.status(200).json({ error: "Product not found" });

    const review = product.reviews?.find((rev) => String(rev._id) === String(reviewId));
    if (!review) return res.status(200).json({ error: "Review not found" });

    if (String(review.userId) !== String(req.user.id) && req.user.role !== 'Admin') {
      return res.status(403).json({ error: "Not authorized to update this review." });
    }

    const rating = Number(req.body.rating || req.body.rate || review.rating || 0);
    const title = String(req.body.title || review.title || '').trim();
    const comment = String(req.body.comment || review.comment || '').trim();
    const variant = String(req.body.variant || review.variant || '').trim();
    
    let removedImages = [];
    if (req.body.removedImages) {
        try {
            if (typeof req.body.removedImages === 'string') {
                removedImages = JSON.parse(req.body.removedImages);
            } else {
                removedImages = req.body.removedImages;
            }
        } catch (err) {
            removedImages = String(req.body.removedImages).split(',').map(s => s.trim()).filter(Boolean);
        }
    }

    const uploadedImages = (req.files || []).map(getFileUrl).filter(Boolean);
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: "Rating must be between 1 and 5." });
    if (!comment) return res.status(400).json({ error: "Review comment is required." });

    review.title = title;
    review.comment = comment;
    review.rating = rating;
    review.variant = variant;

    if (Array.isArray(removedImages) && removedImages.length) {
        try {
            await Promise.allSettled(removedImages.map(deleteFromCloudinary));
        } catch (err) {
            console.warn('Failed to delete some images from Cloudinary during review update:', err?.message || err);
        }
        review.images = Array.isArray(review.images) ? review.images.filter(img => !removedImages.includes(img)) : [];
    }

    if (uploadedImages.length) {
        const before = Array.isArray(review.images) ? review.images : [];
        const merged = [...before, ...uploadedImages].filter(Boolean);
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

        const product = await Product.findOne({ 
                $and: [
                    { $or: query },
                    { status: 'ACTIVE' }
                ]
            })
            .populate('categoryInfo.id')
            .populate('collectionInfo.id');

        if (!product) return res.status(200).json({ message: "Product not found or is currently drafted" });

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
        if (!product) return res.status(200).json({ message: "Product not found" });

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

        if (typeof updateData.isFeatured === 'string') updateData.isFeatured = parseBooleanValue(updateData.isFeatured);
        if (typeof updateData.taxable === 'string') updateData.taxable = parseBooleanValue(updateData.taxable);
        if (typeof updateData.isSponsored === 'string') updateData.isSponsored = parseBooleanValue(updateData.isSponsored);
        if (typeof updateData.sponsorPriority === 'string') {
            updateData.sponsorPriority = updateData.sponsorPriority === '' || updateData.sponsorPriority === 'null' ? 0 : Number(updateData.sponsorPriority) || 0;
        }
        
        // BUG FIX: Parse Dates Safely
        if (typeof updateData.sponsorUntil !== 'undefined') {
            updateData.sponsorUntil = parseDateValue(updateData.sponsorUntil);
        }

        const { byToken: uploadedByToken, byVariantIndex: uploadedByVariantIndex } = buildUploadMappings(req);

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

        await safeRedisDel(`product:detail:${id}`, `product:detail:${updatedProduct?._id || ''}`, `product:detail:${updatedProduct?.id || ''}`);
        await safeRedisDel("products:featured", "products:all");

        try {
            const oldImages = Array.isArray(product?.variants) ? product.variants.flatMap(v => (v.images || [])) : [];
            const newImages = Array.isArray(updatedProduct?.variants) ? updatedProduct.variants.flatMap(v => (v.images || [])) : [];
            const imagesToDelete = oldImages.filter((img) => img && !newImages.includes(img));
            for (const img of imagesToDelete) {
                try { await deleteFromCloudinary(img); } catch (err) {}
            }
        } catch (err) {}

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

        if (!deletedProduct) return res.status(200).json({ message: "Product not found" });

        try {
            const imgs = Array.isArray(deletedProduct.variants) ? deletedProduct.variants.flatMap(v => (v.images || [])) : [];
            for (const img of imgs) {
                try { await deleteFromCloudinary(img); } catch (err) {}
            }
        } catch (err) {}

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

        const featuredProducts = await Product.find({ isFeatured: true, status: 'ACTIVE' }, {
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

// --- GET ALL PRODUCTS ---
export const getAllProducts = async (req, res) => {
    try {
        setNoStoreHeaders(res);

        const cacheKey = "products:admin:all";
        const cached = await redisClient.get(cacheKey);
        
        if (cached) return res.status(200).json(JSON.parse(cached));

        const productsRaw = await Product.find({})
            .select("name id price discount fabric pattern fit salesCount isTrending createdAt variants type description categoryInfo collectionInfo isFeatured sizeType isSponsored sponsorPriority deal sponsorUntil status" ) 
            .sort({ createdAt: -1 })
            .lean();

        // 🟢 USING THE EXTRACTED HELPER FUNCTION
        const products = formatProductsHelper(productsRaw);

        await redisClient.setEx(cacheKey, 3600, JSON.stringify(products));
        return res.status(200).json(products);

    } catch (error) {
        console.error("Error in getAllProducts:", error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};

// --- TOGGLE PRODUCT STATUS ---
export const toggleProductStatus = async (req, res) => {
    try {
        const { id } = req.params;
        
        const query = [{ id }];
        if (mongoose.Types.ObjectId.isValid(id)) query.push({ _id: id });

        const product = await Product.findOne({ $or: query });

        if (!product) return res.status(200).json({ message: "Product not found" });

        // 1. Update the status
        product.status = product.status === 'ACTIVE' ? 'DRAFT' : 'ACTIVE';
        await product.save();

        // 2. Fetch the newly updated list from DB to ensure sync
        const updatedProductsRaw = await Product.find({})
            .select("name id price discount fabric pattern fit salesCount isTrending createdAt variants type description categoryInfo collectionInfo isFeatured sizeType isSponsored sponsorPriority deal sponsorUntil status")
            .sort({ createdAt: -1 })
            .lean();

        // 3. Format using the helper
        const formattedProducts = formatProductsHelper(updatedProductsRaw);

        // 4. Actively set the cache with the fresh formatted data
        await redisClient.setEx("products:admin:all", 3600, JSON.stringify(formattedProducts));
        
        await invalidateProductCache({
            categoryId: normalizeCacheId(product.categoryInfo?.id || product.categoryInfo?._id),
            collectionId: normalizeCacheId(product.collectionInfo?.id || product.collectionInfo?._id),
            categoryName: product.categoryInfo?.name,
            collectionName: product.collectionInfo?.name,
            productId: product.id
        });

        res.status(200).json({ 
            success: true, 
            message: `Product is now ${product.status}`, 
            status: product.status 
        });
    } catch (error) {
        console.error('Toggle Product Status Error:', error);
        res.status(500).json({ error: error.message });
    }
};