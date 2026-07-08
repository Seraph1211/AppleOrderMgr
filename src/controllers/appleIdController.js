/* eslint-disable camelcase */
/**
 * Apple ID 控制器
 * @module controllers/appleIdController
 * @description Apple ID CRUD，含 order_count / recipient_count 聚合字段
 * @see docs/05-API接口设计方案.md 3.1
 */

const { Op } = require('sequelize');
const { sequelize, AppleId } = require('../models');
const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');
const { isValidEmail } = require('../utils/helpers');
const {
  paginatedResponse,
  parsePositiveInt,
} = require('../utils/apiResponse');

const APPLE_ID_STATUSES = ['active', 'inactive', 'locked'];

/**
 * 把 AppleId 实例序列化为对外对象
 * @param {Object} appleId - Sequelize AppleId JSON 形态
 * @returns {Object} 对外对象
 */
function serializeAppleId(appleId, counts = {}) {
  return {
    id: appleId.id,
    apple_id: appleId.appleId,
    nickname: appleId.nickname,
    country: appleId.country,
    is_modified: appleId.isModified,
    status: appleId.status,
    order_count: counts.orderCount ?? 0,
    recipient_count: counts.recipientCount ?? 0,
    created_at: appleId.createdAt,
    updated_at: appleId.updatedAt,
  };
}

/**
 * GET /api/apple-ids?page=1&limit=20&status=active&keyword=xxx
 */
async function listAppleIds(req, res) {
  try {
    const page = parsePositiveInt(req.query.page, { defaultValue: 1, min: 1, max: 100000 });
    const limit = parsePositiveInt(req.query.limit, { defaultValue: 20, min: 1, max: 100 });

    const where = {};
    if (req.query.status) {
      if (!APPLE_ID_STATUSES.includes(req.query.status)) {
        throw ApiError.badRequest(
          `Apple ID 状态非法，可选值: ${APPLE_ID_STATUSES.join(', ')}`,
          { received: req.query.status },
        );
      }
      where.status = req.query.status;
    }
    if (req.query.keyword) {
      const kw = String(req.query.keyword).trim();
      if (kw.length > 0) {
        where[Op.or] = [
          { appleId: { [Op.iLike]: `%${kw}%` } },
          { nickname: { [Op.iLike]: `%${kw}%` } },
        ];
      }
    }

    const { count, rows } = await AppleId.findAndCountAll({
      where,
      order: [['id', 'DESC']],
      limit,
      offset: (page - 1) * limit,
      distinct: true,
    });

    // 聚合每个 Apple ID 的订单数和收件人数（一次性 in 查询，避免 N+1）
    const ids = rows.map((r) => r.id);
    const orderCounts = await getOrderCountsByAppleIds(ids);
    const recipientCounts = await getRecipientCountsByAppleIds(ids);

    res.json(paginatedResponse(
      rows.map((row) => serializeAppleId(row.toJSON(), {
        orderCount: orderCounts[row.id] || 0,
        recipientCount: recipientCounts[row.id] || 0,
      })),
      count,
      page,
      limit,
      'apple_ids',
    ));
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('查询 Apple ID 列表失败', { error: error.message });
    throw ApiError.database('查询 Apple ID 列表失败', { reason: error.message });
  }
}

/**
 * 在 apple_ids 列表中按 id 聚合 Order/Recipient 数量，避免 N+1
 * @param {number[]} ids - Apple ID 列表
 * @returns {Promise<Object>} { [id]: count }
 */
async function getOrderCountsByAppleIds(ids) {
  if (ids.length === 0) return {};
  const { Order } = require('../models');
  const rows = await Order.findAll({
    attributes: [
      'appleIdRef',
      [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
    ],
    where: { appleIdRef: { [Op.in]: ids } },
    group: ['appleIdRef'],
    raw: true,
  });
  const out = {};
  rows.forEach((r) => {
    out[r.appleIdRef] = parseInt(r.count, 10);
  });
  return out;
}

/**
 * @param {number[]} ids - Apple ID 列表
 * @returns {Promise<Object>} { [id]: count }
 */
async function getRecipientCountsByAppleIds(ids) {
  if (ids.length === 0) return {};
  const { Recipient } = require('../models');
  const rows = await Recipient.findAll({
    attributes: [
      'appleIdRef',
      [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
    ],
    where: { appleIdRef: { [Op.in]: ids } },
    group: ['appleIdRef'],
    raw: true,
  });
  const out = {};
  rows.forEach((r) => {
    out[r.appleIdRef] = parseInt(r.count, 10);
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

    const orderCounts = await getOrderCountsByAppleIds([id]);
    const recipientCounts = await getRecipientCountsByAppleIds([id]);

    // 安全设计：密码不返回
    const plain = appleId.toJSON();
    delete plain.password;
    delete plain.securityQa;

    res.json({
      success: true,
      data: serializeAppleId({ ...plain, password: undefined }, {
        orderCount: orderCounts[id] || 0,
        recipientCount: recipientCounts[id] || 0,
      }),
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
    const { apple_id, password, nickname, country, status } = req.body || {};

    if (!isValidEmail(apple_id)) {
      throw ApiError.badRequest('apple_id 必须是合法邮箱', { received: apple_id });
    }
    if (!password || typeof password !== 'string' || password.length === 0) {
      throw ApiError.badRequest('password 不能为空');
    }
    if (status && !APPLE_ID_STATUSES.includes(status)) {
      throw ApiError.badRequest(
        `status 非法，可选值: ${APPLE_ID_STATUSES.join(', ')}`,
        { received: status },
      );
    }

    const existing = await AppleId.findOne({ where: { appleId: apple_id } });
    if (existing) {
      throw ApiError.conflict('该 Apple ID 已存在', { apple_id });
    }

    const created = await AppleId.create({
      appleId: apple_id,
      password,
      nickname: nickname || null,
      country: country || null,
      status: status || 'active',
    });

    logger.info('Apple ID 创建成功', { id: created.id, apple_id });

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

    const { password, nickname, country, status } = req.body || {};

    if (status !== undefined && !APPLE_ID_STATUSES.includes(status)) {
      throw ApiError.badRequest(
        `status 非法，可选值: ${APPLE_ID_STATUSES.join(', ')}`,
        { received: status },
      );
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
    if (nickname !== undefined) updates.nickname = nickname;
    if (country !== undefined) updates.country = country;
    if (status !== undefined) updates.status = status;
    // 一旦发生过任意字段更新，标记为 is_modified = true（用于审计）
    if (Object.keys(updates).length > 0) {
      updates.isModified = true;
    }

    await appleId.update(updates);

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

    await appleId.destroy();

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

module.exports = {
  listAppleIds,
  getAppleIdDetail,
  createAppleId,
  updateAppleId,
  deleteAppleId,
};
