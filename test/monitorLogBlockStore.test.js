const { createHash } = require('crypto');
const { gzipSync, gunzip } = require('zlib');
jest.mock('zlib', () => {
  const actual = jest.requireActual('zlib');
  return { ...actual, gunzip: jest.fn((...args) => actual.gunzip(...args)) };
});
jest.mock('../src/models', () => ({ sequelize: {} }));
jest.mock('../src/utils/logger', () => ({ warn: jest.fn() }));
const store = require('../src/services/monitorLogBlockStore');
const { performance } = require('perf_hooks');

function oldSignature(messages, search = false) {
  const bits = new Uint8Array(8192);
  for (const message of new Set(messages)) {
    const points = Array.from(message);
    for (const size of search ? [Math.min(3, points.length)] : [1, 2, 3]) {
      if (!size) continue;
      for (let index = 0; index <= points.length - size; index++) {
        let first = 2166136261;
        let second = 5381;
        for (const point of points.slice(index, index + size).join('')) {
          first = Math.imul(first ^ point.codePointAt(0), 16777619) >>> 0;
          second = (Math.imul(second, 33) ^ point.codePointAt(0)) >>> 0;
        }
        for (const bit of [first % 8192, second % 8192, (first + second) % 8192]) bits[bit] = 1;
      }
    }
  }
  return Array.from(bits).join('');
}

describe('压缩日志排序与块签名边界', () => {
  test('ISO与数据库Date保留毫秒；UUID及BIGINT偏移按原排序', () => {
    const base = {
      sortAt: '2026-10-07T00:00:00.001Z',
      fileId: '00000000-0000-4000-a000-000000000001',
      byteOffset: '9007199254740990',
    };
    expect(store.compare(base, { ...base, sortAt: new Date(base.sortAt) })).toBe(0);
    expect(store.compare(base, { ...base, sortAt: new Date('2026-10-07T00:00:00.002Z') })).toBe(-1);
    expect(store.compare(base, { ...base, fileId: '00000000-0000-4000-a000-000000000002' })).toBe(
      -1
    );
    expect(store.compare(base, { ...base, byteOffset: '9007199254740991' })).toBe(-1);
  });
  test('Unicode子串候选在不同字符宽度及重复正文下无漏检', () => {
    const alphabet = Array.from('abc0123中文🙂%_\\\r\n');
    const messages = Array.from({ length: 100 }, (_, row) =>
      Array.from(
        { length: 40 },
        (_, column) => alphabet[(row * 7 + column * 11) % alphabet.length]
      ).join('')
    );
    const mask = store.signature(messages);
    expect(mask).toHaveLength(8192);
    expect(store.signature([...messages, ...messages])).toEqual(mask);
    for (const message of messages) {
      const points = Array.from(message);
      for (const length of [1, 2, 3, 5, 10]) {
        const needle = points.slice(4, 4 + length).join('');
        const search = store.signature([needle], true);
        for (let bit = 0; bit < search.length; bit++)
          if (search[bit] === '1') expect(mask[bit]).toBe('1');
      }
    }
  });
  test('优化后的v1签名与旧算法随机Unicode逐位完全等价', () => {
    const alphabet = Array.from('abc0123456789中文🙂🚀%_\\\r\n\u0301𠮷');
    const messages = Array.from({ length: 1000 }, (_, row) => {
      let entropy = row + 1;
      return Array.from({ length: 80 }, () => {
        entropy = (Math.imul(entropy, 1664525) + 1013904223) >>> 0;
        return alphabet[entropy % alphabet.length];
      }).join('');
    });
    const started = performance.now();
    const oldMask = oldSignature(messages);
    const oldMs = performance.now() - started;
    const improved = performance.now();
    expect(store.signature(messages)).toBe(oldMask);
    const newMs = performance.now() - improved;
    for (const message of messages.slice(0, 50)) {
      const queryMask = store.signature([message], true);
      expect(queryMask).toBe(oldSignature([message]));
      const oldQueryMask = oldSignature([message], true);
      expect([...oldQueryMask].every((bit, index) => bit !== '1' || queryMask[index] === '1')).toBe(
        true
      );
    }
    process.stdout.write(
      JSON.stringify({ kind: 'synthetic-signature-microbenchmark', oldMs, newMs }) + '\n'
    );
  });
  test('长重复字词保留1/2字元约束，兼容已有v1签名且不跨片段拼接', () => {
    for (const keyword of ['龘'.repeat(16), 'f'.repeat(16), '🙂'.repeat(16)]) {
      const mask = store.signature([keyword], true);
      const prior = oldSignature([keyword], true);
      expect([...mask].filter(bit => bit === '1')).toHaveLength(9);
      expect([...prior].filter(bit => bit === '1')).toHaveLength(3);
      for (const short of [Array.from(keyword)[0], Array.from(keyword).slice(0, 2).join('')]) {
        const shortMask = oldSignature([short], true);
        expect([...shortMask].every((bit, index) => bit !== '1' || mask[index] === '1')).toBe(true);
      }
      const existingBlock = oldSignature([`前缀${keyword}后缀`, '真实重复行', '真实重复行']);
      expect([...mask].every((bit, index) => bit !== '1' || existingBlock[index] === '1')).toBe(
        true
      );
    }
  });
  test('解压长度、摘要、格式和片段数异常均明确拒绝', async () => {
    const raw = Buffer.from('[]');
    const block = {
      // 数据库列名保持原结构。
      /* eslint-disable camelcase */
      format_version: 1,
      codec: 'gzip',
      payload: gzipSync(raw),
      raw_bytes: raw.length,
      payload_hash: createHash('sha256').update(raw).digest(),
      entry_count: 0,
      /* eslint-enable camelcase */
    };
    for (const change of [
      /* eslint-disable camelcase */
      { format_version: 2 },
      { codec: 'unknown' },
      { raw_bytes: 5000000 },
      { raw_bytes: -1 },
      { raw_bytes: 0 },
      { raw_bytes: NaN },
      { raw_bytes: Infinity },
      { raw_bytes: raw.length + 1 },
      { payload_hash: Buffer.alloc(32) },
      { entry_count: 1 },
      /* eslint-enable camelcase */
      { payload: Buffer.from([0]) },
    ]) {
      for (const keyword of ['', '无匹配'])
        await expect(store.readBlock({ ...block, ...change }, keyword)).rejects.toMatchObject({
          statusCode: 503,
          code: 'FULL_LOG_CORRUPT',
        });
    }
  });
  test('按已保护原文长度解压；小块、精确4MiB与伪装长度的压缩bomb保留完整校验', async () => {
    const maxBytes = 4 * 1024 * 1024;
    const row = ['old-id', null, null, null, '1', 0, '0', '', null, 'parsed', null, null, null];
    const overhead = Buffer.byteLength(JSON.stringify([row]));
    row[7] = 'x'.repeat(maxBytes - overhead);
    const raw = Buffer.from(JSON.stringify([row]));
    expect(raw.length).toBe(maxBytes);
    const block = {
      /* eslint-disable camelcase */
      format_version: 1,
      codec: 'gzip',
      payload: gzipSync(raw),
      raw_bytes: raw.length,
      payload_hash: createHash('sha256').update(raw).digest(),
      entry_count: 1,
      business_date: '2026-10-07',
      /* eslint-enable camelcase */
    };
    expect((await store.readBlock(block))[0].message).toBe(row[7]);
    expect(gunzip).toHaveBeenLastCalledWith(
      block.payload,
      { maxOutputLength: maxBytes, chunkSize: maxBytes },
      expect.any(Function)
    );
    expect(
      await Promise.all(Array.from({ length: 5 }, () => store.readBlock(block, '不匹配')))
    ).toEqual([[], [], [], [], []]);
    const smallRaw = Buffer.from('[]');
    /* eslint-disable camelcase */
    expect(
      await store.readBlock({
        ...block,
        payload: gzipSync(smallRaw),
        raw_bytes: smallRaw.length,
        payload_hash: createHash('sha256').update(smallRaw).digest(),
        entry_count: 0,
      })
    ).toEqual([]);
    expect(gunzip).toHaveBeenLastCalledWith(
      expect.any(Buffer),
      { maxOutputLength: maxBytes, chunkSize: 64 * 1024 },
      expect.any(Function)
    );
    for (const keyword of ['', '不匹配']) {
      await expect(
        store.readBlock(
          { ...block, raw_bytes: 2, payload: gzipSync(Buffer.alloc(maxBytes + 1, 'x')) },
          keyword
        )
      ).rejects.toMatchObject({ statusCode: 503, code: 'FULL_LOG_CORRUPT' });
      await expect(
        store.readBlock({ ...block, payload_hash: Buffer.alloc(32) }, keyword)
      ).rejects.toMatchObject({ statusCode: 503, code: 'FULL_LOG_CORRUPT' });
      await expect(store.readBlock({ ...block, entry_count: 2 }, keyword)).rejects.toMatchObject({
        statusCode: 503,
        code: 'FULL_LOG_CORRUPT',
      });
    }
    /* eslint-enable camelcase */
  });
  test('非法原文长度在创建解压器与分配输出缓冲之前拒绝', async () => {
    for (const rawBytes of [undefined, null, -1, NaN, Infinity, '262144', 4194305]) {
      gunzip.mockClear();
      await expect(
        // Database column names are unchanged.
        // eslint-disable-next-line camelcase
        store.readBlock({ format_version: 1, codec: 'gzip', raw_bytes: rawBytes })
      ).rejects.toMatchObject({ statusCode: 503, code: 'FULL_LOG_CORRUPT' });
      expect(gunzip).not.toHaveBeenCalled();
    }
  });
});
