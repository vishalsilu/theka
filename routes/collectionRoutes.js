import express from "express";
import upload from "../middleware/upload.middleware.js";
import { protect } from "../middleware/authMiddleware.js";
import { adminOnly } from "../middleware/adminMiddleware.js";
import {
    createCollection,
    getAllCollections, 
    getCollectionDetails,
    updateCollection,
    deleteCollection,
    toggleCollectionFeatured,
    getFeaturedCollection
} from "../controllers/collectionController.js";

const router = express.Router();

router.get('/featured',getFeaturedCollection)
router.route("/")
    .post(protect, adminOnly, upload.single('image'), createCollection)
    .get(getAllCollections)

router.route("/:id")
    .get(getCollectionDetails)
    .put(protect, adminOnly, upload.single('image'), updateCollection)
    .delete(protect, adminOnly, deleteCollection);

router.patch("/:id/featured", protect, adminOnly, toggleCollectionFeatured);


export default router;