const { QueryTypes, Transaction } = require('sequelize');
const models = require('../src/models');
const signals = require('../src/services/aosSignalPolicy');
const stock = require('../src/services/aosStockTaskPolicy');
const configurations = require('../src/services/aosStockConfigurationService');
const ratios = require('../src/services/aosTaskRatioService');
const blocks = require('../src/services/monitorLogBlockStore');
const logger = require('../src/utils/logger');

const MAX_BLOCKS = 200;
const MAX_RAW_BYTES = 32 * 1024 * 1024;

/** 只读重放一个既有汇总窗口，原文补证与比例计算均不回写已发历史。 @param {string} id 汇总ID @returns {Promise<Object>} 脱敏结果 */
async function replay(id) {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(id || '')) throw new Error('INVALID_DELIVERY_ID');
    const source = await models.InventoryDelivery.findByPk(id);
    const body = source?.body;
    if (!body || body.kind !== 'aos_signal' || body.aosImmediate || !body.aosAccountTracker)
      throw new Error('SUMMARY_TRACKER_REQUIRED');
    const tracker = structuredClone(body.aosAccountTracker);
    const participants = [...tracker.refs, ...(tracker.stock?.refs || [])];
    const anchors = participants.map(ref => ref.anchor);
    const sources = new Map(
      participants
        .filter(ref => ref.item?.source?.key)
        .map(ref => [ref.item.source.key, ref.item.source])
    );
    const floor = body.receivedWindowFrom - signals.WINDOW_MS;
    const rows = await models.sequelize.transaction(
      {
        readOnly: true,
        isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ,
      },
      async transaction => {
        try {
          await models.sequelize.query("SET LOCAL statement_timeout='3000ms'", { transaction });
          const metadata = await models.sequelize.query(
            `SELECT b.id,b.business_date,b.raw_bytes FROM monitor_log_blocks b WHERE b.business_date BETWEEN :fromDate AND :toDate
           AND b.device_id IN (:devices) AND b.local_id IN (:instances)
           AND b.min_sort_at <= :to AND b.max_sort_at >= :from ORDER BY b.id LIMIT :limit`,
            {
              replacements: {
                fromDate: new Date(floor + 8 * 3600000).toISOString().slice(0, 10),
                toDate: new Date(body.receivedWindowTo + 8 * 3600000).toISOString().slice(0, 10),
                devices: [...new Set(anchors.map(row => row.deviceId))],
                instances: [...new Set(anchors.map(row => row.localId))],
                from: new Date(floor),
                to: new Date(body.receivedWindowTo),
                limit: MAX_BLOCKS + 1,
              },
              type: QueryTypes.SELECT,
              transaction,
            }
          );
          if (metadata.length > MAX_BLOCKS) throw new Error('REPLAY_BLOCK_LIMIT');
          if (metadata.reduce((total, row) => total + row.raw_bytes, 0) > MAX_RAW_BYTES)
            throw new Error('REPLAY_BYTE_LIMIT');
          if (!metadata.length) throw new Error('REPLAY_LOGS_MISSING');
          const payloads = await models.sequelize.query(
            'SELECT b.* FROM monitor_log_blocks b WHERE business_date IN (:dates) AND id IN (:ids)',
            {
              replacements: {
                dates: [...new Set(metadata.map(row => row.business_date))],
                ids: metadata.map(row => row.id),
              },
              type: QueryTypes.SELECT,
              transaction,
            }
          );
          const result = [];
          for (const block of payloads) result.push(...(await blocks.readBlock(block)));
          return result;
        } catch (error) {
          throw new Error('REPLAY_LOG_READ_FAILED', { cause: error });
        }
      }
    );
    const entries = rows
      .flatMap(row => signals.parseEntries(row, +new Date(row.createdAt)))
      .filter(row => row.receivedAt >= floor && row.receivedAt < body.receivedWindowTo);
    const contexts = new Map();
    const hits = entries.filter(row => row.kind === 'stock');
    const failures = [];
    for (const hit of hits) {
      let settings = [];
      try {
        // 本次尝试含单城市响应时只需补规格；缺城市时同时核对历史城市证据。
        const live = signals.mergeContext(
          null,
          entries.filter(row => row.taskKey === hit.taskKey),
          sources.get(`${hit.deviceId}:${hit.localId}`),
          body.receivedWindowTo
        );
        const provisional = stock.collect(
          null,
          [hit],
          new Map([[hit.taskKey, live]]),
          hit.receivedAt,
          body.aosSignalsSince
        ).refs[0];
        settings = await configurations.load(models, hit, {
          includeCities: provisional?.item.city === '未知',
        });
      } catch (error) {
        failures.push(error.cause?.cause?.message || error.message);
      }
      contexts.set(
        hit.taskKey,
        signals.mergeContext(
          null,
          [...settings, ...entries.filter(row => row.taskKey === hit.taskKey)],
          sources.get(`${hit.deviceId}:${hit.localId}`) || {
            enabled: true,
            key: `${hit.deviceId}:${hit.localId}`,
          },
          body.receivedWindowTo
        )
      );
    }
    let buffer = null;
    const batches = new Map();
    for (const entry of entries.sort((a, b) => a.receivedAt - b.receivedAt)) {
      if (!batches.has(entry.receivedAt)) batches.set(entry.receivedAt, []);
      batches.get(entry.receivedAt).push(entry);
    }
    for (const [receivedAt, batch] of batches)
      buffer = stock.collect(buffer, batch, contexts, receivedAt, body.aosSignalsSince);
    buffer = stock.collect(buffer, [], contexts, body.receivedWindowTo, body.aosSignalsSince);
    buffer.startedAt = floor;
    tracker.stock = stock.snapshot(
      buffer,
      tracker,
      body.receivedWindowFrom,
      body.receivedWindowTo,
      true
    );
    const result = await models.sequelize.transaction({ readOnly: true }, async transaction => {
      try {
        return await ratios.evaluate(tracker, models, transaction);
      } catch (error) {
        throw new Error('REPLAY_RATIO_FAILED', { cause: error });
      }
    });
    const after = await models.InventoryDelivery.findByPk(id);
    return {
      id,
      readOnly: true,
      historyUnchanged: JSON.stringify(after.body) === JSON.stringify(body),
      originalStatus: body.status,
      rawRows: rows.length,
      stockEvents: hits.length,
      configurationFailures: failures,
      scopes: Object.values(result.scopes).map(scope => ({
        city: scope.city,
        model: scope.model,
        color: scope.color,
        capacity: scope.capacity,
        sources: Object.values(scope.sources).map(row => ({
          server: row.source?.server,
          submitted: row.numerator,
          detected: row.stockCount,
          configured: row.denominator,
          reason: row.reason,
          stockReason: row.stockReason,
          diagnostics: row.stockDiagnostics,
        })),
      })),
    };
  } catch (error) {
    throw new Error('AOS_STOCK_WINDOW_REPLAY_FAILED', { cause: error });
  }
}

if (require.main === module) {
  replay(process.argv[2])
    .then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n'))
    .catch(error => {
      logger.error('AOS窗口只读重放失败', { reason: error.cause?.message || error.message });
      process.exitCode = 1;
    })
    .finally(() => models.sequelize.close());
}

module.exports = { replay };
