const crypto = require('crypto');
const { Op, QueryTypes } = require('sequelize');
const { sequelize, Order, AppleId, Recipient, User } = require('../models');
const { scopeOrderWhere, assertOrderIdsAccess } = require('./orderAccessService');
const { getEffectivePermissions } = require('./permissionService');
const { validateOfficialStatusResult } = require('./officialOrderStatusSync');
const { officialAccountKey, normalizeOfficialAccount } = require('./officialOrderAccount');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

const LOCK_ID = 26100371;
const MAX_ORDERS = 10000;
const MAX_ID = 2147483647;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const BATCH_PAUSE_ERRORS = new Set([
  'AUTH_REJECTED',
  'AUTH_PRECONDITION_REQUIRED',
  'HTTP_AUTH_FAILED',
  'HUMAN_VERIFICATION_REQUIRED',
  'HTTP_541',
  'HTTP_429',
  'HTTP_407',
  'PROXY_CONNECTION_FAILED',
  'PROXY_COOLDOWN',
  'REQUEST_BUDGET',
  'TIME_BUDGET',
  'ACCOUNT_COOLDOWN',
  'LOGIN_COOLDOWN',
]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const INCLUDES = [
  { model: AppleId, as: 'appleAccount', attributes: [] },
  { model: Recipient, as: 'recipient', attributes: [] },
];

function assertAdmin(user) {
  if (user?.role !== 'admin') throw new ApiError(403, 'FORBIDDEN', '官网更新仅限管理员');
}

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
    'officialOrderStatuses',
    'payerNames',
    'productKeys',
    'recipientName',
    'recipientTags',
    'pickupStores',
    'pickupDate',
    'pickupDateFrom',
    'pickupDateTo',
    'actualPickupDateFrom',
    'actualPickupDateTo',
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
    assertAdmin(user);
    const selection = validateSelection(input);
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(selection)).digest('hex');
    return await mutate(async transaction => {
      try {
        const [existing] = await query(
          `SELECT id, request_fingerprint AS fingerprint, submission_summary AS summary
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
            ...existing.summary,
          };
        }
        const [runtime] = await query(
          `SELECT id FROM official_order_refresh_runtime
          WHERE id=1 AND heartbeat_at>now()-interval '5 minutes'`,
          {},
          transaction
        );
        if (!runtime)
          throw new ApiError(
            503,
            'OFFICIAL_WORKER_OFFLINE',
            '官网更新后台服务离线，请联系管理员检查；已有任务和官网状态已保留'
          );
        const where =
          selection.selection === 'ids'
            ? { id: { [Op.in]: selection.orderIds } }
            : require('../controllers/orderController').buildListFilters(selection.filters).where;
        const selected = await Order.findAll({
          where: scopeOrderWhere(user, where),
          attributes: ['id', 'orderNumber', 'appleId'],
          include: INCLUDES,
          order: [['id', 'ASC']],
          limit: MAX_ORDERS + 1,
          transaction,
        });
        if (selection.selection === 'ids' && selected.length !== selection.orderIds.length)
          throw ApiError.notFound('订单不存在或不可访问');
        if (selected.length > MAX_ORDERS)
          throw ApiError.badRequest(`单次最多 ${MAX_ORDERS} 单，请缩小筛选范围`);
        const accounts = [
          ...new Set(selected.map(o => normalizeOfficialAccount(o.appleId)).filter(Boolean)),
        ];
        if (!selected.length)
          return {
            batchId: null,
            total: 0,
            queued: 0,
            skipped: 0,
            selectedCount: 0,
            accountCount: 0,
            queuedAccountCount: 0,
          };
        const orders = selected.map(order => ({
          id: order.id,
          orderNumber: order.orderNumber,
          appleId: order.appleId,
        }));
        for (const order of orders) order.accountKey = officialAccountKey(order.appleId);
        await query(
          `UPDATE official_order_refresh_jobs j
          SET state='cancelled',error_code='REQUEUED_MANUALLY',finished_at=now()
          FROM official_order_refresh_batches b
          WHERE j.batch_id=b.id AND b.paused_at IS NOT NULL AND j.state='queued'
          AND (b.requested_by=:userId OR :isAdmin) AND j.order_id IN (:ids) RETURNING j.id`,
          { userId: user.id, isAdmin: user.role === 'admin', ids: orders.map(o => o.id) },
          transaction
        );
        const active = await query(
          `SELECT order_id AS id FROM official_order_refresh_jobs
          WHERE state IN ('queued','running') AND order_id IN (:ids)`,
          { ids: orders.map(order => order.id) },
          transaction
        );
        const activeIds = new Set(active.map(row => row.id));
        const pending = orders.filter(order => !activeIds.has(order.id));
        const groups = new Map();
        for (const order of pending) {
          const key = order.accountKey || `missing:${order.id}`;
          if (!groups.has(key)) groups.set(key, crypto.randomUUID());
          order.accountGroupId = groups.get(key);
        }
        const summary = {
          selectedCount: selected.length,
          accountCount: accounts.length,
          total: orders.length,
          queued: pending.length,
          skipped: orders.length - pending.length,
          queuedAccountCount: new Set(pending.map(o => o.accountKey).filter(Boolean)).size,
        };
        if (!pending.length) return { batchId: null, ...summary };
        const batchId = crypto.randomUUID();
        await query(
          `INSERT INTO official_order_refresh_batches
          (id,requested_by,request_key,request_fingerprint,selection_mode,selected_count,submission_summary)
          VALUES(:batchId,:userId,:key,:fingerprint,:mode,:selectedCount,CAST(:summary AS jsonb)) RETURNING id`,
          {
            batchId,
            userId: user.id,
            key: input.requestKey,
            fingerprint,
            mode: selection.selection,
            selectedCount: selected.length,
            summary: JSON.stringify(summary),
          },
          transaction
        );
        await query(
          `INSERT INTO official_order_refresh_jobs(id,batch_id,order_id,order_number,account_key,account_group_id)
          SELECT x.id,:batchId,x."orderId",x."orderNumber",x."accountKey",x."accountGroupId"
          FROM jsonb_to_recordset(CAST(:jobs AS jsonb))
          AS x(id uuid,"orderId" integer,"orderNumber" text,"accountKey" text,"accountGroupId" uuid) RETURNING id`,
          {
            batchId,
            jobs: JSON.stringify(
              pending.map(order => ({
                id: crypto.randomUUID(),
                orderId: order.id,
                orderNumber: order.orderNumber,
                accountKey: order.accountKey,
                accountGroupId: order.accountGroupId,
              }))
            ),
          },
          transaction
        );
        return { batchId, ...summary };
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
    assertAdmin(user);
    if (!UUID.test(id || '')) throw ApiError.badRequest('批次编号不合法');
    const [batch] = await query(
      `SELECT id, requested_by AS "requestedBy", created_at AS "createdAt",
      paused_at AS "pausedAt", pause_reason AS "pauseReason", selected_count AS "selectedCount"
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
    assertAdmin(user);
    return await query(
      `SELECT b.id, b.created_at AS "createdAt", b.paused_at AS "pausedAt", b.pause_reason AS "pauseReason",
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
    assertAdmin(user);
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
      error_code AS "errorCode",result_status AS "officialStatus",observed_at AS "observedAt",
      account_group_id AS "accountGroupId"
      FROM official_order_refresh_jobs WHERE batch_id=:id ORDER BY created_at,id LIMIT :limit OFFSET :offset`,
      { id, limit, offset: (page - 1) * limit }
    );
    const [accounts] = await query(
      'SELECT count(DISTINCT account_key)::int AS count FROM official_order_refresh_jobs WHERE batch_id=:id',
      { id }
    );
    return {
      ...batch,
      workerOnline: Boolean(runtime),
      accountCount: accounts.count,
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

/** 从数据库读取有效管理员；不信任排队时的角色快照。 */
async function authorizedAdmin(userId, transaction) {
  try {
    const user = await User.findByPk(userId, {
      transaction,
      lock: transaction.LOCK.SHARE,
    });
    if (!user || user.status !== 'active' || user.role !== 'admin') return null;
    const permissions = await getEffectivePermissions(user, { transaction });
    if (!['orders.read', 'orders.edit'].every(code => permissions.includes(code))) return null;
    return user;
  } catch (error) {
    error.component = 'officialOrderRefresh';
    throw error;
  }
}

/** 单笔兼容回写独立检查最新管理员与订单身份。 */
async function authorizedOrder(job, transaction) {
  try {
    const user = await authorizedAdmin(job.requestedBy, transaction);
    if (!user) return null;
    const order = await Order.findOne({
      where: scopeOrderWhere(user, { id: job.orderId, orderNumber: job.orderNumber }),
      attributes: ['id', 'officialRawStatus', 'appleId'],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!order || officialAccountKey(order.appleId) !== job.accountKey) return null;
    return order;
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
          j.account_group_id AS "accountGroupId",j.account_key AS "accountKey",
          b.requested_by AS "requestedBy" FROM official_order_refresh_jobs j
          JOIN official_order_refresh_batches b ON b.id=j.batch_id
          WHERE j.state='queued' AND b.paused_at IS NULL AND j.account_group_id IS NOT NULL
          ORDER BY j.created_at,j.id LIMIT 1 FOR UPDATE OF j`,
          {},
          transaction
        );
        if (!job) return null;
        const jobs = await query(
          `SELECT id,order_id AS "orderId",order_number AS "orderNumber",account_key AS "accountKey"
           FROM official_order_refresh_jobs WHERE account_group_id=:groupId AND state='queued'
           ORDER BY order_id FOR UPDATE`,
          { groupId: job.accountGroupId },
          transaction
        );
        if (!(await authorizedAdmin(job.requestedBy, transaction))) {
          await query(
            `UPDATE official_order_refresh_jobs SET state='failed',error_code='ACCESS_REVOKED',finished_at=now()
            WHERE account_group_id=:groupId AND state='queued' RETURNING id`,
            { groupId: job.accountGroupId },
            transaction
          );
          return null;
        }
        const leaseToken = crypto.randomUUID();
        await query(
          `UPDATE official_order_refresh_jobs SET state='running',started_at=now(),lease_token=:lease
          WHERE account_group_id=:groupId AND state='queued' RETURNING id`,
          { groupId: job.accountGroupId, lease: leaseToken },
          transaction
        );
        return {
          id: job.id,
          orderId: job.orderId,
          leaseToken,
          accountGroupId: job.accountGroupId,
          accountKey: job.accountKey,
          jobs: jobs.map(row => ({ id: row.id, orderId: row.orderId, leaseToken })),
        };
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

/** HTTP 执行器逐单领取；全局最多五单，同账号串行，租约涵盖三次有界采集。 */
async function claimHttp() {
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
          WHERE state='running' AND started_at<now()-interval '20 minutes' RETURNING id`,
          {},
          transaction
        );
        const [running] = await query(
          "SELECT count(*)::int AS count FROM official_order_refresh_jobs WHERE state='running'",
          {},
          transaction
        );
        if (running.count >= 5) return null;
        const [job] = await query(
          `SELECT j.id,j.order_id AS "orderId",j.order_number AS "orderNumber",
          j.account_key AS "accountKey",b.requested_by AS "requestedBy"
          FROM official_order_refresh_jobs j JOIN official_order_refresh_batches b ON b.id=j.batch_id
          WHERE j.state='queued' AND b.paused_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM official_order_refresh_jobs r WHERE r.state='running'
            AND (r.order_id=j.order_id OR r.account_key=j.account_key))
          ORDER BY j.created_at,j.order_id LIMIT 1 FOR UPDATE OF j`,
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
        return { ...job, leaseToken };
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
          j.account_key AS "accountKey",
          j.started_at AS "startedAt",j.batch_id AS "batchId",
          b.requested_by AS "requestedBy" FROM official_order_refresh_jobs j
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
            `UPDATE orders SET official_raw_status=:status,official_status_observed_at=:observed,
            actual_pickup_date=COALESCE(actual_pickup_date,CAST(:pickupDate AS date))
            WHERE id=:id AND order_number=:number AND
            (official_status_observed_at IS NULL OR official_status_observed_at<=:observed) RETURNING id`,
            {
              id: job.orderId,
              number: job.orderNumber,
              status: result.status,
              pickupDate: input.transport === 'http' ? result.actualPickupDate : null,
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
        if (!result && BATCH_PAUSE_ERRORS.has(errorCode)) {
          await query(
            `UPDATE official_order_refresh_batches SET paused_at=now(),pause_reason=:reason
            WHERE id=:id AND paused_at IS NULL RETURNING id`,
            { id: job.batchId, reason: errorCode },
            transaction
          );
          logger.warn('官网更新批次保护性暂停', { batchId: job.batchId, code: errorCode });
        }
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

/** 整组结果原子回写，批量锁定订单；部分成功保留，逐单身份／新鲜度独立校验。 */
async function finishGroup(input) {
  try {
    if (
      !UUID.test(input?.accountGroupId || '') ||
      !UUID.test(input?.leaseToken || '') ||
      !Array.isArray(input.results) ||
      input.results.length > MAX_ORDERS
    )
      throw ApiError.badRequest('账号组结果不合法');
    return await mutate(async transaction => {
      try {
        const jobs = await query(
          `SELECT j.id,j.order_id AS "orderId",j.order_number AS "orderNumber",
             j.account_key AS "accountKey",j.started_at AS "startedAt",j.batch_id AS "batchId",
             b.requested_by AS "requestedBy"
           FROM official_order_refresh_jobs j JOIN official_order_refresh_batches b ON b.id=j.batch_id
           WHERE j.account_group_id=:groupId AND j.lease_token=:lease AND j.state='running'
           ORDER BY j.order_id FOR UPDATE OF j`,
          { groupId: input.accountGroupId, lease: input.leaseToken },
          transaction
        );
        if (!jobs.length) return { ignored: true };
        const user = await User.findByPk(jobs[0].requestedBy, {
          transaction,
          lock: transaction.LOCK.SHARE,
        });
        const allowed = user?.role === 'admin' && user.status === 'active';
        const orders = await Order.findAll({
          where: { id: { [Op.in]: jobs.map(job => job.orderId) } },
          attributes: ['id', 'orderNumber', 'appleId', 'officialRawStatus'],
          order: [['id', 'ASC']],
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const byOrder = new Map(orders.map(order => [order.id, order]));
        const byJob = new Map();
        const jobIds = new Set(jobs.map(job => job.id));
        for (const value of input.results) {
          if (!value || byJob.has(value.id) || !jobIds.has(value.id))
            throw ApiError.badRequest('账号组包含重复或非本组结果');
          byJob.set(value.id, value);
        }
        const results = jobs.map(job => {
          const order = byOrder.get(job.orderId);
          const value = byJob.get(job.id);
          let error = /^[A-Z_0-9]{1,80}$/.test(value?.outcome || '')
            ? value.outcome
            : 'COLLECTOR_FAILED';
          if (!allowed) error = 'ACCESS_REVOKED';
          else if (!order || order.orderNumber !== job.orderNumber) error = 'ORDER_NOT_FOUND';
          else if (officialAccountKey(order.appleId) !== job.accountKey) error = 'ACCOUNT_CHANGED';
          let result;
          if (error === 'SUCCEEDED') {
            try {
              result = validateOfficialStatusResult(value.result, job);
            } catch (_error) {
              error = 'INVALID_OFFICIAL_RESULT';
            }
          }
          return {
            id: job.id,
            orderId: job.orderId,
            orderNumber: job.orderNumber,
            previous: order?.officialRawStatus || null,
            error: result ? null : error,
            status: result?.status || null,
            observed: result?.observedAt || null,
            runId: result?.runId || null,
            sha: result?.sha256 || null,
          };
        });
        const updated = await query(
          `UPDATE orders o SET official_raw_status=x.status,official_status_observed_at=x.observed
           FROM jsonb_to_recordset(CAST(:results AS jsonb)) AS x("orderId" integer,"orderNumber" text,status text,observed timestamptz,error text)
           WHERE o.id=x."orderId" AND o.order_number=x."orderNumber" AND x.error IS NULL
             AND (o.official_status_observed_at IS NULL OR o.official_status_observed_at<=x.observed)
           RETURNING o.id`,
          { results: JSON.stringify(results) },
          transaction
        );
        const updatedIds = new Set(updated.map(row => row.id));
        for (const result of results) {
          if (!result.error && !updatedIds.has(result.orderId)) {
            result.error = 'STALE_OFFICIAL_RESULT';
            result.status = result.observed = result.runId = result.sha = null;
          }
        }
        await query(
          `UPDATE official_order_refresh_jobs j SET
             state=CASE WHEN x.error IS NULL THEN 'succeeded' ELSE 'failed' END,
             error_code=x.error,finished_at=now(),result_run_id=x."runId",result_sha256=x.sha,
             previous_status=x.previous,result_status=x.status,observed_at=x.observed
           FROM jsonb_to_recordset(CAST(:results AS jsonb)) AS x(id uuid,error text,"runId" integer,
             sha text,previous text,status text,observed timestamptz)
           WHERE j.id=x.id RETURNING j.id`,
          { results: JSON.stringify(results) },
          transaction
        );
        const pause = results.find(result => BATCH_PAUSE_ERRORS.has(result.error));
        if (pause)
          await query(
            `UPDATE official_order_refresh_batches SET paused_at=now(),pause_reason=:reason
           WHERE id=:id AND paused_at IS NULL RETURNING id`,
            { id: jobs[0].batchId, reason: pause.error },
            transaction
          );
        return {
          state:
            updated.length === results.length ? 'succeeded' : updated.length ? 'partial' : 'failed',
          succeeded: updated.length,
          failed: results.length - updated.length,
        };
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

module.exports = {
  claimHttp,
  enqueue,
  listBatches,
  getBatch,
  cancelBatch,
  claim,
  finish,
  finishGroup,
  validateSelection,
};
