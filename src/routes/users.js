/**
 * 用户管理路由
 * @module routes/users
 * @description 用户管理接口（仅管理员）
 */

const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const { requirePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const controller = require('../controllers/userController');
const permissionController = require('../controllers/permissionController');

const router = express.Router();

router.get('/', requirePermission(PERMISSIONS.USERS_READ), asyncHandler(controller.listUsers));
router.get(
  '/permission-catalog',
  requirePermission(PERMISSIONS.USERS_PERMISSIONS_MANAGE),
  permissionController.getCatalog
);
router.get(
  '/:id/permissions',
  requirePermission(PERMISSIONS.USERS_PERMISSIONS_MANAGE),
  asyncHandler(permissionController.getUserPermissions)
);
router.put(
  '/:id/permissions',
  requirePermission(PERMISSIONS.USERS_PERMISSIONS_MANAGE),
  asyncHandler(permissionController.replaceUserPermissions)
);
router.post('/', requirePermission(PERMISSIONS.USERS_MANAGE), asyncHandler(controller.createUser));
router.put(
  '/:id',
  requirePermission(PERMISSIONS.USERS_MANAGE),
  asyncHandler(controller.updateUser)
);
router.delete(
  '/:id',
  requirePermission(PERMISSIONS.USERS_MANAGE),
  asyncHandler(controller.deleteUser)
);
router.put(
  '/:id/unlock',
  requirePermission(PERMISSIONS.USERS_MANAGE),
  asyncHandler(controller.unlockUser)
);

module.exports = router;
