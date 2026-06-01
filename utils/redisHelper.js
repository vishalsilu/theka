import { redisClient } from '../config/redis.js';

/**
 * Safe Redis operation wrapper for Upstash reliability
 * Falls back to no-cache on timeout instead of failing request
 */

export const safeRedisGet = async (key, onCacheMiss) => {
    try {
        // Try to get from cache with timeout
        const cached = await Promise.race([
            redisClient.get(key),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Redis timeout')), 5000)
            )
        ]);
        
        if (cached) {
            return { source: 'cache', data: JSON.parse(cached) };
        }
    } catch (err) {
        // Log but don't crash - Upstash can be flaky
        console.warn(`[redisHelper] Cache read failed for ${key}:`, err.message);
    }
    
    // Cache miss or error - fetch fresh data
    const data = await onCacheMiss();
    return { source: 'database', data };
};

export const safeRedisSet = async (key, data, ttl = 3600) => {
    try {
        // Don't cache empty arrays
        if (Array.isArray(data) && data.length === 0) {
            return false;
        }
        
        // Try to set with timeout
        await Promise.race([
            redisClient.setEx(key, ttl, JSON.stringify(data)),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Redis timeout')), 5000)
            )
        ]);
        return true;
    } catch (err) {
        // Log but don't crash - cache write failure shouldn't break the response
        console.warn(`[redisHelper] Cache write failed for ${key}:`, err.message);
        return false;
    }
};

export const safeRedisDelete = async (pattern) => {
    try {
        await Promise.race([
            redisClient.del(pattern),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Redis timeout')), 5000)
            )
        ]);
        return true;
    } catch (err) {
        console.warn(`[redisHelper] Cache delete failed for ${pattern}:`, err.message);
        return false;
    }
};

export const safeRedisScan = async (pattern) => {
    try {
        const keys = [];
        let cursor = 0;
        
        do {
            const { cursor: nextCursor, keys: batchKeys } = await Promise.race([
                redisClient.scan(cursor, { MATCH: pattern, COUNT: 100 }),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Redis timeout')), 5000)
                )
            ]);
            
            keys.push(...batchKeys);
            cursor = nextCursor;
        } while (cursor !== 0);
        
        return keys;
    } catch (err) {
        console.warn(`[redisHelper] Cache scan failed for ${pattern}:`, err.message);
        return [];
    }
};
