import jwt from 'jsonwebtoken';
import User from '../models/Users.js';
import { redisClient } from '../config/redis.js'; // Ensure this is imported

export const protect = async (req, res, next) => {
    let token;
    // #region agent log
    fetch('http://127.0.0.1:7755/ingest/6ac935e2-f8c4-4581-8a21-d5980fc75e55',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'bbe97d'},body:JSON.stringify({sessionId:'bbe97d',runId:'checkout-debug-1',hypothesisId:'H3',location:'authMiddleware.js:protect:entry',message:'Auth middleware entry',data:{hasAuthHeader:Boolean(req.headers.authorization),path:req.originalUrl,method:req.method},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    const authHeader = req.get('Authorization') || req.get('authorization') || req.headers.authorization;
 

    if (authHeader && typeof authHeader === 'string' && authHeader.trim().toLowerCase().startsWith('bearer ')) {
        try {
            token = authHeader.trim().split(' ')[1];
            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            // 1. Try to get user from Redis first
            const cachedUser = await redisClient.get(`user:id:${decoded.id}`);
            if (cachedUser) {
                req.user = JSON.parse(cachedUser);
                return next(); // Exit early, no DB call needed!
            }


            // 2. Redis Miss - Get from MongoDB
            const user = await User.findOne({ id: decoded.id }).select('-password');

            if (!user) {
                return res.status(401).json({ alert: "User no longer exists" });
            }

            // 3. Update Redis so next time is a "Hit"
            await redisClient.setEx(
                `user:id:${user.id}`,
                3600, // Cache for 1 hour
                JSON.stringify(user)
            );

            req.user = user;
            next();

        } catch (error) {
            console.error("Token Verification Error:", error);
            return res.status(401).json({ alert: "Not authorized, token failed" });
        }
    } else if (req.cookies && req.cookies.token) {
        // Support cookie-based JWT (httpOnly cookie)
        try {
            token = req.cookies.token;
            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            const cachedUser = await redisClient.get(`user:id:${decoded.id}`);
            if (cachedUser) {
                req.user = JSON.parse(cachedUser);
                return next();
            }

            const user = await User.findOne({ id: decoded.id }).select('-password');
            if (!user) return res.status(401).json({ alert: "User no longer exists" });

            await redisClient.setEx(`user:id:${user.id}`, 3600, JSON.stringify(user));
            req.user = user;
            return next();
        } catch (error) {
            console.error('Cookie token verification failed:', error?.message || error);
            return res.status(401).json({ alert: 'Not authorized, token failed' });
        }
    } else {
        return res.status(401).json({ alert: "Not authorized, no token" });
    }
};

export const optionalProtect = async (req, res, next) => {
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            const token = req.headers.authorization.split(' ')[1];
            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            const cachedUser = await redisClient.get(`user:id:${decoded.id}`);
            if (cachedUser) {
                req.user = JSON.parse(cachedUser);
                return next();
            }

            const user = await User.findOne({ id: decoded.id }).select('-password');
            if (!user) return next();

            await redisClient.setEx(
                `user:id:${user.id}`,
                3600,
                JSON.stringify(user)
            );

            req.user = user;
            return next();
        } catch (error) {
            console.error('Optional auth failed:', error.message);
            return next();
        }
    }

    next();
};