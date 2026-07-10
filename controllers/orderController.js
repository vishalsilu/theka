import Order from "../models/Order.js";
import User from "../models/Users.js";
import Product from "../models/Product.js";
import Coupon from "../models/Coupon.js";
import Invoice from "../models/Invoice.js";
import SiteData from "../models/SiteData.js";
import { evaluateCoupon } from "./couponController.js";
import axios from "axios"
import { redisClient } from "../config/redis.js";
import { razorpayInstance } from "../config/razorpay.js";
import { sendEmail } from "../config/email.js";

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

// const triggerDelhiveryShipment = async (order, address, items, paymentMode, siteData) => {
//   console.log(address)
//   const API_TOKEN = process.env.DELHIVERY_API_TOKEN; 
//   // Use 'https://staging-express.delhivery.com/api/cmu/create.json' for testing/sandbox
//   // const ENDPOINT = 'https://track.delhivery.com/api/cmu/create.json'; 
//   const ENDPOINT = 'https://staging-express.delhivery.com/api/cmu/create.json'; 

//   if (!API_TOKEN) {
//     throw new Error("Delhivery API token is missing from environment variables.");
//   }

//   // Compile individual product names into a readable shipping label description
//   const productDescription = items.map(i => `${i.name} (x${i.quantity})`).join(', ');

//   // Extract dynamic contact and address data from siteData
//   const contactInfo = siteData?.contact || {};
//   const siteAddress = contactInfo.address || {};
  
//   // Create a fallback-safe full address string
//   const fullSiteAddress = siteAddress.address || 
//     [siteAddress.appartment, siteAddress.street].filter(Boolean).join(', ') || 
//     process.env.DELHIVERY_PICKUP_ADDRESS || 
//     "Registered Store Address";

//   const rawPhone = address.phone || address.phoneNumber || address.mobile || contactInfo.phone ;
  
//   // Clean it up (removes spaces, +91, etc., keeping just the last 10 digits)
//   const customerPhone = String(rawPhone).replace(/\D/g, '').slice(-10);
//   const orderValue = Number(order.totalAmount || order.total || order.finalAmount || order.amount || 0);

//   if (paymentMode === 'COD' && orderValue <= 0) {
//     console.warn("Attempted COD Delhivery shipment with 0 amount. Delhivery will reject this.");
//   }

//   const userName=address.firstName + " " + address.lastName
//   const finalAddress = address.street + " " + address.apartment + " " + address.city + " " + address.state + address.zip + address.country

//   const payload = {
//     "shipments": [
//       {
//         "name": userName, 
//         "add": finalAddress,
//         "pin": String(address.pincode || address.zip), 
//         "city": address.city,
//         "state": address.state,
//         "country": "India",
//         "phone": customerPhone,
//         "order": order.orderId,
//         "payment_mode": paymentMode, // Must be exactly "COD" or "Prepaid"
        
//         // --- DYNAMIC RETURN ADDRESS ---
//         "return_add": fullSiteAddress,
//         "return_city": siteAddress.city,
//         "return_state": siteAddress.state,
//         "return_pin": siteAddress.pin, 
//         "return_phone": contactInfo.phone,
//         "return_country": "India",
        
//         "products_desc": productDescription, 
//         "total_amount": orderValue, 
//         "cod_amount": paymentMode === 'COD' ? orderValue : 0, 
//         "order_date": new Date().toISOString(),
//         "seller_name": siteData?.websiteName || "URBANROYALTY SURFACE", 
//         "seller_inv": `INV-${order.orderId}`,
//         "quantity": String(items.reduce((acc, curr) => acc + curr.quantity, 0)),
//         "waybill": "" // Left empty so Delhivery auto-assigns an AWB
//       }
//     ],
//     // --- EXACT REGISTERED PICKUP LOCATION ---
//     "pickup_location": {
//       "name": "URBANROYALTY SURFACE" // Must match your testing credential name exactly
//     }
//   };

//   // Build key-value URL parameters
//   const params = new URLSearchParams();
//   params.append('format', 'json');
//   params.append('data', JSON.stringify(payload));

//   const response = await axios.post(ENDPOINT, params.toString(), {
//     headers: {
//       'Authorization': `Token ${API_TOKEN}`,
//       'Content-Type': 'application/x-www-form-urlencoded'
//     }
//   });

//   if (response.data && response.data.success) {
//     // Return the generated waybill tracking number
//     return response.data.packages[0].waybill;
//   } else {
//     throw new Error(`Delhivery payload rejected: ${JSON.stringify(response.data)}`);
//   }
// };

export const createOrder = async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(200).json({ error: "Not authorized" });

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
      if (!product) return res.status(200).json({ error: `Product ${productId} not found` });

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

    const siteData = await SiteData.findOne({}).lean();
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
      if (couponCode) {
        await applyCouponUsage(couponCode, userId);
      }

      await reduceStockForOrder(enrichedItems);
      await clearUserCart(userId);

      // Cache Invalidation Flow
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


      // try {
      //   const waybill = await triggerDelhiveryShipment(order, shippingAddress, enrichedItems, "COD", siteData, totals);
      //   if (waybill) {
      //     order.awb = waybill;
      //     order.tracking.push({ status: "Waybill Generated", date: new Date(), location: "Delhivery" });
      //     await order.save();
      //   }
      // } catch (delhiveryError) {
      //   console.error("Non-fatal: Delhivery COD registration failed:", delhiveryError.message);
      // }
      
      // Create invoice record
      try {
        const { createInvoiceForOrder } = await import('./invoiceController.js');
        const invoice = await createInvoiceForOrder({ order });
        return res.status(201).json({ success: true, order, invoice, shipping: order.shipping });
      } catch (invErr) {
        console.warn('Invoice creation failed', invErr);
        return res.status(201).json({ success: true, order, shipping: order.shipping });
      }
    }

    return res.status(201).json({ success: true, order, shipping: order.shipping });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

export const finalizeRazorpayOrder = async ({ order, paymentDetails = {}, eventLabel = 'Payment Confirmed' }) => {
  if (!order || !order.orderId) throw new Error('Order is required for finalization');
  if (['completed', 'failed'].includes(order.paymentStatus)) return order;

  if (order.coupon?.code) {
    await applyCouponUsage(order.coupon.code, order.userId);
  }

  await reduceStockForOrder(order.items || []);
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


  // try {
  //   const siteData = await SiteData.findOne({}).lean();
    
  //   const waybill = await triggerDelhiveryShipment(
  //     updatedOrder, 
  //     updatedOrder.shippingAddress, 
  //     updatedOrder.items, 
  //     "Prepaid",
  //     siteData
  //   );
    
  //   if (waybill) {
  //     await Order.updateOne(
  //       { orderId: updatedOrder.orderId },
  //       { 
  //         $set: { awb: waybill },
  //         $push: { tracking: { status: "Waybill Generated", date: new Date(), location: "Delhivery" } }
  //       }
  //     );
  //     updatedOrder.awb = waybill; // Injects property into memory object for downstream invoice parsing
  //   }
  // } catch (delhiveryError) {
  //   console.error("Non-fatal: Delhivery Prepaid registration failed:", delhiveryError.message);
  // }

  try {
    const { createInvoiceForOrder } = await import('./invoiceController.js');
    await createInvoiceForOrder({ order: updatedOrder });
  } catch (invoiceErr) {
    console.warn('Invoice creation failed after Razorpay payment confirmation', invoiceErr?.message || invoiceErr);
  }

  return updatedOrder;
};

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
    if (!order) return res.status(200).json({ error: "Order not found" });

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
    if (!order) return res.status(200).json({ error: "Order not found" });

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
    if (!order) return res.status(200).json({ error: "Order not found" });

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

    if (!userId) return res.status(200).json({ error: "Not authorized" });

    // Fetch full document to leverage model mutations safely
    const order = await Order.findOne({ orderId });
    if (!order) return res.status(200).json({ error: "Order not found" });
    
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
    const { status, q, sortBy, sortOrder } = req.query; 
    const query = {};

    if (status && status !== "All") {
      query.status = status;
    }

    if (q) {
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
    return res.status(500).json({ error: error.message });
  }
};

export const updateOrderAdmin = async (req, res) => {
  try {
    const { orderId } = req.params;
    const patch = { ...req.body };
    const order = await Order.findOneAndUpdate({ orderId }, patch, { new: true });
    if (!order) return res.status(200).json({ error: "Order not found" });

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
    if (!deleted) return res.status(200).json({ error: "Order not found" });

    await redisClient.del(`order:detail:${orderId}`);
    await redisClient.del(`orders:user:${deleted.userId}`);

    return res.status(200).json({ success: true, message: "Order deleted" });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// --- ISSUE REFUND (ADMIN) ---
export const issueRefundAdmin = async (req, res) => {
  const OTP_TTL_SECONDS = 60 * 10; // 10 minutes
  try {
    const { orderId } = req.params;
    const { items = [], adjustment = 0, note = '', otp } = req.body;
    
    // Admin verification
    if (req.user?.role !== 'Admin') {
      return res.status(403).json({ error: 'Forbidden. Admin access required.' });
    }
    const adminEmail = req.user?.email;
    if (!adminEmail) return res.status(400).json({ error: 'Admin email not available for OTP.' });

    const order = await Order.findOne({ orderId });

    if (!order) return res.status(404).json({ error: 'Order not found' });
    var paymentId = order?.paymentDetails?.razorpayPaymentId

    // Unique Redis key per admin per order to prevent cross-contamination
    const redisKey = `refund:pending:${req.user.id}:${orderId}`;

    // ==========================================
    // PHASE 1: INITIATE REFUND & SEND OTP
    // ==========================================
    if (!otp) {
      // Calculate refund amount and map exact items for restocking
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
          restockOperations.push({ 
            productId, 
            quantity: line,
            variant: orderItem.variant,
            size: orderItem.size,
            name: orderItem.name 
          });
        }
      }

     
      refundAmount = refundAmount + Number(adjustment || 0);

      // Pre-flight checks before sending OTP
      if (refundAmount <= 0) {
        return res.status(400).json({ error: 'Refund amount must be greater than zero.' });
      }
      if (order.paymentMode !== 'COD' && !paymentId) {
        return res.status(400).json({ error: 'No Razorpay Payment ID found for this prepaid order.' });
      }

      // Generate 6-digit OTP
      const generatedOtp = String(Math.floor(100000 + Math.random() * 900000));

      // Store in Redis (cache the calculations so we don't recalculate on confirmation)
      const store = { 
        otp: generatedOtp, 
        payload: { items, adjustment, note }, 
        computed: { refundAmount, restockOperations },
        createdAt: Date.now() 
      };
      await redisClient.setEx(redisKey, OTP_TTL_SECONDS, JSON.stringify(store));

      // HTML Email UI for Refund Confirmation
      const subject = `URGENT: Confirm Refund for Order #${orderId}`;
      const html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e5e5; padding: 20px;">
          <h2 style="color: #dc2626;">Confirm Refund Request</h2>
          <p>An admin has requested a refund for <strong>Order #${orderId}</strong>. Please confirm this action using the OTP below.</p>
          
          <div style="background-color: #f3f4f6; padding: 15px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 5px; margin: 20px 0;">
            ${generatedOtp}
          </div>

          <h4 style="border-bottom: 1px solid #ccc; padding-bottom: 5px;">Refund Details</h4>
          <ul style="list-style: none; padding: 0;">
            <li style="margin-bottom: 8px;"><strong>Total Refund Amount:</strong> ₹${refundAmount}</li>
            <li style="margin-bottom: 8px;"><strong>Manual Adjustment:</strong> ₹${adjustment}</li>
            <li style="margin-bottom: 8px;"><strong>Reason / Note:</strong> ${note || 'None provided'}</li>
          </ul>

          <h4 style="border-bottom: 1px solid #ccc; padding-bottom: 5px;">Items to Restock</h4>
          <ul style="list-style: none; padding: 0;">
            ${restockOperations.length > 0 
              ? restockOperations.map(op => `<li>📦 ${op.name} (Variant: ${op.variant || 'N/A'}, Size: ${op.size || 'N/A'}) - <strong>Qty: ${op.quantity}</strong></li>`).join('') 
              : '<li>No items selected for restocking.</li>'}
          </ul>

          <p style="font-size: 12px; color: #6b7280; margin-top: 20px;">This OTP expires in 10 minutes. If you did not request this, please secure your admin account.</p>
        </div>
      `;

      const emailResult = await sendEmail({ to: adminEmail, subject, html });
      if (!emailResult?.success) {
        console.warn('Failed to send refund OTP email', emailResult);
        return res.status(202).json({ requiresOtp: true, message: 'OTP generated but email delivery failed. Check server logs.' });
      }

      // Tell frontend to show the OTP modal
      return res.status(200).json({ 
        requiresOtp: true, 
        message: 'OTP sent to admin email.',
        refundAmount // Pass amount back so frontend can show "Confirm refund of ₹X"
      });
    }

    // ==========================================
    // PHASE 2: VALIDATE OTP & PROCESS REFUND
    // ==========================================
    
    // Fetch cached data from Redis
    const cachedDataString = await redisClient.get(redisKey);
    if (!cachedDataString) {
      return res.status(400).json({ error: 'Refund request expired or not found. Please initiate the refund again.' });
    }

    const cachedData = JSON.parse(cachedDataString);

    // Validate OTP
    if (String(cachedData.otp) !== String(otp)) {
      return res.status(400).json({ error: 'Invalid OTP. Refund cancelled.' });
    }

    // Extract pre-calculated values securely from Redis
    const { refundAmount, restockOperations } = cachedData.computed;
    const { items: originalItems, adjustment: originalAdjustment, note: originalNote } = cachedData.payload;

    // Process Razorpay Refund (Skip if COD)
    let razorpayRefundId = null;
    
    if (order.paymentMode !== 'COD') {
      try {
        const refundResponse = await razorpayInstance.payments.refund(paymentId, {
          amount: Math.round(refundAmount * 100), // paise
          notes: {
            reason: originalNote || "Admin initiated refund",
            order_ref: order.orderId
          }
        });
        razorpayRefundId = refundResponse.id;
      } catch (rpError) {
        console.error("Razorpay Gateway Error:", rpError);
        return res.status(500).json({ 
          error: "Payment Gateway failed to process refund.", 
          details: rpError.error?.description || rpError.message 
        });
      }
    }

    // Create Database Refund Record
    const refundRecord = {
      id: razorpayRefundId || `RF-COD-${Date.now()}`,
      amount: refundAmount,
      items: originalItems.map(i => ({ 
        productId: i.productId, 
        quantity: Number(i.quantity || 0), 
        restocked: !!i.restock 
      })),
      adjustment: Number(originalAdjustment || 0),
      note: String(originalNote || ''),
      createdBy: req.user.id,
      createdAt: new Date().toISOString()
    };

    order.refunds = order.refunds || [];
    order.refunds.push(refundRecord);
    order.total = Math.max(0, Number(order.total || 0) - refundAmount);
    order.status = "Refunded"
    order.tracking.push({ 
      status: 'Refunded', 
      date: new Date().toISOString(), 
      location: originalNote || 'Refund processed' 
    });

    await order.save();

    // Restock Products (Exact Match Logic)
    for (const op of restockOperations) {
      try {
        const prod = await Product.findOne({ id: op.productId }); 
        if (!prod) continue;

        let stockUpdated = false;

        if (prod.variants && prod.variants.length > 0) {
          const targetVariant = prod.variants.find(v => v.name === op.variant || v.color === op.variant);
          if (targetVariant && targetVariant.sizes) {
            const targetSize = targetVariant.sizes.find(s => s.name === op.size || s.size === op.size);
            if (targetSize) {
              targetSize.stock = (targetSize.stock || 0) + op.quantity;
              stockUpdated = true;
            }
          }
        }

        if (stockUpdated) {
          await prod.save();
        } else {
          console.warn(`Could not find exact variant/size match to restock: ${op.variant} - ${op.size}`);
        }
      } catch (err) {
        console.warn('Failed to restock', op, err.message || err);
      }
    }

    // Cleanup and Invalidate Caches
    await redisClient.del(redisKey); // Remove OTP from cache so it can't be reused
    if (typeof redisClient !== 'undefined') {
      await redisClient.del(`order:detail:${orderId}`).catch(() => {});
      await redisClient.del(`orders:user:${order.userId}`).catch(() => {});
    }

    return res.status(200).json({ success: true, refund: refundRecord, order });

  } catch (error) {
    console.error('Refund controller error:', error);
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
    if (!order) return res.status(200).json({ error: 'Order not found' });
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
    if (!order) return res.status(200).json({ error: 'Order not found' });
    if (req.user?.role !== 'Admin') return res.status(403).json({ error: 'Forbidden' });

    const existing = (order.adjustments || []).find(a => a.id === adjId);
    if (!existing) return res.status(200).json({ error: 'Adjustment not found' });
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