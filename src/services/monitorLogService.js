const { randomUUID } = require('crypto');
const { Op, QueryTypes } = require('sequelize');
const {
  sequelize,
  AosDevice,
  MonitorInstance,
  MonitorLogEntry,
  MonitorLogState,
} = require('../models');
const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');
const p = require('./monitorPolicy');
const policy = require('./monitorLogPolicy');
const blockStore = require('./monitorLogBlockStore');
const blockCompactor = require('./monitorLogBlockCompactor');
const aosSignals = require('./aosSignalService');
const accountConfigs = require('./aosAccountConfigService');
const ORDER = 'sort_at, file_id, byte_offset, id';
const TUPLE = '(sort_at, file_id, byte_offset, id)';
const MARK = '(:anchorAt::timestamptz, :anchorFile::uuid, :anchorOffset::bigint, :anchorId::uuid)';
const CONTEXT_PAGE_SIZE = 100;
const EXPORT_PAGE_SIZE = 100;
const fail = error => {
  logger.debug('完整日志操作未完成', { errorCode: error.code || error.name });
};
const safe = row => {
  const item = row.toJSON ? row.toJSON() : row;
  delete item.payloadHash;
  delete item.contextAt;
  return item;
};
async function lockDevice(deviceId, transaction) {
  try {
    const device = await AosDevice.findByPk(deviceId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!device?.enabled) throw ApiError.forbidden('采集设备已停用');
  } catch (error) {
    fail(error);
    throw error instanceof ApiError
      ? error
      : new ApiError(503, 'FULL_LOG_TEMPORARY', '日志服务暂时不可用，请稍后重试');
  }
}
/** 事务接收设备片段；同位置不同载荷拒绝。 @param {string} deviceId 设备 @param {Object} body 批次 @returns {Promise<Object>} 回执 */
async function receive(deviceId, body) {
  try {
    p.fields(body, ['entries']);
    if (!Array.isArray(body.entries) || body.entries.length < 1 || body.entries.length > 200)
      throw ApiError.badRequest('日志批次数量无效');
    const items = body.entries.map(policy.entry);
    const { first, today } = policy.retention();
    if (
      items.some(
        item =>
          item.businessDate > today ||
          ((item.loggedAt || item.contextAt) &&
            Date.parse(item.loggedAt || item.contextAt) > Date.now() + 60000)
      )
    )
      throw ApiError.badRequest('不能上传未来日志');
    return await sequelize.transaction(async transaction => {
      try {
        await lockDevice(deviceId, transaction);
        const active = items.filter(item => item.businessDate >= first);
        const expired = items.filter(item => item.businessDate < first).map(item => item.id);
        const keys = active.flatMap(item => [
          { id: item.id },
          { deviceId, fileId: item.fileId, byteOffset: item.byteOffset },
        ]);
        const existing = keys.length
          ? await MonitorLogEntry.findAll({ where: { [Op.or]: keys }, transaction })
          : [];
        const byId = new Map(existing.map(item => [item.id, item]));
        const byPosition = new Map(
          existing.map(item => [`${item.deviceId}:${item.fileId}:${item.byteOffset}`, item])
        );
        const create = [];
        const committedAt = new Date();
        for (const item of active) {
          const payloadHash = policy.digest(item);
          const position = `${deviceId}:${item.fileId}:${item.byteOffset}`;
          const previous = [byId.get(item.id), byPosition.get(position)].filter(Boolean);
          if (previous.some(row => row.deviceId !== deviceId || row.payloadHash !== payloadHash))
            throw new ApiError(409, 'LOG_PAYLOAD_CONFLICT', '日志事件或位置载荷冲突');
          if (!previous.length) {
            const row = {
              ...item,
              deviceId,
              payloadHash,
              createdAt: committedAt,
              updatedAt: committedAt,
              sortAt: item.loggedAt || item.contextAt || `${item.businessDate}T00:00:00+08:00`,
            };
            create.push(row);
            byId.set(item.id, row);
            byPosition.set(position, row);
          }
        }
        await accountConfigs.capture(
          active.map(item => ({ deviceId, localId: item.localId })),
          transaction
        );
        if (create.length) {
          const modes = new Map();
          for (const localId of [...new Set(create.map(row => row.localId))].sort())
            modes.set(localId, await blockStore.mode(deviceId, localId, transaction));
          const legacy = create.filter(row => modes.get(row.localId) !== 'blocks');
          const compressed = create.filter(row => modes.get(row.localId) !== 'rows');
          if (legacy.length) await MonitorLogEntry.bulkCreate(legacy, { transaction });
          let blockResult = { inserted: 0, blocks: 0, insertedIds: [] };
          if (compressed.length) blockResult = await blockStore.append(compressed, transaction);
          const insertedIds = new Set([
            ...legacy.map(row => row.id),
            ...(blockResult.insertedIds || []),
          ]);
          await accountConfigs.ingest(
            create.filter(row => insertedIds.has(row.id)),
            transaction
          );
          await aosSignals.enqueue(
            create.filter(row => insertedIds.has(row.id)),
            transaction
          );
          logger.info('完整日志上传指标', {
            storageModes: [...new Set(modes.values())],
            inserted:
              create.filter(row => modes.get(row.localId) === 'rows').length + blockResult.inserted,
            blocksCreated: blockResult.blocks,
            accepted: active.length,
            expired: expired.length,
          });
        }
        return { accepted: active.map(item => item.id), expired };
      } catch (error) {
        fail(error);
        if (error.name === 'SequelizeUniqueConstraintError')
          throw new ApiError(409, 'LOG_PAYLOAD_CONFLICT', '日志事件或位置载荷冲突');
        throw error instanceof ApiError
          ? error
          : new ApiError(503, 'FULL_LOG_TEMPORARY', '日志服务暂时不可用，请稍后重试');
      }
    });
  } catch (error) {
    fail(error);
    throw error instanceof ApiError
      ? error
      : new ApiError(503, 'FULL_LOG_TEMPORARY', '日志服务暂时不可用，请稍后重试');
  }
}
/** 更新采集进度，旧报告不覆盖新状态。 @param {string} deviceId 设备 @param {Object} body 状态 @returns {Promise<Object>} 回执 */
async function receiveStates(deviceId, body) {
  try {
    p.fields(body, ['observedAt', 'instances']);
    const observedAt = policy.instant(body.observedAt);
    if (Date.parse(observedAt) > Date.now() + 60000) throw ApiError.badRequest('采集状态时间无效');
    if (!Array.isArray(body.instances) || body.instances.length > 20)
      throw ApiError.badRequest('实例数量无效');
    const ids = new Set();
    const snapshots = body.instances.map(item => {
      p.fields(item, [
        'localId',
        'label',
        'state',
        'dates',
        'fileCount',
        'totalBytes',
        'scannedBytes',
        'pending',
        'issues',
        'expired',
      ]);
      const localId = p.uuid(item.localId).toLowerCase();
      if (ids.has(localId)) throw ApiError.badRequest('实例重复');
      ids.add(localId);
      const label = p.shortText(item.label, 100);
      if (
        !['ready', 'catching_up', 'backpressure', 'missing', 'unreadable', 'error'].includes(
          item.state
        )
      )
        throw ApiError.badRequest('采集状态无效');
      if (!Array.isArray(item.dates) || item.dates.length > policy.RETENTION_DAYS)
        throw ApiError.badRequest('覆盖日期无效');
      item.dates.forEach(policy.date);
      for (const key of ['fileCount', 'totalBytes', 'scannedBytes', 'pending', 'issues', 'expired'])
        p.integer(item[key], 0, Number.MAX_SAFE_INTEGER);
      if (item.scannedBytes > item.totalBytes) throw ApiError.badRequest('采集进度无效');
      return { localId, label, snapshot: { ...item, localId: undefined, label: undefined } };
    });
    await sequelize.transaction(async transaction => {
      try {
        await lockDevice(deviceId, transaction);
        await accountConfigs.capture(
          snapshots.map(item => ({ deviceId, localId: item.localId })),
          transaction
        );
        for (const item of snapshots) {
          const row = await MonitorLogState.findOne({
            where: { deviceId, localId: item.localId },
            transaction,
          });
          if (!row)
            await MonitorLogState.create(
              { id: randomUUID(), deviceId, ...item, observedAt },
              { transaction }
            );
          else if (Date.parse(observedAt) > +row.observedAt)
            await row.update({ ...item, observedAt }, { transaction });
        }
      } catch (error) {
        fail(error);
        throw error instanceof ApiError
          ? error
          : new ApiError(503, 'FULL_LOG_TEMPORARY', '日志服务暂时不可用，请稍后重试');
      }
    });
    return { accepted: true };
  } catch (error) {
    fail(error);
    throw error instanceof ApiError
      ? error
      : new ApiError(503, 'FULL_LOG_TEMPORARY', '日志服务暂时不可用，请稍后重试');
  }
}
/** 日志选择器和进度；保留已移除实例的查询能力。 @returns {Promise<Object>} 列表 */
async function states() {
  try {
    const [devices, configured, rows] = await Promise.all([
      AosDevice.findAll({
        attributes: ['id', 'name', 'enabled', 'heartbeatAt'],
        order: [['name', 'ASC']],
      }),
      MonitorInstance.findAll({ attributes: ['deviceId', 'localId', 'label', 'active'] }),
      MonitorLogState.findAll({ order: [['label', 'ASC']] }),
    ]);
    const instances = new Map(
      configured.map(row => [
        `${row.deviceId}:${row.localId}`,
        { ...row.toJSON(), snapshot: null, observedAt: null },
      ])
    );
    for (const row of rows) {
      const key = `${row.deviceId}:${row.localId}`;
      instances.set(key, {
        ...instances.get(key),
        ...row.toJSON(),
        active: instances.get(key)?.active ?? true,
        fresh: Date.now() - +row.observedAt <= 120000,
      });
    }
    return { devices, instances: [...instances.values()], ...policy.retention() };
  } catch (error) {
    fail(error);
    throw error instanceof ApiError
      ? error
      : new ApiError(503, 'FULL_LOG_TEMPORARY', '日志服务暂时不可用，请稍后重试');
  }
}
function filters(query) {
  const clauses = ['device_id=:deviceId', 'local_id=:localId'];
  if (query.startDate) clauses.push('business_date BETWEEN :startDate AND :endDate');
  else clauses.push('business_date=:date');
  const replacements = { ...query };
  if (query.account === '__unassigned__') clauses.push('account_number IS NULL');
  else if (query.account) clauses.push('account_number=:account');
  if (query.startAt) {
    clauses.push('sort_at >= :startBound::timestamptz', 'sort_at < :endBound::timestamptz');
    replacements.startBound = `${query.startAt}+08:00`;
    replacements.endBound = new Date(Date.parse(`${query.endAt}+08:00`) + 1000).toISOString();
  }
  if (query.fromTime) {
    clauses.push('logged_at >= :fromAt::timestamptz');
    replacements.fromAt = `${query.date}T${query.fromTime}+08:00`;
  }
  if (query.toTime) {
    clauses.push('logged_at < :toAt::timestamptz');
    replacements.toAt = new Date(
      Date.parse(`${query.date}T${query.toTime}+08:00`) + 1000
    ).toISOString();
  }
  if (query.keyword) {
    clauses.push("message LIKE :pattern ESCAPE '\\'");
    replacements.pattern = policy.literalSearch(query.keyword);
  }
  return { clauses, replacements };
}
function anchorValues(row) {
  return {
    anchorAt: new Date(row.sortAt).toISOString(),
    anchorFile: row.fileId,
    anchorOffset: row.byteOffset,
    anchorId: row.id,
  };
}
async function select(clauses, replacements, direction = 'ASC', limit = 50) {
  try {
    return await sequelize.query(
      `SELECT * FROM monitor_log_entries WHERE ${clauses.join(' AND ')} ORDER BY ${ORDER.split(', ')
        .map(column => `${column} ${direction}`)
        .join(', ')} LIMIT :take`,
      { replacements: { ...replacements, take: limit }, model: MonitorLogEntry, mapToModel: true }
    );
  } catch (error) {
    fail(error);
    throw error instanceof ApiError
      ? error
      : new ApiError(503, 'FULL_LOG_TEMPORARY', '日志服务暂时不可用，请稍后重试');
  }
}
function findAnchor(id, compressed) {
  return compressed
    ? blockStore.findById(id.toLowerCase())
    : MonitorLogEntry.findByPk(id.toLowerCase());
}
function sameContext(anchor, candidate, scope, bounds) {
  return (
    candidate &&
    candidate.deviceId === anchor.deviceId &&
    candidate.localId === anchor.localId &&
    candidate.businessDate >= bounds.first &&
    candidate.businessDate <= bounds.today &&
    (scope !== 'account' || candidate.accountNumber === anchor.accountNumber)
  );
}
/** 按业务日有界读取上下文；sortAt 由已校验的同日时间或该日零点生成。 */
async function surroundingPage(query, anchor, direction, limit, compressed) {
  try {
    const rows = [];
    const step = direction === 'ASC' ? 86400000 : -86400000;
    let day = anchor.businessDate;
    while (day >= query.startDate && day <= query.endDate && rows.length <= limit) {
      const dayQuery = { ...query, date: day };
      delete dayQuery.startDate;
      delete dayQuery.endDate;
      const dayAnchor = day === anchor.businessDate ? anchor : null;
      const take = limit + 1 - rows.length;
      let dailyRows;
      if (compressed) dailyRows = await blockStore.select(dayQuery, dayAnchor, direction, take);
      else {
        const { clauses, replacements } = filters(dayQuery);
        if (dayAnchor) {
          clauses.push(`${TUPLE} ${direction === 'ASC' ? '>' : '<'} ${MARK}`);
          Object.assign(replacements, anchorValues(dayAnchor));
        }
        dailyRows = await select(clauses, replacements, direction, take);
      }
      rows.push(...dailyRows);
      day = new Date(Date.parse(day) + step).toISOString().slice(0, 10);
    }
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    if (direction === 'DESC') items.reverse();
    return { items: items.map(safe), hasMore };
  } catch (error) {
    fail(error);
    throw error;
  }
}
/** 查询完整日志，绑定过滤条件的游标避免串页。 @param {Object} input 查询 @returns {Promise<Object>} 分页 */
async function list(input) {
  try {
    const query = policy.query(input);
    const { clauses, replacements } = filters(query);
    const scope = policy.digest({ ...query, cursor: '' });
    const compressed = (await blockStore.mode(query.deviceId, query.localId)) === 'blocks';
    let blockAnchor = null;
    if (query.cursor) {
      let cursor;
      try {
        cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
      } catch {
        throw ApiError.badRequest('日志游标无效');
      }
      p.fields(cursor, ['id', 'scope']);
      p.uuid(cursor.id);
      if (cursor.scope !== scope) throw ApiError.badRequest('筛选已变化，请从首页查询');
      let anchor;
      if (compressed) anchor = await blockStore.findById(cursor.id.toLowerCase());
      else
        anchor = await MonitorLogEntry.findOne({
          where: {
            id: cursor.id,
            deviceId: query.deviceId,
            localId: query.localId,
            businessDate: query.startDate
              ? { [Op.between]: [query.startDate, query.endDate] }
              : query.date,
          },
        });
      if (
        !anchor ||
        anchor.deviceId !== query.deviceId ||
        anchor.localId !== query.localId ||
        (query.startDate
          ? anchor.businessDate < query.startDate || anchor.businessDate > query.endDate
          : anchor.businessDate !== query.date)
      )
        throw ApiError.badRequest('日志游标已过期，请重新查询');
      blockAnchor = anchor;
      clauses.push(`${TUPLE} > ${MARK}`);
      Object.assign(replacements, anchorValues(anchor));
    }
    const rows = compressed
      ? await blockStore.select(query, blockAnchor, 'ASC', query.limit + 1)
      : await select(clauses, replacements, 'ASC', query.limit + 1);
    const items = rows.slice(0, query.limit).map(safe);
    return {
      items,
      nextCursor:
        rows.length > query.limit
          ? Buffer.from(JSON.stringify({ id: items.at(-1).id, scope })).toString('base64url')
          : null,
    };
  } catch (error) {
    fail(error);
    throw error instanceof ApiError
      ? error
      : new ApiError(503, 'FULL_LOG_TEMPORARY', '日志服务暂时不可用，请稍后重试');
  }
}
/** 分页账号候选，不扫描其他实例。 @param {Object} input 筛选 @returns {Promise<Object>} 编号列表 */
async function accounts(input) {
  try {
    p.fields(input, ['deviceId', 'localId', 'date', 'startDate', 'endDate', 'search', 'after']);
    const rangeMode = input.startDate !== undefined || input.endDate !== undefined;
    if (rangeMode && input.date !== undefined)
      throw ApiError.badRequest('日志日期与日期范围不能混用');
    let query;
    if (rangeMode) {
      query = {
        deviceId: p.uuid(input.deviceId).toLowerCase(),
        localId: p.uuid(input.localId).toLowerCase(),
        ...policy.dateRange(input.startDate, input.endDate),
      };
    } else
      query = policy.query({ deviceId: input.deviceId, localId: input.localId, date: input.date });
    const { clauses, replacements } = filters(query);
    clauses.push('account_number IS NOT NULL');
    if (input.search) {
      p.shortText(input.search, 64);
      clauses.push("account_number LIKE :pattern ESCAPE '\\'");
      replacements.pattern = policy.literalSearch(input.search);
    }
    if (input.after) {
      if (!/^\d{1,64}$/.test(input.after)) throw ApiError.badRequest('账号游标无效');
      clauses.push('account_number > :after');
      replacements.after = input.after;
    }
    if ((await blockStore.mode(query.deviceId, query.localId)) === 'blocks')
      return await blockStore.accounts(query, input);
    const rows = await sequelize.query(
      `SELECT DISTINCT account_number AS account FROM monitor_log_entries WHERE ${clauses.join(' AND ')} ORDER BY account_number LIMIT 101`,
      { replacements, type: QueryTypes.SELECT }
    );
    return {
      items: rows.slice(0, 100).map(row => row.account),
      nextCursor: rows.length > 100 ? rows[99].account : null,
    };
  } catch (error) {
    fail(error);
    throw error instanceof ApiError
      ? error
      : new ApiError(503, 'FULL_LOG_TEMPORARY', '日志服务暂时不可用，请稍后重试');
  }
}
/** 同实例90日内连续账号或实例上下文，支持以边界事件双向翻页。 @param {string} id 片段ID @param {Object} input 范围 @returns {Promise<Object>} 上下文 */
async function context(id, input) {
  try {
    p.uuid(id);
    p.fields(input, ['scope', 'cursor', 'direction', 'limit']);
    if (!['account', 'instance'].includes(input.scope)) throw ApiError.badRequest('上下文范围无效');
    if (input.direction && !['before', 'after'].includes(input.direction))
      throw ApiError.badRequest('上下文方向无效');
    if (Boolean(input.cursor) !== Boolean(input.direction))
      throw ApiError.badRequest('上下文游标与方向必须同时提供');
    const limit = p.integer(Number(input.limit ?? CONTEXT_PAGE_SIZE), 1, CONTEXT_PAGE_SIZE);
    const cursorId = input.cursor ? p.uuid(input.cursor).toLowerCase() : '';
    const legacyAnchor = await MonitorLogEntry.findByPk(id);
    const candidate = legacyAnchor || (await blockStore.findById(id.toLowerCase()));
    const compressed =
      candidate && (await blockStore.mode(candidate.deviceId, candidate.localId)) === 'blocks';
    const anchor = compressed ? await blockStore.findById(id.toLowerCase()) : legacyAnchor;
    const { first, today } = policy.retention();
    if (!anchor || anchor.businessDate < first || anchor.businessDate > today)
      throw ApiError.notFound();
    if (input.scope === 'account' && !anchor.accountNumber)
      throw ApiError.badRequest('该日志未识别账号，请查看实例上下文');
    const query = {
      deviceId: anchor.deviceId,
      localId: anchor.localId,
      startDate: first,
      endDate: today,
      account: input.scope === 'account' ? anchor.accountNumber : '',
    };
    if (cursorId) {
      const cursor = await findAnchor(cursorId, compressed);
      if (!sameContext(anchor, cursor, input.scope, { first, today }))
        throw ApiError.badRequest('上下文游标已过期，请重新打开详情');
      const direction = input.direction === 'before' ? 'DESC' : 'ASC';
      const page = await surroundingPage(query, cursor, direction, limit, compressed);
      return {
        anchorId: id,
        scope: input.scope,
        direction: input.direction,
        items: page.items,
        hasMore: page.hasMore,
      };
    }
    const [before, after] = await Promise.all([
      surroundingPage(query, anchor, 'DESC', limit, compressed),
      surroundingPage(query, anchor, 'ASC', limit, compressed),
    ]);
    return {
      anchorId: id,
      scope: input.scope,
      direction: null,
      items: [...before.items, safe(anchor), ...after.items],
      hasMoreBefore: before.hasMore,
      hasMoreAfter: after.hasMore,
    };
  } catch (error) {
    fail(error);
    throw error instanceof ApiError
      ? error
      : new ApiError(503, 'FULL_LOG_TEMPORARY', '日志服务暂时不可用，请稍后重试');
  }
}
/** 准备单实例范围流式导出，首批先读取以便在响应头发送前失败。 @param {Object} input 范围 @returns {Promise<Object>} 导出状态 */
async function prepareExport(input) {
  try {
    p.fields(input, ['deviceId', 'localId', 'date', 'startAt', 'endAt']);
    const query = policy.query(input);
    const compressed = (await blockStore.mode(query.deviceId, query.localId)) === 'blocks';
    const pageFilters = filters(query);
    const rows = compressed
      ? await blockStore.select(query, null, 'ASC', EXPORT_PAGE_SIZE)
      : await select(pageFilters.clauses, pageFilters.replacements, 'ASC', EXPORT_PAGE_SIZE);
    return {
      query,
      compressed,
      rows,
      fileName: `aos-${query.date || `${query.startAt.replace(/:/g, '-')}_${query.endAt.replace(/:/g, '-')}`}-${query.deviceId.slice(0, 8)}-${query.localId.slice(0, 8)}.log`,
    };
  } catch (error) {
    fail(error);
    throw error instanceof ApiError
      ? error
      : new ApiError(503, 'FULL_LOG_TEMPORARY', '日志服务暂时不可用，请稍后重试');
  }
}
/** 有界分页写出范围原文；write 返回 false 时停止，避免客户端断开后继续扫描。 @param {Object} prepared 导出状态 @param {Function} write 写入函数 @returns {Promise<Object>} 导出指标 */
async function writeExport(prepared, write) {
  const started = Date.now();
  let rows = prepared.rows;
  let exported = 0;
  let anchor = null;
  try {
    while (rows.length) {
      for (const row of rows) {
        if ((await write(row.message)) === false)
          return { exported, aborted: true, durationMs: Date.now() - started };
        exported++;
      }
      anchor = rows.at(-1);
      if (rows.length < EXPORT_PAGE_SIZE) break;
      if (prepared.compressed)
        rows = await blockStore.select(prepared.query, anchor, 'ASC', EXPORT_PAGE_SIZE);
      else {
        const pageFilters = filters(prepared.query);
        rows = await select(
          [...pageFilters.clauses, `${TUPLE} > ${MARK}`],
          { ...pageFilters.replacements, ...anchorValues(anchor) },
          'ASC',
          EXPORT_PAGE_SIZE
        );
      }
    }
    const result = { exported, aborted: false, durationMs: Date.now() - started };
    logger.info('完整日志导出指标', {
      ...result,
      deviceId: prepared.query.deviceId,
      localId: prepared.query.localId,
      businessDate: prepared.query.date,
      startAt: prepared.query.startAt,
      endAt: prepared.query.endAt,
      storage: prepared.compressed ? 'blocks' : 'rows',
    });
    return result;
  } catch (error) {
    fail(error);
    throw error instanceof ApiError
      ? error
      : new ApiError(503, 'FULL_LOG_TEMPORARY', '日志服务暂时不可用，请稍后重试');
  }
}
/** 有界清理90天外原文；独立数据库互斥、小批提交及耗时预算。 @returns {Promise<Object>} 清理指标 */
async function cleanup() {
  const started = Date.now();
  const budgetMs = Math.max(
    1000,
    Math.min(60000, Number(process.env.MONITOR_LOG_CLEANUP_BUDGET_MS) || 15000)
  );
  const maxPages = Math.max(1, Math.min(200, Number(process.env.MONITOR_LOG_CLEANUP_PAGES) || 40));
  let deleted = 0;
  let receipts = 0;
  try {
    const { first, today } = policy.retention();
    // A dedicated pooled connection holds the session lock across individual batch commits.
    const connection = await sequelize.connectionManager.getConnection({ type: 'WRITE' });
    let locked = false;
    try {
      const result = await connection.query('SELECT pg_try_advisory_lock(709101,1) AS locked');
      locked = result.rows[0].locked;
      if (!locked) return { skipped: true, reason: 'busy' };
      for (let page = 0; page < maxPages && Date.now() - started < budgetMs; page++) {
        const progress = await sequelize.transaction(async transaction => {
          try {
            await sequelize.query("SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='5s'", {
              transaction,
            });
            const rows = await sequelize.query(
              'DELETE FROM monitor_log_entries WHERE id IN (SELECT id FROM monitor_log_entries WHERE business_date < :first ORDER BY business_date LIMIT 5000) RETURNING id',
              { replacements: { first }, transaction, type: QueryTypes.SELECT }
            );
            const blocks = await blockStore.cleanup(first, transaction, 5000);
            return { legacy: rows.length, receipts: blocks.deleted };
          } catch (error) {
            fail(error);
            throw error;
          }
        });
        deleted += progress.legacy;
        receipts += progress.receipts;
        if (progress.legacy < 5000 && progress.receipts < 5000) break;
      }
      await MonitorLogState.destroy({
        where: { observedAt: { [Op.lt]: new Date(`${first}T00:00:00+08:00`) } },
      });
      const remainingBudget = budgetMs - (Date.now() - started);
      let compaction = { skipped: true, reason: 'cleanup-budget' };
      if (remainingBudget >= 1000)
        compaction = await blockCompactor.compact({
          first,
          today,
          budgetMs: Math.min(5000, remainingBudget),
          maxBatches: Math.max(
            1,
            Math.min(100, Number(process.env.MONITOR_LOG_COMPACTION_BATCHES) || 100)
          ),
        });
      const oldest = await sequelize.query(
        `
        SELECT min(day) AS oldest FROM (
          SELECT min(business_date) AS day FROM monitor_log_entries
          UNION ALL SELECT min(business_date) FROM monitor_log_receipts) d`,
        { type: QueryTypes.SELECT }
      );
      const metrics = {
        compaction,
        deleted,
        receipts,
        first,
        oldest: oldest[0]?.oldest,
        durationMs: Date.now() - started,
        budgetExhausted: Date.now() - started >= budgetMs,
      };
      await sequelize.query(
        `INSERT INTO monitor_log_storage_metrics(name,value) VALUES('cleanup',:value::jsonb)
        ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
        { replacements: { value: JSON.stringify(metrics) } }
      );
      const capacity = await blockStore.capacity();
      await sequelize.query(
        `INSERT INTO monitor_log_storage_metrics(name,value) VALUES('capacity',:value::jsonb)
        ON CONFLICT(name) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,
        {
          replacements: {
            value: JSON.stringify({ ...capacity, observedAt: new Date().toISOString() }),
          },
        }
      );
      logger.info('完整日志清理指标', metrics);
      logger.info('完整日志容量指标', capacity);
      return metrics;
    } finally {
      let destroyed = false;
      try {
        if (locked) await connection.query('SELECT pg_advisory_unlock(709101,1)');
      } catch (error) {
        logger.warn('完整日志清理连接解锁失败，销毁连接', { errorCode: error.code || error.name });
        await sequelize.connectionManager.destroyConnection(connection);
        destroyed = true;
      }
      if (!destroyed) await sequelize.connectionManager.releaseConnection(connection);
    }
  } catch (error) {
    logger.warn('完整日志清理失败', {
      deleted,
      receipts,
      durationMs: Date.now() - started,
      errorCode: error.code || error.name,
    });
    throw error instanceof ApiError
      ? error
      : new ApiError(503, 'FULL_LOG_TEMPORARY', '日志服务暂时不可用，请稍后重试');
  }
}
module.exports = {
  receive,
  receiveStates,
  states,
  list,
  accounts,
  context,
  prepareExport,
  writeExport,
  cleanup,
};
