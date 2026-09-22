const { Op } = require('sequelize');
const XLSX = require('xlsx');
const {
  sequelize,
  Order,
  Recipient,
  PickupRecord,
  PickupEvidence,
  PickupRecordEvent,
  User,
} = require('../models');
const { scopeOrderWhere } = require('../services/orderAccessService');
const ossService = require('../services/ossService');
const { STATUSES, normalizePickupUpdate } = require('../services/pickupRecordRules');
const {
  serializePublicProducts,
  serializeEmailLifecycleFields,
} = require('../utils/orderSerialization');
const { escapeSpreadsheetFormula } = require('../utils/masking');
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
  if (query.tag) where.tag = query.tag;
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

/** 列出当前账号订单 TAG 范围内的取货记录。 */
async function list(req, res) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(req.query.pageSize) || 20));
  const include = orderInclude();
  const where = filters(req.query);
  if (req.query.status) {
    if (!STATUSES.has(req.query.status)) throw ApiError.badRequest('取货状态无效');
    include[1].required = req.query.status !== 'pending';
    if (req.query.status === 'pending') {
      where[Op.and] = [
        ...(where[Op.and] || []),
        { [Op.or]: [{ '$pickupRecord.id$': null }, { '$pickupRecord.status$': 'pending' }] },
      ];
    } else include[1].where = { status: req.query.status };
  }
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

/** 新建或修改一笔取货记录并追加变更历史。 */
async function update(req, res) {
  const orderId = parseOrderId(req.params.orderId);
  const result = await sequelize.transaction(async transaction => {
    await accessibleOrder(req, orderId, transaction);
    let record = await PickupRecord.findOne({
      where: { orderId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!record) record = await PickupRecord.create({ orderId }, { transaction });
    const expected = Number(req.body.expectedVersion);
    if (!Number.isInteger(expected) || expected !== record.version)
      throw ApiError.conflict(
        '记录已被其他人更新，请刷新后重试',
        { currentVersion: record.version },
        'CONCURRENT_MODIFICATION'
      );
    const before = {
      status: record.status,
      pickedUpAt: record.pickedUpAt,
      settlementAmount: record.settlementAmount,
      settlementPerson: record.settlementPerson,
      notes: record.notes,
    };
    const after = normalizePickupUpdate(req.body, record);
    const changes = Object.fromEntries(
      Object.keys(after)
        .filter(key => String(before[key] ?? '') !== String(after[key] ?? ''))
        .map(key => [key, { before: before[key] ?? null, after: after[key] ?? null }])
    );
    if (!Object.keys(changes).length) return record;
    const beforeVersion = record.version;
    await record.update(
      { ...after, lastUpdatedBy: req.user.id, version: beforeVersion + 1 },
      { transaction }
    );
    await PickupRecordEvent.create(
      {
        pickupRecordId: record.id,
        orderId,
        actorUserId: req.user.id,
        actorName: req.user.nickname || req.user.username,
        eventType: 'updated',
        changes,
        beforeVersion,
        afterVersion: record.version,
      },
      { transaction }
    );
    return record;
  });
  const order = await Order.findByPk(orderId, { include: orderInclude() });
  res.json({ success: true, data: serialize(order), version: result.version });
}

/** 返回单笔记录的追加历史。 */
async function events(req, res) {
  const orderId = parseOrderId(req.params.orderId);
  await sequelize.transaction(transaction => accessibleOrder(req, orderId, transaction));
  const rows = await PickupRecordEvent.findAll({
    where: { orderId },
    order: [['createdAt', 'DESC']],
    limit: 200,
  });
  res.json({ success: true, data: rows });
}

/** 为浏览器签发受限 OSS 上传地址。 */
async function prepareEvidence(req, res) {
  const orderId = parseOrderId(req.params.orderId);
  await sequelize.transaction(transaction => accessibleOrder(req, orderId, transaction));
  res.json({ success: true, data: ossService.createUpload(orderId, req.body.kind, req.body) });
}

/** 确认 OSS 上传并登记凭证元数据。 */
async function confirmEvidence(req, res) {
  const orderId = parseOrderId(req.params.orderId);
  const metadata = ossService.validateFile(req.body);
  const kind = req.body.kind;
  if (!['pickup', 'settlement'].includes(kind)) throw ApiError.badRequest('凭证类型无效');
  const expectedPrefix = `pickup-evidence/${orderId}/${kind}/`;
  if (typeof req.body.objectKey !== 'string' || !req.body.objectKey.startsWith(expectedPrefix))
    throw ApiError.badRequest('OSS 对象路径无效');
  await sequelize.transaction(transaction => accessibleOrder(req, orderId, transaction));
  await ossService.confirmUpload(req.body.objectKey, metadata.sizeBytes);
  const evidence = await sequelize.transaction(async transaction => {
    await accessibleOrder(req, orderId, transaction);
    let record = await PickupRecord.findOne({
      where: { orderId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!record)
      record = await PickupRecord.create({ orderId, lastUpdatedBy: req.user.id }, { transaction });
    const created = await PickupEvidence.create(
      {
        pickupRecordId: record.id,
        kind,
        objectKey: req.body.objectKey,
        ...metadata,
        uploadedBy: req.user.id,
      },
      { transaction }
    );
    const beforeVersion = record.version;
    await record.update(
      { lastUpdatedBy: req.user.id, version: beforeVersion + 1 },
      { transaction }
    );
    await PickupRecordEvent.create(
      {
        pickupRecordId: record.id,
        orderId,
        actorUserId: req.user.id,
        actorName: req.user.nickname || req.user.username,
        eventType: 'evidence_added',
        changes: { evidence: { kind, id: created.id, name: created.originalName } },
        beforeVersion,
        afterVersion: record.version,
      },
      { transaction }
    );
    return created;
  });
  res.status(201).json({ success: true, data: evidence });
}

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

/** 导出当前筛选和授权范围内的取货清单。 */
async function exportList(req, res) {
  const rows = await Order.findAll({
    where: scopeOrderWhere(req.user, filters(req.query)),
    include: orderInclude(),
    order: [
      ['emailPickupDate', 'ASC NULLS LAST'],
      ['id', 'ASC'],
    ],
  });
  const data = rows.map(serialize).map(item => ({
    系统编号: item.orderId,
    订单号: escapeSpreadsheetFormula(item.orderNumber || ''),
    商品信息: escapeSpreadsheetFormula(
      item.products
        .map(product => `${product.name || product.model || '-'} ×${product.quantity ?? '-'}`)
        .join('、')
    ),
    取机人: escapeSpreadsheetFormula(item.recipientName || ''),
    TAG: escapeSpreadsheetFormula(item.tag || ''),
    取货门店: escapeSpreadsheetFormula(item.pickupStore || ''),
    取货日期: item.pickupDate || '',
    取货时间: escapeSpreadsheetFormula(
      item.pickupInfo?.appointmentMode === 'business_hours'
        ? '营业时间内到店'
        : [item.pickupInfo?.startTime, item.pickupInfo?.endTime].filter(Boolean).join('–')
    ),
    取货状态:
      item.status === 'picked_up' ? '已取货' : item.status === 'exception' ? '异常' : '待取货',
    备注: escapeSpreadsheetFormula(item.notes || ''),
  }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(data), '取货清单');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="pickup_${new Date().toISOString().slice(0, 10)}.xlsx"`
  );
  logger.info('取货清单导出完成', { userId: req.user.id, count: rows.length });
  res.send(buffer);
}

module.exports = {
  list,
  update,
  events,
  prepareEvidence,
  confirmEvidence,
  readEvidence,
  exportList,
};
