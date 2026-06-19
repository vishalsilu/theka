import express from 'express';
import {
  getSupportTicketsAdmin,
  getSupportTicketAdmin,
  updateSupportTicketStatusAdmin,
  replySupportTicketAdmin,
  
  createSupportTicketUser,
  getSupportTicketsUser,
  getSupportTicketUser,
  replySupportTicketUser
} from '../controllers/supportController.js';

import { protect } from '../middleware/authMiddleware.js';
import { adminOnly } from '../middleware/adminMiddleware.js';

const router = express.Router();


router.post('/user', protect, createSupportTicketUser);
router.get('/user', protect, getSupportTicketsUser);
router.get('/user/:ticketId', protect, getSupportTicketUser);
router.post('/user/:ticketId/reply', protect, replySupportTicketUser);



router.get('/admin', protect, adminOnly, getSupportTicketsAdmin);
router.get('/admin/:ticketId', protect, adminOnly, getSupportTicketAdmin);
router.patch('/admin/:ticketId', protect, adminOnly, updateSupportTicketStatusAdmin);
router.post('/admin/:ticketId/reply', protect, adminOnly, replySupportTicketAdmin);

export default router;