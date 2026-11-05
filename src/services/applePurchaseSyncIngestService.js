const { QueryTypes } = require('sequelize');
const ApiError = require('../utils/ApiError');
const { getIngestDatabase } = require('./applePurchaseSyncDatabase');
const { batchDigest, digest } = require('./applePurchaseSyncDigest');
const { hashToken } = require('./applePurchaseSyncTerminalService');

function serverTime() {
  return new Date().toISOString();
}

function successData(batchId, accepted, duplicates, highWater) {
  return {
    batchId,
    accepted,
    duplicates,
    highWater: {
      observations: String(highWater.observations),
      monitorChanges: String(highWater.monitorChanges),
    },
    serverTime: serverTime(),
  };
}

async function authenticateToken(rawToken, transaction) {
  if (typeof rawToken !== 'string' || rawToken.length < 48 || rawToken.length > 160) {
    throw new ApiError(401, 'UNAUTHORIZED', '终端凭据无效');
  }
  const database = getIngestDatabase();
  const rows = await database.query(
    `SELECT id, enabled,
      observation_high_water::text AS "observationHighWater",
      monitor_change_high_water::text AS "monitorChangeHighWater"
     FROM apple_purchase_sync.terminals
     WHERE token_hash = :tokenHash
     FOR UPDATE`,
    { replacements: { tokenHash: hashToken(rawToken) }, type: QueryTypes.SELECT, transaction }
  );
  if (!rows.length) throw new ApiError(401, 'UNAUTHORIZED', '终端凭据无效');
  if (!rows[0].enabled) throw new ApiError(401, 'TERMINAL_DISABLED', '终端已禁用');
  return rows[0];
}

/** 校验机器 Token 并记录非业务访问时间。 @param {string} rawToken Token @returns {Promise<Object>} 终端 */
async function authenticate(rawToken) {
  const database = getIngestDatabase();
  try {
    return await database.transaction(async transaction => {
      const terminal = await authenticateToken(rawToken, transaction);
      await database.query(
        'UPDATE apple_purchase_sync.terminals SET last_seen_at = NOW(), updated_at = NOW() WHERE id = :terminalId',
        { replacements: { terminalId: terminal.id }, transaction }
      );
      return terminal;
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', '同步服务暂不可用');
  }
}

function observationValues(event, terminalId, batchId) {
  return {
    terminalId,
    batchId,
    contentDigest: digest(event),
    observationId: event.observationId,
    sourceSequence: event.sourceSequence,
    responseReceivedAt: event.responseReceivedAt,
    responseReceivedAtMs: event.responseReceivedAtMs,
    city: event.city,
    storeId: event.storeId,
    officialStoreId: event.officialStoreId,
    storeName: event.storeName,
    partNumber: event.partNumber,
    productId: event.productId,
    productName: event.productName,
    specification: event.specification,
    officialTitle: event.officialTitle,
    color: event.color,
    storage: event.storage,
    family: event.family,
    availability: event.availability,
  };
}

async function insertObservation(database, transaction, event, terminalId, batchId) {
  const values = observationValues(event, terminalId, batchId);
  const inserted = await database.query(
    `INSERT INTO apple_purchase_sync.observations
      (terminal_id, observation_id, source_sequence, response_received_at, response_received_at_ms,
       city, store_id, official_store_id, store_name, part_number, product_id, product_name,
       specification, official_title, color, storage, family, availability, batch_id, content_digest)
     VALUES
      (:terminalId, :observationId, CAST(:sourceSequence AS bigint), :responseReceivedAt, :responseReceivedAtMs,
       :city, :storeId, :officialStoreId, :storeName, :partNumber, :productId, :productName,
       :specification, :officialTitle, :color, :storage, :family, :availability, :batchId, :contentDigest)
     ON CONFLICT (terminal_id, observation_id) DO NOTHING
     RETURNING sequence::text AS sequence`,
    { replacements: values, type: QueryTypes.SELECT, transaction }
  );
  if (inserted.length) return 'accepted';
  const existing = await database.query(
    `SELECT content_digest AS "contentDigest" FROM apple_purchase_sync.observations
     WHERE terminal_id = :terminalId AND observation_id = :observationId`,
    { replacements: values, type: QueryTypes.SELECT, transaction }
  );
  if (!existing.length || existing[0].contentDigest !== values.contentDigest) {
    throw new ApiError(409, 'EVENT_ID_CONFLICT', '有货观察 ID 已用于不同内容');
  }
  return 'duplicate';
}

function monitorValues(event, terminalId, batchId) {
  return {
    terminalId,
    batchId,
    contentDigest: digest(event),
    eventId: event.eventId,
    sourceSequence: event.sourceSequence,
    monitorId: event.monitorId,
    monitorName: event.monitorName,
    changeType: event.changeType,
    changedAt: event.changedAt,
    changedAtMs: event.changedAtMs,
    previousRevision: event.previousRevision,
    revision: event.revision,
    before: event.before === null ? null : JSON.stringify(event.before),
    after: event.after === null ? null : JSON.stringify(event.after),
    changes: JSON.stringify(event.changes),
    source: event.source,
    taskId: event.taskId,
  };
}

async function insertMonitorChange(database, transaction, event, terminalId, batchId) {
  const values = monitorValues(event, terminalId, batchId);
  const inserted = await database.query(
    `INSERT INTO apple_purchase_sync.monitor_changes
      (terminal_id, event_id, source_sequence, monitor_id, monitor_name, change_type,
       changed_at, changed_at_ms, previous_revision, revision, before_json, after_json,
       changes_json, source, task_id, batch_id, content_digest)
     VALUES
      (:terminalId, :eventId, CAST(:sourceSequence AS bigint), :monitorId, :monitorName, :changeType,
       :changedAt, :changedAtMs, :previousRevision, :revision, CAST(:before AS jsonb), CAST(:after AS jsonb),
       CAST(:changes AS jsonb), :source, :taskId, :batchId, :contentDigest)
     ON CONFLICT (terminal_id, event_id) DO NOTHING
     RETURNING sequence::text AS sequence`,
    { replacements: values, type: QueryTypes.SELECT, transaction }
  );
  if (inserted.length) return 'accepted';
  const existing = await database.query(
    `SELECT content_digest AS "contentDigest" FROM apple_purchase_sync.monitor_changes
     WHERE terminal_id = :terminalId AND event_id = :eventId`,
    { replacements: values, type: QueryTypes.SELECT, transaction }
  );
  if (!existing.length || existing[0].contentDigest !== values.contentDigest) {
    throw new ApiError(409, 'EVENT_ID_CONFLICT', '监控变更 ID 已用于不同内容');
  }
  return 'duplicate';
}

function previousBatchData(row) {
  return successData(
    row.batchId,
    {
      observations: row.acceptedObservations,
      monitorChanges: row.acceptedMonitorChanges,
    },
    {
      observations: row.duplicateObservations,
      monitorChanges: row.duplicateMonitorChanges,
    },
    {
      observations: row.observationHighWater,
      monitorChanges: row.monitorChangeHighWater,
    }
  );
}

/** 原子接收冻结 v1 混合批次。 @param {Object} batch 已校验批次 @param {Object} terminal 鉴权终端 @param {string} rawToken 原始 Token @param {string} requestId 请求 ID @returns {Promise<Object>} 结果 */
async function ingestBatch(batch, terminal, rawToken, requestId) {
  if (batch.terminalId !== terminal.id) {
    throw new ApiError(401, 'UNAUTHORIZED', '终端标识与凭据不匹配');
  }
  const database = getIngestDatabase();
  const payloadDigest = batchDigest(batch);
  try {
    return await database.transaction(async transaction => {
      const currentTerminal = await authenticateToken(rawToken, transaction);
      if (currentTerminal.id !== terminal.id || batch.terminalId !== currentTerminal.id) {
        throw new ApiError(401, 'UNAUTHORIZED', '终端标识与凭据不匹配');
      }
      const created = await database.query(
        `INSERT INTO apple_purchase_sync.ingest_batches
          (terminal_id, batch_id, request_id, payload_digest, mode, sent_at, source_history, event_count)
         VALUES
          (:terminalId, :batchId, :requestId, :payloadDigest, :mode, :sentAt,
           CAST(:sourceHistory AS jsonb), :eventCount)
         ON CONFLICT (terminal_id, batch_id) DO NOTHING
         RETURNING batch_id AS "batchId"`,
        {
          replacements: {
            terminalId: terminal.id,
            batchId: batch.batchId,
            requestId,
            payloadDigest,
            mode: batch.mode,
            sentAt: batch.sentAt,
            sourceHistory: JSON.stringify(batch.sourceHistory),
            eventCount: batch.observations.length + batch.monitorChanges.length,
          },
          type: QueryTypes.SELECT,
          transaction,
        }
      );
      if (!created.length) {
        const rows = await database.query(
          `SELECT batch_id AS "batchId", payload_digest AS "payloadDigest", result_status AS "resultStatus",
            accepted_observations AS "acceptedObservations",
            accepted_monitor_changes AS "acceptedMonitorChanges",
            duplicate_observations AS "duplicateObservations",
            duplicate_monitor_changes AS "duplicateMonitorChanges",
            observation_high_water::text AS "observationHighWater",
            monitor_change_high_water::text AS "monitorChangeHighWater"
           FROM apple_purchase_sync.ingest_batches
           WHERE terminal_id = :terminalId AND batch_id = :batchId
           FOR UPDATE`,
          {
            replacements: { terminalId: terminal.id, batchId: batch.batchId },
            type: QueryTypes.SELECT,
            transaction,
          }
        );
        if (!rows.length || rows[0].payloadDigest !== payloadDigest) {
          throw new ApiError(409, 'BATCH_ID_CONFLICT', '批次 ID 已用于不同内容');
        }
        if (rows[0].resultStatus !== 'committed') {
          throw new ApiError(503, 'SERVICE_UNAVAILABLE', '批次正在处理');
        }
        await database.query(
          'UPDATE apple_purchase_sync.terminals SET last_seen_at = NOW(), updated_at = NOW() WHERE id = :terminalId',
          { replacements: { terminalId: terminal.id }, transaction }
        );
        return previousBatchData(rows[0]);
      }

      const accepted = { observations: 0, monitorChanges: 0 };
      const duplicates = { observations: 0, monitorChanges: 0 };
      for (const event of batch.observations) {
        const result = await insertObservation(
          database,
          transaction,
          event,
          terminal.id,
          batch.batchId
        );
        if (result === 'accepted') accepted.observations += 1;
        else duplicates.observations += 1;
      }
      for (const event of batch.monitorChanges) {
        const result = await insertMonitorChange(
          database,
          transaction,
          event,
          terminal.id,
          batch.batchId
        );
        if (result === 'accepted') accepted.monitorChanges += 1;
        else duplicates.monitorChanges += 1;
      }
      const [highWater] = await database.query(
        `SELECT
          COALESCE((SELECT MAX(sequence) FROM apple_purchase_sync.observations WHERE terminal_id = :terminalId), 0)::text AS observations,
          COALESCE((SELECT MAX(sequence) FROM apple_purchase_sync.monitor_changes WHERE terminal_id = :terminalId), 0)::text AS "monitorChanges"`,
        { replacements: { terminalId: terminal.id }, type: QueryTypes.SELECT, transaction }
      );
      await database.query(
        `UPDATE apple_purchase_sync.terminals
         SET last_seen_at = NOW(), last_success_at = NOW(),
             observation_high_water = CAST(:observations AS bigint),
             monitor_change_high_water = CAST(:monitorChanges AS bigint),
             source_history = CAST(:sourceHistory AS jsonb), updated_at = NOW()
         WHERE id = :terminalId`,
        {
          replacements: {
            terminalId: terminal.id,
            observations: highWater.observations,
            monitorChanges: highWater.monitorChanges,
            sourceHistory: JSON.stringify(batch.sourceHistory),
          },
          transaction,
        }
      );
      await database.query(
        `UPDATE apple_purchase_sync.ingest_batches
         SET accepted_observations = :acceptedObservations,
             accepted_monitor_changes = :acceptedMonitorChanges,
             duplicate_observations = :duplicateObservations,
             duplicate_monitor_changes = :duplicateMonitorChanges,
             observation_high_water = CAST(:observations AS bigint),
             monitor_change_high_water = CAST(:monitorChanges AS bigint),
             result_status = 'committed', committed_at = NOW()
         WHERE terminal_id = :terminalId AND batch_id = :batchId`,
        {
          replacements: {
            terminalId: terminal.id,
            batchId: batch.batchId,
            acceptedObservations: accepted.observations,
            acceptedMonitorChanges: accepted.monitorChanges,
            duplicateObservations: duplicates.observations,
            duplicateMonitorChanges: duplicates.monitorChanges,
            observations: highWater.observations,
            monitorChanges: highWater.monitorChanges,
          },
          transaction,
        }
      );
      const [globalHighWater] = await database.query(
        `SELECT
          COALESCE((SELECT MAX(sequence) FROM apple_purchase_sync.observations), 0)::text AS observations,
          COALESCE((SELECT MAX(sequence) FROM apple_purchase_sync.monitor_changes), 0)::text AS "monitorChanges"`,
        { type: QueryTypes.SELECT, transaction }
      );
      await database.query(
        'SELECT apple_purchase_sync.publish_inventory_version(CAST(:observations AS bigint), CAST(:monitorChanges AS bigint))',
        { replacements: globalHighWater, transaction }
      );
      return successData(batch.batchId, accepted, duplicates, highWater);
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'DATABASE_UNAVAILABLE', '同步数据库暂不可用');
  }
}

/** 返回连接测试状态，不读取数据库内部细节。 @param {Object} terminal 终端 @returns {Object} 状态 */
function status(terminal) {
  return {
    contractVersion: '1',
    terminalId: terminal.id,
    terminalEnabled: true,
    serverTime: serverTime(),
    maxBatchEvents: 500,
    maxBodyBytes: 1_048_576,
  };
}

module.exports = { authenticate, authenticateToken, ingestBatch, status };
