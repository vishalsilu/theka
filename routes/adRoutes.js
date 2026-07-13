import express from "express";
import { 
    createAd, 
    getAds, 
    getAdById, 
    getSingleAd, // 1. Imported the new controller function
    updateAd, 
    deleteAd 
} from "../controllers/adController.js"; 

import upload from "../middleware/upload.middleware.js";
import { protect } from "../middleware/authMiddleware.js";
import { adminOnly } from "../middleware/adminMiddleware.js";

const router = express.Router();

// ==========================================
// AD ROUTES
// ==========================================

// Create a new Ad (Expects form-data with an 'image' file)
router.post("/", upload.single("image"), createAd);

// Get all Ads (Supports query filters like ?collectionId=... )
router.get("/", getAds);

// Get a single Ad by Collection & Category Names
// 💡 NOTE: This MUST sit above /:id so Express doesn't treat "single" as an ID parameter!
router.get("/single", getSingleAd);

// Get a single Ad by ID
router.get("/:id", getAdById);

// Update an Ad by ID (Expects form-data, image is optional)
router.put("/:id", protect, adminOnly, upload.single("image"), updateAd);

// Delete an Ad by ID
router.delete("/:id", protect, adminOnly, deleteAd);

export default router;