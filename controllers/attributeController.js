import Attribute from '../models/Attribute.js';
import { redisClient } from '../config/redis.js'; // Ensure you import your configured Redis client

// Helper to generate consistent cache keys
const getCacheKey = (key) => `attributes:${key}`;

export const getAttributes = async (req, res) => {
  try {
    const { key } = req.params;
    const cacheKey = getCacheKey(key);

    // 1. Try to fetch from Redis Cache
    const cachedData = await redisClient.get(cacheKey);
    if (cachedData) {
      return res.status(200).json({ 
        success: true, 
        data: JSON.parse(cachedData), 
        fromCache: true // Nice for debugging!
      });
    }

    // 2. Cache Miss - Query MongoDB
    const items = await Attribute.find({ key }).sort({ name: 1 }).lean();

    // 3. Store results in Redis (Set to expire in 24 hours to prevent stale data indefinitely)
    // 86400 seconds = 24 hours
    await redisClient.setEx(cacheKey, 86400, JSON.stringify(items));

    res.status(200).json({ success: true, data: items });
  } catch (error) {
    console.error('Get attributes error', error);
    res.status(500).json({ error: error.message });
  }
};

export const createAttribute = async (req, res) => {
  try {
    const { key } = req.params;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Missing name' });

    const newAttr = new Attribute({ key, name });
    await newAttr.save();

    // Invalidate Cache for this specific key group
    await redisClient.del(getCacheKey(key));

    res.status(201).json({ success: true, data: newAttr });
  } catch (error) {
    console.error('Create attribute error', error);
    res.status(500).json({ error: error.message });
  }
};

export const updateAttribute = async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Missing name' });

    // We use findByIdAndUpdate, but we need the original document's 'key' to invalidate the right cache
    const updated = await Attribute.findByIdAndUpdate(id, { name }, { new: true });
    if (!updated) return res.status(200).json({ error: 'Not found' });

    // Invalidate Cache for this attribute group (e.g., 'attributes:color')
    await redisClient.del(getCacheKey(updated.key));

    res.status(200).json({ success: true, data: updated });
  } catch (error) {
    console.error('Update attribute error', error);
    res.status(500).json({ error: error.message });
  }
};

export const deleteAttribute = async (req, res) => {
  try {
    const { id } = req.params;
    
    // We need the document before deletion to find out which 'key' group it belonged to
    const deleted = await Attribute.findByIdAndDelete(id);
    if (!deleted) return res.status(200).json({ error: 'Not found' });

    // Invalidate Cache for this specific group
    await redisClient.del(getCacheKey(deleted.key));

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Delete attribute error', error);
    res.status(500).json({ error: error.message });
  }
};