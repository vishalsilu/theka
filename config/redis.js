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
        keepAlive: isUpstash ? 10000 : 5000,  // Longer keep-alive for Upstash
        noDelay: true,
        reconnectStrategy: (retries) => {
            if (isUpstash) {
                // More aggressive retry for Upstash intermittent failures
                return Math.min(retries * 50, 1000);
            }
            return Math.min(retries * 100, 3000);
        },
        // Upstash-specific: increase socket timeout
        ...(isUpstash && { timeout: 30000 })
    },
    maxRetriesPerRequest: isUpstash ? 3 : 5,
    disableOfflineQueue: false,  // Allow queue for transient failures
    // Add connection timeout
    commandTimeout: isUpstash ? 15000 : 10000
});

redisClient.on('error', (err) => {
    if (isUpstash) {
        console.error('⚠️ Upstash Redis Error:', err.message);
        // Upstash timeouts are expected occasionally - log but don't crash
        if (err.message?.includes('timeout') || err.message?.includes('ECONNREFUSED')) {
            console.log('🔄 Upstash connection issue - will retry on next request');
        }
    } else {
        console.error('❌ Local Redis Client Error:', err);
    }
});
redisClient.on('connect', () => console.log(`🔄 Redis connecting (${isUpstash ? 'Upstash Cloud' : 'Local Redis'})...`));
redisClient.on('ready', () => console.log(`✅ Redis Client Ready (${isUpstash ? 'Upstash Cloud' : 'Local Redis'})`));
redisClient.on('reconnecting', () => console.log(`🔄 Redis reconnecting (${isUpstash ? 'Upstash' : 'Local'})...`));
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