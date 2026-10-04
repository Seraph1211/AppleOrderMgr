const crypto = require('crypto');
const { Op, QueryTypes } = require('sequelize');
const { sequelize, Order, AppleId, Recipient, User } = require('../models');
const { scopeOrderWhere, assertOrderIdsAccess } = require('./orderAccessService');
const { getEffectivePermissions } = require('./permissionService');
const { validateOfficialStatusResult } = require('./officialOrderStatusSync');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const LOCK_ID = 26100371;
const MAX_ORDERS = 10000;
const MAX_ID = 2147483647;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const INCLUDES = [
  { model: AppleId, as: 'appleAccount', attributes: [] },
  { model: Recipient, as: 'recipient', attributes: [] },
];

/** 执行不返回敏感数据库错误的固定查询。 */
async function query(sql, replacements = {}, transaction) {
  try {
    return await sequelize.query(sql, { replacements, transaction, type: QueryTypes.SELECT });
  } catch (error) {
    logger.error('官网更新数据库操作失败', { errorType: error.name });
    throw error;
  }
}

/** 所有队列状态变更共享事务锁，避免提交、取消和领取竞态。 */
async function mutate(callback) {
  try {
    return await sequelize.transaction(async transaction => {
      try {
        await query('SELECT pg_advisory_xact_lock(:lock)', { lock: LOCK_ID }, transaction);
        return await callback(transaction);
      } catch (error) {
        error.component = 'officialOrderRefresh';
        throw error;
      }
    });
  } catch (error) {
    logger.warn('官网更新操作未完成', { code: error.code || error.name });
    throw error;
  }
}

/** 校验选择参数；全选只接受订单列表支持的筛选字段。 */
function validateSelection(input) {
  if (
    !input ||
    !UUID.test(input.requestKey || '') ||
    !['ids', 'filtered'].includes(input.selection)
  )
    throw ApiError.badRequest('请提供有效的请求编号和选择范围');
  if (input.selection === 'ids') {
    if (
      !Array.isArray(input.orderIds) ||
      !input.orderIds.length ||
      input.orderIds.length > MAX_ORDERS ||
      input.orderIds.some(id => !Number.isInteger(id) || id < 1 || id > MAX_ID)
    )
      throw ApiError.badRequest(`请选择 1 至 ${MAX_ORDERS} 个有效订单`);
    return { selection: 'ids', orderIds: [...new Set(input.orderIds)].sort((a, b) => a - b) };
  }
  const allowed = [
    'keyword',
    'displayOrderStatuses',
    'productKeys',
    'recipientName',
    'recipientTags',
    'pickupStores',
    'pickupDate',
    'dateFrom',
    'dateTo',
  ];
  if (
    !input.filters ||
    typeof input.filters !== 'object' ||
    Array.isArray(input.filters) ||
    Object.keys(input.filters).some(key => !allowed.includes(key))
  )
    throw ApiError.badRequest('全选筛选条件不合法');
  const filters = Object.fromEntries(
    Object.keys(input.filters)
      .sort()
      .map(key => [key, input.filters[key]])
  );
  return { selection: 'filtered', filters };
}

/** 手工提交时固化订单 ID，整个越权集合拒绝，活动任务去重。 */
async function enqueue(user, input) {
  try {
    const selection = validateSelection(input);
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(selection)).digest('hex');
    return await mutate(async transaction => {
      try {
        const [existing] = await query(
          `SELECT id, request_fingerprint AS fingerprint
          FROM official_order_refresh_batches WHERE requested_by=:userId AND request_key=:key`,
          { userId: user.id, key: input.requestKey },
          transaction
        );
        if (existing) {
          if (existing.fingerprint !== fingerprint)
            throw ApiError.conflict('请求编号已用于其他选择');
          await assertBatch(user, existing.id, transaction);
          const [count] = await query(
            'SELECT count(*)::int AS total FROM official_order_refresh_jobs WHERE batch_id=:id',
            { id: existing.id },
            transaction
          );
          return {
            batchId: existing.id,
            queued: count.total,
            skipped: 0,
            total: count.total,
            replayed: true,
          };
        }
        const [runtime] = await query(
          `SELECT id FROM official_order_refresh_runtime
          WHERE id=1 AND heartbeat_at>now()-interval '5 minutes'`,
          {},
          transaction
        );
        if (!runtime)
          throw new ApiError(503, 'OFFICIAL_WORKER_OFFLINE', '官网更新服务暂未就绪，请稍后重试');
        const where =
          selection.selection === 'ids'
            ? { id: { [Op.in]: selection.orderIds } }
            : require('../controllers/orderController').buildListFilters(selection.filters).where;
        const orders = await Order.findAll({
          where: scopeOrderWhere(user, where),
          attributes: ['id', 'orderNumber'],
          include: INCLUDES,
          order: [['id', 'ASC']],
          limit: MAX_ORDERS + 1,
          transaction,
        });
        if (selection.selection === 'ids' && orders.length !== selection.orderIds.length)
          throw ApiError.notFound('订单不存在或不可访问');
        if (orders.length > MAX_ORDERS)
          throw ApiError.badRequest(`单次最多 ${MAX_ORDERS} 单，请缩小筛选范围`);
        if (!orders.length) return { batchId: null, total: 0, queued: 0, skipped: 0 };
        const active = await query(
          `SELECT order_id AS id FROM official_order_refresh_jobs
          WHERE state IN ('queued','running') AND order_id IN (:ids)`,
          { ids: orders.map(o => o.id) },
          transaction
        );
        const activeIds = new Set(active.map(row => row.id));
        const pending = orders.filter(order => !activeIds.has(order.id));
        if (!pending.length)
          return { batchId: null, queued: 0, skipped: orders.length, total: orders.length };
        const batchId = crypto.randomUUID();
        await query(
          `INSERT INTO official_order_refresh_batches
          (id,requested_by,request_key,request_fingerprint,selection_mode)
          VALUES(:batchId,:userId,:key,:fingerprint,:mode) RETURNING id`,
          {
            batchId,
            userId: user.id,
            key: input.requestKey,
            fingerprint,
            mode: selection.selection,
          },
          transaction
        );
        await query(
          `INSERT INTO official_order_refresh_jobs(id,batch_id,order_id,order_number)
          SELECT x.id,:batchId,x."orderId",x."orderNumber" FROM jsonb_to_recordset(CAST(:jobs AS jsonb))
          AS x(id uuid,"orderId" integer,"orderNumber" text) RETURNING id`,
          {
            batchId,
            jobs: JSON.stringify(
              pending.map(order => ({
                id: crypto.randomUUID(),
                orderId: order.id,
                orderNumber: order.orderNumber,
              }))
            ),
          },
          transaction
        );
        return { batchId, queued: pending.length, skipped: active.length, total: orders.length };
      } catch (error) {
        error.component = 'officialOrderRefresh';
        throw error;
      }
    });
  } catch (error) {
    error.component = 'officialOrderRefresh';
    throw error;
  }
}

/** 检查批次所有权及当前数据权限，撤权后不可继续读取或执行。 */
async function assertBatch(user, id, transaction) {
  try {
    if (!UUID.test(id || '')) throw ApiError.badRequest('批次编号不合法');
    const [batch] = await query(
      `SELECT id, requested_by AS "requestedBy", created_at AS "createdAt"
      FROM official_order_refresh_batches WHERE id=:id`,
      { id },
      transaction
    );
    if (!batch || (user.role !== 'admin' && batch.requestedBy !== user.id))
      throw ApiError.notFound('批次不存在或不可访问');
    const rows = await query(
      'SELECT order_id AS id FROM official_order_refresh_jobs WHERE batch_id=:id',
      { id },
      transaction
    );
    await assertOrderIdsAccess(
      user,
      rows.map(row => row.id),
      { transaction }
    );
    return batch;
  } catch (error) {
    error.component = 'officialOrderRefresh';
    throw error;
  }
}

/** 获取本人近期批次，用于页面重开恢复。 */
async function listBatches(user) {
  try {
    return await query(
      `SELECT b.id, b.created_at AS "createdAt",
      count(j.id)::int AS total, count(j.id) FILTER (WHERE j.state IN ('queued','running'))::int AS active
      FROM official_order_refresh_batches b JOIN official_order_refresh_jobs j ON j.batch_id=b.id
      WHERE b.requested_by=:userId GROUP BY b.id ORDER BY b.created_at DESC LIMIT 10`,
      { userId: user.id }
    );
  } catch (error) {
    error.component = 'officialOrderRefresh';
    throw error;
  }
}

/** 分页读取逐单结果和完整进度，不产生官网请求。 */
async function getBatch(user, id, page = 1, limit = DEFAULT_PAGE_SIZE) {
  try {
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > MAX_ORDERS ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_PAGE_SIZE
    )
      throw ApiError.badRequest('分页参数不合法');
    const batch = await assertBatch(user, id);
    const [runtime] = await query(`SELECT id FROM official_order_refresh_runtime
      WHERE id=1 AND heartbeat_at>now()-interval '5 minutes'`);
    const totals = await query(
      `SELECT state,count(*)::int AS count FROM official_order_refresh_jobs
      WHERE batch_id=:id GROUP BY state`,
      { id }
    );
    const counts = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
    for (const row of totals) counts[row.state] = row.count;
    const jobs = await query(
      `SELECT id,order_id AS "orderId",order_number AS "orderNumber",state,
      error_code AS "errorCode",result_status AS "officialStatus",observed_at AS "observedAt"
      FROM official_order_refresh_jobs WHERE batch_id=:id ORDER BY created_at,id LIMIT :limit OFFSET :offset`,
      { id, limit, offset: (page - 1) * limit }
    );
    return {
      ...batch,
      workerOnline: Boolean(runtime),
      counts,
      total: totals.reduce((sum, row) => sum + row.count, 0),
      page,
      limit,
      jobs,
    };
  } catch (error) {
    error.component = 'officialOrderRefresh';
    throw error;
  }
}

/** 取消尚未开始的请求；正在执行的请求保留完整结果。 */
async function cancelBatch(user, id) {
  try {
    return await mutate(async transaction => {
      try {
        await assertBatch(user, id, transaction);
        const rows = await query(
          `UPDATE official_order_refresh_jobs SET state='cancelled',finished_at=now()
          WHERE batch_id=:id AND state='queued' RETURNING id`,
          { id },
          transaction
        );
        return { cancelled: rows.length };
      } catch (error) {
        error.component = 'officialOrderRefresh';
        throw error;
      }
    });
  } catch (error) {
    error.component = 'officialOrderRefresh';
    throw error;
  }
}

/** 从最新数据库权限重新检查执行者和订单范围。 */
async function authorizedOrder(job, transaction) {
  try {
    const user = await User.findByPk(job.requestedBy, {
      transaction,
      lock: transaction.LOCK.SHARE,
    });
    if (!user || user.status !== 'active') return null;
    const permissions = await getEffectivePermissions(user, { transaction });
    if (!['orders.read', 'orders.edit'].every(code => permissions.includes(code))) return null;
    return await Order.findOne({
      where: scopeOrderWhere(user, { id: job.orderId, orderNumber: job.orderNumber }),
      attributes: ['id', 'officialRawStatus'],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
  } catch (error) {
    error.component = 'officialOrderRefresh';
    throw error;
  }
}

/** 宿主机唯一执行器领取；中断任务不自动重试，避免重复登录。 */
async function claim() {
  try {
    return await mutate(async transaction => {
      try {
        await query(
          `INSERT INTO official_order_refresh_runtime(id,heartbeat_at) VALUES(1,now())
          ON CONFLICT(id) DO UPDATE SET heartbeat_at=excluded.heartbeat_at RETURNING id`,
          {},
          transaction
        );
        await query(
          `UPDATE official_order_refresh_jobs SET state='failed',error_code='WORKER_INTERRUPTED',finished_at=now()
          WHERE state='running' AND started_at<now()-interval '5 minutes' RETURNING id`,
          {},
          transaction
        );
        const [running] = await query(
          "SELECT id FROM official_order_refresh_jobs WHERE state='running' LIMIT 1",
          {},
          transaction
        );
        if (running) return null;
        const [job] = await query(
          `SELECT j.id,j.order_id AS "orderId",j.order_number AS "orderNumber",
          b.requested_by AS "requestedBy" FROM official_order_refresh_jobs j
          JOIN official_order_refresh_batches b ON b.id=j.batch_id
          WHERE j.state='queued' ORDER BY j.created_at,j.id LIMIT 1 FOR UPDATE OF j`,
          {},
          transaction
        );
        if (!job) return null;
        if (!(await authorizedOrder(job, transaction))) {
          await query(
            `UPDATE official_order_refresh_jobs SET state='failed',error_code='ACCESS_REVOKED',finished_at=now()
            WHERE id=:id RETURNING id`,
            { id: job.id },
            transaction
          );
          return null;
        }
        const leaseToken = crypto.randomUUID();
        await query(
          `UPDATE official_order_refresh_jobs SET state='running',started_at=now(),lease_token=:lease
          WHERE id=:id RETURNING id`,
          { id: job.id, lease: leaseToken },
          transaction
        );
        return { id: job.id, orderId: job.orderId, leaseToken };
      } catch (error) {
        error.component = 'officialOrderRefresh';
        throw error;
      }
    });
  } catch (error) {
    error.component = 'officialOrderRefresh';
    throw error;
  }
}

/** 私有执行通道提交结果；事务内只回写官网状态及其观测时间。 */
async function finish(input) {
  try {
    if (!UUID.test(input?.id || '') || !UUID.test(input?.leaseToken || ''))
      throw ApiError.badRequest('任务凭据不合法');
    return await mutate(async transaction => {
      try {
        const [job] = await query(
          `SELECT j.id,j.order_id AS "orderId",j.order_number AS "orderNumber",
          j.started_at AS "startedAt",b.requested_by AS "requestedBy" FROM official_order_refresh_jobs j
          JOIN official_order_refresh_batches b ON b.id=j.batch_id WHERE j.id=:id
          AND j.lease_token=:lease AND j.state='running' FOR UPDATE OF j`,
          { id: input.id, lease: input.leaseToken },
          transaction
        );
        if (!job) return { ignored: true };
        let errorCode =
          typeof input.outcome === 'string' && /^[A-Z_0-9]{1,80}$/.test(input.outcome)
            ? input.outcome
            : 'COLLECTOR_FAILED';
        const order = await authorizedOrder(job, transaction);
        if (!order) errorCode = 'ACCESS_REVOKED';
        let result;
        if (errorCode === 'SUCCEEDED') {
          try {
            result = validateOfficialStatusResult(input.result, job);
          } catch (_error) {
            errorCode = 'INVALID_OFFICIAL_RESULT';
          }
        }
        if (result) {
          const updated = await query(
            `UPDATE orders SET official_raw_status=:status,official_status_observed_at=:observed
            WHERE id=:id AND order_number=:number AND
            (official_status_observed_at IS NULL OR official_status_observed_at<=:observed) RETURNING id`,
            {
              id: job.orderId,
              number: job.orderNumber,
              status: result.status,
              observed: result.observedAt,
            },
            transaction
          );
          if (!updated.length) {
            errorCode = 'STALE_OFFICIAL_RESULT';
            result = null;
          }
        }
        await query(
          `UPDATE official_order_refresh_jobs SET state=:state,error_code=:error,
          finished_at=now(),result_run_id=:runId,result_sha256=:sha,previous_status=:previous,
          result_status=:status,observed_at=:observed WHERE id=:id RETURNING id`,
          {
            id: job.id,
            state: result ? 'succeeded' : 'failed',
            error: result ? null : errorCode,
            runId: result?.runId || null,
            sha: result?.sha256 || null,
            previous: order?.officialRawStatus || null,
            status: result?.status || null,
            observed: result?.observedAt || null,
          },
          transaction
        );
        return { state: result ? 'succeeded' : 'failed', errorCode: result ? null : errorCode };
      } catch (error) {
        error.component = 'officialOrderRefresh';
        throw error;
      }
    });
  } catch (error) {
    error.component = 'officialOrderRefresh';
    throw error;
  }
}

module.exports = { enqueue, listBatches, getBatch, cancelBatch, claim, finish, validateSelection };
