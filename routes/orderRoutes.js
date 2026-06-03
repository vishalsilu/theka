import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { adminOnly } from "../middleware/adminMiddleware.js";
import upload from "../config/cloudinary.js";
import {
  cancelOrder,
  createOrder,
  createAdjustmentAdmin,
  deleteOrderAdmin,
  getAllOrdersAdmin,
  getMyOrders,
  getOrderById,
  reverseAdjustmentAdmin,
  submitOrderReviews,
  updateOrderAdmin,
  updateOrderStatusAdmin,
  issueRefundAdmin
} from "../controllers/orderController.js";

const router = express.Router();

router.post("/", protect, createOrder);
router.get("/my", protect, getMyOrders);

router.get("/admin/all", protect, adminOnly, getAllOrdersAdmin);
router.get("/admin/:orderId", protect, adminOnly, getOrderById);
router.patch("/admin/:orderId", protect, adminOnly, updateOrderAdmin);
router.patch("/admin/:orderId/status", protect, adminOnly, updateOrderStatusAdmin);
router.post("/admin/:orderId/refund", protect, adminOnly, issueRefundAdmin);
router.post('/admin/:orderId/adjustments', protect, adminOnly, createAdjustmentAdmin);
router.post('/admin/:orderId/adjustments/:adjId/reverse', protect, adminOnly, reverseAdjustmentAdmin);
router.delete("/admin/:orderId", protect, adminOnly, deleteOrderAdmin);

router.get("/:orderId", getOrderById);

router.patch("/:orderId/reviews", protect, upload.any(), submitOrderReviews);
router.patch("/:orderId/cancel", cancelOrder);

export default router;

