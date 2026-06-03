import express from "express";
import { getAllUsersAdmin, getUserAdmin, updateUserAdmin, deleteUserAdmin } from "../controllers/userController.js";
import { protect } from "../middleware/authMiddleware.js";
import { adminOnly } from "../middleware/adminMiddleware.js";

const router = express.Router();

router.get("/all", protect, adminOnly, getAllUsersAdmin);
router.get("/:userId", protect, adminOnly, getUserAdmin);
router.patch("/:userId", protect, adminOnly, updateUserAdmin);
router.delete("/:userId", protect, adminOnly, deleteUserAdmin);

export default router;
