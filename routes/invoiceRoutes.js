import express from 'express';
import { getInvoiceByOrderId } from '../controllers/invoiceController.js';

const router = express.Router();

router.get('/order/:orderId', getInvoiceByOrderId);

export default router;
