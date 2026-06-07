// tasks/syncCart.js
import cron from 'node-cron';
import { redisClient } from "../config/redis.js";
import User from "../models/Users.js";

const startCartSync = () => {
    console.log("⏰ Cart Sync Scheduler Initialized...");
    
    cron.schedule('*/1 * * * *', async () => {
        try {
            // 1. Get all dirty user IDs
            const dirtyUsers = await redisClient.sMembers('dirty_carts');
            if (dirtyUsers.length === 0) return;

            console.log(`🔄 Syncing ${dirtyUsers.length} dirty carts...`);
            console.time('🎯 Sync Performance');

            // 2. Fetch all cart data from Redis concurrently
            const redisKeys = dirtyUsers.map(userId => `cart:user:${userId}`);
            const allCartsData = await redisClient.mGet(redisKeys); // Fetches all keys in ONE network trip

            const bulkOps = [];
            const syncedUserIds = [];

            // 3. Prepare the MongoDB bulk operations array
            dirtyUsers.forEach((userId, index) => {
                const cartData = allCartsData[index];
                if (cartData) {
                    bulkOps.push({
                        updateOne: {
                            filter: { id: userId }, // Your custom 'id' field
                            update: { $set: { cart: JSON.parse(cartData) } }
                        }
                    });
                    syncedUserIds.push(userId);
                }
            });

            // 4. Execute Bulk Write to MongoDB and cleanup Redis in pairs
            if (bulkOps.length > 0) {
                // Executes thousands of updates in a single database round-trip
                await User.bulkWrite(bulkOps, { ordered: false });
                
                // Remove processed users from the dirty set in one go
                await redisClient.sRem('dirty_carts', syncedUserIds);
            }

            console.timeEnd('🎯 Sync Performance');
            console.log(`✅ Successfully synced ${bulkOps.length} carts.`);

        } catch (err) {
            console.error("❌ Sync Error:", err);
        }
    });
};

export default startCartSync;