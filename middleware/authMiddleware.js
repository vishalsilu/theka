import jwt from 'jsonwebtoken';
import User from '../models/Users.js';
import { redisClient } from '../config/redis.js';

const extractTokenCookie = (req) => {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader || typeof cookieHeader !== 'string') {
        return req.cookies?.token || null;
    }

    const tokenValues = cookieHeader
        .split(';')
        .map((pair) => pair.trim())
        .filter((pair) => pair.startsWith('token='))
        .map((pair) => pair.slice('token='.length));

    if (tokenValues.length > 1) {
        console.log('[debug][auth] duplicate token cookies found:', tokenValues);
    }

    return tokenValues.length ? tokenValues[tokenValues.length - 1] : req.cookies?.token || null;
};

const getAuthToken = (req) => {
    const authHeader = req.get('Authorization') || req.headers.authorization;
    if (authHeader?.toLowerCase().startsWith('bearer ')) {
        return authHeader.split(' ')[1];
    }
    return extractTokenCookie(req);
};

export const resolveUserFromToken = async (token) => {
    if (!token) return null;
    const key = `session:${token.trim()}`;
    const cachedSession = await redisClient.get(key);
    
    if (!cachedSession) {
        console.error(`[debug][auth] Redis miss: Key ${key} not found.`);
        return null;
    }
    
    try {
        return JSON.parse(cachedSession);
    } catch (e) {
        console.error('[debug][auth] Failed to parse Redis session:', e);
        return null;
    }
};

// Cleaned up middleware
export const protect = async (req, res, next) => {
    const token = getAuthToken(req);
    const rawCookie = req.headers.cookie;
    const parsedToken = req.cookies?.token;

    console.log('[debug][auth] protect:', {
        url: req.originalUrl,
        method: req.method,
        protocol: req.protocol,
        secure: req.secure,
        forwardedProto: req.headers['x-forwarded-proto'],
        origin: req.get('origin'),
        rawCookie,
        parsedToken,
        selectedToken: token,
    });

    if (!token) {
        return res.status(401).json({ alert: 'Not authorized, no session cookie found' });
    }

    const user = await resolveUserFromToken(token);
    console.log('[debug][auth] Resolved user from token:', user ? { id: user.id, email: user.email } : null);   

    if (!user) {
        return res.status(401).json({ alert: 'Not authorized, session invalid or expired' });
    }

    req.user = user;
    next();
};