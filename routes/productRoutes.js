import express from "express";
import upload from "../middleware/upload.middleware.js";
import {
    createProduct,
    getFeaturedProducts,
    getProductsByCategory,
    setProductSponsorship,
    updateProduct,
    deleteProduct,
    getSpecificProduct,
    getProductsByCollection,
    addProductReview,
    updateProductReview,
    removeReview,
    removeReviewAdmin,
    getAllProducts,
    toggleProductStatus
} from "../controllers/productController.js";
import { protect } from "../middleware/authMiddleware.js";
import { adminOnly } from "../middleware/adminMiddleware.js";

const router = express.Router();

// ==========================================
// 1. STATIC & COLLECTION ROUTES (NO :id)
// ==========================================

// Global Product Routes
router.get("/", protect, adminOnly, getAllProducts);
router.post("/", protect, adminOnly, upload.array("images", 12), createProduct);

// Featured & Categorization
router.get("/featured", getFeaturedProducts);
router.get("/type/:type", getProductsByCollection);
router.get("/:type/:category", getProductsByCategory);

// Global Review Deletion (Must be above /:id routes)
router.delete("/reviews/remove", protect, removeReview);
router.delete("/admin/reviews/remove", protect, adminOnly, removeReviewAdmin);

// ==========================================
// 2. DYNAMIC ID ROUTES (HAS :id)
// ==========================================

// Product Specific Actions
router.get("/:id", getSpecificProduct);
router.put("/:id", protect, adminOnly, upload.array("images", 12), updateProduct);
router.delete("/:id", protect, adminOnly, deleteProduct);

// Product Status & Sponsorship
router.patch("/:id/sponsor", protect, adminOnly, setProductSponsorship);
router.put("/:id/status", protect, adminOnly, toggleProductStatus);

// Product Reviews specific to an ID
router.post("/:id/reviews", protect, upload.array("images", 5), addProductReview);
router.patch("/:id/reviews/:reviewId", protect, upload.array("images", 5), updateProductReview);

export default router;