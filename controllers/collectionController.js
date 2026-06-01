import Collection from "../models/Collection.js";
import {redisClient} from "../config/redis.js";
import { deleteFromCloudinary } from "../config/cloudinary.js";
import { enqueueNamePropagationJob } from "../tasks/namePropagation.js";

const clearCollectionCache = async (id = null) => {
    // These keys are "Global" - they affect everyone
    const keys = [
        "collections:all", 
        "navigation:megamenu", 
        "collections:featured"
    ];

    // This key is "Specific" - only affects one collection detail page
    if (id) keys.push(`collections:detail:${id}`);
    
    try {
        const toDel = keys.filter(Boolean);
        if (toDel.length) await redisClient.del(...toDel);
    } catch (err) {
        console.error("Redis Cache Invalidation Error:", err);
    }
};

export const createCollection = async (req, res) => {
    try {
        // If the client sent `featured` as a JSON string (FormData or stringified payload), parse it.
        if (typeof req.body.featured === 'string') {
            try {
                req.body.featured = JSON.parse(req.body.featured);
            } catch (err) {
                // Ignore parse error; let Mongoose validate and return a helpful message
            }
        }

        // If an image was uploaded via multer/cloudinary, attach its URL to the body
        if (req.file) {
            req.body.image = req.file.path || req.file.secure_url || req.file.url;
        }

        const newCollection = new Collection(req.body);
        await newCollection.save();

        await clearCollectionCache();

        res.status(201).json({ success: true, data: newCollection });
    } catch (error) {
        if (error.code === 11000) return res.status(400).json({ message: "Collection name must be unique" });
        res.status(500).json({ error: error.message });
    }
};

export const getAllCollections = async (req, res) => {
    try {
        const cacheKey = "collections:all";
        console.log('[getAllCollections] Starting...');

        // 1. Check Redis Cache
        const cached = await redisClient.get(cacheKey);
        console.log('[getAllCollections] Cache check:', cached ? 'HIT (length: ' + (cached?.length || 0) + ')' : 'MISS');
        
        if (cached) {
            try {
                const parsed = JSON.parse(cached);
                console.log('[getAllCollections] Parsed cache:', Array.isArray(parsed) ? `array[${parsed.length}]` : typeof parsed);
                
                if (Array.isArray(parsed)) {
                    if (parsed.length > 0) {
                        console.log('[getAllCollections] Returning non-empty cache');
                        return res.status(200).json({ success: true, collections: parsed });
                    }
                    // Empty array cache may be stale if the DB now contains collections.
                    console.log('[getAllCollections] Cache is empty array, deleting stale cache');
                    await redisClient.del(cacheKey);
                }
            } catch (err) {
                console.warn('[getAllCollections] Invalid cache, refreshing from DB:', err?.message || err);
                await redisClient.del(cacheKey);
            }
        }

        // 2. Fetch from DB (Populate categories for the megamenu)
        console.log('[getAllCollections] Querying MongoDB...');
        const collections = await Collection.find().populate('allCategories')
            .lean({ virtuals: true });
        console.log('[getAllCollections] DB returned', collections.length, 'collections');

        // 3. Save to Redis (Expire in 24 hours)
        console.log('[getAllCollections] Caching result...');
        await redisClient.setEx(cacheKey, 86400, JSON.stringify(collections));
        console.log('[getAllCollections] Response sent:', collections.length, 'collections');
        res.status(200).json({ success: true, collections });
    } catch (error) {
        console.error('[getAllCollections] ERROR:', error);
        res.status(500).json({ error: error.message });
    }
};

export const toggleCollectionFeatured = async (req, res) => {
    try {
        const { id } = req.params;
        const { isFeatured, featuredCategoryId } = req.body;

        if (!featuredCategoryId) {
            return res.status(400).json({ message: "featuredCategoryId is required" });
        }

        const collection = await Collection.findById(id);
        if (!collection) return res.status(404).json({ message: "Collection not found" });

        const isAlreadyFeatured = collection.featured.some(
            (item) => item.featuredCategory.toString() === featuredCategoryId
        );

        let update;

        if (isFeatured) {
            if (isAlreadyFeatured) return res.status(400).json({ message: "Already featured" });
            update = { $push: { featured: { isFeatured: true, featuredCategory: featuredCategoryId } } };
        } else {
            if (!isAlreadyFeatured) return res.status(400).json({ message: "Category wasn't featured" });
            update = { $pull: { featured: { featuredCategory: featuredCategoryId } } };
        }

        const updated = await Collection.findByIdAndUpdate(id, update, { new: true })
            .populate("featured.featuredCategory", "name");

        // --- REDIS LOGIC: CACHE INVALIDATION ---
        // 1. Delete the specific collection cache
        await redisClient.del(`collection:${id}`);
        
        // 2. Delete list caches (like 'all_collections' or 'featured_collections')
        // This ensures the lists on the frontend reflect the change immediately
        await redisClient.del("collections:featured");
        await redisClient.del("collections:all");

        res.status(200).json({ success: true, data: updated });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const getCollectionDetails = async (req, res) => {
    try {
        const { id } = req.params;
        const cacheKey = `collections:detail:${id}`;

        const cached = await redisClient.get(cacheKey);
        if (cached) return res.status(200).json(JSON.parse(cached));

        const collection = await Collection.findById(id)
            .populate('allCategories')
            .populate('featured.featuredCategory') // Populate the category chosen as featured
            .lean({ virtuals: true });

        if (!collection) return res.status(404).json({ message: "Collection not found" });

        await redisClient.setEx(cacheKey, 86400, JSON.stringify(collection));

        res.status(200).json(collection);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const updateCollection = async (req, res) => {
    try {
        const { id } = req.params;
        // If the client sent `featured` as a JSON string (from FormData), parse it so Mongoose gets an array
        if (typeof req.body.featured === 'string') {
            try {
                req.body.featured = JSON.parse(req.body.featured);
            } catch (err) {
                // Leave as-is; Mongoose will throw a validation error if necessary
            }
        }

        // Normalize removeImage flag (FormData may pass 'true' string)
        const removeImageFlag = req.body.removeImage === true || req.body.removeImage === 'true';

        // Fetch existing collection to handle image replacement/deletion cleanly
        const existing = await Collection.findById(id);
        if (!existing) return res.status(404).json({ message: "Not found" });

        // If a new file was uploaded, set the image URL and delete the old one
        if (req.file) {
            // Delete old image if present
            if (existing.image) {
                try {
                    await deleteFromCloudinary(existing.image);
                } catch (err) {
                    console.warn('Failed to delete old collection image from Cloudinary:', err?.message || err);
                }
            }
            req.body.image = req.file.path || req.file.secure_url || req.file.url;
        }

        // If client requested removal of image without uploading a new one
        if (removeImageFlag && !req.file) {
            if (existing.image) {
                try {
                    await deleteFromCloudinary(existing.image);
                } catch (err) {
                    console.warn('Failed to delete collection image from Cloudinary:', err?.message || err);
                }
            }
            req.body.image = null;
        }

        const oldCollection = await Collection.findByIdAndUpdate(
            id,
            { $set: req.body },
            { new: false, runValidators: true }
        );

        if (!oldCollection) return res.status(404).json({ message: "Not found" });

        if (req.body.name) {
            const newName = String(req.body.name).trim();
            const oldName = String(oldCollection?.name || "").trim();
            if (newName && oldName && newName !== oldName) {
                enqueueNamePropagationJob({ type: 'collection', id, newName }).catch((err) => {
                    console.warn('Failed to queue collection name propagation job:', err?.message || err);
                });
            }
        }

        await clearCollectionCache(id);

        res.status(200).json({ success: true, message: "Collection updated" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const deleteCollection = async (req, res) => {
    try {
        const { id } = req.params;
        const deleted = await Collection.findByIdAndDelete(id);
        
        if (!deleted) return res.status(404).json({ message: "Collection not found" });

        await clearCollectionCache(id);

        res.status(200).json({ success: true, message: "Collection and related caches deleted" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const getFeaturedCollection = async (req, res) => {
    const cacheKey = "collections:featured";
    console.log('[getFeaturedCollection] Starting...');

    try {
        // 1. Try to get data from Redis
        const cachedData = await redisClient.get(cacheKey);
        console.log('[getFeaturedCollection] Cache check:', cachedData ? 'HIT (length: ' + (cachedData?.length || 0) + ')' : 'MISS');
        
        if (cachedData) {
            try {
                const parsed = JSON.parse(cachedData);
                console.log('[getFeaturedCollection] Parsed cache:', Array.isArray(parsed) ? `array[${parsed.length}]` : typeof parsed);
                
                if (Array.isArray(parsed)) {
                    if (parsed.length > 0) {
                        console.log('[getFeaturedCollection] Returning non-empty cache');
                        return res.status(200).json({ data: parsed });
                    }
                    console.log('[getFeaturedCollection] Cache is empty array, deleting stale cache');
                    await redisClient.del(cacheKey);
                }
            } catch (err) {
                console.warn('[getFeaturedCollection] Invalid cache, refreshing from DB:', err?.message || err);
                await redisClient.del(cacheKey);
            }
        }

        // 2. If not in Redis, get from MongoDB
        console.log('[getFeaturedCollection] Querying MongoDB...');
        const featured = await Collection.find({ "featured.isFeatured": true })
            .populate("featured.featuredCategory", "name");
        console.log('[getFeaturedCollection] DB returned', featured.length, 'featured collections');

        // 3. Save result to Redis for next time (expire in 1 hour)
        console.log('[getFeaturedCollection] Caching result...');
        await redisClient.setEx(cacheKey, 3600, JSON.stringify(featured));
        console.log('[getFeaturedCollection] Response sent:', featured.length, 'collections');

        res.status(200).json({ success: true, source: "database", data: featured });
    } catch (error) {
        console.error('[getFeaturedCollection] ERROR:', error);
        res.status(500).json({ error: error.message });
    }
};