import { redisClient } from "../config/redis.js";
import Ad from "../models/Ad.js";
// import { deleteFromCloudinary } from "../utils/cloudinary.js"; 

// Helper function to generate consistent cache keys
const getCacheKey = (collectionName, categoryName) => {
    if (!collectionName || !categoryName) return null;
    return `ad:${collectionName.toLowerCase()}:${categoryName.toLowerCase()}`;
};

// ==========================================
// 1. CREATE AD
// ==========================================
export const createAd = async (req, res) => {
    try {
        const adData = { ...req.body };

        // Handle stringified nested objects if sent via multipart/form-data
        if (typeof adData.collectionInfo === 'string') {
            adData.collectionInfo = JSON.parse(adData.collectionInfo);
        }
        if (typeof adData.categoryInfo === 'string') {
            adData.categoryInfo = JSON.parse(adData.categoryInfo);
        }

        // Handle Image
        if (req.file) {
            adData.image = req.file.path || req.file.secure_url || req.file.url;
        }

        const newAd = new Ad(adData);
        await newAd.save();

        // CACHE MANAGEMENT: Invalidate the cache for this combination so the new ad can be fetched
        const cacheKey = getCacheKey(newAd.collectionInfo?.name, newAd.categoryInfo?.name);
        if (cacheKey) {
            await redisClient.del(cacheKey);
        }

        res.status(201).json({ 
            success: true, 
            message: "Ad created successfully",
            data: newAd 
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

// ==========================================
// 2. GET ALL ADS
// ==========================================
export const getAds = async (req, res) => {
    try {
        const filter = {};
        if (req.query.collectionId) {
            filter['collectionInfo.id'] = req.query.collectionId;
        }
        if (req.query.categoryId) {
            filter['categoryInfo.id'] = req.query.categoryId;
        }

        const ads = await Ad.find(filter).sort({ _id: -1 }); 

        res.status(200).json({ 
            success: true, 
            count: ads.length,
            data: ads 
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

// ==========================================
// 3. GET SINGLE AD BY ID
// ==========================================
export const getAdById = async (req, res) => {
    try {
        const { id } = req.params;
        const ad = await Ad.findById(id);

        if (!ad) {
            return res.status(200).json({ success: false, message: "Ad not found" });
        }

        res.status(200).json({ 
            success: true, 
            data: ad 
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

// ==========================================
// 3.5. GET SINGLE AD BY CATEGORY/COLLECTION
// ==========================================
// ==========================================
// 3.5. GET SINGLE AD BY CATEGORY/COLLECTION
// ==========================================
export const getSingleAd = async (req, res) => {
    try {
        const { collectionName, categoryName } = req.query;

        if (!collectionName || !categoryName) {
            return res.status(400).json({ 
                success: false, 
                message: "Both collectionName and categoryName are required." 
            });
        }

        // Cache keys should also be standardized to lowercase so "Men" and "men" hit the same cache
        const cacheKey = getCacheKey(collectionName.trim(), categoryName.trim());
        const cachedAd = await redisClient.get(cacheKey);
        
        if (cachedAd) {
            return res.status(200).json({ 
                success: true, 
                data: JSON.parse(cachedAd) 
            });
        }

        // THE FIX: Use Regex for case-insensitive matching and trim whitespace
       // Helper function to build a flexible regex
const buildFlexibleRegex = (searchTerm) => {
    if (!searchTerm) return '';

    // 1. Trim leading and trailing spaces
    let formattedTerm = searchTerm.trim();

    // 2. Escape special regex characters to prevent regex injection
    // (e.g., if a user sends a string with (, ), or *, it won't break the query)
    formattedTerm = formattedTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // 3. Replace any sequence of spaces or hyphens with a regex pattern 
    // that matches one or more spaces OR hyphens: [\s\-]+
    formattedTerm = formattedTerm.replace(/[\s\-]+/g, '[\\s\\-]+');

    // 4. Return the case-insensitive ('i') RegExp matching the exact string (^...$)
    return new RegExp(`^${formattedTerm}$`, 'i');
};

// Apply the helper function to your filter
const filter = {
    'collectionInfo.name': buildFlexibleRegex(collectionName),
    'categoryInfo.name': buildFlexibleRegex(categoryName)
};

const ad = await Ad.findOne(filter).sort({ _id: -1 });


        if (!ad) {
            return res.status(200).json({ 
                success: false, 
                message: "No ad found for this collection and category combination." 
            });
        }

        await redisClient.setEx(cacheKey, 3600, JSON.stringify(ad));

        res.status(200).json({ 
            success: true, 
            data: ad 
        });

    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
};

// ==========================================
// 4. UPDATE AD
// ==========================================
export const updateAd = async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = { ...req.body };

        if (typeof updateData.collectionInfo === 'string') {
            updateData.collectionInfo = JSON.parse(updateData.collectionInfo);
        }
        if (typeof updateData.categoryInfo === 'string') {
            updateData.categoryInfo = JSON.parse(updateData.categoryInfo);
        }

        const ad = await Ad.findById(id);
        if (!ad) {
            return res.status(200).json({ success: false, message: "Ad not found" });
        }

        if (req.file) {
            // if (ad.image) await deleteFromCloudinary(ad.image); 
            updateData.image = req.file.path || req.file.secure_url || req.file.url;
        }

        const updatedAd = await Ad.findByIdAndUpdate(
            id,
            { $set: updateData },
            { new: true, runValidators: true }
        );

        // CACHE MANAGEMENT: 
        const oldCacheKey = getCacheKey(ad.collectionInfo?.name, ad.categoryInfo?.name);
        const newCacheKey = getCacheKey(updatedAd.collectionInfo?.name, updatedAd.categoryInfo?.name);

        // If the admin changed the category/collection during the update, delete the old cache key
        if (oldCacheKey && oldCacheKey !== newCacheKey) {
            await redisClient.del(oldCacheKey);
        }

        // Update the Redis cache with the newly updated data immediately
        if (newCacheKey) {
            await redisClient.setEx(newCacheKey, 3600, JSON.stringify(updatedAd));
        }

        res.status(200).json({ 
            success: true, 
            message: "Ad updated successfully", 
            data: updatedAd 
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};

// ==========================================
// 5. DELETE AD
// ==========================================
export const deleteAd = async (req, res) => {
    try {
        const { id } = req.params;

        const ad = await Ad.findById(id);
        if (!ad) {
            return res.status(200).json({ success: false, message: "Ad not found" });
        }

        // if (ad.image) await deleteFromCloudinary(ad.image);

        await Ad.findByIdAndDelete(id);

        // CACHE MANAGEMENT: Remove the deleted ad from Redis
        const cacheKey = getCacheKey(ad.collectionInfo?.name, ad.categoryInfo?.name);
        if (cacheKey) {
            await redisClient.del(cacheKey);
        }

        res.status(200).json({ 
            success: true, 
            message: "Ad deleted successfully" 
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
};