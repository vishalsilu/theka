import 'dotenv/config';
import { createClient } from 'redis';

const redisUrl = (process.env.UPSTASH_REDIS_URL || '').trim();

if (!redisUrl) {
    throw new Error('❌ Environment variable UPSTASH_REDIS_URL is missing!');
}

// node-redis supports Upstash natively via the 'rediss://' protocol
const redisClient = createClient({
    url: redisUrl,
    socket: {
        tls: true, // Upstash requires TLS
        rejectUnauthorized: false // Often needed for some cloud providers
    }
});

redisClient.on('error', (err) => console.error('❌ Redis Client Error:', err));

const connectRedis = async () => {
    try {
        if (!redisClient.isOpen) {
            await redisClient.connect();
            console.log('✅ Redis Client Connected');
        }
    } catch (error) {
        console.error('❌ Redis Initialization Failed:', error);
        throw error;
    }
};

export { redisClient, connectRedis };