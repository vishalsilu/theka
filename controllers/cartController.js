import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { redisClient } from '../config/redis.js';
import Product from "../models/Product.js"
import User from "../models/Users.js";

const CART_PREFIX_USER = 'cart:user:';
const CART_PREFIX_GUEST = 'cart:guest:';
const TTL_SECONDS = 60 * 60 * 24 * 30;

const TOKEN_REGEX = /^[a-f0-9]{32}$/i;

const parseJwtUserId = (authHeader) => {
    
    if (!authHeader || !authHeader.startsWith('Bearer')) return null;
    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
                
        return decoded.id || null;
    } catch {
        return null;
    }
};

function normalizeCartItem(raw) {
    if (!raw || typeof raw !== 'object') return null;

    const productId = String(raw.productId || '').slice(0, 120);
    
    // Ensure this key name matches your User Schema EXACTLY
    // If schema says 'varient', use 'varient' here.
    const variantId = Number(raw.variantId ?? raw.varient); 

    const size = String(raw.size || '').slice(0, 20);
    // Enforce per-variant+size max quantity of 10
    const quantity = Math.min(10, Math.max(1, Number(raw.quantity) || 1));

    if (!productId || isNaN(variantId)) return null;

    return { productId, variantId, size, quantity };
}

function sanitizeThinCart(items) {
    if (!Array.isArray(items)) return [];
    return items
        .slice(0, 50)
        .map(normalizeCartItem)
        .filter(Boolean);
}

function mergeThinCarts(primary = [], secondary = []) {
    const merged = new Map();

    for (const raw of [...primary, ...secondary]) {
        const item = normalizeCartItem(raw);
        if (!item) continue;

        const key = `${item.productId}:${item.variantId}:${item.size}`;
        const existing = merged.get(key);

        if (existing) {
            existing.quantity = Math.min(10, existing.quantity + item.quantity);
        } else {
            // Ensure we never store more than allowed per item
            item.quantity = Math.min(10, item.quantity);
            merged.set(key, item);
        }
    }

    return [...merged.values()];
}

async function getUserCartItems(userId) {
    if (!userId) return [];

    const cached = await redisClient.get(`${CART_PREFIX_USER}${userId}`);
    if (cached) {
        const items = sanitizeThinCart(JSON.parse(cached));
        if (items.length) return items;
    }

    const user = await User.findOne({ id: userId }).select('cart');
    if (!user?.cart?.length) return [];

    const dbItems = user.cart
        .map(normalizeCartItem)
        .filter(Boolean);

    if (dbItems.length) {
        await redisClient.setEx(`${CART_PREFIX_USER}${userId}`, TTL_SECONDS, JSON.stringify(dbItems));
    }

    return dbItems;
}

async function saveUserCart(userId, items) {
    if (!userId) return [];
    const finalItems = sanitizeThinCart(items);
    
    // Save to Redis for fast access
    await redisClient.setEx(`${CART_PREFIX_USER}${userId}`, TTL_SECONDS, JSON.stringify(finalItems));
    
    // IMMEDIATELY sync to MongoDB so cart persists even if Redis expires or cron is delayed
    try {
        await User.findOneAndUpdate(
            { id: userId },
            { $set: { cart: finalItems } },
            { new: true }
        );
    } catch (err) {
        console.error(`Failed to save cart to DB for user ${userId}:`, err);
        // Mark as dirty for cron retry if immediate save fails
        await redisClient.sAdd('dirty_carts', String(userId)).catch(() => {});
    }
    
    return finalItems;
}

async function saveGuestCart(cartToken, items) {
    if (!cartToken) return [];
    const finalItems = sanitizeThinCart(items);
    await redisClient.setEx(`${CART_PREFIX_GUEST}${cartToken}`, TTL_SECONDS, JSON.stringify(finalItems));
    return finalItems;
}

export const getCart = async (req, res) => {
    try {
        const userId = parseJwtUserId(req.headers.authorization);
        const cartToken = String(req.headers['x-cart-token'] || '').trim();

        let thinItems = [];
        let bucket = 'guest';

        if (userId) {
            thinItems = await getUserCartItems(userId);
            bucket = 'user';
        } else if (cartToken && TOKEN_REGEX.test(cartToken)) {
            const raw = await redisClient.get(`${CART_PREFIX_GUEST}${cartToken}`);
            thinItems = raw ? sanitizeThinCart(JSON.parse(raw)) : [];
        }

        if (thinItems.length === 0) return res.status(200).json({ items: [], bucket });

        const productIds = [...new Set(thinItems.map(i => i.productId))];
        const products = await Product.find({ id: { $in: productIds } });

        const fullItems = thinItems.map(cartItem => {
            const product = products.find(p => p.id === cartItem.productId);
            if (!product) return null;

            const variant = product.variants.find(v => v.id === cartItem.variantId);
            if (!variant) return null;

            const sizeInfo = variant.sizes.find(s => s.size === cartItem.size);
            const availableStock = sizeInfo ? sizeInfo.stock : 0;

            return {
                productId: product.id,
                variantId: variant.id,
                name: product.name,
                color: variant.color,
                size: cartItem.size,
                image: variant.images[0],
                price: product.price,
                fit: product?.fit,
                salePrice: product.salePrice,
                discountDisplay: product.discountDisplay,
                quantity: Math.min(cartItem.quantity, availableStock, 10),
                stock: availableStock,
                inStock: availableStock > 0,
                type: product.collectionInfo?.name,
                category: product.categoryInfo?.name,
            };
        }).filter(Boolean);

        return res.status(200).json({
            items: fullItems,
            cartToken: userId ? null : cartToken,
            bucket
        });

    } catch (error) {
        console.error("Cart Hydration Error:", error);
        return res.status(500).json({ error: 'Failed to sync cart with database' });
    }
};
export const putCart = async (req, res) => {
    try {
        const userId = parseJwtUserId(req.headers.authorization);
        let cartToken = String(req.headers['x-cart-token'] || '').trim();
        
        const finalItems = sanitizeThinCart(req.body?.items);
        console.log(finalItems);
        // I am getting varientId in this finalItems
        
          
        if (userId) {
            await saveUserCart(userId, finalItems);
            // i got varient id in this also

            if (cartToken && TOKEN_REGEX.test(cartToken)) {
                await saveGuestCart(cartToken, finalItems);
            }

            return res.status(200).json({
                items: finalItems,
                cartToken: null,
                bucket: 'user'
            });
        }

        if (!cartToken || !TOKEN_REGEX.test(cartToken)) {
            cartToken = crypto.randomBytes(16).toString('hex');
        }

        await saveGuestCart(cartToken, finalItems);

        return res.status(200).json({
            items: finalItems,
            cartToken,
            bucket: 'guest'
        });
    } catch (error) {
        console.error("PutCart Error:", error);
        return res.status(500).json({ error: 'Failed to save cart' });
    }
};

export const logoutAndPreserveCart = async (req, res) => {
    try {
        const userId = parseJwtUserId(req.headers.authorization);
        const cartToken = String(req.headers['x-cart-token'] || '').trim();

        if (!userId) {
            return res.status(401).json({ error: 'Please login again' });
        }

        const userItems = await getUserCartItems(userId);
        let guestItems = [];
        let preservedToken = cartToken && TOKEN_REGEX.test(cartToken) ? cartToken : crypto.randomBytes(16).toString('hex');

        if (cartToken && TOKEN_REGEX.test(cartToken)) {
            const raw = await redisClient.get(`${CART_PREFIX_GUEST}${cartToken}`);
            guestItems = raw ? sanitizeThinCart(JSON.parse(raw)) : [];
        }

        const mergedItems = mergeThinCarts(userItems, guestItems);
        await saveGuestCart(preservedToken, mergedItems);

        return res.status(200).json({
            cartToken: preservedToken,
            bucket: 'guest'
        });
    } catch (error) {
        console.error("Logout Preserve Cart Error:", error);
        return res.status(500).json({ error: 'Failed to preserve cart on logout' });
    }
};


export const clearCart = async (req, res) => {
    try {
        const userId = parseJwtUserId(req.headers.authorization);
        const cartToken = String(req.headers['x-cart-token'] || '').trim();

        if (userId) {
            // Clear from Redis
            await redisClient.del(`${CART_PREFIX_USER}${userId}`).catch(() => {});
            // Clear from MongoDB
            await User.findOneAndUpdate(
                { id: userId },
                { $set: { cart: [] } }
            ).catch(() => {});
            console.log(`✅ Cart cleared from Redis & MongoDB for user ${userId}`);
        } else if (cartToken && TOKEN_REGEX.test(cartToken)) {
            // Clear guest cart from Redis only (guests don't have MongoDB)
            await redisClient.del(`${CART_PREFIX_GUEST}${cartToken}`).catch(() => {});
            console.log(`✅ Guest cart cleared from Redis for token ${cartToken}`);
        }

        return res.status(200).json({ success: true, message: "Cart cleared" });
    } catch (error) {
        console.error("Clear Cart Error:", error);
        return res.status(500).json({ error: "Failed to clear cart" });
    }
};