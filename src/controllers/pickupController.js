const { Op } = require('sequelize');
const { sequelize, Order, Recipient, PickupRecord, PickupEvidence, User } = require('../models');
const { scopeOrderWhere } = require('../services/orderAccessService');
const ossService = require('../services/ossService');
const { STATUSES } = require('../services/pickupRecordRules');
const {
  serializePublicProducts,
  serializeEmailLifecycleFields,
} = require('../utils/orderSerialization');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const MAX_PAGE_SIZE = 100;

function parseOrderId(value) {
  const orderId = Number(value);
  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    throw ApiError.badRequest('订单 ID 必须是正整数');
  }
  return orderId;
}

function orderInclude() {
  return [
    { model: Recipient, as: 'recipient', attributes: ['lastName', 'firstName'] },
    {
      model: PickupRecord,
      as: 'pickupRecord',
      required: false,
      include: [
        { model: User, as: 'lastUpdater', attributes: ['id', 'username', 'nickname'] },
        {
          model: PickupEvidence,
          as: 'evidence',
          separate: true,
          order: [['createdAt', 'DESC']],
          attributes: ['id', 'kind', 'originalName', 'contentType', 'sizeBytes', 'createdAt'],
        },
      ],
    },
  ];
}

function serialize(order) {
  const plain = order.toJSON();
  const record = plain.pickupRecord;
  const email = serializeEmailLifecycleFields(plain);
  let lastUpdater = null;
  if (record?.lastUpdater) {
    lastUpdater = {
      id: record.lastUpdater.id,
      name: record.lastUpdater.nickname || record.lastUpdater.username,
    };
  }
  return {
    orderId: plain.id,
    orderNumber: plain.orderNumber,
    tag: plain.tag || null,
    recipientName: plain.recipient
      ? `${plain.recipient.lastName || ''}${plain.recipient.firstName || ''}` || plain.recipientName
      : plain.recipientName,
    products: serializePublicProducts(plain.products, plain.productFilterItems),
    pickupStore: email.email_pickup_info?.storeName || plain.pickupStore || null,
    pickupDate: email.email_pickup_date || null,
    pickupInfo: email.email_pickup_info || null,
    status: record?.status || 'pending',
    pickedUpAt: record?.pickedUpAt || null,
    settlementAmount: record?.settlementAmount ?? null,
    settlementPerson: record?.settlementPerson || null,
    notes: record?.notes || null,
    version: record?.version || 0,
    lastUpdater,
    updatedAt: record?.updatedAt || null,
    evidence: record?.evidence || [],
  };
}

function filters(query) {
  const where = {};
  if (query.tags !== undefined && query.tags !== '') {
    let tags = query.tags;
    if (typeof tags === 'string') {
      try {
        tags = JSON.parse(tags);
      } catch (_error) {
        throw ApiError.badRequest('tags 必须是合法字符串数组');
      }
    }
    if (
      !Array.isArray(tags) ||
      tags.length > 100 ||
      tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > 500)
    ) {
      throw ApiError.badRequest('tags 最多 100 项，每项为 1-500 字符的非空字符串');
    }
    if (tags.length) where.tag = { [Op.in]: [...new Set(tags)] };
  } else if (query.tag) {
    if (typeof query.tag !== 'string' || !query.tag.trim() || query.tag.length > 500) {
      throw ApiError.badRequest('tag 必须是 1-500 字符的非空字符串');
    }
    where.tag = query.tag;
  }
  if (query.search) {
    const search = String(query.search).trim().slice(0, 100);
    where[Op.or] = [
      { orderNumber: { [Op.iLike]: `%${search}%` } },
      { recipientName: { [Op.iLike]: `%${search}%` } },
      ...(/^\d+$/.test(search) ? [{ id: Number(search) }] : []),
    ];
  }
  return where;
}

function buildPickupQuery(query) {
  const include = orderInclude();
  const where = filters(query);
  if (query.status) {
    if (!STATUSES.has(query.status)) throw ApiError.badRequest('取货状态无效');
    include[1].required = query.status !== 'pending';
    if (query.status === 'pending') {
      where[Op.and] = [
        { [Op.or]: [{ '$pickupRecord.id$': null }, { '$pickupRecord.status$': 'pending' }] },
      ];
    } else include[1].where = { status: query.status };
  }
  return { where, include };
}

function positiveInteger(value, fallback, label) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw ApiError.badRequest(`${label} 必须是正整数`);
  return number;
}

/** 列出当前账号订单 TAG 范围内的取货记录。 */
async function list(req, res) {
  try {
    const page = positiveInteger(req.query.page, 1, 'page');
    const pageSize = Math.min(MAX_PAGE_SIZE, positiveInteger(req.query.pageSize, 20, 'pageSize'));
    const { where, include } = buildPickupQuery(req.query);
    const result = await Order.findAndCountAll({
      where: scopeOrderWhere(req.user, where),
      subQuery: false,
      include,
      distinct: true,
      order: [
        ['emailPickupDate', 'ASC NULLS LAST'],
        ['id', 'ASC'],
      ],
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    const items = result.rows.map(serialize);
    res.json({ success: true, data: { items, page, pageSize, total: result.count } });
  } catch (error) {
    logger.error('加载取货记录失败', { userId: req.user?.id, error: error.message });
    throw error;
  }
}

async function accessibleOrder(req, orderId, transaction) {
  const order = await Order.findOne({
    where: scopeOrderWhere(req.user, { id: orderId }),
    transaction,
    lock: transaction?.LOCK.UPDATE,
  });
  if (!order) throw ApiError.notFound('订单不存在或不可访问');
  return order;
}

/** 校验订单范围后读取历史凭证，供订单详情使用。 */
async function readEvidence(req, res) {
  const orderId = parseOrderId(req.params.orderId);
  const evidence = await PickupEvidence.findByPk(req.params.evidenceId, {
    include: [{ model: PickupRecord, as: 'record' }],
  });
  if (!evidence) throw ApiError.notFound('凭证不存在');
  if (evidence.record.orderId !== orderId) throw ApiError.notFound('凭证不存在');
  await sequelize.transaction(transaction =>
    accessibleOrder(req, evidence.record.orderId, transaction)
  );
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, data: { url: ossService.createReadUrl(evidence.objectKey) } });
}

module.exports = { list, readEvidence };
