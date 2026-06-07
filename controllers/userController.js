import mongoose from "mongoose";
import User from "../models/Users.js";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import { v4 as uuidv4 } from 'uuid';
import { redisClient } from '../config/redis.js';
import jwt from "jsonwebtoken";
import axios from "axios";
import { sendEmail } from '../config/email.js';
import { validateRecaptchaToken } from "../middleware/verifyReCaptcha.js";
import SiteData from '../models/SiteData.js'; // Ensure the path points to your actual Mongoose model file

const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: '30d',
    });
};

const CART_PREFIX_USER = 'cart:user:';
const CART_PREFIX_GUEST = 'cart:guest:';
const TTL_SECONDS = 60 * 60 * 24 * 30;
const TOKEN_REGEX = /^[a-f0-9]{32}$/i;
const OTP_TTL = 300; // 5 minutes in seconds

// --- Internal Helper Functions (Maintained) ---
function normalizeCartItem(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const productId = String(raw.productId || '').slice(0, 120);
    const variantId = Number(raw.variantId ?? raw.varient) || 0;
    const size = String(raw.size || '').slice(0, 20);
    const quantity = Math.min(10, Math.max(1, Number(raw.quantity) || 1));
    const varient = String((raw.varient ?? raw.variant ?? variantId) || '').slice(0, 120);
    if (!productId) return null;
    return { productId, variantId, size, quantity, varient };
}

function sanitizeThinCart(items) {
    if (!Array.isArray(items)) return [];
    return items.slice(0, 50).map(normalizeCartItem).filter(Boolean);
}

function mergeThinCarts(primary = [], secondary = []) {
    const merged = new Map();
    for (const raw of [...primary, ...secondary]) {
        const item = normalizeCartItem(raw);
        if (!item) continue;
        const key = `${item.productId}:${item.variantId}:${item.size}`;
        const existing = merged.get(key);
        if (existing) {
            existing.quantity = Math.min(99, existing.quantity + item.quantity);
        } else {
            merged.set(key, item);
        }
    }
    return [...merged.values()];
}

async function processUserSession(user, req, res, messageSuccess) {
    const userData = user.toObject();
    delete userData.password;

    const guestToken = String(req.headers['x-cart-token'] || '').trim();

    const rawUserCart = await redisClient.get(`${CART_PREFIX_USER}${user.id}`);
    let userCartItems = rawUserCart ? sanitizeThinCart(JSON.parse(rawUserCart)) : [];

    if (!userCartItems.length && Array.isArray(user.cart)) {
        userCartItems = user.cart.map(normalizeCartItem).filter(Boolean);
    }

    let guestItems = [];
    if (guestToken && TOKEN_REGEX.test(guestToken)) {
        const rawGuest = await redisClient.get(`${CART_PREFIX_GUEST}${guestToken}`);
        guestItems = rawGuest ? sanitizeThinCart(JSON.parse(rawGuest)) : [];
    }

    const mergedCart = mergeThinCarts(userCartItems, guestItems);
    await redisClient.setEx(`${CART_PREFIX_USER}${user.id}`, TTL_SECONDS, JSON.stringify(mergedCart));
    await redisClient.sAdd('dirty_carts', String(user.id)).catch(() => {});

    if (guestToken && TOKEN_REGEX.test(guestToken)) {
        await redisClient.del(`${CART_PREFIX_GUEST}${guestToken}`).catch(() => {});
    }

    const token = generateToken(user.id);
    const jsonUser = JSON.stringify(userData);

    const TTL = 3600;
    await Promise.all([
        redisClient.setEx(`user:id:${user.id}`, TTL, jsonUser),
        redisClient.setEx(`user:email:${user.email || ''}`, TTL, jsonUser),
        redisClient.setEx(`user:phone:${user.phone || ''}`, TTL, jsonUser)
    ].filter(p => p));

    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('token', token, {
        httpOnly: true,
        secure: isProd,
        sameSite: 'lax',
        path: '/',
        maxAge: 30 * 24 * 60 * 60 * 1000
    });

    return res.json({ success: messageSuccess, user: userData, token });
}

// ==========================================
// UNIFIED EMAIL OTP CONTROLLERS (SMOOTH FLOW)
// ==========================================

/**
 * @desc    Step 1: Check Email & Send/Resend Code (Handles both Login & Registration seamlessly)
 * @route   POST /api/auth/email/send-otp
 * @access  Public
 */

export const handleContactUsRequest = async (req, res) => {
    try {
        // =========================================================
        // 📥 STEP 1: EXTRACT AND NORMALIZE INPUTS
        // =========================================================
        const {userId, name, email, subject, message, recaptchaToken } = req.body;

        // Ensure all required fields are provided
        if (!name || !email || !subject || !message) {
            return res.status(400).json({ error: "All fields (name, email, subject, message) are required." });
        }

        const normalizedEmail = String(email).trim().toLowerCase();
        const cleanName = String(name).trim();
        const cleanSubject = String(subject).trim();
        const cleanMessage = String(message).trim();

        // =========================================================
        // 🤖 STEP 2: RECAPTCHA BOT PROTECTION
        // =========================================================
        try {
            await validateRecaptchaToken(recaptchaToken);
        } catch (recaptchaError) {
            return res.status(403).json({ error: recaptchaError.message });
        }

        // =========================================================
        // 📐 STEP 3: STRUCTURAL EMAIL VALIDATION
        // =========================================================
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(normalizedEmail)) {
            return res.status(400).json({ error: "Please provide a valid email address." });
        }

        // =========================================================
        // 🛡️ STEP 4: ANTI-SPAM COOLDOWN RATE LIMITING (Redis)
        // =========================================================
        const contactCooldownKey = `cooldown:contact:${normalizedEmail}`;
        const hasSubmittedRecently = await redisClient.get(contactCooldownKey);

        if (hasSubmittedRecently) {
            return res.status(429).json({ 
                error: "You have submitted a request recently. Please wait 2 minutes before trying again." 
            });
        }


        // =========================================================
        // 🎨 STEP 5: GENERATE CLEAN EMAIL HTML FOR YOUR TEAM
        // =========================================================
        const internalEmailHtml = `
        <div style="max-width: 600px; margin: 0 auto; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05); border: 1px solid #eaeaea;">
            <div style="padding: 30px; background-color: #1d3557; color: #ffffff; text-align: center;">
                <h1 style="font-size: 24px; margin: 0; font-weight: 700;">New Contact Form Submission</h1>
                <p style="font-size: 14px; margin: 5px 0 0 0; color: #f1faee;">Received via Urban Contact Us page</p>
            </div>
            <div style="padding: 30px;">
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                    <tr>
                        <td style="padding: 10px 0; border-bottom: 1px solid #eaeaea; font-weight: bold; color: #4a5568; width: 30%;">Sender ID:</td>
                        <td style="padding: 10px 0; border-bottom: 1px solid #eaeaea; color: #1d3557;">${userId || 'N/A'}</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px 0; border-bottom: 1px solid #eaeaea; font-weight: bold; color: #4a5568; width: 30%;">Sender Name:</td>
                        <td style="padding: 10px 0; border-bottom: 1px solid #eaeaea; color: #1d3557;">${cleanName}</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px 0; border-bottom: 1px solid #eaeaea; font-weight: bold; color: #4a5568;">Sender Email:</td>
                        <td style="padding: 10px 0; border-bottom: 1px solid #eaeaea; color: #1d3557;"><a href="mailto:${normalizedEmail}">${normalizedEmail}</a></td>
                    </tr>
                    <tr>
                        <td style="padding: 10px 0; border-bottom: 1px solid #eaeaea; font-weight: bold; color: #4a5568;">User Subject:</td>
                        <td style="padding: 10px 0; border-bottom: 1px solid #eaeaea; color: #1d3557;">${cleanSubject}</td>
                    </tr>
                </table>
                
                <div style="background-color: #f8f9fa; border-left: 4px solid #4361ee; border-radius: 4px; padding: 20px; margin-top: 20px;">
                    <span style="font-size: 12px; color: #64748b; display: block; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px;">Message Payload:</span>
                    <p style="font-size: 15px; color: #2d3748; line-height: 1.6; margin: 0; white-space: pre-wrap;">${cleanMessage}</p>
                </div>
            </div>
            <div style="background-color: #f8f9fa; padding: 15px; text-align: center; border-top: 1px solid #eaeaea;">
                <p style="font-size: 11px; color: #94a3b8; margin: 0;">This transmission was handled automatically by the backend notification dispatcher.</p>
            </div>
        </div>
        `;

        // =========================================================
        // 🚀 STEP 6: TRANSMIT NOTIFICATION VIA NODEMAILER
        // =========================================================
        const siteConfig = await SiteData.findOne({}); 
        
        // Fallback to an environment variable or hardcoded fallback if DB string is empty
        const targetSupportEmail = siteConfig?.contact?.email || "vishalsainig009@gmail.com";

        if (!siteConfig || !siteConfig.contact?.email) {
            return res.status(500).json({error: "Support contact email is not configured properly. Please try again later."});
            console.warn("⚠️ Warning: contact email not found in SiteData collection. Using fallback mapping.");
        }

        const mailResult = await sendEmail({
            to: targetSupportEmail, 
            replyTo: normalizedEmail, 
            subject: `[Contact Us] - ${cleanName} ${userId ? `(ID: ${userId})` : ''} - ${cleanSubject}`, 
            html: internalEmailHtml
        });

        if (!mailResult || mailResult.success === false) {
            return res.status(500).json({ 
                error: "Failed to process your request at this time.",
                details: mailResult?.error || "Mail transmission handshake failure"
            });
        }

        // =========================================================
        // 🔒 STEP 7: ACTIVATE 2-MINUTE COOLDOWN ANTI-SPAM LOCK
        // =========================================================
        await redisClient.setEx(contactCooldownKey, 120, "locked");

        return res.status(200).json({ 
            success: true, 
            message: "Your message has been received! Our support team will get back to you shortly." 
        });

    } catch (error) {
        // This will now print the actual underlying error to your server terminal logs for debugging
        console.error("Contact Form Pipeline Error Details:", error);
        return res.status(500).json({ error: "Internal server error occurred processing the ticket." });
    }
};

export const requestEmailOTP = async (req, res) => {
    try {
        
        // =========================================================
        // 📥 STEP 1: EXTRACT INPUTS FROM THE REQUEST BODY
        // =========================================================
        const { email, adminLogin, recaptchaToken } = req.body;

        // Ensure critical email field is present
        if (!email) {
            return res.status(400).json({ error: "Email address is required" });
        }

        const normalizedEmail = String(email).trim().toLowerCase();

        if (!adminLogin) {
            try {
                await validateRecaptchaToken(recaptchaToken);
            } catch (recaptchaError) {
                return res.status(403).json({ error: recaptchaError.message });
            }
        }

        // If this request is specifically for admin login, verify the account is an Admin
        if (adminLogin) {
            const adminCheck = await User.findOne({ email: normalizedEmail });
            if (!adminCheck || adminCheck.role !== 'Admin') {
                return res.status(403).json({ error: 'Invalid admin user' });
            }
        }


        // =========================================================
        // STEP 2: STANDARD STRUCTURAL DATA VALIDATION
        // =========================================================
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: "Please enter a valid email address structure" });
        }
        
        // =========================================================
        // 🛡️ STEP 3: ANTI-SPAM REDIS COOLDOWN SECURITY CHECK
        // =========================================================
        const cooldownKey = `cooldown:email:${normalizedEmail}`;
        const hasRequestedRecently = await redisClient.get(cooldownKey);

        if (hasRequestedRecently) {
            return res.status(429).json({ 
                error: "Please wait 60 seconds before requesting another verification code." 
            });
        }

        // =========================================================
        // STEP 4: OTP GENERATION & REDIS STORAGE
        // =========================================================
        const cacheKey = `otp:email:${normalizedEmail}`;

        // Generate clean 6-digit OTP string
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        // Atomically set/overwrite value and lock a 5-minute TTL duration
        await redisClient.setEx(cacheKey, OTP_TTL, otp);

        const emailHtml = `
   <div style="max-width: 600px; margin: 0 auto; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05); border: 1px solid #eaeaea;">
  <div style="padding: 40px 30px; text-align: center;">
    <div style="font-size: 14px; font-weight: bold; color: #4361ee; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 10px;">Security Verification</div>
    <h1 style="font-size: 28px; color: #1d3557; margin: 0 0 15px 0; font-weight: 700;">Verify Your Identity</h1>
    <p style="font-size: 16px; color: #4a5568; line-height: 1.6; margin: 0 0 30px 0;">You are receiving this notification because an access verification request was initialized for your account. Use the secure single-use authentication token code below to complete your sign-in process.</p>
    <div style="background-color: #f8f9fa; border: 2px dashed #cbd5e1; border-radius: 8px; padding: 20px; margin-bottom: 30px; display: inline-block; min-width: 250px;">
      <span style="font-size: 12px; color: #64748b; display: block; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 5px;">Your One-Time Password</span>
      <strong style="font-size: 32px; color: #4361ee; font-family: monospace; letter-spacing: 6px;">${otp}</strong>
      <span style="font-size: 14px; color: #e63946; display: block; margin-top: 8px; font-weight: bold;">⏰ This temporary code expires strictly in 5 minutes.</span>
    </div>
    <div>
      
    </div>
  </div>
  <div style="background-color: #f8f9fa; padding: 20px; text-align: center; border-top: 1px solid #eaeaea;">
    <p style="font-size: 12px; color: #94a3b8; margin: 0;">If you did not initiate this authentication request, please ignore this communication or reset your credentials immediately to protect your account security.</p>
  </div>
</div>
`;

        // =========================================================
        // STEP 5: TRANSMIT EMAIL NODEMAILER SYSTEM
        // =========================================================
        const mailResult = await sendEmail({
            to: normalizedEmail,
            subject: `Urban Account Verification Code: ${otp}`,
            html: emailHtml
        });

        if (!mailResult || mailResult.success === false) {
            return res.status(500).json({ 
                error: "Failed to dispatch email verification code",
                details: mailResult?.error || "SMTP configuration handshake failed"
            });
        }

        // =========================================================
        // 🔒 STEP 6: ACTIVATE COOLDOWN LOCK ONCE SUCCESSFUL
        // =========================================================
        await redisClient.setEx(cooldownKey, 60, "locked");

        return res.status(200).json({ 
            success: true, 
            message: "Verification OTP dispatched successfully!" 
        });

    } catch (error) {
        console.error("Email OTP Distribution Error:", error);
        return res.status(500).json({ error: "Internal server error during authentication routing" });
    }
};

/**
 * @desc    Step 2: Validate OTP and dynamically log in or create user profile
 * @route   POST /api/auth/email/verify-otp
 * @access  Public
 */
export const verifyEmailOTP = async (req, res) => {
    try {
        const { email, otp, adminLogin } = req.body;

        if (!email || !otp) {
            return res.status(400).json({ error: "Email and verification OTP parameters are required" });
        }

        const normalizedEmail = String(email).trim().toLowerCase();
        const cacheKey = `otp:email:${normalizedEmail}`;

        // 1. Fetch code from Redis cache memory cell
        const cachedOtp = await redisClient.get(cacheKey);

        if (!cachedOtp) {
            return res.status(400).json({ error: "Your verification code has expired or was never requested. Click resend." });
        }

        // 2. Validate user entry against stored token string explicitly
        if (cachedOtp !== String(otp).trim()) {
            return res.status(400).json({ error: "Incorrect OTP entered. Please check your inbox and try again." });
        }

        // 3. Clean up the cache key immediately to prevent reuse injection vectors
        await redisClient.del(cacheKey);

        // 4. Look up existing profile index paths
        let user = await User.findOne({ email: normalizedEmail });

        if (!user) {
            if (adminLogin) {
                return res.status(403).json({ error: 'Invalid admin user' });
            }

            // 🌟 Flow B: First-time Registration Path -> Tell Frontend to Ask for Details
            // Generate a short-lived token (valid for 15 mins) containing the verified email
            // This prevents users from fabricating or modifying emails during step 2
            const registrationToken = jwt.sign(
                { email: normalizedEmail }, 
                process.env.JWT_SECRET, 
                { expiresIn: '15m' }
            );

            return res.status(200).json({
                success: true,
                registrationRequired: true,
                message: "Email verified successfully! Please complete your registration profile details.",
                registrationToken // Send this back so frontend can pass it back in the next step
            });
        }

        if (adminLogin && user.role !== 'Admin') {
            return res.status(403).json({ error: 'Invalid admin user' });
        }

        // 🌟 Flow A: Returning User -> Login instantly
        return await processUserSession(user, req, res, "Welcome back! Login successful.");

    } catch (error) {
        console.error("Email Verification Endpoint Error:", error);
        return res.status(500).json({ error: error.message || "Internal profile session integration crash" });
    }
};

export const completeRegistration = async (req, res) => {
    try {
        const { firstName, lastName, phone, registrationToken } = req.body;

        if (!firstName || !lastName || !phone || !registrationToken) {
            return res.status(400).json({ error: "All profile fields and verification signatures are required." });
        }

        // 1. Decode and verify the short-lived registration token to get the email address
        let decoded;
        try {
            decoded = jwt.verify(registrationToken, process.env.JWT_SECRET);
        } catch (err) {
            return res.status(400).json({ error: "Registration session expired. Please verify your email again." });
        }

        const verifiedEmail = decoded.email;

        // 2. Double-check if a race condition happened and the user was created in the meantime
        let existingUser = await User.findOne({ email: verifiedEmail });
        if (existingUser) {
            return res.status(400).json({ error: "An account with this email address already exists." });
        }

        // 3. Construct and save the clean profile configuration to the Database
        const generatedId = `USR-${Date.now().toString().slice(-4)}${Math.floor(1000 + Math.random() * 9000)}`;
        const secureFallbackPassword = uuidv4(); 

        const newUser = new User({
            id: generatedId,
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            email: verifiedEmail,
            phone: phone.trim(),
            password: secureFallbackPassword
        });

        await newUser.save();

        // 4. Provision their login token and establish their active Redux state session
        return await processUserSession(newUser, req, res, "Account successfully provisioned! Welcome to Urban.");

    } catch (error) {
        console.error("Complete Registration Error:", error);
        return res.status(500).json({ error: "Internal profile configuration creation failure." });
    }
};

// ==========================================
// REMAINDER SERVICE ENDPOINTS (MAINTAINED)
// ==========================================
export const updateUser = async (req, res) => {
    try {
        const { id } = req.user;
        const { firstName, lastName } = req.body; 
        
        const user = await User.findOne({ id });
        if (!user) return res.status(404).json({ error: "User not found" });    

        if (firstName !== undefined) user.firstName = firstName;
        if (lastName !== undefined) user.lastName = lastName;

        await user.save();
        const userData = user.toObject();
        const jsonUser = JSON.stringify(userData);

        await Promise.all([
            redisClient.setEx(`user:id:${user.id}`, 3600, jsonUser),
            redisClient.setEx(`user:email:${user.email || ''}`, 3600, jsonUser),
            redisClient.setEx(`user:phone:${user.phone || ''}`, 3600, jsonUser)
        ]);

        return res.status(200).json({ success: "User profile updated successfully", user: userData });
    } catch (error) {
        return res.status(500).json({ error: error.message || "Internal Server Error" });
    }
};

export const getAllUsersAdmin = async (req, res) => {
    try {
        const { q, role, sortBy, sortOrder } = req.query;
        const query = {};
        if (role && role !== "All") query.role = String(role).trim();
        if (q) {
            const search = new RegExp(String(q).trim(), "i");
            query.$or = [
                { id: search }, { firstName: search }, { lastName: search },
                { email: search }, { phone: search }, { role: search }
            ];
        }
        const field = sortBy === "email" ? "email" : "createdAt";
        const direction = sortOrder === "asc" ? 1 : -1;
        const users = await User.find(query).select("-password -__v").sort({ [field]: direction }).lean();
        return res.status(200).json({ success: true, users });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

export const getUserAdmin = async (req, res) => {
    try {
        const { id } = req.params;
        const user = await User.findOne({ id: id }).select("-password -__v").lean();
        if (!user) return res.status(404).json({ error: "User not found" });

        const orders = await Order.find({ id }).sort({ createdAt: -1 }).lean();
        const cartItems = Array.isArray(user.cart) ? user.cart : [];
        const cart = await Promise.all(cartItems.map(async (item) => {
            const product = await Product.findOne({ id: item.productId }).lean();
            return {
                ...item,
                name: product?.name || item.productId,
                price: Number(product?.price || 0)
            };
        }));
        return res.status(200).json({ success: true, user, orders, cart });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

export const updateUserAdmin = async (req, res) => {
    try {
        const { userId } = req.params;
        const { firstName, lastName, phone, role,email } = req.body;
        const patch = {};
        if (firstName !== undefined) patch.firstName = String(firstName).trim();
        if (lastName !== undefined) patch.lastName = String(lastName).trim();
        if(email !== undefined) patch.email = String(email).trim().toLowerCase();
        if (phone !== undefined) patch.phone = String(phone).trim();
        if (role !== undefined) patch.role = String(role).trim();

        const user = await User.findOneAndUpdate({ id: userId }, patch, { new: true }).select("-password -__v").lean();
        if (!user) return res.status(404).json({ error: "User not found" });
        return res.status(200).json({ success: true, user });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

export const deleteUserAdmin = async (req, res) => {
    try {
        const { userId } = req.params;
        const deletedUser = await User.findOneAndDelete({ id: userId });
        if (!deletedUser) return res.status(404).json({ error: "User not found" });
        return res.status(200).json({ success: true, message: "User deleted successfully" });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

export const addAddress = async (req, res) => {
    try {
        const { userId, ...addressData } = req.body;
        if (!userId) return res.status(401).json({ error: "Please login again to continue" });

        const user = await User.findOne({ id: userId });
        if (!user) return res.status(404).json({ error: "User not found" });
        if (user.addresses.length >= 5) return res.status(400).json({ error: "Can't add more than 5 addresses" });
        
        if (user.addresses.length === 0) {
            addressData.isDefault = true;
        } else if (addressData.isDefault === true) {
            await User.updateOne({ id: userId }, { $set: { "addresses.$[].isDefault": false } });
            const refreshedUser = await User.findOne({ id: userId });
            if (refreshedUser) user.addresses = refreshedUser.addresses;
        }

        const _id = new mongoose.Types.ObjectId();
        const newAddress = { ...addressData, _id, country: addressData.country || 'India' };
        user.addresses.push(newAddress);
        await user.save();

        const keysToInvalidate = [`user:id:${userId}`, `user:email:${user.email || ''}`, `user:phone:${user.phone || ''}`];
        await redisClient.del(...keysToInvalidate.filter(Boolean)).catch(() => {});

        return res.status(201).json({ success: true, message: "Address added successfully", newAddress });
    } catch (error) {
        if (error.name === 'ValidationError') return res.status(400).json({ error: "Validation Failed", details: error.message });
        return res.status(500).json({ error: "Internal Server Error" });
    }
};

export const updateAddress = async (req, res) => {
    try {
        const { _id, userId, ...updatedAddressData } = req.body;
        if (!userId) return res.status(401).json({ error: "Please login again" });

        const currentUser = await User.findOne({ id: userId });
        if (!currentUser) return res.status(404).json({ error: "User not found" });

        const targetAddress = currentUser.addresses.id(_id);
        if (!targetAddress) return res.status(404).json({ error: "Address not found" });

        if (updatedAddressData.isDefault === false && targetAddress.isDefault === true) {
            const otherDefaults = currentUser.addresses.filter(addr => addr._id.toString() !== _id && addr.isDefault === true);
            if (otherDefaults.length === 0) return res.status(400).json({ error: "At least one address must be set as default." });
        }

        if (updatedAddressData.isDefault === true) {
            await User.updateOne({ id: userId }, { $set: { "addresses.$[].isDefault": false } });
        }

        const updateFields = {};
        for (const key in updatedAddressData) {
            updateFields[`addresses.$.${key}`] = updatedAddressData[key];
        }

        const user = await User.findOneAndUpdate({ id: userId, "addresses._id": _id }, { $set: updateFields }, { new: true, runValidators: true });
        const keysToInvalidate = [`user:id:${userId}`, `user:email:${user.email || ''}`, `user:phone:${user.phone || ''}`];
        await redisClient.del(...keysToInvalidate.filter(Boolean)).catch(() => {});

        return res.status(200).json({ success: "Address updated successfully", updatedAddress: user.addresses.id(_id) });
    } catch (error) {
        return res.status(500).json({ error: "Internal Server Error" });
    }
};

export const deleteAddress = async (req, res) => {
    try {
        const { id, addressId } = req.params; 
        if (!id || !addressId) return res.status(400).json({ error: "Missing identification" });

        const user = await User.findOne({ id });
        if (!user) return res.status(404).json({ error: "User not found" });

        const addressToDelete = user.addresses.id(addressId);
        if (!addressToDelete) return res.status(404).json({ error: "Address not found" });

        if (addressToDelete.isDefault) return res.status(400).json({ error: "You cannot delete your primary address." });

        user.addresses.pull(addressId);
        await user.save();

        const keysToInvalidate = [`user:id:${id}`, `user:email:${user.email || ''}`, `user:phone:${user.phone || ''}`];
        await redisClient.del(...keysToInvalidate.filter(Boolean)).catch(() => {});

        return res.status(200).json({ success: "Address deleted successfully", deletedAddress: addressId });
    } catch (error) {
        return res.status(500).json({ error: "Internal Server Error" });
    }
};

export const getAddresses = async (req, res) => {
    try {
        const { id } = req.params; 
        if (!id) return res.status(401).json({ error: "Please login to continue" });

        const cacheKey = `user:addresses:${id}`;
        const cachedAddresses = await redisClient.get(cacheKey);

        if (cachedAddresses) return res.status(200).json({ success: true, addresses: JSON.parse(cachedAddresses) });

        const user = await User.findOne({ id });
        if (!user) return res.status(404).json({ error: "User not found" });

        await redisClient.setEx(cacheKey, 3600, JSON.stringify(user.addresses));
        return res.status(200).json({ success: true, addresses: user.addresses });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

export const getMe = async (req, res) => {
    try {
        if (req.user) res.status(200).json({ success: true, user: req.user });
        else res.status(404).json({ alert: "User not found" });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

export const logoutUser = async (req, res) => {
    try {
        res.clearCookie('token');
        return res.status(200).json({ success: true, message: 'Logged out' });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to logout' });
    }
};

// import mongoose from "mongoose";
// import User from "../models/Users.js";
// import Order from "../models/Order.js";
// import Product from "../models/Product.js";
// import bcrypt from "bcryptjs"
// import { v4 as uuidv4 } from 'uuid';
// import { redisClient } from '../config/redis.js';
// import jwt from "jsonwebtoken"

// const generateToken = (id) => {
//     return jwt.sign({ id }, process.env.JWT_SECRET, {
//         expiresIn: '30d', // Token lasts for 30 days
//     });
// };

// const CART_PREFIX_USER = 'cart:user:';
// const CART_PREFIX_GUEST = 'cart:guest:';
// const TTL_SECONDS = 60 * 60 * 24 * 30;
// const TOKEN_REGEX = /^[a-f0-9]{32}$/i;

// function normalizeCartItem(raw) {
//     if (!raw || typeof raw !== 'object') return null;

//     const productId = String(raw.productId || '').slice(0, 120);
//     const variantId = Number(raw.variantId ?? raw.varient) || 0;
//     const size = String(raw.size || '').slice(0, 20);
//     const quantity = Math.min(10, Math.max(1, Number(raw.quantity) || 1));
//     const varient = String((raw.varient ?? raw.variant ?? variantId) || '').slice(0, 120);

//     if (!productId) return null;
//     return { productId, variantId, size, quantity, varient };
// }

// function sanitizeThinCart(items) {
//     if (!Array.isArray(items)) return [];
//     return items
//         .slice(0, 50)
//         .map(normalizeCartItem)
//         .filter(Boolean);
// }

// function mergeThinCarts(primary = [], secondary = []) {
//     const merged = new Map();

//     for (const raw of [...primary, ...secondary]) {
//         const item = normalizeCartItem(raw);
//         if (!item) continue;

//         const key = `${item.productId}:${item.variantId}:${item.size}`;
//         const existing = merged.get(key);

//         if (existing) {
//             existing.quantity = Math.min(99, existing.quantity + item.quantity);
//         } else {
//             merged.set(key, item);
//         }
//     }

//     return [...merged.values()];
// }

// export const registerUser = async (req, res) => {
//     const { firstName, lastName, email, phone, password } = req.body;
//     const id = `USR-${Date.now().toString().slice(-4)}${Math.floor(1000 + Math.random() * 9000)}`;

//     try {
//         // Check existence in parallel
//         const [emailExists, phoneExists] = await Promise.all([
//             User.exists({ email }),
//             User.exists({ phone })
//         ]);

//         if (emailExists || phoneExists) {
//             return res.status(400).json({ error: "Email or Phone already taken" });
//         }

//         const newUser = new User({ id, firstName, lastName, email, phone, password });
//         const savedUser = await newUser.save();

//         const userData = savedUser.toObject();
//         delete userData.password;

//         const token = generateToken(savedUser.id);
//         const jsonUser = JSON.stringify(userData);

//         // Seed all cache keys immediately
//         await Promise.all([
//             redisClient.setEx(`user:id:${savedUser.id}`, 3600, jsonUser),
//             redisClient.setEx(`user:email:${savedUser.email}`, 3600, jsonUser),
//             redisClient.setEx(`user:phone:${savedUser.phone}`, 3600, jsonUser)
//         ]);

//         const guestToken = String(req.headers['x-cart-token'] || '').trim();
//         if (guestToken && TOKEN_REGEX.test(guestToken)) {
//             const rawGuest = await redisClient.get(`${CART_PREFIX_GUEST}${guestToken}`);
//             if (rawGuest) {
//                 const guestItems = sanitizeThinCart(JSON.parse(rawGuest));
//                 if (guestItems.length) {
//                     await redisClient.setEx(`${CART_PREFIX_USER}${savedUser.id}`, TTL_SECONDS, JSON.stringify(guestItems));
//                     await redisClient.sAdd('dirty_carts', String(savedUser.id)).catch(() => {});
//                     await redisClient.del(`${CART_PREFIX_GUEST}${guestToken}`).catch(() => {});
//                 }
//             }
//         }

//         // Set httpOnly cookie for browser-based clients (Admin panel)
//         const isProd = process.env.NODE_ENV === 'production';
//         res.cookie('token', token, {
//             httpOnly: true,
//             secure: isProd,
//             sameSite: 'lax',
//             maxAge: 30 * 24 * 60 * 60 * 1000
//         });

//         return res.status(201).json({ success: "Registered", user: userData, token });
//     } catch (error) {
//         return res.status(500).json({ error: "Internal Server Error" });
//     }
// };

// export const loginUser = async (req, res) => {
//     try {
//         const { email, phone, password } = req.body;
//         if (!password || (!email && !phone)) {
//             return res.status(400).json({ error: "Credentials missing" });
//         }

//         // 1. We ALWAYS need the password from DB for a safe login
//         // Caching passwords is risky. Login is the one place where a DB hit is fine.
//         const query = email ? { email } : { phone };
//         const user = await User.findOne(query).select('+password');

//         if (!user) return res.status(401).json({ error: "Invalid Credentials" });

//         // 2. Compare password
//         const isMatch = await user.comparePassword(password);
//         if (!isMatch) return res.status(401).json({ error: "Invalid Credentials" });

//         // 3. Prepare data for response & cache
//         const userData = user.toObject();
//         delete userData.password;

//         const guestToken = String(req.headers['x-cart-token'] || '').trim();

//         const rawUserCart = await redisClient.get(`${CART_PREFIX_USER}${user.id}`);
//         let userCartItems = rawUserCart ? sanitizeThinCart(JSON.parse(rawUserCart)) : [];

//         if (!userCartItems.length && Array.isArray(user.cart)) {
//             userCartItems = user.cart.map(normalizeCartItem).filter(Boolean);
//         }

//         let guestItems = [];
//         if (guestToken && TOKEN_REGEX.test(guestToken)) {
//             const rawGuest = await redisClient.get(`${CART_PREFIX_GUEST}${guestToken}`);
//             guestItems = rawGuest ? sanitizeThinCart(JSON.parse(rawGuest)) : [];
//         }

//         const mergedCart = mergeThinCarts(userCartItems, guestItems);
//         await redisClient.setEx(`${CART_PREFIX_USER}${user.id}`, TTL_SECONDS, JSON.stringify(mergedCart));
//         await redisClient.sAdd('dirty_carts', String(user.id)).catch(() => {});

//         if (guestToken && TOKEN_REGEX.test(guestToken)) {
//             await redisClient.del(`${CART_PREFIX_GUEST}${guestToken}`).catch(() => {});
//         }

//         const token = generateToken(user.id);
//         const jsonUser = JSON.stringify(userData);

//         // 4. Update/Seed all cache aliases so other routes (profile, cart) are fast
//         const TTL = 3600;
//         await Promise.all([
//             redisClient.setEx(`user:id:${user.id}`, TTL, jsonUser),
//             redisClient.setEx(`user:email:${user.email}`, TTL, jsonUser),
//             redisClient.setEx(`user:phone:${user.phone}`, TTL, jsonUser)
//         ]);

//         // Set httpOnly cookie for browser-based clients (Admin panel)
//         const isProd = process.env.NODE_ENV === 'production';
//         res.cookie('token', token, {
//             httpOnly: true,
//             secure: isProd,
//             sameSite: 'lax',
//             maxAge: 30 * 24 * 60 * 60 * 1000
//         });

//         return res.json({ success: "Login Successful", user: userData, token });
//     } catch (error) {
//         return res.status(500).json({ error: error.message });
//     }
// };


// export const updateUser = async (req, res) => {
//     try {
//         const { id } = req.user;
//         const { firstName, lastName } = req.body; // Explicitly pull only the fields you want to update
        
//         // 1. Fetch the document first to safely trigger 'save' middleware later
//         const user = await User.findOne({ id });
//         if (!user) {
//             return res.status(404).json({ error: "User not found" });    
//         }

//         // 2. Apply modifications only if they are passed in the request body
//         if (firstName !== undefined) user.firstName = firstName;
//         if (lastName !== undefined) user.lastName = lastName;

//         // 3. Save the document (This safely fires all validation and your pre('save') hooks)
//         await user.save();

//         // 4. Convert to Object to respect your virtuals config (like fullName)
//         const userData = user.toObject();
//         const jsonUser = JSON.stringify(userData);

//         // 5. Atomic cache update across all user identifiers
//         await Promise.all([
//             redisClient.setEx(`user:id:${user.id}`, 3600, jsonUser),
//             redisClient.setEx(`user:email:${user.email}`, 3600, jsonUser),
//             redisClient.setEx(`user:phone:${user.phone}`, 3600, jsonUser)
//         ]);

//         return res.status(200).json({ 
//             success: "User profile updated successfully", 
//             user: userData 
//         });

//     } catch (error) {
//         return res.status(500).json({ 
//             error:error.message || "Internal Server Error"    });
//     }
// };

// export const getAllUsersAdmin = async (req, res) => {
//     try {
//         const { q, role, sortBy, sortOrder } = req.query;
//         const query = {};

//         if (role && role !== "All") {
//             query.role = String(role).trim();
//         }

//         if (q) {
//             const search = new RegExp(String(q).trim(), "i");
//             query.$or = [
//                 { id: search },
//                 { firstName: search },
//                 { lastName: search },
//                 { email: search },
//                 { phone: search },
//                 { role: search }
//             ];
//         }

//         const field = sortBy === "email" ? "email" : "createdAt";
//         const direction = sortOrder === "asc" ? 1 : -1;
//         const users = await User.find(query).select("-password -__v").sort({ [field]: direction }).lean();

//         return res.status(200).json({ success: true, users });
//     } catch (error) {
//         return res.status(500).json({ error: error.message });
//     }
// };

// export const getUserAdmin = async (req, res) => {
//     try {
//         const { userId } = req.params;
//         const user = await User.findOne({ id: userId }).select("-password -__v").lean();
//         if (!user) return res.status(404).json({ error: "User not found" });

//         const orders = await Order.find({ userId }).sort({ createdAt: -1 }).lean();
//         const cartItems = Array.isArray(user.cart) ? user.cart : [];
//         const cart = await Promise.all(cartItems.map(async (item) => {
//             const product = await Product.findOne({ id: item.productId }).lean();
//             return {
//                 ...item,
//                 name: product?.name || item.productId,
//                 price: Number(product?.price || 0)
//             };
//         }));

//         return res.status(200).json({ success: true, user, orders, cart });
//     } catch (error) {
//         return res.status(500).json({ error: error.message });
//     }
// };

// export const updateUserAdmin = async (req, res) => {
//     try {
//         const { userId } = req.params;
//         const { firstName, lastName, phone, role } = req.body;
//         const patch = {};

//         if (firstName !== undefined) patch.firstName = String(firstName).trim();
//         if (lastName !== undefined) patch.lastName = String(lastName).trim();
//         if (phone !== undefined) patch.phone = String(phone).trim();
//         if (role !== undefined) patch.role = String(role).trim();

//         const user = await User.findOneAndUpdate({ id: userId }, patch, { new: true }).select("-password -__v").lean();
//         if (!user) return res.status(404).json({ error: "User not found" });

//         return res.status(200).json({ success: true, user });
//     } catch (error) {
//         return res.status(500).json({ error: error.message });
//     }
// };

// export const deleteUserAdmin = async (req, res) => {
//     try {
//         const { userId } = req.params;
//         const deletedUser = await User.findOneAndDelete({ id: userId });
//         if (!deletedUser) return res.status(404).json({ error: "User not found" });

//         return res.status(200).json({ success: true, message: "User deleted successfully" });
//     } catch (error) {
//         return res.status(500).json({ error: error.message });
//     }
// };

// export const addAddress = async (req, res) => {
//     try {
//         const { userId, ...addressData } = req.body;

//         if (!userId) {
//             return res.status(401).json({ error: "Please login again to continue" });
//         }

//         const user = await User.findOne({ id: userId });
//         if (!user) {
//             return res.status(404).json({ error: "User not found" });
//         }
// if(user.addresses.length >=5 ) return res.status(400).json({error : "Can't add more than 5 addresses"})
//         // LOGIC 1: If this is the first address, make it default
//         if (user.addresses.length === 0) {
//             addressData.isDefault = true;
//         } 
//         // LOGIC 1: If adding new address with isDefault=true, set all others to false
//         else if (addressData.isDefault === true) {
//             // Use MongoDB operator to set all other addresses to false
//             await User.updateOne(
//                 { id: userId },
//                 { $set: { "addresses.$[].isDefault": false } }
//             );
//             // Refresh the user object to get updated addresses
//             const refreshedUser = await User.findOne({ id: userId });
//             if (refreshedUser) {
//                 user.addresses = refreshedUser.addresses;
//             }
//         }

//         const _id = new mongoose.Types.ObjectId();
//         const newAddress = { 
//             ...addressData, 
//             _id,
//             country: addressData.country || 'India' // Fallback to default
//         };
        
//         // 5. Push and Save
//         user.addresses.push(newAddress);
     
//         await user.save();

//         const keysToInvalidate = [
//             `user:id:${userId}`,
//             `user:email:${user.email}`,
//             `user:phone:${user.phone}`
//         ];

//         try {
//             await redisClient.del(...keysToInvalidate.filter(Boolean));
//         } catch (redisError) {
//             console.error("Redis Cache Clear Error:", redisError);
//         }

//         // 7. Success Response
//         return res.status(201).json({
//             success: true,
//             message: "Address added successfully",
//             newAddress: newAddress
//         });

//     } catch (error) {
//         console.error(`Address Adding Error: ${error}`);
        
//         if (error.name === 'ValidationError') {
//             return res.status(400).json({ 
//                 error: "Validation Failed", 
//                 details: error.message 
//             });
//         }

//         return res.status(500).json({ error: "Internal Server Error" });
//     }
// };

// export const updateAddress = async (req, res) => {
//     try {
//         const { _id, userId, ...updatedAddressData } = req.body;

//         if (!userId) return res.status(401).json({ error: "Please login again" });

//         // 1. Fetch current user to check address state
//         const currentUser = await User.findOne({ id: userId });
//         if (!currentUser) return res.status(404).json({ error: "User not found" });

//         const targetAddress = currentUser.addresses.id(_id);
//         if (!targetAddress) return res.status(404).json({ error: "Address not found" });

//         if (updatedAddressData.isDefault === false && targetAddress.isDefault === true) {
//             const otherDefaults = currentUser.addresses.filter(
//                 (addr) => addr._id.toString() !== _id && addr.isDefault === true
//             );
            
//             if (otherDefaults.length === 0) {
//                 return res.status(400).json({ 
//                     error: "At least one address must be set as default. Please set another address as default first." 
//                 });
//             }
//         }

//         // 3. Handle the "Switching Default" logic
//         if (updatedAddressData.isDefault === true) {
//             // Set all addresses for this user to false first
//             await User.updateOne(
//                 { id: userId },
//                 { $set: { "addresses.$[].isDefault": false } } 
//             );
//         }

//         // 4. Build the update object
//         const updateFields = {};
//         for (const key in updatedAddressData) {
//             updateFields[`addresses.$.${key}`] = updatedAddressData[key];
//         }

//         // 5. Update the specific address
//         const user = await User.findOneAndUpdate(
//             { id: userId, "addresses._id": _id },
//             { $set: updateFields },
//             { new: true, runValidators: true }
//         );

//         // Cache Invalidation
//         const keysToInvalidate = [`user:id:${userId}`, `user:email:${user.email}`, `user:phone:${user.phone}`];
//         await redisClient.del(...keysToInvalidate.filter(Boolean)).catch(() => {});

//         return res.status(200).json({ 
//             success: "Address updated successfully",
//             updatedAddress: user.addresses.id(_id) 
//         });

//     } catch (error) {
//         console.error("Update Address Error:", error);
//         return res.status(500).json({ error: "Internal Server Error" });
//     }
// };


// export const deleteAddress = async (req, res) => {
//     try {
//         const { id, addressId } = req.params; 

//         if (!id || !addressId) {
//             return res.status(400).json({ error: "Missing identification" });
//         }

//         // 1. Find user and check if address is default
//         const user = await User.findOne({ id: id });
//         if (!user) return res.status(404).json({ error: "User not found" });

//         const addressToDelete = user.addresses.id(addressId);
//         if (!addressToDelete) return res.status(404).json({ error: "Address not found" });

//         // CRITICAL CHECK: Block deletion if default
//         if (addressToDelete.isDefault) {
//             return res.status(400).json({ 
//                 error: "You cannot delete your primary address. Please set another address as default first." 
//             });
//         }

//         // 2. Proceed with deletion
//         user.addresses.pull(addressId);
//         await user.save();

//         // Cache Invalidation
//         const keysToInvalidate = [`user:id:${id}`, `user:email:${user.email}`, `user:phone:${user.phone}`];
//         await redisClient.del(...keysToInvalidate.filter(Boolean)).catch(() => {});

//         return res.status(200).json({ success: "Address deleted successfully", deletedAddress: addressId });

//     } catch (error) {
//         return res.status(500).json({ error: "Internal Server Error" });
//     }
// };

// export const getAddresses = async (req, res) => {
//     try {
//         const { id } = req.params; 
        
//         if (!id) return res.status(401).json({ error: "Please login to continue" });

//         const cacheKey = `user:addresses:${id}`;
//         const cachedAddresses = await redisClient.get(cacheKey);

//         if (cachedAddresses) {
//             return res.status(200).json({
//                 success: true,
//                 addresses: JSON.parse(cachedAddresses)
//             });
//         }

//         // 2. Cache Miss - Go to MongoDB
//         const user = await User.findOne({ id: id });

//         if (!user) {
//             return res.status(404).json({ error: "User not found" });
//         }

//         // 3. Save to Redis for next time (Cache for 1 hour)
//         await redisClient.setEx(cacheKey, 3600, JSON.stringify(user.addresses));

//         return res.status(200).json({
//             success: true,
//             addresses: user.addresses
//         });

//     } catch (error) {
//         return res.status(500).json({ error: error.message });
//     }
// };

// export const getMe = async (req, res) => {
//     try {
//         // req.user was populated by the 'protect' middleware
//         if (req.user) {
//             res.status(200).json({
//                 success: true,
//                 user: req.user
//             });
//         } else {
//             res.status(404).json({ alert: "User not found" });
//         }
//     } catch (error) {
//         res.status(500).json({ message: error.message });
//     }
// };

// export const logoutUser = async (req, res) => {
//     try {
//         res.clearCookie('token');
//         return res.status(200).json({ success: true, message: 'Logged out' });
//     } catch (error) {
//         return res.status(500).json({ error: 'Failed to logout' });
//     }
// };