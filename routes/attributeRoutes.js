import express from 'express';
import { getAttributes, createAttribute, updateAttribute, deleteAttribute } from '../controllers/attributeController.js';

const router = express.Router();

// GET /attributes/:key
router.get('/:key', getAttributes);
// POST /attributes/:key
router.post('/:key', createAttribute);
// PUT /attributes/:key/:id
router.put('/:key/:id', updateAttribute);
// DELETE /attributes/:key/:id
router.delete('/:key/:id', deleteAttribute);

export default router;
