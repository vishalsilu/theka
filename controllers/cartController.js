import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { redisClient } from '../config/redis.js';
import Product from "../models/Product.js";
import User from "../models/Users.js"; 
import { debounceCartSync } from "../utils/cartDebouncer.js";

const CART_PREFIX_USER = 'cart:user:';
const CART_PREFIX_GUEST = 'cart:guest:';
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const TOKEN_REGEX = /^[a-f0-9]{32}$/i;

const getSessionUserId = async (req) => {
    let token = req.cookies?.token;
    if (!token && req.headers.authorization?.toLowerCase().startsWith('bearer ')) {
        token = req.headers.authorization.split(' ')[1];
    }

    if (!token) return null;

    try {
        const sessionStr = await redisClient.get(`session:${token}`);
        if (sessionStr) {
            const session = JSON.parse(sessionStr);
            return session.user.id || session.user._id || null; 
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        return decoded.id || decoded.userId || null;
    } catch (error) {
        return null;
    }
};

const extractSafeId = (val) => {
    if (val === null || val === undefined) return '';
    if (typeof val === 'object') {
        if (val._id) return String(val._id).trim();
        if (val.id) return String(val.id).trim();
        return ''; 
    }
    return String(val).trim();
};

export function normalizeCartItem(raw) { 
    if (!raw || typeof raw !== 'object') return null;

    const productId = extractSafeId(raw.productId || raw.product);
    const variantId = extractSafeId(raw.variantId ?? raw.varient ?? raw.varientId); 
    
    const color = raw.color ? String(raw.color).trim() : '';
    const size = String(raw.size || '').slice(0, 20);
    const quantity = Math.min(99, Math.max(1, Number(raw.quantity) || 1));

    if (!productId) return null; 

    return { productId, variantId, color, size, quantity };
}

export function sanitizeThinCart(items) { 
    if (!Array.isArray(items)) return [];
    return items.slice(0, 50).map(normalizeCartItem).filter(Boolean);
}

// 🔥 CRITICAL FIXED MERGE LOGIC FOR NO DOUBLING 🔥
export function mergeThinCarts(primary = [], secondary = []) { 
    const merged = new Map();

    // 1. Pehle database (primary) cart ke items map me daalo
    for (const raw of primary) {
        const item = normalizeCartItem(raw);
        if (!item) continue;
        const key = `${item.productId}:${item.variantId || 'none'}:${item.size.toLowerCase()}`;
        merged.set(key, item);
    }

    // 2. Phir guest (secondary) cart ke items check karo
    for (const raw of secondary) {
        const item = normalizeCartItem(raw);
        if (!item) continue;
        const key = `${item.productId}:${item.variantId || 'none'}:${item.size.toLowerCase()}`;
        
        // Agar item already DB se aa chuka hai, toh usko double MAT karo. 
        // Guest cart wale item ki exact quantity ko final mano (bina purani quantity me plus kiye)
        merged.set(key, item);
    }

    return [...merged.values()];
}

export async function getUserCartItems(userId) {
    if (!userId) return [];

    const cached = await redisClient.get(`${CART_PREFIX_USER}${userId}`);
    if (cached) {
        const items = sanitizeThinCart(JSON.parse(cached));
        if (items.length) return items;
    }

    const isObjectId = mongoose.Types.ObjectId.isValid(userId);
    const query = isObjectId ? { _id: userId } : { id: userId };
    
    const user = await User.findOne(query).select('cart');
    if (!user?.cart?.length) return [];

    const dbItems = user.cart.map(normalizeCartItem).filter(Boolean);
    
    if (dbItems.length) {
        await redisClient.setEx(`${CART_PREFIX_USER}${userId}`, TTL_SECONDS, JSON.stringify(dbItems));
    }

    return dbItems;
}

export async function saveUserCart(userId, items) {
    if (!userId) return [];
    
    const finalItems = sanitizeThinCart(items).map(i => ({
        productId: i.productId,
        variantId: i.variantId,
        size: i.size,
        quantity: i.quantity
    }));
    
    await redisClient.setEx(`${CART_PREFIX_USER}${userId}`, TTL_SECONDS, JSON.stringify(finalItems));
    
    const isObjectId = mongoose.Types.ObjectId.isValid(userId);
    const query = isObjectId ? { _id: userId } : { id: userId };

    try {
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
    const finalItems = sanitizeThinCart(items).map(i => ({
        productId: i.productId, variantId: i.variantId, size: i.size, quantity: i.quantity
    }));
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
        const products = await Product.find({ 
            $or: [
                { id: { $in: productIds } }, 
                { _id: { $in: productIds.filter(id => mongoose.Types.ObjectId.isValid(id)) } }
            ] 
        });
        
        const fullItems = thinItems.map(cartItem => {
            const product = products.find(p => String(p.id || p._id) === String(cartItem.productId));
            if (!product) return null;
            
            const variant = product.variants?.find(v => String(v.id || v._id) === String(cartItem.variantId));
            if (product.variants?.length > 0 && !variant) return null; 
            
            const sizeInfo = variant ? variant.sizes?.find(s => String(s.size).trim().toLowerCase() === String(cartItem.size).trim().toLowerCase()) : null;
            const availableStock = sizeInfo ? sizeInfo.stock : 99; 
            
            return {
                productId: product.id || product._id,
                variantId: variant ? (variant.id || variant._id) : '',
                name: product.name,
                color: variant ? variant.color : null,
                size: cartItem.size,
                image: variant?.images?.[0] ? variant.images[0] : (product.images?.[0] || null),
                price: product.price,
                fit: product?.fit,
                salePrice: product.salePrice,
                discountDisplay: product.discountDisplay,
                quantity: Math.min(cartItem.quantity, availableStock, 99),
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
        
        const rawRequested = sanitizeThinCart(req.body?.items);
        const requestedItems = mergeThinCarts([], rawRequested); 
        
        const validatedItems = [];
        const productIds = [...new Set(requestedItems.map(i => i.productId))];
        
        if (productIds.length > 0) {
            const products = await Product.find({ 
                $or: [
                    { id: { $in: productIds } }, 
                    { _id: { $in: productIds.filter(id => mongoose.Types.ObjectId.isValid(id)) } }
                ] 
            }).lean();
            
            for (const item of requestedItems) {
                const product = products.find(p => String(p.id || p._id) === String(item.productId));
                if (!product) continue;
                
                const variant = product.variants?.find(v => String(v.id || v._id) === String(item.variantId));
                if (product.variants?.length > 0 && !variant) continue;
                
                const sizeInfo = variant ? variant.sizes?.find(s => String(s.size).trim().toLowerCase() === String(item.size).trim().toLowerCase()) : null;
                const availableStock = sizeInfo ? sizeInfo.stock : 99; 
                
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

// 🔥 PRESERVE ON LOGOUT LOGIC RESTORED 🔥
export const logoutAndPreserveCart = async (req, res) => {
    try {
        const userId = await getSessionUserId(req);
        const cartToken = String(req.headers['x-cart-token'] || '').trim().replace(/['"]/g, '');

        let preservedToken = cartToken && TOKEN_REGEX.test(cartToken) 
            ? cartToken 
            : crypto.randomBytes(16).toString('hex');

        let userItems = [];
        if (userId) {
            userItems = await getUserCartItems(userId);
        }

        // Isko wapas clone kar diya taaki logout hone par items screen se gayab na hon
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

export const clearCart = async (req, res) => {
    try {
        const userId = await getSessionUserId(req);
        const cartToken = String(req.headers['x-cart-token'] || '').trim();

        if (userId) {
            await redisClient.del(`${CART_PREFIX_USER}${userId}`).catch(() => {});
            
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