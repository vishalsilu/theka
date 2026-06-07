import express from 'express';
import { protect } from '../middleware/authMiddleware.js';
import { adminOnly } from "../middleware/adminMiddleware.js";
import { createSubscriber, listSubscribers, sendOfferToSubscribers, checkSubscriber, deleteSubscriber, adminDeleteSubscriber } from '../controllers/subscriberController.js';

const router = express.Router();

router.post('/', createSubscriber);
router.get('/check', checkSubscriber);
router.delete('/', deleteSubscriber);
router.get('/admin', protect, adminOnly, listSubscribers);
router.post('/admin/send', protect, adminOnly, sendOfferToSubscribers);
router.delete('/admin/:id', protect, adminOnly, adminDeleteSubscriber);

export default router;
