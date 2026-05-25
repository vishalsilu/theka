import express from "express";
import upload from "../middleware/upload.middleware.js";
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
    .post(upload.single('image'), createCollection)
    .get(getAllCollections)

router.route("/:id")
    .get(getCollectionDetails)
    .put(upload.single('image'), updateCollection)
    .delete(deleteCollection);

router.patch("/:id/featured", toggleCollectionFeatured);


export default router;