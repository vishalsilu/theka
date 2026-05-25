import express from "express";
import { protect } from "../middleware/authMiddleware.js";
import { adminOnly } from "../middleware/adminMiddleware.js";
import upload from "../config/cloudinary.js";
import {
  cancelOrder,
  createOrder,
  deleteOrderAdmin,
  getAllOrdersAdmin,
  getMyOrders,
  getOrderById,
  submitOrderReviews,
  updateOrderAdmin,
  updateOrderStatusAdmin,
  issueRefundAdmin
} from "../controllers/orderController.js";

const router = express.Router();

router.post("/", protect, createOrder);
router.get("/my", protect, getMyOrders);

router.get("/admin/all", getAllOrdersAdmin);
router.get("/admin/:orderId", getOrderById);
router.patch("/admin/:orderId", updateOrderAdmin);
router.patch("/admin/:orderId/status", updateOrderStatusAdmin);
router.post("/admin/:orderId/refund", issueRefundAdmin);
router.delete("/admin/:orderId", deleteOrderAdmin);

router.get("/:orderId", getOrderById);

router.patch("/:orderId/reviews", upload.any(), submitOrderReviews);
router.patch("/:orderId/cancel", cancelOrder);

export default router;

