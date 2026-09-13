const logger = require('../utils/logger');
/** 管理员订单数据源管理路由。 */
const express = require('express');
const { AosDevice, AosRecord, OrderSource, PickupStore, OperationLog } = require('../models');
const { requireRole, requirePermission } = require('../middleware/authMiddleware');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const repo = require('../services/ingestionRepository');
const aos = require('../services/aosIngestionService');
const management = require('../services/ingestionManagementService');
const router = express.Router();
router.use(requireRole(['admin']), requirePermission('ingestion.read'));
router.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

function route(permission, work, status = 200) {
  return [
    requirePermission(permission),
    asyncHandler(async (req, res) => {
      try {
        res.status(status).json({ success: true, data: await work(req) });
      } catch (error) {
        logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
        throw error;
      }
    }),
  ];
}
router.get(
  '/collector-releases',
  ...route('ingestion.devices.manage', () =>
    require('../services/collectorReleaseService').listReleases()
  )
);
router.get(
  '/collector-updates',
  ...route('ingestion.devices.manage', () =>
    require('../services/collectorUpdateService').listUpdates()
  )
);
router.post(
  '/collector-updates',
  ...route(
    'ingestion.devices.manage',
    req => require('../services/collectorUpdateService').scheduleUpdates(req),
    201
  )
);
router.get('/settings', ...route('ingestion.read', () => management.getSettings()));
router.post('/switch-preview', ...route('ingestion.manage', management.switchPreview));
router.put('/settings', ...route('ingestion.manage', management.switchSource));
router.get(
  '/backfills/:id',
  ...route('ingestion.read', req => management.getBackfill(req.params.id))
);
router.post(
  '/devices',
  ...route('ingestion.devices.manage', req => management.manageDevice('create', req), 201)
);
router.patch(
  '/devices/:id',
  ...route('ingestion.devices.manage', req => management.manageDevice('edit', req))
);
router.post(
  '/devices/:id/rotate-credential',
  ...route('ingestion.devices.manage', req => management.manageDevice('rotate', req))
);
router.get(
  '/devices/:id/credential',
  ...route('ingestion.devices.manage', req =>
    management.getDeviceCredential(req.params.id, req.user)
  )
);

router.get(
  '/devices',
  ...route('ingestion.read', async req => {
    try {
      repo.assertFields(req.query, ['page', 'limit', 'enabled', 'online', 'keyword']);
      const { page, limit, offset } = repo.pagination(req.query);
      const where = {};
      for (const field of ['enabled', 'online'])
        if (req.query[field] !== undefined && !['true', 'false'].includes(req.query[field]))
          throw ApiError.badRequest('布尔筛选无效');
      if (req.query.enabled !== undefined) where.enabled = req.query.enabled === 'true';
      if (req.query.online === 'true')
        where.heartbeatAt = { [repo.Op.gt]: new Date(Date.now() - 60000) };
      if (req.query.online === 'false')
        where[repo.Op.or] = [
          { heartbeatAt: null },
          { heartbeatAt: { [repo.Op.lte]: new Date(Date.now() - 60000) } },
        ];
      if (req.query.keyword)
        where.name = { [repo.Op.iLike]: `%${String(req.query.keyword).slice(0, 100)}%` };
      const { rows, count } = await AosDevice.findAndCountAll({
        where,
        limit,
        offset,
        order: [['createdAt', 'DESC']],
      });
      const counts = await management.deviceCounts(rows.map(d => d.id));
      return {
        items: rows.map(d => management.deviceDto(d, counts.get(d.id))),
        total: count,
        page,
        limit,
      };
    } catch (error) {
      logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
      throw error;
    }
  })
);
router.get(
  '/devices/:id',
  ...route('ingestion.read', async req => {
    try {
      const row = await AosDevice.findByPk(repo.requireUuid(req.params.id));
      if (!row) throw ApiError.notFound();
      return management.deviceDto(row, (await management.deviceCounts([row.id])).get(row.id));
    } catch (error) {
      logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
      throw error;
    }
  })
);

function dateRange(query, start, end) {
  const range = {};
  for (const key of [start, end]) {
    const value = query[key];
    if (value === undefined) continue;
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
    )
      throw ApiError.badRequest('日期筛选无效');
    range[key === start ? repo.Op.gte : repo.Op.lt] =
      repo.dayBounds(value)[key === start ? 'from' : 'toExclusive'];
  }
  if (query[start] && query[end] && query[start] > query[end])
    throw ApiError.badRequest('起始日期晚于结束日期');
  return Reflect.ownKeys(range).length ? range : null;
}
router.get(
  '/aos-records',
  ...route('ingestion.read', async req => {
    try {
      repo.assertFields(req.query, [
        'page',
        'limit',
        'deviceId',
        'orderNumber',
        'status',
        'eligibility',
        'dateFrom',
        'dateTo',
        'receivedFrom',
        'receivedTo',
      ]);
      const { page, limit, offset } = repo.pagination(req.query);
      const where = {};
      if (req.query.deviceId) where.deviceId = repo.requireUuid(req.query.deviceId);
      if (req.query.orderNumber) {
        if (!/^W\d{10}$/.test(req.query.orderNumber)) throw ApiError.badRequest('订单号无效');
        where.orderNumber = req.query.orderNumber;
      }
      for (const [field, values] of [
        ['status', aos.STATUSES],
        ['eligibility', aos.ELIGIBILITIES],
      ]) {
        if (req.query[field] !== undefined) {
          if (!values.includes(req.query[field])) throw ApiError.badRequest('筛选状态无效');
          where[field] = req.query[field];
        }
      }
      const dates = dateRange(req.query, 'dateFrom', 'dateTo');
      const received = dateRange(req.query, 'receivedFrom', 'receivedTo');
      if (dates) where.orderDate = dates;
      if (received) where.receivedAt = received;
      const { rows, count } = await AosRecord.findAndCountAll({
        where,
        order: [
          ['receivedAt', 'DESC'],
          ['id', 'ASC'],
        ],
        limit,
        offset,
      });
      return { items: rows.map(aos.recordDto), total: count, page, limit };
    } catch (error) {
      logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
      throw error;
    }
  })
);
router.get(
  '/aos-records/:id',
  ...route('ingestion.read', async req => {
    try {
      const row = await AosRecord.findByPk(repo.requireUuid(req.params.id));
      if (!row) throw ApiError.notFound();
      return aos.recordDto(row);
    } catch (error) {
      logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
      throw error;
    }
  })
);
router.get(
  '/aos-records/:id/content',
  ...route('ingestion.content.read', req =>
    repo.ingestionTransaction(async transaction => {
      try {
        const row = await AosRecord.findByPk(repo.requireUuid(req.params.id), { transaction });
        if (!row) throw ApiError.notFound();
        await repo.audit(req.user, '查看敏感内容', row.id, transaction);
        const parsed = require('../services/aosParser').parseAosLine(row.payload.rawLine);
        return {
          rawLine: row.payload.rawLine,
          data: row.draft?.data || parsed.data,
          password: row.draft?.password || parsed.password,
          resolutionReason: row.payload.resolutionReason || null,
        };
      } catch (error) {
        logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
        throw error;
      }
    })
  )
);
for (const action of ['reparse', 'ingest', 'retry', 'resolve'])
  router.post(
    `/aos-records/:id/${action}`,
    ...route(
      'ingestion.records.process',
      req => aos.processManual(action, req),
      action === 'retry' ? 202 : 200
    )
  );
router.put(
  '/aos-records/:id/draft',
  ...route('ingestion.records.process', req => aos.processManual('draft', req))
);
router.get(
  '/orders/:orderId/sources',
  ...route('ingestion.read', async req => {
    try {
      const orderId = Number(req.params.orderId);
      if (!Number.isSafeInteger(orderId) || orderId < 1) throw ApiError.badRequest('订单 ID 无效');
      const { page, limit, offset } = repo.pagination(req.query);
      const { rows, count } = await OrderSource.findAndCountAll({
        where: { orderId },
        limit,
        offset,
        order: [['receivedAt', 'DESC']],
      });
      return { items: rows, total: count, page, limit };
    } catch (error) {
      logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
      throw error;
    }
  })
);
router.get(
  '/stores',
  ...route('ingestion.read', async req => {
    try {
      repo.assertFields(req.query, ['page', 'limit', 'code', 'keyword']);
      const { page, limit, offset } = repo.pagination(req.query);
      const where = {};
      if (req.query.code) {
        if (!/^R\d+$/.test(req.query.code)) throw ApiError.badRequest('门店代码无效');
        where.code = req.query.code;
      }
      if (req.query.keyword)
        where.name = { [repo.Op.iLike]: `%${String(req.query.keyword).slice(0, 100)}%` };
      const { rows, count } = await PickupStore.findAndCountAll({
        where,
        limit,
        offset,
        order: [['code', 'ASC']],
      });
      return { items: rows, total: count, page, limit };
    } catch (error) {
      logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
      throw error;
    }
  })
);
router.get(
  '/audits',
  ...route('ingestion.read', async req => {
    try {
      repo.assertFields(req.query, ['page', 'limit', 'dateFrom', 'dateTo']);
      const { page, limit, offset } = repo.pagination(req.query);
      const where = { action: { [repo.Op.like]: '订单数据源：%' } };
      const dates = dateRange(req.query, 'dateFrom', 'dateTo');
      if (dates) where.createdAt = dates;
      const { rows, count } = await OperationLog.findAndCountAll({
        where,
        limit,
        offset,
        order: [['createdAt', 'DESC']],
      });
      return { items: rows, total: count, page, limit };
    } catch (error) {
      logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
      throw error;
    }
  })
);
// 仅返回受控错误，不将 Sequelize 的 SQL/绑定载荷或开发堆栈带给客户端。
router.use((error, _req, res, _next) =>
  res.status(error.statusCode || 503).json({
    success: false,
    error: {
      code: error.statusCode ? error.code : 'TEMPORARILY_UNAVAILABLE',
      message: error.statusCode ? error.message : '服务暂时不可用',
      ...(error.statusCode && error.details ? { details: error.details } : {}),
    },
  })
);
module.exports = router;
