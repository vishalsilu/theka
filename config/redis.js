import { Redis } from '@upstash/redis';
import 'dotenv/config'; 

// Using a getter function ensures the env variable is read ONLY when called,
// completely avoiding the dotenv hoisting race condition.
const getRedisClient = () => {
    return new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL, // Note: Upstash uses REST url for this SDK
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
};

export const redisClient = getRedisClient();
// No .connect() method is needed! It works instantly over HTTP.