const { Op, QueryTypes } = require('sequelize');
const policy = require('./aosAccountConfigPolicy');
const logger = require('../utils/logger');
const MAX_ACCOUNTS = 10000;
const MAX_EVENTS = 20000;

/** 已校验接收事务记录实例捕获启用水位；只写一次，不设置ready。 @param {Object[]} scopes 设备及实例 @param {Object} transaction 接收事务 @param {Object} models 可选模型 @returns {Promise<void>} 完成 */
async function capture(scopes, transaction, models = require('../models')) {
  try {
    if (!models.AosAccountIndexState || !scopes.length) return;
    const unique = new Map(scopes.map(row => [policy.digest([row.deviceId, row.localId]), row]));
    const replacements = {};
    const values = [...unique]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, row], index) => {
        replacements[`id${index}`] = id;
        replacements[`device${index}`] = row.deviceId;
        replacements[`local${index}`] = row.localId;
        return `(:id${index},:device${index},:local${index},jsonb_build_object('captureStartedAt',clock_timestamp()::text))`;
      });
    await models.sequelize.query(
      `INSERT INTO aos_account_index_states AS target(id,device_id,local_id,body)
      VALUES ${values.join(',')} ON CONFLICT(id) DO UPDATE
      SET body=target.body || EXCLUDED.body,updated_at=now()
      WHERE target.body->>'captureStartedAt' IS NULL`,
      { replacements, transaction }
    );
  } catch (error) {
    throw new Error('AOS_ACCOUNT_CAPTURE_FAILED', { cause: error });
  }
}

/** 实际新增日志事务内写稀疏索引；不调用信号发送，不受3分钟鲜度限制。 @param {Object[]} rows 新日志 @param {Object} transaction 事务 @param {Object} models 可选模型 @returns {Promise<Object>} 统计 */
async function ingest(rows, transaction, models = require('../models')) {
  try {
    if (!models.AosAccountConfigEvent) return { events: 0, accounts: 0 };
    const parsed = policy.parse(rows);
    const db = models.sequelize;
    // 稳定顺序避免多个实例回填与实时上报反向持锁。
    parsed.accounts.sort((a, b) => a.id.localeCompare(b.id));
    if (parsed.accounts.length) {
      const replacements = {};
      const values = parsed.accounts.map((row, index) => {
        for (const key of ['id', 'deviceId', 'localId', 'accountNumber', 'firstSeenAt'])
          replacements[`${key}${index}`] = row[key];
        return `(:id${index},:deviceId${index},:localId${index},:accountNumber${index},:firstSeenAt${index})`;
      });
      await db.query(
        `INSERT INTO aos_account_registries(id,device_id,local_id,account_number,first_seen_at)
        VALUES ${values.join(',')} ON CONFLICT(id) DO UPDATE SET first_seen_at=EXCLUDED.first_seen_at,updated_at=now()
        WHERE EXCLUDED.first_seen_at<aos_account_registries.first_seen_at`,
        { replacements, transaction }
      );
    }
    if (parsed.events.length) {
      parsed.events.sort((a, b) => a.id.localeCompare(b.id));
      await models.AosAccountConfigEvent.bulkCreate(parsed.events, {
        transaction,
        ignoreDuplicates: true,
      });
      const persisted = await models.AosAccountConfigEvent.findAll({
        where: { id: { [Op.in]: parsed.events.map(row => row.id) } },
        attributes: ['id', 'payloadHash'],
        transaction,
      });
      const hashes = new Map(persisted.map(row => [row.id, row.payloadHash]));
      if (parsed.events.some(row => hashes.get(row.id) !== row.payloadHash))
        throw new Error('ACCOUNT_INDEX_EVENT_CONFLICT');
    }
    const scopes = new Map(
      [...parsed.accounts, ...parsed.gaps].map(row => [`${row.deviceId}:${row.localId}`, row])
    );
    for (const row of scopes.values()) {
      const id = policy.digest([row.deviceId, row.localId]);
      await models.AosAccountIndexState.findOrCreate({
        where: { id },
        defaults: { deviceId: row.deviceId, localId: row.localId, status: 'pending', body: {} },
        transaction,
      });
      const gaps = parsed.gaps.filter(
        gap => gap.deviceId === row.deviceId && gap.localId === row.localId
      );
      if (gaps.length) {
        const state = await models.AosAccountIndexState.findByPk(id, {
          transaction,
          lock: transaction?.LOCK?.UPDATE,
        });
        const merged = [
          ...new Map(
            [...(state.body.gaps || []), ...gaps].map(gap => [policy.digest(gap), gap])
          ).values(),
        ];
        await state.update(
          {
            body: {
              ...state.body,
              gaps: merged.slice(-1000),
              gapOverflow: state.body.gapOverflow || merged.length > 1000,
            },
          },
          { transaction }
        );
      }
    }
    return { events: parsed.events.length, accounts: parsed.accounts.length };
  } catch (error) {
    logger.warn('AOS账号设置索引事务未完成', {
      errorCode:
        error.message === 'ACCOUNT_INDEX_EVENT_CONFLICT'
          ? error.message
          : error.original?.code || error.name,
    });
    throw new Error('AOS_ACCOUNT_INDEX_WRITE_FAILED', { cause: error });
  }
}

/** 在给定日志时段裁剪到每账号首hit前最后启动以及之后的稀疏事件。 @param {Object} models 模型 @param {Object} source 实例 @param {number} from 首hit @param {number} to 最后hit @param {Object} transaction 事务 @returns {Promise<Object>} 有界索引和覆盖 */
async function loadUnsafe(models, source, from, to, transaction) {
  try {
    if (!models.AosAccountRegistry)
      return { ready: false, reason: 'INDEX_UNAVAILABLE', registries: [], events: [] };
    const where = { deviceId: source.deviceId, localId: source.localId };
    const [registries, states, monitors, instances, devices] = await Promise.all([
      models.AosAccountRegistry.findAll({
        where: { ...where, firstSeenAt: { [Op.lte]: new Date(to) } },
        limit: MAX_ACCOUNTS + 1,
        transaction,
      }),
      models.AosAccountIndexState.findAll({ where, transaction }),
      models.MonitorLogState.findAll({ where, transaction }),
      models.MonitorInstance.findAll({ where, transaction }),
      models.AosDevice.findAll({ where: { id: source.deviceId }, transaction }),
    ]);
    const state = states[0];
    const monitor = monitors[0];
    const snapshot = monitor?.snapshot;
    let reason = null;
    if (devices.some(row => row.enabled === false)) reason = 'DEVICE_DISABLED';
    else if (instances.some(row => row.active === false)) reason = 'INSTANCE_DISABLED';
    else if (!state || state.status !== 'ready') reason = state?.body?.reason || 'BACKFILL_PENDING';
    else if (
      !snapshot ||
      snapshot.state !== 'ready' ||
      snapshot.pending ||
      snapshot.scannedBytes !== snapshot.totalBytes ||
      +new Date(monitor.observedAt) < to
    )
      reason = 'LOG_COVERAGE_INCOMPLETE';
    else if (registries.length > MAX_ACCOUNTS) reason = 'ACCOUNT_LIMIT';
    // expired是累计历史淘汰计数，仅在回填期间增量或可用日期丢失时由backfill标缺口，不能永久禁用新完整窗口。
    const events = await models.sequelize.query(
      `WITH starts AS (
      SELECT DISTINCT ON(account_number) account_number,logged_at FROM aos_account_config_events
      WHERE device_id=:deviceId AND local_id=:localId AND kind='start' AND logged_at<=:from
      ORDER BY account_number,logged_at DESC,byte_offset DESC,line_index DESC
    ), raw_events AS (
      SELECT e.*,sum(CASE WHEN e.kind='start' THEN 1 ELSE 0 END) OVER
        (PARTITION BY e.account_number ORDER BY e.logged_at,e.file_id,e.byte_offset,e.line_index) AS epoch
      FROM aos_account_config_events e LEFT JOIN starts s ON s.account_number=e.account_number
      WHERE e.device_id=:deviceId AND e.local_id=:localId AND e.kind<>'signal' AND e.logged_at<=:to
      AND (s.logged_at IS NULL OR e.logged_at>=s.logged_at)
    ), compact AS (
      SELECT *,row_number() OVER(PARTITION BY account_number,file_id,epoch,kind,body ORDER BY logged_at,byte_offset,line_index) AS repeated
      FROM raw_events
    ) SELECT e.id,e.device_id AS "deviceId",e.local_id AS "localId",e.account_number AS "accountNumber",
      e.file_id AS "fileId",e.byte_offset AS "byteOffset",e.line_index AS "lineIndex",e.logged_at AS "loggedAt",e.kind,e.body
      FROM compact e WHERE e.kind='start' OR e.repeated=1
      ORDER BY e.logged_at,e.file_id,e.byte_offset,e.line_index LIMIT :limit`,
      {
        replacements: { ...where, from: new Date(from), to: new Date(to), limit: MAX_EVENTS + 1 },
        transaction,
        type: QueryTypes.SELECT,
      }
    );
    if (events.length > MAX_EVENTS) reason = 'CONFIG_EVENT_LIMIT';
    return {
      ready: !reason,
      reason,
      registries: registries.map(row => (row.toJSON ? row.toJSON() : row)),
      events,
      gaps: state?.body?.gaps || [],
      gapOverflow: Boolean(state?.body?.gapOverflow),
      coverage: {
        indexStatus: state?.status || null,
        observedAt: monitor?.observedAt || null,
        accountCount: registries.length,
        eventCount: events.length,
      },
    };
  } catch (error) {
    logger.warn('AOS账号比例索引读取降级', { errorCode: error.original?.code || error.name });
    throw new Error('AOS_ACCOUNT_INDEX_READ_FAILED', { cause: error });
  }
}

/** 用独立signal索引补齐旧API创建的无账号anchor，绝不反推任务摘要。 @param {Object} models 模型 @param {Object[]} anchors 信号 @param {Object} transaction 事务 @returns {Promise<Object[]>} 信号 */
async function attachAccountsUnsafe(models, anchors, transaction) {
  try {
    if (!models.AosAccountConfigEvent || !anchors.length) return anchors;
    const rows = await models.AosAccountConfigEvent.findAll({
      where: { id: { [Op.in]: anchors.map(row => row.id) }, kind: 'signal' },
      transaction,
    });
    const byId = new Map(rows.map(row => [row.id, row]));
    return anchors.map(anchor => {
      const event = byId.get(anchor.id);
      return {
        ...anchor,
        accountNumber:
          event &&
          !event.body.invalid &&
          ['deviceId', 'localId', 'fileId'].every(key => anchor[key] === event[key]) &&
          String(anchor.byteOffset) === String(event.byteOffset) &&
          (anchor.lineIndex || 0) === event.lineIndex &&
          +new Date(anchor.loggedAt) === +new Date(event.loggedAt)
            ? event.accountNumber
            : null,
      };
    });
  } catch (error) {
    logger.warn('AOS信号账号映射暂不可用', { errorCode: error.original?.code || error.name });
    throw new Error('AOS_ACCOUNT_MAP_READ_FAILED', { cause: error });
  }
}

/** 保存点隔离SQL失败，父信号事务不会留在aborted状态。 @param {Object} models 模型 @param {Object} parent 父事务 @param {Function} work 工作 @returns {Promise<*>} 结果 */
async function isolated(models, parent, work) {
  try {
    return await models.sequelize.transaction({ transaction: parent }, async transaction => {
      try {
        const [setting] = await models.sequelize.query(
          "SELECT current_setting('statement_timeout') AS timeout",
          { type: QueryTypes.SELECT, transaction }
        );
        await models.sequelize.query("SET LOCAL statement_timeout='1500ms'", { transaction });
        const result = await work(transaction);
        await models.sequelize.query("SELECT set_config('statement_timeout',:timeout,true)", {
          replacements: { timeout: setting.timeout },
          transaction,
        });
        return result;
      } catch (error) {
        throw new Error('AOS_ACCOUNT_READ_ISOLATED', { cause: error });
      }
    });
  } catch (error) {
    throw new Error('AOS_ACCOUNT_OPERATION_FAILED', { cause: error });
  }
}

/** 有界快照失败时仅比例降级。 @param {Object} models 模型 @param {Object} source 来源 @param {number} from 首hit @param {number} to 末hit @param {Object} transaction 事务 @returns {Promise<Object>} 快照 */
async function load(models, source, from, to, transaction) {
  try {
    if (!models.AosAccountRegistry)
      return { ready: false, reason: 'INDEX_UNAVAILABLE', registries: [], events: [] };
    return await isolated(models, transaction, nested =>
      loadUnsafe(models, source, from, to, nested)
    );
  } catch (_error) {
    return { ready: false, reason: 'INDEX_READ_FAILED', registries: [], events: [] };
  }
}

/** 旧API信号按原位置补编号，失败仅令比例未知。 @param {Object} models 模型 @param {Object[]} anchors 信号 @param {Object} transaction 事务 @returns {Promise<Object[]>} 信号 */
async function attachAccounts(models, anchors, transaction) {
  try {
    const missing = anchors.filter(row => !/^\d{1,64}$/.test(row.accountNumber || ''));
    if (!models.AosAccountConfigEvent || !missing.length) return anchors;
    const attached = await isolated(models, transaction, nested =>
      attachAccountsUnsafe(models, missing, nested)
    );
    const byId = new Map(attached.map(row => [row.id, row]));
    return anchors.map(row => byId.get(row.id) || row);
  } catch (_error) {
    return anchors.map(row => ({
      ...row,
      accountNumber: /^\d{1,64}$/.test(row.accountNumber || '') ? row.accountNumber : null,
    }));
  }
}

module.exports = { capture, ingest, load, attachAccounts, MAX_ACCOUNTS, MAX_EVENTS };
