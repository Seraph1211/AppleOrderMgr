/* eslint-disable no-control-regex -- 校验并拒绝路径中的控制字符。 */
const logger = require('../utils/logger');
/** 来源管理、设备遥测与补录进度。 */
const crypto = require('crypto');
const {
  sequelize,
  IngestionSetting,
  IngestionOperation,
  AosDevice,
  AosRecord,
  EmailLog,
  EmailWorkerState,
} = require('../models');
const ApiError = require('../utils/ApiError');
const repo = require('./ingestionRepository');
const aos = require('./aosIngestionService');
const { Op } = repo;

/** 按设备聚合服务器计数。 @param {string[]} ids 设备 @param {Object} transaction 事务 @returns {Promise<Map>} 计数 */
async function deviceCounts(ids, transaction) {
  if (!ids.length) return new Map();
  try {
    const { from, toExclusive } = repo.dayBounds();
    const [rows] = await sequelize.query(
      `SELECT device_id AS "deviceId",
      COUNT(*) FILTER (WHERE received_at >= :from AND received_at < :toExclusive) AS "todayReceived",
      COUNT(*) FILTER (WHERE status = 'succeeded') AS created,
      COUNT(*) FILTER (WHERE status = 'duplicate') AS duplicate,
      COUNT(*) FILTER (WHERE status = 'manual_review') AS "manualReview",
      COUNT(*) FILTER (WHERE eligibility != 'allowed' AND status NOT IN ('succeeded','duplicate','closed')) AS paused
      FROM aos_records WHERE device_id IN (:ids) GROUP BY device_id`,
      { replacements: { from, toExclusive, ids }, transaction }
    );
    return new Map(
      rows.map(row => [
        row.deviceId,
        Object.fromEntries(
          Object.entries(row)
            .filter(([k]) => k !== 'deviceId')
            .map(([k, v]) => [k, Number(v)])
        ),
      ])
    );
  } catch (error) {
    logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
    throw error;
  }
}

function deviceDto(device, counts = {}) {
  const t = device.telemetry || {};
  const online = Boolean(
    device.heartbeatAt && Date.now() - new Date(device.heartbeatAt).getTime() < 60000
  );
  return {
    id: device.id,
    name: device.name,
    notes: device.notes,
    enabled: device.enabled,
    version: device.version,
    credentialVersion: device.credentialVersion,
    credentialConfigured: Boolean(device.credentialHash),
    agentVersion: t.agentVersion || null,
    osVersion: t.osVersion || null,
    lastHeartbeatAt: device.heartbeatAt,
    lastSuccessfulScanAt: t.lastSuccessfulScanAt || null,
    lastNewOrderAt: t.lastNewOrderAt || null,
    online,
    scanHealthy:
      online &&
      Boolean(t.scanReceivedAt && Date.now() - Date.parse(t.scanReceivedAt) < 60000) &&
      (t.directories || []).length > 0 &&
      (t.directories || []).every(d => ['ready', 'waiting_file'].includes(d.state)),
    directories: t.directories || [],
    localCounts: t.localCounts || { pendingUpload: 0, uploadError: 0, todayDiscovered: 0 },
    serverCounts: {
      todayReceived: 0,
      created: 0,
      duplicate: 0,
      manualReview: 0,
      paused: 0,
      ...counts,
    },
    countsBusinessDate: t.countsBusinessDate || repo.businessDate(),
    lastErrorCode: t.lastErrorCode || null,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
  };
}

/** 读取设置和真实就绪摘要。 @returns {Promise<Object>} SettingsDto */
async function getSettings(transaction = null, currentSettings = null) {
  try {
    const [settings, worker, devices] = await Promise.all([
      currentSettings || IngestionSetting.findByPk(1, { transaction }),
      EmailWorkerState.findByPk(1, { transaction }),
      AosDevice.findAll({ where: { enabled: true }, transaction }),
    ]);
    if (!settings) throw new ApiError(503, 'TEMPORARILY_UNAVAILABLE', '来源设置尚未初始化');
    return {
      activeSource: settings.activeSource,
      version: settings.version,
      effectiveAt: settings.effectiveAt,
      timeZone: 'Asia/Shanghai',
      backfillPolicy: 'current_day',
      duplicatePolicy: 'keep_existing',
      duplicatePolicyStatus: 'confirmed',
      updatedBy: settings.updatedBy ? { id: settings.updatedBy } : null,
      readiness: {
        email: {
          ready: Boolean(
            worker?.isConnected &&
            worker?.heartbeatAt &&
            Date.now() - new Date(worker.heartbeatAt).getTime() < 60000 &&
            worker.lastScanSucceededAt &&
            Date.now() - new Date(worker.lastScanSucceededAt).getTime() < 90000
          ),
          lastSuccessfulScanAt: worker?.lastScanSucceededAt || null,
          errorCode: worker?.lastScanErrorCode || null,
        },
        aos: {
          ready: devices.some(d => deviceDto(d).scanHealthy),
          enabledDeviceCount: devices.length,
          onlineDeviceCount: devices.filter(d => deviceDto(d).online).length,
          healthyDirectoryDeviceCount: devices.filter(d => deviceDto(d).scanHealthy).length,
        },
      },
    };
  } catch (error) {
    logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
    throw error;
  }
}

/** 创建不触发扫描的切换预览。 @param {Object} req 请求 @returns {Promise<Object>} 预览 */
function switchPreview(req) {
  repo.assertFields(req.body, ['targetSource', 'expectedVersion']);
  if (!['email', 'aos'].includes(req.body.targetSource)) throw ApiError.badRequest('数据源无效');
  return repo.ingestionTransaction(async (transaction, settings) => {
    try {
      repo.assertVersion(settings, req.body.expectedVersion);
      const id = crypto.randomUUID();
      const day = repo.businessDate();
      const bounds = repo.dayBounds(day);
      const model = req.body.targetSource === 'aos' ? AosRecord : EmailLog;
      const where =
        req.body.targetSource === 'aos'
          ? { orderDate: { [Op.gte]: bounds.from, [Op.lt]: bounds.toExclusive } }
          : { receivedAt: { [Op.gte]: bounds.from, [Op.lt]: bounds.toExclusive } };
      const knownPendingCount = await model.count({
        where: {
          ...where,
          status: { [Op.notIn]: ['succeeded', 'superseded', 'duplicate', 'closed', 'ignored'] },
        },
        transaction,
      });
      const knownDuplicateCount = await model.count({
        where: { ...where, status: { [Op.in]: ['superseded', 'duplicate'] } },
        transaction,
      });
      const readiness = (await getSettings(transaction, settings)).readiness;
      const warnings = ['数量仅涵盖服务器已知记录；离线设备或尚未回查的邮件不在此计数中。'];
      if (!readiness[req.body.targetSource].ready)
        warnings.push('目标来源当前未就绪，切换后将等待邮件 Worker 或采集器恢复。');
      const data = {
        previewId: id,
        targetSource: req.body.targetSource,
        settingsVersion: settings.version,
        serverTime: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        businessDate: day,
        ...bounds,
        knownPendingCount,
        knownDuplicateCount,
        inventoryComplete: false,
        warnings,
      };
      await IngestionOperation.create(
        {
          id,
          kind: 'preview',
          scope: `preview:${id}`,
          actorId: req.user.id,
          status: 'ready',
          data,
          expiresAt: data.expiresAt,
        },
        { transaction }
      );
      return data;
    } catch (error) {
      logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
      throw error;
    }
  });
}

async function newOperation(kind, scope, data, transaction, extras = {}) {
  try {
    return await IngestionOperation.create(
      { id: crypto.randomUUID(), kind, scope, data, status: 'queued', ...extras },
      { transaction }
    );
  } catch (error) {
    logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
    throw error;
  }
}

/** 切换与补录任务同事务提交。 @param {Object} req 请求 @returns {Promise<Object>} 结果 */
function switchSource(req) {
  repo.assertFields(req.body, ['activeSource', 'expectedVersion', 'previewId']);
  repo.requireUuid(req.body.previewId);
  if (!['email', 'aos'].includes(req.body.activeSource)) throw ApiError.badRequest('数据源无效');
  return repo.manageOperation(req, async (transaction, settings) => {
    try {
      repo.assertVersion(settings, req.body.expectedVersion);
      const preview = await IngestionOperation.findByPk(req.body.previewId, { transaction });
      if (
        !preview ||
        preview.kind !== 'preview' ||
        preview.actorId !== req.user.id ||
        preview.expiresAt <= new Date() ||
        preview.data.businessDate !== repo.businessDate() ||
        preview.data.targetSource !== req.body.activeSource ||
        preview.data.settingsVersion !== settings.version
      )
        throw ApiError.conflict('切换预览已失效', undefined, 'PREVIEW_EXPIRED');
      if (settings.activeSource === req.body.activeSource)
        return {
          settings: await getSettings(transaction, settings),
          backfillId: null,
          warnings: [],
        };
      const oldSource = settings.activeSource;
      settings.activeSource = req.body.activeSource;
      settings.version += 1;
      settings.effectiveAt = new Date();
      settings.updatedBy = req.user.id;
      await settings.save({ transaction });
      await IngestionOperation.update(
        { status: 'superseded' },
        {
          where: {
            kind: { [Op.in]: ['backfill', 'scan'] },
            status: { [Op.notIn]: ['completed', 'superseded'] },
          },
          transaction,
        }
      );
      const day = repo.businessDate();
      const devices =
        settings.activeSource === 'aos'
          ? await AosDevice.findAll({ where: { enabled: true }, transaction })
          : [];
      const backfill = await newOperation(
        'backfill',
        `backfill:${settings.version}`,
        {
          source: settings.activeSource,
          settingsVersion: settings.version,
          businessDate: day,
          ...repo.dayBounds(day),
          deviceIds: devices.map(d => d.id),
        },
        transaction
      );
      for (const device of devices)
        await newOperation(
          'scan',
          `scan:${backfill.id}:${device.id}`,
          {
            backfillId: backfill.id,
            businessDate: day,
            settingsVersion: settings.version,
            ...repo.dayBounds(day),
          },
          transaction,
          { deviceId: device.id }
        );
      await EmailLog.update(
        { ingestionPauseReason: settings.activeSource === 'email' ? null : 'source_disabled' },
        { where: { status: { [Op.notIn]: ['succeeded', 'superseded', 'ignored'] } }, transaction }
      );
      await repo.refreshEligibility(settings, transaction);
      await repo.audit(
        req.user,
        `切换 ${oldSource} → ${settings.activeSource}`,
        `设置版本 ${settings.version}；补录 ${backfill.id}`,
        transaction
      );
      return {
        settings: await getSettings(transaction, settings),
        backfillId: backfill.id,
        warnings: preview.data.warnings,
      };
    } catch (error) {
      logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
      throw error;
    }
  });
}

/** 设备新增、编辑或轮换；旧凭证立即失效。 @param {string} action 操作 @param {Object} req 请求 @returns {Promise<Object>} 结果 */
function manageDevice(action, req) {
  repo.assertFields(
    req.body,
    action === 'create'
      ? ['name', 'notes']
      : action === 'rotate'
        ? ['expectedVersion']
        : ['expectedVersion', 'name', 'notes', 'enabled']
  );
  if (action !== 'create') repo.requireUuid(req.params.id);
  for (const [field, max] of [
    ['name', 100],
    ['notes', 500],
  ]) {
    if ((action === 'create' && field === 'name') || Object.hasOwn(req.body, field)) {
      if (
        typeof req.body[field] !== 'string' ||
        req.body[field].length > max ||
        (field === 'name' && !req.body[field].trim())
      )
        throw ApiError.badRequest(`${field} 格式无效`);
    }
  }
  if (Object.hasOwn(req.body, 'enabled') && typeof req.body.enabled !== 'boolean')
    throw ApiError.badRequest('enabled 必须为布尔值');
  if (action === 'edit' && Object.keys(req.body).length < 2)
    throw ApiError.badRequest('至少修改一个字段');
  return repo.manageOperation(req, async (transaction, settings) => {
    try {
      let device;
      let credential;
      if (action === 'create') {
        const created = repo.createCredential();
        credential = created.credential;
        device = await AosDevice.create(
          {
            id: crypto.randomUUID(),
            name: req.body.name,
            notes: req.body.notes || null,
            credentialHash: created.credentialHash,
          },
          { transaction }
        );
      } else {
        device = await AosDevice.findByPk(req.params.id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!device) throw ApiError.notFound();
        repo.assertVersion(device, req.body.expectedVersion);
        if (action === 'rotate') {
          const created = repo.createCredential();
          credential = created.credential;
          device.credentialHash = created.credentialHash;
          device.credentialVersion += 1;
        } else {
          for (const field of ['name', 'notes', 'enabled'])
            if (Object.hasOwn(req.body, field)) device[field] = req.body[field];
        }
        device.version += 1;
        await device.save({ transaction });
      }
      if (
        device.enabled &&
        settings.activeSource === 'aos' &&
        (action === 'create' || req.body.enabled === true)
      ) {
        await newOperation(
          'scan',
          `first-scan:${device.id}:${device.version}`,
          {
            backfillId: null,
            businessDate: repo.businessDate(),
            settingsVersion: settings.version,
            ...repo.dayBounds(),
          },
          transaction,
          { deviceId: device.id }
        );
      }
      await repo.refreshEligibility(settings, transaction);
      await repo.audit(req.user, `设备 ${action}`, device.id, transaction);
      return {
        device: deviceDto(device),
        ...(credential ? { credential, credentialDisplayed: false } : {}),
      };
    } catch (error) {
      logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
      throw error;
    }
  });
}

async function collectorState(device, settings, transaction) {
  try {
    const requests = await IngestionOperation.findAll({
      where: {
        kind: 'scan',
        deviceId: device.id,
        status: { [Op.in]: ['queued', 'running', 'failed'] },
      },
      transaction,
    });
    let capturePermitId = null;
    if (settings.activeSource === 'aos') {
      const scope = `permit:${device.id}:${repo.businessDate()}:${settings.version}`;
      let permit = await IngestionOperation.findOne({ where: { scope }, transaction });
      if (!permit)
        permit = await newOperation(
          'permit',
          scope,
          { businessDate: repo.businessDate(), settingsVersion: settings.version },
          transaction,
          { deviceId: device.id, status: 'active' }
        );
      capturePermitId = permit.id;
    }
    return {
      device: {
        id: device.id,
        name: device.name,
        enabled: device.enabled,
        credentialVersion: device.credentialVersion,
      },
      protocolVersion: 1,
      serverTime: new Date().toISOString(),
      settingsVersion: settings.version,
      activeSource: settings.activeSource,
      businessDate: repo.businessDate(),
      capturePermitId,
      backfillPolicy: 'current_day',
      limits: {
        maxBatchRecords: 100,
        maxRequestBytes: 1048576,
        maxRawLineBytes: 16384,
        heartbeatIntervalSeconds: 15,
      },
      serverCounts:
        (await deviceCounts([device.id], transaction)).get(device.id) ||
        deviceDto(device).serverCounts,
      countsBusinessDate: repo.businessDate(),
      pendingScanRequests: requests.map(r => ({ id: r.id, ...r.data })),
    };
  } catch (error) {
    logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
    throw error;
  }
}

/** 设备连接上下文，许可按日和设置版本持久化。 @param {string} header 凭证 @returns {Promise<Object>} 上下文 */
function context(header) {
  return repo.ingestionTransaction(async (transaction, settings) => {
    try {
      return await collectorState(
        await repo.authenticateDevice(header, transaction),
        settings,
        transaction
      );
    } catch (error) {
      logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
      throw error;
    }
  });
}

function validateHeartbeat(body) {
  repo.assertFields(body, [
    'heartbeatId',
    'agentVersion',
    'osVersion',
    'observedAt',
    'lastSuccessfulScanAt',
    'lastNewOrderAt',
    'directories',
    'localCounts',
    'scanResults',
  ]);
  repo.requireUuid(body.heartbeatId);
  for (const field of ['agentVersion', 'osVersion'])
    if (typeof body[field] !== 'string' || !body[field] || body[field].length > 100)
      throw ApiError.badRequest('版本信息无效');
  for (const field of ['observedAt', 'lastSuccessfulScanAt', 'lastNewOrderAt'])
    if (!aos.validTimestamp(body[field], field !== 'observedAt'))
      throw ApiError.badRequest('遥测时间无效');
  if (
    !Array.isArray(body.directories) ||
    body.directories.length > 20 ||
    !Array.isArray(body.scanResults) ||
    body.scanResults.length > 100
  )
    throw ApiError.badRequest('遥测列表无效');
  for (const dir of body.directories) {
    repo.assertFields(dir, [
      'directoryId',
      'label',
      'state',
      'currentFileNames',
      'lastSuccessfulScanAt',
      'errorCode',
    ]);
    repo.requireUuid(dir.directoryId);
    if (
      typeof dir.label !== 'string' ||
      dir.label.length > 100 ||
      /[/\\]/.test(dir.label) ||
      !['ready', 'waiting_file', 'unreadable', 'missing'].includes(dir.state) ||
      !Array.isArray(dir.currentFileNames) ||
      dir.currentFileNames.length > 20 ||
      dir.currentFileNames.some(
        n => typeof n !== 'string' || n.length > 255 || /[/\\\u0000-\u001f]/.test(n)
      ) ||
      !aos.validTimestamp(dir.lastSuccessfulScanAt, true) ||
      (dir.errorCode !== null && !/^[A-Z_]{1,100}$/.test(dir.errorCode))
    )
      throw ApiError.badRequest('目录状态无效');
  }
  repo.assertFields(body.localCounts, ['pendingUpload', 'uploadError', 'todayDiscovered']);
  for (const field of ['pendingUpload', 'uploadError', 'todayDiscovered'])
    if (!Number.isSafeInteger(body.localCounts[field]) || body.localCounts[field] < 0)
      throw ApiError.badRequest('计数无效');
  for (const scan of body.scanResults) {
    repo.assertFields(scan, [
      'scanRequestId',
      'status',
      'discoveredCount',
      'receiptedCount',
      'pendingUploadCount',
      'errorCode',
    ]);
    repo.requireUuid(scan.scanRequestId);
    if (
      !['running', 'completed', 'failed', 'superseded'].includes(scan.status) ||
      ['discoveredCount', 'receiptedCount', 'pendingUploadCount'].some(
        k => !Number.isSafeInteger(scan[k]) || scan[k] < 0
      ) ||
      (scan.errorCode !== null && !/^[A-Z_]{1,100}$/.test(scan.errorCode)) ||
      (scan.status === 'completed' &&
        (scan.discoveredCount !== scan.receiptedCount || scan.pendingUploadCount !== 0))
    )
      throw ApiError.badRequest('扫描结果无效');
  }
}

/** 保存白名单遥测，重复心跳不刷新已过期扫描。 @param {string} header 凭证 @param {Object} body 请求 @returns {Promise<Object>} 上下文 */
function heartbeat(header, body) {
  validateHeartbeat(body);
  return repo.ingestionTransaction(async (transaction, settings) => {
    try {
      const device = await repo.authenticateDevice(header, transaction);
      const seenHeartbeats = device.telemetry?.recentHeartbeatIds || [];
      if (
        !seenHeartbeats.includes(body.heartbeatId) &&
        (!device.telemetry?.observedAt ||
          Date.parse(body.observedAt) > Date.parse(device.telemetry.observedAt))
      ) {
        const old = device.telemetry || {};
        const now = new Date();
        device.telemetry = {
          recentHeartbeatIds: [...seenHeartbeats, body.heartbeatId].slice(-256),
          agentVersion: body.agentVersion,
          osVersion: body.osVersion,
          observedAt: body.observedAt,
          lastSuccessfulScanAt: body.lastSuccessfulScanAt,
          lastNewOrderAt: body.lastNewOrderAt,
          directories: body.directories,
          localCounts: body.localCounts,
          scanReceivedAt:
            body.lastSuccessfulScanAt && body.lastSuccessfulScanAt !== old.lastSuccessfulScanAt
              ? now.toISOString()
              : old.scanReceivedAt || null,
          countsBusinessDate: repo.businessDate(),
          lastErrorCode: body.directories.find(d => d.errorCode)?.errorCode || null,
        };
        device.heartbeatId = body.heartbeatId;
        device.heartbeatAt = now;
        await device.save({ transaction });
        for (const result of body.scanResults) {
          const scan = await IngestionOperation.findOne({
            where: { id: result.scanRequestId, deviceId: device.id, kind: 'scan' },
            transaction,
          });
          if (!scan) throw ApiError.badRequest('扫描任务不属于此设备');
          if (scan.status === 'superseded') continue;
          if (result.status === 'completed') {
            const count = await IngestionOperation.count({
              where: { kind: 'scan_record', scope: { [Op.like]: `scan-record:${scan.id}:%` } },
              transaction,
            });
            if (count !== result.receiptedCount)
              throw ApiError.badRequest('扫描回执尚未与服务器可靠接收记录核对');
          }
          scan.status = result.status;
          scan.data = { ...scan.data, result };
          await scan.save({ transaction });
        }
      }
      return collectorState(device, settings, transaction);
    } catch (error) {
      logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
      throw error;
    }
  });
}

/** 查询补录并结合扫描回执和实际入库状态计算进度。 @param {string} id ID @returns {Promise<Object>} 进度 */
async function getBackfill(id) {
  repo.requireUuid(id);
  try {
    const op = await IngestionOperation.findByPk(id);
    if (!op || op.kind !== 'backfill') throw ApiError.notFound();
    const scans = await IngestionOperation.findAll({
      where: { kind: 'scan', scope: { [Op.like]: `scan:${id}:%` } },
    });
    const data = op.data;
    let rows;
    if (data.source === 'aos') {
      const scanRefs = scans.length
        ? await IngestionOperation.findAll({
          where: {
            kind: 'scan_record',
            [Op.or]: scans.map(scan => ({ scope: { [Op.like]: `scan-record:${scan.id}:%` } })),
          },
          attributes: ['data'],
        })
        : [];
      rows = await AosRecord.findAll({
        where: {
          deviceId: { [Op.in]: data.deviceIds },
          [Op.or]: [
            { id: { [Op.in]: scanRefs.map(ref => ref.data.aosRecordId) } },
            { orderDate: { [Op.gte]: data.from, [Op.lt]: data.toExclusive } },
            { orderDate: null, receivedAt: { [Op.gte]: data.from, [Op.lt]: data.toExclusive } },
          ],
        },
        attributes: ['status'],
      });
    } else {
      const refs = await IngestionOperation.findAll({
        where: { kind: 'backfill_record', scope: { [Op.like]: `backfill-record:${id}:%` } },
        attributes: ['data'],
      });
      const mails = await EmailLog.findAll({
        where: { id: { [Op.in]: refs.map(r => r.data.emailLogId) } },
        attributes: ['status', 'parsedData', 'finalData', 'ingestionPauseReason'],
      });
      rows = mails.filter(row => {
        const date = row.finalData?.orderDate || row.parsedData?.orderDate;
        return (
          row.ingestionPauseReason !== 'out_of_range' &&
          (!date || repo.businessDate(date) === data.businessDate)
        );
      });
    }
    const counts = { received: rows.length, created: 0, duplicate: 0, manualReview: 0, pending: 0 };
    for (const row of rows) {
      if (row.status === 'succeeded') counts.created += 1;
      else if (['duplicate', 'superseded'].includes(row.status)) counts.duplicate += 1;
      else if (row.status === 'manual_review') counts.manualReview += 1;
      else if (!['closed', 'ignored'].includes(row.status)) counts.pending += 1;
    }
    const scanned =
      data.source === 'aos'
        ? scans.length > 0 && scans.every(s => s.status === 'completed')
        : Boolean(data.scanCompletedAt);
    const status =
      op.status === 'superseded'
        ? 'superseded'
        : scanned && counts.pending === 0
          ? 'completed'
          : scans.some(s => s.status === 'completed')
            ? 'partial'
            : 'waiting_source';
    return {
      id,
      ...data,
      status,
      counts,
      devices: scans.map(s => ({
        deviceId: s.deviceId,
        status: s.status,
        lastScanAt: s.updatedAt,
        errorCode: s.data.result?.errorCode || null,
      })),
      errorCode: data.errorCode || null,
      createdAt: op.createdAt,
      updatedAt: op.updatedAt,
    };
  } catch (error) {
    logger.debug('来源操作未完成', { errorCode: error.code || 'DATABASE_TEMPORARY' });
    throw error;
  }
}

module.exports = {
  deviceDto,
  deviceCounts,
  getSettings,
  switchPreview,
  switchSource,
  manageDevice,
  context,
  heartbeat,
  getBackfill,
};
