import Order from "../models/Order.js";
import User from "../models/Users.js";
import Product from "../models/Product.js";
import Coupon from "../models/Coupon.js";
import Invoice from "../models/Invoice.js";
import SiteData from "../models/SiteData.js";
import { evaluateCoupon } from "./couponController.js";
import { redisClient } from "../config/redis.js";
import { sendEmail } from "../config/email.js";
import generateOrderInvoiceHtml from "../utils/emailTemplates.js"
import { sendMyInvoice } from "../utils/sendMyInvoice.js";
// Adjust the path to wherever your SiteData model file lives

const today = () => new Date().toISOString().split("T")[0];

const normalizeItems = (items) => {
  if (!Array.isArray(items)) return [];

  return items
    .filter(Boolean)
    .slice(0, 100)
    .map((i) => ({
      productId: String(i.productId || i.id || i._id || ""),
      name: String(i.name || "Item"),
      price: Number(i.price) || 0,
      quantity: Math.max(1, Math.min(10, Number(i.quantity) || 1)),
      size: i.size ? String(i.size) : undefined,
      type: i.type ? String(i.type) : undefined,
      category: i.category ? String(i.category) : undefined,
      variant: i.variant ? String(i.variant) : undefined,
      images: Array.isArray(i.images) ? i.images.filter(Boolean).slice(0, 8) : [],
      thumbnail: i.thumbnail ? String(i.thumbnail) : undefined
    }))
    .filter((i) => i.productId && i.name);
};

const getShippingConfig = async () => {
  const siteData = await SiteData.findOne({}).lean();
  const rawCost = Number(siteData?.shipping?.defaultCost);
  const defaultCost = rawCost > 0 ? rawCost : 99;
  const freeShippingThreshold =
    typeof siteData?.shipping?.freeShippingThreshold === 'number' && siteData.shipping.freeShippingThreshold > 0
      ? siteData.shipping.freeShippingThreshold
      : Infinity;

  return { defaultCost, freeShippingThreshold };
};

const computeTotals = ({ items, coupon, shippingConfig }) => {
  const subtotal = items.reduce((acc, it) => acc + it.price * it.quantity, 0);

  let discount = Number(coupon?.discountValue || 0);
  discount = Math.max(0, Math.min(discount, subtotal));

  const afterDiscount = subtotal - discount;
  const shipping = coupon?.type === "shipping" || afterDiscount >= shippingConfig.freeShippingThreshold
    ? 0
    : shippingConfig.defaultCost;
  const tax = 0;
  const total = afterDiscount + shipping + tax;

  return { subtotal, discount, shipping, tax, total };
};

const generateOrderId = () => `ORD-${Math.floor(10000 + Math.random() * 90000)}`;

const applyCouponUsage = async (couponCode, userId) => {
  if (!couponCode) return;

  await Coupon.findOneAndUpdate(
    { code: couponCode },
    [
      {
        $set: {
          usedCount: { $add: ["$usedCount", 1] },
          usageBy: {
            $cond: [
              {
                $in: [userId, { $map: { input: "$usageBy", as: "u", in: "$$u.userId" } }]
              },
              {
                $map: {
                  input: "$usageBy",
                  as: "item",
                  in: {
                    $cond: [
                      { $eq: ["$$item.userId", userId] },
                      { userId: userId, count: { $add: ["$$item.count", 1] } },
                      "$$item"
                    ]
                  }
                }
              },
              { $concatArrays: ["$usageBy", [{ userId, count: 1 }]] }
            ]
          }
        }
      }
    ],
    { new: true, updatePipeline: true }
  ).catch(() => {});
};

const reduceStockForOrder = async (items) => {
  if (!Array.isArray(items)) return;

  for (const item of items) {
    try {
      await Product.updateOne(
        { id: item.productId },
        {
          $inc: {
            'variants.$[v].sizes.$[s].stock': -Number(item.quantity || 0),
            salesCount: Number(item.quantity || 0)
          }
        },
        {
          arrayFilters: [
            { 'v.id': Number(item.variantId) },
            { 's.size': String(item.size) }
          ]
        }
      );
    } catch (err) {
      console.warn('Failed to update product stock for', item.productId, err?.message || err);
    }
  }
};

const clearUserCart = async (userId) => {
  await redisClient.del(`cart:user:${userId}`).catch(() => {});
  await User.findOneAndUpdate({ id: userId }, { $set: { cart: [] } }).catch(() => {});
  await redisClient.del(`orders:user:${userId}`).catch(() => {});
};

export const finalizeRazorpayOrder = async ({ order, paymentDetails = {}, eventLabel = 'Payment Confirmed' }) => {
  if (!order || !order.orderId) throw new Error('Order is required for finalization');
  if (['completed', 'failed'].includes(order.paymentStatus)) return order;

  // Apply coupon usage only when Razorpay payment has truly completed.
  if (order.coupon?.code) {
    await applyCouponUsage(order.coupon.code, order.userId);
  }

  // Reduce stock and update product sales after payment success.
  await reduceStockForOrder(order.items || []);

  // Clear the user's cart and invalidate caches.
  await clearUserCart(order.userId);

  const updateFields = {
    paymentStatus: 'completed',
    paymentMethod: 'razorpay',
    status: 'Confirmed',
    isDraft: false,
    razorpayOrderId: paymentDetails.orderId,
    'paymentDetails.razorpayPaymentId': paymentDetails.paymentId,
    'paymentDetails.razorpayOrderId': paymentDetails.orderId,
    'paymentDetails.verifiedAt': paymentDetails.verifiedAt || new Date().toISOString(),
    'paymentDetails.webhookVerifiedAt': paymentDetails.webhookVerifiedAt || paymentDetails.webhookVerifiedAt,
    'paymentDetails.failedAt': paymentDetails.failedAt,
    'paymentDetails.failureReason': paymentDetails.failureReason,
  };

  const updatePayload = { $set: {}, $push: { tracking: { status: eventLabel, date: today(), location: paymentDetails.source || 'Razorpay' } } };
  Object.keys(updateFields).forEach((key) => {
    if (updateFields[key] !== undefined) updatePayload.$set[key] = updateFields[key];
  });

  const updatedOrder = await Order.findOneAndUpdate(
    { orderId: order.orderId },
    updatePayload,
    { new: true }
  ).lean();

  try {
    const { createInvoiceForOrder } = await import('./invoiceController.js');
    await createInvoiceForOrder({ order: updatedOrder });
  } catch (invoiceErr) {
    console.warn('Invoice creation failed after Razorpay payment confirmation', invoiceErr?.message || invoiceErr);
  }

  return updatedOrder;
};

// --- CREATE ORDER ---
// Add this import at the top of your file (adjust the path to your actual email utility)

export const createOrder = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authorized" });

    const clientItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!clientItems.length) return res.status(400).json({ error: "Cart is empty" });

    const enrichedItems = [];
    for (const clientItem of clientItems) {
      const productId = String(clientItem.productId || "").trim();
      const variantId = Number(clientItem.variantId || 0);
      const size = String(clientItem.size || "").trim();
      const quantity = Math.max(1, Math.min(10, Number(clientItem.quantity) || 1));

      if (!productId || !size || !variantId) {
        return res.status(400).json({ error: `Invalid item details` });
      }

      const product = await Product.findOne({ id: productId }).lean();
      if (!product) return res.status(404).json({ error: `Product ${productId} not found` });

      const variant = product.variants?.find(v => v.id === variantId);
      const sizeObj = variant?.sizes?.find(s => s.size === size);

      if (!sizeObj || sizeObj.stock < quantity) {
        return res.status(400).json({ 
          error: `${product.name} - ${size}: Only ${sizeObj?.stock || 0} in stock` 
        });
      }

      const thumbnail = variant?.images?.[0] || product.variants?.[0]?.images?.[0] || "";
      let salePrice = product.price || 0;
      const discValue = product.discount?.value || 0;
      const discType = product.discount?.type || 'none';

      if (discType === 'percentage' && discValue > 0) {
        salePrice = salePrice - (salePrice * (discValue / 100));
      } else if (discType === 'amount' && discValue > 0) {
        salePrice = Math.max(0, salePrice - discValue);
      }

      enrichedItems.push({
        productId,
        name: String(product.name || "Product"),
        price: Number(salePrice),
        quantity,
        size,
        variant: variant?.color || "Default",
        variantId: variant?.id,
        category: product.categoryInfo?.name || "Uncategorized",
        images: variant?.images || product.variants?.[0]?.images || [],
        thumbnail: String(thumbnail)
      });
    }

    // 🔥 FETCH SITE DATA ONCE 🔥
    const siteData = await SiteData.findOne({}).lean() || {};
    
    const paymentMethod = String(req.body?.paymentMethod || "cod").trim();
    const couponCode = String(req.body?.coupon?.code || "").trim().toUpperCase();

    const configuredOptions = Array.isArray(siteData?.payment?.paymentOptions)
      ? siteData.payment.paymentOptions.map((opt) => ({
          id: String(opt.id || '').trim(),
          enabled: opt.enabled !== false
        }))
      : [];

    const defaults = [
      { id: 'razorpay', enabled: siteData?.payment?.onlinePaymentEnabled !== false },
      { id: 'cod', enabled: siteData?.payment?.codEnabled !== false }
    ];

    const availableOptions = defaults.map((base) => {
      const saved = configuredOptions.find((opt) => opt.id === base.id);
      return {
        id: base.id,
        enabled: saved?.enabled !== undefined ? saved.enabled : base.enabled
      };
    });

    const enabledIds = new Set(availableOptions.filter((opt) => opt.enabled).map((opt) => opt.id));

    if (!enabledIds.has(paymentMethod)) {
      return res.status(400).json({ error: 'Selected payment method is not available. Please choose another payment option.' });
    }

    const isRazorpay = paymentMethod === 'razorpay';

    let shippingAddress = null;
    const user = await User.findOne({ id: userId }).lean();
    const addressId = req.body?.shippingAddressId;
    
    if (addressId) {
      shippingAddress = user?.addresses?.find(a => String(a._id) === String(addressId));
    }
    
    if (!shippingAddress) {
      shippingAddress = user?.addresses?.find((a) => a.isDefault === true);
    }

    if (!shippingAddress?.address) {
      return res.status(400).json({ error: "Valid shipping address is required" });
    }

    let coupon = null;
    if (couponCode) {
      const couponDoc = await Coupon.findOne({ code: couponCode });
      const subtotalForCoupon = enrichedItems.reduce((a, b) => a + b.price * b.quantity, 0);
      const couponCheck = evaluateCoupon(couponDoc, subtotalForCoupon, userId);
      if (!couponCheck.valid) return res.status(400).json({ error: couponCheck.message });
      
      coupon = { code: couponDoc.code, discountValue: couponCheck.discountAmount, type: couponDoc.type };
    }

    const shippingConfig = await getShippingConfig();
    const totals = computeTotals({ items: enrichedItems, coupon, shippingConfig });
    let orderId = generateOrderId();
    
    const order = await Order.create({
      orderId,
      userId,
      items: enrichedItems,
      ...totals,
      coupon,
      paymentMethod,
      status: isRazorpay ? "Pending Payment" : "Placed",
      shippingAddress,
      tracking: [{ status: isRazorpay ? "Payment Pending" : "Order Placed", date: today() }],
      isDraft: isRazorpay,
    });

    if (!isRazorpay) {
      // Update coupon usage (if any) BEFORE finalizing response
      if (couponCode) {
        await applyCouponUsage(couponCode, userId);
      }

      // REDUCE STOCK & INCREMENT SALES
      await reduceStockForOrder(enrichedItems);

      // CLEAR CART
      await clearUserCart(userId);

      // PRODUCT CACHE INVALIDATION
      try {
        const keysToDelete = new Set(["products:all", "products:featured"]);

        for (const item of enrichedItems) {
          try {
            const product = await Product.findOne({ id: item.productId }).lean();
            if (product) {
              keysToDelete.add(`product:detail:${product.id}`);
              keysToDelete.add(`product:detail:${product._id}`);

              const collectionName = product.collectionInfo?.name || '';
              const categoryName = product.categoryInfo?.name || '';
              const collectionId = String(product.collectionInfo?.id || product.collectionInfo?._id || '');
              const categoryId = String(product.categoryInfo?.id || product.categoryInfo?._id || '');

              if (collectionName && categoryName) {
                keysToDelete.add(`products:${collectionName.toLowerCase()}:${categoryName.toLowerCase()}:lite`);
              }
              if (collectionId) keysToDelete.add(`products:collection:${collectionId}`);
              if (categoryId) keysToDelete.add(`products:category:${categoryId}`);
              if (collectionName) keysToDelete.add(`collectionProducts:${collectionName.toLowerCase()}:lite`);
            }
          } catch (err) {
            console.warn('Failed to fetch product for cache invalidation', item.productId, err?.message || err);
          }
        }

        const keysArray = Array.from(keysToDelete).filter(Boolean);
        if (keysArray.length > 0) {
          await redisClient.del(...keysArray).catch(() => {});
        }

        try {
          for await (const key of redisClient.scanIterator({ MATCH: "products:*" })) {
            await redisClient.del(key).catch(() => {});
          }
          for await (const key of redisClient.scanIterator({ MATCH: "collectionProducts:*" })) {
            await redisClient.del(key).catch(() => {});
          }
        } catch (scanErr) {
          console.warn('Pattern-based cache sweep had issues', scanErr?.message || scanErr);
        }
      } catch (err) { console.warn("Cache invalidation error", err); }

      // Create invoice database record
      let invoice = null;
      try {
        const { createInvoiceForOrder } = await import('./invoiceController.js');
        invoice = await createInvoiceForOrder({ order });
      } catch (invErr) {
        console.warn('Invoice creation failed', invErr);
      }

      // 🔥 FIRE THE EMAIL HERE 🔥
      try {
        await sendMyInvoice(order.orderId)
      } catch (emailErr) {
        console.error("Non-fatal: Failed to send order confirmation email:", emailErr);
      }

      return res.status(201).json({ success: true, order, invoice, shipping: order.shipping });
    }

    return res.status(201).json({ success: true, order, shipping: order.shipping });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// --- GET MY ORDERS (WITH CACHING) ---
export const getMyOrders = async (req, res) => {
  try {
    const userId = req.user?.id;
    const cacheKey = `orders:user:${userId}`;

    const cached = await redisClient.get(cacheKey);
    if (cached) return res.status(200).json({ success: true, orders: JSON.parse(cached) });

    const query = { userId, isDraft: false };
    const orders = await Order.find(query).sort({ createdAt: -1 }).lean();
    await redisClient.setEx(cacheKey, 1800, JSON.stringify(orders)); // 30 min cache

    return res.status(200).json({ success: true, orders });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// --- GET ORDER BY ID (WITH CACHING) ---
export const getOrderById = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { orderId } = req.params;
    const shouldBypassCache = req.query.fresh === 'true';
    const cacheKey = `order:detail:${orderId}`;

    if (!shouldBypassCache) {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const order = JSON.parse(cached);
        if (order.userId !== userId && req.user?.role !== "Admin") return res.status(403).json({ error: "Forbidden" });
        return res.status(200).json({ success: true, order });
      }
    }

    const order = await Order.findOne({ orderId }).lean();
    if (!order) return res.status(404).json({ error: "Order not found" });

    // if (order.userId !== userId && req.user?.role !== "Admin") return res.status(403).json({ error: "Forbidden" });

    await redisClient.setEx(cacheKey, 3600, JSON.stringify(order)); // 1 hour cache
    return res.status(200).json({ success: true, order });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// --- UPDATE ORDER STATUS (WITH INVALIDATION) ---
export const updateOrderStatusAdmin = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { status, location } = req.body;
    
    const order = await Order.findOne({ orderId });
    if (!order) return res.status(404).json({ error: "Order not found" });

    order.status = status;
    order.tracking.push({ status, date: today(), location: location || "Updated by admin" });
    await order.save();

    // ✅ Invalidate caches
    await redisClient.del(`order:detail:${orderId}`);
    await redisClient.del(`orders:user:${order.userId}`);

    return res.status(200).json({ success: true, order });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// --- CANCEL ORDER (WITH INVALIDATION) ---
export const cancelOrder = async (req, res) => {
  try {
    const userId = req.user?.id;
    const { orderId } = req.params;

    const order = await Order.findOne({ orderId });
    if (!order) return res.status(404).json({ error: "Order not found" });

    if (order.userId !== userId && req.user?.role !== "Admin") return res.status(403).json({ error: "Forbidden" });
    if (order.status === "Delivered") return res.status(400).json({ error: "Cannot cancel delivered order" });

    order.status = "Cancelled";
    order.tracking.push({ status: "Cancelled", date: today() });
    await order.save();

    // ✅ Invalidate caches
    await redisClient.del(`order:detail:${orderId}`);
    await redisClient.del(`orders:user:${order.userId}`);

    return res.status(200).json({ success: true, order });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// --- SUBMIT REVIEWS FOR ORDER ITEMS ---
// import Product from "./Product.js"; // Ensure your Product model is imported here

export const submitOrderReviews = async (req, res) => {
  
  try {
    const userId = req.user?.id;
    const { orderId } = req.params;

    if (!userId) return res.status(401).json({ error: "Not authorized" });

    // Fetch full document to leverage model mutations safely
    const order = await Order.findOne({ orderId });
    if (!order) return res.status(404).json({ error: "Order not found" });
    
    if (order.userId !== userId && req.user?.role !== "Admin") return res.status(403).json({ error: "Forbidden" });
    if (order.status !== "Delivered") return res.status(400).json({ error: "Reviews are only allowed for delivered orders" });

    let reviewsPayload = [];
    try {
      reviewsPayload = JSON.parse(req.body.reviews || '[]');
    } catch (parseError) {
      return res.status(400).json({ error: "Invalid review payload" });
    }

    if (!Array.isArray(reviewsPayload) || reviewsPayload.length === 0) {
      return res.status(400).json({ error: "Please include at least one review" });
    }

    const orderProducts = order.items.map((item) => item.productId);
    

    // Dynamic extraction helper for multi-storage multer configs
    const getFileUrl = (file) => {
      if (!file) return '';
      return file.path || file.location || file.secure_url || file.url || '';
    };

    

    // Construct dictionary of array attachments matched to input order indices
    const groupedFiles = (req.files || []).reduce((acc, file) => {
      const key = file.fieldname;
      if (!acc[key]) acc[key] = [];
      const fileUrl = getFileUrl(file);
      if (fileUrl) acc[key].push(fileUrl);
      return acc;
    }, {});

    let orderUpdated = false;

    for (let index = 0; index < reviewsPayload.length; index += 1) {
      const review = reviewsPayload[index];
      if (!review || !review.productId || !review.rating) continue;
      if (!orderProducts.includes(String(review.productId))) continue;

      const product = await Product.findOne({ id: String(review.productId) });
      if (!product) continue;

      const uploadedImages = (groupedFiles[`images[${index}]`] || []).filter(Boolean);
      
      // 1. Append review details into the product catalog array
      product.reviews = product.reviews || [];
      product.reviews.push({
        user: `${req.user?.firstName || ''} ${req.user?.lastName || ''}`.trim() || req.user?.email || 'Anonymous',
        userId,
        orderId,
        productId: review.productId,
        variant: review.variant || '',
        title: review.title || '',
        comment: review.comment || '',
        images: uploadedImages,
        rating: Number(review.rating),
        date: new Date().toISOString().split('T')[0]
      });

      await product.save();

      // 2. Identify and safely mutate target item inside the subdocument array
      const orderItem = order.items.find(item => 
        String(item.productId) === String(review.productId) && 
        (!review.variant || item.variant === review.variant)
      );

      if (orderItem) {
        orderItem.set('reviewed', {
          isReviewed: true,
          review: {
            rating: Number(review.rating),
            comment: review.comment || '',
            images: uploadedImages,
            date: new Date()
          }
        });
        orderUpdated = true;
      }

      // 3. Clear relevant product layout cache blocks (both id and _id)
      const cacheKeys = [
        `product:detail:${product.id}`,
        `product:detail:${product._id}`,
        'products:all',
        'products:featured',
        `orders:user:${userId}`
      ];

      // Add collection/category list keys if available
      const collName = product.collectionInfo?.name ? String(product.collectionInfo.name).toLowerCase() : null;
      const catName = product.categoryInfo?.name ? String(product.categoryInfo.name).toLowerCase() : null;
      const collId = product.collectionInfo?.id || product.collectionInfo?._id || null;
      const catId = product.categoryInfo?.id || product.categoryInfo?._id || null;

      if (collName) cacheKeys.push(`collectionProducts:${collName}:lite`);
      if (collName && catName) cacheKeys.push(`products:${collName}:${catName}:lite`);
      if (collId) cacheKeys.push(`products:collection:${collId}`);
      if (catId) cacheKeys.push(`products:category:${catId}`);

      if (cacheKeys.length > 0 && typeof redisClient?.del === 'function') {
        try {
          await redisClient.del(...cacheKeys);
        } catch (err) {
          console.warn('Error deleting cache keys for review submission:', err?.message || err);
        }
      }

      // Additionally sweep list-style caches that may match dynamic filters
      try {
        for await (const key of redisClient.scanIterator({ MATCH: "products:*:*:lite" })) {
          await redisClient.del(key).catch(() => {});
        }
        for await (const key of redisClient.scanIterator({ MATCH: "collectionProducts:*" })) {
          await redisClient.del(key).catch(() => {});
        }
        for await (const key of redisClient.scanIterator({ MATCH: "products:category:*" })) {
          await redisClient.del(key).catch(() => {});
        }
      } catch (err) {
        console.warn('Error sweeping list caches after reviews:', err?.message || err);
      }
    }

    // 4. Force save modified subdocument state on the Order Document
    if (orderUpdated) {
      order.markModified('items');
      await order.save();
    }

    // 5. Bust context-wide order cache states
    if (typeof redisClient?.del === 'function') {
      await redisClient.del(`order:detail:${orderId}`, `orders:user:${userId}`);
    }
    

    return res.status(200).json({ success: true, message: "Reviews submitted successfully" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};



// --- REMAINING ADMIN CONTROLLERS ---
export const getAllOrdersAdmin = async (req, res) => {
  try {
    // 1. Removed 'includeDrafts' from req.query since we don't care anymore
    const { status, q, sortBy, sortOrder } = req.query; 
    const query = {};

    // 🔥 DELETED THE isDraft IF-STATEMENT HERE 🔥
    // Now MongoDB will pull all 16 orders, guaranteed.

    // 2. Handle Status 
    if (
      status && 
      status !== 'undefined' && 
      status !== 'null' && 
      status.trim().toLowerCase() !== "all"
    ) {
      query.status = status;
    }

    // 3. Handle Search 
    if (
      q && 
      q !== 'undefined' && 
      q !== 'null' && 
      String(q).trim() !== ""
    ) {
      const search = new RegExp(String(q).trim(), "i");
      
      query.$or = [
        { orderId: search },
        { paymentMethod: search },
        { status: search },
        { "shippingAddress.firstName": search },
        { "shippingAddress.lastName": search },
        { "shippingAddress.address": search },
        { "shippingAddress.city": search },
        { "shippingAddress.state": search },
        { "shippingAddress.zip": search },
        { "shippingAddress.mobile": search },
        { "items.name": search }
      ];
    }

    const field = sortBy === "total" ? "total" : "createdAt";
    const direction = sortOrder === "asc" ? 1 : -1;

    const orders = await Order.find(query).sort({ [field]: direction }).lean();

    return res.status(200).json({ success: true, orders });
  } catch (error) {
    console.error("Fetch orders error:", error);
    return res.status(500).json({ error: error.message });
  }
};

export const updateOrderAdmin = async (req, res) => {
  try {
    const { orderId } = req.params;
    const patch = { ...req.body };
    const order = await Order.findOneAndUpdate({ orderId }, patch, { new: true });
    if (!order) return res.status(404).json({ error: "Order not found" });

    await redisClient.del(`order:detail:${orderId}`);
    await redisClient.del(`orders:user:${order.userId}`);

    return res.status(200).json({ success: true, order });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

export const deleteOrderAdmin = async (req, res) => {
  try {
    const { orderId } = req.params;
    const deleted = await Order.findOneAndDelete({ orderId });
    if (!deleted) return res.status(404).json({ error: "Order not found" });

    await redisClient.del(`order:detail:${orderId}`);
    await redisClient.del(`orders:user:${deleted.userId}`);

    return res.status(200).json({ success: true, message: "Order deleted" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// --- ISSUE REFUND (ADMIN) ---
export const issueRefundAdmin = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { items = [], adjustment = 0, note = '', method = 'original' } = req.body;

    const order = await Order.findOne({ orderId });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Calculate refund amount from items
    let refundAmount = 0;
    const restockOperations = [];

    for (const it of items) {
      const productId = String(it.productId || '');
      const qty = Number(it.quantity || 0);
      if (!productId || qty <= 0) continue;

      const orderItem = order.items.find(o => String(o.productId) === productId);
      if (!orderItem) continue;

      const perUnit = Number(orderItem.price || 0);
      const line = Math.min(qty, orderItem.quantity || 0);
      refundAmount += perUnit * line;

      if (it.restock) {
        restockOperations.push({ productId, quantity: line });
      }
    }

    refundAmount = refundAmount + Number(adjustment || 0);

    // Create refund record
    const refundRecord = {
      id: `RF-${Date.now()}`,
      amount: refundAmount,
      items: items.map(i => ({ productId: i.productId, quantity: Number(i.quantity || 0), restocked: !!i.restock })),
      adjustment: Number(adjustment || 0),
      note: String(note || ''),
      createdBy: req.user?.id || 'admin',
      createdAt: new Date().toISOString()
    };

    order.refunds = order.refunds || [];
    order.refunds.push(refundRecord);

    // Adjust order totals: subtract refund amount from total (simple approach)
    order.total = Math.max(0, Number(order.total || 0) - refundAmount);

    // Push a tracking event
    order.tracking.push({ status: 'Refunded', date: new Date().toISOString(), location: note || 'Refund processed' });

    await order.save();

    // Optional: Restock products
    for (const op of restockOperations) {
      try {
        const prod = await Product.findOne({ id: op.productId });
        if (!prod) continue;
        // We conservatively add to first variant first size if present
        if (prod.variants && prod.variants.length > 0) {
          const variant = prod.variants[0];
          if (variant.sizes && variant.sizes.length > 0) {
            variant.sizes[0].stock = (variant.sizes[0].stock || 0) + Number(op.quantity || 0);
            await prod.save();
          }
        }
      } catch (err) {
        console.warn('Failed to restock', op, err.message || err);
      }
    }

    // Invalidate caches
    await redisClient.del(`order:detail:${orderId}`).catch(() => {});
    await redisClient.del(`orders:user:${order.userId}`).catch(() => {});

    return res.status(200).json({ success: true, refund: refundRecord, order });
  } catch (error) {
    console.error('Refund error', error);
    return res.status(500).json({ error: error.message });
  }
};

// --- CREATE ADMIN ADJUSTMENT ON ORDER ---
export const createAdjustmentAdmin = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { type, amount, items, note } = req.body;
    if (typeof amount !== 'number' && typeof amount !== 'string') return res.status(400).json({ error: 'Amount is required' });
    const amt = Number(amount);
    if (Number.isNaN(amt)) return res.status(400).json({ error: 'Invalid amount' });

    const order = await Order.findOne({ orderId });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (req.user?.role !== 'Admin') return res.status(403).json({ error: 'Forbidden' });

    const adjType = String(type || 'price');
    if (adjType === 'refund') {
      if (!note || String(note).trim().length < 5) return res.status(400).json({ error: 'Refunds require a note explaining reason' });
      if (amt >= 0) return res.status(400).json({ error: 'Refund amount must be negative' });
    }

    const adj = {
      id: `ADJ-${Date.now()}`,
      type: adjType,
      amount: amt,
      items: Array.isArray(items) ? items.map(i => ({ productId: String(i.productId || ''), quantity: Number(i.quantity || 0), priceDelta: Number(i.priceDelta || 0) })) : [],
      note: String(note || ''),
      createdBy: `${req.user?.firstName || ''} ${req.user?.lastName || ''}`.trim() || req.user?.id || 'admin',
      createdById: req.user?.id || null,
      createdAt: new Date().toISOString(),
      reversed: false
    };

    order.adjustments = order.adjustments || [];
    order.adjustments.push(adj);
    order.total = Number(order.total || 0) + amt;
    if (adj.type === 'price') {
      order.subtotal = Number(order.subtotal || 0) + amt;
    }

    await order.save();

    await redisClient.del(`order:detail:${orderId}`);
    await redisClient.del(`orders:user:${order.userId}`);

    return res.status(200).json({ success: true, order });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// --- REVERSE AN EXISTING ADJUSTMENT ---
export const reverseAdjustmentAdmin = async (req, res) => {
  try {
    const { orderId, adjId } = req.params;
    const order = await Order.findOne({ orderId });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (req.user?.role !== 'Admin') return res.status(403).json({ error: 'Forbidden' });

    const existing = (order.adjustments || []).find(a => a.id === adjId);
    if (!existing) return res.status(404).json({ error: 'Adjustment not found' });
    if (existing.reversed) return res.status(400).json({ error: 'Adjustment already reversed' });

    const reversal = {
      id: `ADJ-REV-${Date.now()}`,
      type: `reversal`,
      amount: -Number(existing.amount || 0),
      items: existing.items || [],
      note: `Reversal of ${existing.id} - ${existing.note || ''}`,
      createdBy: `${req.user?.firstName || ''} ${req.user?.lastName || ''}`.trim() || req.user?.id || 'admin',
      createdById: req.user?.id || null,
      createdAt: new Date().toISOString(),
      reversed: false
    };

    order.adjustments.push(reversal);
    existing.reversed = true;
    existing.reversedAt = new Date().toISOString();
    existing.reversedBy = `${req.user?.firstName || ''} ${req.user?.lastName || ''}`.trim() || req.user?.id || 'admin';
    existing.reversalId = reversal.id;

    order.total = Number(order.total || 0) + reversal.amount;
    if (existing.type === 'price') {
      order.subtotal = Number(order.subtotal || 0) + reversal.amount;
    }

    await order.save();

    await redisClient.del(`order:detail:${orderId}`);
    await redisClient.del(`orders:user:${order.userId}`);

    return res.status(200).json({ success: true, order });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};