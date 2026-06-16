import crypto from 'crypto';
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
    }

    return tokenValues.length ? tokenValues[tokenValues.length - 1] : req.cookies?.token || null;
};

const getAuthToken = (req) => {
    const authHeader = req.get('Authorization') || req.headers.authorization;
    if (authHeader?.toLowerCase().startsWith('bearer ')) {
        return authHeader.split(' ')[1];
    }
    return extractTokenCookie(req) || null;
};

const computeSessionFingerprint = (req) => {
    // Only use the most stable headers. 
    // Avoid 'origin' or 'accept-language' which change frequently on mobile.
    const userAgent = String(req.headers['user-agent'] || '').trim().slice(0, 512);
    // Remove origin and acceptLanguage to prevent mobile disconnects
    return crypto.createHash('sha256').update(`${userAgent}`).digest('hex');
};

export const resolveUserFromToken = async (token, req) => {
    const key = `session:${token.trim()}`;
    const cachedSession = await redisClient.get(key);
    
    if (!cachedSession) {
        return null;
    }
    
    let sessionPayload;
    try {
        sessionPayload = JSON.parse(cachedSession);
    } catch (e) {
        return null;
    }

    const fingerprint = computeSessionFingerprint(req);
    if (!sessionPayload?.fingerprint || sessionPayload.fingerprint !== fingerprint) {
        return null;
    }

    return sessionPayload.user || null;
};

// Cleaned up middleware
export const protect = async (req, res, next) => {
    try {
        // 1. Unified Token Extraction
        const token = req.cookies?.token || 
                      req.headers.authorization?.split(' ')[1];

        if (!token) {
            return res.status(401).json({ error: 'Not authorized, no token provided' });
        }

        // 2. Resolve User using your Redis session logic
        const user = await resolveUserFromToken(token, req);
        
        if (!user) {
            // This is the line triggered when Redis session is missing/expired
            // or if the request fingerprint (browser/IP/OS) changed.
            return res.status(401).json({ error: 'Not authorized, session invalid or expired' });
        }

        // 3. Attach user to request
        req.user = user;
        next();
    } catch (error) {
        console.error('[Middleware Error]:', error);
        return res.status(500).json({ error: 'Internal server error during authentication' });
    }
};