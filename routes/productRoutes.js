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

router.post("/", protect, adminOnly, upload.array("images", 12), createProduct);
router.get("/featured", getFeaturedProducts);
router.get("/type/:type", getProductsByCollection);
router.get("/:type/:category", getProductsByCategory);
router.patch("/:id/sponsor", protect, adminOnly, setProductSponsorship);
router.put("/:id/status", protect, adminOnly, toggleProductStatus );
router.post("/:id/reviews", protect, upload.array("images", 5), addProductReview);
router.put("/:id", protect, adminOnly, upload.array("images", 12), updateProduct);
router.patch("/:id/reviews/:reviewId", protect, upload.array("images", 5), updateProductReview);
router.get("/:id", getSpecificProduct);
router.delete("/:id", protect, adminOnly, deleteProduct);
router.delete("/reviews/remove", protect, removeReview);
router.delete('/admin/reviews/remove', protect, adminOnly, removeReviewAdmin);


//Admin Routes
router.get("/", protect, adminOnly, getAllProducts);

export default router;