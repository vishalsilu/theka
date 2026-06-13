import jwt from 'jsonwebtoken';
import User from '../models/Users.js';
import { redisClient } from '../config/redis.js';

const getAuthToken = (req) => {
    const authHeader = req.get('Authorization') || req.headers.authorization;
    if (authHeader?.toLowerCase().startsWith('bearer ')) {
        return authHeader.split(' ')[1];
    }
    return req.cookies?.token || null;
};

const resolveUserFromToken = async (token) => {
    // Only accept opaque session tokens from Redis; no JWT fallback.
    // This ensures logout actually invalidates the session.
    const cachedSession = await redisClient.get(`session:${token}`);
    if (cachedSession) {
        return JSON.parse(cachedSession);
    }

    return null;
};

export const protect = async (req, res, next) => {
    const token = getAuthToken(req);

    if (!token) {
        return res.status(401).json({ alert: 'Not authorized, no token provided' });
    }

    const user = await resolveUserFromToken(token);
    if (!user) {
        return res.status(401).json({ alert: 'Not authorized, token invalid or expired' });
    }

    req.user = user;
    next();
};

export const optionalProtect = async (req, res, next) => {
    const token = getAuthToken(req);
    
    if (token) {
        req.user = await resolveUserFromToken(token);
    }
    
    next();
};