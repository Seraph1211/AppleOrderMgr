const { createHash } = require('crypto');
const { repeatLimits, repeatQuery } = require('../src/services/monitorLogRepeatFilter');

const key = points => createHash('sha256').update(JSON.stringify(points)).digest('hex');
const normalized = value => Buffer.from(value, 'utf8').toString('utf8');

// 独立穷举oracle：直接判断整词能否由短unit完整重复，不复用生产归一化方法。
function oracle(keyword) {
  const points = Array.from(keyword, point => point.codePointAt(0));
  if (points.length > 200) return null;
  for (let size = 1; size <= 8 && size * 4 <= points.length; size++) {
    if (points.length % size) continue;
    const unit = points.slice(0, size);
    if (!points.every((point, index) => point === unit[index % size])) continue;
    const rotations = Array.from({ length: size }, (_, start) => [
      ...unit.slice(start),
      ...unit.slice(0, start),
    ]);
    rotations.sort((left, right) => {
      for (let index = 0; index < size; index++) {
        if (left[index] !== right[index]) return left[index] - right[index];
      }
      return 0;
    });
    return { key: key(rotations[0]), repeats: points.length / size };
  }
  return null;
}

function assertAllSubstrings(message, metadata) {
  let checked = 0;
  let eligible = 0;
  // 包含UTF16半surrogate边界的所有真实String.slice子串，匹配原includes语义。
  for (let start = 0; start < message.length; start++) {
    for (let end = start + 1; end <= message.length; end++) {
      const keyword = message.slice(start, end);
      const query = repeatQuery(keyword);
      checked++;
      if (!query) continue;
      eligible++;
      if (metadata !== null && !(metadata[query.key] >= query.repeats))
        throw new Error(`重复必要条件漏检:${start}:${end}:${query.repeats}`);
    }
  }
  return { checked, eligible };
}

describe('Unicode完整重复周期必要条件', () => {
  test('只启用最小短周期的完整四次以上重复，不截取前缀或尾巴', () => {
    for (const word of ['a', 'ab', 'abc', 'abcdefg', 'abcdefgh', '🙂', 'a\u0301', '\r\n']) {
      const keyword = word.repeat(4);
      expect(repeatQuery(keyword)).toEqual(oracle(keyword));
      expect(repeatQuery(word.repeat(3))).toBeNull();
      expect(repeatQuery(`前${keyword}`)).toBeNull();
      expect(repeatQuery(`${keyword}尾`)).toBeNull();
    }
    expect(repeatQuery('abcdefghi'.repeat(4))).toBeNull();
    expect(repeatQuery('ab'.repeat(4) + 'a')).toBeNull();
    expect(repeatQuery('')).toBeNull();
    expect(repeatQuery(null)).toBeNull();
    expect(repeatQuery({})).toBeNull();
    expect(repeatQuery('a'.repeat(200))).toEqual({ key: key([97]), repeats: 200 });
    expect(repeatQuery('a'.repeat(201))).toBeNull();
  });

  test('primitive及旋转归一化按codepoint数值顺序，不用UTF16 lexical或NFC折叠', () => {
    expect(repeatQuery('abab'.repeat(4))).toEqual({ key: key([97, 98]), repeats: 8 });
    expect(repeatQuery('ba'.repeat(8))).toEqual(repeatQuery('ab'.repeat(8)));
    expect(repeatQuery('😀\uE000'.repeat(4))).toEqual({
      key: key([57344, 128512]),
      repeats: 4,
    });
    expect(repeatQuery('e\u0301'.repeat(4)).key).not.toBe(repeatQuery('é'.repeat(4)).key);
    expect(repeatQuery('AB'.repeat(4)).key).not.toBe(repeatQuery('ab'.repeat(4)).key);
    expect(JSON.parse(JSON.stringify(repeatLimits(['ab'.repeat(8)])))).toEqual({
      [key([97, 98])]: 8,
    });
  });

  test('距离p的最大equal-run保留前p点，捕获跨run边界及所有重叠', () => {
    const message = 'a'.repeat(16) + 'b' + 'ab'.repeat(9);
    const limits = repeatLimits([message]);
    expect(limits[key([97])]).toBe(16);
    expect(limits[key([97, 98])]).toBe(10);
    expect(assertAllSubstrings(message, limits).eligible).toBeGreaterThan(0);
    for (const unit of [
      'abc',
      'abcd',
      'abcde',
      'abcdef',
      'abcdefg',
      'abcdefgh',
      '🙂🚀',
      'a\u0301',
    ]) {
      const mixed = normalized('X' + unit.repeat(6) + unit.slice(0, 1) + 'Y');
      expect(repeatLimits([mixed])[repeatQuery(unit.repeat(6)).key]).toBeGreaterThanOrEqual(6);
      assertAllSubstrings(mixed, repeatLimits([mixed]));
    }
  });

  test('run结尾、片段边界和真实重复消息：逐条取最大，不跨消息凑四次', () => {
    expect(repeatLimits([])).toEqual({});
    expect(repeatLimits(['abc', 'ab'.repeat(3), 'ab'.repeat(3)])).toEqual({});
    expect(repeatLimits(['aaa', 'aaa', ''])).toEqual({});
    expect(repeatLimits(['ab'.repeat(7), 'ba'.repeat(9), 'ab'.repeat(7)])).toEqual({
      [key([97, 98])]: 9,
    });
    expect(repeatLimits(['z'.repeat(300000)])[key([122])]).toBe(300000);
  });

  test('随机规范化Unicode全部真实子串：可选条件始终不漏，查询与独立oracle一致', () => {
    const alphabet = Array.from('ab012中é🙂🚀\u0301%_\\\r\n\uD800');
    let seed = 314159265;
    const pick = maximum => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % maximum;
    };
    let checked = 0;
    let eligible = 0;
    for (let row = 0; row < 1000; row++) {
      const unit = Array.from({ length: 1 + pick(8) }, () => alphabet[pick(alphabet.length)]).join(
        ''
      );
      const prefix = Array.from({ length: pick(10) }, () => alphabet[pick(alphabet.length)]).join(
        ''
      );
      const suffix = Array.from({ length: pick(10) }, () => alphabet[pick(alphabet.length)]).join(
        ''
      );
      const message = normalized(prefix + unit.repeat(4 + pick(8)) + suffix);
      const metadata = repeatLimits([message]);
      expect(metadata).not.toBeNull();
      const result = assertAllSubstrings(message, metadata);
      checked += result.checked;
      eligible += result.eligible;
      for (let sample = 0; sample < 20; sample++) {
        const start = pick(message.length);
        const keyword = message.slice(start, start + 1 + pick(message.length - start));
        expect(repeatQuery(keyword)).toEqual(oracle(keyword));
      }
    }
    expect(checked).toBeGreaterThan(500000);
    expect(eligible).toBeGreaterThan(10000);
    process.stdout.write(
      JSON.stringify({
        kind: 'repeat-filter-unicode-property',
        messages: 1000,
        checked,
        eligible,
      }) + '\n'
    );
  }, 30000);

  test('穷举二元正文及其全部子串，不依赖随机选择周期', () => {
    let eligible = 0;
    let checked = 0;
    for (let length = 1; length <= 12; length++) {
      for (let bits = 0; bits < 2 ** length; bits++) {
        const message = Array.from({ length }, (_, index) =>
          bits & (1 << index) ? 'a' : 'b'
        ).join('');
        const result = assertAllSubstrings(message, repeatLimits([message]));
        eligible += result.eligible;
        checked += result.checked;
      }
    }
    expect(eligible).toBeGreaterThan(10000);
    process.stdout.write(
      JSON.stringify({ kind: 'repeat-filter-exhaustive-property', checked, eligible }) + '\n'
    );
  });

  test('256key及2048cycle-cache有界，超限返回null而不是部分map', () => {
    const messages = Array.from({ length: 256 }, (_, index) =>
      String.fromCodePoint(4096 + index).repeat(4)
    );
    expect(Object.keys(repeatLimits(messages))).toHaveLength(256);
    expect(repeatLimits([...messages, String.fromCodePoint(4352).repeat(4)])).toBeNull();
    expect(repeatLimits([...messages, String.fromCodePoint(4352).repeat(4) + 'x'])).toBeNull();
    const fullCache = messages.map(message => message.repeat(8));
    expect(Object.keys(repeatLimits(fullCache))).toHaveLength(256);
    expect(Object.keys(repeatLimits([...fullCache, fullCache[0]]))).toHaveLength(256);
    expect(repeatLimits([...fullCache, String.fromCodePoint(4352).repeat(32)])).toBeNull();
  });

  test('先计数再分配：4MiB ASCII及累计点超限安全fallback，精确4MiB emoji支持', () => {
    const allocation = jest.spyOn(global, 'Uint32Array');
    try {
      expect(repeatLimits(['a'.repeat(4 * 1024 * 1024)])).toBeNull();
      expect(allocation).not.toHaveBeenCalled();
    } finally {
      allocation.mockRestore();
    }
    const emoji = '🙂'.repeat(1048576);
    expect(Buffer.byteLength(emoji)).toBe(4 * 1024 * 1024);
    expect(repeatLimits([emoji])).toEqual({ [key([128578])]: 1048576 });
    expect(repeatLimits(['a'.repeat(524288), 'b'.repeat(524288)])).toEqual({
      [key([97])]: 524288,
      [key([98])]: 524288,
    });
    expect(repeatLimits(['a'.repeat(524288), 'b'.repeat(524289)])).toBeNull();
    expect(repeatLimits(Array(32768).fill(''))).toEqual({});
    expect(repeatLimits(Array(32769).fill(''))).toBeNull();
  });

  test('无效输入与边界异常都安全fallback，不把失败当作完整空结果', () => {
    expect(repeatLimits(null)).toBeNull();
    expect(repeatLimits('aaaa')).toBeNull();
    expect(repeatLimits(['aaaa', null])).toBeNull();
    expect(repeatLimits(['🙂' + '\uDC42'.repeat(3)])).toBeNull();
    expect(repeatLimits(['\uD800'.repeat(4)])).toBeNull();
    expect(repeatQuery('\uDC42'.repeat(4))).toBeNull();
    expect(repeatQuery('\uD800'.repeat(4))).toBeNull();
    expect(repeatLimits([normalized('🙂' + '\uDC42'.repeat(3))])).toEqual({});
    const changedIterator = ['aaaa'];
    changedIterator[Symbol.iterator] = () => [][Symbol.iterator]();
    expect(repeatLimits(changedIterator)).toEqual({ [key([97])]: 4 });
    expect(
      repeatLimits(
        new Proxy([], {
          get(_target, name) {
            return name === 'length' ? NaN : undefined;
          },
        })
      )
    ).toBeNull();
    expect(
      repeatLimits(
        new Proxy([], {
          get(_target, name) {
            return name === 'length' ? -1 : undefined;
          },
        })
      )
    ).toBeNull();
    const hostile = new Proxy([], {
      get() {
        throw new Error('synthetic-input-failure');
      },
    });
    expect(repeatLimits(hostile)).toBeNull();
    const iterator = jest.spyOn(String.prototype, Symbol.iterator).mockImplementation(() => {
      throw new Error('synthetic-iterator-failure');
    });
    try {
      expect(repeatQuery('aaaa')).toBeNull();
      expect(repeatLimits(['aaaa'])).toBeNull();
    } finally {
      iterator.mockRestore();
    }
  });
});
