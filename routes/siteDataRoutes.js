import express from "express";
import upload from "../config/cloudinary.js";
import {
  getSiteData,
  createSiteData,
  updateSiteData,
  uploadSiteDataImage,
} from "../controllers/siteDataController.js";

const router = express.Router();

router.get("/", getSiteData);
router.post("/", createSiteData);
router.patch("/", updateSiteData);
router.post("/upload", upload.single('image'), uploadSiteDataImage);

export default router;
