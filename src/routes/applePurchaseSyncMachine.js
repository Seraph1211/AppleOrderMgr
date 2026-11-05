const crypto = require('crypto');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const service = require('../services/applePurchaseSyncIngestService');
const {
  MAX_BODY_BYTES,
  UUID_PATTERN,
  parseBatchBody,
} = require('../services/applePurchaseSyncValidation');

function errorResponse(res, requestId, error) {
  const known = error instanceof ApiError;
  const status = known ? error.statusCode : 500;
  if ([429, 503].includes(status) && !res.getHeader('Retry-After'))
    res.set('Retry-After', status === 429 ? '1' : '5');
  return res.status(status).json({
    success: false,
    error: {
      code: known ? error.code : 'INTERNAL_ERROR',
      message: known ? error.message : '同步服务内部错误',
      ...(known && error.details !== undefined ? { details: error.details } : {}),
    },
    requestId,
  });
}

function createLimiter(keyGenerator, limit) {
  return rateLimit({
    windowMs: 60_000,
    limit,
    keyGenerator,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) =>
      errorResponse(res, req.requestId, new ApiError(429, 'RATE_LIMITED', '请求过于频繁')),
  });
}

function createRouter(syncService = service) {
  const router = express.Router();
  router.use((req, res, next) => {
    const supplied = req.get('X-Request-Id');
    req.requestId = supplied && UUID_PATTERN.test(supplied) ? supplied : crypto.randomUUID();
    res.set({
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Request-Id': req.requestId,
    });
    if (!supplied || !UUID_PATTERN.test(supplied)) {
      return errorResponse(
        res,
        req.requestId,
        ApiError.badRequest('X-Request-Id 必须是 UUID', [
          { path: 'X-Request-Id', reason: supplied ? 'invalid_uuid' : 'required' },
        ])
      );
    }
    if (process.env.NODE_ENV === 'production' && !req.secure) {
      return errorResponse(
        res,
        req.requestId,
        new ApiError(400, 'VALIDATION_ERROR', '生产同步接口仅接受 HTTPS')
      );
    }
    next();
  });
  router.use(createLimiter(req => req.ip || req.socket?.remoteAddress || 'unknown', 180));
  router.use(async (req, res, next) => {
    try {
      const authorization = req.get('Authorization');
      const match =
        typeof authorization === 'string' ? authorization.match(/^Bearer ([^\s]+)$/) : null;
      if (!match) throw new ApiError(401, 'UNAUTHORIZED', '终端凭据缺失或格式无效');
      req.machineToken = match[1];
      req.machineTerminal = await syncService.authenticate(req.machineToken);
      next();
    } catch (error) {
      errorResponse(res, req.requestId, error);
    }
  });
  router.use(createLimiter(req => `${req.ip || 'unknown'}:${req.machineTerminal.id}`, 120));
  router.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () =>
      logger.info('ApplePurchase 同步访问', {
        route: req.route?.path || '/unmatched',
        method: req.method,
        requestId: req.requestId,
        terminalId: req.machineTerminal?.id,
        batchId: req.machineAudit?.batchId,
        observations: req.machineAudit?.observations,
        monitorChanges: req.machineAudit?.monitorChanges,
        status: res.statusCode,
        costMs: Date.now() - startedAt,
      })
    );
    next();
  });

  router.get('/status', (req, res) => {
    res.json({
      success: true,
      data: syncService.status(req.machineTerminal),
      requestId: req.requestId,
    });
  });
  router.post(
    '/batches',
    (req, res, next) => {
      const contentType = req.get('Content-Type') || '';
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
        return errorResponse(
          res,
          req.requestId,
          ApiError.badRequest('Content-Type 必须是 application/json')
        );
      }
      return express.raw({ type: 'application/json', limit: MAX_BODY_BYTES })(req, res, next);
    },
    async (req, res) => {
      try {
        const batch = parseBatchBody(req.body);
        req.machineAudit = {
          batchId: batch.batchId,
          observations: batch.observations.length,
          monitorChanges: batch.monitorChanges.length,
        };
        const data = await syncService.ingestBatch(
          batch,
          req.machineTerminal,
          req.machineToken,
          req.requestId
        );
        res.json({ success: true, data, requestId: req.requestId });
      } catch (error) {
        errorResponse(res, req.requestId, error);
      }
    }
  );
  router.use((error, req, res, _next) => {
    if (error?.type === 'entity.too.large') {
      return errorResponse(
        res,
        req.requestId,
        new ApiError(413, 'PAYLOAD_TOO_LARGE', '请求体超过 v1 上限')
      );
    }
    return errorResponse(res, req.requestId, ApiError.badRequest('请求体格式无效'));
  });
  return router;
}

module.exports = createRouter();
module.exports.createRouter = createRouter;
