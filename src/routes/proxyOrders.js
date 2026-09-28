const logger = require('../utils/logger');
const express = require('express');
const { requirePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const asyncHandler = require('../utils/asyncHandler');
const service = require('../services/proxyOrderService');
const input = require('../utils/proxyOrderInput');
const router = express.Router();
router.use(requirePermission(PERMISSIONS.PROXY_READ));
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
const handle = work =>
  asyncHandler(async (req, res) => {
    try {
      res.json({ success: true, data: await work(req) });
    } catch (error) {
      logger.debug('代抢接口未完成', { errorType: error.name });
      throw error;
    }
  });
router.get(
  '/stores',
  handle(() => input.STORES)
);
router.post(
  '/parse',
  requirePermission(PERMISSIONS.PROXY_EDIT),
  handle(req => input.parseProxyText(req.body.text))
);
router.post(
  '/address',
  requirePermission(PERMISSIONS.PROXY_EDIT),
  handle(req => input.generateProxyAddress(req.body.storeCode))
);
router.post(
  '/copy',
  requirePermission(PERMISSIONS.PROXY_COPY),
  handle(req => service.copyTemplates(req.body.ids, req.user.id))
);
router.get(
  '/accounts',
  requirePermission(PERMISSIONS.PROXY_ACCOUNTS),
  handle(req => service.listAccounts(req.query))
);
for (const action of ['import', 'adopt'])
  router.post(
    `/accounts/${action}`,
    requirePermission(PERMISSIONS.PROXY_ACCOUNTS),
    handle(req => service.changeAccounts(action, req.body, req.user.id))
  );
router.post(
  '/accounts/status',
  requirePermission(PERMISSIONS.PROXY_ACCOUNTS),
  handle(req => service.changeAccounts('status', req.body, req.user.id))
);
router.put(
  '/accounts/:id',
  requirePermission(PERMISSIONS.PROXY_ACCOUNTS),
  handle(req => service.changeAccounts('update', req.body, req.user.id, req.params.id))
);
router.get(
  '/',
  handle(req => service.listOrders(req.query))
);
router.post(
  '/',
  requirePermission(PERMISSIONS.PROXY_EDIT),
  handle(req => service.saveOrder(null, req.body, req.user.id))
);
router.get(
  '/:id',
  handle(req => service.detail(req.params.id))
);
router.put(
  '/:id',
  requirePermission(PERMISSIONS.PROXY_EDIT),
  handle(req => service.saveOrder(req.params.id, req.body, req.user.id))
);
for (const [action, permission] of [
  ['status', PERMISSIONS.PROXY_STATUS],
  ['notes', PERMISSIONS.PROXY_EDIT],
  ['accounts', PERMISSIONS.PROXY_ACCOUNTS],
  ['release', PERMISSIONS.PROXY_ACCOUNTS],
  ['link', PERMISSIONS.PROXY_LINK],
])
  router.post(
    `/:id/${action}`,
    requirePermission(permission),
    handle(req => service.changeOrder(action, req.params.id, req.body, req.user.id))
  );
module.exports = router;
