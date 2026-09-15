const { randomUUID, createHash } = require('crypto');
const { Op, QueryTypes } = require('sequelize');
const {
  sequelize,
  AosDevice,
  MonitorRule,
  MonitorInstance,
  MonitorTraffic,
  MonitorAlert,
  MonitorAction,
  MonitorNotificationDelivery,
} = require('../models');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const p = require('./monitorPolicy');
const notification = require('./monitorNotificationService');
const MINUTE_MS = 60000;
const RETENTION_MS = 90 * 86400000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain = row => (row.toJSON ? row.toJSON() : row);
const conflict = () => new ApiError(409, 'CONCURRENT_MODIFICATION', '内容已更新，请刷新后重试');
async function ruleContext(transaction) {
  try {
    const rules = (await MonitorRule.findAll({ order: [['id', 'ASC']], transaction })).map(plain);
    return {
      revision: hash(rules.map(r => [r.id, r.version, r.config])),
      rules: rules.map(r => ({ id: r.id, version: r.version, ...r.config })),
    };
  } catch (error) {
    logger.debug('监控操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/**
 * 设备规则下发，只使用设备认证。
 * @param {string} deviceId 已认证设备UUID
 * @returns {Promise<Object>} 处理结果
 */
async function context(deviceId) {
  try {
    const data = await ruleContext();
    return {
      revision: data.revision,
      rules: data.rules.filter(
        r => r.enabled && (!r.deviceIds.length || r.deviceIds.includes(deviceId))
      ),
    };
  } catch (error) {
    logger.debug('监控操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/**
 * 网站安全资源列表，不带凭据和订单遥测。
 * @returns {Promise<Object>} 处理结果
 */
async function overview() {
  try {
    const [devices, instances, rules, alerts, notificationSettings] = await Promise.all([
      AosDevice.findAll({
        attributes: ['id', 'name', 'enabled', 'heartbeatAt'],
        order: [['name', 'ASC']],
      }),
      MonitorInstance.findAll({ order: [['label', 'ASC']] }),
      MonitorRule.findAll({ order: [['createdAt', 'ASC']] }),
      MonitorAlert.findAll({ where: { status: 'active' }, order: [['lastSeenAt', 'DESC']] }),
      notification.settings(),
    ]);
    const revision = hash(
      [...rules].sort((a, b) => a.id.localeCompare(b.id)).map(r => [r.id, r.version, r.config])
    );
    return {
      revision,
      devices,
      rules,
      notificationSettings,
      instances: instances.map(row => {
        const item = plain(row);
        const display = p.displayState(item);
        const device = devices.find(d => d.id === item.deviceId);
        return {
          ...item,
          ...display,
          ...(display.fresh && item.snapshot.revision !== revision
            ? { state: 'rules_pending', actionable: false }
            : {}),
          ...(device?.enabled ? {} : { state: 'disabled', actionable: false }),
          ...(!item.active ? { state: 'removed', actionable: false } : {}),
          alerts: alerts.filter(a => a.instanceId === item.id),
        };
      }),
    };
  } catch (error) {
    logger.debug('监控操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/**
 * 乐观锁更新规则并终止旧版本告警。
 * @param {number} actorId 操作者ID
 * @param {string|null} id 规则UUID
 * @param {Object} body 配置与乐观锁版本
 * @returns {Promise<Object>} 处理结果
 */
async function saveRule(actorId, id, body) {
  try {
    p.fields(body, ['config', 'expectedVersion']);
    const config = p.validateRule(body.config);
    if (id) p.uuid(id);
    return await sequelize.transaction(async transaction => {
      try {
        await sequelize.query("SELECT pg_advisory_xact_lock(hashtext('server-monitor-rules'))", {
          transaction,
        });
        if (
          config.deviceIds.length &&
          (await AosDevice.count({ where: { id: { [Op.in]: config.deviceIds } }, transaction })) !==
            config.deviceIds.length
        )
          throw ApiError.badRequest('适用服务器不存在');
        if (config.directoryIds.length) {
          const directories = await MonitorInstance.findAll({
            where: { localId: { [Op.in]: config.directoryIds } },
            attributes: ['localId'],
            transaction,
          });
          if (new Set(directories.map(d => d.localId)).size !== config.directoryIds.length)
            throw ApiError.badRequest('适用实例不存在');
        }
        let row;
        if (id) {
          row = await MonitorRule.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
          if (!row) throw ApiError.notFound();
          if (row.version !== body.expectedVersion) throw conflict();
          await row.update({ config, version: row.version + 1 }, { transaction });
          await MonitorAlert.update(
            { status: 'rule_changed' },
            { where: { ruleId: id, status: 'active' }, transaction }
          );
        } else {
          if ((await MonitorRule.count({ transaction })) >= 100)
            throw ApiError.badRequest('规则最多100条');
          row = await MonitorRule.create({ id: randomUUID(), config, version: 1 }, { transaction });
        }
        await MonitorAction.create(
          {
            id: randomUUID(),
            actorId,
            action: 'rule_save',
            note: '',
            details: { ruleId: row.id, version: row.version, config },
          },
          { transaction }
        );
        return row;
      } catch (error) {
        logger.debug('监控操作未完成', { errorCode: error.code || error.name });
        throw error;
      }
    });
  } catch (error) {
    logger.debug('监控操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/**
 * 不保存测试正文。
 * @param {Object} body 规则与临时测试文本
 * @returns {Object} 处理结果
 */
function testRule(body) {
  p.fields(body, ['rule', 'text']);
  const rule = p.validateRule(body.rule);
  const text = p.shortText(body.text, 20000, true);
  const lines = text.split(/\r?\n/);
  return {
    count: lines.filter(l => p.matches(rule, l)).length,
    lines: lines.map((l, i) => (p.matches(rule, l) ? i + 1 : null)).filter(Boolean),
  };
}
function validateReport(report, now) {
  p.fields(report, ['id', 'revision', 'startedAt', 'endedAt', 'traffic', 'instances']);
  p.uuid(report.id);
  if (typeof report.revision !== 'string' || !/^[a-f0-9]{64}$/.test(report.revision))
    throw ApiError.badRequest('规则版本无效');
  const start = new Date(report.startedAt);
  const end = new Date(report.endedAt);
  if (
    !Number.isFinite(+start) ||
    !Number.isFinite(+end) ||
    end <= start ||
    end - start > 120000 ||
    end > +now + MINUTE_MS ||
    start < +now - RETENTION_MS
  )
    throw ApiError.badRequest('报告时间无效');
  p.fields(report.traffic, [
    'receivedBytes',
    'sentBytes',
    'collectorReceivedBytes',
    'collectorSentBytes',
    'quality',
  ]);
  for (const key of ['receivedBytes', 'sentBytes', 'collectorReceivedBytes', 'collectorSentBytes'])
    p.integer(report.traffic[key], 0, Number.MAX_SAFE_INTEGER);
  if (!['complete', 'gap', 'unavailable'].includes(report.traffic.quality))
    throw ApiError.badRequest('流量质量无效');
  if (!Array.isArray(report.instances) || report.instances.length > 20)
    throw ApiError.badRequest('实例数量无效');
  const ids = new Set();
  for (const instance of report.instances) {
    p.fields(instance, ['localId', 'label', 'state', 'files', 'results']);
    p.uuid(instance.localId);
    p.shortText(instance.label, 100);
    if (ids.has(instance.localId)) throw ApiError.badRequest('实例重复');
    ids.add(instance.localId);
    if (
      !['ready', 'missing', 'unreadable', 'invalid', 'catching_up'].includes(instance.state) ||
      !Array.isArray(instance.files) ||
      instance.files.length > 200 ||
      !Array.isArray(instance.results) ||
      instance.results.length > 100
    )
      throw ApiError.badRequest('实例状态无效');
    instance.files.forEach(f => {
      if (!/^Log\d{8}_[\w-]+\.txt$/.test(f) || f.length > 100)
        throw ApiError.badRequest('日志文件名无效');
    });
    const resultIds = new Set();
    for (const r of instance.results) {
      p.fields(r, ['ruleId', 'count', 'samples']);
      p.uuid(r.ruleId);
      p.integer(r.count, 0, 1000000);
      if (resultIds.has(r.ruleId)) throw ApiError.badRequest('规则结果重复');
      resultIds.add(r.ruleId);
      if (!Array.isArray(r.samples) || r.samples.length > 3) throw ApiError.badRequest('样例过多');
      r.samples.forEach(s => {
        p.fields(s, ['at', 'file', 'keywords', 'lineNumber', 'message', 'truncated']);
        if (
          !Number.isFinite(+new Date(s.at)) ||
          !instance.files.includes(s.file) ||
          !Array.isArray(s.keywords) ||
          s.keywords.length > 20
        )
          throw ApiError.badRequest('样例无效');
        s.keywords.forEach(k => p.shortText(k, 100));
        if (s.lineNumber !== undefined) p.integer(s.lineNumber, 1, 1000000000);
        if (
          s.message !== undefined &&
          (typeof s.message !== 'string' || s.message.length > 4000 || s.message.includes('\0'))
        )
          throw ApiError.badRequest('日志正文无效');
        if (s.truncated !== undefined && typeof s.truncated !== 'boolean')
          throw ApiError.badRequest('日志截断标记无效');
      });
    }
  }
}
/**
 * 事务接收分钟报告，去重流量并按新鲜且完整的规则结果更新告警。
 * @param {string} deviceId 已认证设备UUID
 * @param {Object} body 有界报告批次
 * @param {Date} now 服务端当前时间
 * @returns {Promise<Object>} 处理结果
 */
async function receive(deviceId, body, now = new Date()) {
  try {
    p.fields(body, ['reports']);
    if (!Array.isArray(body.reports) || body.reports.length < 1 || body.reports.length > 10)
      throw ApiError.badRequest('报告数量无效');
    body.reports.forEach(r => validateReport(r, now));
    return await sequelize.transaction(async transaction => {
      try {
        await sequelize.query("SELECT pg_advisory_xact_lock(hashtext('server-monitor-rules'))", {
          transaction,
        });
        const device = await AosDevice.findByPk(deviceId, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!device?.enabled) throw new ApiError(403, 'DEVICE_DISABLED', '设备已停用');
        const current = await ruleContext(transaction);
        const accepted = [];
        for (const report of body.reports) {
          const digest = hash(report);
          const existing = await MonitorTraffic.findByPk(report.id, { transaction });
          if (existing) {
            if (existing.deviceId !== deviceId || existing.payloadHash !== digest) throw conflict();
            accepted.push(report.id);
            continue;
          }
          const overlap = await MonitorTraffic.findOne({
            where: {
              deviceId,
              startedAt: { [Op.lt]: report.endedAt },
              endedAt: { [Op.gt]: report.startedAt },
            },
            attributes: ['id'],
            transaction,
          });
          if (overlap)
            throw new ApiError(409, 'MONITOR_INTERVAL_OVERLAP', '采样区间重叠，请检查采集器时间');
          await MonitorTraffic.create(
            {
              id: report.id,
              deviceId,
              startedAt: report.startedAt,
              endedAt: report.endedAt,
              ...report.traffic,
              payloadHash: digest,
            },
            { transaction }
          );
          const fresh = now - new Date(report.endedAt) <= 120000 && new Date(report.endedAt) <= now;
          const newer = await MonitorTraffic.findOne({
            where: { deviceId, endedAt: { [Op.gt]: report.endedAt } },
            attributes: ['id'],
            transaction,
          });
          if (!fresh || newer) {
            accepted.push(report.id);
            continue;
          }
          const deviceInstances = await MonitorInstance.findAll({
            where: { deviceId },
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          const deviceAlerts = deviceInstances.length
            ? await MonitorAlert.findAll({
              where: {
                instanceId: { [Op.in]: deviceInstances.map(i => i.id) },
                status: 'active',
              },
              transaction,
              lock: transaction.LOCK.UPDATE,
            })
            : [];
          const seen = [];
          for (const observed of report.instances) {
            let instance = deviceInstances.find(i => i.localId === observed.localId);
            if (!instance)
              instance = await MonitorInstance.create(
                { id: randomUUID(), deviceId, localId: observed.localId, label: observed.label },
                { transaction }
              );
            seen.push(instance.id);
            if (instance.observedAt && new Date(instance.observedAt) >= new Date(report.endedAt))
              continue;
            const applicable = current.rules.filter(r => p.applies(r, deviceId, observed.localId));
            const valid =
              fresh &&
              report.revision === current.revision &&
              observed.state === 'ready' &&
              applicable.every(r => observed.results.some(result => result.ruleId === r.id));
            // 原始日志仅允许有界字段，并继续校验关键词必须来自对应规则。
            const results = observed.results
              .filter(r => applicable.some(rule => rule.id === r.ruleId))
              .map(r => ({
                ...r,
                samples: r.samples.map(s => ({
                  at: s.at,
                  file: s.file,
                  keywords: s.keywords.filter(k =>
                    applicable.find(rule => rule.id === r.ruleId).keywords.includes(k)
                  ),
                  ...(s.lineNumber === undefined ? {} : { lineNumber: s.lineNumber }),
                  ...(s.message === undefined ? {} : { message: s.message }),
                  ...(s.truncated === undefined ? {} : { truncated: s.truncated }),
                })),
              }));
            const previousObservationAt = instance.observedAt;
            await instance.update(
              {
                label: observed.label,
                active: true,
                observedAt: report.endedAt,
                snapshot: {
                  state:
                    report.revision !== current.revision
                      ? 'rules_pending'
                      : observed.state === 'ready' && !valid
                        ? 'invalid'
                        : observed.state,
                  revision: report.revision,
                  files: observed.files,
                  results,
                },
              },
              { transaction }
            );
            const active = deviceAlerts.filter(a => a.instanceId === instance.id);
            if (
              fresh &&
              (!valid ||
                (previousObservationAt &&
                  new Date(report.endedAt) - new Date(previousObservationAt) > 90000))
            ) {
              for (const alert of active)
                if (alert.quietChecks) await alert.update({ quietChecks: 0 }, { transaction });
            }
            for (const rule of applicable) {
              const result = results.find(r => r.ruleId === rule.id);
              const alert = active.find(a => a.ruleId === rule.id);
              const change = p.transition(alert, rule, result?.count || 0, report.endedAt, valid);
              if (!change) continue;
              if (alert) {
                await alert.update(
                  {
                    ...change,
                    ...(result?.count >= rule.threshold ? { samples: result.samples } : {}),
                  },
                  { transaction }
                );
                if (change.status === 'recovered')
                  await notification.enqueueRecovery(
                    {
                      alertId: alert.id,
                      instanceId: instance.id,
                      deviceId,
                      instanceLabel: instance.label,
                      ruleName: alert.ruleName,
                      severity: alert.severity,
                      hitCount: alert.hitCount,
                      at: report.endedAt,
                    },
                    transaction
                  );
              } else {
                const created = await MonitorAlert.create(
                  {
                    id: randomUUID(),
                    instanceId: instance.id,
                    ruleId: rule.id,
                    ruleVersion: rule.version,
                    ruleName: rule.name,
                    severity: rule.severity,
                    firstSeenAt: report.endedAt,
                    samples: result.samples,
                    ...change,
                  },
                  { transaction }
                );
                await notification.enqueueAlert(
                  {
                    alertId: created.id,
                    instanceId: instance.id,
                    deviceId,
                    instanceLabel: instance.label,
                    ruleName: rule.name,
                    severity: rule.severity,
                    hitCount: result.count,
                    at: report.endedAt,
                  },
                  transaction
                );
              }
            }
          }
          if (fresh && report.revision === current.revision)
            await MonitorInstance.update(
              { active: false, observedAt: report.endedAt },
              {
                where: {
                  deviceId,
                  id: { [Op.notIn]: seen },
                  [Op.or]: [{ observedAt: null }, { observedAt: { [Op.lt]: report.endedAt } }],
                },
                transaction,
              }
            );
          accepted.push(report.id);
        }
        return { accepted };
      } catch (error) {
        logger.debug('监控操作未完成', { errorCode: error.code || error.name });
        throw error;
      }
    });
  } catch (error) {
    logger.debug('监控操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/**
 * 记录实例级处理与静默，乐观锁避免覆盖另一用户操作。
 * @param {number} actorId 操作者ID
 * @param {string} id 实例UUID
 * @param {Object} body 动作、时长、备注与版本
 * @param {Date} now 当前时间
 * @returns {Promise<Object>} 处理结果
 */
async function act(actorId, id, body, now = new Date()) {
  try {
    p.uuid(id);
    p.fields(body, ['action', 'minutes', 'note', 'expectedVersion']);
    if (!['start', 'ignore', 'extend', 'end', 'complete', 'note'].includes(body.action))
      throw ApiError.badRequest('操作无效');
    const note = p.shortText(body.note ?? '', 500, true);
    const minutes = body.minutes ?? 30;
    if (![15, 30, 60, 120].includes(minutes)) throw ApiError.badRequest('静默时长无效');
    return await sequelize.transaction(async transaction => {
      try {
        const instance = await MonitorInstance.findByPk(id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!instance) throw ApiError.notFound();
        if (instance.version !== body.expectedVersion) throw conflict();
        let handling = { ...instance.handling };
        if (['start', 'ignore', 'extend'].includes(body.action)) {
          const base =
            body.action === 'extend' ? Math.max(+now, +new Date(handling.until || 0)) : +now;
          handling = {
            status: body.action === 'ignore' ? 'ignored' : 'processing',
            actorId,
            startedAt: handling.startedAt || now.toISOString(),
            until: new Date(base + minutes * MINUTE_MS).toISOString(),
            note,
          };
        } else if (body.action !== 'note')
          handling = {
            ...handling,
            status: body.action === 'complete' ? 'completed' : 'ended',
            until: now.toISOString(),
            actorId,
            note,
          };
        await instance.update({ handling, version: instance.version + 1 }, { transaction });
        await MonitorAction.create(
          {
            id: randomUUID(),
            instanceId: id,
            actorId,
            action: body.action,
            note,
            details: { until: handling.until || null },
          },
          { transaction }
        );
        if (['start', 'ignore', 'extend'].includes(body.action))
          await notification.enqueueReminder(
            {
              instanceId: instance.id,
              deviceId: instance.deviceId,
              instanceLabel: instance.label,
              until: handling.until,
              at: handling.until,
            },
            transaction
          );
        return instance;
      } catch (error) {
        logger.debug('监控操作未完成', { errorCode: error.code || error.name });
        throw error;
      }
    });
  } catch (error) {
    logger.debug('监控操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/**
 * 按实例分页读取告警与人工操作历史。
 * @param {string} id 实例UUID
 * @param {number} page 页码
 * @returns {Promise<Object>} 处理结果
 */
async function history(id, page = 1) {
  try {
    p.uuid(id);
    p.integer(page, 1, 100000);
    const options = {
      where: { instanceId: id, createdAt: { [Op.gte]: new Date(Date.now() - RETENTION_MS) } },
      limit: 30,
      offset: (page - 1) * 30,
      order: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ],
    };
    const [alerts, actions] = await Promise.all([
      MonitorAlert.findAndCountAll(options),
      MonitorAction.findAndCountAll(options),
    ]);
    return { alerts, actions, page };
  } catch (error) {
    logger.debug('监控操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/**
 * 数据库内按北京时间小时聚合，边界样本按时长分摊，避免传输90天原始明细。
 * @param {Object} query 北京时间日期与设备过滤
 * @returns {Promise<Object>} 处理结果
 */
async function traffic(query) {
  try {
    p.fields(query, ['from', 'to', 'deviceIds']);
    const { start, end } = p.dateRange(query.from, query.to);
    const ids = query.deviceIds ? query.deviceIds.split(',').map(p.uuid) : [];
    if (ids.length > 100) throw ApiError.badRequest('设备过多');
    const rows = await sequelize.query(
      `WITH samples AS (
      SELECT *, greatest(started_at, :start::timestamptz) AS a, least(ended_at, :end::timestamptz) AS b
      FROM monitor_traffic WHERE ended_at > :start::timestamptz AND started_at < :end::timestamptz
      AND ended_at >= NOW() - INTERVAL '90 days' ${ids.length ? 'AND device_id IN (:ids)' : ''}
    ), slices AS (
      SELECT samples.*, h, EXTRACT(EPOCH FROM least(b,h+INTERVAL '1 hour')-greatest(a,h)) AS seconds,
      EXTRACT(EPOCH FROM ended_at-started_at) AS duration
      FROM samples CROSS JOIN LATERAL generate_series(date_trunc('hour',a),date_trunc('hour',b-INTERVAL '1 microsecond'),INTERVAL '1 hour') h
    ) SELECT device_id AS "deviceId", to_char(h AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,
      to_char(h AT TIME ZONE 'Asia/Shanghai','HH24:00') AS hour,
      SUM(received_bytes*seconds/duration)::float8 AS "receivedBytes", SUM(sent_bytes*seconds/duration)::float8 AS "sentBytes",
      SUM(collector_received_bytes*seconds/duration)::float8 AS "collectorReceivedBytes", SUM(collector_sent_bytes*seconds/duration)::float8 AS "collectorSentBytes",
      SUM(CASE WHEN quality='complete' THEN seconds ELSE 0 END)::float8 AS "coveredSeconds",
      SUM(CASE WHEN quality<>'complete' THEN seconds ELSE 0 END)::float8 AS "gapSeconds"
      FROM slices GROUP BY device_id,h ORDER BY h,device_id`,
      {
        replacements: { start: start.toISOString(), end: end.toISOString(), ids },
        type: QueryTypes.SELECT,
      }
    );
    return { rows, from: query.from, to: query.to, unit: 'bytes', timezone: 'Asia/Shanghai' };
  } catch (error) {
    logger.debug('监控操作未完成', { errorCode: error.code || error.name });
    throw error;
  }
}
/**
 * 只清理监控历史；事务及锁支持多API实例。
 * @returns {Promise<void>} 处理结果
 */
async function cleanup() {
  try {
    const before = new Date(Date.now() - RETENTION_MS);
    await sequelize.transaction(async transaction => {
      try {
        await sequelize.query(
          "SELECT pg_advisory_xact_lock(hashtext('server-monitor-retention'))",
          { transaction }
        );
        await MonitorTraffic.destroy({ where: { endedAt: { [Op.lt]: before } }, transaction });
        await MonitorAction.destroy({ where: { createdAt: { [Op.lt]: before } }, transaction });
        await MonitorAlert.destroy({ where: { lastSeenAt: { [Op.lt]: before } }, transaction });
        await MonitorNotificationDelivery.destroy({
          where: { createdAt: { [Op.lt]: before } },
          transaction,
        });
        await MonitorInstance.update(
          { snapshot: {}, handling: {} },
          { where: { observedAt: { [Op.lt]: before } }, transaction }
        );
      } catch (error) {
        logger.debug('监控操作未完成', { errorCode: error.code || error.name });
        throw error;
      }
    });
  } catch (error) {
    logger.warn('监控历史清理未完成', { errorCode: error.name });
  }
}
module.exports = { context, overview, saveRule, testRule, receive, act, history, traffic, cleanup };

let cleanupTimer;
let cleanupRun = null;
/**
 * 启动本模块历史保留任务。
 * @returns {void} 处理结果
 */
function start() {
  if (cleanupTimer) return;
  const tick = () => {
    if (!cleanupRun)
      cleanupRun = cleanup().finally(() => {
        cleanupRun = null;
      });
  };
  cleanupTimer = setInterval(tick, 3600000);
  cleanupTimer.unref();
  tick();
}
/**
 * 停止领取清理并等待在途事务。
 * @returns {Promise<void>} 处理结果
 */
async function stop() {
  try {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    if (cleanupRun) await cleanupRun;
  } catch (error) {
    logger.warn('等待监控清理结束失败', { errorCode: error.name });
  }
}
module.exports.start = start;
module.exports.stop = stop;
