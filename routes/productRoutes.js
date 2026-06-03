import express from "express";
import upload from "../middleware/upload.middleware.js";
import {
    createProduct,
    getFeaturedProducts,
    getProductsByCategory,
    updateProduct,
    deleteProduct,
    getSpecificProduct,
    getProductsByCollection,
    addProductReview,
    updateProductReview,
    removeReview,
    removeReviewAdmin,
    getAllProducts
} from "../controllers/productController.js";
import { protect } from "../middleware/authMiddleware.js";
import { adminOnly } from "../middleware/adminMiddleware.js";

const router = express.Router();

router.post("/", upload.array("images", 12), createProduct);
router.get("/featured", getFeaturedProducts);
router.get("/type/:type", getProductsByCollection);
router.get("/:type/:category", getProductsByCategory);
router.put("/:id", upload.array("images", 12), updateProduct);
router.post("/:id/reviews", protect, upload.array("images", 5), addProductReview);
router.patch("/:id/reviews/:reviewId", protect, upload.array("images", 5), updateProductReview);
router.get("/:id", getSpecificProduct);
router.delete("/:id", deleteProduct);
router.delete("/reviews/remove", protect, removeReview);
router.delete('/admin/reviews/remove', protect, adminOnly, removeReviewAdmin);


//Admin Routes
router.get("/" , getAllProducts)

export default router;