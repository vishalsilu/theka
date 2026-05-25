import SiteData from "../models/SiteData.js";
import { redisClient } from "../config/redis.js";

const SITE_DATA_CACHE_KEY = "siteData:root";

const findSiteData = () => SiteData.findOne();

const cacheSiteData = async (siteData) => {
  try {
    if (!redisClient.isOpen) return;
    await redisClient.set(SITE_DATA_CACHE_KEY, JSON.stringify(siteData), {
      EX: 3600,
    });
  } catch (error) {
    console.error("Failed to cache site data:", error);
  }
};

const getCachedSiteData = async () => {
  try {
    if (!redisClient.isOpen) return null;
    const cached = await redisClient.get(SITE_DATA_CACHE_KEY);
    return cached ? JSON.parse(cached) : null;
    console.log();
    
  } catch (error) {
    console.error("Failed to read site data from Redis:", error);
    return null;
  }
};

export const getSiteData = async (req, res) => {
  try {
    const cached = await getCachedSiteData();
    if (cached) {
      return res.status(200).json({ success: true, siteData: cached, source: "cache" });
    }

    const siteData = await findSiteData();
    const responseData = siteData ?? {};

    await cacheSiteData(responseData);
    return res.status(200).json({ success: true, siteData: responseData, source: "db" });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

export const uploadSiteDataImage = async (req, res) => {
  try {
    const file = req.file;
    if (!file) {
      return res.status(400).json({ success: false, error: 'Image file is required' });
    }

    const imageUrl = file.secure_url || file.path || file.url || null;
    if (!imageUrl) {
      return res.status(500).json({ success: false, error: 'Unable to resolve uploaded image URL' });
    }

    return res.status(200).json({ success: true, url: imageUrl });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

const saveSiteData = async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || Object.keys(payload).length === 0) {
      return res.status(400).json({ success: false, error: "Site data payload is required" });
    }

    const siteData = await SiteData.findOneAndUpdate(
      {},
      { $set: payload },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await cacheSiteData(siteData);
    return res.status(200).json({ success: true, siteData });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

export const createSiteData = saveSiteData;
export const updateSiteData = saveSiteData;
