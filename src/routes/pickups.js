const express = require('express');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');
const ocr = require('../controllers/pickupOcrController');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { requirePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const controller = require('../controllers/pickupController');
const devices = require('../controllers/pickupDeviceController');

const router = express.Router();
const ocrUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 2 },
}).single('image');
router.post(
  '/:orderId/devices/ocr',
  requirePermission(PERMISSIONS.PICKUPS_READ),
  requirePermission(PERMISSIONS.PICKUPS_EDIT),
  ocr.authorize,
  rateLimit({
    windowMs: 60000,
    limit: 10,
    keyGenerator: req => String(req.user.id),
    handler: (_req, _res, next) =>
      next(new ApiError(429, 'OCR_RATE_LIMIT', '识别过于频繁，请稍后重试')),
  }),
  (req, res, next) =>
    ocrUpload(req, res, error =>
      next(
        error
          ? ApiError.badRequest(
            error.code === 'LIMIT_FILE_SIZE'
              ? '图片不能超过 10 MB'
              : '请上传一张 JPG、PNG 或 WebP 图片'
          )
          : undefined
      )
    ),
  asyncHandler(ocr.recognize)
);
router.get(
  '/:orderId/devices',
  requirePermission(PERMISSIONS.PICKUPS_READ),
  asyncHandler(devices.list)
);
router.post(
  '/:orderId/devices',
  requirePermission(PERMISSIONS.PICKUPS_READ),
  requirePermission(PERMISSIONS.PICKUPS_EDIT),
  asyncHandler(devices.create)
);
router.delete(
  '/:orderId/devices/:deviceId',
  requirePermission(PERMISSIONS.PICKUPS_READ),
  requirePermission(PERMISSIONS.PICKUPS_EDIT),
  asyncHandler(devices.remove)
);
router.get(
  '/filter-options',
  requirePermission(PERMISSIONS.PICKUPS_READ),
  asyncHandler(controller.filterOptions)
);
router.get('/', requirePermission(PERMISSIONS.PICKUPS_READ), asyncHandler(controller.list));
router.get(
  '/export',
  requirePermission(PERMISSIONS.PICKUPS_EXPORT),
  asyncHandler(controller.exportList)
);
router.put(
  '/:orderId',
  requirePermission(PERMISSIONS.PICKUPS_EDIT),
  asyncHandler(controller.update)
);
router.get(
  '/:orderId/events',
  requirePermission(PERMISSIONS.PICKUPS_READ),
  asyncHandler(controller.events)
);
router.post(
  '/:orderId/evidence/prepare',
  requirePermission(PERMISSIONS.PICKUPS_EDIT),
  asyncHandler(controller.prepareEvidence)
);
router.post(
  '/:orderId/evidence/confirm',
  requirePermission(PERMISSIONS.PICKUPS_EDIT),
  asyncHandler(controller.confirmEvidence)
);
router.get(
  '/:orderId/evidence/:evidenceId',
  requirePermission(PERMISSIONS.PICKUPS_READ),
  asyncHandler(controller.readEvidence)
);
module.exports = router;
