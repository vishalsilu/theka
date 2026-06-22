import Coupon from "../models/Coupon.js";

const now = () => new Date();

export const evaluateCoupon = (coupon, subtotal, userId) => {
  if (!coupon) return { valid: false, error: "Coupon not found" };
  if (!coupon.isActive) return { valid: false, error: "Coupon is inactive" };
  if (coupon.startAt && now() < new Date(coupon.startAt)) return { valid: false, error: "Coupon not started yet" };
  if (coupon.endAt && now() > new Date(coupon.endAt)) return { valid: false, error: "Coupon expired" };
  if (subtotal < (coupon.minOrderValue || 0)) {
    return { valid: false, error: `Minimum order ₹${coupon.minOrderValue} required` };
  }
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
    return { valid: false, error: "Coupon usage limit reached" };
  }

  if (userId && coupon.perUserLimit) {
    const usedByUser = coupon.usageBy?.find((u) => u.userId === userId)?.count || 0;
    if (usedByUser >= coupon.perUserLimit) {
      return { valid: false, error: "You already used this coupon maximum times" };
    }
  }

  let discountAmount = 0;
  if (coupon.type === "percentage") {
    discountAmount = subtotal * ((coupon.value || 0) / 100);
  } else if (coupon.type === "amount") {
    discountAmount = coupon.value || 0;
  } else if (coupon.type === "shipping") {
    discountAmount = 0;
  }

  if (coupon.maxDiscount && discountAmount > coupon.maxDiscount) {
    discountAmount = coupon.maxDiscount;
  }

  discountAmount = Math.max(0, Math.min(discountAmount, subtotal));

  return {
    valid: true,
    message: "Coupon applied",
    code: coupon.code,
    type: coupon.type,
    value: coupon.value,
    discountAmount
  };
};

export const validateCoupon = async (req, res) => {
  
  try {
    const code = String(req.query.code || "").trim().toUpperCase();
    const subtotal = Number(req.query.subtotal || 0);
    const userId = req.user?.id || null;

    if (!code) return res.status(400).json({ valid: false, error: "Coupon code is required" });
    if (subtotal < 0) return res.status(400).json({ valid: false, error: "Invalid subtotal" });

    const coupon = await Coupon.findOne({ code }).lean();
    const result = evaluateCoupon(coupon, subtotal, userId);
    return res.status(result.valid ? 200 : 400).json(result);
  } catch (error) {
    return res.status(500).json({ valid: false, error: error.message || "Validation failed" });
  }
};

export const createCoupon = async (req, res) => {
  try {
    const payload = {
      ...req.body,
      code: String(req.body?.code || "").toUpperCase().trim()
    };
    const coupon = await Coupon.create(payload);
    return res.status(201).json({ success: true, coupon });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to create coupon" });
  }
};

export const getCouponsAdmin = async (_req, res) => {
  try {
    const coupons = await Coupon.find({}).sort({ createdAt: -1 }).lean();
    return res.status(200).json({ success: true, coupons });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to fetch coupons" });
  }
};

export const getCouponByIdAdmin = async (req, res) => {
  try {
    const coupon = await Coupon.findById(req.params.id).lean();
    if (!coupon) return res.status(200).json({ error: "Coupon not found" });
    return res.status(200).json({ success: true, coupon });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to fetch coupon" });
  }
};

export const updateCouponAdmin = async (req, res) => {
  try {
    const patch = { ...req.body };
    if (patch.code) patch.code = String(patch.code).toUpperCase().trim();
    const coupon = await Coupon.findByIdAndUpdate(req.params.id, patch, { new: true, runValidators: true });
    if (!coupon) return res.status(200).json({ error: "Coupon not found" });
    return res.status(200).json({ success: true, coupon });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to update coupon" });
  }
};

export const deleteCouponAdmin = async (req, res) => {
  try {
    const deleted = await Coupon.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(200).json({ error: "Coupon not found" });
    return res.status(200).json({ success: true});
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to delete coupon" });
  }
};

