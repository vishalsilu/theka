import express from 'express';
import { getCart, putCart, clearCart, logoutAndPreserveCart } from '../controllers/cartController.js';

const router = express.Router();

router.get('/', getCart);

router.put('/', putCart);

router.delete('/', clearCart);

router.post('/logout-preserve', logoutAndPreserveCart);

export default router;