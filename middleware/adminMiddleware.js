export const adminOnly = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: "Not authorized" });
  if (req.user.role !== "Admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
};

