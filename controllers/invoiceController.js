import Invoice from '../models/Invoice.js';

const genInvoiceNumberUnique = async () => {
  for (let i = 0; i < 6; i += 1) {
    const datePart = new Date().toISOString().slice(0,10).replace(/-/g,'');
    const rand = Math.floor(1000 + Math.random() * 9000);
    const num = `INV-${datePart}-${rand}`;
    const exists = await Invoice.findOne({ invoiceNumber: num });
    if (!exists) return num;
  }
  return `INV-${Date.now()}`;
};

export const getInvoiceByOrderId = async (req, res) => {
  try {
    const { orderId } = req.params;
    const invoice = await Invoice.findOne({ orderId }).lean();
    if (!invoice) return res.status(404).json({ success: false, error: 'Invoice not found' });
    return res.status(200).json({ success: true, invoice });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

export const createInvoiceForOrder = async ({ order }) => {
  if (!order || !order.orderId) throw new Error('Order required');
  // If invoice already exists for order, return it
  const existing = await Invoice.findOne({ orderId: order.orderId }).lean();
  if (existing) return existing;

  const invoiceNumber = await genInvoiceNumberUnique();
  const invoice = await Invoice.create({
    invoiceNumber,
    orderId: order.orderId,
    amount: order.total || 0,
    currency: order.currency || 'INR',
    itemsSnapshot: order.items || [],
    billing: order.billingAddress || order.shippingAddress || {},
    shipping: order.shippingAddress || {},
    meta: {
      createdFromOrderId: order._id,
      customerId: order.userId,
      paymentMethod: order.paymentMethod,
      status: order.status,
      paymentDetails: order.paymentDetails || {}
    }
  });
  return invoice.toObject();
};
