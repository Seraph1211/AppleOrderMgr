const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requirePermission, requireRole } = require('../middleware/authMiddleware');
const service = require('../services/officialOrderRefreshService');
const router = express.Router();

router.use(
  requireRole(['admin']),
  requirePermission('orders.read'),
  requirePermission('orders.edit')
);
router.post(
  '/batches',
  asyncHandler(async (req, res) => {
    try {
      res.status(202).json({ success: true, data: await service.enqueue(req.user, req.body) });
    } catch (error) {
      error.component = 'officialOrderRefresh';
      throw error;
    }
  })
);
router.get(
  '/batches',
  asyncHandler(async (req, res) => {
    try {
      res.json({ success: true, data: await service.listBatches(req.user) });
    } catch (error) {
      error.component = 'officialOrderRefresh';
      throw error;
    }
  })
);
router.get(
  '/batches/:batchId',
  asyncHandler(async (req, res) => {
    try {
      res.json({
        success: true,
        data: await service.getBatch(
          req.user,
          req.params.batchId,
          Number(req.query.page || 1),
          Number(req.query.limit || 20)
        ),
      });
    } catch (error) {
      error.component = 'officialOrderRefresh';
      throw error;
    }
  })
);
router.post(
  '/batches/:batchId/cancel',
  asyncHandler(async (req, res) => {
    try {
      res.json({ success: true, data: await service.cancelBatch(req.user, req.params.batchId) });
    } catch (error) {
      error.component = 'officialOrderRefresh';
      throw error;
    }
  })
);

module.exports = router;
