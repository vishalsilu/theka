import express from "express";
import { getAllUsersAdmin, getUserAdmin, updateUserAdmin, deleteUserAdmin } from "../controllers/userController.js";

const router = express.Router();

router.get("/all", getAllUsersAdmin);
router.get("/:userId", getUserAdmin);
router.patch("/:userId", updateUserAdmin);
router.delete("/:userId", deleteUserAdmin);

export default router;
