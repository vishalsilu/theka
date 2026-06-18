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

const defaultOrigins = [
  'http://localhost:5175', 
  'http://localhost:5174', 
  'http://localhost:3001',
  'http://172.20.10.13:5173',
  'http://172.28.56.116:5173',
  'http://172.20.10.13:5174',
  'http://172.28.56.116:5174',
  
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


app.set('trust proxy', 1);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    
    
    const allowed = allowedOrigins.includes(origin) || 
                    allowedOriginPatterns.some((pattern) => pattern.test(origin));

    if (allowed) {
      callback(null, true);
    } else {
      callback(new Error(`CORS Policy Blocked This Request: ${origin}`));
    }
  },
  credentials: true,
  
  
  allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-id', 'x-cart-token', 'Cookie'], 
  exposedHeaders: ['Set-Cookie']
}));






















app.use(express.json());



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


app.get('/', (req, res) => res.send('Urban API is running...'));


app.use((err, req, res, next) => {
    if (err && err.name === 'MulterError') {
        return res.status(400).json({ error: err.message });
    }
    if (err) {
        return res.status(500).json({ error: err.message || 'Unexpected server error' });
    }
    next();
});


const startServer = async () => {
    try {
        await connectDB();
        
await connectRedis();
        startCartSyncCron();
        startNamePropagation();

        app.listen(port, '0.0.0.0', () => {
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