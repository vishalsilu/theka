export const adminOnly = (req, res, next) => {
  // 1. Check if user exists
  if (!req.user) {
    return res.status(401).json({ error: "Not authorized: No user found" });
  }

  // 2. Normalize role check (handle case sensitivity)
  const userRole = String(req.user.role || '').toLowerCase();
  
  if (userRole !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }

  next();
};