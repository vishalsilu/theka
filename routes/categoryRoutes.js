import upload from "../middleware/upload.middleware.js";
import express from "express";
import {
    createCategory,
    getAllCategories,
    updateCategory,
    deleteCategory,
    getCollectionCategory,
    getDynamicFiltersByName
} from "../controllers/categoryController.js"; 

const router = express.Router();

router.post("/", upload.single('image'), createCategory);
router.get("/weartype/:collectionName/:categoryName", getDynamicFiltersByName);
router.get("/:collectionId", getCollectionCategory);

router.get("/", getAllCategories);



router.put("/:id", upload.single('image'),updateCategory);

router.delete("/:id", deleteCategory);

export default router;