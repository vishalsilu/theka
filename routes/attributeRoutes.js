import express from 'express';
import { getAttributes, createAttribute, updateAttribute, deleteAttribute } from '../controllers/attributeController.js';
import { protect } from '../middleware/authMiddleware.js';
import { adminOnly } from '../middleware/adminMiddleware.js';

const router = express.Router();

// GET /attributes/:key
router.get('/:key', getAttributes);
// POST /attributes/:key (admin)
router.post('/:key', protect, adminOnly, createAttribute);
// PUT /attributes/:key/:id (admin)
router.put('/:key/:id', protect, adminOnly, updateAttribute);
// DELETE /attributes/:key/:id (admin)
router.delete('/:key/:id', protect, adminOnly, deleteAttribute);

export default router;
