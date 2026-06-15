import jwt from 'jsonwebtoken';
import User from '../models/Users.js';
import { redisClient } from '../config/redis.js';

const getAuthToken = (req) => {
    const authHeader = req.get('Authorization') || req.headers.authorization;
    console.log('Authorization header:', authHeader,req);
    if (authHeader?.toLowerCase().startsWith('bearer ')) {
        return authHeader.split(' ')[1];
    }
    return req.cookies?.token || null;
};

export const resolveUserFromToken = async (token) => {
    // No need to verify a JWT here because this is a session-based approach
    const key = `session:${token.trim()}`;
    console.log('Looking up session in Redis with key:', key);
    const cachedSession = await redisClient.get(key);
    
    return cachedSession ? JSON.parse(cachedSession) : null;
};

// Cleaned up middleware
export const protect = async (req, res, next) => {
    // 1. Log what cookies we actually see

    const token = req.cookies?.token;
console.log('Received cookies:',token , "Complete cookies", req.cookies);
    if (!token) {
        return res.status(401).json({ alert: 'Not authorized, no session cookie found' });
    }

    const user = await resolveUserFromToken(token);
console.log('Resolved user from token:', user);
    if (!user) {
        return res.status(401).json({ alert: 'Not authorized, session invalid or expired' });
    }

    req.user = user;
    next();
};