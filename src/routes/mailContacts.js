const express = require('express');
const logger = require('../utils/logger');
const { requireRole } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const service = require('../services/mailContactService');
const router = express.Router();
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const permissions = req.user?.permissions || [];
  if (
    req.user?.role === 'admin' ||
    (permissions.includes(PERMISSIONS.ORDERS_READ) &&
      (permissions.includes(PERMISSIONS.ORDER_MAIL_MANAGE) ||
        [PERMISSIONS.ORDER_MAIL_READ, PERMISSIONS.ORDER_MAIL_FORWARD].every(code =>
          permissions.includes(code)
        )))
  )
    return next();
  return next(new ApiError(403, 'FORBIDDEN', '当前账号没有邮件联系人使用权限'));
});
router.get(
  '/',
  asyncHandler(async (req, res) => {
    try {
      res.json({ success: true, data: await service.listContacts(req.query) });
    } catch (error) {
      logger.warn('邮件联系人请求失败', { errorType: error.name, errorCode: error.code });
      throw error;
    }
  })
);
router.post(
  '/',
  requireRole(['admin']),
  asyncHandler(async (req, res) => {
    try {
      const data = await service.saveContact(undefined, req.body);
      req.auditTarget = '新增邮件联系人；ID ' + data.id;
      res.status(201).json({ success: true, data });
    } catch (error) {
      logger.warn('邮件联系人请求失败', { errorType: error.name, errorCode: error.code });
      throw error;
    }
  })
);
router.put(
  '/:id',
  requireRole(['admin']),
  asyncHandler(async (req, res) => {
    try {
      const data = await service.saveContact(req.params.id, req.body);
      req.auditTarget = '编辑邮件联系人；ID ' + data.id;
      res.json({ success: true, data });
    } catch (error) {
      logger.warn('邮件联系人请求失败', { errorType: error.name, errorCode: error.code });
      throw error;
    }
  })
);
router.delete(
  '/:id',
  requireRole(['admin']),
  asyncHandler(async (req, res) => {
    try {
      const data = await service.deleteContact(req.params.id);
      req.auditTarget = '删除邮件联系人；ID ' + data.id;
      res.json({ success: true, data });
    } catch (error) {
      logger.warn('邮件联系人请求失败', { errorType: error.name, errorCode: error.code });
      throw error;
    }
  })
);
module.exports = router;
