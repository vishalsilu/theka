import { createClient } from 'redis';

const redisUrl = process.env.UPSTASH_REDIS_URL || 'redis://127.0.0.1:6379';

const redisClient = createClient({
    url: redisUrl,
});

redisClient.on('error', (err) => console.error('❌ Redis Client Error:', err));

const connectRedis = async () => {
    try {
        await redisClient.connect();
        console.log(`✅ Redis Connected (${redisUrl.startsWith('redis://127.0.0.1') ? 'local' : 'Upstash'})`);
    } catch (error) {
        console.error('❌ Redis Connection Failed:', error);
        throw error; // Let the main server handle the crash
    }
};

export { redisClient, connectRedis };