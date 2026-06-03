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
    getDynamicFiltersByName
} from "../controllers/categoryController.js"; 

const router = express.Router();

router.post("/", protect, adminOnly, upload.single('image'), createCategory);
router.get("/weartype/:collectionName/:categoryName", getDynamicFiltersByName);
router.get("/:collectionId", getCollectionCategory);

router.get("/", getAllCategories);



router.put("/:id", protect, adminOnly, upload.single('image'), updateCategory);

router.delete("/:id", protect, adminOnly, deleteCategory);

export default router;