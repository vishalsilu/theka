import mongoose from "mongoose";

const couponUsageSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    count: { type: Number, default: 0 }
  },
  { _id: false }
);

const couponSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },

    type: {
      type: String,
      enum: ["percentage", "amount", "shipping"],
      required: true
    },
    value: { type: Number, required: true, min: 0 },
    maxDiscount: { type: Number, default: null },
    minOrderValue: { type: Number, default: 0 },

    usageLimit: { type: Number, default: null },
    perUserLimit: { type: Number, default: null },
    usedCount: { type: Number, default: 0 },
    usageBy: { type: [couponUsageSchema], default: [] },

    startAt: { type: Date, default: null },
    endAt: { type: Date, default: null },
    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

couponSchema.index({ code: 1, isActive: 1 });

const Coupon = mongoose.model("Coupon", couponSchema);
export default Coupon;

