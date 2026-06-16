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
    const key = `session:${token.trim()}`;
    const cachedSession = await redisClient.get(key);
    
    if (!cachedSession) {
        console.error(`Redis miss: Key ${key} not found.`);
        return null;
    }
    
    try {
        return JSON.parse(cachedSession);
    } catch (e) {
        console.error("Failed to parse Redis session:", e);
        return null;
    }
};

// Cleaned up middleware
export const protect = async (req, res, next) => {
    const token = req.cookies?.token;
    console.log('[server][auth] protect request:', {
        originalUrl: req.originalUrl,
        method: req.method,
        hostname: req.hostname,
        protocol: req.protocol,
        secure: req.secure,
        forwardedProto: req.headers['x-forwarded-proto'],
        origin: req.get('origin'),
        cookieHeader: req.headers.cookie,
        parsedCookies: req.cookies,
        tokenValue: token,
    });

    if (!token) {
        return res.status(401).json({ alert: 'Not authorized, no session cookie found' });
    }

    const user = await resolveUserFromToken(token);
    console.log('[server][auth] token lookup:', {
        token,
        userFound: Boolean(user),
    });

    if (!user) {
        return res.status(401).json({ alert: 'Not authorized, session invalid or expired' });
    }

    req.user = user;
    next();
};