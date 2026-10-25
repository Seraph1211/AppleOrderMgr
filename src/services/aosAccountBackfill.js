const { Op, QueryTypes, Transaction } = require('sequelize');
const policy = require('./aosAccountConfigPolicy');
const configs = require('./aosAccountConfigService');
const blockStore = require('./monitorLogBlockStore');
const logger = require('../utils/logger');
const PAGE_SIZE = 1000;
const MAX_RAW_BYTES = 4 * 1024 * 1024;
const WORDS = [
  '开始监控库存状态',
  '开始下单',
  '消息24093001',
  '消息21101002',
  '无货',
  '没有',
  '取货信息',
];

/** 固定最近3个北京时间自然日，拒绝沿用更宽的历史游标范围。 */
function dateRange(body = {}) {
  if (
    /^\d{4}-\d{2}-\d{2}$/.test(body.firstDate || '') &&
    /^\d{4}-\d{2}-\d{2}$/.test(body.lastDate || '') &&
    Date.parse(body.lastDate) - Date.parse(body.firstDate) === 2 * 86400000
  )
    return { firstDate: body.firstDate, lastDate: body.lastDate };
  const lastDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  return {
    firstDate: new Date(Date.parse(lastDate) - 2 * 86400000).toISOString().slice(0, 10),
    lastDate,
  };
}

/** 设置回填与库存全局锁分离，每次只解压一个至多4MiB候选块，不创建历史通知。 */
class AosAccountBackfill {
  constructor(models) {
    this.m = models;
    this.nextDiscovery = 0;
  }

  /** 注册待回填实例。 @returns {Promise<void>} 完成 */
  async discover() {
    try {
      if (Date.now() < this.nextDiscovery) return;
      this.nextDiscovery = Date.now() + 60000;
      const [devices, states, instances] = await Promise.all([
        this.m.AosDevice.findAll({ where: { enabled: true } }),
        this.m.MonitorLogState.findAll(),
        this.m.MonitorInstance.findAll(),
      ]);
      const enabled = new Set(devices.map(row => row.id));
      const disabled = new Set(
        instances.filter(row => row.active === false).map(row => `${row.deviceId}:${row.localId}`)
      );
      for (const row of states) {
        if (!enabled.has(row.deviceId) || disabled.has(`${row.deviceId}:${row.localId}`)) continue;
        const [index] = await this.m.AosAccountIndexState.findOrCreate({
          where: { id: policy.digest([row.deviceId, row.localId]) },
          defaults: { deviceId: row.deviceId, localId: row.localId, status: 'pending', body: {} },
        });
        if (
          index.status === 'incomplete' &&
          row.snapshot?.state === 'ready' &&
          !row.snapshot.pending
        )
          await this.reset(row.deviceId, row.localId);
      }
    } catch (error) {
      throw new Error('ACCOUNT_DISCOVERY_FAILED', { cause: error });
    }
  }

  /** 原子合并进度，保留并发实时入库写入的gap和capture水位。 @param {Object} state 状态 @param {string} status 阶段 @param {Object} patch 进度 @param {Object} transaction 事务 @returns {Promise<void>} 完成 */
  async save(state, status, patch, transaction) {
    try {
      const progress = { ...patch };
      delete progress.gaps;
      delete progress.gapOverflow;
      delete progress.captureStartedAt;
      await this.m.sequelize.query(
        'UPDATE aos_account_index_states SET status=:status,body=body || :patch::jsonb,updated_at=now() WHERE id=:id',
        { replacements: { id: state.id, status, patch: JSON.stringify(progress) }, transaction }
      );
      await state.reload({ transaction });
    } catch (error) {
      throw new Error('ACCOUNT_PROGRESS_FAILED', { cause: error });
    }
  }

  /** 针对单实例重走当前3自然日，不清除账号/设置、不创建通知。 @param {string} deviceId 设备 @param {string} localId 实例 @returns {Promise<void>} 完成 */
  async reset(deviceId, localId) {
    try {
      const state = await this.m.AosAccountIndexState.findByPk(policy.digest([deviceId, localId]));
      if (!state) throw new Error('ACCOUNT_SCOPE_NOT_FOUND');
      await this.save(state, 'pending', {
        seeded: false,
        afterFile: null,
        fileId: null,
        offset: '-1',
        seedCaptureAt: null,
        seedAt: null,
        registryVersion: null,
        registryAfterDate: null,
        registryPages: 0,
        firstDate: null,
        lastDate: null,
        retryAfter: null,
        reason: null,
        sqlState: null,
        resetAt: new Date().toISOString(),
      });
    } catch (error) {
      throw new Error('ACCOUNT_RESET_FAILED', { cause: error });
    }
  }

  /** 按实际目录日期小步建立完整账号宇宙，不读取范围外原文。 @param {Object} state 状态 @returns {Promise<Object>} 日片进度 */
  async seed(state) {
    try {
      const started = Date.now();
      const initializing = state.body.registryVersion !== 1;
      const { firstDate, lastDate } = dateRange(state.body);
      return await this.m.sequelize.transaction(async transaction => {
        try {
          const query = async (sql, options) => {
            try {
              const remaining = 2000 - (Date.now() - started);
              if (remaining <= 0) throw new Error('ACCOUNT_SEED_PAGE_BUDGET');
              await this.m.sequelize.query("SELECT set_config('statement_timeout',:timeout,true)", {
                replacements: { timeout: `${Math.min(1500, remaining)}ms` },
                transaction,
              });
              return await this.m.sequelize.query(sql, { ...options, transaction });
            } catch (error) {
              throw new Error('ACCOUNT_SEED_QUERY_FAILED', { cause: error });
            }
          };
          const replacements = {
            deviceId: state.deviceId,
            localId: state.localId,
            after: initializing ? '0001-01-01' : state.body.registryAfterDate || '0001-01-01',
          };
          const dates = [];
          for (const table of ['monitor_log_block_accounts', 'monitor_log_entries']) {
            const [row] = await query(
              `SELECT business_date::text AS day FROM ${table}
              WHERE device_id=:deviceId AND local_id=:localId AND business_date>:after::date
              ORDER BY business_date LIMIT 1`,
              { replacements, type: QueryTypes.SELECT, transaction }
            );
            if (row) dates.push(row.day);
          }
          const day = dates.sort()[0] || null;
          let rows = [];
          if (day)
            rows = await query(
              `SELECT account_number AS "accountNumber",min(first_at) AS "firstSeenAt" FROM (
            SELECT account_number,min(min_sort_at) AS first_at FROM monitor_log_block_accounts
              WHERE device_id=:deviceId AND local_id=:localId AND business_date=:day::date AND account_number<>'' GROUP BY account_number
            UNION ALL SELECT account_number,min(sort_at) FROM monitor_log_entries
              WHERE device_id=:deviceId AND local_id=:localId AND business_date=:day::date AND account_number IS NOT NULL GROUP BY account_number
          ) source GROUP BY account_number ORDER BY account_number LIMIT 10001`,
              { replacements: { ...replacements, day }, type: QueryTypes.SELECT, transaction }
            );
          if (rows.length > configs.MAX_ACCOUNTS) throw new Error('ACCOUNT_UNIVERSE_LIMIT');
          if (Date.now() - started > 2000) throw new Error('ACCOUNT_SEED_PAGE_BUDGET');
          for (let offset = 0; offset < rows.length; offset += 500) {
            const values = rows.slice(offset, offset + 500).map((row, index) => {
              replacements[`id${index}`] = policy.digest([
                state.deviceId,
                state.localId,
                row.accountNumber,
              ]);
              replacements[`account${index}`] = row.accountNumber;
              replacements[`at${index}`] = row.firstSeenAt;
              return `(:id${index},:deviceId,:localId,:account${index},:at${index})`;
            });
            if (values.length)
              await query(
                `INSERT INTO aos_account_registries(id,device_id,local_id,account_number,first_seen_at)
              VALUES ${values.join(',')} ON CONFLICT(id) DO UPDATE SET first_seen_at=EXCLUDED.first_seen_at,updated_at=now()
              WHERE EXCLUDED.first_seen_at<aos_account_registries.first_seen_at`,
                { replacements, transaction }
              );
          }
          const [{ count }] = await query(
            'SELECT count(*)::int AS count FROM aos_account_registries WHERE device_id=:deviceId AND local_id=:localId',
            { replacements, transaction, type: QueryTypes.SELECT }
          );
          if (count > configs.MAX_ACCOUNTS) throw new Error('ACCOUNT_UNIVERSE_LIMIT');
          let initial = {};
          if (initializing) {
            const [monitor] = await query(
              'SELECT snapshot FROM monitor_log_states WHERE device_id=:deviceId AND local_id=:localId LIMIT 1',
              { replacements, type: QueryTypes.SELECT }
            );
            initial = {
              firstDate,
              lastDate,
              seedCaptureAt: state.body.captureStartedAt || null,
              initialDates: (monitor?.snapshot?.dates || []).filter(
                value => value >= firstDate && value <= lastDate
              ),
              initialExpired: monitor?.snapshot?.expired || 0,
              seedAt: new Date().toISOString(),
            };
          }
          return {
            ...initial,
            registryVersion: 1,
            registryAfterDate: day || state.body.registryAfterDate || null,
            registryPages: (initializing ? 0 : state.body.registryPages || 0) + (day ? 1 : 0),
            seeded: !day,
            accountCount: count,
            sqlState: null,
            reason: null,
            retryAfter: null,
          };
        } catch (error) {
          throw new Error('ACCOUNT_SEED_FAILED', { cause: error });
        }
      });
    } catch (error) {
      throw new Error('AOS_ACCOUNT_OPERATION_FAILED', { cause: error });
    }
  }

  /** 按稳定源文件ID续跑，不依赖压实可替换的块ID。 @param {Object} state 状态 @returns {Promise<string|null>} 文件 */
  async nextFile(state) {
    try {
      const { firstDate, lastDate } = dateRange(state.body);
      return await this.m.sequelize.transaction(async transaction => {
        try {
          await this.m.sequelize.query("SET LOCAL statement_timeout='1500ms'", { transaction });
          const rows = await this.m.sequelize.query(
            `SELECT file_id AS "fileId" FROM (
            SELECT f.file_id FROM monitor_log_files f JOIN monitor_log_blocks b ON b.file_key=f.id
              WHERE b.device_id=:deviceId AND b.local_id=:localId AND b.business_date BETWEEN :firstDate AND :lastDate AND f.file_id>:after::uuid
            UNION SELECT file_id FROM monitor_log_entries WHERE device_id=:deviceId AND local_id=:localId AND business_date BETWEEN :firstDate AND :lastDate AND file_id>:after::uuid
          ) files ORDER BY file_id LIMIT 1`,
            {
              replacements: {
                deviceId: state.deviceId,
                localId: state.localId,
                after: state.body.afterFile || '00000000-0000-0000-0000-000000000000',
                firstDate,
                lastDate,
              },
              type: QueryTypes.SELECT,
              transaction,
            }
          );
          return rows[0]?.fileId || null;
        } catch (error) {
          throw new Error('ACCOUNT_FILE_PAGE_FAILED', { cause: error });
        }
      });
    } catch (error) {
      throw new Error('AOS_ACCOUNT_OPERATION_FAILED', { cause: error });
    }
  }

  /** 先在短快照复制单块，再在事务外解压；回执游标在压实后仍按原字节位置有效。 @param {Object} state 状态 @returns {Promise<Object>} 有界原文页 */
  async page(state) {
    try {
      const started = Date.now();
      const { firstDate, lastDate } = dateRange(state.body);
      const copied = await this.m.sequelize.transaction(
        { isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ, readOnly: true },
        async transaction => {
          try {
            const query = async (sql, options) => {
              try {
                const remaining = 2000 - (Date.now() - started);
                if (remaining <= 0) throw new Error('BACKFILL_PAGE_BUDGET');
                await this.m.sequelize.query(
                  "SELECT set_config('statement_timeout',:timeout,true)",
                  {
                    replacements: { timeout: `${Math.min(1500, remaining)}ms` },
                    transaction,
                  }
                );
                return await this.m.sequelize.query(sql, { ...options, transaction });
              } catch (error) {
                throw new Error('ACCOUNT_COPY_QUERY_FAILED', { cause: error });
              }
            };
            const replacements = {
              deviceId: state.deviceId,
              localId: state.localId,
              fileId: state.body.fileId,
              offset: state.body.offset || '-1',
              firstDate,
              lastDate,
            };
            const signatures = WORDS.map((word, index) => {
              replacements[`sig${index}`] = blockStore.signature([word], true);
              return `(b.signature & :sig${index}::bit(8192))=:sig${index}::bit(8192)`;
            });
            const legacy = await query(
              `SELECT id,device_id AS "deviceId",local_id AS "localId",file_id AS "fileId",byte_offset AS "byteOffset",business_date AS "businessDate",sort_at AS "contextAt",message,logged_at AS "loggedAt",account_number AS "accountNumber",parse_state AS "parseState",part_index AS "partIndex"
            FROM monitor_log_entries WHERE device_id=:deviceId AND local_id=:localId AND file_id=:fileId AND business_date BETWEEN :firstDate AND :lastDate AND byte_offset>:offset::bigint ORDER BY byte_offset LIMIT 100`,
              { replacements, type: QueryTypes.SELECT, transaction }
            );
            const receipts = await query(
              `WITH receipt_page AS MATERIALIZED (
              SELECT r.id,r.byte_offset,r.ordinal,r.business_date,r.block_id FROM monitor_log_receipts r
              WHERE r.file_key=(SELECT id FROM monitor_log_files WHERE device_id=:deviceId AND file_id=:fileId)
                AND r.byte_offset>:offset::bigint ORDER BY r.byte_offset LIMIT ${PAGE_SIZE}
            ) SELECT r.id,r.byte_offset AS offset,r.ordinal,b.business_date AS day,b.id AS block_id,
              CASE WHEN b.id IS NULL THEN false ELSE (${signatures.join(' OR ')}) END AS candidate
            FROM receipt_page r LEFT JOIN monitor_log_blocks b ON b.business_date=r.business_date AND b.id=r.block_id
              AND b.business_date BETWEEN :firstDate AND :lastDate AND b.device_id=:deviceId AND b.local_id=:localId
            ORDER BY r.byte_offset`,
              { replacements, type: QueryTypes.SELECT, transaction }
            );
            let blockId = null;
            const selected = [];
            for (const receipt of receipts) {
              if (
                receipt.candidate &&
                blockId !== null &&
                String(receipt.block_id) !== String(blockId)
              )
                break;
              selected.push(receipt);
              if (receipt.candidate) blockId = receipt.block_id;
            }
            let block = null;
            if (blockId !== null) {
              const receipt = selected.find(row => String(row.block_id) === String(blockId));
              [block] = await query(
                'SELECT * FROM monitor_log_blocks WHERE business_date=:day AND id=:id',
                {
                  replacements: { day: receipt.day, id: blockId },
                  type: QueryTypes.SELECT,
                  transaction,
                }
              );
              if (!block || block.raw_bytes > MAX_RAW_BYTES) throw new Error('BLOCK_BYTE_BUDGET');
            }
            const ends = [];
            if (legacy.length === 100) ends.push(BigInt(legacy.at(-1).byteOffset));
            if (selected.length) ends.push(BigInt(selected.at(-1).offset));
            if (!selected.length && legacy.length) ends.push(BigInt(legacy.at(-1).byteOffset));
            const end = ends.length ? ends.reduce((a, b) => (a < b ? a : b)).toString() : null;
            return { legacy, receipts: selected, block, end };
          } catch (error) {
            throw new Error('ACCOUNT_COPY_FAILED', { cause: error });
          }
        }
      );
      const rows = copied.legacy.filter(
        row => copied.end == null || BigInt(row.byteOffset) <= BigInt(copied.end)
      );
      if (copied.block) {
        const decoded = await blockStore.readBlock(copied.block);
        const wanted = new Set(
          copied.receipts
            .filter(
              row =>
                String(row.block_id) === String(copied.block.id) &&
                BigInt(row.offset) <= BigInt(copied.end)
            )
            .map(row => row.id)
        );
        rows.push(...decoded.filter(row => wanted.has(row.id)));
      }
      return {
        rows,
        end: copied.end,
        blocks: copied.block ? 1 : 0,
        bytes: copied.block?.raw_bytes || 0,
        receipts: copied.receipts.length,
      };
    } catch (error) {
      throw new Error('ACCOUNT_PAGE_FAILED', { cause: error });
    }
  }

  /** 单例后台小步回填，任何失败只暂停该索引，不阻断通知。 @returns {Promise<Object>} 诊断指标 */
  async tick(target) {
    let connection;
    let locked = false;
    try {
      if (!this.m.AosAccountIndexState) return { enabled: false };
      connection = await this.m.sequelize.connectionManager.getConnection();
      const lock = await connection.query('SELECT pg_try_advisory_lock(20261026,1) AS locked');
      locked = lock.rows[0].locked;
      if (!locked) return { busy: true };
      await this.discover();
      const candidates = await this.m.AosAccountIndexState.findAll({
        where: { status: { [Op.in]: ['pending', 'running', 'error'] }, ...(target || {}) },
        order: [['updatedAt', 'ASC']],
        limit: 50,
      });
      const state = candidates.find(
        row => !row.body.retryAfter || row.body.retryAfter <= Date.now()
      );
      if (!state) return { idle: true };
      const started = Date.now();
      try {
        const [device, instance] = await Promise.all([
          this.m.AosDevice.findByPk(state.deviceId),
          this.m.MonitorInstance.findOne({
            where: { deviceId: state.deviceId, localId: state.localId },
          }),
        ]);
        if (!device?.enabled || instance?.active === false) {
          await this.save(state, 'incomplete', { reason: 'INSTANCE_DISABLED' });
          return { disabled: true };
        }
        if (
          state.body.seedAt &&
          state.body.captureStartedAt &&
          state.body.seedCaptureAt !== state.body.captureStartedAt
        ) {
          await this.reset(state.deviceId, state.localId);
          return { captureRescan: true };
        }
        if (!state.body.seeded || state.body.registryVersion !== 1) {
          const seed = await this.seed(state);
          await this.save(state, 'running', seed);
          return {
            seeded: seed.accountCount,
            registryDay: seed.registryAfterDate,
            metadataComplete: seed.seeded,
          };
        }
        if (!state.body.fileId) {
          const fileId = await this.nextFile(state);
          if (!fileId) {
            await state.reload();
            if (!state.body.captureStartedAt) {
              await this.save(state, 'running', {
                reason: 'WAITING_REALTIME_CAPTURE',
                retryAfter: Date.now() + 30000,
              });
              return { waitingCapture: true };
            }
            if (state.body.seedCaptureAt !== state.body.captureStartedAt) {
              await this.reset(state.deviceId, state.localId);
              return { captureRescan: true };
            }
            const monitor = await this.m.MonitorLogState.findOne({
              where: { deviceId: state.deviceId, localId: state.localId },
            });
            const snapshot = monitor?.snapshot;
            const { firstDate, lastDate } = dateRange(state.body);
            const datesLost = (state.body.initialDates || [])
              .filter(day => day >= firstDate && day <= lastDate)
              .some(day => !snapshot?.dates?.includes(day));
            const expiredDelta = Math.max(
              0,
              (snapshot?.expired || 0) - (state.body.initialExpired || 0)
            );
            const ready =
              snapshot?.state === 'ready' &&
              !snapshot.pending &&
              snapshot.scannedBytes === snapshot.totalBytes;
            await this.save(state, datesLost || !ready ? 'incomplete' : 'ready', {
              completedAt: new Date().toISOString(),
              expiredDelta,
              reason: datesLost
                ? 'HISTORY_GAP_DURING_BACKFILL'
                : !ready
                  ? 'CURRENT_LOG_COVERAGE'
                  : null,
            });
            return { completed: true };
          }
          await this.save(state, 'running', { fileId, offset: '-1' });
        }
        const page = await this.page(state);
        if (Date.now() - started > 2000) throw new Error('BACKFILL_PAGE_BUDGET');
        await this.m.sequelize.transaction(async transaction => {
          try {
            await this.m.sequelize.query("SET LOCAL statement_timeout='1500ms'", { transaction });
            await configs.ingest(page.rows, transaction, this.m, { historical: true });
            const body = {
              ...state.body,
              pages: (state.body.pages || 0) + 1,
              blocks: (state.body.blocks || 0) + page.blocks,
              rawBytes: (state.body.rawBytes || 0) + page.bytes,
              scannedReceipts: (state.body.scannedReceipts || 0) + page.receipts,
              lastPageMs: Date.now() - started,
            };
            if (page.end === null) {
              body.afterFile = body.fileId;
              body.fileId = null;
              body.offset = '-1';
            } else body.offset = page.end;
            body.retryAfter = null;
            body.reason = null;
            body.sqlState = null;
            await this.save(state, 'running', body, transaction);
          } catch (error) {
            throw new Error('ACCOUNT_BACKFILL_COMMIT_FAILED', { cause: error });
          }
        });
        return { rows: page.rows.length, blocks: page.blocks, bytes: page.bytes };
      } catch (error) {
        let sqlState = null;
        let cause = error;
        for (let depth = 0; cause && depth < 8; depth++, cause = cause.cause) {
          const code = cause.original?.code || cause.parent?.code || cause.code;
          if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) sqlState = code;
        }
        await this.save(state, 'error', {
          reason: error.message,
          sqlState,
          retryAfter: Date.now() + 30000,
        });
        logger.warn('AOS账号回填暂缓', { errorCode: error.message, sqlState });
        return { failed: true };
      }
    } catch (error) {
      logger.warn('AOS账号回填暂不可用', { errorCode: error.name });
      return { failed: true };
    } finally {
      if (connection) {
        let discard = false;
        try {
          if (locked) await connection.query('SELECT pg_advisory_unlock(20261026,1)');
        } catch (error) {
          discard = true;
          logger.warn('AOS账号回填解锁失败', { errorCode: error.name });
        }
        try {
          if (discard) await this.m.sequelize.connectionManager.pool.destroy(connection);
          else await this.m.sequelize.connectionManager.releaseConnection(connection);
        } catch (error) {
          logger.warn('AOS账号回填连接释放失败', { errorCode: error.name });
          try {
            await this.m.sequelize.connectionManager.pool.destroy(connection);
          } catch (_error) {
            try {
              await connection.end();
            } catch (closingError) {
              logger.warn('AOS账号回填连接关闭失败', { errorCode: closingError.name });
            }
          }
        }
      }
    }
  }
}
module.exports = AosAccountBackfill;
