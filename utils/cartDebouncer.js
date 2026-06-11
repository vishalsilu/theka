// utils/cartDebouncer.js
import { redisClient } from "../config/redis.js";
import User from "../models/Users.js";

// Keep track of running timeouts per user in application memory
const activeTimers = new Map();

// Time to wait after the last user action before syncing (e.g., 5 seconds)
const DEBOUNCE_DELAY = 5000; 

export const debounceCartSync = (userId) => {
    // 1. If the user clicks again within 5 seconds, clear the previous timer
    if (activeTimers.has(userId)) {
        clearTimeout(activeTimers.get(userId));
    }

    // 2. Start a fresh 5-second countdown
    const timer = setTimeout(async () => {
        try {
            // console.log(`⚡ User ${userId} stopped changing items. Syncing immediately to MongoDB...`);
            
            // Fetch the absolute latest state from Redis to save to MongoDB
            const cartData = await redisClient.get(`cart:user:${userId}`);
            
            if (cartData) {
                // Save directly to your MongoDB User schema
                await User.updateOne(
                    { id: userId }, 
                    { $set: { cart: JSON.parse(cartData) } }
                );
                
                // Clean up the Redis dirty tracking flag
                await redisClient.sRem('dirty_carts', userId);
                // console.log(`✅ MongoDB sync complete for user: ${userId}`);
            }
        } catch (err) {
            console.error(`❌ Real-time Sync Error for user ${userId}:`, err);
        } finally {
            // Drop the completed timer reference out of memory
            activeTimers.delete(userId);
        }
    }, DEBOUNCE_DELAY);

    // Save this timer instance so it can be overwritten if they keep clicking
    activeTimers.set(userId, timer);
};