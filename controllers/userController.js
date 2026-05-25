import mongoose from "mongoose";
import User from "../models/Users.js";
import Order from "../models/Order.js";
import Product from "../models/Product.js";
import bcrypt from "bcryptjs"
import { v4 as uuidv4 } from 'uuid';
import { redisClient } from '../config/redis.js';
import jwt from "jsonwebtoken"

const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: '30d', // Token lasts for 30 days
    });
};

const CART_PREFIX_USER = 'cart:user:';
const CART_PREFIX_GUEST = 'cart:guest:';
const TTL_SECONDS = 60 * 60 * 24 * 30;
const TOKEN_REGEX = /^[a-f0-9]{32}$/i;

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
    return items
        .slice(0, 50)
        .map(normalizeCartItem)
        .filter(Boolean);
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

export const registerUser = async (req, res) => {
    const { firstName, lastName, email, phone, password } = req.body;
    const id = `USR-${Date.now().toString().slice(-4)}${Math.floor(1000 + Math.random() * 9000)}`;

    try {
        // Check existence in parallel
        const [emailExists, phoneExists] = await Promise.all([
            User.exists({ email }),
            User.exists({ phone })
        ]);

        if (emailExists || phoneExists) {
            return res.status(400).json({ error: "Email or Phone already taken" });
        }

        const newUser = new User({ id, firstName, lastName, email, phone, password });
        const savedUser = await newUser.save();

        const userData = savedUser.toObject();
        delete userData.password;

        const token = generateToken(savedUser.id);
        const jsonUser = JSON.stringify(userData);

        // Seed all cache keys immediately
        await Promise.all([
            redisClient.setEx(`user:id:${savedUser.id}`, 3600, jsonUser),
            redisClient.setEx(`user:email:${savedUser.email}`, 3600, jsonUser),
            redisClient.setEx(`user:phone:${savedUser.phone}`, 3600, jsonUser)
        ]);

        const guestToken = String(req.headers['x-cart-token'] || '').trim();
        if (guestToken && TOKEN_REGEX.test(guestToken)) {
            const rawGuest = await redisClient.get(`${CART_PREFIX_GUEST}${guestToken}`);
            if (rawGuest) {
                const guestItems = sanitizeThinCart(JSON.parse(rawGuest));
                if (guestItems.length) {
                    await redisClient.setEx(`${CART_PREFIX_USER}${savedUser.id}`, TTL_SECONDS, JSON.stringify(guestItems));
                    await redisClient.sAdd('dirty_carts', String(savedUser.id)).catch(() => {});
                    await redisClient.del(`${CART_PREFIX_GUEST}${guestToken}`).catch(() => {});
                }
            }
        }

        return res.status(201).json({ success: "Registered", user: userData, token });
    } catch (error) {
        return res.status(500).json({ error: "Internal Server Error" });
    }
};

export const loginUser = async (req, res) => {
    try {
        const { email, phone, password } = req.body;
        if (!password || (!email && !phone)) {
            return res.status(400).json({ error: "Credentials missing" });
        }

        // 1. We ALWAYS need the password from DB for a safe login
        // Caching passwords is risky. Login is the one place where a DB hit is fine.
        const query = email ? { email } : { phone };
        const user = await User.findOne(query).select('+password');

        if (!user) return res.status(401).json({ error: "Invalid Credentials" });

        // 2. Compare password
        const isMatch = await user.comparePassword(password);
        if (!isMatch) return res.status(401).json({ error: "Invalid Credentials" });

        // 3. Prepare data for response & cache
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

        // 4. Update/Seed all cache aliases so other routes (profile, cart) are fast
        const TTL = 3600;
        await Promise.all([
            redisClient.setEx(`user:id:${user.id}`, TTL, jsonUser),
            redisClient.setEx(`user:email:${user.email}`, TTL, jsonUser),
            redisClient.setEx(`user:phone:${user.phone}`, TTL, jsonUser)
        ]);

        return res.json({ success: "Login Successful", user: userData, token });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};


export const updateUser = async (req, res) => {
    try {
        const { id } = req.user;
        const { firstName, lastName } = req.body; // Explicitly pull only the fields you want to update
        
        // 1. Fetch the document first to safely trigger 'save' middleware later
        const user = await User.findOne({ id });
        if (!user) {
            return res.status(404).json({ error: "User not found" });    
        }

        // 2. Apply modifications only if they are passed in the request body
        if (firstName !== undefined) user.firstName = firstName;
        if (lastName !== undefined) user.lastName = lastName;

        // 3. Save the document (This safely fires all validation and your pre('save') hooks)
        await user.save();

        // 4. Convert to Object to respect your virtuals config (like fullName)
        const userData = user.toObject();
        const jsonUser = JSON.stringify(userData);

        // 5. Atomic cache update across all user identifiers
        await Promise.all([
            redisClient.setEx(`user:id:${user.id}`, 3600, jsonUser),
            redisClient.setEx(`user:email:${user.email}`, 3600, jsonUser),
            redisClient.setEx(`user:phone:${user.phone}`, 3600, jsonUser)
        ]);

        return res.status(200).json({ 
            success: "User profile updated successfully", 
            user: userData 
        });

    } catch (error) {
        return res.status(500).json({ 
            error:error.message || "Internal Server Error"    });
    }
};

export const getAllUsersAdmin = async (req, res) => {
    try {
        const { q, role, sortBy, sortOrder } = req.query;
        const query = {};

        if (role && role !== "All") {
            query.role = String(role).trim();
        }

        if (q) {
            const search = new RegExp(String(q).trim(), "i");
            query.$or = [
                { id: search },
                { firstName: search },
                { lastName: search },
                { email: search },
                { phone: search },
                { role: search }
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
        const { userId } = req.params;
        const user = await User.findOne({ id: userId }).select("-password -__v").lean();
        if (!user) return res.status(404).json({ error: "User not found" });

        const orders = await Order.find({ userId }).sort({ createdAt: -1 }).lean();
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
        const { firstName, lastName, phone, role } = req.body;
        const patch = {};

        if (firstName !== undefined) patch.firstName = String(firstName).trim();
        if (lastName !== undefined) patch.lastName = String(lastName).trim();
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

        if (!userId) {
            return res.status(401).json({ error: "Please login again to continue" });
        }

        const user = await User.findOne({ id: userId });
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }
if(user.addresses.length >=5 ) return res.status(400).json({error : "Can't add more than 5 addresses"})
        // LOGIC 1: If this is the first address, make it default
        if (user.addresses.length === 0) {
            addressData.isDefault = true;
        } 
        // LOGIC 1: If adding new address with isDefault=true, set all others to false
        else if (addressData.isDefault === true) {
            // Use MongoDB operator to set all other addresses to false
            await User.updateOne(
                { id: userId },
                { $set: { "addresses.$[].isDefault": false } }
            );
            // Refresh the user object to get updated addresses
            const refreshedUser = await User.findOne({ id: userId });
            if (refreshedUser) {
                user.addresses = refreshedUser.addresses;
            }
        }

        const _id = new mongoose.Types.ObjectId();
        const newAddress = { 
            ...addressData, 
            _id,
            country: addressData.country || 'India' // Fallback to default
        };
        
        // 5. Push and Save
        user.addresses.push(newAddress);
     
        await user.save();

        const keysToInvalidate = [
            `user:id:${userId}`,
            `user:email:${user.email}`,
            `user:phone:${user.phone}`
        ];

        try {
            await redisClient.del(...keysToInvalidate.filter(Boolean));
        } catch (redisError) {
            console.error("Redis Cache Clear Error:", redisError);
        }

        // 7. Success Response
        return res.status(201).json({
            success: true,
            message: "Address added successfully",
            newAddress: newAddress
        });

    } catch (error) {
        console.error(`Address Adding Error: ${error}`);
        
        if (error.name === 'ValidationError') {
            return res.status(400).json({ 
                error: "Validation Failed", 
                details: error.message 
            });
        }

        return res.status(500).json({ error: "Internal Server Error" });
    }
};

export const updateAddress = async (req, res) => {
    try {
        const { _id, userId, ...updatedAddressData } = req.body;

        if (!userId) return res.status(401).json({ error: "Please login again" });

        // 1. Fetch current user to check address state
        const currentUser = await User.findOne({ id: userId });
        if (!currentUser) return res.status(404).json({ error: "User not found" });

        const targetAddress = currentUser.addresses.id(_id);
        if (!targetAddress) return res.status(404).json({ error: "Address not found" });

        if (updatedAddressData.isDefault === false && targetAddress.isDefault === true) {
            const otherDefaults = currentUser.addresses.filter(
                (addr) => addr._id.toString() !== _id && addr.isDefault === true
            );
            
            if (otherDefaults.length === 0) {
                return res.status(400).json({ 
                    error: "At least one address must be set as default. Please set another address as default first." 
                });
            }
        }

        // 3. Handle the "Switching Default" logic
        if (updatedAddressData.isDefault === true) {
            // Set all addresses for this user to false first
            await User.updateOne(
                { id: userId },
                { $set: { "addresses.$[].isDefault": false } } 
            );
        }

        // 4. Build the update object
        const updateFields = {};
        for (const key in updatedAddressData) {
            updateFields[`addresses.$.${key}`] = updatedAddressData[key];
        }

        // 5. Update the specific address
        const user = await User.findOneAndUpdate(
            { id: userId, "addresses._id": _id },
            { $set: updateFields },
            { new: true, runValidators: true }
        );

        // Cache Invalidation
        const keysToInvalidate = [`user:id:${userId}`, `user:email:${user.email}`, `user:phone:${user.phone}`];
        await redisClient.del(...keysToInvalidate.filter(Boolean)).catch(() => {});

        return res.status(200).json({ 
            success: "Address updated successfully",
            updatedAddress: user.addresses.id(_id) 
        });

    } catch (error) {
        console.error("Update Address Error:", error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};


export const deleteAddress = async (req, res) => {
    try {
        const { id, addressId } = req.params; 

        if (!id || !addressId) {
            return res.status(400).json({ error: "Missing identification" });
        }

        // 1. Find user and check if address is default
        const user = await User.findOne({ id: id });
        if (!user) return res.status(404).json({ error: "User not found" });

        const addressToDelete = user.addresses.id(addressId);
        if (!addressToDelete) return res.status(404).json({ error: "Address not found" });

        // CRITICAL CHECK: Block deletion if default
        if (addressToDelete.isDefault) {
            return res.status(400).json({ 
                error: "You cannot delete your primary address. Please set another address as default first." 
            });
        }

        // 2. Proceed with deletion
        user.addresses.pull(addressId);
        await user.save();

        // Cache Invalidation
        const keysToInvalidate = [`user:id:${id}`, `user:email:${user.email}`, `user:phone:${user.phone}`];
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

        if (cachedAddresses) {
            console.log("⚡ Redis Hit: Serving addresses from cache");
            return res.status(200).json({
                success: true,
                addresses: JSON.parse(cachedAddresses)
            });
        }

        // 2. Cache Miss - Go to MongoDB
        console.log("🐢 Redis Miss: Fetching addresses from MongoDB");
        const user = await User.findOne({ id: id });

        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        // 3. Save to Redis for next time (Cache for 1 hour)
        await redisClient.setEx(cacheKey, 3600, JSON.stringify(user.addresses));

        return res.status(200).json({
            success: true,
            addresses: user.addresses
        });

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

export const getMe = async (req, res) => {
    try {
        // req.user was populated by the 'protect' middleware
        if (req.user) {
            res.status(200).json({
                success: true,
                user: req.user
            });
        } else {
            res.status(404).json({ alert: "User not found" });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};