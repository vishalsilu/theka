// tasks/syncCart.js
import cron from 'node-cron';
import { redisClient } from "../config/redis.js";
import User from "../models/Users.js";

const startCartSync = () => {
    console.log("⏰ Cart Sync Scheduler Initialized...");
    
    // Changed to every 1 minute for easier testing ('*/1 * * * *')
    cron.schedule('*/1 * * * *', async () => {
        try {
            const dirtyUsers = await redisClient.sMembers('dirty_carts');
            if (dirtyUsers.length === 0) return;

            console.log(`🔄 Syncing ${dirtyUsers.length} dirty carts...`);

            for (const userId of dirtyUsers) {
                const cartData = await redisClient.get(`cart:user:${userId}`);
                if (cartData) {
                    
                    // CRITICAL: Ensure 'id' matches your Schema field (not _id)
                    await User.updateOne({ id: userId }, { $set: { cart: JSON.parse(cartData) } });
                    await redisClient.sRem('dirty_carts', userId);
                }
            }
        } catch (err) {
            console.error("❌ Sync Error:", err);
        }
    });
};

export default startCartSync;