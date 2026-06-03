import 'dotenv/config'; // 1. Load environment variables first
import { createClient } from 'redis';

const redisUrl = (process.env.UPSTASH_REDIS_URL || '').trim();

if (!redisUrl) {
    throw new Error('❌ Environment variable UPSTASH_REDIS_URL is missing!');
}

const isUpstash = redisUrl.includes('.upstash.io') || redisUrl.startsWith('rediss://');

const redisClient = createClient({
    url: redisUrl,
    socket: {
        tls: isUpstash,
        keepAlive: 5000,
        noDelay: true,
        reconnectStrategy: (retries) => {
            return Math.min(retries * 100, 3000);
        }
    },
    maxRetriesPerRequest: 5,
    disableOfflineQueue: true
});

redisClient.on('error', (err) => console.error('❌ Redis Client Error:', err));
redisClient.on('connect', () => console.log(`🔄 Redis connecting (${isUpstash ? 'Upstash Cloud' : 'Local Redis'})...`));
redisClient.on('ready', () => console.log(`✅ Redis Client Ready (${isUpstash ? 'Upstash Cloud' : 'Local Redis'})`));
redisClient.on('reconnecting', () => console.log('🔄 Redis reconnecting...'));
redisClient.on('end', () => console.log('⚠️ Redis connection closed'));

const connectRedis = async () => {
    try {
        if (!redisClient.isOpen) {
            await redisClient.connect();
        }
        await redisClient.ping();
        console.log('✅ Redis ping successful');
    } catch (error) {
        console.error('❌ Redis Initialization Failed:', error);
        throw error;
    }
};

export { redisClient, connectRedis };