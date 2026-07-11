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

import { protect , optionalProtect  } from '../middleware/authMiddleware.js';
import { adminOnly } from '../middleware/adminMiddleware.js';
// Import your new optional auth middleware here

const router = express.Router();

// ==========================================
// USER / GUEST ROUTES
// ==========================================

// Swapped 'protect' for 'optionalProtect' so guests can hit this endpoint
router.post('/user', optionalProtect, createSupportTicketUser);

// These still require a strict login because they fetch/alter account-specific data
router.get('/user', protect, getSupportTicketsUser);
router.get('/user/:ticketId', protect, getSupportTicketUser);
router.post('/user/:ticketId/reply', protect, replySupportTicketUser);

// ==========================================
// ADMIN ROUTES
// ==========================================
router.get('/admin', protect, adminOnly, getSupportTicketsAdmin);
router.get('/admin/:ticketId', protect, adminOnly, getSupportTicketAdmin);
router.patch('/admin/:ticketId', protect, adminOnly, updateSupportTicketStatusAdmin);
router.post('/admin/:ticketId/reply', protect, adminOnly, replySupportTicketAdmin);

export default router;