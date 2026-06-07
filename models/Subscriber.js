import mongoose from 'mongoose';

const subscriberSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  subscribedAt: { type: String, default: () => new Date().toISOString() },
  source: { type: String, default: 'website' },
  confirmed: { type: Boolean, default: true }
}, { timestamps: true });

const Subscriber = mongoose.model('Subscriber', subscriberSchema);
export default Subscriber;
