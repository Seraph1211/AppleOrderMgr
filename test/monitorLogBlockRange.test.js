/* eslint camelcase: ["error", {"properties": "never"}] */
const { createHash } = require('crypto');
const { gzipSync } = require('zlib');

jest.mock('../src/models', () => ({ sequelize: {} }));
jest.mock('../src/utils/logger', () => ({ warn: jest.fn(), debug: jest.fn(), info: jest.fn() }));

const { sequelize } = require('../src/models');
const store = require('../src/services/monitorLogBlockStore');
const logger = require('../src/utils/logger');

const DEVICE_ID = '00000000-0000-4000-a000-000000000010';
const LOCAL_ID = '00000000-0000-4000-a000-000000000020';
const FILE_ID = '00000000-0000-4000-a000-000000000030';
const TRANSACTION = { id: 'snapshot' };
const isMetadataQuery = sql =>
  sql.startsWith('SELECT b.business_date AS business_date') ||
  sql.startsWith('SELECT a.business_date AS business_date');

function makeBlock(day, minute, message, extra = {}) {
  const sortAt = new Date(Date.parse(`${day}T00:00:00+08:00`) + minute * 60000).toISOString();
  const values = [
    `${day}-${minute}`,
    sortAt,
    sortAt,
    extra.accountNumber ?? 'acct-1',
    '1',
    0,
    String(minute),
    message,
    null,
    'parsed',
    null,
    sortAt,
    sortAt,
  ];
  const raw = Buffer.from(JSON.stringify([values]));
  return {
    id: String(Number(day.replace(/-/g, '')) * 10000 + minute),
    business_date: day,
    device_id: DEVICE_ID,
    local_id: LOCAL_ID,
    file_id: FILE_ID,
    file_name: 'monitor.log',
    format_version: 1,
    codec: 'gzip',
    account_number: extra.accountNumber ?? 'acct-1',
    payload: gzipSync(raw),
    raw_bytes: raw.length,
    payload_hash: createHash('sha256').update(raw).digest(),
    entry_count: 1,
    signature: extra.keywordMatch === false ? '0'.repeat(8192) : '1'.repeat(8192),
    min_sort_at: sortAt,
    min_file_id: FILE_ID,
    min_byte_offset: String(minute),
    max_sort_at: sortAt,
    max_file_id: FILE_ID,
    max_byte_offset: String(minute),
    boundary_at: sortAt,
    boundary_file: FILE_ID,
    boundary_offset: String(minute),
    ...extra.block,
  };
}

function makeMultiBlock(day, blockNumber, boundaries, entries) {
  const values = entries.map(({ minute, message }) => {
    const sortAt = new Date(Date.parse(`${day}T00:00:00+08:00`) + minute * 60000).toISOString();
    return [
      `${day}-${blockNumber}-${minute}`,
      sortAt,
      sortAt,
      'acct-1',
      '1',
      0,
      String(minute),
      message,
      null,
      'parsed',
      null,
      sortAt,
      sortAt,
    ];
  });
  const raw = Buffer.from(JSON.stringify(values));
  const minAt = new Date(
    Date.parse(`${day}T00:00:00+08:00`) + boundaries.min * 60000
  ).toISOString();
  const maxAt = new Date(
    Date.parse(`${day}T00:00:00+08:00`) + boundaries.max * 60000
  ).toISOString();
  const blockId = String(Number(day.replace(/-/g, '')) * 10000 + blockNumber);
  return {
    id: blockId,
    business_date: day,
    device_id: DEVICE_ID,
    local_id: LOCAL_ID,
    file_id: FILE_ID,
    file_name: 'monitor.log',
    format_version: 1,
    codec: 'gzip',
    payload: gzipSync(raw),
    raw_bytes: raw.length,
    payload_hash: createHash('sha256').update(raw).digest(),
    entry_count: values.length,
    signature: '1'.repeat(8192),
    min_sort_at: minAt,
    min_file_id: FILE_ID,
    min_byte_offset: String(boundaries.min),
    max_sort_at: maxAt,
    max_file_id: FILE_ID,
    max_byte_offset: String(boundaries.max),
    boundary_at: minAt,
    boundary_file: FILE_ID,
    boundary_offset: String(boundaries.min),
  };
}

function installDatabase(blocks) {
  const snapshots = [];
  sequelize.transaction = jest.fn((options, callback) => callback(TRANSACTION));
  sequelize.query = jest.fn((sql, options) => {
    if (sql.startsWith('SET ')) return [];
    snapshots.push({ sql, options });
    if (snapshots.length > 1000) throw new Error('测试模拟分页未收敛');
    const day = options.replacements.date;
    if (isMetadataQuery(sql)) {
      const orderBy = sql.match(/ORDER BY [\s\S]*?LIMIT/)?.[0] || '';
      const desc = /ORDER BY [\s\S]* DESC/.test(orderBy);
      const afterAt = options.replacements.afterAt;
      const anchorAt = sql.includes(':anchorAt::timestamptz')
        ? options.replacements.anchorAt
        : null;
      return blocks
        .filter(block => block.business_date === day)
        .filter(
          block =>
            !options.replacements.accountValue ||
            block.account_number === options.replacements.accountValue
        )
        .filter(
          block => !afterAt || (desc ? block.boundary_at < afterAt : block.boundary_at > afterAt)
        )
        .filter(
          block => !anchorAt || (desc ? block.boundary_at < anchorAt : block.boundary_at > anchorAt)
        )
        .sort((a, b) => a.boundary_at.localeCompare(b.boundary_at) * (desc ? -1 : 1))
        .slice(0, Number(sql.match(/LIMIT (\d+)/)?.[1] || 64))
        .map(block => ({
          business_date: block.business_date,
          id: block.id,
          boundary_at: block.boundary_at,
          boundary_file: block.boundary_file,
          boundary_offset: block.boundary_offset,
          candidate_min_at: block.min_sort_at,
          candidate_min_file: block.min_file_id,
          candidate_min_offset: block.min_byte_offset,
          candidate_max_at: block.max_sort_at,
          candidate_max_file: block.max_file_id,
          candidate_max_offset: block.max_byte_offset,
        }));
    }
    if (sql.startsWith('SELECT b.* FROM monitor_log_blocks b WHERE')) {
      const ids = options.replacements.payloadIds.map(String);
      const mask = options.replacements.mask;
      return blocks.filter(
        block =>
          ids.includes(String(block.id)) &&
          [...mask].every((bit, index) => bit !== '1' || block.signature[index] === '1')
      );
    }
    const orderBy = sql.match(/ORDER BY [\s\S]*?LIMIT/)?.[0] || '';
    const desc = /ORDER BY [\s\S]* DESC/.test(orderBy);
    const anchorAt = options.replacements.anchorAt;
    return blocks
      .filter(block => block.business_date === day)
      .filter(
        block => !anchorAt || (desc ? block.boundary_at < anchorAt : block.boundary_at > anchorAt)
      )
      .sort((a, b) => a.boundary_at.localeCompare(b.boundary_at) * (desc ? -1 : 1))
      .slice(0, Number(sql.match(/LIMIT (\d+)/)?.[1] || 64));
  });
  return snapshots;
}

describe('monitorLogBlockStore 跨日范围查询', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each([
    ['ASC', '2026-10-16', '2026-10-19', ['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19']],
    ['DESC', '2026-10-16', '2026-10-19', ['2026-10-19', '2026-10-18', '2026-10-17', '2026-10-16']],
  ])(
    '%s 按日期方向跨过空日，并在单一只读快照事务中执行',
    async (direction, startDate, endDate, expectedDays) => {
      const blocks = [
        makeBlock('2026-10-16', 1, '超限 一'),
        makeBlock('2026-10-18', 2, '超限 二'),
        makeBlock('2026-10-19', 3, '超限 三'),
      ];
      const snapshots = installDatabase(blocks);
      const rows = await store.select(
        { deviceId: DEVICE_ID, localId: LOCAL_ID, startDate, endDate, keyword: '超限' },
        null,
        direction,
        10
      );

      expect(rows.map(row => row.businessDate)).toEqual(
        direction === 'ASC'
          ? ['2026-10-16', '2026-10-18', '2026-10-19']
          : ['2026-10-19', '2026-10-18', '2026-10-16']
      );
      expect(
        snapshots
          .filter(item => isMetadataQuery(item.sql))
          .map(item => item.options.replacements.date)
      ).toEqual(expectedDays);
      expect(sequelize.transaction).toHaveBeenCalledWith(
        { isolationLevel: 'REPEATABLE READ' },
        expect.any(Function)
      );
      expect(sequelize.query.mock.calls[0][0]).toContain('SET TRANSACTION READ ONLY');
      expect(snapshots.every(item => item.options.transaction === TRANSACTION)).toBe(true);
    }
  );

  test('从 anchor.businessDate 续页，首日应用锚点且其后日期不再应用锚点', async () => {
    const snapshots = installDatabase([
      makeBlock('2026-10-16', 1, '旧记录'),
      makeBlock('2026-10-17', 2, '后续记录'),
      makeBlock('2026-10-18', 3, '再后续'),
    ]);
    const anchor = {
      businessDate: '2026-10-17',
      sortAt: new Date('2026-10-17T00:02:00+08:00').toISOString(),
      fileId: FILE_ID,
      byteOffset: '2',
    };
    const rows = await store.select(
      {
        deviceId: DEVICE_ID,
        localId: LOCAL_ID,
        startDate: '2026-10-16',
        endDate: '2026-10-18',
        keyword: '续',
      },
      anchor,
      'ASC',
      10
    );

    expect(rows.map(row => row.businessDate)).toEqual(['2026-10-18']);
    expect(
      snapshots
        .filter(item => isMetadataQuery(item.sql))
        .map(item => item.options.replacements.date)
    ).toEqual(['2026-10-17', '2026-10-18']);
    expect(snapshots[0].sql).not.toContain(':anchorAt::timestamptz');
  });

  test('limit 只传递剩余额度并在足额后早停', async () => {
    const snapshots = installDatabase([
      makeBlock('2026-10-16', 1, '一'),
      makeBlock('2026-10-16', 2, '二'),
      makeBlock('2026-10-17', 3, '三'),
    ]);
    const rows = await store.select(
      { deviceId: DEVICE_ID, localId: LOCAL_ID, startDate: '2026-10-16', endDate: '2026-10-19' },
      null,
      'ASC',
      2
    );

    expect(rows).toHaveLength(2);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].options.replacements.date).toBe('2026-10-16');
  });

  test('保留起止时刻、账号与关键词的逐行过滤', async () => {
    const snapshots = installDatabase([
      makeBlock('2026-10-16', 0, '超限开始前', { accountNumber: 'acct-1' }),
      makeBlock('2026-10-16', 1, '超限命中', { accountNumber: 'acct-1' }),
      makeBlock('2026-10-16', 2, '超限结束后', { accountNumber: 'acct-1' }),
      makeBlock('2026-10-16', 3, '超限其他账号', { accountNumber: 'acct-2' }),
      makeBlock('2026-10-16', 4, '其他关键词', { accountNumber: 'acct-1' }),
    ]);
    const rows = await store.select(
      {
        deviceId: DEVICE_ID,
        localId: LOCAL_ID,
        startDate: '2026-10-16',
        endDate: '2026-10-16',
        startAt: '2026-10-16T00:01:00',
        endAt: '2026-10-16T00:01:00',
        account: 'acct-1',
        keyword: '超限',
      },
      null,
      'ASC',
      10
    );

    expect(rows.map(row => row.message)).toEqual(['超限命中']);
    expect(snapshots[0].options.replacements).toMatchObject({
      date: '2026-10-16',
      accountValue: 'acct-1',
    });
    expect(snapshots[0].sql).toContain('FROM monitor_log_block_accounts a');
    expect(snapshots[0].sql).toContain('a.device_id=:deviceId');
    expect(snapshots[0].sql).not.toContain('signature');
    expect(snapshots[1].sql).toContain('signature');
    expect(snapshots[0].sql).not.toContain('payload');
    expect(sequelize.query).toHaveBeenCalledWith("SET LOCAL enable_sort='off'", {
      transaction: TRANSACTION,
    });
  });

  test('单日查询保持旧调用方式，且查询失败原样传播', async () => {
    const snapshots = installDatabase([makeBlock('2026-10-16', 1, '兼容')]);
    await expect(
      store.select({ deviceId: DEVICE_ID, localId: LOCAL_ID, date: '2026-10-16' })
    ).resolves.toHaveLength(1);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].options.replacements.date).toBe('2026-10-16');

    const failure = Object.assign(new Error('database failure'), {
      original: { code: '57014' },
    });
    sequelize.query
      .mockImplementationOnce(() => [])
      .mockImplementationOnce(() => {
        throw failure;
      });
    await expect(
      store.select({ deviceId: DEVICE_ID, localId: LOCAL_ID, date: '2026-10-16' })
    ).rejects.toBe(failure);
    expect(logger.warn).toHaveBeenCalledWith('压缩日志操作失败', { errorCode: '57014' });
    expect(logger.warn.mock.calls.flat().join(' ')).not.toContain('database failure');
  });

  test('拒绝反向日期范围及范围外锚点，且不启动逐日查询', async () => {
    const snapshots = installDatabase([]);
    const query = {
      deviceId: DEVICE_ID,
      localId: LOCAL_ID,
      startDate: '2026-10-18',
      endDate: '2026-10-16',
    };
    await expect(store.select(query)).rejects.toThrow('日志查询内部日期范围无效');
    await expect(
      store.select(
        { ...query, startDate: '2026-10-16', endDate: '2026-10-18' },
        { businessDate: '2026-10-19' }
      )
    ).rejects.toThrow('日志查询内部锚点无效');
    expect(snapshots).toHaveLength(0);
  });

  test('64 个关键词未命中元数据后继续推进，并从下一页返回命中块', async () => {
    const blocks = Array.from({ length: 64 }, (_, index) =>
      makeBlock('2026-10-16', index, '其他内容', { keywordMatch: false })
    );
    blocks.push(makeBlock('2026-10-16', 64, '目标关键词'));
    const snapshots = installDatabase(blocks);
    const rows = await store.select(
      {
        deviceId: DEVICE_ID,
        localId: LOCAL_ID,
        startDate: '2026-10-16',
        endDate: '2026-10-16',
        keyword: '目标',
      },
      null,
      'ASC',
      1
    );

    expect(rows.map(row => row.message)).toEqual(['目标关键词']);
    const metadataQueries = snapshots.filter(item => isMetadataQuery(item.sql));
    const payloadQueries = snapshots.filter(item => item.sql.startsWith('SELECT b.*'));
    expect(metadataQueries).toHaveLength(2);
    expect(payloadQueries).toHaveLength(2);
    expect(metadataQueries[1].options.replacements.afterAt).toBe(blocks[63].boundary_at);
    expect(metadataQueries.every(item => !item.sql.includes('payload'))).toBe(true);
    expect(payloadQueries[0].sql).toContain('signature');
    expect(payloadQueries[0].options.replacements.payloadIds).toHaveLength(64);
  });

  test('零关键词候选时仍按完整元数据页推进直到范围结束', async () => {
    const blocks = Array.from({ length: 130 }, (_, index) =>
      makeBlock('2026-10-16', index, '无目标内容', { keywordMatch: false })
    );
    const snapshots = installDatabase(blocks);
    const rows = await store.select(
      {
        deviceId: DEVICE_ID,
        localId: LOCAL_ID,
        startDate: '2026-10-16',
        endDate: '2026-10-16',
        keyword: '目标',
      },
      null,
      'ASC',
      10
    );

    expect(rows).toEqual([]);
    expect(snapshots.filter(item => isMetadataQuery(item.sql))).toHaveLength(3);
    expect(snapshots.filter(item => item.sql.startsWith('SELECT b.*'))).toHaveLength(3);
  });

  test('保留重叠块排序：读取边界仍覆盖第 limit 条结果的块', async () => {
    const blocks = [
      makeMultiBlock('2026-10-16', 1, { min: 1, max: 7 }, [
        { minute: 1, message: '普通行' },
        { minute: 5, message: '目标 A' },
      ]),
      makeMultiBlock('2026-10-16', 2, { min: 3, max: 4 }, [
        { minute: 3, message: '普通行' },
        { minute: 4, message: '目标 B' },
      ]),
      makeBlock('2026-10-16', 8, '目标 C'),
    ];
    const snapshots = installDatabase(blocks);
    const rows = await store.select(
      {
        deviceId: DEVICE_ID,
        localId: LOCAL_ID,
        startDate: '2026-10-16',
        endDate: '2026-10-16',
        keyword: '目标',
      },
      null,
      'ASC',
      1
    );

    expect(rows.map(row => row.message)).toEqual(['目标 B']);
    expect(snapshots.filter(item => isMetadataQuery(item.sql))).toHaveLength(1);
    expect(
      snapshots.filter(item => item.sql.startsWith('SELECT b.*'))[0].options.replacements.payloadIds
    ).toHaveLength(3);
  });
});
