/**
 * Excel 导入控制器。
 * @module controllers/importController
 */

const crypto = require('crypto');
const fs = require('fs/promises');

const { AppleId, Recipient, sequelize } = require('../models');
const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');
const { blindIndex } = require('../utils/fieldEncryption');
const { previewImportData } = require('../services/importService');

const IMPORT_TYPES = Object.freeze(['apple_ids', 'recipients']);
const MAX_IMPORT_ROWS = 1000;
const SESSION_TTL_MS = 15 * 60 * 1000;
const importSessions = new Map();

function validateType(type) {
  if (!IMPORT_TYPES.includes(type)) {
    throw ApiError.badRequest('导入类型必须是 apple_ids 或 recipients');
  }
}

function removeExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of importSessions.entries()) {
    if (session.expiresAt <= now) importSessions.delete(token);
  }
}

async function removeUploadedFile(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger.warn('清理导入临时文件失败', { filePath, error: error.message });
    }
  }
}

/**
 * 预览导入文件并创建仅服务端保存的数据会话。
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @returns {Promise<void>}
 */
async function previewImport(req, res) {
  try {
    if (!req.file) throw ApiError.badRequest('请上传 .xlsx 文件');
    validateType(req.body.type);

    const result = previewImportData(req.file.path, req.body.type);
    if (result.summary.total > MAX_IMPORT_ROWS) {
      throw ApiError.badRequest(`单次导入不能超过 ${MAX_IMPORT_ROWS} 行`);
    }

    removeExpiredSessions();
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    importSessions.set(sessionToken, {
      type: req.body.type,
      userId: req.user.id,
      preview: result.preview,
      expiresAt: Date.now() + SESSION_TTL_MS,
    });

    logger.info('导入预览成功', {
      type: req.body.type,
      userId: req.user.id,
      total: result.summary.total,
      valid: result.summary.valid,
      invalid: result.summary.invalid,
    });
    res.json({
      success: true,
      data: {
        sessionToken,
        expiresInSeconds: SESSION_TTL_MS / 1000,
        summary: result.summary,
        errors: result.preview
          .filter(item => item.errors.length > 0)
          .map(item => ({ rowNumber: item.rowNumber, errors: item.errors })),
      },
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('导入预览失败', { userId: req.user?.id, error: error.message });
    throw ApiError.badRequest('导入文件解析失败', { reason: error.message });
  } finally {
    await removeUploadedFile(req.file?.path);
  }
}

async function batchImportAppleIds(dataList, transaction) {
  const result = { imported: 0, skipped: 0, errors: [] };
  for (const previewItem of dataList) {
    const item = previewItem.data;
    if (previewItem.errors.length > 0) {
      result.errors.push({
        rowNumber: previewItem.rowNumber,
        error: previewItem.errors.map(error => error.message).join(', '),
      });
      continue;
    }
    const existing = await AppleId.findOne({ where: { appleId: item.appleId }, transaction });
    if (existing) {
      result.skipped += 1;
      result.errors.push({ rowNumber: previewItem.rowNumber, error: 'Apple ID 已存在' });
      continue;
    }
    const securityQa = item.question1
      ? {
        question1: item.question1,
        answer1: item.answer1,
        question2: item.question2,
        answer2: item.answer2,
        question3: item.question3,
        answer3: item.answer3,
      }
      : null;
    await AppleId.create(
      {
        appleId: item.appleId,
        password: item.password,
        nickname: item.nickname || null,
        country: item.country || null,
        isModified: item.isModified === '是',
        status: item.status || '未使用',
        securityQa,
      },
      { transaction }
    );
    result.imported += 1;
  }
  return result;
}

async function batchImportRecipients(dataList, transaction) {
  const result = { imported: 0, skipped: 0, errors: [] };
  for (const previewItem of dataList) {
    const item = previewItem.data;
    if (previewItem.errors.length > 0) {
      result.errors.push({
        rowNumber: previewItem.rowNumber,
        error: previewItem.errors.map(error => error.message).join(', '),
      });
      continue;
    }
    const existing = await Recipient.findOne({
      where: { idCardHash: blindIndex(item.idCardNumber) },
      transaction,
    });
    if (existing) {
      result.skipped += 1;
      result.errors.push({ rowNumber: previewItem.rowNumber, error: '身份证号已存在' });
      continue;
    }

    let appleIdRef = null;
    if (item.appleId) {
      const account = await AppleId.findOne({ where: { appleId: item.appleId }, transaction });
      if (!account) {
        result.errors.push({ rowNumber: previewItem.rowNumber, error: '绑定的 Apple ID 不存在' });
        continue;
      }
      appleIdRef = account.id;
    }
    await Recipient.create(
      {
        lastName: item.lastName,
        firstName: item.firstName,
        idCardNumber: item.idCardNumber,
        phone: item.phone || null,
        email: item.email || null,
        province: item.province || null,
        city: item.city || null,
        district: item.district || null,
        streetAddress: item.streetAddress || null,
        appleIdRef,
        tag: item.tag || null,
        status: item.status || '未使用',
        notes: item.notes || null,
      },
      { transaction }
    );
    result.imported += 1;
  }
  return result;
}

/**
 * 使用服务端导入会话执行导入。
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @returns {Promise<void>}
 */
async function executeImport(req, res) {
  try {
    const { sessionToken } = req.body || {};
    if (!sessionToken || typeof sessionToken !== 'string') {
      throw ApiError.badRequest('sessionToken 不能为空');
    }
    removeExpiredSessions();
    const session = importSessions.get(sessionToken);
    if (!session || session.userId !== req.user.id) {
      throw ApiError.badRequest('导入会话不存在、已过期或不属于当前用户');
    }
    if (req.body.type !== session.type) {
      throw ApiError.badRequest('导入类型与预览会话不匹配');
    }
    // 执行前即消费令牌，防止并发重放。失败后需重新预览。
    importSessions.delete(sessionToken);

    const result = await sequelize.transaction(transaction => {
      if (session.type === 'apple_ids') {
        return batchImportAppleIds(session.preview, transaction);
      }
      return batchImportRecipients(session.preview, transaction);
    });
    logger.info('批量导入完成', {
      type: session.type,
      userId: req.user.id,
      imported: result.imported,
      skipped: result.skipped,
      errorCount: result.errors.length,
    });
    res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('批量导入失败', { userId: req.user?.id, error: error.message });
    throw ApiError.database('批量导入失败', { reason: error.message });
  }
}

module.exports = { previewImport, executeImport };
