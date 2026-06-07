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
  'http://localhost:5173', // Typically your Storefront
  'http://localhost:5174', // Typically your Storefront
  'http://localhost:3001',
  'http://172.20.10.13:5173',
  'http://172.28.56.116:5173',
  'http://172.20.10.13:5174',
  'http://172.28.56.116:5174',
  // Typically your Admin Dashboard
  'https://urbanroyalty.netlify.app',
  'https://adminurbanroyalty.netlify.app'
];

 // Debugging line to confirm initialization

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
  : defaultOrigins;

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-id']
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