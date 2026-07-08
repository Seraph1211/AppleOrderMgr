/* eslint-disable camelcase */
/**
 * 收件人（取机人）控制器
 * @module controllers/recipientController
 * @description 收件人 CRUD + 分页 + 关键字/标签/Apple ID 过滤
 * @see docs/05-API接口设计方案.md 3.2
 */

const { Op } = require('sequelize');
const { sequelize, Recipient, AppleId } = require('../models');
const logger = require('../utils/logger');
const ApiError = require('../utils/ApiError');
const {
  paginatedResponse,
  parsePositiveInt,
} = require('../utils/apiResponse');

const RECIPIENT_STATUSES = ['active', 'inactive'];

/**
 * 把 Recipient 实例序列化为对外对象
 * @param {Object} recipient - JSON 形态的 Recipient
 * @returns {Object} 对外对象
 */
function serializeRecipient(recipient, orderCount = 0) {
  return {
    id: recipient.id,
    name: `${recipient.lastName || ''}${recipient.firstName || ''}`,
    last_name: recipient.lastName,
    first_name: recipient.firstName,
    id_card_last4: recipient.idCardLast4,
    phone: recipient.phone,
    email: recipient.email,
    apple_id: recipient.appleId,
    apple_id_ref: recipient.appleIdRef,
    province: recipient.province,
    city: recipient.city,
    district: recipient.district,
    street_address: recipient.streetAddress,
    tag: recipient.tag,
    status: recipient.status,
    notes: recipient.notes,
    order_count: orderCount,
    created_at: recipient.createdAt,
    updated_at: recipient.updatedAt,
  };
}

/**
 * 一次性查询指定 recipient id 列表的订单数
 * @param {number[]} ids
 * @returns {Promise<Object>} { [id]: count }
 */
async function getOrderCountsByRecipients(ids) {
  if (ids.length === 0) return {};
  const { Order } = require('../models');
  const rows = await Order.findAll({
    attributes: [
      'recipientRef',
      [sequelize.fn('COUNT', sequelize.col('id')), 'count'],
    ],
    where: { recipientRef: { [Op.in]: ids } },
    group: ['recipientRef'],
    raw: true,
  });
  const out = {};
  rows.forEach((r) => {
    out[r.recipientRef] = parseInt(r.count, 10);
  });
  return out;
}

/**
 * GET /api/recipients?page=1&limit=20&tag=北京&keyword=李&status=active&apple_id_ref=1
 */
async function listRecipients(req, res) {
  try {
    const page = parsePositiveInt(req.query.page, { defaultValue: 1, min: 1, max: 100000 });
    const limit = parsePositiveInt(req.query.limit, { defaultValue: 20, min: 1, max: 100 });

    const where = {};
    if (req.query.tag) {
      where.tag = req.query.tag;
    }
    if (req.query.status) {
      if (!RECIPIENT_STATUSES.includes(req.query.status)) {
        throw ApiError.badRequest(
          `status 非法，可选值: ${RECIPIENT_STATUSES.join(', ')}`,
          { received: req.query.status },
        );
      }
      where.status = req.query.status;
    }
    if (req.query.apple_id_ref) {
      const ref = parseInt(req.query.apple_id_ref, 10);
      if (Number.isNaN(ref) || ref <= 0) {
        throw ApiError.badRequest('apple_id_ref 必须是正整数', { received: req.query.apple_id_ref });
      }
      where.appleIdRef = ref;
    }
    if (req.query.keyword) {
      const kw = String(req.query.keyword).trim();
      if (kw.length > 0) {
        where[Op.or] = [
          { lastName: { [Op.iLike]: `%${kw}%` } },
          { firstName: { [Op.iLike]: `%${kw}%` } },
          { idCardLast4: kw },
          { phone: { [Op.iLike]: `%${kw}%` } },
        ];
      }
    }

    const { count, rows } = await Recipient.findAndCountAll({
      where,
      order: [['id', 'DESC']],
      limit,
      offset: (page - 1) * limit,
      distinct: true,
    });

    const orderCounts = await getOrderCountsByRecipients(rows.map((r) => r.id));

    res.json(paginatedResponse(
      rows.map((r) => serializeRecipient(r.toJSON(), orderCounts[r.id] || 0)),
      count,
      page,
      limit,
      'recipients',
    ));
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('查询收件人列表失败', { error: error.message });
    throw ApiError.database('查询收件人列表失败', { reason: error.message });
  }
}

/**
 * GET /api/recipients/:id
 */
async function getRecipientDetail(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id) || id <= 0) {
      throw ApiError.badRequest('收件人 ID 必须是正整数', { received: req.params.id });
    }

    const recipient = await Recipient.findByPk(id, {
      include: [{ model: AppleId, as: 'appleAccount' }],
    });
    if (!recipient) {
      throw ApiError.notFound('收件人不存在', { id });
    }

    const orderCounts = await getOrderCountsByRecipients([id]);
    res.json({
      success: true,
      data: serializeRecipient(recipient.toJSON(), orderCounts[id] || 0),
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('查询收件人详情失败', { id: req.params.id, error: error.message });
    throw ApiError.database('查询收件人详情失败', { reason: error.message });
  }
}

/**
 * POST /api/recipients
 */
async function createRecipient(req, res) {
  try {
    const payload = req.body || {};
    if (!payload.lastName || !payload.firstName) {
      throw ApiError.badRequest('lastName 与 firstName 必填');
    }
    if (!payload.idCardNumber || !/^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/.test(payload.idCardNumber)) {
      throw ApiError.badRequest('idCardNumber 格式无效（必须 18 位身份证号）');
    }
    if (payload.status && !RECIPIENT_STATUSES.includes(payload.status)) {
      throw ApiError.badRequest(
        `status 非法，可选值: ${RECIPIENT_STATUSES.join(', ')}`,
        { received: payload.status },
      );
    }
    if (payload.appleIdRef) {
      const ref = parseInt(payload.appleIdRef, 10);
      if (Number.isNaN(ref) || ref <= 0) {
        throw ApiError.badRequest('appleIdRef 必须是正整数', { received: payload.appleIdRef });
      }
      const exists = await AppleId.findByPk(ref);
      if (!exists) {
        throw ApiError.badRequest('关联的 Apple ID 不存在', { appleIdRef: ref });
      }
    }

    const created = await Recipient.create({
      lastName: payload.lastName,
      firstName: payload.firstName,
      idCardNumber: payload.idCardNumber,
      phone: payload.phone || null,
      email: payload.email || null,
      province: payload.province || null,
      city: payload.city || null,
      district: payload.district || null,
      streetAddress: payload.streetAddress || null,
      appleId: payload.appleId || null,
      password: payload.password || null,
      appleIdRef: payload.appleIdRef ? parseInt(payload.appleIdRef, 10) : null,
      tag: payload.tag || null,
      status: payload.status || 'active',
      notes: payload.notes || null,
    });

    logger.info('收件人创建成功', { id: created.id, name: `${created.lastName}${created.firstName}` });

    res.status(201).json({
      success: true,
      data: serializeRecipient(created.toJSON(), 0),
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (error.name === 'SequelizeUniqueConstraintError') {
      throw ApiError.conflict('该身份证号已存在');
    }
    logger.error('创建收件人失败', { error: error.message });
    throw ApiError.database('创建收件人失败', { reason: error.message });
  }
}

/**
 * PUT /api/recipients/:id
 */
async function updateRecipient(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id) || id <= 0) {
      throw ApiError.badRequest('收件人 ID 必须是正整数', { received: req.params.id });
    }

    const recipient = await Recipient.findByPk(id);
    if (!recipient) {
      throw ApiError.notFound('收件人不存在', { id });
    }

    const payload = req.body || {};
    const allowed = [
      'lastName', 'firstName', 'idCardNumber', 'phone', 'email',
      'province', 'city', 'district', 'streetAddress',
      'appleId', 'password', 'appleIdRef', 'tag', 'status', 'notes',
    ];
    const updates = {};
    for (const key of allowed) {
      if (payload[key] !== undefined) {
        updates[key] = payload[key];
      }
    }

    if (updates.status !== undefined && !RECIPIENT_STATUSES.includes(updates.status)) {
      throw ApiError.badRequest(
        `status 非法，可选值: ${RECIPIENT_STATUSES.join(', ')}`,
        { received: updates.status },
      );
    }
    if (updates.idCardNumber !== undefined
      && !/^[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]$/.test(updates.idCardNumber)) {
      throw ApiError.badRequest('idCardNumber 格式无效（必须 18 位身份证号）');
    }
    if (updates.appleIdRef !== undefined && updates.appleIdRef !== null) {
      const ref = parseInt(updates.appleIdRef, 10);
      if (Number.isNaN(ref) || ref <= 0) {
        throw ApiError.badRequest('appleIdRef 必须是正整数', { received: updates.appleIdRef });
      }
      const exists = await AppleId.findByPk(ref);
      if (!exists) {
        throw ApiError.badRequest('关联的 Apple ID 不存在', { appleIdRef: ref });
      }
      updates.appleIdRef = ref;
    }

    await recipient.update(updates);

    logger.info('收件人更新成功', { id, fields: Object.keys(updates) });

    res.json({
      success: true,
      data: serializeRecipient(recipient.toJSON()),
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    if (error.name === 'SequelizeUniqueConstraintError') {
      throw ApiError.conflict('该身份证号已存在');
    }
    logger.error('更新收件人失败', { id: req.params.id, error: error.message });
    throw ApiError.database('更新收件人失败', { reason: error.message });
  }
}

/**
 * DELETE /api/recipients/:id
 */
async function deleteRecipient(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id) || id <= 0) {
      throw ApiError.badRequest('收件人 ID 必须是正整数', { received: req.params.id });
    }

    const recipient = await Recipient.findByPk(id);
    if (!recipient) {
      throw ApiError.notFound('收件人不存在', { id });
    }

    await recipient.destroy();

    logger.info('收件人删除成功', { id });

    res.json({
      success: true,
      message: '收件人已删除',
      data: { id },
    });
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    logger.error('删除收件人失败', { id: req.params.id, error: error.message });
    throw ApiError.database('删除收件人失败', { reason: error.message });
  }
}

module.exports = {
  listRecipients,
  getRecipientDetail,
  createRecipient,
  updateRecipient,
  deleteRecipient,
};
