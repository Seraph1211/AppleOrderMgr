const { AppleId, Recipient, sequelize } = require('../models');
const logger = require('../utils/logger');
const { previewImportData } = require('../services/importService');

/**
 * 预览导入数据
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
function previewImport(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: '请上传文件',
      });
    }

    const { type } = req.body;

    if (!['apple_ids', 'recipients'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: '导入类型必须是 apple_ids 或 recipients',
      });
    }

    const result = previewImportData(req.file.path, type);

    logger.info('导入预览成功', {
      type,
      total: result.summary.total,
      valid: result.summary.valid,
      invalid: result.summary.invalid,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('导入预览失败', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}

/**
 * 执行导入
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
async function executeImport(req, res) {
  const transaction = await sequelize.transaction();

  try {
    const { type, data } = req.body;

    if (!['apple_ids', 'recipients'].includes(type)) {
      return res.status(400).json({
        success: false,
        error: '导入类型必须是 apple_ids 或 recipients',
      });
    }

    if (!Array.isArray(data) || data.length === 0) {
      return res.status(400).json({
        success: false,
        error: '导入数据不能为空',
      });
    }

    let result;
    if (type === 'apple_ids') {
      result = await batchImportAppleIds(data, transaction);
    } else {
      result = await batchImportRecipients(data, transaction);
    }

    await transaction.commit();

    logger.info('批量导入成功', {
      type,
      imported: result.imported,
      skipped: result.skipped,
      errorCount: result.errors.length,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    await transaction.rollback();
    logger.error('批量导入失败', { error: error.message, stack: error.stack });
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
}

/**
 * 批量导入 Apple IDs
 * @param {Array} dataList - 数据列表（预览格式：包含 rowNumber, data, errors）
 * @param {Object} transaction - 数据库事务
 * @returns {Object} 导入结果
 */
async function batchImportAppleIds(dataList, transaction) {
  const results = {
    imported: 0,
    skipped: 0,
    errors: [],
  };

  for (const previewItem of dataList) {
    // 从预览格式中提取实际数据
    const item = previewItem.data || previewItem;

    // 跳过校验失败的行
    if (previewItem.errors && previewItem.errors.length > 0) {
      results.errors.push({
        rowNumber: previewItem.rowNumber,
        data: item,
        error: previewItem.errors.map(e => e.message).join(', '),
      });
      continue;
    }

    try {
      // 构建密保 JSONB 对象
      const securityQa =
        item.question1 && item.answer1
          ? {
            question1: item.question1,
            answer1: item.answer1,
            question2: item.question2,
            answer2: item.answer2,
            question3: item.question3,
            answer3: item.answer3,
          }
          : null;

      const [, created] = await AppleId.findOrCreate({
        where: { appleId: item.appleId },
        defaults: {
          password: item.password,
          nickname: item.nickname || null,
          country: item.country || null,
          isModified: item.isModified === '是',
          status: item.status || 'active',
          securityQa: securityQa,
        },
        transaction,
      });

      if (created) {
        results.imported++;
        logger.info('Apple ID 导入成功', { appleId: item.appleId });
      } else {
        results.skipped++;
        results.errors.push({
          data: item,
          error: 'Apple ID 已存在',
        });
        logger.warn('Apple ID 已存在，跳过', { appleId: item.appleId });
      }
    } catch (error) {
      results.errors.push({
        data: item,
        error: error.message,
      });
      logger.error('Apple ID 导入失败', {
        appleId: item.appleId,
        error: error.message,
      });
    }
  }

  return results;
}

/**
 * 批量导入取机人
 * @param {Array} dataList - 数据列表（预览格式：包含 rowNumber, data, errors）
 * @param {Object} transaction - 数据库事务
 * @returns {Object} 导入结果
 */
async function batchImportRecipients(dataList, transaction) {
  const results = {
    imported: 0,
    skipped: 0,
    errors: [],
  };

  for (const previewItem of dataList) {
    // 从预览格式中提取实际数据
    const item = previewItem.data || previewItem;

    // 跳过校验失败的行
    if (previewItem.errors && previewItem.errors.length > 0) {
      results.errors.push({
        rowNumber: previewItem.rowNumber,
        data: item,
        error: previewItem.errors.map(e => e.message).join(', '),
      });
      continue;
    }

    try {
      // 如果提供了 appleId，查找对应的 apple_id_ref
      let appleIdRef = null;
      if (item.appleId) {
        const appleAccount = await AppleId.findOne({
          where: { appleId: item.appleId },
          transaction,
        });
        if (appleAccount) {
          appleIdRef = appleAccount.id;
        } else {
          results.errors.push({
            rowNumber: previewItem.rowNumber,
            data: item,
            error: `绑定的 Apple ID "${item.appleId}" 不存在`,
          });
          continue;
        }
      }

      const [, created] = await Recipient.findOrCreate({
        where: { idCardNumber: item.idCardNumber },
        defaults: {
          lastName: item.lastName,
          firstName: item.firstName,
          phone: item.phone || null,
          email: item.email || null,
          province: item.province || null,
          city: item.city || null,
          district: item.district || null,
          streetAddress: item.streetAddress || null,
          appleIdRef: appleIdRef,
          tag: item.tag || null,
          status: item.status || 'active',
          notes: item.notes || null,
        },
        transaction,
      });

      if (created) {
        results.imported++;
        logger.info('取机人导入成功', {
          name: `${item.lastName}${item.firstName}`,
          idCard: item.idCardNumber,
        });
      } else {
        results.skipped++;
        results.errors.push({
          data: item,
          error: '身份证号已存在',
        });
        logger.warn('取机人已存在，跳过', {
          name: `${item.lastName}${item.firstName}`,
          idCard: item.idCardNumber,
        });
      }
    } catch (error) {
      results.errors.push({
        data: item,
        error: error.message,
      });
      logger.error('取机人导入失败', {
        name: item.lastName + item.firstName,
        error: error.message,
      });
    }
  }

  return results;
}

module.exports = {
  previewImport,
  executeImport,
};
