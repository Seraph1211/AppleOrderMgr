/**
 * 仅在专用合成库中比较旧宽表与压缩块；不连接生产、不输出日志正文和账号。
 * DB_NAME=aos_log_test_synthetic node scripts/monitorLogStorageBenchmark.js seed 1000000
 * DB_NAME=aos_log_test_synthetic node scripts/monitorLogStorageBenchmark.js measure
 */
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const zlib = require('zlib');
const { QueryTypes } = require('sequelize');
const { sequelize, AosDevice, MonitorLogEntry } = require('../src/models');
const policy = require('../src/services/monitorLogPolicy');
const logger = require('../src/utils/logger');
const DAY_MS = 86400000;
const MAX_ROWS = 28000000;
const UPLOAD_ID_START = 100000000;
const PREVIOUS_UPLOAD_FIRST = 27525977;
const PREVIOUS_UPLOAD_AFTER = 27529977;
const INSTANCE_WEIGHTS = [4258, 4055, 3567, 3209, 2825, 2509, 2127, 2079, 1913, 1912];
const SYNTHETIC_DATABASES = [
  'aos_log_test_synthetic',
  'aos_log_test_synthetic_scale',
  'aos_log_test_synthetic_1m',
  'aos_log_test_synthetic_hotspot',
  'aos_log_test_synthetic_small_batch',
  'aos_log_test_synthetic_restore',
  'aos_log_test_synthetic_small_batch_1_budget',
  'aos_log_test_synthetic_tiny_steady_1',
  'aos_log_test_synthetic_tiny_steady_10',
  'aos_log_test_synthetic_tiny_steady_1_manual',
  'aos_log_test_synthetic_tiny_steady_1_auto_day',
  'aos_log_test_synthetic_tiny_steady_10_auto_day',
  'aos_log_test_synthetic_tiny_wal',
  'aos_log_test_synthetic_tiny_wal_retry',
  ...[1, 10, 200].flatMap(size => [
    `aos_log_test_synthetic_small_batch_${size}`,
    `aos_log_test_synthetic_small_batch_${size}_fresh`,
  ]),
];
const BATCH_SIZE = Number(process.env.AOS_BENCHMARK_BATCH || 2000);
const REPETITIONS = Number(process.env.AOS_BENCHMARK_REPETITIONS || 20);
const RESULT_DIR = path.resolve(process.env.AOS_BENCHMARK_RESULT_DIR || 'test-artifacts');
const today = policy.retention().today;
const baseTime = Date.parse(`${today}T00:00:00+08:00`);
const uuid = value => {
  const hex = createHash('md5').update(`aos-synthetic:${value}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
};
const deviceIds = Array.from({ length: 10 }, (_, index) => uuid(`device-${index}`));
const localIds = Array.from({ length: 10 }, (_, index) => uuid(`local-${index}`));
/** 生成含准确载荷摘要的合成片段。 @param {number} index 序号 @param {number} total 总量 @returns {Object} 片段 */
function syntheticRow(index, _total) {
  // 连续来源簇避免一次模拟上传混入几百个文件；权重源于生产脱敏聚合样本。
  const cluster = Math.floor(index / 10000);
  const entropy = (Math.imul(cluster, 1664525) + 1013904223) >>> 0;
  const sample = entropy % INSTANCE_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
  let instance = 0;
  let threshold = INSTANCE_WEIGHTS[0];
  while (sample >= threshold && instance < INSTANCE_WEIGHTS.length - 1) {
    instance++;
    threshold += INSTANCE_WEIGHTS[instance];
  }
  const hotspot = process.env.AOS_BENCHMARK_HOTSPOT === 'true';
  if (hotspot) instance = 0;
  const dayOffset = hotspot || entropy % 100 < 35 ? 0 : 1 + ((entropy >>> 8) % 29);
  const dayBase = baseTime - dayOffset * DAY_MS;
  const businessDate = new Date(dayBase + 8 * 3600000).toISOString().slice(0, 10);
  const timestamp = new Date(dayBase + (index % 4 === 0 ? 1000 : index % 86400000)).toISOString();
  const rowEntropy = (Math.imul(index, 1664525) + 1013904223) >>> 0;
  const unassigned = rowEntropy % 10000 < 194;
  const account =
    rowEntropy % 1000 < 4 ? '000' : `00${instance * 27 + (index % (instance === 9 ? 24 : 27))}`;
  const row = policy.entry({
    id: uuid(`event-${index}`),
    localId: localIds[instance],
    fileId: uuid(`file-${instance}-${Math.floor(index / 1200000)}`),
    fileName: `Log${businessDate.replace(/-/g, '')}_synthetic.txt`,
    businessDate,
    loggedAt: unassigned ? null : timestamp,
    contextAt: unassigned ? timestamp : null,
    accountNumber: unassigned ? null : account,
    lineNumber: index + 1,
    partIndex: 0,
    byteOffset: index * 100,
    message:
      index % 65537 === 0
        ? 'rare-unique-探测词_100%\\\n'
        : `${timestamp} [${unassigned ? '---' : account}] ${uuid(`trace-${index}`)} 继续监控中\n`,
    rawBase64: null,
    parseState: unassigned ? 'unparsed' : 'parsed',
  });
  return {
    ...row,
    deviceId: deviceIds[instance],
    sortAt: timestamp,
    payloadHash: policy.digest(row),
    createdAt: new Date(baseTime),
    updatedAt: new Date(baseTime),
  };
}
async function guard() {
  try {
    if (
      !SYNTHETIC_DATABASES.includes(sequelize.config.database) ||
      process.env.NODE_ENV !== 'test' ||
      process.env.DATABASE_URL ||
      process.env.DB_HOST !== 'postgres'
    )
      throw new Error('仅允许指定的隔离合成库，不接受真实日志恢复副本');
    if (!Number.isInteger(BATCH_SIZE) || BATCH_SIZE < 200 || BATCH_SIZE > 20000)
      throw new Error('合成批次必须介于200和20000');
    if (
      process.env.AOS_BENCHMARK_HOTSPOT === 'true' &&
      sequelize.config.database !== 'aos_log_test_synthetic_hotspot'
    )
      throw new Error('单日热点仅允许专用hotspot库');
    if (
      sequelize.config.database === 'aos_log_test_synthetic_restore' &&
      !['integrity', 'cold'].includes(process.argv[2])
    )
      throw new Error('合成恢复库仅允许只读完整性与冷启动测量');
    await sequelize.authenticate();
  } catch (error) {
    logger.debug('合成日志基准步骤失败', { errorCode: error.name });
    throw error;
  }
}
async function seed(total) {
  try {
    if (!Number.isInteger(total) || total < 1 || total > MAX_ROWS)
      throw new Error(`合成片段数必须介于1和${MAX_ROWS}`);
    const store = require('../src/services/monitorLogBlockStore');
    const [existing] = await sequelize.query(
      'SELECT EXISTS(SELECT 1 FROM monitor_log_entries) AS occupied',
      { type: QueryTypes.SELECT }
    );
    if (existing.occupied && process.env.AOS_BENCHMARK_RESUME !== 'true')
      throw new Error('合成库已有日志，拒绝覆盖；续播需显式AOS_BENCHMARK_RESUME=true');
    const deferIndexes = process.env.AOS_BENCHMARK_DEFER_OLD_INDEXES === 'true';
    if (deferIndexes) {
      if (
        !['aos_log_test_synthetic_scale', 'aos_log_test_synthetic_hotspot'].includes(
          sequelize.config.database
        )
      )
        throw new Error('延后宽索引仅允许新的scale专库，保护既有百万条对照');
      await sequelize.query(
        'DROP INDEX IF EXISTS monitor_log_instance_page; DROP INDEX IF EXISTS monitor_log_account_page'
      );
    }
    const rangeStart = Number(process.env.AOS_BENCHMARK_RANGE_START || 0);
    const rangeEnd = Number(process.env.AOS_BENCHMARK_RANGE_END || total);
    const explicitRange = process.env.AOS_BENCHMARK_RANGE_START !== undefined;
    if (
      !Number.isInteger(rangeStart) ||
      !Number.isInteger(rangeEnd) ||
      rangeStart < 0 ||
      rangeStart >= rangeEnd ||
      rangeEnd > total
    )
      throw new Error('合成播种范围无效');
    let firstIndex = rangeStart;
    if (existing.occupied && explicitRange) {
      const [range] = await sequelize.query(
        `SELECT count(*)::text AS count,coalesce(max(line_number),:start)::text AS next,
          (SELECT count(*) FROM monitor_log_receipts r JOIN monitor_log_entries e ON e.id=r.id
            WHERE e.line_number>:start AND e.line_number<=:end)::text AS receipts
          FROM monitor_log_entries WHERE line_number>:start AND line_number<=:end`,
        { replacements: { start: rangeStart, end: rangeEnd }, type: QueryTypes.SELECT }
      );
      firstIndex = Number(range.next);
      if (Number(range.count) !== firstIndex - rangeStart || range.count !== range.receipts)
        throw new Error('分段续播存在缺口或回执不一致');
    } else if (existing.occupied) {
      const [resume] = await sequelize.query(
        `SELECT coalesce(max(line_number),0)::text AS next FROM monitor_log_entries
         WHERE line_number<=:max AND NOT(line_number>:reservedFirst AND line_number<=:reservedAfter)`,
        {
          replacements: {
            max: MAX_ROWS,
            reservedFirst: PREVIOUS_UPLOAD_FIRST,
            reservedAfter: PREVIOUS_UPLOAD_AFTER,
          },
          type: QueryTypes.SELECT,
        }
      );
      firstIndex = Number(resume.next);
      const [counts] = await sequelize.query(
        'SELECT (SELECT count(*) FROM monitor_log_entries)::text AS old_count,' +
          '(SELECT count(*) FROM monitor_log_receipts)::text AS new_count',
        { type: QueryTypes.SELECT }
      );
      if (counts.old_count !== counts.new_count)
        throw new Error('续播前旧表与回执数量不一致，拒绝继续');
    }
    for (let index = 0; index < deviceIds.length; index++)
      await AosDevice.findOrCreate({
        where: { id: deviceIds[index] },
        defaults: {
          name: `合成存储基准${index}`,
          credentialHash: createHash('sha256').update(deviceIds[index]).digest('hex'),
        },
      });
    const started = performance.now();
    const [before] = await sequelize.query('SELECT pg_current_wal_lsn() AS lsn', {
      type: QueryTypes.SELECT,
    });
    for (let start = firstIndex; start < rangeEnd; start += BATCH_SIZE) {
      const rows = Array.from({ length: Math.min(BATCH_SIZE, rangeEnd - start) }, (_, offset) =>
        syntheticRow(start + offset, total)
      );
      if (!rows.length) continue;
      await sequelize.transaction(async transaction => {
        try {
          await MonitorLogEntry.bulkCreate(rows, { transaction });
          await store.append(rows, transaction);
        } catch (error) {
          logger.debug('合成日志事务失败', { errorCode: error.name });
          throw error;
        }
      });
      if ((start - firstIndex) % 100000 === 0)
        process.stdout.write(
          JSON.stringify({
            phase: 'synthetic-seed',
            nextIndex: start + BATCH_SIZE,
            elapsedMs: performance.now() - started,
          }) + '\n'
        );
    }
    const [wal] = await sequelize.query(
      'SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), :before)::text AS bytes',
      { replacements: { before: before.lsn }, type: QueryTypes.SELECT }
    );
    if (deferIndexes && process.env.AOS_BENCHMARK_SKIP_INDEXES !== 'true') {
      process.stdout.write(JSON.stringify({ phase: 'synthetic-rebuild-wide-indexes' }) + '\n');
      await sequelize.query(`CREATE INDEX IF NOT EXISTS monitor_log_instance_page ON monitor_log_entries
        (device_id,local_id,business_date,sort_at,file_id,byte_offset,id)`);
      await sequelize.query(`CREATE INDEX IF NOT EXISTS monitor_log_account_page ON monitor_log_entries
        (device_id,local_id,business_date,account_number,sort_at,file_id,byte_offset,id)`);
    }
    const result = {
      kind: 'synthetic-only',
      total,
      rangeStart,
      rangeEnd,
      resumedFromIndex: firstIndex,
      batchSize: BATCH_SIZE,
      deferredOldWideIndexes: deferIndexes,
      elapsedMs: performance.now() - started,
      dualWriteWalBytes: Number(wal.bytes),
      sourceAverageMessageBytes: Buffer.byteLength(syntheticRow(1, total).message),
      distribution:
        '10实例样本权重；35%热点日；25%同毫秒；267全局账号含前导零；逐行时间与独立UUID高熵正文',
    };
    fs.mkdirSync(RESULT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(
        RESULT_DIR,
        `aos-storage-${sequelize.config.database}-${rangeStart}-${rangeEnd}-seed.json`
      ),
      JSON.stringify(result)
    );
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    logger.debug('合成日志基准步骤失败', { errorCode: error.name });
    throw error;
  }
}
/** 读取旧表对照结果。 @param {Object} query 查询 @param {Object|null} anchor 锚点 @param {string} direction 顺序 @param {number} limit 数量 @returns {Promise<Array>} 日志 */
async function oldSelect(query, anchor, direction = 'ASC', limit = 50) {
  try {
    const clauses = ['device_id=:deviceId', 'local_id=:localId', 'business_date=:date'];
    const replacements = { ...query, limit };
    if (query.account === '__unassigned__') clauses.push('account_number IS NULL');
    else if (query.account) clauses.push('account_number=:account');
    if (query.keyword) {
      clauses.push("message LIKE :pattern ESCAPE '\\'");
      replacements.pattern = policy.literalSearch(query.keyword);
    }
    if (anchor) {
      clauses.push(
        `(sort_at,file_id,byte_offset) ${direction === 'ASC' ? '>' : '<'} ` +
          '(:anchorAt::timestamptz,:anchorFile::uuid,:anchorOffset::bigint)'
      );
      Object.assign(replacements, {
        anchorAt: new Date(anchor.sortAt).toISOString(),
        anchorFile: anchor.fileId,
        anchorOffset: anchor.byteOffset,
      });
    }
    return await sequelize.query(
      `SELECT * FROM monitor_log_entries WHERE ${clauses.join(' AND ')} ORDER BY ` +
        `sort_at ${direction},file_id ${direction},byte_offset ${direction} LIMIT :limit`,
      { replacements, model: MonitorLogEntry, mapToModel: true }
    );
  } catch (error) {
    logger.debug('合成日志基准步骤失败', { errorCode: error.name });
    throw error;
  }
}
function percentile(samples, fraction) {
  return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * fraction) - 1];
}
async function timings(operation) {
  try {
    const samples = [];
    const queryMetrics = [];
    const originalInfo = logger.info;
    logger.info = function (message, metrics) {
      if (metrics?.storage === 'blocks')
        queryMetrics.push({
          durationMs: metrics.durationMs,
          decodedBlocks: metrics.decodedBlocks,
          returned: metrics.returned,
        });
      return originalInfo.call(logger, message, metrics);
    };
    let peakRss = process.memoryUsage().rss;
    const monitor = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 25);
    try {
      for (let round = 0; round < REPETITIONS; round++) {
        const start = performance.now();
        await operation();
        samples.push(performance.now() - start);
      }
    } finally {
      clearInterval(monitor);
      logger.info = originalInfo;
    }
    return {
      samples: samples.length,
      p50: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
      peakRssBytes: peakRss,
      queryMetrics,
    };
  } catch (error) {
    logger.debug('合成日志基准步骤失败', { errorCode: error.name });
    throw error;
  }
}
async function measure() {
  try {
    const store = require('../src/services/monitorLogBlockStore');
    const scopes = await sequelize.query(
      `SELECT device_id AS "deviceId",local_id AS "localId",business_date AS date,
         count(*)::text AS count FROM monitor_log_entries WHERE business_date>=:first
         GROUP BY device_id,local_id,business_date ORDER BY count(*) DESC LIMIT 1`,
      { replacements: { first: policy.retention().first }, type: QueryTypes.SELECT }
    );
    const scope = scopes[0];
    const query = policy.query({
      deviceId: scope.deviceId,
      localId: scope.localId,
      date: scope.date,
    });
    await sequelize.query(
      'ANALYZE monitor_log_entries; ANALYZE monitor_log_receipts; ANALYZE monitor_log_blocks; ANALYZE monitor_log_block_accounts'
    );
    const sizes = await sequelize.query(
      `SELECT relname AS name, pg_table_size(oid)::text AS table_bytes,
         pg_indexes_size(oid)::text AS index_bytes, pg_total_relation_size(oid)::text AS total_bytes
       FROM pg_class WHERE relkind IN ('r','p') AND relnamespace='public'::regnamespace
       AND (relname='monitor_log_entries' OR relname LIKE 'monitor_log_blocks%'
       OR relname LIKE 'monitor_log_block_accounts%' OR relname IN
       ('monitor_log_receipts','monitor_log_files','monitor_log_storage_scopes','monitor_log_storage_metrics'))
       ORDER BY relname`,
      { type: QueryTypes.SELECT }
    );
    const oldBytes = Number(sizes.find(row => row.name === 'monitor_log_entries').total_bytes);
    const newBytes = sizes
      .filter(row => row.name !== 'monitor_log_entries')
      .reduce((sum, row) => sum + Number(row.total_bytes), 0);
    const result = {
      kind: 'synthetic-only',
      measuredAt: new Date().toISOString(),
      databaseVersion: (
        await sequelize.query('SELECT version() AS version', { type: QueryTypes.SELECT })
      )[0].version,
      oldBytes,
      newBytes,
      savingsFraction: 1 - newBytes / oldBytes,
      sizes,
      cache: 'warm-process-and-database;cold-cache not measured',
      correctnessCases: 0,
      timings: {},
    };
    result.closedSet = (
      await sequelize.query(
        `SELECT
      (SELECT count(*)::text FROM monitor_log_entries) AS legacy_rows,
      (SELECT count(*)::text FROM monitor_log_receipts) AS receipts,
      (SELECT sum(entry_count)::text FROM monitor_log_blocks) AS block_rows,
      (SELECT count(*)::text FROM pg_indexes WHERE tablename='monitor_log_entries') AS legacy_indexes,
      (SELECT avg(octet_length(message)) FROM monitor_log_entries) AS message_bytes_mean`,
        { type: QueryTypes.SELECT }
      )
    )[0];
    if (
      result.closedSet.legacy_rows !== result.closedSet.receipts ||
      result.closedSet.receipts !== result.closedSet.block_rows
    )
      throw new Error('测量前完整闭集数量不一致');
    const first = await oldSelect(query);
    const anchor = first.at(-1)?.toJSON();
    const selectedAccount = first.find(row => row.accountNumber)?.accountNumber || '001';
    const trace = first.find(row =>
      /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}/.test(row.message)
    );
    const rareKeyword = trace
      ? trace.message.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}/)[0]
      : 'rare-unique-探测词_100%\\';
    fs.mkdirSync(RESULT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RESULT_DIR, `aos-storage-${sequelize.config.database}-query-context.json`),
      JSON.stringify({ query, anchor, selectedAccount, rareKeyword })
    );
    result.scopeRowCount = Number(scope.count);
    result.directory = (
      await sequelize.query(
        `SELECT
      (SELECT count(*)::text FROM monitor_log_blocks) AS blocks,
      (SELECT count(*)::text FROM monitor_log_block_accounts) AS account_directories,
      (SELECT avg(bit_count(signature)) FROM monitor_log_blocks) AS mean_signature_bits,
      (SELECT max(bit_count(signature)) FROM monitor_log_blocks) AS max_signature_bits`,
        { type: QueryTypes.SELECT }
      )
    )[0];
    for (const [name, extra, mark, direction] of [
      ['first', {}, null, 'ASC'],
      ['next', {}, anchor, 'ASC'],
      ['account', { account: selectedAccount }, null, 'ASC'],
      ['unknown', { account: '__unassigned__' }, null, 'ASC'],
      ['before', {}, anchor, 'DESC'],
      ['rare', { keyword: rareKeyword }, null, 'ASC'],
      ['absent', { keyword: 'definitely-absent-QXZ921' }, null, 'ASC'],
      ['short-absent', { keyword: '龘' }, null, 'ASC'],
      ['repeated-gram-absent', { keyword: 'ffffffffffffffff' }, null, 'ASC'],
    ]) {
      const current = { ...query, ...extra };
      const oldRows = await oldSelect(current, mark, direction);
      const newRows = await store.select(current, mark, direction, 50);
      if (JSON.stringify(oldRows.map(row => row.id)) !== JSON.stringify(newRows.map(row => row.id)))
        throw new Error(`合成差分失败:${name}`);
      result.correctnessCases++;
      result.timings[name] = {
        rowsReturned: oldRows.length,
        old: await timings(() => oldSelect(current, mark, direction)),
        blocks: await timings(() => store.select(current, mark, direction, 50)),
      };
      process.stdout.write(
        JSON.stringify({ phase: 'synthetic-measure', name, metrics: result.timings[name] }) + '\n'
      );
    }
    result.timings.accounts = {
      blocks: await timings(() => store.accounts(query, {})),
    };
    result.timings.fiveConcurrentQueries = await timings(() =>
      Promise.all([
        store.select(query, null, 'ASC', 50),
        store.select(query, anchor, 'ASC', 50),
        store.select({ ...query, account: selectedAccount }, null, 'ASC', 50),
        store.select({ ...query, keyword: rareKeyword }, null, 'ASC', 50),
        store.accounts(query, {}),
      ])
    );
    {
      const service = require('../src/services/monitorLogService');
      await sequelize.query(
        "INSERT INTO monitor_log_storage_scopes(device_id,local_id,mode) VALUES(:deviceId,:localId,'shadow') " +
          "ON CONFLICT(device_id,local_id) DO UPDATE SET mode='shadow'",
        { replacements: query }
      );
      let uploadRound = 0;
      result.timings.fiveQueriesPlusAtomicUpload = await timings(() => {
        const entries = Array.from({ length: 200 }, (_, offset) => {
          const value = syntheticRow(UPLOAD_ID_START + uploadRound * 200 + offset, MAX_ROWS);
          value.localId = query.localId;
          for (const key of ['deviceId', 'sortAt', 'payloadHash', 'createdAt', 'updatedAt'])
            delete value[key];
          return policy.entry(value);
        });
        uploadRound++;
        return Promise.all([
          store.select(query, null, 'ASC', 50),
          store.select(query, anchor, 'ASC', 50),
          store.select({ ...query, account: selectedAccount }, null, 'ASC', 50),
          store.select({ ...query, keyword: rareKeyword }, null, 'ASC', 50),
          store.accounts(query, {}),
          service.receive(query.deviceId, { entries }),
        ]);
      });
    }
    fs.mkdirSync(RESULT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RESULT_DIR, `aos-storage-${sequelize.config.database}-measure.json`),
      JSON.stringify(result, null, 2)
    );
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    logger.debug('合成日志基准步骤失败', { errorCode: error.name });
    throw error;
  }
}
async function rebuildIndexes() {
  try {
    if (sequelize.config.database !== 'aos_log_test_synthetic_scale')
      throw new Error('最终索引核对仅允许scale专库');
    const [count] = await sequelize.query(
      `SELECT count(*)::text AS rows,
      min(line_number)::text AS first,max(line_number)::text AS last,
      (SELECT count(*) FROM monitor_log_receipts)::text AS receipts,
      (SELECT sum(entry_count) FROM monitor_log_blocks)::text AS block_rows,
      count(DISTINCT line_number)::text AS distinct_lines FROM monitor_log_entries`,
      { type: QueryTypes.SELECT }
    );
    if (
      count.rows !== '27798848' ||
      count.receipts !== count.rows ||
      count.block_rows !== count.rows ||
      count.distinct_lines !== count.rows ||
      count.first !== '1' ||
      count.last !== count.rows
    )
      throw new Error('完整27798848闭集或连续位置验证失败，禁止重建索引发布容量');
    const started = performance.now();
    await sequelize.query(`CREATE INDEX IF NOT EXISTS monitor_log_instance_page ON monitor_log_entries
      (device_id,local_id,business_date,sort_at,file_id,byte_offset,id)`);
    await sequelize.query(`CREATE INDEX IF NOT EXISTS monitor_log_account_page ON monitor_log_entries
      (device_id,local_id,business_date,account_number,sort_at,file_id,byte_offset,id)`);
    const result = {
      kind: 'synthetic-full-closed-set',
      ...count,
      indexBuildMs: performance.now() - started,
    };
    fs.mkdirSync(RESULT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RESULT_DIR, 'aos-storage-full-closed-set.json'),
      JSON.stringify(result)
    );
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    logger.debug('合成闭集索引核验失败', { errorCode: error.name });
    throw error;
  }
}
async function smallBatch() {
  try {
    const requestSize = Number(process.argv[3]);
    if (
      ![1, 10, 200].includes(requestSize) ||
      sequelize.config.database !== `aos_log_test_synthetic_small_batch_${requestSize}`
    )
      throw new Error('小请求容量仅允许对应大小的独立专库');
    const [occupied] = await sequelize.query(
      'SELECT EXISTS(SELECT 1 FROM monitor_log_entries) AS value',
      { type: QueryTypes.SELECT }
    );
    if (occupied.value) throw new Error('小请求专库非空，拒绝覆盖');
    const store = require('../src/services/monitorLogBlockStore');
    const first = syntheticRow(0, 2000);
    await AosDevice.create({
      id: first.deviceId,
      name: '合成小请求基准',
      credentialHash: createHash('sha256').update(first.deviceId).digest('hex'),
    });
    const latencies = [];
    for (let start = 0; start < 2000; start += requestSize) {
      const rows = Array.from({ length: requestSize }, (_, offset) =>
        syntheticRow(start + offset, 2000)
      );
      const at = performance.now();
      await sequelize.transaction(async transaction => {
        try {
          await MonitorLogEntry.bulkCreate(rows, { transaction });
          await store.append(rows, transaction);
        } catch (error) {
          logger.debug('小请求事务失败', { errorCode: error.name });
          throw error;
        }
      });
      latencies.push(performance.now() - at);
      if (!(await store.findById(rows.at(-1).id))) throw new Error('请求提交后片段不可见');
    }
    const [size] = await sequelize.query(
      `SELECT
      (SELECT pg_total_relation_size('monitor_log_entries'))::text AS old_bytes,
      (SELECT sum(pg_total_relation_size(oid)) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN('r','p') AND
        (relname LIKE 'monitor_log_blocks%' OR relname LIKE 'monitor_log_block_accounts%' OR relname IN
        ('monitor_log_receipts','monitor_log_files','monitor_log_storage_scopes','monitor_log_storage_metrics')))::text AS new_bytes,
      (SELECT count(*) FROM monitor_log_blocks)::text AS blocks,
      (SELECT count(*) FROM monitor_log_receipts)::text AS receipts`,
      { type: QueryTypes.SELECT }
    );
    const result = {
      kind: 'synthetic-small-request-capacity',
      rows: 2000,
      requestSize,
      ...size,
      savingsFraction: 1 - Number(size.new_bytes) / Number(size.old_bytes),
      appendP95Ms: percentile(latencies, 0.95),
      immediatelyVisible: true,
    };
    fs.mkdirSync(RESULT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RESULT_DIR, `aos-storage-small-request-${requestSize}.json`),
      JSON.stringify(result)
    );
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    logger.debug('小请求容量核验失败', { errorCode: error.name });
    throw error;
  }
}
async function appendSmallDay() {
  try {
    if (sequelize.config.database !== 'aos_log_test_synthetic_small_batch_1')
      throw new Error('日请求追加仅允许single专库');
    const [count] = await sequelize.query(
      'SELECT count(*)::text AS value FROM monitor_log_entries',
      { type: QueryTypes.SELECT }
    );
    if (count.value !== '2000') throw new Error('日请求追加必须从已验证2000片段开始');
    const store = require('../src/services/monitorLogBlockStore');
    for (let index = 2000; index < 3000; index++) {
      const value = syntheticRow(index, 3000);
      await sequelize.transaction(async transaction => {
        try {
          await MonitorLogEntry.create(value, { transaction });
          await store.append([value], transaction);
        } catch (error) {
          logger.debug('日请求事务失败', { errorCode: error.name });
          throw error;
        }
      });
      if (!(await store.findById(value.id))) throw new Error('日请求即时不可见');
    }
    process.stdout.write(
      JSON.stringify({ kind: 'synthetic-daily-one-line', rows: 3000, immediatelyVisible: true }) +
        '\n'
    );
  } catch (error) {
    logger.debug('日请求追加失败', { errorCode: error.name });
    throw error;
  }
}
async function concurrent() {
  try {
    if (
      !['aos_log_test_synthetic_hotspot', 'aos_log_test_synthetic_scale'].includes(
        sequelize.config.database
      )
    )
      throw new Error('并发复测仅允许热点和全量合成库');
    const store = require('../src/services/monitorLogBlockStore');
    const service = require('../src/services/monitorLogService');
    const [scope] = await sequelize.query(
      `SELECT device_id AS "deviceId",local_id AS "localId",business_date AS date,sum(entry_count) AS count
      FROM monitor_log_blocks GROUP BY device_id,local_id,business_date ORDER BY sum(entry_count) DESC LIMIT 1`,
      { type: QueryTypes.SELECT }
    );
    const query = policy.query({
      deviceId: scope.deviceId,
      localId: scope.localId,
      date: scope.date,
    });
    const first = await store.select(query, null, 'ASC', 50);
    const anchor = first.at(-1);
    const account = first.find(value => value.accountNumber)?.accountNumber;
    const rare = first
      .find(value =>
        /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}/.test(value.message)
      )
      .message.match(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}/)[0];
    await sequelize.query(
      `INSERT INTO monitor_log_storage_scopes(device_id,local_id,mode)VALUES(:deviceId,:localId,'shadow')
      ON CONFLICT(device_id,local_id)DO UPDATE SET mode='shadow'`,
      { replacements: query }
    );
    const factories = {
      first: () => store.select(query, null, 'ASC', 50),
      next: () => store.select(query, anchor, 'ASC', 50),
      account: () => store.select({ ...query, account }, null, 'ASC', 50),
      rare: () => store.select({ ...query, keyword: rare }, null, 'ASC', 50),
      accounts: () => store.accounts(query, {}),
    };
    const individual = { queries: {}, queriesPlusUpload: {}, queriesPlusUploadAndCompact: {} };
    const timed = (stage, name, factory) => async () => {
      try {
        const at = performance.now();
        const value = await factory();
        individual[stage][name] ||= [];
        individual[stage][name].push(performance.now() - at);
        return value;
      } catch (error) {
        throw new Error(`并发${stage}/${name}失败:${error.name}`);
      }
    };
    const operations = stage =>
      Object.entries(factories).map(([name, factory]) => timed(stage, name, factory)());
    const queries = await timings(() => Promise.all(operations('queries')));
    let round = 0;
    const upload = async () => {
      try {
        const entries = Array.from({ length: 200 }, (_, offset) => {
          const value = syntheticRow(UPLOAD_ID_START + round * 200 + offset, MAX_ROWS);
          value.localId = query.localId;
          for (const key of ['deviceId', 'sortAt', 'payloadHash', 'createdAt', 'updatedAt'])
            delete value[key];
          return policy.entry(value);
        });
        round++;
        const ack = await service.receive(query.deviceId, { entries });
        if (!(await store.findById(entries.at(-1).id))) throw new Error('并发上传确认后不可见');
        return ack;
      } catch (error) {
        throw new Error(`并发上传失败:${error.name}`);
      }
    };
    const queriesPlusUpload = await timings(() =>
      Promise.all([
        ...operations('queriesPlusUpload'),
        timed('queriesPlusUpload', 'uploadVisible', upload)(),
      ])
    );
    await sequelize.query(
      `UPDATE monitor_log_storage_scopes SET mode='blocks' WHERE device_id=:deviceId AND local_id=:localId;
      INSERT INTO monitor_log_storage_metrics(name,value)VALUES('storage-default','{"mode":"blocks"}')ON CONFLICT(name)DO UPDATE SET value=EXCLUDED.value`,
      { replacements: query }
    );
    const { compact } = require('../src/services/monitorLogBlockCompactor');
    const queriesPlusUploadAndCompact = await timings(() =>
      Promise.all([
        ...operations('queriesPlusUploadAndCompact'),
        timed('queriesPlusUploadAndCompact', 'uploadVisible', upload)(),
        timed('queriesPlusUploadAndCompact', 'compact', () =>
          compact({ today: query.date, maxBatches: 1, budgetMs: 5000 })
        )(),
      ])
    );
    const result = {
      kind: 'synthetic-concurrency-retest',
      poolMax: Number(process.env.DB_POOL_MAX),
      scopeRows: Number(scope.count),
      queries,
      queriesPlusUpload,
      queriesPlusUploadAndCompact,
      individual: Object.fromEntries(
        Object.entries(individual).map(([stage, results]) => [
          stage,
          Object.fromEntries(
            Object.entries(results).map(([name, samples]) => [
              name,
              { samples, p95: percentile(samples, 0.95) },
            ])
          ),
        ])
      ),
    };
    fs.mkdirSync(RESULT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RESULT_DIR, `aos-storage-${sequelize.config.database}-pool8-concurrency.json`),
      JSON.stringify(result, null, 2)
    );
    process.stdout.write(
      JSON.stringify({
        poolMax: result.poolMax,
        scopeRows: result.scopeRows,
        queriesP95: queries.p95,
        queriesPlusUploadP95: queriesPlusUpload.p95,
        peakRssBytes: Math.max(queries.peakRssBytes, queriesPlusUpload.peakRssBytes),
      }) + '\n'
    );
  } catch (error) {
    logger.debug('并发复测失败', { errorCode: error.name });
    throw error;
  }
}
async function dailyBudget() {
  try {
    if (sequelize.config.database !== 'aos_log_test_synthetic_small_batch_1_budget')
      throw new Error('5秒预算吞吐仅允许预算专库');
    const store = require('../src/services/monitorLogBlockStore');
    const { compact } = require('../src/services/monitorLogBlockCompactor');
    const [occupied] = await sequelize.query(
      'SELECT count(*)::text AS value FROM monitor_log_receipts',
      { type: QueryTypes.SELECT }
    );
    if (occupied.value !== '0') throw new Error('预算专库非空，拒绝覆盖');
    const first = syntheticRow(0, 3000);
    await AosDevice.create({
      id: first.deviceId,
      name: '合成5秒预算基准',
      credentialHash: createHash('sha256').update(first.deviceId).digest('hex'),
    });
    for (let index = 0; index < 3000; index++)
      await sequelize.transaction(async transaction => {
        try {
          await store.append([syntheticRow(index, 3000)], transaction);
        } catch (error) {
          logger.debug('预算夹具事务失败', { errorCode: error.name });
          throw error;
        }
      });
    await sequelize.query(
      `INSERT INTO monitor_log_storage_scopes(device_id,local_id,mode)VALUES(:deviceId,:localId,'blocks');
      INSERT INTO monitor_log_storage_metrics(name,value)VALUES('storage-default','{"mode":"blocks"}')`,
      { replacements: first }
    );
    const at = performance.now();
    const result = await compact({
      today: new Date(Date.parse(`${today}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10),
      maxBatches: 100,
      budgetMs: 5000,
      maxRows: 1000,
      maxSourceBlocks: 64,
    });
    const measuredMs = performance.now() - at;
    const [counts] = await sequelize.query(
      `SELECT (SELECT count(*) FROM monitor_log_blocks)::text AS blocks,
      (SELECT count(*) FROM monitor_log_receipts)::text AS receipts,(SELECT sum(entry_count) FROM monitor_log_blocks)::text AS rows`,
      { type: QueryTypes.SELECT }
    );
    if (counts.receipts !== '3000' || counts.rows !== '3000') throw new Error('预算压实闭集丢失');
    const output = {
      kind: 'synthetic-5s-compaction-throughput',
      poolMax: Number(process.env.DB_POOL_MAX),
      sourceBlocksBefore: 3000,
      ...counts,
      ...result,
      measuredMs,
    };
    fs.mkdirSync(RESULT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RESULT_DIR, 'aos-storage-small-5s-throughput.json'),
      JSON.stringify(output, null, 2)
    );
    process.stdout.write(JSON.stringify(output) + '\n');
  } catch (error) {
    logger.debug('预算压实吞吐测量失败', { errorCode: error.name });
    throw error;
  }
}
/** 加速模拟30日小请求的真实存储结构和同日维护；不是跨30日生产观测。 */
async function steady() {
  try {
    const requestSize = Number(process.env.AOS_BENCHMARK_REQUEST_SIZE || 1);
    const realDay = process.env.AOS_BENCHMARK_REAL_DAY === 'true';
    const manual = process.env.AOS_BENCHMARK_MANUAL === 'true';
    const suffix = realDay ? '_auto_day' : manual ? '_manual' : '';
    const dayCount = realDay ? 1 : 30;
    const roundsPerDay = realDay ? 4 : 20;
    const totalRows = dayCount * roundsPerDay * 150;
    if (
      ![1, 10].includes(requestSize) ||
      sequelize.config.database !== `aos_log_test_synthetic_tiny_steady_${requestSize}${suffix}`
    )
      throw new Error('连续小请求仅允许对应的专用空合成库');
    const [occupied] = await sequelize.query(
      'SELECT count(*)::text AS n FROM monitor_log_receipts',
      { type: QueryTypes.SELECT }
    );
    if (occupied.n !== '0') throw new Error('连续请求合成库非空，拒绝覆盖');
    const store = require('../src/services/monitorLogBlockStore');
    const { compact } = require('../src/services/monitorLogBlockCompactor');
    const deviceId = uuid('steady-device');
    const localId = uuid('steady-local');
    const firstDate = new Date(baseTime - (realDay ? 0 : 29) * DAY_MS + 8 * 3600000)
      .toISOString()
      .slice(0, 10);
    const makeRow = index => {
      const dayIndex = Math.floor(index / 3000);
      const dayAt = baseTime - ((realDay ? 0 : 29) - dayIndex) * DAY_MS;
      const timestamp = new Date(dayAt + (index % 3000) * 28000).toISOString();
      const day = new Date(dayAt + 8 * 3600000).toISOString().slice(0, 10);
      const value = policy.entry({
        id: uuid(`steady-event-${index}`),
        localId,
        fileId: uuid(`steady-file-${day}`),
        fileName: `Log${day.replace(/-/g, '')}_steady.txt`,
        businessDate: day,
        loggedAt: timestamp,
        contextAt: null,
        accountNumber: `00${index % 27}`,
        lineNumber: index + 1,
        partIndex: 0,
        byteOffset: index * 100,
        message: `${timestamp} [00${index % 27}] ${uuid(`steady-trace-${index}`)} 继续监控中\n`,
        rawBase64: null,
        parseState: 'parsed',
      });
      return {
        ...value,
        deviceId,
        sortAt: timestamp,
        payloadHash: policy.digest(value),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    };
    await AosDevice.upsert({
      id: deviceId,
      name: '30日小请求结构合成',
      credentialHash: createHash('sha256').update(deviceId).digest('hex'),
    });
    const [legacyPrefix] = await sequelize.query(
      'SELECT count(*)::text AS n,coalesce(max(line_number),0)::text AS last FROM monitor_log_entries',
      { type: QueryTypes.SELECT }
    );
    if (legacyPrefix.n !== legacyPrefix.last || Number(legacyPrefix.n) > totalRows)
      throw new Error('连续请求旧对照不是连续前缀');
    for (let start = Number(legacyPrefix.n); start < totalRows; start += 2000)
      await MonitorLogEntry.bulkCreate(
        Array.from({ length: Math.min(2000, totalRows - start) }, (_, i) => makeRow(start + i))
      );
    await sequelize.query(
      `INSERT INTO monitor_log_storage_scopes(device_id,local_id,mode)VALUES(:deviceId,:localId,'blocks');
      INSERT INTO monitor_log_storage_metrics(name,value)VALUES('storage-default','{"mode":"blocks"}')`,
      { replacements: { deviceId, localId } }
    );
    const result = {
      kind: realDay
        ? 'synthetic-real-day-default-autovacuum'
        : 'synthetic-30day-small-request-structure',
      requestSize,
      manual,
      rows: totalRows,
      rounds: [],
      note: realDay
        ? '同一真实业务日4轮，每轮150片段；压实后真实等待65秒默认autovacuum，最终人工VACUUM独立列出。'
        : manual
          ? '加速30日，每逻辑日20轮，每轮150片段；每轮人工VACUUM独立正对照，不能当作已接入生产维护。'
          : '加速30日每逻辑日20轮，每轮150片段；真实v1块/签名/回执/目录等价批量INSERT，非90k次HTTP上传；默认autovacuum保持不改、最终人工VACUUM独立列出。',
      days: [],
    };
    let totalCompactMs = 0;
    let totalInsertMs = 0;
    const [walStart] = await sequelize.query('SELECT pg_current_wal_lsn()::text AS lsn', {
      type: QueryTypes.SELECT,
    });
    const physical = async () => {
      try {
        const [value] = await sequelize.query(
          `SELECT
        (SELECT pg_total_relation_size('monitor_log_entries'))::text AS old_bytes,
        (SELECT sum(pg_total_relation_size(oid)) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN('r','p') AND
          (relname LIKE 'monitor_log_blocks%' OR relname LIKE 'monitor_log_block_accounts%' OR relname IN
          ('monitor_log_receipts','monitor_log_files','monitor_log_storage_scopes','monitor_log_storage_metrics')))::text AS new_bytes,
        (SELECT count(*) FROM monitor_log_blocks)::text AS blocks,
        (SELECT count(*) FROM monitor_log_receipts)::text AS receipts`,
          { type: QueryTypes.SELECT }
        );
        value.autovacuum = await sequelize.query(
          `SELECT relname,n_live_tup,n_dead_tup,autovacuum_count,vacuum_count,last_autovacuum
          FROM pg_stat_user_tables WHERE relname LIKE 'monitor_log_blocks%' OR relname LIKE 'monitor_log_block_accounts%' OR relname='monitor_log_receipts' ORDER BY relname`,
          { type: QueryTypes.SELECT }
        );
        return value;
      } catch (error) {
        throw new Error(`连续请求容量查询失败:${error.name}`);
      }
    };
    for (let dayIndex = 0; dayIndex < dayCount; dayIndex++) {
      const day = makeRow(dayIndex * 3000).businessDate;
      await sequelize.transaction(async transaction => {
        try {
          await store.ensureDay(day, transaction);
        } catch (error) {
          throw new Error(`连续请求日期创建失败:${error.name}`);
        }
      });
      const [file] = await sequelize.query(
        'INSERT INTO monitor_log_files(device_id,file_id)VALUES(:deviceId,:fileId)RETURNING id',
        {
          replacements: { deviceId, fileId: makeRow(dayIndex * 3000).fileId },
          type: QueryTypes.SELECT,
        }
      );
      let lastMaintenance;
      for (let round = 0; round < roundsPerDay; round++) {
        const rows = Array.from({ length: 150 }, (_, i) =>
          makeRow(dayIndex * 3000 + round * 150 + i)
        );
        const insertStarted = performance.now();
        await sequelize.transaction(async transaction => {
          try {
            const ids = await sequelize.query(
              "SELECT nextval('monitor_log_block_id_seq')::text AS id FROM generate_series(1,:n)",
              { replacements: { n: 150 / requestSize }, transaction, type: QueryTypes.SELECT }
            );
            const blocks = [],
              receipts = [],
              directories = [];
            const values = items =>
              '(' + items.map(value => sequelize.escape(value)).join(',') + ')';
            for (let i = 0; i < rows.length; i += requestSize) {
              const batch = rows.slice(i, i + requestSize).map(row => ({
                ...row,
                byteOffset: String(row.byteOffset),
                lineNumber: String(row.lineNumber),
              }));
              const id = ids[i / requestSize].id;
              const first = batch[0],
                last = batch.at(-1);
              const raw = Buffer.from('[' + batch.map(store.encodeRow).join(',') + ']');
              blocks.push(
                values([
                  day,
                  id,
                  deviceId,
                  localId,
                  file.id,
                  first.fileName,
                  'gzip',
                  zlib.gzipSync(raw, { level: 6 }),
                  createHash('sha256').update(raw).digest(),
                  store.signature(batch.map(row => row.message)),
                  batch.length,
                  raw.length,
                  first.sortAt,
                  first.fileId,
                  first.byteOffset,
                  last.sortAt,
                  last.fileId,
                  last.byteOffset,
                ])
              );
              const accounts = new Map();
              batch.forEach((row, ordinal) => {
                receipts.push(
                  values([
                    row.id,
                    file.id,
                    row.byteOffset,
                    Buffer.from(row.payloadHash, 'hex'),
                    day,
                    id,
                    ordinal,
                  ])
                );
                if (!accounts.has(row.accountNumber || ''))
                  accounts.set(row.accountNumber || '', []);
                accounts.get(row.accountNumber || '').push(row);
              });
              for (const [account, items] of accounts) {
                const a = items[0],
                  b = items.at(-1);
                directories.push(
                  values([
                    day,
                    id,
                    deviceId,
                    localId,
                    account,
                    a.sortAt,
                    a.fileId,
                    a.byteOffset,
                    b.sortAt,
                    b.fileId,
                    b.byteOffset,
                  ])
                );
              }
            }
            await sequelize.query(
              `INSERT INTO monitor_log_blocks(business_date,id,device_id,local_id,file_key,file_name,codec,payload,payload_hash,signature,entry_count,raw_bytes,min_sort_at,min_file_id,min_byte_offset,max_sort_at,max_file_id,max_byte_offset)VALUES ${blocks.join(',')}`,
              { transaction }
            );
            await sequelize.query(
              `INSERT INTO monitor_log_receipts(id,file_key,byte_offset,payload_hash,business_date,block_id,ordinal)VALUES ${receipts.join(',')}`,
              { transaction }
            );
            await sequelize.query(
              `INSERT INTO monitor_log_block_accounts(business_date,block_id,device_id,local_id,account_number,min_sort_at,min_file_id,min_byte_offset,max_sort_at,max_file_id,max_byte_offset)VALUES ${directories.join(',')}`,
              { transaction }
            );
          } catch (error) {
            throw new Error(`连续请求结构插入失败:${error.message}`);
          }
        });
        totalInsertMs += performance.now() - insertStarted;
        const compactStarted = performance.now();
        lastMaintenance = await compact({
          today: day,
          first: firstDate,
          maxBatches: 100,
          budgetMs: 5000,
          maxRows: 1000,
          maxSourceBlocks: 64,
        });
        totalCompactMs += performance.now() - compactStarted;
        if (manual)
          await sequelize.query(
            'VACUUM (ANALYZE) monitor_log_receipts,monitor_log_blocks,monitor_log_block_accounts,monitor_log_storage_metrics'
          );
        if (realDay) {
          const beforeAuto = await physical();
          await new Promise(resolve => setTimeout(resolve, 65000));
          const afterAuto = await physical();
          result.rounds.push({ round, beforeAuto, afterAuto, lastMaintenance });
          process.stdout.write(
            JSON.stringify({
              round,
              before: beforeAuto.new_bytes,
              after: afterAuto.new_bytes,
              autoVacuums: afterAuto.autovacuum.reduce(
                (sum, row) => sum + Number(row.autovacuum_count),
                0
              ),
              receipts: afterAuto.receipts,
            }) + '\n'
          );
        }
      }
      const snapshot = { day, ...(await physical()), lastMaintenance };
      result.days.push(snapshot);
      process.stdout.write(
        JSON.stringify({
          day,
          newBytes: snapshot.new_bytes,
          blocks: snapshot.blocks,
          receipts: snapshot.receipts,
          autoVacuums: snapshot.autovacuum.reduce(
            (sum, row) => sum + Number(row.autovacuum_count),
            0
          ),
          compactMs: totalCompactMs,
        }) + '\n'
      );
    }
    result.beforeManualVacuum = await physical();
    // 保留默认autovacuum短实测窗口，与人工VACUUM结果严格区分。
    await new Promise(resolve => setTimeout(resolve, 65000));
    result.afterDefaultAutovacuumWindow = await physical();
    await sequelize.query(
      'VACUUM (ANALYZE) monitor_log_receipts,monitor_log_blocks,monitor_log_block_accounts,monitor_log_storage_metrics'
    );
    result.afterManualVacuum = await physical();
    const [wal] = await sequelize.query(
      'SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),:lsn)::text AS bytes',
      { replacements: walStart, type: QueryTypes.SELECT }
    );
    result.sharedClusterWalBytes = wal.bytes;
    result.walNote = '全共享隔离PG的LSN差值，若其他测试同时写入，不能归属纯steady WAL。';
    result.totalCompactMs = totalCompactMs;
    result.totalInsertMs = totalInsertMs;
    const [counts] = await sequelize.query(
      'SELECT (SELECT count(*) FROM monitor_log_receipts)::text AS receipts,(SELECT sum(entry_count) FROM monitor_log_blocks)::text AS rows',
      { type: QueryTypes.SELECT }
    );
    if (counts.receipts !== String(totalRows) || counts.rows !== String(totalRows))
      throw new Error('连续请求90k闭集失败');
    result.closedSet = counts;
    fs.mkdirSync(RESULT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RESULT_DIR, `aos-storage-${sequelize.config.database}-steady.json`),
      JSON.stringify(result, null, 2)
    );
    process.stdout.write(
      JSON.stringify({
        kind: result.kind,
        requestSize,
        before: result.beforeManualVacuum.new_bytes,
        auto: result.afterDefaultAutovacuumWindow.new_bytes,
        manual: result.afterManualVacuum.new_bytes,
        totalCompactMs,
        totalInsertMs,
        closedSet: counts,
      }) + '\n'
    );
  } catch (error) {
    logger.debug('连续小请求结构验证失败', { errorCode: error.name });
    throw error;
  }
}
/** 单一合成写入窗口测量单条即时成块、压实及人工VACUUM的WAL；不调整生产维护。 */
async function wal() {
  try {
    if (
      !['aos_log_test_synthetic_tiny_wal', 'aos_log_test_synthetic_tiny_wal_retry'].includes(
        sequelize.config.database
      )
    )
      throw new Error('WAL仅允许独立空合成库');
    const [occupied] = await sequelize.query(
      'SELECT count(*)::text AS n FROM monitor_log_receipts',
      { type: QueryTypes.SELECT }
    );
    if (occupied.n !== '0') throw new Error('WAL专库非空拒绝覆盖');
    const store = require('../src/services/monitorLogBlockStore');
    const { compact } = require('../src/services/monitorLogBlockCompactor');
    const first = syntheticRow(0, 3000);
    await AosDevice.create({
      id: first.deviceId,
      name: '单组WAL合成验证',
      credentialHash: createHash('sha256').update(first.deviceId).digest('hex'),
    });
    await sequelize.query(
      `INSERT INTO monitor_log_storage_scopes(device_id,local_id,mode)VALUES(:deviceId,:localId,'blocks');
      INSERT INTO monitor_log_storage_metrics(name,value)VALUES('storage-default','{"mode":"blocks"}')`,
      { replacements: first }
    );
    await sequelize.transaction(async transaction => {
      try {
        await store.ensureDay(today, transaction);
      } catch (error) {
        throw new Error(`WAL分区准备失败:${error.name}`);
      }
    });
    const snapshot = async () => {
      try {
        const [value] = await sequelize.query(
          `SELECT pg_current_wal_lsn()::text AS lsn,
          (SELECT count(*) FROM pg_stat_activity WHERE datname<>current_database() AND state='active') AS other_active`,
          { type: QueryTypes.SELECT }
        );
        return value;
      } catch (error) {
        throw new Error(`WAL快照失败:${error.name}`);
      }
    };
    const difference = async start => {
      try {
        return (
          await sequelize.query(
            'SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),:lsn)::text AS bytes',
            { replacements: { lsn: start }, type: QueryTypes.SELECT }
          )
        )[0].bytes;
      } catch (error) {
        throw new Error(`WAL差值失败:${error.name}`);
      }
    };
    const result = {
      kind: 'synthetic-single-writer-wal',
      rows: 3000,
      poolMax: Number(process.env.DB_POOL_MAX),
      note: '其他开发写者已停止；LSN仍为全隔离PG级别，其他数据库后台autovacuum可能贡献，非生产成本承诺。',
    };
    result.beforeUpload = await snapshot();
    let at = performance.now();
    for (let index = 0; index < 3000; index++) {
      const timestamp = new Date(baseTime + index * 28000).toISOString();
      const raw = syntheticRow(index, 3000);
      for (const key of ['deviceId', 'sortAt', 'payloadHash', 'createdAt', 'updatedAt'])
        delete raw[key];
      const value = policy.entry({
        ...raw,
        businessDate: today,
        fileId: uuid('wal-file'),
        fileName: `Log${today.replace(/-/g, '')}_wal.txt`,
        loggedAt: timestamp,
        contextAt: null,
      });
      const row = {
        ...value,
        deviceId: first.deviceId,
        sortAt: timestamp,
        payloadHash: policy.digest(value),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await sequelize.transaction(async transaction => {
        try {
          await store.append([row], transaction);
        } catch (error) {
          throw new Error(`WAL即时事务失败:${error.name}`);
        }
      });
      if (index === 0 || index === 2999)
        if (!(await store.findById(value.id))) throw new Error('WAL即时可见失败');
    }
    result.uploadMs = performance.now() - at;
    result.uploadWalBytes = await difference(result.beforeUpload.lsn);
    const beforeRows = await sequelize.query(
      'SELECT id,file_key,byte_offset,payload_hash FROM monitor_log_receipts ORDER BY id',
      { type: QueryTypes.SELECT }
    );
    const before = {
      receipts: String(beforeRows.length),
      hash: createHash('sha256').update(JSON.stringify(beforeRows)).digest('hex'),
    };
    result.beforeCompact = await snapshot();
    at = performance.now();
    result.compaction = await compact({
      today,
      maxBatches: 100,
      budgetMs: 5000,
      maxRows: 1000,
      maxSourceBlocks: 64,
    });
    result.compactMs = performance.now() - at;
    result.compactWalBytes = await difference(result.beforeCompact.lsn);
    const after = await sequelize.query(
      'SELECT id,file_key,byte_offset,payload_hash FROM monitor_log_receipts ORDER BY id',
      { type: QueryTypes.SELECT }
    );
    if (
      before.receipts !== '3000' ||
      before.hash !== createHash('sha256').update(JSON.stringify(after)).digest('hex')
    )
      throw new Error('WAL压实回执认证差分失败');
    const [counts] = await sequelize.query(
      'SELECT count(*)::text AS blocks,sum(entry_count)::text AS rows FROM monitor_log_blocks',
      { type: QueryTypes.SELECT }
    );
    result.closedSet = { ...counts, receipts: before.receipts, receiptDifference: 0 };
    result.beforeManualVacuum = await snapshot();
    at = performance.now();
    await sequelize.query(
      'VACUUM (ANALYZE) monitor_log_receipts,monitor_log_blocks,monitor_log_block_accounts,monitor_log_storage_metrics'
    );
    result.manualVacuumMs = performance.now() - at;
    result.manualVacuumWalBytes = await difference(result.beforeManualVacuum.lsn);
    result.after = await snapshot();
    result.rssBytes = process.memoryUsage().rss;
    fs.mkdirSync(RESULT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RESULT_DIR, 'aos-storage-single-writer-wal.json'),
      JSON.stringify(result, null, 2)
    );
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    logger.debug('单组WAL实验失败', { errorCode: error.name });
    throw error;
  }
}
async function measureSmall() {
  try {
    if (!sequelize.config.database.startsWith('aos_log_test_synthetic_small_batch_'))
      throw new Error('小请求性能仅允许专库');
    const store = require('../src/services/monitorLogBlockStore');
    const [scope] = await sequelize.query(
      'SELECT device_id AS "deviceId",local_id AS "localId",business_date AS date FROM monitor_log_blocks LIMIT 1',
      { type: QueryTypes.SELECT }
    );
    const query = policy.query(scope);
    const results = {};
    for (const [name, extra] of [
      ['first', {}],
      ['short-absent', { keyword: '龘' }],
      ['repeated-gram-absent', { keyword: 'ffffffffffffffff' }],
    ])
      results[name] = await timings(() => store.select({ ...query, ...extra }, null, 'ASC', 50));
    const [sizes] = await sequelize.query(
      `SELECT
      (SELECT pg_total_relation_size('monitor_log_entries'))::text AS old_bytes,
      (SELECT sum(pg_total_relation_size(oid)) FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN('r','p') AND
        (relname LIKE 'monitor_log_blocks%' OR relname LIKE 'monitor_log_block_accounts%' OR relname IN
        ('monitor_log_receipts','monitor_log_files','monitor_log_storage_scopes','monitor_log_storage_metrics')))::text AS new_bytes,
      (SELECT count(*) FROM monitor_log_blocks)::text AS blocks,
      (SELECT count(*) FROM monitor_log_receipts)::text AS receipts`,
      { type: QueryTypes.SELECT }
    );
    const stage = process.env.AOS_BENCHMARK_STAGE || 'before';
    if (!['before', 'after', 'fresh'].includes(stage)) throw new Error('小请求测量阶段无效');
    const result = {
      kind: 'synthetic-daily-small-measure',
      database: sequelize.config.database,
      stage,
      ...sizes,
      timings: results,
    };
    fs.mkdirSync(RESULT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RESULT_DIR, `aos-storage-${sequelize.config.database}-${stage}.json`),
      JSON.stringify(result, null, 2)
    );
    process.stdout.write(
      JSON.stringify({
        stage,
        ...sizes,
        timings: Object.fromEntries(
          Object.entries(results).map(([name, value]) => [name, value.p95])
        ),
      }) + '\n'
    );
  } catch (error) {
    logger.debug('小请求性能测量失败', { errorCode: error.name });
    throw error;
  }
}
async function compactSmall() {
  try {
    if (!/^aos_log_test_synthetic_small_batch_(1|10|200)$/.test(sequelize.config.database))
      throw new Error('小请求压实仅允许三个原专库');
    const store = require('../src/services/monitorLogBlockStore');
    const { compact } = require('../src/services/monitorLogBlockCompactor');
    const [scope] = await sequelize.query(
      'SELECT device_id AS "deviceId",local_id AS "localId",business_date AS date FROM monitor_log_blocks LIMIT 1',
      { type: QueryTypes.SELECT }
    );
    const query = policy.query(scope);
    const collect = async () => {
      try {
        const rows = [];
        let anchor = null;
        for (let page = 0; page < 100; page++) {
          const batch = await store.select(query, anchor, 'ASC', 100);
          rows.push(...batch);
          if (batch.length < 100) return rows;
          anchor = batch.at(-1);
        }
        throw new Error('小请求全页游标未收敛');
      } catch (error) {
        logger.debug('小请求全页查询失败', { errorCode: error.name });
        throw error;
      }
    };
    const before = await collect();
    const privateBefore = await sequelize.query(
      'SELECT id,file_key,byte_offset,payload_hash,business_date FROM monitor_log_receipts ORDER BY id',
      { type: QueryTypes.SELECT }
    );
    await sequelize.query(
      `INSERT INTO monitor_log_storage_scopes(device_id,local_id,mode) VALUES(:deviceId,:localId,'blocks')
      ON CONFLICT(device_id,local_id) DO UPDATE SET mode='blocks';
      INSERT INTO monitor_log_storage_metrics(name,value)VALUES('storage-default','{"mode":"blocks"}')ON CONFLICT(name)DO UPDATE SET value=EXCLUDED.value`,
      { replacements: query }
    );
    const nextDay = new Date(Date.parse(`${today}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
    const batches = [];
    for (let round = 0; round < 10; round++) {
      const result = await compact({
        today: nextDay,
        maxBatches: 20,
        budgetMs: 10000,
        maxRows: 1000,
        maxSourceBlocks: 64,
      });
      batches.push(result);
    }
    const after = await collect();
    const privateAfter = await sequelize.query(
      'SELECT id,file_key,byte_offset,payload_hash,business_date FROM monitor_log_receipts ORDER BY id',
      { type: QueryTypes.SELECT }
    );
    if (
      JSON.stringify(before) !== JSON.stringify(after) ||
      JSON.stringify(privateBefore) !== JSON.stringify(privateAfter)
    )
      throw new Error('压实完整字段或幂等认证差分不为0');
    const result = {
      kind: 'synthetic-small-compaction',
      rows: after.length,
      closedSetDifference: 0,
      batches,
    };
    fs.mkdirSync(RESULT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RESULT_DIR, `aos-storage-${sequelize.config.database}-compaction.json`),
      JSON.stringify(result, null, 2)
    );
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    logger.debug('小请求压实失败', { errorCode: error.name });
    throw error;
  }
}
async function integrity() {
  try {
    if (
      !['aos_log_test_synthetic_scale', 'aos_log_test_synthetic_restore'].includes(
        sequelize.config.database
      )
    )
      throw new Error('完整恢复认证仅允许全量合成源与恢复专库');
    const store = require('../src/services/monitorLogBlockStore');
    const started = performance.now();
    const result = {
      kind: 'synthetic-full-integrity',
      database: sequelize.config.database,
      counts: {},
      fingerprints: {},
      blocksVerified: 0,
      rowsVerified: 0,
    };
    await sequelize.transaction(
      { isolationLevel: 'REPEATABLE READ', readOnly: true },
      async transaction => {
        try {
          for (const name of [
            'aos_devices',
            'monitor_log_storage_scopes',
            'monitor_log_storage_metrics',
            'monitor_log_files',
            'monitor_log_receipts',
            'monitor_log_block_accounts',
          ]) {
            const [summary] = await sequelize.query(
              `SELECT count(*)::text AS count,
            coalesce(sum(('x'||substr(md5(row_to_json(t)::text),1,15))::bit(60)::bigint),0)::text AS first,
            coalesce(sum(('x'||substr(md5(row_to_json(t)::text),17,15))::bit(60)::bigint),0)::text AS second
            FROM ${name} t`,
              { transaction, type: QueryTypes.SELECT }
            );
            result.counts[name] = summary.count;
            result.fingerprints[name] = [summary.first, summary.second];
          }
          const digest = createHash('sha256');
          const days = await sequelize.query(
            'SELECT business_date AS day,count(*)::text AS blocks FROM monitor_log_blocks GROUP BY business_date ORDER BY business_date',
            { transaction, type: QueryTypes.SELECT }
          );
          for (const day of days) {
            let after = 0;
            let verified = 0;
            while (verified < Number(day.blocks)) {
              const blocks = await sequelize.query(
                'SELECT * FROM monitor_log_blocks WHERE business_date=:day AND id>:after ORDER BY id LIMIT 32',
                { transaction, replacements: { after, day: day.day }, type: QueryTypes.SELECT }
              );
              if (!blocks.length) throw new Error('合成块分页出现缺口');
              for (const block of blocks) {
                const rows = await store.readBlock(block);
                result.blocksVerified++;
                verified++;
                result.rowsVerified += rows.length;
                const metadata = {
                  ...block,
                  payload: undefined,
                  payloadHash: block.payload_hash.toString('hex'),
                };
                digest.update(JSON.stringify(metadata) + '\n');
                after = block.id;
              }
            }
          }
          result.fingerprints.blocksSha256 = digest.digest('hex');
          if (result.rowsVerified !== Number(result.counts.monitor_log_receipts))
            throw new Error('恢复块与回执片段数不同');
        } catch (error) {
          logger.debug('合成恢复认证事务失败', { errorCode: error.name });
          throw error;
        }
      }
    );
    result.elapsedMs = performance.now() - started;
    fs.mkdirSync(RESULT_DIR, { recursive: true });
    if (sequelize.config.database.endsWith('_restore')) {
      const original = JSON.parse(
        fs.readFileSync(
          path.join(RESULT_DIR, 'aos-storage-aos_log_test_synthetic_scale-integrity.json')
        )
      );
      for (const key of ['counts', 'fingerprints', 'blocksVerified', 'rowsVerified'])
        if (JSON.stringify(result[key]) !== JSON.stringify(original[key]))
          throw new Error('合成恢复完整认证不匹配');
      result.sourceManifestMatched = true;
    }
    fs.writeFileSync(
      path.join(RESULT_DIR, `aos-storage-${sequelize.config.database}-integrity.json`),
      JSON.stringify(result, null, 2)
    );
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    logger.debug('合成恢复认证失败', { errorCode: error.name });
    throw error;
  }
}
async function cold() {
  try {
    const store = require('../src/services/monitorLogBlockStore');
    const context = JSON.parse(
      fs.readFileSync(
        path.join(RESULT_DIR, 'aos-storage-aos_log_test_synthetic_scale-query-context.json')
      )
    );
    const choices = {
      first: {},
      rare: { keyword: context.rareKeyword },
      'short-absent': { keyword: '龘' },
      'repeated-gram-absent': { keyword: 'ffffffffffffffff' },
    };
    const name = process.argv[3];
    if (!choices[name]) throw new Error('冷启动用例无效');
    const started = performance.now();
    let decodedBlocks = 0;
    const originalInfo = logger.info;
    logger.info = (message, metrics) => {
      if (metrics?.storage === 'blocks') decodedBlocks = metrics.decodedBlocks;
    };
    const rows = await store.select({ ...context.query, ...choices[name] }, null, 'ASC', 50);
    logger.info = originalInfo;
    process.stdout.write(
      JSON.stringify({
        kind: 'synthetic-db-buffer-cold',
        name,
        durationMs: performance.now() - started,
        rows: rows.length,
        decodedBlocks,
        rssBytes: process.memoryUsage().rss,
        osCache: 'retained',
      }) + '\n'
    );
  } catch (error) {
    logger.debug('合成恢复冷启动测量失败', { errorCode: error.name });
    throw error;
  }
}
async function codecs() {
  try {
    if (typeof zlib.zstdCompressSync !== 'function')
      throw new Error('此运行时不支持原生Zstandard实验');
    const blocks = await sequelize.query(
      'SELECT payload FROM monitor_log_blocks ORDER BY business_date,id LIMIT 32',
      { type: QueryTypes.SELECT }
    );
    if (!blocks.length) throw new Error('合成块数据为空');
    const rawBlocks = blocks.map(block => zlib.gunzipSync(block.payload));
    const result = {
      kind: 'synthetic-codec-comparison',
      blocks: blocks.length,
      rawBytes: rawBlocks.reduce((sum, raw) => sum + raw.length, 0),
      note: 'Zstandard仅Node22.22实验，项目Node20兼容须另验；本轮生产codec仍gzip。',
      codecs: {},
    };
    for (const codec of ['gzip6', 'zstd3']) {
      const compress = raw =>
        codec === 'gzip6'
          ? zlib.gzipSync(raw, { level: 6 })
          : zlib.zstdCompressSync(raw, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 } });
      const decompress = payload =>
        codec === 'gzip6' ? zlib.gunzipSync(payload) : zlib.zstdDecompressSync(payload);
      const payloads = rawBlocks.map(compress);
      for (let index = 0; index < payloads.length; index++)
        if (!decompress(payloads[index]).equals(rawBlocks[index]))
          throw new Error('压缩器实验无损核对失败');
      const compressTimes = [];
      const decompressTimes = [];
      for (let round = 0; round < REPETITIONS; round++) {
        let started = performance.now();
        rawBlocks.forEach(compress);
        compressTimes.push(performance.now() - started);
        started = performance.now();
        payloads.forEach(decompress);
        decompressTimes.push(performance.now() - started);
      }
      result.codecs[codec] = {
        bytes: payloads.reduce((sum, payload) => sum + payload.length, 0),
        batchCompressP95Ms: percentile(compressTimes, 0.95),
        batchDecompressP95Ms: percentile(decompressTimes, 0.95),
      };
    }
    fs.mkdirSync(RESULT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(RESULT_DIR, `aos-storage-${sequelize.config.database}-codecs.json`),
      JSON.stringify(result, null, 2)
    );
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    logger.debug('合成压缩器对照失败', { errorCode: error.name });
    throw error;
  }
}
async function main() {
  try {
    const mode = process.argv[2];
    await guard();
    if (mode === 'seed') await seed(Number(process.argv[3] || 1000000));
    else if (mode === 'measure') await measure();
    else if (mode === 'codecs') await codecs();
    else if (mode === 'indexes') await rebuildIndexes();
    else if (mode === 'small-batch') await smallBatch();
    else if (mode === 'integrity') await integrity();
    else if (mode === 'cold') await cold();
    else if (mode === 'small-append') await appendSmallDay();
    else if (mode === 'measure-small') await measureSmall();
    else if (mode === 'compact-small') await compactSmall();
    else if (mode === 'concurrent') await concurrent();
    else if (mode === 'daily-budget') await dailyBudget();
    else if (mode === 'steady') await steady();
    else if (mode === 'wal') await wal();
    else throw new Error('仅接受seed、measure、codecs、indexes或small-batch子命令');
  } catch (error) {
    logger.error('隔离日志存储基准失败', { errorCode: error.name, reason: error.message });
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}
if (require.main === module) main();
module.exports = { syntheticRow, oldSelect };
