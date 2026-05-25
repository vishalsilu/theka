import Product from "../models/Product.js";
import Category from "../models/Category.js";
import Collection from "../models/Collection.js";
import { redisClient } from "../config/redis.js";

export const globalSearch = async (req, res) => {
    try {
        const { q } = req.query; 

        if (!q || q.length < 2) {
            return res.status(200).json({ products: [], categories: [], collections: [] });
        }

        const searchTerm = q.toLowerCase().trim();
        const cacheKey = `search:global:unlimited:${searchTerm}`;

        // 1. Check Redis Cache
        const cachedResults = await redisClient.get(cacheKey);
        if (cachedResults) return res.status(200).json(JSON.parse(cachedResults));

        const regex = new RegExp(searchTerm, 'i');

        // 2. Parallel Search with Multi-Field matching for Products
        const [rawProducts, categories, collections] = await Promise.all([
            Product.find({
                $or: [
                    { name: regex },            // Match product name (e.g., "Linen Shirt")
                    { "variants.color": regex } // Match variant color (e.g., "Blue")
                ]
            })
                .select('name variants price id isFeatured discount')
                .sort({ name: 1 })
                .lean({ virtuals: true }),
            
            Category.find({ name: regex })
                .select('name image id ')
                .populate('parentCollection', 'name')
                .sort({ name: 1 })
                .lean(),
            
            Collection.find({ name: regex })
                .select('name image id')
                .sort({ name: 1 })
                .lean()
        ]);

        // 3. Flatten and Filter Variants
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
                            isDefault: variant.isDefault
                        });
                    }
                });
            } else if (product.name.match(regex)) {
                // Fallback for products without variants (only if name matched)
                flattenedProducts.push({
                    id: product.id,
                    variantId: null,
                    name: product.name,
                    price: product.price,
                    salePrice: product.salePrice,
                    isFeatured: product.isFeatured,
                    thumbnail: null,
                    sizes: []
                });
            }
        });

        const results = { products: flattenedProducts, categories, collections };

        // 4. Cache the results for 30 minutes
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