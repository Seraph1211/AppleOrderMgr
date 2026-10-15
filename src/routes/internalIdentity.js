const express = require('express');
const crypto = require('crypto');
const service = require('../services/identityApiService');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const router = express.Router();

// 比JSON解析、通用日志、CORS、JWT更早执行。禁止错误内容传播敏感URI/SQL。
router.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.set({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Request-Id': req.requestId,
  });
  const start = Date.now();
  res.on('finish', () =>
    logger.info('内部身份核验访问', {
      route: '/api/internal/v1/identity',
      method: req.method,
      requestId: req.requestId,
      status: res.statusCode,
      costMs: Date.now() - start,
      userId: req.identityAudit?.userId,
      tokenId: req.identityAudit?.tokenId,
      verificationId: req.identityAudit?.verificationId,
    })
  );
  if (!req.secure)
    return res.status(400).json({
      success: false,
      requestId: req.requestId,
      error: { code: 'HTTPS_REQUIRED', message: '必须直接使用HTTPS访问此接口' },
      providerCalled: false,
    });
  if (req.method !== 'GET')
    return res
      .status(405)
      .set('Allow', 'GET')
      .json({
        success: false,
        requestId: req.requestId,
        error: { code: 'METHOD_NOT_ALLOWED', message: '仅允许GET请求' },
        providerCalled: false,
      });
  next();
});
router.get('/verify', async (req, res) => {
  try {
    // 原始URL只用于解析，不进入日志、错误和响应。URLSearchParams拒绝重复及嵌套键。
    const params = new URL(req.originalUrl, 'https://internal.invalid').searchParams;
    const allowed = ['name', 'idCardNumber', 'token'];
    if (
      [...params.keys()].some(key => !allowed.includes(key)) ||
      allowed.some(key => params.getAll(key).length > 1) ||
      ['name', 'idCardNumber'].some(key => params.getAll(key).length !== 1)
    )
      throw ApiError.badRequest('仅允许name、idCardNumber、token三个单值参数');
    if (!params.get('token')) throw new ApiError(401, 'UNAUTHORIZED', 'API令牌缺失或已失效');
    const input = Object.fromEntries(params.entries());
    const data = await service.verify(input, undefined, actor => {
      req.identityAudit = actor;
    });
    req.identityAudit.verificationId = data.verificationId;
    res.json({ success: true, requestId: req.requestId, data });
  } catch (error) {
    if (req.identityAudit && error.verificationId)
      req.identityAudit.verificationId = error.verificationId;
    const known = error instanceof ApiError;
    const status = known ? error.statusCode : 503;
    if (status === 429) res.set('Retry-After', error.code === 'DAILY_LIMIT' ? '3600' : '1');
    res.status(status).json({
      success: false,
      requestId: req.requestId,
      error: {
        code: known ? error.code : 'INTERNAL_ERROR',
        message: known ? error.message : '核验服务暂不可用，请联系管理员',
      },
      ...(error.verificationId ? { verificationId: error.verificationId } : {}),
      ...(error.resultStatus ? { status: error.resultStatus, matched: null } : {}),
      providerCalled: error.providerCalled === true,
    });
  }
});
router.use((req, res) =>
  res.status(404).json({
    success: false,
    requestId: req.requestId,
    error: { code: 'NOT_FOUND', message: '核验接口不存在' },
    providerCalled: false,
  })
);
router.use((_error, req, res, _next) =>
  res.status(400).json({
    success: false,
    requestId: req.requestId,
    error: { code: 'VALIDATION_ERROR', message: '核验请求格式无效' },
    providerCalled: false,
  })
);
module.exports = router;
