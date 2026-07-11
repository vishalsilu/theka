import SiteData from "../models/SiteData.js";
import { redisClient } from "../config/redis.js";
import { deleteFromCloudinary } from "../config/cloudinary.js";
import { sendEmail } from "../config/email.js";

const SITE_DATA_CACHE_KEY = "siteData:root";

const isEmptySiteData = (siteData) => {
  return (
    siteData &&
    typeof siteData === 'object' &&
    !Array.isArray(siteData) &&
    Object.keys(siteData).length === 0
  );
};

const findOrCreateSiteData = async () => {
  const siteData = await SiteData.findOneAndUpdate(
    {},
    { $setOnInsert: {} },
    {
      upsert: true,
      returnDocument: 'after', // Fixed deprecation warning
      setDefaultsOnInsert: true,
    }
  );

  if (siteData) {
    return siteData;
  }

  return new SiteData().toObject();
};

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
    if (!cached) return null;

    const parsed = JSON.parse(cached);
    if (isEmptySiteData(parsed)) {
      try {
        await redisClient.del(SITE_DATA_CACHE_KEY);
      } catch (deleteError) {
        console.warn('Failed to delete stale site data cache:', deleteError?.message || deleteError);
      }
      return null;
    }

    return parsed;
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

    const siteData = await findOrCreateSiteData();
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

    const prevUrl = req.body.prevUrl || req.query.prevUrl;
    const imageUrl = file.secure_url || file.path || file.url || null;
    if (!imageUrl) {
      return res.status(500).json({ success: false, error: 'Unable to resolve uploaded image URL' });
    }

    if (prevUrl && prevUrl !== imageUrl) {
      try {
        await deleteFromCloudinary(prevUrl);
      } catch (deleteError) {
        console.warn('Failed to delete previous Cloudinary image:', deleteError?.message || deleteError);
      }
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

    // --- Schema Migration Failsafe ---
    // Clears out the legacy string address before attempting to save the new object structure
    await SiteData.updateOne(
      { "contact.address": { $type: "string" } }, 
      { $unset: { "contact.address": "" } }
    );

    const siteData = await SiteData.findOneAndUpdate(
      {},
      { $set: payload },
      { 
        upsert: true, 
        returnDocument: 'after', // Fixed deprecation warning
        setDefaultsOnInsert: true 
      }
    );

    if (!isEmptySiteData(siteData)) {
      await cacheSiteData(siteData);
    } else {
      if (redisClient.isOpen) {
        await redisClient.del(SITE_DATA_CACHE_KEY).catch(() => {});
      }
    }

    return res.status(200).json({ success: true, siteData });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

export const createSiteData = saveSiteData;

export const updateSiteData = async (req, res) => {
  try {
    // If an Admin is attempting to update, start OTP confirmation flow
    if (req.user?.role === 'Admin') {
      // Delegate to initiate flow which sends OTP instead of immediately applying
      return initiateSiteDataUpdate(req, res);
    }

    // Non-admin updates are applied immediately
    return await saveSiteData(req, res);
  } catch (err) {
    return res.status(500).json({ success: false, error: err?.message || String(err) });
  }
};

const OTP_TTL_SECONDS = 60 * 10; // 10 minutes

export const initiateSiteDataUpdate = async (req, res) => {
  try {
    if (req.user?.role !== 'Admin') return res.status(403).json({ success: false, error: 'Forbidden' });

    const payload = req.body;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length === 0) {
      return res.status(400).json({ success: false, error: 'Site data payload is required' });
    }

    const adminEmail = req.user?.email;
    if (!adminEmail) return res.status(400).json({ success: false, error: 'Admin email not available' });

    const prevSiteData = await findOrCreateSiteData();

    // Generate 6-digit OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));

    const redisKey = `siteData:pending:${req.user.id}`;
    const store = { otp, payload, prevSiteData, createdAt: Date.now() };
    await redisClient.setEx(redisKey, OTP_TTL_SECONDS, JSON.stringify(store));

    // Create human-friendly diffs (stringified, truncated)
    const safeString = (obj) => {
      try {
        return JSON.stringify(obj, null, 2).slice(0, 3000);
      } catch (e) { return String(obj).slice(0, 3000); }
    };

    const subject = 'Confirm Site Data Update — OTP Required';
    const html = `
      <p>You requested to update the main site data. Please confirm this change by entering the OTP below in the admin panel.</p>
      <p><strong>OTP:</strong> ${otp}</p>
      <h4>Previous Data (truncated)</h4>
      <pre style="white-space:pre-wrap;max-height:300px;overflow:auto">${safeString(prevSiteData)}</pre>
      <h4>Proposed New Data (truncated)</h4>
      <pre style="white-space:pre-wrap;max-height:300px;overflow:auto">${safeString(payload)}</pre>
      <p>This OTP will expire in 10 minutes. If you did not request this, ignore this email.</p>
    `;

    const emailResult = await sendEmail({ to: adminEmail, subject, html });
    if (!emailResult?.success) {
      console.warn('Failed to send OTP email', emailResult);
      // still keep the pending change in redis but notify client
      return res.status(202).json({ success: true, message: 'OTP generated but email delivery failed. Check server logs.' });
    }

    return res.status(200).json({ success: true, message: 'OTP sent to admin email' });
  } catch (error) {
    console.error('initiateSiteDataUpdate error', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

export const confirmSiteDataUpdate = async (req, res) => {
  try {
    if (req.user?.role !== 'Admin') return res.status(403).json({ success: false, error: 'Forbidden' });
    const { otp } = req.body || {};
    if (!otp) return res.status(400).json({ success: false, error: 'OTP is required' });

    const redisKey = `siteData:pending:${req.user.id}`;
    const raw = await redisClient.get(redisKey);
    if (!raw) return res.status(400).json({ success: false, error: 'No pending update found or it has expired' });

    let store;
    try { store = JSON.parse(raw); } catch (e) { store = null; }
    if (!store || String(store.otp) !== String(otp)) return res.status(400).json({ success: false, error: 'Invalid OTP' });

    const payload = store.payload || {};

    // --- Schema Migration Failsafe ---
    // Clears out the legacy string address before attempting to save the new object structure
    await SiteData.updateOne(
      { "contact.address": { $type: "string" } }, 
      { $unset: { "contact.address": "" } }
    );

    // Apply the payload
    const siteData = await SiteData.findOneAndUpdate(
      {}, 
      { $set: payload }, 
      { 
        upsert: true, 
        returnDocument: 'after', // Fixed deprecation warning
        setDefaultsOnInsert: true 
      }
    );

    if (!isEmptySiteData(siteData)) {
      await cacheSiteData(siteData);
    } else {
      if (redisClient.isOpen) await redisClient.del(SITE_DATA_CACHE_KEY).catch(() => {});
    }

    // remove pending key
    await redisClient.del(redisKey).catch(() => {});

    return res.status(200).json({ success: true, siteData, message: 'Site data updated successfully' });
  } catch (error) {
    console.error('confirmSiteDataUpdate error', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};