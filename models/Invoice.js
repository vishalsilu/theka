import mongoose from 'mongoose';

const InvoiceSchema = new mongoose.Schema({
  invoiceNumber: { type: String, required: true, unique: true, immutable: true },
  orderId: { type: String, required: true, immutable: true, index: true },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'INR' },
  createdAt: { type: Date, default: Date.now, immutable: true },
  itemsSnapshot: { type: Array, default: [] },
  billing: { type: Object, default: {} },
  shipping: { type: Object, default: {} },
  meta: { type: Object, default: {} }
});

const Invoice = mongoose.model('Invoice', InvoiceSchema);
export default Invoice;
