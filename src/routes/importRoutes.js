const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requirePermission } = require('../middleware/authMiddleware');
const { PERMISSIONS } = require('../constants/business');
const { previewImport, reviewImport, executeImport } = require('../controllers/importController');
const asyncHandler = require('../utils/asyncHandler');

const router = express.Router();
const associations = require('../controllers/profileAssociationController');
const associationPermissions = [
  PERMISSIONS.ORDERS_READ,
  PERMISSIONS.ORDERS_EDIT,
  PERMISSIONS.RECIPIENTS_READ,
  PERMISSIONS.APPLE_IDS_READ,
].map(requirePermission);
router.post(
  '/associations/preview',
  ...associationPermissions,
  asyncHandler(associations.previewAssociations)
);
router.post(
  '/associations/execute',
  ...associationPermissions,
  asyncHandler(associations.executeAssociations)
);

function requireImportPermission(permissionByType) {
  return (req, res, next) => {
    const type = req.query.type || req.body?.type;
    const permission = permissionByType[type];
    if (!permission) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: '导入类型必须是 apple_ids 或 recipients' },
      });
    }
    return requirePermission(permission)(req, res, next);
  };
}

/* eslint-disable camelcase -- 导入类型是已发布的 API 枚举 */
const importPermissionByType = {
  apple_ids: PERMISSIONS.APPLE_IDS_IMPORT,
  recipients: PERMISSIONS.RECIPIENTS_IMPORT,
};
const templatePermissionByType = {
  apple_ids: PERMISSIONS.APPLE_IDS_TEMPLATE_READ,
  recipients: PERMISSIONS.RECIPIENTS_TEMPLATE_READ,
};
/* eslint-enable camelcase */

// 确保上传目录存在
const uploadDir = path.join(__dirname, '../../uploads/import');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// 配置文件上传
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.xlsx') {
      return cb(new Error('只支持 .xlsx 格式的文件'));
    }
    cb(null, true);
  },
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB
    // 导入仅接收平面字段，避免异常下标分配超大稀疏数组。
    fieldArrayIndexLimit: 0,
  },
});

/**
 * @route POST /api/import/preview
 * @desc 预览导入数据
 * @access Public
 */
router.post(
  '/preview',
  requireImportPermission(importPermissionByType),
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'files', maxCount: 20 },
  ]),
  asyncHandler(previewImport)
);

/**
 * @route POST /api/import/execute
 * @desc 执行批量导入
 * @access Public
 */
router.post('/review', requireImportPermission(importPermissionByType), asyncHandler(reviewImport));

router.post(
  '/execute',
  requireImportPermission(importPermissionByType),
  asyncHandler(executeImport)
);

/**
 * @route GET /api/import/template/:type
 * @desc 下载导入模板
 * @access Public
 */
router.get('/template/:type', (req, res) => {
  const { type } = req.params;

  if (!['apple_ids', 'recipients'].includes(type)) {
    return res.status(400).json({
      success: false,
      error: '模板类型必须是 apple_ids 或 recipients',
    });
  }

  return requirePermission(templatePermissionByType[type])(req, res, () => {
    const XLSX = require('xlsx');
    const headers =
      type === 'apple_ids'
        ? [
          'Apple ID',
          '密码',
          '国家',
          '状态',
          '备注',
          '密保问题1',
          '密保答案1',
          '密保问题2',
          '密保答案2',
          '密保问题3',
          '密保答案3',
        ]
        : [
          'Apple ID',
          '密码',
          '下单手机号码',
          'Email',
          '省',
          '市',
          '区',
          '街道地址',
          '使用状态',
          '姓',
          '名',
          '身份证号码',
          'TAG',
          '信息导入模板',
          '真实联系电话',
          '备注',
        ];
    const book = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([headers]);
    for (let row = 1; row <= 1000; row++) {
      for (let col = 0; col < headers.length; col++) {
        sheet[XLSX.utils.encode_cell({ r: row, c: col })] = { t: 's', v: '', z: '@' };
      }
    }
    sheet['!ref'] = XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: 1000, c: headers.length - 1 },
    });
    XLSX.utils.book_append_sheet(book, sheet, type === 'apple_ids' ? 'Apple IDs' : 'Recipients');
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${type}_import_template.xlsx"`);
    return res.send(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
  });
});

module.exports = router;
