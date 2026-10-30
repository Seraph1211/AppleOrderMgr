const { notifyDuoQuoteVersion } = require('./duoQuoteEvents');
const { randomUUID } = require('crypto');
const {
  sequelize,
  DuoQuotePricingSetting: Setting,
  DuoQuotePriceAdjustment: Adjustment,
  DuoQuotePricingVersion: Version,
} = require('../models');
const sourceRepository = require('../repositories/quoteSourceRepository');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const {
  DEFAULT_MARKUP,
  MAX_PRICE_CENTS,
  moneyToCents,
  normalizeDuoSource,
  createSourceVersion,
  validateMarkup,
  mergeDuoItems,
  sourceFreshness,
  sourceUnavailable,
} = require('./duoQuotePricingCore');

function validateFields(body, allowed) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some(key => !allowed.includes(key))
  )
    throw ApiError.badRequest('请求字段无效');
}

function checkVersions(setting, source, body) {
  if (
    !Number.isSafeInteger(body.expectedVersion) ||
    body.expectedVersion < 0 ||
    typeof body.expectedSourceVersion !== 'string' ||
    !/^[a-f0-9]{64}$/.test(body.expectedSourceVersion)
  ) {
    throw ApiError.badRequest('报价版本或来源版本无效');
  }
  if (setting.version !== body.expectedVersion)
    throw new ApiError(409, 'CONCURRENT_MODIFICATION', '报价设置已更新，请刷新后重试', {
      currentVersion: setting.version,
    });
  if (source.sourceVersion !== body.expectedSourceVersion)
    throw new ApiError(409, 'DUO_SOURCE_CHANGED', '来源报价已变化，请刷新后重新核对');
}

async function loadSource() {
  try {
    const batch = await sourceRepository.fetchLatestDuoBatch();
    const items = normalizeDuoSource(batch);
    return { ...batch, items, sourceVersion: createSourceVersion(batch, items) };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('读取Duo调价来源失败', { errorType: error.name, errorCode: error.code || null });
    throw sourceUnavailable();
  }
}

async function getSetting(transaction, lock) {
  try {
    const setting = await Setting.findByPk(1, { transaction, lock });
    if (!setting) throw new ApiError(503, 'DUO_PRICING_NOT_MIGRATED', 'Duo报价功能尚未初始化');
    return setting;
  } catch (error) {
    if (error.original?.code === '42P01') {
      throw new ApiError(503, 'DUO_PRICING_NOT_MIGRATED', 'Duo报价功能尚未初始化');
    }
    throw error;
  }
}

function quoteTimestamp(source, setting) {
  return setting.pricingUpdatedAt &&
    new Date(setting.pricingUpdatedAt) > new Date(source.sourceUpdatedAt)
    ? setting.pricingUpdatedAt
    : source.sourceUpdatedAt;
}

function snapshotItems(items) {
  return items.map(item => ({
    productKey: item.productKey,
    productModel: item.productModel,
    storageGb: item.storageGb,
    color: item.color,
    markup: item.markup,
  }));
}

function validateSelection(value, sourceItems) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 8 ||
    new Set(value).size !== value.length ||
    value.some(key => typeof key !== 'string' || !sourceItems.some(item => item.productKey === key))
  )
    throw ApiError.badRequest('请选择1至8个有效且不重复的Duo商品');
  return new Set(value);
}

function parseRequest(operation, body) {
  const versions = ['expectedVersion', 'expectedSourceVersion'];
  if (operation === 'adjust') validateFields(body, [...versions, 'productKeys', 'mode', 'amount']);
  else if (operation === 'reset') validateFields(body, [...versions, 'productKeys']);
  else if (operation === 'restore') validateFields(body, [...versions, 'versionId']);
  else throw ApiError.badRequest('预览操作无效');
  if (operation === 'adjust') {
    if (!['markup', 'retail'].includes(body.mode))
      throw ApiError.badRequest('请选择加价额或零售价输入方式');
    const cents = moneyToCents(body.amount);
    if (body.mode === 'retail' && (cents < 0 || cents > MAX_PRICE_CENTS))
      throw ApiError.badRequest('零售价超出允许范围');
    if (body.mode === 'markup') validateMarkup(body.amount);
  }
  if (
    operation === 'restore' &&
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.versionId || '')
  ) {
    throw ApiError.badRequest('历史版本标识无效');
  }
}

async function buildPlan(operation, body, source, currentItems, transaction) {
  try {
    let selected;
    let restoredFromRevision;
    const nextMarkups = new Map();
    if (operation === 'restore') {
      const target = await Version.findByPk(body.versionId, { transaction });
      if (!target) throw ApiError.notFound('Duo报价版本不存在');
      if (!Array.isArray(target.snapshot) || target.snapshot.length !== 8)
        throw ApiError.badRequest('历史加价快照不完整');
      selected = validateSelection(
        target.snapshot.map(row => row.productKey),
        source.items
      );
      target.snapshot.forEach(row => {
        const item = source.items.find(candidate => candidate.productKey === row.productKey);
        if (
          row.productModel !== item.productModel ||
          row.storageGb !== item.storageGb ||
          row.color !== item.color
        ) {
          throw ApiError.badRequest('历史加价快照身份无效');
        }
        nextMarkups.set(row.productKey, validateMarkup(row.markup));
      });
      restoredFromRevision = target.revision;
    } else {
      selected = validateSelection(body.productKeys, source.items);
      source.items
        .filter(item => selected.has(item.productKey))
        .forEach(item => {
          let markup = DEFAULT_MARKUP;
          if (operation === 'adjust' && body.mode === 'retail') {
            if (item.wholesalePrice === null)
              throw new ApiError(
                400,
                'DUO_BASE_PRICE_REQUIRED',
                '缺少批发价，无法按零售价换算加价'
              );
            markup = (moneyToCents(body.amount) - moneyToCents(item.wholesalePrice)) / 100;
          } else if (operation === 'adjust') markup = body.amount;
          nextMarkups.set(item.productKey, validateMarkup(markup));
        });
    }
    const rules = currentItems.map(item => ({
      productKey: item.productKey,
      markup: nextMarkups.get(item.productKey) ?? item.markup,
    }));
    const nextItems = mergeDuoItems(source.items, rules, { allowInvalid: true });
    if (nextItems.some(item => selected.has(item.productKey) && item.pricingError)) {
      throw ApiError.badRequest('调整后的零售价超出允许范围');
    }
    const items = nextItems.map((item, index) => ({
      ...item,
      previousMarkup: currentItems[index].markup,
      previousRetailPrice: currentItems[index].retailPrice,
      selected: selected.has(item.productKey),
    }));
    const changes = items
      .filter(item => item.markup !== item.previousMarkup)
      .map(item => ({
        productKey: item.productKey,
        storageGb: item.storageGb,
        color: item.color,
        previousMarkup: item.previousMarkup,
        markup: item.markup,
        wholesalePrice: item.wholesalePrice,
        previousRetailPrice: item.previousRetailPrice,
        retailPrice: item.retailPrice,
      }));
    return { items, selected, changes, restoredFromRevision };
  } catch (error) {
    logger.debug('Duo报价处理失败', { errorType: error.name });
    throw error;
  }
}

/** 读取管理员Duo报价与双版本。 @returns {Promise<Object>} 管理报价 */
async function getAdminQuotes() {
  try {
    const source = await loadSource();
    return await sequelize.transaction(async transaction => {
      const setting = await getSetting(transaction, transaction.LOCK.SHARE);
      const adjustments = await Adjustment.findAll({ transaction });
      return {
        version: setting.version,
        sourceVersion: source.sourceVersion,
        sourceUpdatedAt: source.sourceUpdatedAt,
        updatedAt: quoteTimestamp(source, setting),
        pricingUpdatedAt: setting.pricingUpdatedAt || null,
        ...sourceFreshness(source),
        defaultMarkup: DEFAULT_MARKUP,
        publicEnabled: process.env.QUOTE_DUO_PUBLIC_ENABLED === 'true',
        publicPath: '/quote/duo',
        items: mergeDuoItems(source.items, adjustments, { allowInvalid: true }),
      };
    });
  } catch (error) {
    logger.debug('读取Duo管理报价失败', { errorType: error.name });
    throw error;
  }
}

async function executeOperation(actor, operation, body, write) {
  try {
    parseRequest(operation, body);
    return await sequelize.transaction(async transaction => {
      const setting = await getSetting(
        transaction,
        write ? transaction.LOCK.UPDATE : transaction.LOCK.SHARE
      );
      const source = await loadSource();
      checkVersions(setting, source, body);
      const adjustments = await Adjustment.findAll({ transaction });
      const currentItems = mergeDuoItems(source.items, adjustments, { allowInvalid: true });
      const plan = await buildPlan(operation, body, source, currentItems, transaction);
      if (!write)
        return {
          version: setting.version,
          sourceVersion: source.sourceVersion,
          sourceUpdatedAt: source.sourceUpdatedAt,
          selectedCount: plan.selected.size,
          items: plan.items,
        };
      const now = new Date();
      await Adjustment.bulkCreate(
        snapshotItems(plan.items)
          .filter(item => plan.selected.has(item.productKey))
          .map(item => ({
            ...item,
            updatedBy: actor.id,
            createdAt: now,
            updatedAt: now,
          })),
        { transaction, updateOnDuplicate: ['markup', 'updatedBy', 'updatedAt'] }
      );
      await setting.update(
        { version: setting.version + 1, updatedBy: actor.id, pricingUpdatedAt: now },
        { transaction }
      );
      await Version.create(
        {
          id: randomUUID(),
          revision: setting.version,
          action: operation,
          snapshot: snapshotItems(plan.items),
          summary: {
            sourceVersion: source.sourceVersion,
            sourceUpdatedAt: source.sourceUpdatedAt,
            selectedCount: plan.selected.size,
            mode: body.mode || null,
            changes: plan.changes,
            ...(plan.restoredFromRevision
              ? { restoredFromRevision: plan.restoredFromRevision }
              : {}),
          },
          actorUserId: actor.id,
          actorName: String(actor.nickname || actor.username || '管理员').slice(0, 100),
          createdAt: now,
        },
        { transaction }
      );
      const latestSource = await loadSource();
      checkVersions({ version: body.expectedVersion }, latestSource, body);
      await notifyDuoQuoteVersion(transaction, setting.version);
      return { version: setting.version, selectedCount: plan.selected.size };
    });
  } catch (error) {
    logger.debug('Duo调价操作失败', { operation, write, errorType: error.name });
    throw error;
  }
}

/** 预览调价／重置／恢复，不修改规则或历史。 @param {Object} body 请求 @returns {Promise<Object>} 预览 */
async function preview(body) {
  try {
    validateFields(body, [
      'operation',
      'productKeys',
      'mode',
      'amount',
      'versionId',
      'expectedVersion',
      'expectedSourceVersion',
    ]);
    const { operation, ...input } = body;
    return await executeOperation(null, operation, input, false);
  } catch (error) {
    logger.debug('Duo报价处理失败', { errorType: error.name });
    throw error;
  }
}

/** 保存逐款或批量加价。 @param {Object} actor 管理员 @param {Object} body 请求 @returns {Promise<Object>} 新版本 */
async function saveAdjustments(actor, body) {
  try {
    return await executeOperation(actor, 'adjust', body, true);
  } catch (error) {
    logger.debug('Duo报价处理失败', { errorType: error.name });
    throw error;
  }
}

/** 重置选中Duo为默认加价50。 @param {Object} actor 管理员 @param {Object} body 请求 @returns {Promise<Object>} 新版本 */
async function resetAdjustments(actor, body) {
  try {
    return await executeOperation(actor, 'reset', body, true);
  } catch (error) {
    logger.debug('Duo报价处理失败', { errorType: error.name });
    throw error;
  }
}

/** 恢复完整8款历史加价并用当前基价重算。 @param {Object} actor 管理员 @param {string} id 历史id @param {Object} body 请求 @returns {Promise<Object>} 新版本 */
async function restoreVersion(actor, id, body) {
  try {
    validateFields(body, ['expectedVersion', 'expectedSourceVersion']);
    return await executeOperation(actor, 'restore', { ...body, versionId: id }, true);
  } catch (error) {
    logger.debug('Duo报价处理失败', { errorType: error.name });
    throw error;
  }
}

/** 分页读取Duo加价历史及完整快照。 @param {Object} query 分页参数 @returns {Promise<Object>} 历史 */
async function listVersions(query = {}) {
  try {
    validateFields(query, ['limit', 'offset']);
    const parsePage = (value, fallback) => {
      if (value === undefined) return fallback;
      if (!/^\d+$/.test(String(value))) throw ApiError.badRequest('历史分页参数无效');
      return Number(value);
    };
    const limit = parsePage(query.limit, 20);
    const offset = parsePage(query.offset, 0);
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    ) {
      throw ApiError.badRequest('历史分页参数无效');
    }
    const result = await Version.findAndCountAll({ order: [['revision', 'DESC']], limit, offset });
    return {
      total: result.count,
      limit,
      offset,
      items: result.rows.map(row => ({
        id: row.id,
        revision: row.revision,
        action: row.action,
        summary: row.summary,
        changes: row.summary.changes || [],
        actorName: row.actorName,
        createdAt: row.createdAt,
        snapshot: row.snapshot,
      })),
    };
  } catch (error) {
    logger.debug('Duo报价处理失败', { errorType: error.name });
    throw error;
  }
}

module.exports = {
  getAdminQuotes,
  preview,
  saveAdjustments,
  resetAdjustments,
  listVersions,
  restoreVersion,
};
