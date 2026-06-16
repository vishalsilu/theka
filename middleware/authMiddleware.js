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
    const userAgent = String(req.headers['user-agent'] || '').trim().slice(0, 512);
    const acceptLanguage = String(req.headers['accept-language'] || '').trim().slice(0, 128);
    const origin = String(req.headers.origin || '').trim().slice(0, 128);
    return crypto.createHash('sha256').update(`${userAgent}|${acceptLanguage}|${origin}`).digest('hex');
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
    const token = getAuthToken(req);
    const parsedToken = req.cookies?.token;

    if (!token) {
        return res.status(401).json({ alert: 'Not authorized, no session cookie found' });
    }

    const user = await resolveUserFromToken(token, req);
    if (!user) {
        return res.status(401).json({ alert: 'Not authorized, session invalid or expired' });
    }

    req.user = user;
    next();
};