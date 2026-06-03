import express from "express";
import upload from "../config/cloudinary.js";
import {
  getSiteData,
  createSiteData,
  updateSiteData,
  uploadSiteDataImage,
} from "../controllers/siteDataController.js";
import { protect } from "../middleware/authMiddleware.js";
import { adminOnly } from "../middleware/adminMiddleware.js";

const router = express.Router();

router.get("/", getSiteData);
router.post("/", protect, adminOnly, createSiteData);
router.patch("/", protect, adminOnly, updateSiteData);
router.post("/upload", protect, adminOnly, upload.single('image'), uploadSiteDataImage);

export default router;
