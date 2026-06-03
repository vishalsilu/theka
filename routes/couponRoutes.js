import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { adminOnly } from "../middleware/adminMiddleware.js";
import {
  createCoupon,
  deleteCouponAdmin,
  getCouponByIdAdmin,
  getCouponsAdmin,
  updateCouponAdmin,
  validateCoupon
} from "../controllers/couponController.js";

const router = express.Router();

router.get("/validate", protect, validateCoupon);

router.post("/admin",protect,adminOnly,  createCoupon);
router.get("/admin", protect, adminOnly, getCouponsAdmin);
router.get("/admin/:id", protect, adminOnly, getCouponByIdAdmin);
router.patch("/admin/:id", protect, adminOnly, updateCouponAdmin);
router.delete("/admin/:id", protect, adminOnly, deleteCouponAdmin);

export default router;

