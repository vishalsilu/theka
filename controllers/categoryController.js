import mongoose from 'mongoose';
import Category from "../models/Category.js";
import Collection from "../models/Collection.js"; // Import Collection to handle featured logic
import Product from "../models/Product.js";
import {redisClient} from "../config/redis.js";
import { deleteFromCloudinary } from "../config/cloudinary.js";
import { enqueueNamePropagationJob } from "../tasks/namePropagation.js";
import { json } from 'stream/consumers';

const safeRedisDel = async (keys) => {
    const normalized = Array.isArray(keys) ? keys.flat(Infinity) : [keys];
    const filtered = normalized.filter(Boolean).map(String);
    if (!filtered.length) return;
    try {
        if (filtered.length === 1) {
            return await redisClient.del(filtered[0]);
        }
        return await redisClient.del(...filtered);
    } catch (error) {
        console.error("Redis delete failed for keys:", filtered, error);
        throw error;
    }
};

// 1. Updated Invalidation Logic
const invalidateCache = async (parentCollectionId = null, categoryId = null , type = null , category = null) => {
    const keys = [
        "categories:all",
        "navigation:megamenu",
        "collections:featured",
        "collections:all"
    ];

    if (parentCollectionId) {
        keys.push(`categories:${parentCollectionId}`);
        keys.push(`collections:detail:${parentCollectionId}`);
        keys.push(`collection:${parentCollectionId}`);
    }

    if (categoryId) {
        keys.push(`category:${categoryId}`);
    }

    if(type && category){
        keys.push(`categoryAd:${type}/${category}`)
    }

    await safeRedisDel(keys);

    // Also clear any dynamic category/collection cache namespaces that may still exist.
    for await (const key of redisClient.scanIterator({ MATCH: `categories:*` })) {
        await safeRedisDel(key);
    }
    for await (const key of redisClient.scanIterator({ MATCH: `collection:*` })) {
        await safeRedisDel(key);
    }
    for await (const key of redisClient.scanIterator({ MATCH: `collections:*` })) {
        await safeRedisDel(key);
    }
    for await (const key of redisClient.scanIterator({ MATCH: `dynamicFilters:*` })) {
        await safeRedisDel(key);
    }
    for await (const key of redisClient.scanIterator({ MATCH: `categoryAd:*` })) {
        await safeRedisDel(key);
    }
};

// export const createCategory = async (req, res) => {

//     try {
//         const categoryData = { ...req.body };

//         if (req.file) {
//             categoryData.image = req.file.path || req.file.secure_url || req.file.url;
//         }

//         const newCategory = new Category(categoryData);
//         await newCategory.save();

//         const parentCollectionId = categoryData.parentCollection?.toString?.() || categoryData.parentCollection || null;
//         await invalidateCache(parentCollectionId, newCategory._id);

//         res.status(201).json({ success: true, data: newCategory });
//     } catch (error) {
//         res.status(500).json({ error: error.message });
//     }
// };


export const createCategory = async (req, res) => {
    try {
        const categoryData = { ...req.body };

        // Handle multiple files
        if (req.files) {
            if (req.files.image && req.files.image[0]) {
                const img = req.files.image[0];
                categoryData.image = img.path || img.secure_url || img.url;
            }
            if (req.files.ad && req.files.ad[0]) {
                const adImg = req.files.ad[0];
                categoryData.ad = adImg.path || adImg.secure_url || adImg.url;
            }
        }

        const newCategory = new Category(categoryData);
        await newCategory.save();

        const parentCollectionId = categoryData.parentCollection?.toString?.() || categoryData.parentCollection || null;
        await invalidateCache(parentCollectionId, newCategory._id);

        res.status(201).json({ success: true, data: newCategory });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const getAllCategories = async (req, res) => {
    try {
        const cacheKey = "categories:all";
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
                console.warn('Invalid categories cache value, refreshing from DB:', err?.message || err);
                await redisClient.del(cacheKey);
            }
        }

        const categories = await Category.find()
            .populate('parentCollection', 'name')
            .lean();
        
        await redisClient.setEx(cacheKey, 86400, JSON.stringify(categories));
        res.status(200).json(categories);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};




// export const updateCategory = async (req, res) => {
//     try {
//         const { id } = req.params;
//         const updateData = { ...req.body };

//         // 1. Fetch current category to handle image deletion & parent checks
//         const category = await Category.findById(id);
//         if (!category) return res.status(200).json({ message: "Category not found" });

//         // 2. Handle Image Update
//         if (req.file) {
//             // Delete old image from Cloudinary if it exists
//             if (category.image) {
//                 await deleteFromCloudinary(category.image);
//             }
//             // Set the new image path
//             updateData.image = req.file.path || req.file.secure_url || req.file.url;
//         }

//         // 3. Perform the Update
//         const updatedCategory = await Category.findByIdAndUpdate(
//             id,
//             { $set: updateData },
//             { new: true, runValidators: true }
//         );

//         if (updateData.name) {
//             const newName = String(updateData.name).trim();
//             const oldName = String(category?.name || "").trim();
//             if (newName && oldName && newName !== oldName) {
//                 enqueueNamePropagationJob({ type: 'category', id, newName }).catch((err) => {
//                     console.warn('Failed to queue category name propagation job:', err?.message || err);
//                 });
//             }
//         }

//         // 5. Cache Invalidation Logic
//         const oldParentCollectionId = category.parentCollection?._id || category.parentCollection || null;
//         await invalidateCache(oldParentCollectionId, id);

//         // 6. Handle Parent Collection Change
//         const newParentId = updateData.parentCollection || null;
//         if (newParentId && oldParentCollectionId?.toString() !== newParentId.toString()) {
//             await invalidateCache(newParentId, id);
//         }

//         res.status(200).json({ 
//             success: true, 
//             message: "Category updated successfully", 
//             data: updatedCategory 
//         });

//     } catch (error) {
//         res.status(500).json({ error: error.message });
//     }
// };

export const updateCategory = async (req, res) => {
    try {
        const { id } = req.params;
        const updateData = { ...req.body };

        // 1. Fetch current category
        const category = await Category.findById(id);
        if (!category) return res.status(200).json({ message: "Category not found" });

        // 2. Handle Image & Ad Updates/Replacements
        if (req.files) {
            // Main Category Image
            if (req.files.image && req.files.image[0]) {
                if (category.image) {
                    await deleteFromCloudinary(category.image);
                }
                const img = req.files.image[0];
                updateData.image = img.path || img.secure_url || img.url;
            }

            // Ad Image
            if (req.files.ad && req.files.ad[0]) {
                if (category.ad) {
                    await deleteFromCloudinary(category.ad);
                }
                const adImg = req.files.ad[0];
                updateData.ad = adImg.path || adImg.secure_url || adImg.url;
            }
        }

        // 3. Handle Explicit Deletion of the Ad (without replacement)
        // Send a boolean 'removeAd: true' from the frontend if the user clicks "Delete Ad"
        if (req.body.removeAd === 'true' || req.body.removeAd === true) {
            if (category.ad) {
                await deleteFromCloudinary(category.ad);
                updateData.ad = null; 
            }
        }

        // 4. Perform the Update
        const updatedCategory = await Category.findByIdAndUpdate(
            id,
            { $set: updateData },
            { new: true, runValidators: true }
        );

        if (updateData.name) {
            const newName = String(updateData.name).trim();
            const oldName = String(category?.name || "").trim();
            if (newName && oldName && newName !== oldName) {
                enqueueNamePropagationJob({ type: 'category', id, newName }).catch((err) => {
                    console.warn('Failed to queue category name propagation job:', err?.message || err);
                });
            }
        }

        // 5. Cache Invalidation Logic
        const oldParentCollectionId = category.parentCollection?._id || category.parentCollection || null;
        await invalidateCache(oldParentCollectionId, id);

        // 6. Handle Parent Collection Change
        const newParentId = updateData.parentCollection || null;
        if (newParentId && oldParentCollectionId?.toString() !== newParentId.toString()) {
            await invalidateCache(newParentId, id);
        }

        res.status(200).json({ 
            success: true, 
            message: "Category updated successfully", 
            data: updatedCategory 
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const categoryAdByPath = async (req, res) => {
    const { type, category } = req.params;
    const adCache = `categoryAd:${type}/${category}`;
    
    try {
        const cached = await redisClient.get(adCache);
        
        // FIX 1: Check if the 'cached' data exists, not the string key
        if (cached) {
            // FIX 2: Parse the actual cached data
            const result = JSON.parse(cached);
            // FIX 3: Return a proper Express response
            return res.status(200).json({ success: true, ad: result.ad , url:result.adUrl});
        }
        
        const expectedPath = `/${type.toLowerCase()}/${category.toLowerCase().replace(/\s+/g, '-')}`;

        const categoryData = await Category.findOne({ path: expectedPath }).select('ad adUrl');

        if (!categoryData || !categoryData.ad) {
            return res.status(200).json({ success: false, message: "Ad not found." });
        }

        await redisClient.setEx(adCache, 86400, JSON.stringify(categoryData));
        
        return res.status(200).json({ success: true, ad: categoryData.ad , url:categoryData.adUrl});
        
    } catch (error) {
        console.error("Error in categoryAdByPath:", error);
        
        // It's good practice to await Redis operations in modern Node Redis clients
        if (redisClient.isOpen) {
            await redisClient.del(adCache); 
        }
        
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
}


export const deleteCategory = async (req, res) => {
    try {
        const { id } = req.params;

        // 1. Delete the category
        const deletedCategory = await Category.findByIdAndDelete(id);

        if (!deletedCategory) {
            return res.status(200).json({ message: "Category not found" });
        }

        // 2. Clear references in Collections
        // Since 'featured' is an array, we use $pull to remove the specific object
        // that references this category ID.
        const affectedCollections = await Collection.find({ "featured.featuredCategory": id });
        
        await Collection.updateMany(
            { "featured.featuredCategory": id },
            { $pull: { featured: { featuredCategory: id } } }
        );

        // 3. Redis Invalidation
        const parentId = deletedCategory.parentCollection;

        // Remove category image from Cloudinary (cleanup)
        try {
            if (deletedCategory.image) await deleteFromCloudinary(deletedCategory.image);
        } catch (err) {
            console.warn('Failed to delete Cloudinary image for category:', deletedCategory.image, err?.message || err);
        }

        await invalidateCache(parentId, id);

        // Also clear the specific cache for every collection that was referencing this category
        const extraKeys = [];
        affectedCollections.forEach(col => {
            extraKeys.push(`collection:${col._id}`);
            extraKeys.push(`collections:detail:${col._id}`);
        });
        if (extraKeys.length) {
            await safeRedisDel(extraKeys);
        }

        res.status(200).json({ 
            success: true, 
            message: `Category '${deletedCategory.name}' deleted and all featured references cleared.` 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

export const getCollectionCategory = async(req,res) => {
    const {collectionId} = req.params;
    
    if (!collectionId) return res.status(400).json({ error : "Collection is not Available" });

    try {
        let resolvedCollectionId = collectionId;
        if (!mongoose.isValidObjectId(collectionId)) {
            const collection = await Collection.findOne({
                $or: [
                    { path: collectionId },
                    { name: new RegExp(`^${collectionId}$`, 'i') },
                    { path: `/${collectionId}` }
                ]
            }).lean();
            if (collection) resolvedCollectionId = collection._id;
        }

        const cacheKey = `categories:${collectionId}`;
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
                console.warn('Invalid collection-category cache value, refreshing from DB:', err?.message || err);
                await redisClient.del(cacheKey);
            }
        }

        const categories = await Category.find({ parentCollection: resolvedCollectionId })
            .populate('parentCollection', 'name')
            .lean();
        
        await redisClient.setEx(cacheKey, 86400, JSON.stringify(categories));
        res.status(200).json(categories);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export const getDynamicFiltersByName = async (req, res) => {
    try {
        // 1. Destructure from route parameters (matches your req.params setup)
        // Expected route definition: /api/filters/:collectionName/:categoryName
        const { collectionName, categoryName } = req.params;

        if (!collectionName || !categoryName) {
            return res.status(400).json({ 
                error: "Both collectionName and categoryName are required parameters." 
            });
        }

        // 2. Create a clean Redis key pointing to the exact filter options combo
        const cacheKey = `dynamicFilters:${collectionName.toLowerCase()}:${categoryName.toLowerCase()}`;

        // 3. Try fetching compiled filter sets from Redis first
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
            return res.status(200).json(JSON.parse(cachedData));
        }

        // 4. Cache Miss: Run an aggregation pipeline across your active inventory
        const filterAggregation = await Product.aggregate([
            {
                // Filter down to the matching string names (case-insensitive for safety)
                $match: {
                    "collectionInfo.name": { $regex: new RegExp(`^${collectionName}$`, "i") },
                    "categoryInfo.name": { $regex: new RegExp(`^${categoryName}$`, "i") }
                }
            },
            {
                // Strip out unnecessary properties early to preserve RAM during aggregation
                $project: {
                    fit: 1,
                    fabric: 1,
                    pattern: 1,
                    variants: 1
                }
            },
            // Unwind the variants array to parse single color lines
            { $unwind: { path: "$variants", preserveNullAndEmptyArrays: false } },
            // Unwind the sizes array nested deep within the variant configuration
            { $unwind: { path: "$variants.sizes", preserveNullAndEmptyArrays: false } },
            // {
        //   This is for Hide Out of stock Variations from Filter Options, but we can remove this block if you want to show all sizes regardless of stock status

            //     $match: {
            //         "variants.sizes.stock": { $gt: 0 }
            //     }
            // },
            {
                // Group everything across our matching products into unique, clean sets
                $group: {
                    _id: null,
                    allFits: { $addToSet: "$fit" },
                    allColors: { $addToSet: "$variants.color" },
                    allSizes: { $addToSet: "$variants.sizes.size" },
                    allFabrics: { $addToSet: "$fabric" },
                    allPatterns: { $addToSet: "$pattern" }
                }
            }
        ]);

        // If no items map to this combination, return empty configurations safely
        if (!filterAggregation || filterAggregation.length === 0) {
            return res.status(200).json({
                Fit: [],
                Color: [],
                Size: [],
                Fabric: [],
                Pattern: []
            });
        }

        const rawFilters = filterAggregation[0];

        // 5. Intelligent Sorter Helper for Alphanumeric or Waist Numbers
        const cleanAndSortSizes = (sizesArray) => {
            return sizesArray
                .filter(Boolean)
                .sort((a, b) => {
                    // Check if they are numeric sizes (e.g., jeans sizes "28", "30", "32")
                    if (!isNaN(a) && !isNaN(b)) return Number(a) - Number(b);
                    
                    // Standard retail order map for alpha sizes
                    const alphaOrder = { 'XS': 1, 'S': 2, 'M': 3, 'L': 4, 'XL': 5, 'XXL': 6, 'XXXL': 7, 'FREE SIZE': 8 };
                    return (alphaOrder[a.toUpperCase()] || 99) - (alphaOrder[b.toUpperCase()] || 99);
                });
        };

        // Assemble the final, sorted client-side filter model
        const dynamicFilters = {
            Fit: rawFilters.allFits.filter(Boolean).sort(),
            Color: rawFilters.allColors.filter(Boolean).sort(),
            Size: cleanAndSortSizes(rawFilters.allSizes),
            Fabric: rawFilters.allFabrics.filter(Boolean).sort(),
            Pattern: rawFilters.allPatterns.filter(Boolean).sort()
        };

        // 6. Cache the calculated filter values for 24 hours (86400 seconds)
        // Since inventory changes, you can lower this time block if you need high accuracy
        await redisClient.setEx(cacheKey, 86400, JSON.stringify(dynamicFilters));

        // 7. Fire response to frontend
        return res.status(200).json(dynamicFilters);

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};