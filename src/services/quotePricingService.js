const { randomUUID } = require('crypto');
const { Op } = require('sequelize');
const {
  sequelize,
  QuotePricingSetting: Setting,
  QuotePriceAdjustment: Adjustment,
  QuotePricingVersion: Version,
} = require('../models');
const sourceRepository = require('../repositories/quoteSourceRepository');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const {
  applyDisplayOrder,
  calculateQuotePrice,
  compareQuoteColors,
  normalizeSourceItems,
  validateAdjustment,
} = require('./quotePricingCore');

const SETTING_ID = 1;
const MAX_SELECTION = 100;
const MAX_DISPLAY_ITEMS = 1000;
const DEFAULT_VERSION_LIMIT = 20;
const MAX_VERSION_LIMIT = 100;

function validateFields(body, allowed) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some(key => !allowed.includes(key))
  ) {
    throw ApiError.badRequest('请求字段无效');
  }
}

function validateExpectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw ApiError.badRequest('版本号无效');
  return value;
}

function validateProductKeys(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SELECTION) {
    throw ApiError.badRequest(`请选择 1 至 ${MAX_SELECTION} 个商品`);
  }
  const keys = [...new Set(value.map(key => (typeof key === 'string' ? key.trim() : '')))];
  if (keys.length < 1 || keys.some(key => !/^[a-f0-9]{40}$/.test(key))) {
    throw ApiError.badRequest('商品选择无效');
  }
  return keys;
}

function validateDisplayOrder(value, sourceItems) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DISPLAY_ITEMS) {
    throw ApiError.badRequest(`商品顺序必须包含 1 至 ${MAX_DISPLAY_ITEMS} 个商品`);
  }
  const productKeys = value.map(key => (typeof key === 'string' ? key.trim() : ''));
  if (productKeys.some(key => !/^[a-f0-9]{40}$/.test(key))) {
    throw ApiError.badRequest('商品顺序无效');
  }
  if (new Set(productKeys).size !== productKeys.length) {
    throw ApiError.badRequest('商品顺序不能包含重复商品');
  }
  const sourceKeys = new Set(sourceItems.map(item => item.productKey));
  if (productKeys.length !== sourceKeys.size || productKeys.some(key => !sourceKeys.has(key))) {
    throw ApiError.conflict(
      '报价商品已经更新，请刷新页面后重新排序',
      undefined,
      'QUOTE_PRODUCTS_CHANGED'
    );
  }
  return productKeys;
}

function checkVersion(setting, expectedVersion) {
  validateExpectedVersion(expectedVersion);
  if (setting.version !== expectedVersion) {
    throw new ApiError(409, 'CONCURRENT_MODIFICATION', '报价设置已更新，请刷新后重试', {
      currentVersion: setting.version,
    });
  }
}

async function getSetting(options = {}) {
  const setting = await Setting.findByPk(SETTING_ID, options);
  if (!setting) throw new ApiError(503, 'QUOTE_PRICING_NOT_MIGRATED', '报价功能尚未初始化');
  return setting;
}

async function loadSource() {
  try {
    const batch = await sourceRepository.fetchLatestIphone18Batch();
    return { ...batch, items: normalizeSourceItems(batch.items) };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('读取报价来源库失败', {
      errorType: error.name,
      errorCode: error.code || null,
    });
    throw new ApiError(503, 'QUOTE_SOURCE_UNAVAILABLE', '报价数据暂不可用');
  }
}

function adjustmentDto(row) {
  return {
    productKey: row.productKey,
    productModel: row.productModel,
    storageGb: row.storageGb,
    color: row.color,
    percentage: Number(row.percentage),
    fixedAmount: Number(row.fixedAmount),
  };
}

function mergeItems(sourceItems, adjustments) {
  const byKey = new Map(adjustments.map(row => [row.productKey, row]));
  return sourceItems.map(item => {
    const adjustment = byKey.get(item.productKey);
    const percentage = Number(adjustment?.percentage || 0);
    const fixedAmount = Number(adjustment?.fixedAmount || 0);
    return {
      ...item,
      percentage,
      fixedAmount,
      quotePrice: calculateQuotePrice(item.basePrice, percentage, fixedAmount),
    };
  });
}

async function currentSnapshot(transaction) {
  const rows = await Adjustment.findAll({
    order: [['productKey', 'ASC']],
    transaction,
  });
  return rows.map(adjustmentDto);
}

async function saveVersion(transaction, setting, actor, action, summary) {
  const snapshot = await currentSnapshot(transaction);
  await Version.create(
    {
      id: randomUUID(),
      revision: setting.version,
      action,
      snapshot,
      summary: { ...summary, itemCount: snapshot.length },
      actorUserId: actor.id,
      actorName: String(actor.nickname || actor.username || '管理员').slice(0, 100),
      createdAt: new Date(),
    },
    { transaction }
  );
  return snapshot;
}

function publicItem(item) {
  return {
    productKey: item.productKey,
    productName: item.productName,
    productModel: item.productModel,
    storageGb: item.storageGb,
    color: item.color,
    quotePrice: item.quotePrice,
    officialPrice: item.officialPrice,
  };
}

function latestDate(...values) {
  const dates = values.filter(Boolean).map(value => new Date(value));
  if (dates.length === 0 || dates.some(date => Number.isNaN(date.getTime()))) return null;
  return new Date(Math.max(...dates.map(date => date.getTime())));
}

/** 获取无需登录的公开报价。 @returns {Promise<Object>} 公开字段白名单 */
async function getPublicQuotes() {
  try {
    const setting = await getSetting();
    if (!setting.publicEnabled) {
      throw new ApiError(503, 'QUOTE_PAGE_PAUSED', '报价页面暂未开放');
    }
    const [source, adjustments] = await Promise.all([loadSource(), Adjustment.findAll()]);
    const items = applyDisplayOrder(
      mergeItems(source.items, adjustments),
      setting.displayOrder
    );
    const lastAdjustmentAt = adjustments.reduce(
      (latest, row) => latestDate(latest, row.updatedAt),
      null
    );
    const staleMinutes = Math.max(
      1,
      Number.parseInt(process.env.QUOTE_SOURCE_STALE_MINUTES || '5', 10) || 5
    );
    const checkedAt = source.lastCheckedAt ? new Date(source.lastCheckedAt) : null;
    return {
      enabled: true,
      updatedAt: latestDate(source.sourceUpdatedAt, lastAdjustmentAt),
      stale: !checkedAt || Date.now() - checkedAt.getTime() > staleMinutes * 60 * 1000,
      filters: {
        productModels: [...new Set(items.map(item => item.productModel))],
        storageGb: [...new Set(items.map(item => item.storageGb))].sort((a, b) => a - b),
        colors: [...new Set(items.map(item => item.color))].sort(compareQuoteColors),
      },
      items: items.map(publicItem),
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('生成公开报价失败', { errorType: error.name });
    throw new ApiError(503, 'QUOTE_SOURCE_UNAVAILABLE', '报价数据暂不可用');
  }
}

/** 获取管理员调价页面数据。 @returns {Promise<Object>} 管理数据 */
async function getAdminQuotes() {
  try {
    const [setting, source, adjustments] = await Promise.all([
      getSetting(),
      loadSource(),
      Adjustment.findAll(),
    ]);
    const defaultItems = mergeItems(source.items, adjustments);
    const items = applyDisplayOrder(defaultItems, setting.displayOrder);
    return {
      publicEnabled: setting.publicEnabled,
      version: setting.version,
      publicPath: '/quote/apple',
      sourceUpdatedAt: source.sourceUpdatedAt,
      lastCheckedAt: source.lastCheckedAt,
      defaultOrder: defaultItems.map(item => item.productKey),
      items: items.map(item => ({
        productKey: item.productKey,
        productName: item.productName,
        productModel: item.productModel,
        storageGb: item.storageGb,
        color: item.color,
        specCode: item.specCode,
        basePrice: item.basePrice,
        officialPrice: item.officialPrice,
        percentage: item.percentage,
        fixedAmount: item.fixedAmount,
        quotePrice: item.quotePrice,
      })),
    };
  } catch (error) {
    logger.debug('读取报价管理数据失败', { errorType: error.name });
    throw error;
  }
}

/** 保存公开报价逐行展示顺序。 @param {Object} actor 管理员 @param {Object} body 请求 */
async function saveDisplayOrder(actor, body) {
  try {
    validateFields(body, ['productKeys', 'expectedVersion']);
    const source = await loadSource();
    const productKeys = validateDisplayOrder(body.productKeys, source.items);
    return await sequelize.transaction(async transaction => {
      const setting = await getSetting({ transaction, lock: transaction.LOCK.UPDATE });
      checkVersion(setting, body.expectedVersion);
      await setting.update(
        {
          displayOrder: productKeys,
          version: setting.version + 1,
          updatedBy: actor.id,
        },
        { transaction }
      );
      return { version: setting.version, itemCount: productKeys.length };
    });
  } catch (error) {
    logger.debug('保存公开报价展示顺序失败', { errorType: error.name });
    throw error;
  }
}

/** 切换固定公开链接。 @param {number} actorId 管理员 @param {Object} body 请求 */
async function setAvailability(actorId, body) {
  try {
    validateFields(body, ['enabled', 'expectedVersion']);
    if (typeof body.enabled !== 'boolean') throw ApiError.badRequest('公开状态无效');
    return await sequelize.transaction(async transaction => {
      const setting = await getSetting({ transaction, lock: transaction.LOCK.UPDATE });
      checkVersion(setting, body.expectedVersion);
      await setting.update(
        {
          publicEnabled: body.enabled,
          version: setting.version + 1,
          updatedBy: actorId,
        },
        { transaction }
      );
      return {
        publicEnabled: setting.publicEnabled,
        version: setting.version,
        publicPath: '/quote/apple',
      };
    });
  } catch (error) {
    logger.debug('切换报价公开状态失败', { errorType: error.name });
    throw error;
  }
}

/** 批量覆盖选中商品调价。 @param {Object} actor 管理员 @param {Object} body 请求 */
async function saveAdjustments(actor, body) {
  try {
    validateFields(body, ['productKeys', 'percentage', 'fixedAmount', 'expectedVersion']);
    const productKeys = validateProductKeys(body.productKeys);
    const values = validateAdjustment(body.percentage, body.fixedAmount);
    const source = await loadSource();
    const sourceByKey = new Map(source.items.map(item => [item.productKey, item]));
    const selected = productKeys.map(key => sourceByKey.get(key));
    if (selected.some(item => !item)) throw ApiError.badRequest('包含已失效或不存在的商品');
    selected.forEach(item =>
      calculateQuotePrice(item.basePrice, values.percentage, values.fixedAmount)
    );
    return await sequelize.transaction(async transaction => {
      const setting = await getSetting({ transaction, lock: transaction.LOCK.UPDATE });
      checkVersion(setting, body.expectedVersion);
      const now = new Date();
      await Adjustment.bulkCreate(
        selected.map(item => ({
          productKey: item.productKey,
          productModel: item.productModel,
          storageGb: item.storageGb,
          color: item.color,
          percentage: values.percentage,
          fixedAmount: values.fixedAmount,
          updatedBy: actor.id,
          createdAt: now,
          updatedAt: now,
        })),
        {
          transaction,
          updateOnDuplicate: [
            'productModel',
            'storageGb',
            'color',
            'percentage',
            'fixedAmount',
            'updatedBy',
            'updatedAt',
          ],
        }
      );
      await setting.update({ version: setting.version + 1, updatedBy: actor.id }, { transaction });
      await saveVersion(transaction, setting, actor, 'bulk_adjust', {
        selectedCount: selected.length,
        sourceUpdatedAt: source.sourceUpdatedAt,
      });
      return { version: setting.version, selectedCount: selected.length };
    });
  } catch (error) {
    logger.debug('批量保存报价调整失败', { errorType: error.name });
    throw error;
  }
}

/** 恢复选中商品原价。 @param {Object} actor 管理员 @param {Object} body 请求 */
async function resetAdjustments(actor, body) {
  try {
    validateFields(body, ['productKeys', 'expectedVersion']);
    const productKeys = validateProductKeys(body.productKeys);
    return await sequelize.transaction(async transaction => {
      const setting = await getSetting({ transaction, lock: transaction.LOCK.UPDATE });
      checkVersion(setting, body.expectedVersion);
      const removedCount = await Adjustment.destroy({
        where: { productKey: { [Op.in]: productKeys } },
        transaction,
      });
      await setting.update({ version: setting.version + 1, updatedBy: actor.id }, { transaction });
      await saveVersion(transaction, setting, actor, 'reset', {
        selectedCount: productKeys.length,
        removedCount,
      });
      return { version: setting.version, selectedCount: productKeys.length, removedCount };
    });
  } catch (error) {
    logger.debug('恢复商品原价失败', { errorType: error.name });
    throw error;
  }
}

/** 读取最近调价版本元数据。 @param {Object} query 查询 @returns {Promise<Object>} 版本列表 */
async function listVersions(query = {}) {
  const allowed = ['limit'];
  if (Object.keys(query).some(key => !allowed.includes(key)))
    throw ApiError.badRequest('查询参数无效');
  const limit = Number(query.limit || DEFAULT_VERSION_LIMIT);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_VERSION_LIMIT) {
    throw ApiError.badRequest('版本数量无效');
  }
  const rows = await Version.findAll({
    attributes: ['id', 'revision', 'action', 'summary', 'actorName', 'createdAt'],
    order: [
      ['revision', 'DESC'],
      ['createdAt', 'DESC'],
    ],
    limit,
  });
  return {
    items: rows.map(row => ({
      id: row.id,
      revision: row.revision,
      action: row.action,
      summary: row.summary,
      actorName: row.actorName,
      createdAt: row.createdAt,
    })),
  };
}

/** 恢复历史调价快照。 @param {Object} actor 管理员 @param {string} id 版本ID @param {Object} body 请求 */
async function restoreVersion(actor, id, body) {
  try {
    validateFields(body, ['expectedVersion']);
    if (!/^[0-9a-f-]{36}$/i.test(id || '')) throw ApiError.badRequest('版本标识无效');
    return await sequelize.transaction(async transaction => {
      const setting = await getSetting({ transaction, lock: transaction.LOCK.UPDATE });
      checkVersion(setting, body.expectedVersion);
      const target = await Version.findByPk(id, { transaction });
      if (!target) throw ApiError.notFound('报价版本不存在');
      const snapshot = Array.isArray(target.snapshot) ? target.snapshot : null;
      if (!snapshot) throw ApiError.badRequest('报价版本快照无效');
      const restored = snapshot.map(row => ({
        productKey: row.productKey,
        productModel: row.productModel,
        storageGb: Number(row.storageGb),
        color: row.color,
        ...validateAdjustment(row.percentage, row.fixedAmount),
        updatedBy: actor.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      if (restored.some(row => !/^[a-f0-9]{40}$/.test(row.productKey || ''))) {
        throw ApiError.badRequest('报价版本快照无效');
      }
      await Adjustment.destroy({ where: {}, transaction });
      if (restored.length) await Adjustment.bulkCreate(restored, { transaction });
      await setting.update({ version: setting.version + 1, updatedBy: actor.id }, { transaction });
      await saveVersion(transaction, setting, actor, 'restore', {
        restoredFromRevision: target.revision,
        restoredCount: restored.length,
      });
      return {
        version: setting.version,
        restoredFromRevision: target.revision,
        restoredCount: restored.length,
      };
    });
  } catch (error) {
    logger.debug('恢复报价版本失败', { errorType: error.name });
    throw error;
  }
}

module.exports = {
  getPublicQuotes,
  getAdminQuotes,
  setAvailability,
  saveDisplayOrder,
  saveAdjustments,
  resetAdjustments,
  listVersions,
  restoreVersion,
};
