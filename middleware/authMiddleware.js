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
        console.log('[server][auth] duplicate token cookie values found:', tokenValues);
    }

    return tokenValues.length ? tokenValues[tokenValues.length - 1] : req.cookies?.token || null;
};

const getAuthToken = (req) => {
    const authHeader = req.get('Authorization') || req.headers.authorization;
    console.log('[server][auth] Authorization header:', authHeader);
    if (authHeader?.toLowerCase().startsWith('bearer ')) {
        return authHeader.split(' ')[1];
    }
    return extractTokenCookie(req);
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
    const token = getAuthToken(req);
    const parsedToken = req.cookies?.token;
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
        parsedToken,
        selectedToken: token,
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