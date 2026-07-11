import crypto from 'crypto';
import User from '../models/Users.js'; // Adjust path if needed
import { redisClient } from '../config/redis.js'; // Adjust path if needed

const extractTokenCookie = (req) => {

    const isAdminRequest = Boolean(req.headers['x-admin-id']);
    const targetCookieName = isAdminRequest ? 'admin_token' : 'token';

    if (req.cookies && req.cookies[targetCookieName]) {
        return req.cookies[targetCookieName];
    }

    const cookieHeader = req.headers.cookie;
    if (!cookieHeader || typeof cookieHeader !== 'string') {
        return null;
    }

    const targetPrefix = `${targetCookieName}=`;
    const tokenValues = cookieHeader
        .split(';')
        .map((pair) => pair.trim())
        .filter((pair) => pair.startsWith(targetPrefix))
        .map((pair) => pair.slice(targetPrefix.length));

    if (tokenValues.length > 1) {
        console.log(`[server][auth] duplicate ${targetCookieName} cookie values found:`, tokenValues);
    }

    return tokenValues.length ? tokenValues[tokenValues.length - 1] : null;
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
        console.error("Failed to parse Redis session:", e);
        return null;
    }

    const fingerprint = computeSessionFingerprint(req);
    if (!sessionPayload?.fingerprint || sessionPayload.fingerprint !== fingerprint) {
        console.warn('[server][auth] session fingerprint mismatch. Potential session hijacking attempt.', {
            expected: sessionPayload?.fingerprint,
            actual: fingerprint,
            token: token.substring(0, 10) + '...' 
        });
        return null;
    }

    return sessionPayload.user || null;
};


export const protect = async (req, res, next) => {
    const token = getAuthToken(req);

    if (!token) {
        return res.status(200).json({ success: false, user: null, error: "Not authorized: No token provided" });
    }

    const user = await resolveUserFromToken(token, req);
    
    if (!user) {
        return res.status(200).json({ success: false, user: null, error: "Not authorized: Invalid or expired session" });
    }

    req.user = user;
    next();
};

export const adminOnly = (req, res, next) => {
  if (!req.user) {
    return res.status(200).json({ success: false, error: "Not authorized: No user found" });
  }

  const userRole = String(req.user.role || '').toLowerCase();
  
  if (userRole !== "admin") {
    return res.status(403).json({ success: false, error: "Forbidden: Admin access required" });
  }

  next();
};

export const optionalProtect = async (req, res, next) => {
    const token = getAuthToken(req);

    // If no token is provided, just move along as a guest
    if (!token) {
        return next();
    }

    try {
        const user = await resolveUserFromToken(token, req);
        
        if (user) {
            req.user = user; // Populate req.user just like strict protect does
        } else {
            console.warn('[server][auth] Optional token provided but invalid, expired, or fingerprint mismatched. Treating as guest.');
        }
    } catch (error) {
        // Catch any unexpected errors (like Redis connection drops) so the user can still browse as a guest
        console.error('[server][auth] Unexpected error during optional auth validation:', error);
    }

    next();
};