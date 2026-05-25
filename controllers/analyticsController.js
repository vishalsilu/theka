import Order from '../models/Order.js';
import Product from '../models/Product.js';
import { redisClient } from '../config/redis.js';

export const getAnalytics = async (req, res) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay);
    endOfDay.setDate(startOfDay.getDate() + 1);

    // Delivered revenue only
    const deliveredMatch = { status: /delivered/i };
    const deliveredOrders = await Order.countDocuments(deliveredMatch);
    const deliveredRevenueAgg = await Order.aggregate([
      { $match: deliveredMatch },
      { $group: { _id: null, total: { $sum: '$total' } } }
    ]);
    const totalRevenue = (deliveredRevenueAgg[0] && deliveredRevenueAgg[0].total) || 0;

    const ordersToday = await Order.countDocuments({ createdAt: { $gte: startOfDay, $lt: endOfDay } });
    const totalOrders = await Order.countDocuments();
    const avgOrderValue = deliveredOrders ? +(totalRevenue / deliveredOrders).toFixed(2) : 0;

    const recentOrders = await Order.find().sort({ createdAt: -1 }).limit(8).lean();

    const topProducts = await Product.find().sort({ salesCount: -1 }).limit(6).select('id name salesCount price').lean();

    const rawLowStock = await Product.find({ 'variants.sizes.stock': { $lte: 5 } }).limit(8).select('id name variants').lean();
    const lowStock = rawLowStock.map((product) => {
      const lowVariants = (product.variants || []).flatMap((variant) =>
        (variant.sizes || [])
          .filter((size) => size.stock <= 5)
          .map((size) => ({ variant: variant.color || variant.id, size: size.size || 'N/A', stock: size.stock }))
      );
      return { id: product.id || product._id, name: product.name, alerts: lowVariants };
    });

    const today = new Date();
    const chartRange = Array.from({ length: 7 }).map((_, index) => {
      const date = new Date(startOfDay);
      date.setDate(startOfDay.getDate() - (6 - index));
      const label = date.toLocaleDateString('en-IN', { weekday: 'short' });
      return { date, label, revenue: 0 };
    });

    const chartAgg = await Order.aggregate([
      { $match: deliveredMatch },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' }
          },
          total: { $sum: '$total' }
        }
      }
    ]);

    const chart = chartRange.map((entry) => {
      const match = chartAgg.find((group) => {
        const d = new Date(group._id.year, group._id.month - 1, group._id.day);
        return d.toDateString() === entry.date.toDateString();
      });
      return { day: entry.label, gross: Math.min(100, Math.round((match?.total || 0) / 1000)), profit: Math.min(100, Math.round((match?.total || 0) / 1500)), amount: match?.total || 0 };
    });

    return res.status(200).json({
      success: true,
      data: {
        totalOrders,
        deliveredOrders,
        totalRevenue,
        ordersToday,
        avgOrderValue,
        recentOrders,
        topProducts,
        lowStock,
        chart
      }
    });
  } catch (err) {
    console.error('Analytics error', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
