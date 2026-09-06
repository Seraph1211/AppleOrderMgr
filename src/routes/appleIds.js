/**
 * Apple ID 路由
 */

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requirePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const controller = require('../controllers/appleIdController');

const router = express.Router();

router.get('/', asyncHandler(controller.listAppleIds));
router.get('/:id', asyncHandler(controller.getAppleIdDetail));
router.post('/', requirePermission(PERMISSIONS.WRITE), asyncHandler(controller.createAppleId));
router.put('/:id', requirePermission(PERMISSIONS.WRITE), asyncHandler(controller.updateAppleId));
router.delete(
  '/:id',
  requirePermission(PERMISSIONS.DELETE),
  asyncHandler(controller.deleteAppleId)
);

module.exports = router;
