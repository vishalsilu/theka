import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import mongoose from 'mongoose'; // <-- ADDED: Required for ObjectId validation
import { redisClient } from '../config/redis.js';
import Product from "../models/Product.js";
import User from "../models/Users.js"; // Note: ensure this matches your actual filename
import { debounceCartSync } from "../utils/cartDebouncer.js";

const CART_PREFIX_USER = 'cart:user:';
const CART_PREFIX_GUEST = 'cart:guest:';
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

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

// Add this helper near the top of your cartController.js
const getSessionUserId = async (req) => {
    // 1. Grab token from cookies or authorization header
    let token = req.cookies?.token;
    if (!token && req.headers.authorization?.toLowerCase().startsWith('bearer ')) {
        token = req.headers.authorization.split(' ')[1];
    }

    if (!token) return null;

    try {
        // 2. Check Redis for the active session
        const sessionStr = await redisClient.get(`session:${token}`);
        if (sessionStr) {
            const session = JSON.parse(sessionStr);
            // Support both id and _id depending on your schema
            return session.user.id || session.user._id || null; 
        }

        // 3. Fallback: Just in case legacy JWTs are still floating around
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        return decoded.id || decoded.userId || null;
    } catch (error) {
        // Token is invalid or expired
        return null;
    }
};

export function normalizeCartItem(raw) { 
    if (!raw || typeof raw !== 'object') return null;

    const productId = String(raw.productId || '').slice(0, 120);
    // FIX: Default to 0 if undefined to prevent NaN from deleting the item
    const variantId = Number(raw.variantId ?? raw.varient) || 0; 
    const size = String(raw.size || '').slice(0, 20);
    // FIX: Allow up to 99 so you don't lose valid merged quantities
    const quantity = Math.min(99, Math.max(1, Number(raw.quantity) || 1));

    // Only reject if there is completely no product ID
    if (!productId) return null; 

    return { productId, variantId, size, quantity };
}

export function sanitizeThinCart(items) { // Exported in case you need it elsewhere
    if (!Array.isArray(items)) return [];
    return items
        .slice(0, 50)
        .map(normalizeCartItem)
        .filter(Boolean);
}

export function mergeThinCarts(primary = [], secondary = []) { // Exported for Auth Controller
    const merged = new Map();

    for (const raw of [...primary, ...secondary]) {
        const item = normalizeCartItem(raw);
        if (!item) continue;

        const key = `${item.productId}:${item.variantId}:${item.size}`;
        const existing = merged.get(key);

        if (existing) {
            existing.quantity = Math.min(10, existing.quantity + item.quantity);
        } else {
            item.quantity = Math.min(10, item.quantity);
            merged.set(key, item);
        }
    }

    return [...merged.values()];
}

// --- ADDED EXPORT & MONGOOSE ID FIX ---
export async function getUserCartItems(userId) {
    if (!userId) return [];

    const cached = await redisClient.get(`${CART_PREFIX_USER}${userId}`);
    if (cached) {
        const items = sanitizeThinCart(JSON.parse(cached));
        if (items.length) return items;
    }

    // Safely determine if userId is a Mongo _id or custom id
    const isObjectId = mongoose.Types.ObjectId.isValid(userId);
    const query = isObjectId ? { _id: userId } : { id: userId };

    const user = await User.findOne(query).select('cart');
    if (!user?.cart?.length) return [];

    const dbItems = user.cart
        .map(normalizeCartItem)
        .filter(Boolean);

    if (dbItems.length) {
        await redisClient.setEx(`${CART_PREFIX_USER}${userId}`, TTL_SECONDS, JSON.stringify(dbItems));
    }

    return dbItems;
}

// --- ADDED EXPORT & MONGOOSE ID FIX ---
export async function saveUserCart(userId, items) {
    if (!userId) return [];
    const finalItems = sanitizeThinCart(items);
    
    // Save to Redis for fast access
    await redisClient.setEx(`${CART_PREFIX_USER}${userId}`, TTL_SECONDS, JSON.stringify(finalItems));
    
    // Safely determine if userId is a Mongo _id or custom id
    const isObjectId = mongoose.Types.ObjectId.isValid(userId);
    const query = isObjectId ? { _id: userId } : { id: userId };

    // IMMEDIATELY sync to MongoDB
    try {
        // Corrected update line:
        await User.findOneAndUpdate(
            query,
            { $set: { cart: finalItems } },
            { returnDocument: 'after' }
        );
    } catch (err) {
        console.error(`Failed to save cart to DB for user ${userId}:`, err);
        await redisClient.sAdd('dirty_carts', String(userId)).catch(() => {});
    }
    
    return finalItems;
}

export async function saveGuestCart(cartToken, items) {
    if (!cartToken) return [];
    const finalItems = sanitizeThinCart(items);
    await redisClient.setEx(`${CART_PREFIX_GUEST}${cartToken}`, TTL_SECONDS, JSON.stringify(finalItems));
    return finalItems;
}

export const getCart = async (req, res) => {
    try {
         
        const userId = await getSessionUserId(req);
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
        const userId = await getSessionUserId(req);
        let cartToken = String(req.headers['x-cart-token'] || '').trim().replace(/['"]/g, '');
        
        // FIX: Force merge any duplicate items the frontend accidentally sent in the array!
        const rawRequested = sanitizeThinCart(req.body?.items);
        const requestedItems = mergeThinCarts([], rawRequested); 
        
        const validatedItems = [];
        const productIds = [...new Set(requestedItems.map(i => i.productId))];
        
        if (productIds.length > 0) {
            const products = await Product.find({ id: { $in: productIds } }).lean();
            
            for (const item of requestedItems) {
                const product = products.find(p => p.id === item.productId);
                if (!product) continue;
                
                const variant = product.variants?.find(v => v.id === item.variantId);
                // If it requires a variant but didn't find one, skip it. If no variants exist, allow it.
                if (product.variants?.length > 0 && !variant) continue;
                
                const sizeInfo = variant ? variant.sizes?.find(s => s.size === item.size) : null;
                const availableStock = sizeInfo ? sizeInfo.stock : 99; // Fallback stock if no variants
                
                if (availableStock <= 0) continue;
                
                const validatedQuantity = Math.min(item.quantity, availableStock, 99);
                
                validatedItems.push({
                    productId: item.productId,
                    variantId: item.variantId,
                    size: item.size,
                    quantity: validatedQuantity
                });
            }
        }
        
        const finalItems = sanitizeThinCart(validatedItems);
        
        if (userId) {
            await saveUserCart(userId, finalItems);
            
            if (typeof debounceCartSync === 'function') {
                debounceCartSync(String(userId)); 
            }

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
        const userId = await getSessionUserId(req);
        const cartToken = String(req.headers['x-cart-token'] || '').trim().replace(/['"]/g, '');

        let preservedToken = cartToken && TOKEN_REGEX.test(cartToken) 
            ? cartToken 
            : crypto.randomBytes(16).toString('hex');

        // FIX: NEVER MERGE ON LOGOUT. 
        // Just take the logged-in user's cart and clone it into the guest cart.
        let userItems = [];
        if (userId) {
            userItems = await getUserCartItems(userId);
        }

        await saveGuestCart(preservedToken, userItems);

        return res.status(200).json({
            cartToken: preservedToken,
            bucket: 'guest'
        });
    } catch (error) {
        console.error("Logout Preserve Cart Error:", error);
        return res.status(500).json({ error: 'Failed to preserve cart on logout' });
    }
};

// --- ADDED MONGOOSE ID FIX ---
export const clearCart = async (req, res) => {
    try {
         
        const userId = await getSessionUserId(req);
const cartToken = String(req.headers['x-cart-token'] || '').trim();

        if (userId) {
            await redisClient.del(`${CART_PREFIX_USER}${userId}`).catch(() => {});
            
            // Safely determine if userId is a Mongo _id or custom id
            const isObjectId = mongoose.Types.ObjectId.isValid(userId);
            const query = isObjectId ? { _id: userId } : { id: userId };

            await User.findOneAndUpdate(
                query,
                { $set: { cart: [] } }
            ).catch(() => {});

        } else if (cartToken && TOKEN_REGEX.test(cartToken)) {
            await redisClient.del(`${CART_PREFIX_GUEST}${cartToken}`).catch(() => {});
        }

        return res.status(200).json({ success: true, message: "Cart cleared" });
    } catch (error) {
        console.error("Clear Cart Error:", error);
        return res.status(500).json({ error: "Failed to clear cart" });
    }
};