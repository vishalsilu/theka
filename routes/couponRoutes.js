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

router.post("/admin",  createCoupon);
router.get("/admin",  getCouponsAdmin);
router.get("/admin/:id",  getCouponByIdAdmin);
router.patch("/admin/:id",  updateCouponAdmin);
router.delete("/admin/:id",  deleteCouponAdmin);

export default router;

