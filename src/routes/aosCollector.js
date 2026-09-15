const logger = require('../utils/logger');
/** 设备专用协议；不得继承用户 Bearer 身份。 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { AosRecord } = require('../models');
const repo = require('../services/ingestionRepository');
const aos = require('../services/aosIngestionService');
const management = require('../services/ingestionManagementService');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const router = express.Router();

router.use(express.json({ limit: '1mb', strict: true }));
router.use(
  asyncHandler(async (req, res, next) => {
    try {
      req.collectorDevice = await repo.authenticateDevice(req.get('Authorization'));
      res.set('Cache-Control', 'no-store');
      next();
    } catch (error) {
      next(error);
    }
  })
);
function limiter(max) {
  return rateLimit({
    windowMs: 60000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: req => req.collectorDevice.id,
    handler: (_req, res) =>
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: '请求过于频繁，请稍后重试' },
      }),
  });
}
router.use(limiter(120));
function respond(work) {
  return asyncHandler(async (req, res) => {
    try {
      res.json({ success: true, data: await work(req) });
    } catch (error) {
      logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
      throw error;
    }
  });
}
router.get(
  '/monitor/context',
  respond(req => require('../services/monitorService').context(req.collectorDevice.id))
);
router.post(
  '/monitor/reports',
  respond(req => require('../services/monitorService').receive(req.collectorDevice.id, req.body))
);
router.get(
  '/context',
  respond(req => management.context(req.get('Authorization')))
);
router.post(
  '/heartbeat',
  respond(req => management.heartbeat(req.get('Authorization'), req.body))
);
router.post(
  '/payment-codes',
  limiter(60),
  respond(req =>
    require('../services/paymentCodeService').receivePaymentCodes(
      req.get('Authorization'),
      req.body
    )
  )
);
router.post(
  '/records',
  limiter(60),
  respond(req => aos.receiveBatch(req.get('Authorization'), req.body))
);
router.post(
  '/records/status',
  respond(async req => {
    try {
      repo.assertFields(req.body, ['eventIds', 'scanRequestId']);
      if (
        !Array.isArray(req.body.eventIds) ||
        req.body.eventIds.length < 1 ||
        req.body.eventIds.length > 100
      )
        throw ApiError.badRequest('事件数量无效');
      req.body.eventIds.forEach(repo.requireUuid);
      if (req.body.scanRequestId)
        await aos.associateScan(
          req.get('Authorization'),
          req.body.scanRequestId,
          req.body.eventIds
        );
      const rows = await AosRecord.findAll({
        where: { deviceId: req.collectorDevice.id, eventId: { [repo.Op.in]: req.body.eventIds } },
        attributes: ['eventId', 'id', 'status', 'eligibility', 'outcome', 'errorCode', 'updatedAt'],
      });
      const byId = new Map(rows.map(r => [r.eventId, r]));
      return {
        items: req.body.eventIds.map(eventId => {
          const r = byId.get(eventId);
          return r
            ? {
              eventId,
              recordId: r.id,
              processingStatus: r.status,
              eligibility: r.eligibility,
              outcome: r.outcome,
              errorCode: r.errorCode,
              updatedAt: r.updatedAt,
            }
            : { eventId, processingStatus: 'not_found' };
        }),
      };
    } catch (error) {
      logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
      throw error;
    }
  })
);
router.get(
  '/update',
  respond(req => require('../services/collectorUpdateService').pollUpdate(req.get('Authorization')))
);
router.post(
  '/update/:id/status',
  respond(req =>
    require('../services/collectorUpdateService').reportUpdate(
      req.get('Authorization'),
      req.params.id,
      req.body
    )
  )
);
router.get(
  '/update/:id/package',
  asyncHandler(async (req, res, next) => {
    try {
      const release = await require('../services/collectorUpdateService').updatePackage(
        req.get('Authorization'),
        req.params.id
      );
      res.set('Content-Type', 'application/octet-stream');
      res.sendFile(release.packagePath, error => {
        if (error) next(error);
      });
    } catch (error) {
      next(error);
    }
  })
);
router.use((_req, _res, next) => next(ApiError.notFound()));
router.use((error, _req, res, _next) => {
  const status =
    error.type === 'entity.too.large'
      ? 413
      : error.type === 'entity.parse.failed'
        ? 400
        : error.statusCode || 503;
  res.status(status).json({
    success: false,
    error: {
      code:
        status === 413
          ? 'PAYLOAD_TOO_LARGE'
          : status >= 500
            ? 'TEMPORARILY_UNAVAILABLE'
            : error.code || 'VALIDATION_ERROR',
      message:
        status >= 500
          ? '服务暂时不可用，请原事件重试'
          : status === 400
            ? '请求格式无效'
            : error.message,
    },
  });
});
module.exports = router;
