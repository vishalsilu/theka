import cron from 'node-cron';
import { redisClient } from '../config/redis.js';
import User from '../models/Users.js';

const syncCartsToMongo = async () => {
    try {
        // 1. Get all user IDs that have modified their carts
        const dirtyUserIds = await redisClient.sMembers('dirty_carts');
        
        if (dirtyUserIds.length === 0) return;

        // console.log(`--- Starting Sync for ${dirtyUserIds.length} carts ---`);

        for (const userId of dirtyUserIds) {
            // 2. Fetch the "Thin" cart from Redis
            const cartData = await redisClient.get(`cart:user:${userId}`);
            
            // 3. Update the User's permanent record in MongoDB
            // Even if cartData is null (cart was cleared), we sync the empty array
            const itemsToSync = cartData ? JSON.parse(cartData) : [];
// Im getting varientId here but why not saving in db ???

            await User.findOneAndUpdate(
                { id: userId },
                { $set: { cart: itemsToSync } }
            );

            // 4. Remove from dirty set after successful DB write
            await redisClient.sRem('dirty_carts', userId);
        }

        // console.log(`--- Sync Complete ---`);
    } catch (error) {
        console.error("CRON Sync Error:", error);
    }
};

// Schedule to run every 10 minutes
// Pattern: minute, hour, day, month, day-of-week
export const startCartSyncCron = () => {
    cron.schedule('*/10 * * * *', () => {
        syncCartsToMongo();
    });
    // console.log("✅ Cart Sync Cron started - runs every 10 minutes");
};

