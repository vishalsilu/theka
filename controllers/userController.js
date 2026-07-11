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
import { 
    sanitizeThinCart, 
    mergeThinCarts, 
    getUserCartItems, 
    saveUserCart 
} from '../controllers/cartController.js'; 

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
    return cookieOptions;
};

const computeSessionFingerprint = (req) => {
    const userAgent = String(req.headers['user-agent'] || '').trim().slice(0, 512);
    const acceptLanguage = String(req.headers['accept-language'] || '').trim().slice(0, 128);
    const origin = String(req.headers.origin || '').trim().slice(0, 128);
    return crypto.createHash('sha256').update(`${userAgent}|${acceptLanguage}|${origin}`).digest('hex');
};

const syncUserCacheAndSession = async (user, req) => {
    try {
        const userData = user.toObject();
        delete userData.password; 
        const jsonUser = JSON.stringify(userData);

        let token = req.cookies?.token;
        if (!token && req.headers.authorization?.toLowerCase().startsWith('bearer ')) {
            token = req.headers.authorization.split(' ')[1];
        }

        let updatedSessionString = null;
        if (token) {
            const sessionKey = `session:${token}`;
            const existingSessionStr = await redisClient.get(sessionKey);
            
            if (existingSessionStr) {
                const existingSession = JSON.parse(existingSessionStr);
                existingSession.user = userData; 
                updatedSessionString = JSON.stringify(existingSession);
            }
        }

        const redisPromises = [
            redisClient.setEx(`user:id:${user.id}`, 3600, jsonUser),
            redisClient.setEx(`user:email:${user.email || ''}`, 3600, jsonUser),
            redisClient.setEx(`user:phone:${user.phone || ''}`, 3600, jsonUser)
        ];

        if (token && updatedSessionString) {
            redisPromises.push(redisClient.setEx(`session:${token}`, 3600, updatedSessionString));
        }

        await Promise.all(redisPromises);
    } catch (err) {
        console.error("Failed to sync user session to Redis:", err);
    }
};

async function processUserSession(user, req, res, messageSuccess, isAdmin = false) {
    const userData = user.toObject();
    delete userData.password;

    const guestTokenRaw = req.headers['x-cart-token'];
    const guestToken = String(guestTokenRaw || '').trim().replace(/['"]/g, ''); 

    const userCartItems = await getUserCartItems(user.id);

    let guestItems = [];
    if (guestToken && TOKEN_REGEX.test(guestToken)) {
        const rawGuest = await redisClient.get(`${CART_PREFIX_GUEST}${guestToken}`);
        guestItems = rawGuest ? sanitizeThinCart(JSON.parse(rawGuest)) : [];
    }

    const mergedCart = mergeThinCarts(userCartItems, guestItems);
    await saveUserCart(user.id, mergedCart);

    if (guestToken && TOKEN_REGEX.test(guestToken)) {
        await redisClient.del(`${CART_PREFIX_GUEST}${guestToken}`).catch(() => {});
    }

    userData.cart = mergedCart;
    
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

    await Promise.all([
        redisClient.setEx(`user:id:${user.id}`, SESSION_TTL, jsonUser),
        redisClient.setEx(`user:email:${user.email || ''}`, SESSION_TTL, jsonUser),
        redisClient.setEx(`user:phone:${user.phone || ''}`, SESSION_TTL, jsonUser),
        redisClient.setEx(`session:${sessionToken}`, SESSION_TTL, jsonSession),
        redisClient.sAdd(`user_sessions:${user.id}`, sessionToken),
        redisClient.expire(`user_sessions:${user.id}`, SESSION_TTL)
    ]);

    const cookieOptions = buildCookieOptions(req);
    
    // 🔥 Dynamically set the cookie name based on role
    const cookieName = isAdmin ? 'admin_token' : 'token';
    res.cookie(cookieName, sessionToken, cookieOptions);
    
    if (process.env.NODE_ENV !== 'production') {
        res.setHeader('X-Debug-Session-Token', sessionToken);
    }

    return res.json({ success: true, message: messageSuccess, user: userData, sessionToken });
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
            return res.status(200).json({ success: false, error: "All fields (name, email, subject, message) are required." });
        }

        try {
            await validateRecaptcha(recaptchaToken);
        } catch (recaptchaError) {
            return res.status(200).json({ success: false, error: recaptchaError.message });
        }

        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(normalizedEmail)) {
            return res.status(200).json({ success: false, error: "Please provide a valid email address." });
        }

        const contactCooldownKey = `cooldown:contact:${normalizedEmail}`;
        const hasSubmittedRecently = await redisClient.get(contactCooldownKey);

        if (hasSubmittedRecently) {
            return res.status(200).json({ success: false, error: "You have submitted a request recently. Please wait 2 minutes before trying again." });
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
            return res.status(500).json({ success: false, error: "Support contact email is not configured properly. Please try again later." });
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
                success: false,
                error: "Failed to process your request at this time.",
                details: mailResult?.error || "Mail transmission handshake failure"
            });
        }

        await redisClient.setEx(contactCooldownKey, 120, "locked");

        return res.status(200).json({ success: true, message: "Your message has been received! Our support team will get back to you shortly." });

    } catch (error) {
        console.error("Contact Form Pipeline Error Details:", error);
        return res.status(500).json({ success: false, error: "Internal server error occurred processing the ticket." });
    }
};

export const checkAuthIdentity = async (req, res) => {
    try {
        const { mode, identifierType = 'email', email, phone, adminLogin } = req.body;

        if (!mode || !['login', 'register', 'forgot'].includes(mode)) {
            return res.status(200).json({ success: false, error: 'Auth mode must be login, register, or forgot.' });
        }

        const normalizedEmail = email ? String(email).trim().toLowerCase() : '';
        const normalizedPhone = phone ? String(phone).trim() : '';
        const effectiveIdentifierType = identifierType === 'phone' ? 'phone' : 'email';

        if (effectiveIdentifierType === 'email' && !normalizedEmail) {
            return res.status(200).json({ success: false, error: 'Email is required for email authentication.' });
        }

        if (effectiveIdentifierType === 'phone' && !normalizedPhone) {
            return res.status(200).json({ success: false, error: 'Phone number is required for phone authentication.' });
        }

        const existingUser = effectiveIdentifierType === 'email'
            ? await User.findOne({ email: normalizedEmail }).select('+password')
            : await User.findOne({ phone: normalizedPhone }).select('+password');

        if (mode === 'login') {
            if (!existingUser) {
                return res.status(200).json({ success: false, error: `No account found with this ${identifierType}.` });
            }

            if (adminLogin && existingUser.role !== 'Admin') {
                return res.status(200).json({ success: false, error: 'Invalid admin user.' });
            }

            if (!req.body.password || !String(req.body.password).trim()) {
                return res.status(200).json({ success: false, error: 'Password is required for login.' });
            }

            if (!existingUser.password) {
                return res.status(200).json({ success: false, error: 'Incorrect password.' });
            }

            const passwordMatches = await existingUser.comparePassword(String(req.body.password).trim());
            if (!passwordMatches) {
                return res.status(200).json({ success: false, error: 'Incorrect password.' });
            }
        }
        if (mode === 'forgot') {
            if (!existingUser) {
                return res.status(200).json({ success: false, error: `No account found with this ${identifierType}.` });
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
                return res.status(200).json({ success: false, error: `This ${identifierType} is already registered.` });
            }

            return res.status(200).json({
                success: true,
                exists: false,
                message: 'This identifier is available for registration.'
            });
        }

        return res.status(200).json({ success: false, error: 'Invalid auth check request.' });
    } catch (error) {
        console.error('Auth identity check error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error during identity verification.' });
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

    // 1. Determine the content based on role/mode
    let title, textContent;

    if (adminLogin) {
        title = "Admin Sign-In Verification";
        textContent = `We have received an admin sign-in request for your account. If this was you, please use the OTP below to <strong>complete your admin sign-in</strong>.`;
    } else {
        const config = configs[mode] || configs.login;
        title = config.title;
        textContent = `${config.message} Use the code below to <strong>${config.action}</strong>.`;
    }

    // 2. Return the single unified template matching the new UI style
    return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e5e5; padding: 20px;">
        <h2 style="color: #dc2626; margin-top: 0;">${title}</h2>
        <p>Dear <strong>${userName}</strong>,</p>
        <p>${textContent}</p>
        
        <div style="background-color: #f3f4f6; padding: 15px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 5px; margin: 20px 0; color: #111827;">
            ${otp}
        </div>

        <p style="font-size: 12px; color: #6b7280; margin-top: 20px;">
            This OTP expires in 5 minutes. If you did not request this, please secure your ${adminLogin ? 'admin account immediately' : 'account'}.
        </p>
    </div>`;
};

export const verifyLoginCredentials = async (req, res) => {
    try {
        const { email, password, recaptchaToken } = req.body;
        
        if (!email || !password) {
            return res.status(200).json({ success: false, error: "Email and password are required" });
        }

        const normalizedEmail = String(email).trim().toLowerCase();

        await validateRecaptcha(recaptchaToken); 

        const user = await User.findOne({ email: normalizedEmail }).select("+password");
        
        if (!user || !user.password) {
            return res.status(200).json({ success: false, error: "Invalid email or password" });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(200).json({ success: false, error: "Invalid email or password" });
        }

        const preAuthToken = jwt.sign(
            { email: normalizedEmail, isPreAuthenticated: true },
            process.env.JWT_SECRET,
            { expiresIn: '10m' }
        );

        return res.status(200).json({ success: true, preAuthToken });

    } catch (error) {
        console.error("Credential Verification Error:", error);
        return res.status(500).json({ success: false, error: "Internal server error" });
    }
};

export const requestEmailOTP = async (req, res) => {
    try {
        const { email, adminLogin, recaptchaToken, mode, preAuthToken, password } = req.body;

        if (!email) return res.status(200).json({ success: false, error: "Email address is required" });
        const normalizedEmail = String(email).trim().toLowerCase();

        let user = null;

        if (mode === 'login') {
            if (!preAuthToken) return res.status(200).json({ success: false, error: "Authentication session missing. Please log in again." });

            try {
                const decoded = jwt.verify(preAuthToken, process.env.JWT_SECRET);
                if (decoded.email !== normalizedEmail || !decoded.isPreAuthenticated) {
                     return res.status(200).json({ success: false, error: "Invalid authentication session" });
                }
            } catch (err) {
                return res.status(200).json({ success: false, error: "Authentication session expired. Please log in again." });
            }

            user = await User.findOne({ email: normalizedEmail }).select("firstName lastName role");
            if (!user) return res.status(200).json({ success: false, error: "User not found" });

        } else if (mode === 'forgot') {
            user = await User.findOne({ email: normalizedEmail }).select("firstName lastName role");
            if (!user) return res.status(200).json({ success: false, error: "No account found with this email" });
            
        } else if (mode === 'register') {
            const existingUser = await User.findOne({ email: normalizedEmail });
            if (existingUser) return res.status(200).json({ success: false, error: "An account with this email already exists" });
            
            if (!password) return res.status(200).json({ success: false, error: "Password is required for registration" });
            
            await redisClient.setEx(`pending:pwd:${normalizedEmail}`, 300, password);
        }

        if (user && adminLogin && user.role !== 'Admin') {
            return res.status(200).json({ success: false, error: 'Invalid admin credentials' });
        }

        if (!adminLogin) await validateRecaptcha(recaptchaToken);

        const cooldownKey = `cooldown:email:${normalizedEmail}`;
        if (await redisClient.get(cooldownKey)) {
            return res.status(200).json({ success: false, error: "Please wait 60 seconds." });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        await redisClient.setEx(`otp:email:${normalizedEmail}`, 300, otp);
        const userName = user ? `${user.firstName} ${user.lastName}` : "Valued User";

        const mailResult = await sendEmail({
            to: normalizedEmail,
            subject: adminLogin ? `Your Admin Sign-In OTP Code : ${otp}` : `Your One-Time Verification Code : ${otp}`,
            html: getOTPTemplate(mode, otp, userName, adminLogin)
        });

        if (!mailResult?.success) throw new Error("Email dispatch failed");

        await redisClient.setEx(cooldownKey, 60, "locked");
        return res.status(200).json({ success: true, message: "Credentials verified. OTP sent successfully!" });

    } catch (error) {
        console.error("Email OTP Error:", error);
        return res.status(500).json({ success: false, error: "Internal server error" });
    }
};

export const verifyEmailOTP = async (req, res) => {
    try {
        const { email, phone, identifierType, otp, adminLogin, mode } = req.body;

        if (!otp) return res.status(200).json({ success: false, error: "OTP code is required." });

        const normalizedEmail = email ? String(email).trim().toLowerCase() : '';
        const normalizedPhone = phone ? String(phone).trim() : '';

        let lookupEmail = normalizedEmail;
        let user = null;

        if (identifierType === 'phone') {
            if (!normalizedPhone) return res.status(200).json({ success: false, error: 'Phone is required.' });
            user = await User.findOne({ phone: normalizedPhone });
            if (user) lookupEmail = user.email;
            else return res.status(200).json({ success: false, error: 'Phone number not found.' }); 
        }

        if (!lookupEmail) return res.status(200).json({ success: false, error: 'Email is required for OTP validation.' });

        const cacheKey = `otp:email:${lookupEmail}`;
        const cachedOtp = await redisClient.get(cacheKey);

        if (!cachedOtp) return res.status(200).json({ success: false, error: "Your verification code has expired or was never requested." });
        if (cachedOtp !== String(otp).trim()) return res.status(200).json({ success: false, error: "Incorrect OTP entered." });

        await redisClient.del(cacheKey);

        if (!user) user = await User.findOne({ email: lookupEmail });

        if (!user) {
            if (adminLogin || mode === 'login') {
                return res.status(200).json({ success: false, error: 'Account does not exist. Please register first.' });
            }

            if (mode === 'register') {
                const rawPassword = await redisClient.get(`pending:pwd:${lookupEmail}`);
                if (!rawPassword) {
                    return res.status(200).json({ success: false, error: "Registration session expired. Please start over." });
                }

                const hashedPassword = await bcrypt.hash(rawPassword, 10);
                await redisClient.del(`pending:pwd:${lookupEmail}`);

                const generatedId = `USR-${Date.now().toString().slice(-4)}${Math.floor(1000 + Math.random() * 9000)}`;
                const uniquePlaceholderPhone = `+9100${Date.now()}`; 

                user = new User({
                    id: generatedId,
                    email: lookupEmail,
                    phone: uniquePlaceholderPhone,
                    password: hashedPassword,
                    firstName: `User${Date.now().toString().slice(-4)}`,
                    lastName: "Guest",
                    isProfileComplete: false
                });
                await user.save();

                const registrationToken = jwt.sign(
                    { userId: user._id },
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
        }


        if (adminLogin && user.role !== 'Admin') {
            return res.status(200).json({ success: false, error: 'Invalid admin user' });
        }

        return await processUserSession(user, req, res, "Welcome back! Login successful.", adminLogin);


    } catch (error) {
        console.error("Email Verification Endpoint Error:", error);
        return res.status(500).json({ success: false, error: error.message || "Internal profile session integration crash" });
    }
};

export const completeRegistration = async (req, res) => {
    try {
        const { firstName, lastName, phone, registrationToken } = req.body;

        if (!firstName || !registrationToken) {
            return res.status(200).json({ success: false, error: "First name and registration token are required." });
        }

        let decoded;
        try {
            decoded = jwt.verify(registrationToken, process.env.JWT_SECRET);
        } catch (err) {
            return res.status(200).json({ success: false, error: "Registration session expired. Please verify your email again." });
        }

        const userId = decoded.userId;
        const normalizedPhone = phone ? String(phone).trim() : '';
        const normalizedFirstName = String(firstName).trim();
        const normalizedLastName = lastName ? String(lastName).trim() : 'Guest';

        let updateData = {
            firstName: normalizedFirstName,
            lastName: normalizedLastName,
            isProfileComplete: true
        };

        if (normalizedPhone) {
            const phoneExists = await User.exists({ phone: normalizedPhone, _id: { $ne: userId } });
            if (phoneExists) {
                return res.status(200).json({ success: false, error: "This phone number is already associated with another account." });
            }
            updateData.phone = normalizedPhone;
        }

        const updatedUser = await User.findByIdAndUpdate(
            userId,
            updateData,
            { new: true } 
        );

        if (!updatedUser) {
            return res.status(200).json({ success: false, error: "User account could not be found to complete setup." });
        }

        return await processUserSession(updatedUser, req, res, "Account successfully provisioned! Welcome to the platform.");

    } catch (error) {
        console.error("Complete Registration Error:", error);
        return res.status(500).json({ success: false, error: "Internal profile configuration creation failure." });
    }
};

export const resetPassword = async (req, res) => {
    try {
        const { email, otp, password } = req.body;

        if (!email || !otp || !password) {
            return res.status(200).json({ success: false, error: 'Email, OTP and new password are required.' });
        }

        const normalizedEmail = String(email).trim().toLowerCase();
        const cacheKey = `otp:email:${normalizedEmail}`;
        const cachedOtp = await redisClient.get(cacheKey);

        if (!cachedOtp) {
            return res.status(200).json({ success: false, error: 'OTP expired or not requested. Please request a new code.' });
        }

        if (String(cachedOtp).trim() !== String(otp).trim()) {
            return res.status(200).json({ success: false, error: 'Invalid OTP code.' });
        }

        const user = await User.findOne({ email: normalizedEmail });
        if (!user) {
            return res.status(200).json({ success: false, error: 'No account exists for that email address.' });
        }

        await redisClient.del(cacheKey);

        user.password = password.trim();
        await user.save();

        return await processUserSession(user, req, res, 'Password reset successful.');
    } catch (error) {
        console.error('Password Reset Error:', error);
        return res.status(500).json({ success: false, error: 'Internal server error during password reset.' });
    }
};

export const updateUser = async (req, res) => {
    try {
        const { id } = req.user;
        const { firstName, lastName, phone } = req.body; 

        const user = await User.findOne({ id });
        if (!user) return res.status(200).json({ success: false, error: "User not found" });

        if (firstName !== undefined) user.firstName = String(firstName).trim();
        if (lastName !== undefined) user.lastName = String(lastName).trim();
        
        if (phone !== undefined && String(phone).trim() !== '') {
            const newPhone = String(phone).trim();
            if (newPhone !== user.phone) {
                const phoneExists = await User.findOne({ phone: newPhone, id: { $ne: id } });
                if (phoneExists) {
                    return res.status(200).json({ success: false, error: "This phone number is already registered to another account." });
                }
                user.phone = newPhone;
            }
        }

        await user.save();
        
        await syncUserCacheAndSession(user, req);

        const userData = user.toObject();
        delete userData.password; 
        return res.status(200).json({ success: true, message: "User profile updated successfully", user: userData });
    } catch (error) {
        console.error("Update User Error:", error);
        return res.status(500).json({ success: false, error: error.message || "Internal Server Error" });
    }
};

export const addAddress = async (req, res) => {
    try {
        const { userId, ...addressData } = req.body;
        if (!userId) return res.status(200).json({ success: false, error: "Please login again to continue" });

        const user = await User.findOne({ id: userId });
        if (!user) return res.status(200).json({ success: false, error: "User not found" });
        if (user.addresses.length >= 5) return res.status(200).json({ success: false, error: "Can't add more than 5 addresses" });

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

        await syncUserCacheAndSession(user, req);

        return res.status(201).json({ success: true, message: "Address added successfully", newAddress });
    } catch (error) {
        if (error.name === 'ValidationError') return res.status(200).json({ success: false, error: "Validation Failed", details: error.message });
        return res.status(500).json({ success: false, error: "Internal Server Error" });
    }
};

export const updateAddress = async (req, res) => {
    try {
        const { _id, userId, ...updatedAddressData } = req.body;
        if (!userId) return res.status(200).json({ success: false, error: "Please login again" });

        const currentUser = await User.findOne({ id: userId });
        if (!currentUser) return res.status(200).json({ success: false, error: "User not found" });

        const targetAddress = currentUser.addresses.id(_id);
        if (!targetAddress) return res.status(200).json({ success: false, error: "Address not found" });

        if (updatedAddressData.isDefault === false && targetAddress.isDefault === true) {
            const otherDefaults = currentUser.addresses.filter(addr => addr._id.toString() !== _id && addr.isDefault === true);
            if (otherDefaults.length === 0) return res.status(200).json({ success: false, error: "At least one address must be set as default." });
        }

        if (updatedAddressData.isDefault === true) {
            await User.updateOne({ id: userId }, { $set: { "addresses.$[].isDefault": false } });
        }

        const updateFields = {};
        for (const key in updatedAddressData) {
            updateFields[`addresses.$.${key}`] = updatedAddressData[key];
        }

        const user = await User.findOneAndUpdate(
            { id: userId, "addresses._id": _id }, 
            { $set: updateFields }, 
            { returnDocument: 'after', runValidators: true }
        );
        
        await syncUserCacheAndSession(user, req);

        return res.status(200).json({ success: true, message: "Address updated successfully", updatedAddress: user.addresses.id(_id) });
    } catch (error) {
        return res.status(500).json({ success: false, error: "Internal Server Error" });
    }
};

export const deleteAddress = async (req, res) => {
    try {
        const { id, addressId } = req.params;
        if (!id || !addressId) return res.status(200).json({ success: false, error: "Missing identification" });

        const user = await User.findOne({ id });
        if (!user) return res.status(200).json({ success: false, error: "User not found" });

        const addressToDelete = user.addresses.id(addressId);
        if (!addressToDelete) return res.status(200).json({ success: false, error: "Address not found" });

        if (addressToDelete.isDefault) return res.status(200).json({ success: false, error: "You cannot delete your primary address." });

        user.addresses.pull(addressId);
        await user.save();

        await syncUserCacheAndSession(user, req);

        return res.status(200).json({ success: true, message: "Address deleted successfully", deletedAddress: addressId });
    } catch (error) {
        return res.status(500).json({ success: false, error: "Internal Server Error" });
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
        return res.status(500).json({ success: false, error: error.message });
    }
};

export const getUserAdmin = async (req, res) => {
    try {
        const { id } = req.params;
        const user = await User.findOne({ id: id }).select("-password -__v").lean();
        if (!user) return res.status(200).json({ success: false, error: "User not found" });

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
        return res.status(500).json({ success: false, error: error.message });
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

        const user = await User.findOneAndUpdate(
            { id: userId }, 
            patch, 
            { returnDocument: 'after' }
        ).select("-password -__v").lean();

        if (!user) return res.status(200).json({ success: false, error: "User not found" });
        return res.status(200).json({ success: true, user });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};

export const deleteUserAdmin = async (req, res) => {
    try {
        const { userId } = req.params;

        const deletedUser = await User.findOneAndDelete(
            { id: userId }, 
            { returnDocument: 'after' }
        );

        if (!deletedUser) return res.status(200).json({ success: false, error: "User not found" });

        const tokens = await redisClient.sMembers(`user_sessions:${userId}`);
        
        if (tokens && tokens.length > 0) {
            const multi = redisClient.multi();
            
            for (const token of tokens) {
                multi.del(`session:${token}`);
            }
            multi.del(`user_sessions:${userId}`);
            
            await multi.exec();
        }

        return res.status(200).json({ success: true, message: "User deleted successfully" });
    } catch (error) {
        console.error("Error deleting admin user:", error);
        return res.status(500).json({ success: false, error: error.message });
    }
};

export const getAddresses = async (req, res) => {
    try {
        const { id } = req.params;
        if (!id) return res.status(200).json({ success: false, error: "Please login to continue" });

        const cacheKey = `user:addresses:${id}`;
        const cachedAddresses = await redisClient.get(cacheKey);

        if (cachedAddresses) return res.status(200).json({ success: true, addresses: JSON.parse(cachedAddresses) });

        const user = await User.findOne({ id });
        if (!user) return res.status(200).json({ success: false, error: "User not found" });

        await redisClient.setEx(cacheKey, 3600, JSON.stringify(user.addresses));
        return res.status(200).json({ success: true, addresses: user.addresses });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
};

export const getMe = async (req, res) => {
    try {
        if (req.user) {
            return res.status(200).json({ success: true, user: req.user });
        }
        return res.status(200).json({ success: false, alert: "User not found" });
    } catch (error) {
        console.error('[server][getMe] error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
};


export const getAdminMe = async (req, res) => {
    try {
        // 1. Check if user is logged in at all
        if (!req.user) {
            return res.status(200).json({ success: false, error: "Not authenticated." });
        }

        // 2. Explicitly check for Admin role
        if (req.user.role !== 'Admin') {
            return res.status(200).json({ 
                success: false, 
                error: "Access denied. Administrator privileges required." 
            });
        }

        // 3. Success: Return the admin user data
        return res.status(200).json({ success: true, user: req.user });

    } catch (error) {
        return res.status(500).json({ success: false, error: error.message || "Internal server error." });
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
        return res.status(500).json({ success: false, error: 'Failed to logout' });
    }
};