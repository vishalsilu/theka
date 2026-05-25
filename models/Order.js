import mongoose from "mongoose";

// Sub-schema for the specific review contents
const reviewDetailSchema = new mongoose.Schema({
  rating: { type: Number, min: 1, max: 5 },
  comment: { type: String, default: "" },
  images: { type: [String], default: [] },
  date: { type: Date }
}, { _id: false });

// Sub-schema for tracking review state on individual items
const orderItemReviewSchema = new mongoose.Schema({
  isReviewed: { type: Boolean, default: false },
  review: { type: reviewDetailSchema, default: () => ({}) }
}, { _id: false });

const orderItemSchema = new mongoose.Schema(
  {
    productId: { type: String, required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 1 },
    size: { type: String },
    type: { type: String },
    category: { type: String },
    variant: { type: String },
    images: [String],
    thumbnail: { type: String },
    
    // Evaluates defaults safely deep within the paths to avoid CastErrors
    reviewed: { 
      type: orderItemReviewSchema, 
      default: () => ({ isReviewed: false }) 
    }
  },
  { _id: false }
);

const addressSchema = new mongoose.Schema(
  {
    type: { type: String, default: "Home" },
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    street: { type: String, required: true },
    apartment: { type: String },
    address: { type: String, required: true },
    city: { type: String, required: true },
    state: { type: String, required: true },
    zip: { type: String, required: true },
    country: { type: String, default: "India" },
    mobile: { type: String, required: true }
  },
  { _id: false }
);

const trackingSchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    date: { type: String, required: true },
    location: { type: String }
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    orderId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    items: { type: [orderItemSchema], default: [] },
    subtotal: { type: Number, required: true, default: 0 },
    shipping: { type: Number, required: true, default: 0 },
    discount: { type: Number, required: true, default: 0 },
    tax: { type: Number, required: true, default: 0 },
    total: { type: Number, required: true, default: 0 },
    coupon: {
      code: { type: String },
      discountValue: { type: Number },
      type: { type: String }
    },
    paymentMethod: {
      type: String,
      enum: ["card", "upi", "cod"],
      default: "cod"
    },
    // Allow flexible status values (admin can add custom statuses like Booked, Reached, In Transit, etc.)
    status: {
      type: String,
      default: "Placed"
    },
    trackingId: { type: String },
    shippingAddress: { type: addressSchema, required: true },
    tracking: { type: [trackingSchema], default: [] }
    ,
    refunds: [{
      id: { type: String },
      amount: { type: Number },
      items: [{ productId: String, quantity: Number, restocked: Boolean }],
      adjustment: { type: Number },
      note: { type: String },
      createdBy: { type: String },
      createdAt: { type: String }
    }]
  },
  { timestamps: true }
);

const Order = mongoose.model("Order", orderSchema);
export default Order;