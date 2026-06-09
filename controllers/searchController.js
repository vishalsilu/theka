import Product from "../models/Product.js";
import Category from "../models/Category.js";
import Collection from "../models/Collection.js";
import { redisClient } from "../config/redis.js";

export const globalSearch = async (req, res) => {
    try {
        const { q, collection } = req.query; 

        // 1. Guard Clauses & Input Validations (Fixed order to check type first)
        if (!q || typeof q !== 'string') {
            return res.status(400).json({ error: "Search query 'q' is required and must be a string" });
        }

        const searchTerm = q.toLowerCase().trim();
        if (searchTerm.length < 2) {
            return res.status(200).json({ products: [], categories: [], collections: [] });
        }

        const collectionFilter = collection ? collection.toString().trim() : null;
        const cacheKey = `search:global:unlimited:${searchTerm}:${collectionFilter || 'all'}`;

        // 2. Check Redis Cache
        const cachedResults = await redisClient.get(cacheKey);
        if (cachedResults) return res.status(200).json(JSON.parse(cachedResults));

        const regex = new RegExp(searchTerm, 'i');

        // 3. Setup Multi-Field matching for Products
        const productQuery = {
            $or: [
                { name: regex },            // Match product name (e.g., "Linen Shirt")
                { "variants.color": regex } // Match variant color (e.g., "Blue")
            ]
        };

        if (collectionFilter) {
            productQuery['collectionInfo.name'] = { $regex: `^${collectionFilter}$`, $options: 'i' };
        }

        // 4. Parallel Search across Collections
        const [rawProducts, categories, collections] = await Promise.all([
            Product.find(productQuery)
                .select('name variants price id isFeatured discount collectionInfo quantity')
                .sort({ name: 1 })
                .lean({ virtuals: true }),
            
            Category.find({ name: regex })
                .select('name image id parentCollection')
                .populate('parentCollection', 'name')
                .sort({ name: 1 })
                .lean(),
            
            Collection.find({ name: regex })
                .select('name image id path')
                .sort({ name: 1 })
                .lean()
        ]);

        const normalizedCollectionFilter = collectionFilter?.toLowerCase();
        const filteredCategories = collectionFilter
            ? categories.filter(cat => cat.parentCollection?.name?.toLowerCase() === normalizedCollectionFilter)
            : categories;

        const filteredCollections = collectionFilter
            ? collections.filter(col => col.name?.toLowerCase() === normalizedCollectionFilter)
            : collections;

        // 5. Flatten and Filter Variants with Reduce Stock Sizing
        const flattenedProducts = [];

        rawProducts.forEach(product => {
            if (product.variants && product.variants.length > 0) {
                product.variants.forEach(variant => {
                    
                    const productTitle = product.name ? product.name.trim() : "";
                    const variantColor = variant.color ? variant.color.trim() : "";

                    const isNameMatch = regex.test(productTitle);
                    const isColorMatch = regex.test(variantColor);

                    // Keep variant if the product name matched OR this specific variant color matched
                    if (isNameMatch || isColorMatch) {
                        
                        // Use Reduce method to sum up quantities from size arrays
                        const variantTotalStock = (variant.sizes || []).reduce((acc, s) => {
                            return acc + (Number(s.stock || s.quantity) || 0);
                        }, 0);

                        flattenedProducts.push({
                            id: product.id,
                            variantId: variant.id,
                            name: variant.color ? `${product.name} (${variant.color})` : product.name, 
                            price: product.price,
                            salePrice: product.salePrice,
                            isFeatured: product.isFeatured,
                            color: variant.color,
                            thumbnail: variant.images && variant.images.length > 0 ? variant.images[0] : null,
                            sizes: variant.sizes,
                            isDefault: variant.isDefault,
                            totalQuantity: variantTotalStock,          // Combined stock quantity
                            inStock: variantTotalStock > 0,            // Status boolean flag
                            collectionInfo: {
                                name: product.collectionInfo?.name || null
                            }
                        });
                    }
                });
            } else if (regex.test(product.name || "")) {
                // Fallback for products without variants (only if name matched)
                const standaloneStock = Number(product.quantity) || 0;

                flattenedProducts.push({
                    id: product.id,
                    variantId: null,
                    name: product.name,
                    price: product.price,
                    salePrice: product.salePrice,
                    isFeatured: product.isFeatured,
                    thumbnail: null,
                    sizes: [],
                    totalQuantity: standaloneStock,
                    inStock: standaloneStock > 0,
                    collectionInfo: {
                        name: product.collectionInfo?.name || null
                    }
                });
            }
        });

        // Fixed baseline reference bug: assigned filtered arrays to results object
        const results = { 
            products: flattenedProducts, 
            categories: filteredCategories, 
            collections: filteredCollections 
        };

        // 6. Cache the results for 30 minutes
        await redisClient.setEx(cacheKey, 1800, JSON.stringify(results));

        res.status(200).json(results);
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            message: "Search failed", 
            error: error.message 
        });
    }
};