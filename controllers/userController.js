import mongoose from "mongoose";
import User from "../models/Users.js";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import SupportTicket from "../models/SupportTicket.js";
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { redisClient } from '../config/redis.js';
import jwt from "jsonwebtoken";
import axios from "axios";
import { sendEmail } from '../config/email.js';
import { validateRecaptcha } from "../middleware/verifyRecaptcha.js";
import SiteData from '../models/SiteData.js';
import bcrypt from "bcryptjs";

const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: '30d',
    });
};

const CART_PREFIX_USER = 'cart:user:';
const CART_PREFIX_GUEST = 'cart:guest:';
const TTL_SECONDS = 60 * 60 * 24 * 30;
const SESSION_TTL = 7 * 24 * 60 * 60;
const TOKEN_REGEX = /^[a-f0-9]{32}$/i;
const OTP_TTL = 300;

const isLocalhost = (hostname) => /^(localhost|127\.0\.0\.1|::1)$/.test(hostname);

const buildCookieOptions = (req) => {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    const isSecureRequest = req.secure || forwardedProto === 'https' || req.protocol === 'https';
    const cookieOptions = {
        httpOnly: true,
        secure: isSecureRequest,
        sameSite: isSecureRequest ? 'none' : 'lax',
        path: '/',
        maxAge: SESSION_TTL * 1000,
    };

    // const cookieDomain = String(process.env.COOKIE_DOMAIN || '').trim();
    // if (cookieDomain) {
    //     cookieOptions.domain = cookieDomain;
    // }

    return cookieOptions;
};

const computeSessionFingerprint = (req) => {
    const userAgent = String(req.headers['user-agent'] || '').trim().slice(0, 512);
    const acceptLanguage = String(req.headers['accept-language'] || '').trim().slice(0, 128);
    const origin = String(req.headers.origin || '').trim().slice(0, 128);
    return crypto.createHash('sha256').update(`${userAgent}|${acceptLanguage}|${origin}`).digest('hex');
};

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

    // 1. Handle Cart Merging Logic
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
    
    // Perform Redis operations for cart and session index
    // We use consistent camelCase (sAdd) as required by node-redis v4+
    await redisClient.setEx(`${CART_PREFIX_USER}${user.id}`, TTL_SECONDS, JSON.stringify(mergedCart));
    await redisClient.sAdd('dirty_carts', String(user.id)).catch(() => {});

    if (guestToken && TOKEN_REGEX.test(guestToken)) {
        await redisClient.del(`${CART_PREFIX_GUEST}${guestToken}`).catch(() => {});
    }

    // 2. Session Issuance Logic
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionFingerprint = computeSessionFingerprint(req);
    const sessionPayload = {
        user: userData,
        fingerprint: sessionFingerprint,
        meta: {
            userAgent: String(req.headers['user-agent'] || '').trim().slice(0, 512),
            acceptLanguage: String(req.headers['accept-language'] || '').trim().slice(0, 128),
            origin: String(req.headers.origin || '').trim().slice(0, 128),
            issuedAt: Date.now(),
        },
    };

    const jsonUser = JSON.stringify(userData);
    const jsonSession = JSON.stringify(sessionPayload);

    // 
    // Parallelizing session storage and indexing
    await Promise.all([
        redisClient.setEx(`user:id:${user.id}`, SESSION_TTL, jsonUser),
        redisClient.setEx(`user:email:${user.email || ''}`, SESSION_TTL, jsonUser),
        redisClient.setEx(`user:phone:${user.phone || ''}`, SESSION_TTL, jsonUser),
        redisClient.setEx(`session:${sessionToken}`, SESSION_TTL, jsonSession),
        redisClient.sAdd(`user_sessions:${user.id}`, sessionToken),
        redisClient.expire(`user_sessions:${user.id}`, SESSION_TTL)
    ]);

    const cookieOptions = buildCookieOptions(req);

    res.cookie('token', sessionToken, cookieOptions);
    if (process.env.NODE_ENV !== 'production') {
        res.setHeader('X-Debug-Session-Token', sessionToken);
    }

    const sessionKey = `session:${sessionToken}`;
    const sessionExists = await redisClient.exists(sessionKey);
    // console.log('[server][session] issued cookie token and stored session:', {
    //   sessionKey,
    //   sessionExists,
    //   cookieName: 'token',
    //   cookieOptions,
    //   responseOrigin: req.headers.origin,
    //   requestPath: req.originalUrl,
    //   requestMethod: req.method,
    // });

    return res.json({ success: messageSuccess, user: userData, sessionToken });
}


export const handleContactUsRequest = async (req, res) => {
    try {



        const { userId, name, email, senderEmail, subject, message, recaptchaToken, source } = req.body;

        const normalizedEmail = String(email || senderEmail || '').trim().toLowerCase();
        const cleanName = String(name).trim();
        const cleanSubject = String(subject).trim();
        const cleanMessage = String(message).trim();
        const ticketSource = String(source || 'contact_form').trim();

        if (!cleanName || !normalizedEmail || !cleanSubject || !cleanMessage) {
            return res.status(400).json({ error: "All fields (name, email, subject, message) are required." });
        }




        try {
            await validateRecaptcha(recaptchaToken);
        } catch (recaptchaError) {
            return res.status(403).json({ error: recaptchaError.message });
        }




        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(normalizedEmail)) {
            return res.status(400).json({ error: "Please provide a valid email address." });
        }




        const contactCooldownKey = `cooldown:contact:${normalizedEmail}`;
        const hasSubmittedRecently = await redisClient.get(contactCooldownKey);

        if (hasSubmittedRecently) {
            return res.status(429).json({
                error: "You have submitted a request recently. Please wait 2 minutes before trying again."
            });
        }





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




        const siteConfig = await SiteData.findOne({});

        const targetSupportEmail = siteConfig?.contact?.email || siteConfig?.checkout?.supportEmail || "vishalsainig009@gmail.com";

        if (!siteConfig || !targetSupportEmail) {
            return res.status(500).json({ error: "Support contact email is not configured properly. Please try again later." });
        }

        const supportTicket = await SupportTicket.create({
            userId: userId ? String(userId).trim() : 'Guest',
            name: cleanName,
            email: normalizedEmail,
            subject: cleanSubject,
            message: cleanMessage,
            source: ticketSource,
            status: 'new',
            mailSent: false
        });

        const mailResult = await sendEmail({
            to: targetSupportEmail,
            replyTo: normalizedEmail,
            subject: `[Contact Us] - ${cleanName} ${userId ? `(ID: ${userId})` : ''} - ${cleanSubject}`,
            html: internalEmailHtml
        });

        supportTicket.mailSent = Boolean(mailResult?.success);
        await supportTicket.save();

        if (!mailResult || mailResult.success === false) {
            return res.status(500).json({
                error: "Failed to process your request at this time.",
                details: mailResult?.error || "Mail transmission handshake failure"
            });
        }




        await redisClient.setEx(contactCooldownKey, 120, "locked");

        return res.status(200).json({
            success: true,
            message: "Your message has been received! Our support team will get back to you shortly."
        });

    } catch (error) {

        console.error("Contact Form Pipeline Error Details:", error);
        return res.status(500).json({ error: "Internal server error occurred processing the ticket." });
    }
};

export const checkAuthIdentity = async (req, res) => {
    try {
        const { mode, identifierType = 'email', email, phone, adminLogin } = req.body;

        if (!mode || !['login', 'register', 'forgot'].includes(mode)) {
            return res.status(400).json({ error: 'Auth mode must be login, register, or forgot.' });
        }

        const normalizedEmail = email ? String(email).trim().toLowerCase() : '';
        const normalizedPhone = phone ? String(phone).trim() : '';
        const effectiveIdentifierType = identifierType === 'phone' ? 'phone' : 'email';

        if (effectiveIdentifierType === 'email' && !normalizedEmail) {
            return res.status(400).json({ error: 'Email is required for email authentication.' });
        }

        if (effectiveIdentifierType === 'phone' && !normalizedPhone) {
            return res.status(400).json({ error: 'Phone number is required for phone authentication.' });
        }

      const existingUser = effectiveIdentifierType === 'email'
            ? await User.findOne({ email: normalizedEmail }).select('+password')
            : await User.findOne({ phone: normalizedPhone }).select('+password');

        if (mode === 'login') {
            if (!existingUser) {
                return res.status(404).json({ error: `No account found with this ${identifierType}.` });
            }

            if (adminLogin && existingUser.role !== 'Admin') {
                return res.status(403).json({ error: 'Invalid admin user.' });
            }

            if (!req.body.password || !String(req.body.password).trim()) {
                return res.status(400).json({ error: 'Password is required for login.' });
            }

            // FIX: Prevent crash if user has no password
            if (!existingUser.password) {
                return res.status(401).json({ error: 'Incorrect password.' });
            }

            // You can safely use your model method here now
            const passwordMatches = await existingUser.comparePassword(String(req.body.password).trim());
            if (!passwordMatches) {
                return res.status(401).json({ error: 'Incorrect password.' });
            }
        }
        if (mode === 'forgot') {
            if (!existingUser) {
                return res.status(404).json({ error: `No account found with this ${identifierType}.` });
            }

            return res.status(200).json({
                success: true,
                exists: true,
                email: existingUser.email,
                phone: existingUser.phone,
                role: existingUser.role,
                message: 'Account found. Please verify your email with OTP to reset your password.'
            });
        }

        if (mode === 'register') {
            if (existingUser) {
                return res.status(409).json({ error: `This ${identifierType} is already registered.` });
            }

            return res.status(200).json({
                success: true,
                exists: false,
                message: 'This identifier is available for registration.'
            });
        }

        return res.status(400).json({ error: 'Invalid auth check request.' });
    } catch (error) {
        console.error('Auth identity check error:', error);
        return res.status(500).json({ error: 'Internal server error during identity verification.' });
    }
};



export const getOTPTemplate = (mode, otp, userName, adminLogin) => {
    const configs = {
        login: {
            title: "Sign-In Verification",
            message: "We have received a sign-in request for your account. If this was you, please use the OTP below to complete your sign-in.",
            action: "complete your sign-in"
        },
        register: {
            title: "Welcome to Urban!",
            message: "Thanks for creating an account with us. Please verify your email address to get started.",
            action: "complete your registration"
        },
        forgot: {
            title: "Password Reset",
            message: "We have received a password reset request for your account. If this wasn't you, please ignore this email.",
            action: "reset your password"
        },

    };

    const config = configs[mode] || configs.login;

    if (adminLogin) {
        return `
    <div style="max-width: 580px; margin: 0 auto; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; color: #334155;">
        <div style="padding: 30px; text-align: center; background-color: #f8fafc; border-bottom: 1px solid #e2e8f0;">
            <h2 style="margin: 0; color: #1e293b; font-size: 22px;">Admin Sign-In Verification</h2>
        </div>

        <div style="padding: 40px 30px; text-align: center;">
            <p style="font-size: 16px; line-height: 1.5; margin-bottom: 30px;">
              Dear ${userName},We have received an admin sign-in request for your account. If this was you, please use the OTP below to complete your sign-in. Use the code below to <strong>complete your admin sign-in</strong>:
            </p>
            
            <div style="margin: 20px 0;">
                <span style="display: block; font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 10px;">Verification Code</span>
                <div style="background: #eff6ff; border: 2px dashed #3b82f6; border-radius: 12px; padding: 20px; display: inline-block;">
                    <strong style="font-size: 36px; color: #1d4ed8; letter-spacing: 8px; font-family: monospace;">${otp}</strong>
                </div>
            </div>

            <p style="font-size: 14px; color: #64748b; margin-top: 25px;">
                ⚠️ This code is strictly temporary and will expire in <strong>5 minutes</strong>.
            </p>
        </div>

        <div style="padding: 20px; text-align: center; background-color: #f8fafc; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8;">
            <p style="margin: 0;">Urban Security Team</p>
            <p style="margin: 5px 0 0 0;">If you didn't request this, please secure your account immediately.</p>
        </div>
    </div>`;
    } else {
        return `
    <div style="max-width: 580px; margin: 0 auto; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden; color: #334155;">
        <div style="padding: 30px; text-align: center; background-color: #f8fafc; border-bottom: 1px solid #e2e8f0;">
            <h2 style="margin: 0; color: #1e293b; font-size: 22px;">${config.title}</h2>
        </div>

        <div style="padding: 40px 30px; text-align: center;">
            <p style="font-size: 16px; line-height: 1.5; margin-bottom: 30px;">
              Dear ${userName}, ${config.message} Use the code below to <strong>${config.action}</strong>:
            </p>
            
            <div style="margin: 20px 0;">
                <span style="display: block; font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 2px; margin-bottom: 10px;">Verification Code</span>
                <div style="background: #eff6ff; border: 2px dashed #3b82f6; border-radius: 12px; padding: 20px; display: inline-block;">
                    <strong style="font-size: 36px; color: #1d4ed8; letter-spacing: 8px; font-family: monospace;">${otp}</strong>
                </div>
            </div>

            <p style="font-size: 14px; color: #64748b; margin-top: 25px;">
                ⚠️ This code is strictly temporary and will expire in <strong>5 minutes</strong>.
            </p>
        </div>

        <div style="padding: 20px; text-align: center; background-color: #f8fafc; border-top: 1px solid #e2e8f0; font-size: 12px; color: #94a3b8;">
            <p style="margin: 0;">Urban Security Team</p>
            <p style="margin: 5px 0 0 0;">If you didn't request this, please secure your account immediately.</p>
        </div>
    </div>`;
    }
};

export const requestEmailOTP = async (req, res) => {
    try {
        // We replaced 'password' with 'preAuthToken'
        const { email, adminLogin, recaptchaToken, mode, preAuthToken } = req.body;

        if (!email) return res.status(400).json({ error: "Email address is required" });
        const normalizedEmail = String(email).trim().toLowerCase();

        let user = null;

        if (mode === 'login') {
            // Require the temporary token we generated in the previous step
            if (!preAuthToken) return res.status(401).json({ error: "Authentication session missing. Please log in again." });

            try {
                // Verify the token
                const decoded = jwt.verify(preAuthToken, process.env.JWT_SECRET);
                if (decoded.email !== normalizedEmail || !decoded.isPreAuthenticated) {
                     return res.status(401).json({ error: "Invalid authentication session" });
                }
            } catch (err) {
                return res.status(401).json({ error: "Authentication session expired. Please log in again." });
            }

            // Token is valid! Fetch user details needed for the email template
            user = await User.findOne({ email: normalizedEmail }).select("firstName lastName role");
            if (!user) return res.status(404).json({ error: "User not found" });

        } else if (mode === 'forgot') {
            user = await User.findOne({ email: normalizedEmail }).select("firstName lastName role");
            if (!user) return res.status(404).json({ error: "No account found with this email" });
        }

        // Admin check
        if (user && adminLogin && user.role !== 'Admin') {
            return res.status(403).json({ error: 'Invalid admin credentials' });
        }

        if (!adminLogin) await validateRecaptcha(recaptchaToken);

        const cooldownKey = `cooldown:email:${normalizedEmail}`;
        if (await redisClient.get(cooldownKey)) {
            return res.status(429).json({ error: "Please wait 60 seconds." });
        }

        // Generate and send OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        await redisClient.setEx(`otp:email:${normalizedEmail}`, 300, otp);
        const userName = user ? `${user.firstName} ${user.lastName}` : "Valued User";

        const mailResult = await sendEmail({
            to: normalizedEmail,
            subject: adminLogin ? "Your Admin Sign-In OTP Code" : "Your One-Time Verification Code",
            html: getOTPTemplate(mode, otp, userName, adminLogin)
        });

        if (!mailResult?.success) throw new Error("Email dispatch failed");

        await redisClient.setEx(cooldownKey, 60, "locked");
        return res.status(200).json({ success: true, message: "Credentials verified. OTP sent successfully!" });

    } catch (error) {
        console.error("Email OTP Error:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
};

// 1. NEW: Pre-Verification Endpoint
export const verifyLoginCredentials = async (req, res) => {
    try {
        const { email, password, recaptchaToken } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ error: "Email and password are required" });
        }

        const normalizedEmail = String(email).trim().toLowerCase();

        // Optional: Keep Recaptcha here to prevent bot brute-forcing passwords
        await validateRecaptcha(recaptchaToken); 

        const user = await User.findOne({ email: normalizedEmail }).select("+password");
        
        if (!user || !user.password) {
            return res.status(401).json({ error: "Invalid email or password" });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: "Invalid email or password" });
        }

        // SUCCESS! Generate a temporary 10-minute token
        // This proves to the next route that the user knows their password
        const preAuthToken = jwt.sign(
            { email: normalizedEmail, isPreAuthenticated: true },
            process.env.JWT_SECRET,
            { expiresIn: '10m' }
        );

        return res.status(200).json({ success: true, preAuthToken });

    } catch (error) {
        console.error("Credential Verification Error:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
};


export const verifyEmailOTP = async (req, res) => {
    try {
        const { email, phone, identifierType, otp, adminLogin, mode } = req.body;

        if (!otp) {
            return res.status(400).json({ error: "OTP code is required." });
        }

        const normalizedEmail = email ? String(email).trim().toLowerCase() : '';
        const normalizedPhone = phone ? String(phone).trim() : '';

        let lookupEmail = normalizedEmail;
        let user = null;

        if (identifierType === 'phone') {
            if (!normalizedPhone) {
                return res.status(400).json({ error: 'Phone is required when using phone authentication.' });
            }
            user = await User.findOne({ phone: normalizedPhone });
            if (user) {
                lookupEmail = user.email;
            }
        }

        if (!lookupEmail) {
            return res.status(400).json({ error: 'Email is required for OTP validation.' });
        }

        const cacheKey = `otp:email:${lookupEmail}`;
        const cachedOtp = await redisClient.get(cacheKey);

        if (!cachedOtp) {
            return res.status(400).json({ error: "Your verification code has expired or was never requested. Click resend." });
        }

        if (cachedOtp !== String(otp).trim()) {
            return res.status(400).json({ error: "Incorrect OTP entered. Please check your inbox and try again." });
        }

        await redisClient.del(cacheKey);

        if (!user) {
            user = await User.findOne({ email: lookupEmail });
        }

        if (!user) {
            if (adminLogin || mode === 'login') {
                return res.status(404).json({ error: 'Account does not exist. Please register first.' });
            }

            const registrationToken = jwt.sign(
                { email: lookupEmail },
                process.env.JWT_SECRET,
                { expiresIn: '15m' }
            );

            return res.status(200).json({
                success: true,
                registrationRequired: true,
                message: "Email verified successfully! Please complete your registration profile details.",
                registrationToken
            });
        }

        if (adminLogin && user.role !== 'Admin') {
            return res.status(403).json({ error: 'Invalid admin user' });
        }

        return await processUserSession(user, req, res, "Welcome back! Login successful.");

    } catch (error) {
        console.error("Email Verification Endpoint Error:", error);
        return res.status(500).json({ error: error.message || "Internal profile session integration crash" });
    }
};

export const resetPassword = async (req, res) => {
    try {
        const { email, otp, password } = req.body;

        if (!email || !otp || !password) {
            return res.status(400).json({ error: 'Email, OTP and new password are required.' });
        }

        const normalizedEmail = String(email).trim().toLowerCase();
        const cacheKey = `otp:email:${normalizedEmail}`;
        const cachedOtp = await redisClient.get(cacheKey);

        if (!cachedOtp) {
            return res.status(400).json({ error: 'OTP expired or not requested. Please request a new code.' });
        }

        if (String(cachedOtp).trim() !== String(otp).trim()) {
            return res.status(400).json({ error: 'Invalid OTP code.' });
        }

        const user = await User.findOne({ email: normalizedEmail });
        if (!user) {
            return res.status(404).json({ error: 'No account exists for that email address.' });
        }

        await redisClient.del(cacheKey);

        user.password = password.trim();
        await user.save();

        return await processUserSession(user, req, res, 'Password reset successful.');
    } catch (error) {
        console.error('Password Reset Error:', error);
        return res.status(500).json({ error: 'Internal server error during password reset.' });
    }
};

export const completeRegistration = async (req, res) => {
    try {
        const { firstName, lastName, phone, password, registrationToken } = req.body;

        if (!firstName || !password || !registrationToken) {
            return res.status(400).json({ error: "First name, password, and registration token are required." });
        }

        let decoded;
        try {
            decoded = jwt.verify(registrationToken, process.env.JWT_SECRET);
        } catch (err) {
            return res.status(400).json({ error: "Registration session expired. Please verify your email again." });
        }

        const verifiedEmail = decoded.email;
        const normalizedPhone = phone ? String(phone).trim() : '';
        const normalizedFirstName = String(firstName).trim() || `User${Date.now().toString().slice(-4)}`;
        const normalizedLastName = lastName ? String(lastName).trim() : 'Guest';

        let existingUser = await User.findOne({ email: verifiedEmail });
        if (existingUser) {
            return res.status(400).json({ error: "An account with this email address already exists." });
        }

        let finalPhone = normalizedPhone;
        if (finalPhone) {
            const phoneExists = await User.exists({ phone: finalPhone });
            if (phoneExists) {
                return res.status(400).json({ error: "This phone number is already associated with another account." });
            }
        } else {
            let uniquePhone;
            do {
                uniquePhone = `+91${Math.floor(1000000000 + Math.random() * 9000000000)}`;
            } while (await User.exists({ phone: uniquePhone }));
            finalPhone = uniquePhone;
        }

        const generatedId = `USR-${Date.now().toString().slice(-4)}${Math.floor(1000 + Math.random() * 9000)}`;

        const newUser = new User({
            id: generatedId,
            firstName: normalizedFirstName,
            lastName: normalizedLastName,
            email: verifiedEmail,
            phone: finalPhone,
            password: password.trim()
        });

        await newUser.save();

        return await processUserSession(newUser, req, res, "Account successfully provisioned! Welcome to Urban.");

    } catch (error) {
        console.error("Complete Registration Error:", error);
        return res.status(500).json({ error: "Internal profile configuration creation failure." });
    }
};


export const updateUser = async (req, res) => {
    try {
        const { id } = req.user;
        // 1. Extract phone from req.body
        const { firstName, lastName, phone } = req.body; 

        const user = await User.findOne({ id });
        if (!user) return res.status(404).json({ error: "User not found" });

        // Update name fields
        if (firstName !== undefined) user.firstName = String(firstName).trim();
        if (lastName !== undefined) user.lastName = String(lastName).trim();
        
        // 2. Add phone saving logic with uniqueness check
        if (phone !== undefined && String(phone).trim() !== '') {
            const newPhone = String(phone).trim();
            
            // Only check if the phone is actually changing
            if (newPhone !== user.phone) {
                const phoneExists = await User.findOne({ phone: newPhone, id: { $ne: id } });
                if (phoneExists) {
                    return res.status(400).json({ error: "This phone number is already registered to another account." });
                }
                user.phone = newPhone;
            }
        }

        await user.save();
        
        const userData = user.toObject();
        // Crucial: remove password from object before sending to client/Redis
        delete userData.password; 
        const jsonUser = JSON.stringify(userData);

        // Invalidate/Update Redis cache
        await Promise.all([
            redisClient.setEx(`user:id:${user.id}`, 3600, jsonUser),
            redisClient.setEx(`user:email:${user.email || ''}`, 3600, jsonUser),
            redisClient.setEx(`user:phone:${user.phone || ''}`, 3600, jsonUser),
            redisClient.setEx(`session:${req.cookies.token}`, 3600, jsonUser)
        ]);

        return res.status(200).json({ success: "User profile updated successfully", user: userData });
    } catch (error) {
        console.error("Update User Error:", error);
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
        const { firstName, lastName, phone, role, email } = req.body;
        const patch = {};
        if (firstName !== undefined) patch.firstName = String(firstName).trim();
        if (lastName !== undefined) patch.lastName = String(lastName).trim();
        if (email !== undefined) patch.email = String(email).trim().toLowerCase();
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

        // 1. Delete user from MongoDB
        const deletedUser = await User.findOneAndDelete(
            { id: userId }, 
            { returnDocument: 'after' }
        );

        if (!deletedUser) return res.status(404).json({ error: "User not found" });

        // 2. Fetch tokens using the correct node-redis method: sMembers (camelCase)
        const tokens = await redisClient.sMembers(`user_sessions:${userId}`);
        
        if (tokens && tokens.length > 0) {
            // node-redis uses multi() instead of pipeline()
            const multi = redisClient.multi();
            
            for (const token of tokens) {
                multi.del(`session:${token}`);
            }
            multi.del(`user_sessions:${userId}`);
            
            // Execute the batch of commands
            await multi.exec();
        }

        return res.status(200).json({ success: true, message: "User deleted successfully" });
    } catch (error) {
        console.error("Error deleting admin user:", error);
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
        await redisClient.del(...keysToInvalidate.filter(Boolean)).catch(() => { });

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
        await redisClient.del(...keysToInvalidate.filter(Boolean)).catch(() => { });

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
        await redisClient.del(...keysToInvalidate.filter(Boolean)).catch(() => { });

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
        // console.log('[server][getMe] cookies:', req.cookies, 'user:', req.user?.id);
        if (req.user) {
            return res.status(200).json({ success: true, user: req.user });
        }
        return res.status(404).json({ alert: "User not found" });
    } catch (error) {
        console.error('[server][getMe] error:', error);
        return res.status(500).json({ message: error.message });
    }
};

export const logoutUser = async (req, res) => {
    try {
        const token = req.cookies?.token || String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
        const isProd = process.env.NODE_ENV === 'production';
        let deletedCount = 0;


        if (token) {
            try {

                const sessionDel = await redisClient.del(`session:${token}`);
                deletedCount += sessionDel;
            } catch (err) {
                console.error('[logout] Error deleting session from redis:', err?.message || err);
            }


            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                const userId = decoded.id;

                if (userId) {

                    const keysToDelete = [
                        `user:id:${userId}`,
                        `user:addresses:${userId}`
                    ];

                    for (const k of keysToDelete) {
                        try {
                            const result = await redisClient.del(k);
                            if (result) {
                                deletedCount += result;
                            }
                        } catch (e) {
                            console.error(`[logout] Error deleting ${k}:`, e?.message || e);
                        }
                    }
                }
            } catch (verErr) {
            }
        }

        const cookieClearOptions = buildCookieOptions(req);
        delete cookieClearOptions.maxAge;

        res.clearCookie('token', cookieClearOptions);

        return res.status(200).json({ success: true, message: 'Logged out', deletedKeysCount: deletedCount });
    } catch (error) {
        console.error('[logout] Error in logoutUser:', error?.message || error);
        return res.status(500).json({ error: 'Failed to logout' });
    }
};

