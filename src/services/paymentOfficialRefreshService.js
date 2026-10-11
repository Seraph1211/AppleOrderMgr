const crypto = require('crypto');
const { Op, QueryTypes } = require('sequelize');
const db = require('../models');
const ApiError = require('../utils/ApiError');
const { scopeOrderWhere } = require('./orderAccessService');
const { getEffectivePermissions } = require('./permissionService');
const { officialAccountKey } = require('./officialOrderAccount');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TERMINAL = new Set([
  'PROCESSING',
  'PREPARING_TO_SHIP',
  'SHIPPED',
  'DELIVERED',
  'READY_FOR_PICKUP',
  'PICKUP_READY',
  'PICKED_UP',
  'RETURN_STARTED',
  'RETURN_EXPIRED',
  'RETURN_COMPLETED',
  'RETURNED',
  'REFUNDED',
  'CANCELLED',
  'CANCELED',
  'PICKUP_CANCELLED',
  'PICK_UP_CANCELLED',
  'PAYMENT_EXPIRED_STORED_ORDER',
]);

/** 未知或复合部分待付款状态必须继续核对；本地倒计时不作为证据。 */
function needsRefresh(order) {
  if (order.emailPaymentStatus === 'paid') return false;
  const states = String(order.officialRawStatus || '')
    .split('|')
    .map(value => value.trim());
  return !states.length || states.some(value => !TERMINAL.has(value));
}

/** 自动核对仅允许生产显式启用，开发环境永不自动请求官网。 */
function automaticEnabled() {
  return (
    process.env.NODE_ENV === 'production' && process.env.PAYMENT_OFFICIAL_REFRESH_ENABLED === 'true'
  );
}

/** 在当前权限和归属下读取付款任务；不存在与不可见统一返回404。 */
async function accessibleTask(user, taskId, dispatch, transaction) {
  try {
    const permissions = await getEffectivePermissions(user, { transaction });
    const permission = dispatch ? 'payment_dispatch.assign' : 'payment_tasks.handle_own';
    if (
      user.status !== 'active' ||
      !permissions.includes(permission) ||
      (dispatch && user.role !== 'admin')
    )
      throw new ApiError(403, 'FORBIDDEN', '无付款刷新权限');
    const task = await db.PaymentTask.findOne({
      where: dispatch ? { id: taskId } : { id: taskId, assigneeUserId: user.id },
      include: [
        {
          model: db.Order,
          as: 'order',
          required: true,
          where: dispatch ? scopeOrderWhere(user) : {},
          attributes: [
            'id',
            'orderNumber',
            'appleId',
            'officialRawStatus',
            'officialStatusObservedAt',
            'emailPaymentStatus',
          ],
        },
      ],
      transaction,
      ...(transaction ? { lock: { level: transaction.LOCK.UPDATE, of: db.PaymentTask } } : {}),
    });
    if (!task) throw ApiError.notFound('任务不存在或不可访问');
    return task;
  } catch (error) {
    error.component = 'paymentOfficialRefresh';
    throw error;
  }
}

/** 队列领取与回写均重新检查人员有效性和当前归属。 */
async function authorizedOrder(job, transaction) {
  try {
    if (job.purpose === 'payment_auto') {
      if (!automaticEnabled()) return null;
      const task = await db.PaymentTask.findOne({ where: { orderId: job.orderId }, transaction });
      if (!task) return null;
    } else {
      const user = await db.User.findByPk(job.requestedBy, {
        transaction,
        lock: transaction.LOCK.SHARE,
      });
      if (!user) return null;
      const task = await db.PaymentTask.findOne({ where: { orderId: job.orderId }, transaction });
      if (!task) return null;
      await accessibleTask(user, task.id, user.role === 'admin', transaction);
    }
    const order = await db.Order.findOne({
      where: { id: job.orderId, orderNumber: job.orderNumber },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!order || officialAccountKey(order.appleId) !== job.accountKey) return null;
    if (job.purpose === 'payment_auto' && !needsRefresh(order)) return null;
    return order;
  } catch (error) {
    if (error.statusCode === 403 || error.statusCode === 404) return null;
    error.component = 'paymentOfficialRefresh';
    throw error;
  }
}

/** 在官网队列事务锁内建立单订单任务，并复用任何已活动任务。 */
async function enqueueOrder(order, user, requestKey, transaction) {
  try {
    const queue = require('./officialOrderRefreshService');
    if (user) {
      const [existing] = await queue.query(
        `SELECT j.id,j.state,j.order_id AS "orderId"
        FROM official_order_refresh_batches b JOIN official_order_refresh_jobs j ON j.batch_id=b.id
        WHERE b.requested_by=:userId AND b.request_key=:key`,
        { userId: user.id, key: requestKey },
        transaction
      );
      if (existing) {
        if (existing.orderId !== order.id) throw ApiError.conflict('请求编号已用于其他订单');
        return { jobId: existing.id, created: false, state: existing.state };
      }
    }
    await queue.query(
      `UPDATE official_order_refresh_jobs j
      SET state='cancelled',error_code='REQUEUED_FOR_PAYMENT',finished_at=now()
      FROM official_order_refresh_batches b WHERE j.batch_id=b.id AND j.order_id=:id
      AND j.state='queued' AND b.paused_at<=now()-interval '30 minutes' RETURNING j.id`,
      { id: order.id },
      transaction
    );
    const [active] = await queue.query(
      `SELECT j.id,j.state,b.paused_at AS "pausedAt" FROM official_order_refresh_jobs j
      JOIN official_order_refresh_batches b ON b.id=j.batch_id
      WHERE j.order_id=:id AND j.state IN ('queued','running') ORDER BY j.created_at LIMIT 1`,
      { id: order.id },
      transaction
    );
    if (active?.state === 'queued' && active.pausedAt)
      throw new ApiError(409, 'OFFICIAL_REFRESH_PAUSED', '官网保护暂停中，请在30分钟冷却后重试');
    if (active) return { jobId: active.id, created: false, state: active.state };
    const purpose = user ? 'payment_manual' : 'payment_auto';
    if (user) {
      const [replay] = await queue.query(
        `SELECT j.id,j.state FROM official_order_refresh_jobs j
        JOIN official_order_refresh_batches b ON b.id=j.batch_id
        WHERE b.requested_by=:userId AND b.request_key=:key AND b.purpose='payment_manual'
        AND j.order_id=:id`,
        { userId: user.id, key: requestKey, id: order.id },
        transaction
      );
      if (replay) return { jobId: replay.id, created: false, state: replay.state };
    }
    const [runtime] = await queue.query(
      `SELECT id FROM official_order_refresh_runtime
      WHERE id=1 AND heartbeat_at>now()-interval '5 minutes'`,
      {},
      transaction
    );
    if (!runtime)
      throw new ApiError(
        503,
        'OFFICIAL_WORKER_OFFLINE',
        '官网更新后台服务离线，已保存状态保持不变'
      );
    const batchId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    await queue.query(
      `INSERT INTO official_order_refresh_batches
      (id,requested_by,request_key,request_fingerprint,selection_mode,selected_count,purpose)
      VALUES(:batchId,:userId,:key,:fingerprint,'ids',1,:purpose) RETURNING id`,
      {
        batchId,
        userId: user?.id || null,
        key: requestKey,
        fingerprint: crypto.createHash('sha256').update(String(order.id)).digest('hex'),
        purpose,
      },
      transaction
    );
    await queue.query(
      `INSERT INTO official_order_refresh_jobs
      (id,batch_id,order_id,order_number,account_key,account_group_id)
      VALUES(:jobId,:batchId,:id,:number,:accountKey,:groupId) RETURNING id`,
      {
        jobId,
        batchId,
        id: order.id,
        number: order.orderNumber,
        accountKey: officialAccountKey(order.appleId),
        groupId: crypto.randomUUID(),
      },
      transaction
    );
    return { jobId, created: true, state: 'queued' };
  } catch (error) {
    error.component = 'paymentOfficialRefresh';
    throw error;
  }
}

/** 手动单笔只接受当前付款任务，不能客户端指定订单或系统身份。 */
async function enqueue(user, taskId, input, dispatch = false) {
  try {
    if (!UUID.test(input?.requestKey || '') || !Number.isSafeInteger(taskId) || taskId < 1)
      throw ApiError.badRequest('任务编号或请求编号无效');
    return await require('./officialOrderRefreshService').mutate(async transaction => {
      try {
        const task = await accessibleTask(user, taskId, dispatch, transaction);
        return await enqueueOrder(task.order, user, input.requestKey, transaction);
      } catch (error) {
        error.component = 'paymentOfficialRefresh';
        throw error;
      }
    });
  } catch (error) {
    error.component = 'paymentOfficialRefresh';
    throw error;
  }
}

/** 只返回当前可访问订单的进度，活动共享任务不泄露提交人或租约。 */
async function progress(user, taskId, jobId, dispatch = false) {
  try {
    if (!UUID.test(jobId || '')) throw ApiError.badRequest('任务编号无效');
    const task = await accessibleTask(user, taskId, dispatch);
    const queue = require('./officialOrderRefreshService');
    const [job] = await queue.query(
      `SELECT id AS "jobId",order_id AS "orderId",state,error_code AS "errorCode"
      FROM official_order_refresh_jobs WHERE id=:jobId AND order_id=:orderId`,
      { jobId, orderId: task.orderId }
    );
    if (!job) throw ApiError.notFound('任务不存在或不可访问');
    const [runtime] = await queue.query(
      "SELECT id FROM official_order_refresh_runtime WHERE id=1 AND heartbeat_at>now()-interval '5 minutes'"
    );
    return {
      ...job,
      officialRawStatus: task.order.officialRawStatus,
      officialStatusObservedAt: task.order.officialStatusObservedAt,
      workerOnline: Boolean(runtime),
    };
  } catch (error) {
    error.component = 'paymentOfficialRefresh';
    throw error;
  }
}

/** 三分钟扫描；每单持久去重与保护性暂停，人工任务状态和倒计时不影响核对。 */
async function scan() {
  try {
    if (!automaticEnabled()) return { queued: 0 };
    return await require('./officialOrderRefreshService').mutate(async transaction => {
      try {
        const rows = await db.sequelize.query(
          `SELECT o.id FROM orders o
          JOIN payment_tasks t ON t.order_id=o.id WHERE o.email_payment_status IS DISTINCT FROM 'paid'
          AND (NULLIF(btrim(o.official_raw_status),'') IS NULL OR EXISTS
            (SELECT 1 FROM unnest(string_to_array(o.official_raw_status, '|')) AS s(status)
            WHERE btrim(s.status) NOT IN (:terminal)))
          AND NULLIF(o.order_url, '') IS NOT NULL AND NULLIF(o.apple_id, '') IS NOT NULL
          AND (SELECT count(*) FROM official_order_refresh_jobs j WHERE j.order_id=o.id
            AND j.created_at>now()-interval '24 hours')<10
          AND NOT EXISTS (SELECT 1 FROM official_order_refresh_jobs j WHERE j.order_id=o.id
            AND j.error_code='ORDER_ATTEMPT_LIMIT' AND j.finished_at>now()-interval '24 hours')
          AND NOT EXISTS (SELECT 1 FROM official_order_refresh_jobs j
            LEFT JOIN official_order_refresh_batches b ON b.id=j.batch_id WHERE j.order_id=o.id
            AND (j.created_at>now()-interval '3 minutes' OR j.state='running'
              OR (j.state='queued' AND b.paused_at IS NULL)
              OR (b.paused_at>now()-interval '30 minutes'
                AND NOT EXISTS (SELECT 1 FROM official_order_refresh_jobs newer WHERE newer.order_id=o.id
                  AND newer.created_at>j.created_at AND newer.state='succeeded'))))
          ORDER BY (SELECT max(j.created_at) FROM official_order_refresh_jobs j
            WHERE j.order_id=o.id) NULLS FIRST,o.id LIMIT 500`,
          { transaction, replacements: { terminal: [...TERMINAL] }, type: QueryTypes.SELECT }
        );
        const orders = await db.Order.findAll({
          where: { id: { [Op.in]: rows.map(row => row.id) } },
          transaction,
        });
        let queued = 0;
        for (const order of orders) {
          if (needsRefresh(order)) {
            await enqueueOrder(order, null, crypto.randomUUID(), transaction);
            queued++;
          }
        }
        return { queued };
      } catch (error) {
        error.component = 'paymentOfficialRefresh';
        throw error;
      }
    });
  } catch (error) {
    error.component = 'paymentOfficialRefresh';
    throw error;
  }
}
module.exports = { needsRefresh, automaticEnabled, authorizedOrder, enqueue, progress, scan };
