const { Op, QueryTypes, Transaction } = require('sequelize');
const policy = require('./aosSignalPolicy');
const stock = require('./aosStockTaskPolicy');
const logger = require('../utils/logger');

const LOOKBACK_MS = 3 * 86400000;
const MAX_CITY_SHAPES = 32;
const RETRY_MS = 60000;
const MAX_PROBES = 1000;
const probes = new Map();

/** 验证稀疏索引指向的原片段，仅返回完整任务标识一致的设置。 @param {Object} models 模型 @param {Object[]} events 索引事件 @param {Object} anchor 检测锚点 @param {Object} transaction 只读事务 @returns {Promise<Object[]>} 原文证明的设置 */
async function readOriginals(models, events, anchor, transaction) {
  try {
    const ids = [...new Set(events.map(row => row.id.split(':')[0]))];
    if (!ids.length) return [];
    const receipts = await models.sequelize.query(
      `WITH wanted AS (
        SELECT business_date,block_id,jsonb_agg(jsonb_build_object('id',id,'ordinal',ordinal)) AS locations
        FROM monitor_log_receipts WHERE id IN (:ids) GROUP BY business_date,block_id
      ) SELECT b.*,w.locations FROM wanted w JOIN monitor_log_blocks b
        ON b.business_date=w.business_date AND b.id=w.block_id`,
      { replacements: { ids }, type: QueryTypes.SELECT, transaction }
    );
    const rows = new Map();
    for (const receipt of receipts) {
      const decoded = await require('./monitorLogBlockStore').readBlock(receipt);
      for (const location of receipt.locations) {
        const row = decoded[location.ordinal];
        if (row?.id === location.id) rows.set(row.id, row);
      }
    }
    const missing = ids.filter(id => !rows.has(id));
    if (missing.length && models.MonitorLogEntry) {
      const legacy = await models.MonitorLogEntry.findAll({
        where: { id: { [Op.in]: missing } },
        transaction,
        raw: true,
      });
      for (const row of legacy) rows.set(row.id, row);
    }
    const parsed = [...rows.values()].flatMap(row =>
      policy.parseEntries(row, anchor.loggedAt, { configurationOnly: true })
    );
    // 每个索引位置都必须由同文件完整任务的原文证明；不能按账号猜任务。
    return events.map(event => {
      const found = parsed.find(
        row =>
          row.id === event.id &&
          (row.taskKey === anchor.taskKey ||
            (row.configurationBare && row.configurationKey === anchor.configurationKey)) &&
          row.fileId === anchor.fileId &&
          row.deviceId === anchor.deviceId &&
          row.localId === anchor.localId &&
          String(row.byteOffset) === String(event.byteOffset) &&
          row.loggedAt === +new Date(event.loggedAt)
      );
      if (!found) throw new Error('STOCK_CONFIGURATION_ORIGINAL_MISSING');
      return { ...found, taskKey: anchor.taskKey };
    });
  } catch (error) {
    throw new Error('STOCK_CONFIGURATION_ORIGINAL_FAILED', { cause: error });
  }
}

/** 在检测前最近三天查最近启动及所有城市形状；不取未来或较早完整配置代替最新启动。 @param {Object} models 模型 @param {Object} anchor 检测锚点 @returns {Promise<Object[]>} 已验证配置 */
async function load(models, anchor, options = {}) {
  try {
    return await models.sequelize.transaction(
      { readOnly: true, isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ },
      async transaction => {
        try {
          await models.sequelize.query("SET LOCAL statement_timeout='1500ms'", { transaction });
          const replacements = {
            ...anchor,
            from: new Date(anchor.loggedAt - LOOKBACK_MS),
            to: new Date(anchor.loggedAt),
          };
          const starts = await models.sequelize.query(
            `SELECT id,byte_offset AS "byteOffset",logged_at AS "loggedAt"
           FROM aos_account_config_events WHERE device_id = :deviceId AND local_id = :localId
           AND account_number = :accountNumber AND file_id = :fileId AND kind='start'
           AND logged_at BETWEEN :from AND :to AND byte_offset < :byteOffset
           ORDER BY logged_at DESC,byte_offset DESC,line_index DESC LIMIT 1`,
            { replacements, type: QueryTypes.SELECT, transaction }
          );
          if (!starts.length) return [];
          const start = starts[0];
          let cities = [];
          if (options.includeCities !== false)
            cities = await models.sequelize.query(
              `SELECT DISTINCT ON (body) id,byte_offset AS "byteOffset",logged_at AS "loggedAt",body
           FROM aos_account_config_events WHERE device_id = :deviceId AND local_id = :localId
           AND account_number = :accountNumber AND file_id = :fileId AND kind='city'
           AND logged_at BETWEEN :start AND :to AND byte_offset > :startOffset
           AND byte_offset < :byteOffset ORDER BY body,logged_at,byte_offset,line_index LIMIT :limit`,
              {
                replacements: {
                  ...replacements,
                  start: start.loggedAt,
                  startOffset: start.byteOffset,
                  limit: MAX_CITY_SHAPES + 1,
                },
                type: QueryTypes.SELECT,
                transaction,
              }
            );
          if (cities.length > MAX_CITY_SHAPES) throw new Error('STOCK_CONFIGURATION_CITY_LIMIT');
          return await readOriginals(models, [start, ...cities], anchor, transaction);
        } catch (error) {
          throw new Error('STOCK_CONFIGURATION_READ_FAILED', { cause: error });
        }
      }
    );
  } catch (error) {
    throw new Error('STOCK_CONFIGURATION_LOAD_FAILED', { cause: error });
  }
}

/** 原文补证后短事务行锁合并，保留并发实时设置与普通上下文。 @param {Object} models 模型 @param {Object} anchor 检测锚点 @param {Object[]} entries 已验证设置 @returns {Promise<void>} 完成 */
async function merge(models, anchor, entries) {
  try {
    if (!entries.length) return;
    await models.sequelize.transaction(async transaction => {
      try {
        const row = await models.AosSignalContext.findByPk(anchor.taskKey, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (!row) return;
        await row.update(
          { body: { ...row.body, configuration: stock.configuration(row.body, entries) } },
          { transaction }
        );
      } catch (error) {
        throw new Error('STOCK_CONFIGURATION_MERGE_FAILED', { cause: error });
      }
    });
  } catch (error) {
    throw new Error('STOCK_CONFIGURATION_SAVE_FAILED', { cause: error });
  }
}

/** 每轮最多补一个缺设置任务；历史查询在库存全局锁外，失败保留未知并退避。 @param {Object} models 模型 @param {number} now 当前时间 @returns {Promise<void>} 完成 */
async function warm(models, now = Date.now()) {
  try {
    if (!models.AosAccountConfigEvent || !models.InventoryRuntime?.findByPk) return;
    const runtime = await models.InventoryRuntime.findByPk('main');
    const refs = runtime?.body?.aosStockTasks?.refs || [];
    const ref = refs.find(
      row =>
        row.reason === 'STOCK_SCOPE_UNKNOWN' &&
        now - row.anchor.receivedAt < LOOKBACK_MS &&
        (probes.get(row.anchor.taskKey) || 0) <= now
    );
    if (!ref) return;
    probes.set(ref.anchor.taskKey, now + RETRY_MS);
    if (probes.size > MAX_PROBES) probes.delete(probes.keys().next().value);
    const entries = await load(models, ref.anchor, {
      includeCities: !ref.item?.city || ref.item.city === '未知',
    });
    await merge(models, ref.anchor, entries);
    if (entries.length) return ref.anchor;
  } catch (error) {
    logger.warn('AOS有货启动配置补证待重试', {
      errorCode: error.cause?.cause?.original?.code || error.cause?.message || error.name,
    });
  }
}

module.exports = { load, merge, warm };
