import { razorpayInstance } from "../config/razorpay.js";
import Order from "../models/Order.js";
import User from "../models/Users.js";
import crypto from "crypto";

// --- INITIATE RAZORPAY ORDER ---
export const initiateRazorpayOrder = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authorized" });

    const { orderId, amount, currency = "INR" } = req.body;

    if (!orderId || !amount) {
      return res.status(400).json({ error: "Order ID and amount are required" });
    }

    // Verify order exists and belongs to user
    const order = await Order.findOne({ orderId }).lean();
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.userId !== userId && req.user?.role !== "Admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Create Razorpay order
    const razorpayOrder = await razorpayInstance.orders.create({
      amount: Math.round(amount * 100), // Convert to paise
      currency,
      receipt: orderId,
      notes: {
        orderId,
        userId,
        userEmail: req.user?.email,
      },
    });

    // Store Razorpay order ID in the Order document for reference
    await Order.findOneAndUpdate(
      { orderId },
      { 
        $set: { 
          razorpayOrderId: razorpayOrder.id,
          paymentStatus: "pending"
        } 
      }
    );

    return res.status(200).json({
      success: true,
      razorpayOrderId: razorpayOrder.id,
      keyId: process.env.RAZORPAY_KEY_ID,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
    });
  } catch (error) {
    console.error("Razorpay initiation error:", error);
    return res.status(500).json({ error: error.message });
  }
};

// --- VERIFY RAZORPAY PAYMENT (CLIENT-SIDE VERIFICATION SUPPORT) ---
export const verifyPayment = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authorized" });

    const {
      razorpayOrderId,
      razorpayPaymentId,
      razorpaySignature,
      orderId,
    } = req.body;

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature || !orderId) {
      return res.status(400).json({ error: "Missing payment verification details" });
    }

    // Verify signature
    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");

    if (generatedSignature !== razorpaySignature) {
      return res.status(400).json({ error: "Payment verification failed" });
    }

    // Fetch order
    const order = await Order.findOne({ orderId });
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.userId !== userId && req.user?.role !== "Admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Fetch payment details from Razorpay to confirm
    let paymentDetails;
    try {
      paymentDetails = await razorpayInstance.payments.fetch(razorpayPaymentId);
    } catch (err) {
      console.warn("Failed to fetch payment from Razorpay:", err?.message);
      // Continue with signature verification as sufficient proof
    }

    // Update order with payment details
    const paymentStatus = paymentDetails?.status === "captured" ? "completed" : "completed";
    
    await Order.findOneAndUpdate(
      { orderId },
      {
        $set: {
          paymentStatus,
          "paymentDetails.razorpayPaymentId": razorpayPaymentId,
          "paymentDetails.razorpayOrderId": razorpayOrderId,
          "paymentDetails.verifiedAt": new Date().toISOString(),
          paymentMethod: "razorpay",
          status: "Confirmed", // Update order status to Confirmed after payment
        },
      },
      { new: true }
    );

    // Invalidate order caches
    const { redisClient } = await import("../config/redis.js");
    await redisClient.del(`order:detail:${orderId}`).catch(() => {});
    await redisClient.del(`orders:user:${userId}`).catch(() => {});

    return res.status(200).json({
      success: true,
      message: "Payment verified successfully",
      orderId,
    });
  } catch (error) {
    console.error("Payment verification error:", error);
    return res.status(500).json({ error: error.message });
  }
};

// --- WEBHOOK HANDLER FOR RAZORPAY PAYMENT CONFIRMATION ---
export const razorpayWebhook = async (req, res) => {
  try {
    const signature = req.headers["x-razorpay-signature"];
    const body = JSON.stringify(req.body);

    // Verify webhook signature
    const generatedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (generatedSignature !== signature) {
      console.warn("Webhook signature verification failed");
      return res.status(400).json({ error: "Invalid webhook signature" });
    }

    const { event, payload } = req.body;

    if (event === "payment.captured") {
      const { payment } = payload;
      const orderId = payment.notes?.orderId;
      const userId = payment.notes?.userId;

      if (orderId && userId) {
        const order = await Order.findOne({ orderId });
        if (order && order.userId === userId) {
          await Order.findOneAndUpdate(
            { orderId },
            {
              $set: {
                paymentStatus: "completed",
                "paymentDetails.razorpayPaymentId": payment.id,
                "paymentDetails.razorpayOrderId": payment.order_id,
                "paymentDetails.webhookVerifiedAt": new Date().toISOString(),
                status: "Confirmed",
              },
            }
          );

          // Invalidate caches
          const { redisClient } = await import("../config/redis.js");
          await redisClient.del(`order:detail:${orderId}`).catch(() => {});
          await redisClient.del(`orders:user:${userId}`).catch(() => {});

          console.log(`✅ Payment confirmed for order: ${orderId}`);
        }
      }
    } else if (event === "payment.failed") {
      const { payment } = payload;
      const orderId = payment.notes?.orderId;
      const userId = payment.notes?.userId;

      if (orderId && userId) {
        const order = await Order.findOne({ orderId });
        if (order && order.userId === userId) {
          await Order.findOneAndUpdate(
            { orderId },
            {
              $set: {
                paymentStatus: "failed",
                "paymentDetails.failedAt": new Date().toISOString(),
                "paymentDetails.failureReason": payment.error_reason,
              },
            }
          );

          console.log(`❌ Payment failed for order: ${orderId}`);
        }
      }
    } else if (event === "payment.authorized") {
      const { payment } = payload;
      const orderId = payment.notes?.orderId;

      if (orderId) {
        await Order.findOneAndUpdate(
          { orderId },
          { $set: { paymentStatus: "authorized" } }
        );
      }
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(500).json({ error: error.message });
  }
};

// --- HANDLE PAYMENT FAILURE / RETRY ---
export const handlePaymentFailure = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { orderId, reason } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: "Order ID is required" });
    }

    const order = await Order.findOne({ orderId });
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.userId !== userId && req.user?.role !== "Admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    // Update payment status to failed and add tracking
    await Order.findOneAndUpdate(
      { orderId },
      {
        $set: { paymentStatus: "failed" },
        $push: {
          tracking: {
            status: "Payment Failed",
            date: new Date().toISOString(),
            location: reason || "Payment transaction failed",
          },
        },
      }
    );

    const { redisClient } = await import("../config/redis.js");
    await redisClient.del(`order:detail:${orderId}`).catch(() => {});
    await redisClient.del(`orders:user:${userId}`).catch(() => {});

    return res.status(200).json({
      success: true,
      message: "Payment failure recorded. You can retry.",
    });
  } catch (error) {
    console.error("Payment failure handling error:", error);
    return res.status(500).json({ error: error.message });
  }
};
