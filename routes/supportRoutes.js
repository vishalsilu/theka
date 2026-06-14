import express from 'express';
import {
  getSupportTicketsAdmin,
  getSupportTicketAdmin,
  updateSupportTicketStatusAdmin,
  replySupportTicketAdmin
} from '../controllers/supportController.js';
import { protect } from '../middleware/authMiddleware.js';
import { adminOnly } from '../middleware/adminMiddleware.js';

const router = express.Router();

router.get('/admin', protect, adminOnly, getSupportTicketsAdmin);
router.get('/admin/:ticketId', protect, adminOnly, getSupportTicketAdmin);
router.patch('/admin/:ticketId', protect, adminOnly, updateSupportTicketStatusAdmin);
router.post('/admin/:ticketId/reply', protect, adminOnly, replySupportTicketAdmin);

export default router;
