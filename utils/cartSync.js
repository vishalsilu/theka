import cron from 'node-cron';
import { redisClient } from '../config/redis.js';
import User from '../models/Users.js';

const syncCartsToMongo = async () => {
    try {
        const dirtyUserIds = await redisClient.sMembers('dirty_carts');
        
        if (dirtyUserIds.length === 0) return;

        for (const userId of dirtyUserIds) {
            const cartData = await redisClient.get(`cart:user:${userId}`);
            
            // 🔥 THE FIX: Auto-correct 'varientId' to 'variantId' so Mongoose doesn't delete it
            let itemsToSync = [];
            if (cartData) {
                const parsed = JSON.parse(cartData);
                itemsToSync = parsed.map(item => ({
                    productId: item.productId,
                    variantId: item.variantId || item.varientId || item.varient || '', 
                    size: item.size,
                    quantity: item.quantity
                }));
            }

            await User.findOneAndUpdate(
                { id: userId },
                { $set: { cart: itemsToSync } }
            );

            await redisClient.sRem('dirty_carts', userId);
        }
    } catch (error) {
        console.error("CRON Sync Error:", error);
    }
};

export const startCartSyncCron = () => {
    cron.schedule('*/10 * * * *', () => {
        syncCartsToMongo();
    });
};