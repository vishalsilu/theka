import 'dotenv/config'; // 1. CRUCIAL: Must be the absolute first line to load variables
import { createClient } from 'redis';

const redisUrl = process.env.UPSTASH_REDIS_URL;

if (!redisUrl) {
    throw new Error("❌ Environment variable UPSTASH_REDIS_URL is missing!");
}

// Check if we are connecting to Upstash Cloud (uses secure 'rediss://') 
// versus local Docker/Dev Redis (uses unencrypted 'redis://')
const isUpstash = redisUrl.startsWith('rediss://');

// 2. Initialize the client configuration dynamically
const redisClient = createClient({
    url: redisUrl,
    socket: {
        // Enforce TLS/SSL ONLY for Upstash Cloud. Local Redis will crash if this is true.
        tls: isUpstash,         
        keepAlive: 5000,   // Keeps the TCP connection alive under serverless strain
        reconnectStrategy: (retries) => {
            // Smoothly back off connection retries so you don't flood the server
            const delay = Math.min(retries * 100, 3000);
            return delay;
        }
    }
});

// 3. Error monitoring (prevents uncaught exception crashes)
redisClient.on('error', (err) => console.error('❌ Redis Client Error:', err));
redisClient.on('connect', () => console.log(`🔄 Attempting to connect to Redis (${isUpstash ? 'Upstash Cloud' : 'Local Docker'})...`));
redisClient.on('ready', () => console.log(`✅ Redis Client Ready and Connected to ${isUpstash ? 'Upstash Cloud' : 'Local Redis'}!`));

// 4. Safe connection wrapper
const connectRedis = async () => {
    try {
        if (!redisClient.isOpen) {
            await redisClient.connect();
        }
    } catch (error) {
        console.error('❌ Redis Initialization Failed:', error);
        throw error; 
    }
};

export { redisClient, connectRedis };