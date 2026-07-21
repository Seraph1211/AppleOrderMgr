const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authenticate } = require('../middleware/authMiddleware');
const { previewImport, executeImport } = require('../controllers/importController');

const router = express.Router();

// 所有接口都需要认证
router.use(authenticate);

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
  },
});

/**
 * @route POST /api/import/preview
 * @desc 预览导入数据
 * @access Public
 */
router.post('/preview', upload.single('file'), previewImport);

/**
 * @route POST /api/import/execute
 * @desc 执行批量导入
 * @access Public
 */
router.post('/execute', executeImport);

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

  const templateName =
    type === 'apple_ids'
      ? 'apple_ids_import_template.xlsx'
      : 'recipients_import_template.xlsx';
  const templatePath = path.join(__dirname, '../../templates', templateName);

  if (!fs.existsSync(templatePath)) {
    return res.status(404).json({
      success: false,
      error: '模板文件不存在',
    });
  }

  res.download(templatePath, templateName);
});

module.exports = router;
