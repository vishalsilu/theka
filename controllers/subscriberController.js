import Subscriber from '../models/Subscriber.js';
import { sendEmail } from '../config/email.js';

export const createSubscriber = async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ success: false, error: 'Email is required' });

    const existing = await Subscriber.findOne({ email }).lean();
    if (existing) return res.status(200).json({ success: true, subscriber: existing, message: 'Already subscribed' });

    const subscriber = await Subscriber.create({ email, source: req.body?.source || 'website' });
    return res.status(201).json({ success: true, subscriber });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

export const listSubscribers = async (req, res) => {
  try {
    const subs = await Subscriber.find({}).sort({ createdAt: -1 }).lean();
    return res.status(200).json({ success: true, subscribers: subs });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

export const sendOfferToSubscribers = async (req, res) => {
  try {
    const { subject, html } = req.body;
    if (!subject || !html) return res.status(400).json({ success: false, error: 'subject and html are required' });

    const subs = await Subscriber.find({}).lean();
    const emails = subs.map(s => s.email).filter(Boolean);

    // Send in simple loop (could be batched / queued in production)
    const results = [];
    for (const to of emails) {
      // eslint-disable-next-line no-await-in-loop
      const r = await sendEmail({ to, subject, html });
      results.push({ to, ...r });
    }

    return res.status(200).json({ success: true, sent: results.length, results });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

export const checkSubscriber = async (req, res) => {
  try {
    const email = String(req.query?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ success: false, error: 'email query required' });
    const existing = await Subscriber.findOne({ email }).lean();
    return res.status(200).json({ success: true, subscribed: !!existing, subscriber: existing || null });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

export const deleteSubscriber = async (req, res) => {
  try {
    const email = String(req.body?.email || req.query?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ success: false, error: 'email required' });
    const removed = await Subscriber.findOneAndDelete({ email });
    if (!removed) return res.status(404).json({ success: false, error: 'not found' });
    return res.status(200).json({ success: true, deleted: removed });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

export const adminDeleteSubscriber = async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ success: false, error: 'id required' });
    const removed = await Subscriber.findByIdAndDelete(id);
    if (!removed) return res.status(404).json({ success: false, error: 'not found' });
    return res.status(200).json({ success: true, deleted: removed });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};
