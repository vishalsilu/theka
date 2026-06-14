import Razorpay from "razorpay";
import dotenv from "dotenv";

// Ensure your environment variables are loaded
dotenv.config();

export const razorpayInstance = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});