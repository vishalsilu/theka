import 'dotenv/config';
import express from "express";
import cors from "cors";
import cookieParser from 'cookie-parser';
import connectDB from "./config/db.js";
import { connectRedis, redisClient } from "./config/redis.js";
import userRoutes from "./routes/userRoutes.js";
import cartRoutes from "./routes/cartRoutes.js"
import syncCart from "./tasks/syncCart.js"
import productRoutes from "./routes/productRoutes.js"
import categoryRoutes from "./routes/categoryRoutes.js"
import collectionRoutes from "./routes/collectionRoutes.js"
import orderRoutes from "./routes/orderRoutes.js"
import couponRoutes from "./routes/couponRoutes.js"
import searchRoutes from "./routes/searchRoutes.js"
import siteDataRoutes from "./routes/siteDataRoutes.js"
import invoiceRoutes from "./routes/invoiceRoutes.js"
import analyticsRoutes from './routes/analyticsRoutes.js'
import adminUserRoutes from './routes/adminUserRoutes.js'
import subscriberRoutes from './routes/subscriberRoutes.js';
import supportRoutes from './routes/supportRoutes.js';
import { startCartSyncCron } from "./utils/cartSync.js";
import startNamePropagation from "./tasks/namePropagation.js";
import attributeRoutes from './routes/attributeRoutes.js'
import { connectToWhatsApp } from './config/whatsapp.js';


const app = express();
app.use(cookieParser());
const port = process.env.PORT || 5000;
const otpCache = new Map();

// Middlewares
const defaultOrigins = [
  'http://localhost:5175', // Typically your Storefront
  'http://localhost:5174', // Typically your Storefront
  'http://localhost:3001',
  'http://172.20.10.13:5173',
  'http://172.28.56.116:5173',
  'http://172.20.10.13:5174',
  'http://172.28.56.116:5174',
  // Typically your Admin Dashboard
  'https://urbanroyalty.netlify.app',
  'https://adminurbanroyalty.netlify.app',
].filter(Boolean);

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
  : defaultOrigins;

if (process.env.FRONTEND_URL) {
  allowedOrigins.push(process.env.FRONTEND_URL.trim());
}

const allowedOriginPatterns = [
  /(^https:\/\/[^/]+\.netlify\.app$)/i,
  /(^https:\/\/[^/]+\.render\.com$)/i,
];

if (process.env.NODE_ENV !== 'production') {
  allowedOriginPatterns.push(
    /(^https?:\/\/(?:localhost|127\.0\.0\.1|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?$)/i
  );
}

console.log('[server] CORS allowed origins:', allowedOrigins);
console.log('[server] CORS allowed origin patterns:', allowedOriginPatterns);

// When deployed behind a proxy (Render), trust the proxy so HTTPS detection works correctly.
app.set('trust proxy', 1);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) {
      return callback(null, true);
    }

    const allowed = allowedOrigins.includes(origin)
      || allowedOriginPatterns.some((pattern) => pattern.test(origin));

    if (allowed) {
      return callback(null, true);
    }

    callback(new Error(`CORS Policy Blocked This Request: ${origin}`));
  },
  credentials: true, // REQUIRED for cookies
  // Ensure these headers match exactly what you are sending
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-id', 'x-cart-token'],
  exposedHeaders: ['Set-Cookie']
}));
app.use(express.json());
// Parse cookies for cookie-based auth

// Routes
app.use('/api/users', userRoutes);
app.use('/api/cart',cartRoutes)
app.use('/api/product',productRoutes)
app.use('/api/category',categoryRoutes)
app.use('/api/collections',collectionRoutes)
app.use('/api/orders', orderRoutes)
app.use('/api/coupons', couponRoutes)
app.use('/admin/api/coupons', couponRoutes)
app.use('/api/site', siteDataRoutes)
app.use('/admin/api/site', siteDataRoutes)
app.use('/api', searchRoutes)
app.use('/api/subscribers', subscriberRoutes);
app.use('/admin/api/subscribers', subscriberRoutes);

app.use('/api/invoices', invoiceRoutes)
app.use('/admin/api/invoices', invoiceRoutes)
app.use('/api/analytics', analyticsRoutes)
app.use('/admin/api/analytics', analyticsRoutes)
app.use('/api/support', supportRoutes)
app.use('/admin/api/support', supportRoutes)

//Admin Routes
app.use('/admin/api/orders', orderRoutes)
app.use('/admin/api/product',productRoutes)
app.use('/admin/api/collections',collectionRoutes)
app.use('/admin/api/category',categoryRoutes)
app.use('/admin/api/users', adminUserRoutes)
app.use('/api/attributes', attributeRoutes)
app.use('/admin/api/attributes', attributeRoutes)

// Root Route for testing
app.get('/', (req, res) => res.send('Urban API is running...'));

// Multer error handler for file upload failures
app.use((err, req, res, next) => {
    if (err && err.name === 'MulterError') {
        return res.status(400).json({ error: err.message });
    }
    if (err) {
        return res.status(500).json({ error: err.message || 'Unexpected server error' });
    }
    next();
});

// Unified Startup Function
const startServer = async () => {
    try {
        // 1. Connect to MongoDB
        await connectDB();
        
await connectRedis();
        // 3. Start background tasks
        startCartSyncCron();
        startNamePropagation();

        // 4. Start Listening
        app.listen(port, '0.0.0.0', () => {
            // connectToWhatsApp();
            console.log(`🚀 Server spinning on http://localhost:${port}`);
        });
    } catch (error) {
        console.error("Critical System Failure:", error);
        process.exit(1);
    }
};




const shutdown = async (signal) => {
    try {
        console.log(`\nReceived ${signal}, stopping server...`);
        if (redisClient?.isOpen) {
            await redisClient.quit();
            console.log('✅ Redis connection closed');
        }
    } catch (error) {
        console.error('⚠️ Error during shutdown:', error);
    } finally {
        process.exit(0);
    }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startServer();