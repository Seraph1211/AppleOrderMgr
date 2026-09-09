const express = require('express');
const multer = require('multer');
const path = require('path');
const { requirePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const service = require('../services/identityVerificationService');
const provider = require('../services/identityProviderService');
const { exportIdentityWorkbook } = require('../services/identityInputService');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const router = express.Router();
router.use(requirePermission(PERMISSIONS.IDENTITY_READ));
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0 },
  fileFilter: (_req, file, cb) =>
    cb(
      path.extname(file.originalname).toLowerCase() === '.xlsx'
        ? null
        : ApiError.badRequest('只支持.xlsx文件'),
      true
    ),
});

// 本模块不向公共错误处理器传递可能含身份字段的SQL或HTTP客户端异常。
function handle(fn) {
  return async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof ApiError) return next(error);
      logger.error('身份核验接口失败', { code: 'IDENTITY_API_FAILED', userId: req.user?.id });
      return next(ApiError.internal('身份核验操作失败，请稍后重试'));
    }
  };
}

router.get('/status', (_req, res) => res.json({ success: true, data: provider.getStatus() }));
router.get('/template', requirePermission(PERMISSIONS.IDENTITY_BATCH), (_req, res, next) => {
  res.download(
    path.join(__dirname, '../../templates/identity_verification_template.xlsx'),
    '身份核验模板.xlsx',
    error => {
      if (error && !res.headersSent) next(ApiError.internal('模板下载失败'));
    }
  );
});
router.post(
  '/single',
  requirePermission(PERMISSIONS.IDENTITY_VERIFY),
  handle(async (req, res) => {
    const data = await service.createSingle(req.user, req.body, req.get('Idempotency-Key'));
    res.status(202).json({ success: true, data });
  })
);
router.post(
  '/preview',
  requirePermission(PERMISSIONS.IDENTITY_BATCH),
  (req, res, next) => {
    upload.single('file')(req, res, error => {
      if (error)
        return next(
          ApiError.badRequest(
            error.code === 'LIMIT_FILE_SIZE' ? '文件不能超过10MB' : '上传失败，请选择一个.xlsx文件'
          )
        );
      next();
    });
  },
  handle(async (req, res) => {
    try {
      if (!req.file) throw ApiError.badRequest('请选择Excel文件');
      res.json({ success: true, data: await service.preview(req.user, req.file.buffer) });
    } finally {
      if (req.file) req.file.buffer = null;
    }
  })
);
router.get(
  '/batches',
  handle(async (req, res) =>
    res.json({ success: true, data: await service.list(req.user, req.query) })
  )
);
router.get(
  '/batches/:id',
  handle(async (req, res) =>
    res.json({ success: true, data: await service.detail(req.user, req.params.id) })
  )
);
router.post(
  '/batches/:id/start',
  handle(async (req, res) =>
    res.json({ success: true, data: await service.control(req.user, req.params.id, 'start') })
  )
);
router.post(
  '/batches/:id/stop',
  handle(async (req, res) =>
    res.json({ success: true, data: await service.control(req.user, req.params.id, 'stop') })
  )
);
router.get(
  '/batches/:id/export',
  requirePermission(PERMISSIONS.IDENTITY_EXPORT),
  handle(async (req, res) => {
    const data = await service.detail(req.user, req.params.id, PERMISSIONS.IDENTITY_EXPORT);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.attachment(`identity-${req.params.id}.xlsx`);
    res.send(exportIdentityWorkbook(data.rows));
  })
);
module.exports = router;
