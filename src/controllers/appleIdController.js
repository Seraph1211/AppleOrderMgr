const { scopeOrderWhere } = require('../services/orderAccessService');
/* eslint-disable camelcase */
/**
 * Apple ID 控制器
 * @module controllers/appleIdController
 * @description Apple ID CRUD，含 order_count / recipient_count 聚合字段
 * @see docs/design/API设计.md
 */

const { Op } = require('sequelize');
const { sequelize, AppleId } = require('../models');
const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');
const { isValidEmail } = require('../utils/helpers');
const { ACCOUNT_STATUSES } = require('../constants/business');
const { paginatedResponse, parsePositiveInt } = require('../utils/apiResponse');
const { PERMISSIONS } = require('../constants/business');
const {
  assertPermission,
  validateSecurityQa,
  validateAccountText,
} = require('../utils/profileInput');
const { lockProfiles } = require('../services/profileBindingService');
const {
  rejectLegacyBindingFilters,
  rejectLegacyBindingFields,
} = require('../services/profileIndependence');

const MAX_BATCH_ACCOUNT_IDS = 5000;
const MAX_POSTGRES_INTEGER = 2147483647;
const MAX_ACCOUNT_NOTES_LENGTH = 10000;
const MAX_ACCOUNT_KEYWORD_LENGTH = 255;
const MAX_ACCOUNT_COUNTRY_LENGTH = 50;

/**
 * 把 AppleId 实例序列化为对外对象
 * @param {Object} appleId - Sequelize AppleId JSON 形态
 * @param {Object} stats - 统计数据 { orderCount, recipientCount, recipientNames, lastOrderDate }
 * @param {boolean} includePassword - 是否包含密码
 * @returns {Object} 对外对象
 */
function serializeAppleId(appleId, stats = {}, includePassword = false) {
  const result = {
    id: appleId.id,
    account_number: appleId.accountNumber,
    apple_id: appleId.appleId,
    notes: appleId.notes,
    country: appleId.country,
    status: appleId.status,
    order_count: stats.orderCount ?? 0,
    last_order_date: stats.lastOrderDate ?? null,
    created_at: appleId.createdAt,
    updated_at: appleId.updatedAt,
  };

  if (includePassword) {
    result.password = appleId.password;
  }

  return result;
}

/** 列表与筛选全选共用筛选校验及查询条件，不读取任何凭据。 */
function buildAppleIdWhere(query = {}) {
  rejectLegacyBindingFilters(query);
  for (const [field, maxLength] of [
    ['keyword', MAX_ACCOUNT_KEYWORD_LENGTH],
    ['country', MAX_ACCOUNT_COUNTRY_LENGTH],
  ]) {
    if (
      query[field] !== undefined &&
      (typeof query[field] !== 'string' || query[field].length > maxLength)
    ) {
      throw ApiError.badRequest(`${field} 必须是有效长度的字符串`);
    }
  }
  const where = {};
  if (query.status !== undefined && typeof query.status !== 'string') {
    throw ApiError.badRequest('status 必须是字符串');
  }
  if (query.status) {
    if (!ACCOUNT_STATUSES.includes(query.status)) {
      throw ApiError.badRequest(`Apple ID 状态非法，可选值: ${ACCOUNT_STATUSES.join(', ')}`);
    }
    where.status = query.status;
  }
  if (query.country) where.country = query.country;
  const keyword = query.keyword?.trim();
  if (keyword) where.appleId = { [Op.iLike]: `%${keyword}%` };
  return where;
}

/**
 * 查询全库账号状态统计，已知状态补零并保留未知存量状态。
 * @param {Object} req - Express 请求
 * @param {Object} res - Express 响应
 * @returns {Promise<void>} 全库总量及各状态数量
 */
async function getAppleIdStatistics(req, res) {
  res.set('Cache-Control', 'no-store');
  try {
    assertPermission(req, PERMISSIONS.APPLE_IDS_READ);
    const rows = await AppleId.findAll({
      attributes: ['status', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
      group: ['status'],
      order: [['status', 'ASC']],
      raw: true,
    });
    const counts = new Map(ACCOUNT_STATUSES.map(status => [status, 0]));
    for (const row of rows) counts.set(row.status, Number(row.count));
    const statuses = Array.from(counts, ([status, count]) => ({ status, count }));
    const total = statuses.reduce((sum, item) => sum + item.count, 0);
    res.json({ success: true, data: { total, statuses } });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('查询 Apple ID 状态统计失败', { errorType: error.name });
    throw ApiError.database('查询 Apple ID 状态统计失败');
  }
}

/**
 * 查询筛选结果的完整内部 ID 集合，超过批量操作上限时整批拒绝。
 * @param {Object} req - Express 请求
 * @param {Object} res - Express 响应
 * @returns {Promise<void>} 按内部 ID 倒序的选择集合与数量
 */
async function getAppleIdSelectionIds(req, res) {
  res.set('Cache-Control', 'no-store');
  try {
    assertPermission(req, PERMISSIONS.APPLE_IDS_READ);
    const query = req.query || {};
    if (Object.keys(query).some(key => !['keyword', 'status', 'country'].includes(key))) {
      throw ApiError.badRequest('筛选全选仅支持 keyword、status、country 参数');
    }
    const rows = await AppleId.findAll({
      attributes: ['id'],
      where: buildAppleIdWhere(query),
      order: [['id', 'DESC']],
      limit: MAX_BATCH_ACCOUNT_IDS + 1,
      raw: true,
    });
    if (rows.length > MAX_BATCH_ACCOUNT_IDS) {
      throw ApiError.badRequest(
        '筛选结果超过 5000 个账号，请缩小筛选范围后再全选',
        undefined,
        'APPLE_ID_SELECTION_LIMIT_EXCEEDED'
      );
    }
    res.json({ success: true, data: { ids: rows.map(row => row.id), total: rows.length } });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('查询 Apple ID 选择集合失败', { errorType: error.name });
    throw ApiError.database('查询 Apple ID 选择集合失败');
  }
}

/**
 * GET /api/apple-ids?page=1&limit=20&status=active&keyword=xxx
 */
async function listAppleIds(req, res) {
  try {
    const page = parsePositiveInt(req.query.page, { defaultValue: 1, min: 1, max: 100000 });
    const limit = parsePositiveInt(req.query.limit, { defaultValue: 20, min: 1, max: 100 });

    const where = buildAppleIdWhere(req.query);

    const { count, rows } = await AppleId.findAndCountAll({
      where,
      order: [['id', 'DESC']],
      limit,
      offset: (page - 1) * limit,
      distinct: true,
    });

    // 聚合每个 Apple ID 的订单数、收件人数、最后下单日期（一次性 in 查询，避免 N+1）
    const ids = rows.map(r => r.id);
    const orderStats = await getOrderStatsByAppleIds(ids, req.user);
    const includePassword = Boolean(req.user?.permissions?.includes(PERMISSIONS.APPLE_IDS_READ));
    res.set('Cache-Control', 'no-store');

    res.json(
      paginatedResponse(
        rows.map(row =>
          serializeAppleId(
            row.toJSON(),
            {
              orderCount: orderStats[row.id]?.orderCount || 0,
              lastOrderDate: orderStats[row.id]?.lastOrderDate || null,
            },
            includePassword
          )
        ),
        count,
        page,
        limit,
        'apple_ids'
      )
    );
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('查询 Apple ID 列表失败', { error: error.message });
    throw ApiError.database('查询 Apple ID 列表失败', { reason: error.message });
  }
}

/**
 * 在 apple_ids 列表中按 id 聚合 Order 统计，避免 N+1
 * @param {number[]} ids - Apple ID 列表
 * @returns {Promise<Object>} { [id]: { orderCount, lastOrderDate } }
 */
async function getOrderStatsByAppleIds(ids, user) {
  if (!user?.permissions?.includes(PERMISSIONS.ORDERS_READ) || ids.length === 0) return {};
  const { Order } = require('../models');
  const rows = await Order.findAll({
    attributes: [
      'appleIdRef',
      [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
      [
        sequelize.fn(
          'MAX',
          sequelize.fn('COALESCE', sequelize.col('order_date'), sequelize.col('created_at'))
        ),
        'lastOrderDate',
      ],
    ],
    where: scopeOrderWhere(user, { appleIdRef: { [Op.in]: ids } }),
    group: ['appleIdRef'],
    raw: true,
  });
  const out = {};
  rows.forEach(r => {
    out[r.appleIdRef] = {
      orderCount: parseInt(r.count, 10),
      lastOrderDate: r.lastOrderDate,
    };
  });
  return out;
}

/**
 * GET /api/apple-ids/:id
 */
async function getAppleIdDetail(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id) || id <= 0) {
      throw ApiError.badRequest('Apple ID 必须是正整数', { received: req.params.id });
    }

    const appleId = await AppleId.findByPk(id);
    if (!appleId) {
      throw ApiError.notFound('Apple ID 不存在', { id });
    }

    const orderStats = await getOrderStatsByAppleIds([id], req.user);

    const includePassword = Boolean(req.user?.permissions?.includes(PERMISSIONS.APPLE_IDS_READ));
    res.set('Cache-Control', 'no-store');
    const plain = appleId.toJSON();
    if (!includePassword) delete plain.password;
    const includeSecrets = req.query?.includeSecrets === 'true';
    if (includeSecrets) assertPermission(req, PERMISSIONS.APPLE_IDS_SECRETS_READ);
    const securityQa = includeSecrets ? plain.securityQa : undefined;
    delete plain.securityQa;
    res.json({
      success: true,
      data: {
        ...serializeAppleId(
          plain,
          {
            orderCount: orderStats[id]?.orderCount || 0,
            lastOrderDate: orderStats[id]?.lastOrderDate || null,
          },
          includePassword
        ),
        ...(includeSecrets ? { security_qa: securityQa } : {}),
      },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('查询 Apple ID 详情失败', { id: req.params.id, error: error.message });
    throw ApiError.database('查询 Apple ID 详情失败', { reason: error.message });
  }
}

/**
 * POST /api/apple-ids
 * body: { apple_id, password, nickname?, country?, status? }
 */
async function createAppleId(req, res) {
  try {
    rejectAccountNumberInput(req.body);
    rejectLegacyBindingFields(req.body || {}, true);
    const { apple_id, password, notes, country, status, security_qa } = req.body || {};

    validateAccountText({ appleId: apple_id, password, notes, country });
    const originalAppleId = typeof apple_id === 'string' ? apple_id.trim() : apple_id;
    if (!isValidEmail(originalAppleId)) {
      throw ApiError.badRequest('apple_id 必须是合法邮箱', { received: apple_id });
    }
    if (!password || typeof password !== 'string' || password.length === 0) {
      throw ApiError.badRequest('password 不能为空');
    }
    if (status && !ACCOUNT_STATUSES.includes(status)) {
      throw ApiError.badRequest(`status 非法，可选值: ${ACCOUNT_STATUSES.join(', ')}`, {
        received: status,
      });
    }

    const created = await sequelize.transaction(async transaction => {
      await lockProfiles(transaction, req.user?.id);
      const normalized = originalAppleId.toLowerCase();
      const existing = await AppleId.findOne({
        where: sequelize.where(
          sequelize.fn('lower', sequelize.fn('trim', sequelize.col('apple_id'))),
          normalized
        ),
        transaction,
      });
      if (existing) throw ApiError.conflict('该 Apple ID 已存在');
      return AppleId.create(
        {
          appleId: originalAppleId,
          password,
          notes: notes || null,
          country: country || '中国',
          status: status || '未使用',
          securityQa: validateSecurityQa(security_qa),
        },
        { transaction }
      );
    });

    logger.info('Apple ID 创建成功', { id: created.id });

    const plain = created.toJSON();
    delete plain.password;
    delete plain.securityQa;

    res.status(201).json({
      success: true,
      data: serializeAppleId(plain, { orderCount: 0, recipientCount: 0 }),
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (error.name === 'SequelizeUniqueConstraintError') {
      throw ApiError.conflict('该 Apple ID 已存在');
    }
    logger.error('创建 Apple ID 失败', { error: error.message });
    throw ApiError.database('创建 Apple ID 失败', { reason: error.message });
  }
}

/**
 * PUT /api/apple-ids/:id
 */
async function updateAppleId(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id) || id <= 0) {
      throw ApiError.badRequest('Apple ID 必须是正整数', { received: req.params.id });
    }

    rejectAccountNumberInput(req.body);
    rejectLegacyBindingFields(req.body || {}, true);
    const { password, notes, country, status, security_qa } = req.body || {};

    validateAccountText({ password, notes, country });
    if (status !== undefined && !ACCOUNT_STATUSES.includes(status)) {
      throw ApiError.badRequest(`status 非法，可选值: ${ACCOUNT_STATUSES.join(', ')}`, {
        received: status,
      });
    }
    if (password !== undefined && (typeof password !== 'string' || password.length === 0)) {
      throw ApiError.badRequest('password 必须是非空字符串');
    }

    const appleId = await AppleId.findByPk(id);
    if (!appleId) {
      throw ApiError.notFound('Apple ID 不存在', { id });
    }

    const updates = {};
    if (password !== undefined) updates.password = password;
    if (notes !== undefined) {
      if (notes !== null && (typeof notes !== 'string' || notes.length > MAX_ACCOUNT_NOTES_LENGTH))
        throw ApiError.badRequest('备注长度无效');
      updates.notes = notes;
    }
    if (country !== undefined) updates.country = country;
    if (status !== undefined) updates.status = status;
    if (security_qa !== undefined) {
      assertPermission(req, PERMISSIONS.APPLE_IDS_SECRETS_READ);
      updates.securityQa = validateSecurityQa(security_qa);
    }
    await sequelize.transaction(async transaction => {
      await lockProfiles(transaction, req.user?.id);
      await appleId.update(updates, { transaction });
    });

    logger.info('Apple ID 更新成功', { id, fields: Object.keys(updates) });

    const plain = appleId.toJSON();
    delete plain.password;
    delete plain.securityQa;
    res.json({
      success: true,
      data: serializeAppleId(plain),
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('更新 Apple ID 失败', { id: req.params.id, error: error.message });
    throw ApiError.database('更新 Apple ID 失败', { reason: error.message });
  }
}

/**
 * DELETE /api/apple-ids/:id
 */
async function deleteAppleId(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id) || id <= 0) {
      throw ApiError.badRequest('Apple ID 必须是正整数', { received: req.params.id });
    }

    const appleId = await AppleId.findByPk(id);
    if (!appleId) {
      throw ApiError.notFound('Apple ID 不存在', { id });
    }

    await sequelize.transaction(async transaction => {
      await lockProfiles(transaction, req.user?.id);
      await appleId.destroy({ transaction });
    });

    logger.info('Apple ID 删除成功', { id });

    res.json({
      success: true,
      message: 'Apple ID 已删除',
      data: { id },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('删除 Apple ID 失败', { id: req.params.id, error: error.message });
    throw ApiError.database('删除 Apple ID 失败', { reason: error.message });
  }
}

/** 账号编号是只读字段，拒绝手动创建或修改。 */
function rejectAccountNumberInput(body) {
  if (body && ['account_number', 'accountNumber'].some(key => Object.hasOwn(body, key))) {
    throw ApiError.badRequest('账号编号由系统自动分配，不允许手动设置或修改');
  }
}

/** 验证批量请求的字段和数据库 ID，不接受字符串、重复值或额外字段。 */
function validateBatchInput(body, allowedFields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw ApiError.badRequest('请求必须是对象');
  }
  if (Object.keys(body).some(key => !allowedFields.includes(key))) {
    throw ApiError.badRequest('请求包含不允许的字段');
  }
  if (
    !Array.isArray(body.ids) ||
    body.ids.length < 1 ||
    body.ids.length > MAX_BATCH_ACCOUNT_IDS ||
    body.ids.some(id => !Number.isInteger(id) || id <= 0 || id > MAX_POSTGRES_INTEGER) ||
    new Set(body.ids).size !== body.ids.length
  ) {
    throw ApiError.badRequest('ids 必须包含 1 至 5000 个不重复的正整数 ID');
  }
  return body.ids;
}

/**
 * 原子更新选中账号的状态和备注，只修改显式提交的字段。
 * @param {Object} req - Express 请求
 * @param {Object} res - Express 响应
 * @returns {Promise<void>} 更新数量
 */
async function batchUpdateAppleIds(req, res) {
  try {
    assertPermission(req, PERMISSIONS.APPLE_IDS_EDIT);
    const ids = validateBatchInput(req.body, ['ids', 'status', 'notes']);
    const updates = {};
    if (Object.hasOwn(req.body, 'status')) {
      if (!ACCOUNT_STATUSES.includes(req.body.status)) {
        throw ApiError.badRequest('status 必须是：未使用、使用中、已下架或异常');
      }
      updates.status = req.body.status;
    }
    if (Object.hasOwn(req.body, 'notes')) {
      if (
        req.body.notes !== null &&
        (typeof req.body.notes !== 'string' || req.body.notes.length > MAX_ACCOUNT_NOTES_LENGTH)
      ) {
        throw ApiError.badRequest('notes 必须是字符串或 null，长度不能超过 10000');
      }
      updates.notes = req.body.notes;
    }
    if (!Object.keys(updates).length) {
      throw ApiError.badRequest('必须提供 status 或 notes');
    }
    await sequelize.transaction(async transaction => {
      await lockProfiles(transaction, req.user?.id);
      const rows = await AppleId.findAll({
        attributes: ['id'],
        where: { id: { [Op.in]: ids } },
        order: [['id', 'ASC']],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (rows.length !== ids.length) {
        throw ApiError.notFound('部分 Apple ID 不存在，未更新任何账号');
      }
      await AppleId.update(updates, {
        where: { id: { [Op.in]: ids } },
        fields: Object.keys(updates),
        transaction,
      });
    });
    logger.info('批量更新 Apple ID 成功', {
      actorId: req.user?.id,
      count: ids.length,
      fields: Object.keys(updates),
    });
    res.json({ success: true, data: { updated: ids.length } });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('批量更新 Apple ID 失败', { errorType: error.name, actorId: req.user?.id });
    throw ApiError.database('批量更新 Apple ID 失败');
  }
}

/**
 * 按账号编号生成外部导入文本，逗号或换行无法无歧义表示时整批拒绝。
 * @param {Object} req - Express 请求
 * @param {Object} res - Express 响应
 * @returns {Promise<void>} 账号数量及导入文本
 */
async function copyImportAppleIds(req, res) {
  res.set('Cache-Control', 'no-store');
  try {
    assertPermission(req, PERMISSIONS.APPLE_IDS_READ);
    const ids = validateBatchInput(req.body, ['ids']);
    const rows = await AppleId.findAll({
      attributes: ['id', 'accountNumber', 'appleId', 'password'],
      where: { id: { [Op.in]: ids } },
      order: [['accountNumber', 'ASC']],
    });
    if (rows.length !== ids.length) {
      throw ApiError.notFound('部分 Apple ID 不存在，未生成导入文本');
    }
    const lines = rows.map(row => {
      const { appleId, password } = row;
      if (
        typeof appleId !== 'string' ||
        typeof password !== 'string' ||
        /[,\r\n]/.test(appleId) ||
        /[,\r\n]/.test(password)
      ) {
        throw ApiError.badRequest('账号或密码包含逗号或换行等不支持的格式，无法复制导入');
      }
      return `${appleId},${password},`;
    });
    res.json({ success: true, data: { count: rows.length, text: lines.join('\n') } });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('生成 Apple ID 导入文本失败', {
      errorType: error.name,
      actorId: req.user?.id,
    });
    throw ApiError.database('生成 Apple ID 导入文本失败');
  }
}

module.exports = {
  getAppleIdStatistics,
  getAppleIdSelectionIds,
  batchUpdateAppleIds,
  copyImportAppleIds,
  listAppleIds,
  getAppleIdDetail,
  createAppleId,
  updateAppleId,
  deleteAppleId,
};
