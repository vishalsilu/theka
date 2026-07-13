import upload from "../middleware/upload.middleware.js";
import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { adminOnly } from "../middleware/adminMiddleware.js";
import {
    createCategory,
    getAllCategories,
    updateCategory,
    deleteCategory,
    getCollectionCategory,
    getDynamicFiltersByName,
    categoryAdByPath
} from "../controllers/categoryController.js"; 

const router = express.Router();

// router.post("/", protect, adminOnly, upload.single('image'), createCategory);
router.post(
    "/", 
    protect, 
    adminOnly, 
    upload.fields([{ name: 'image', maxCount: 1 }, { name: 'ad', maxCount: 1 }]), 
    createCategory
);
router.get("/weartype/:collectionName/:categoryName", getDynamicFiltersByName);
router.get('/categoryad/:type/:category',categoryAdByPath)
router.get("/:collectionId", getCollectionCategory);


router.get("/", getAllCategories);


// Replace your existing routes with these:

router.put(
    "/:id", 
    protect, 
    adminOnly, 
    upload.fields([{ name: 'image', maxCount: 1 }, { name: 'ad', maxCount: 1 }]), 
    updateCategory
);

// router.put("/:id", protect, adminOnly, upload.single('image'), updateCategory);

router.delete("/:id", protect, adminOnly, deleteCategory);

export default router;