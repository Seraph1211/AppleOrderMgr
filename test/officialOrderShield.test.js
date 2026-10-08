const crypto = require('crypto');
const { performance } = require('perf_hooks');
const {
  parseShieldChallenge,
  solveShieldChallenge,
  inspectShieldCookie,
} = require('../src/services/officialOrderShield');

jest.mock('perf_hooks', () => ({ performance: { now: jest.fn(() => 0) } }));

function hashBody(candidate = 4, overrides = {}) {
  const algorithm = overrides.algorithm || 'SHA256';
  const salt = overrides.salt === undefined ? '合成盐值' : overrides.salt;
  return JSON.stringify({
    algorithm,
    salt,
    challenge: crypto
      .createHash(algorithm.replace('-', '').toLowerCase())
      .update(`${salt}${candidate}`, 'utf8')
      .digest('hex'),
    timeout: 15000,
    ...overrides,
  });
}

function factorBody(overrides = {}) {
  return JSON.stringify({ low: 2, high: 8, parts: 3, result: '120', timeout: 15000, ...overrides });
}

beforeEach(() => {
  performance.now.mockReset().mockReturnValue(0);
});

describe('Shld JSON 解析与类型分派', () => {
  test('使用 JSON 属性分派，空白格式不影响；不复制未复原的提交字段', () => {
    const source = JSON.parse(hashBody());
    source.flagskv = { patSkip: true };
    source.jsa = 'unverified';
    const model = parseShieldChallenge(JSON.stringify(source, null, 2));
    expect(model).toMatchObject({ type: 'hash', algorithm: 'sha256', timeoutMs: 15000 });
    expect(model).not.toHaveProperty('flagskv');
    expect(model).not.toHaveProperty('jsa');
    expect(Object.isFrozen(model)).toBe(true);
  });

  test.each([null, {}, [], '', '{', 'null', '[]', 'true', '"algorithm"', ' '.repeat(16385)])(
    '拒绝非 JSON 对象或超长正文 %#',
    body => {
      expect(() => parseShieldChallenge(body)).toThrow(/^SHIELD_/);
    }
  );

  test.each(['MD5', 'SHA1', 'SHA256 ', '', 256, null, {}, ['SHA256']])(
    '不支持的算法 fail closed：%p',
    algorithm => {
      const model = JSON.parse(hashBody());
      model.algorithm = algorithm;
      expect(() => parseShieldChallenge(JSON.stringify(model))).toThrow(
        'SHIELD_ALGORITHM_UNSUPPORTED'
      );
    }
  );

  test.each([
    { challenge: 'bad' },
    { challenge: 'A'.repeat(64) },
    { challenge: 123 },
    { salt: null },
    { salt: '中'.repeat(342) },
  ])('哈希字段类型、编码长度和摘要长度严格校验 %#', overrides => {
    const model = { ...JSON.parse(hashBody()), ...overrides };
    expect(() => parseShieldChallenge(JSON.stringify(model))).toThrow('SHIELD_HASH_INPUT_INVALID');
  });

  test.each([
    { algorithm: 'SHA256', low: 1 },
    { low: 1, high: 9, parts: 2, result: '9', salt: 'unexpected' },
    { challenge: 'algorithm is absent' },
  ])('混合类型和半份模型不降级成另一种算法：%p', model => {
    expect(() => parseShieldChallenge(JSON.stringify(model))).toThrow('SHIELD_TYPE_AMBIGUOUS');
  });

  test('正整数因数闭区间模型可序列化，Int64 目标保持十进制字符串', () => {
    const model = parseShieldChallenge(factorBody({ result: '9223372036854775807' }));
    expect(model).toEqual({
      type: 'factor',
      low: 2,
      high: 8,
      parts: 3,
      result: '9223372036854775807',
      timeoutMs: 15000,
    });
    expect(JSON.parse(JSON.stringify(model)).result).toBe('9223372036854775807');
  });

  test.each([
    { low: 0 },
    { low: -1 },
    { low: 1.5 },
    { low: '2' },
    { high: 1 },
    { high: Number.MAX_SAFE_INTEGER + 1 },
    { parts: 0 },
    { parts: 9 },
    { parts: '3' },
    { result: 120 },
    { result: '0' },
    { result: '-120' },
    { result: '0120' },
    { result: '1e2' },
    { result: '9223372036854775808' },
    { result: '9'.repeat(100) },
    { low: undefined },
  ])('拒绝非法因数范围、数量和溢出目标：%p', overrides => {
    expect(() => parseShieldChallenge(factorBody(overrides))).toThrow(
      'SHIELD_FACTOR_INPUT_INVALID'
    );
  });

  test('服务器超长 timeout 受本地硬上限限制；零和缺省使用有限默认值', () => {
    for (const timeout of [0, undefined, 1000000]) {
      expect(parseShieldChallenge(factorBody({ timeout })).timeoutMs).toBe(15000);
    }
    expect(parseShieldChallenge(factorBody({ timeout: 1 })).timeoutMs).toBe(1);
  });

  test.each([-1, '1', null, 1.5, Number.MAX_SAFE_INTEGER + 1])('非法 timeout：%p', timeout => {
    expect(() => parseShieldChallenge(factorBody({ timeout }))).toThrow('SHIELD_TIMEOUT_INVALID');
  });
});

describe('有界离线计算', () => {
  test.each(['SHA256', 'sha-384', 'SHA512'])('按 UTF-8 salt + 数字求解 %s', algorithm => {
    const result = solveShieldChallenge(hashBody(4, { algorithm }));
    expect(result).toEqual({
      type: 'hash',
      found: true,
      number: 4,
      took: 0,
      operations: 5,
      reason: 'FOUND',
      serverAccepted: null,
    });
  });

  test('候选 0 是有效答案，空盐也保留原始拼接语义', () => {
    expect(solveShieldChallenge(hashBody(0, { salt: '' }))).toMatchObject({
      found: true,
      number: 0,
    });
  });

  test('操作上限包含精确最后一次计算，超限不返回未找到的候选', () => {
    expect(solveShieldChallenge(hashBody(4), { maxOperations: 5 }).found).toBe(true);
    expect(solveShieldChallenge(hashBody(4), { maxOperations: 4 })).toMatchObject({
      found: false,
      number: null,
      operations: 4,
      reason: 'OPERATION_LIMIT',
      serverAccepted: null,
    });
  });

  test('开始计算前已到期，不尝试候选', () => {
    performance.now.mockReturnValueOnce(0).mockReturnValue(1);
    expect(solveShieldChallenge(hashBody(0), { maxDurationMs: 1 })).toMatchObject({
      found: false,
      number: null,
      operations: 0,
      reason: 'TIMEOUT',
    });
  });

  test('最后一次运算才到期，即使匹配也不能交付过期答案', () => {
    performance.now.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(10);
    expect(solveShieldChallenge(hashBody(0, { timeout: 10 }))).toMatchObject({
      found: false,
      number: null,
      operations: 1,
      reason: 'TIMEOUT',
    });
  });

  test('因数闭区间包含两端、允许重复，单因数不引入浮点误差', () => {
    expect(solveShieldChallenge(factorBody({ parts: 2, result: '16' }))).toMatchObject({
      found: true,
      number: [2, 8],
    });
    expect(solveShieldChallenge(factorBody({ low: 8, parts: 3, result: '512' }))).toMatchObject({
      found: true,
      number: [8, 8, 8],
    });
    expect(solveShieldChallenge(factorBody({ parts: 1, result: '8' }))).toMatchObject({
      found: true,
      number: [8],
    });
  });

  test('超过 Number 安全整数的目标使用 BigInt 仍可正确求解', () => {
    const result = solveShieldChallenge(
      factorBody({ low: 100000000, high: 100000000, parts: 2, result: '10000000000000000' })
    );
    expect(result).toMatchObject({ found: true, number: [100000000, 100000000] });
    expect(result.number.reduce((product, value) => product * BigInt(value), 1n)).toBe(
      10000000000000000n
    );
  });

  test('接近 Int64 上界的不可解目标不会被浮点舍入成解', () => {
    expect(
      solveShieldChallenge(
        factorBody({ low: 3037000499, high: 3037000500, parts: 2, result: '9223372036854775807' })
      )
    ).toMatchObject({ found: false, number: null, reason: 'NOT_FOUND' });
  });

  test.each(['1', '7', '511', '513'])('因数无解保留明确结果：%s', result => {
    expect(solveShieldChallenge(factorBody({ result }))).toMatchObject({
      found: false,
      number: null,
      reason: 'NOT_FOUND',
    });
  });

  test('完整深度上限八层和每层操作预算均生效', () => {
    const body = factorBody({ low: 1, high: 1, parts: 8, result: '1' });
    expect(solveShieldChallenge(body)).toMatchObject({ found: true, number: Array(8).fill(1) });
    expect(solveShieldChallenge(body, { maxDepth: 7 })).toMatchObject({
      found: false,
      number: null,
      operations: 0,
      reason: 'DEPTH_LIMIT',
    });
    expect(solveShieldChallenge(body, { maxOperations: 3 })).toMatchObject({
      found: false,
      number: null,
      operations: 3,
      reason: 'OPERATION_LIMIT',
    });
  });

  test('递归中间检查超时，而不只在最外层检查', () => {
    let time = 0;
    performance.now.mockImplementation(() => time++);
    expect(
      solveShieldChallenge(factorBody({ low: 1, high: 100, parts: 8, result: '120', timeout: 5 }))
    ).toMatchObject({ found: false, number: null, reason: 'TIMEOUT' });
  });

  test('较宽范围同样服从全树操作预算', () => {
    const result = solveShieldChallenge(
      factorBody({ low: 2, high: 1000000000, parts: 2, result: '999999937' }),
      { maxOperations: 20 }
    );
    expect(result).toMatchObject({ found: false, operations: 20, reason: 'OPERATION_LIMIT' });
  });

  test('独立穷举小范围乘积核验剪枝不会遗漏解，返回的每个因数都满足约束', () => {
    const products = new Set();
    for (let first = 1; first <= 5; first += 1)
      for (let second = 1; second <= 5; second += 1)
        for (let third = 1; third <= 5; third += 1) products.add(first * second * third);
    for (let target = 1; target <= 125; target += 1) {
      const result = solveShieldChallenge(factorBody({ low: 1, high: 5, result: String(target) }));
      expect(result.found).toBe(products.has(target));
      if (result.found) {
        expect(result.number).toHaveLength(3);
        expect(result.number.every(value => value >= 1 && value <= 5)).toBe(true);
        expect(result.number.reduce((product, value) => product * value, 1)).toBe(target);
      }
    }
  });

  test.each([
    null,
    [],
    { maxDurationMs: 0 },
    { maxDurationMs: 15001 },
    { maxDurationMs: '1' },
    { maxOperations: 0 },
    { maxOperations: 1000001 },
    { maxDepth: 9 },
    { maxDepth: 1.5 },
    { timeout: 1000 },
  ])('调用者不能扩大或绕过本地硬预算：%p', options => {
    expect(() => solveShieldChallenge(hashBody(), options)).toThrow('SHIELD_BUDGET_INVALID');
  });
});

describe('Cookie 仅做本地到期校验', () => {
  const now = 2000000;
  const cookie = { name: 'shld_bt_ck', value: 'opaque|3000|signature', expires: -1 };

  test('本地有效不等于服务端签名通过，也不依赖任意长度门槛', () => {
    expect(inspectShieldCookie(cookie, now)).toEqual({
      valid: true,
      expiresAt: 3000000,
      reason: 'LOCALLY_VALID',
      serverAccepted: null,
    });
    expect(inspectShieldCookie({ ...cookie, expires: undefined }, now).valid).toBe(true);
  });

  test('到期边界立即失效，浏览器到期时间与内嵌到期时间取更早值', () => {
    expect(inspectShieldCookie(cookie, 3000000).reason).toBe('COOKIE_EXPIRED');
    expect(inspectShieldCookie({ ...cookie, expires: 2000 }, now)).toMatchObject({
      valid: false,
      expiresAt: now,
      reason: 'COOKIE_EXPIRED',
    });
    expect(inspectShieldCookie({ ...cookie, expires: 5000 }, now).expiresAt).toBe(3000000);
    expect(inspectShieldCookie({ ...cookie, expires: 0 }, now).valid).toBe(false);
    expect(inspectShieldCookie({ ...cookie, expires: 2000.123456 }, now).expiresAt).toBe(2000123);
  });

  test.each([
    undefined,
    { name: 'other', value: cookie.value },
    { name: 'shld_bt_ck' },
    { ...cookie, value: null },
    { ...cookie, value: 'a|3000' },
    { ...cookie, value: 'a|3000|' },
    { ...cookie, value: 'a|3e3|b' },
    { ...cookie, value: 'a|03000|b' },
    { ...cookie, value: 'a|-3000|b' },
    { ...cookie, value: 'a|9999999999999|b' },
    { ...cookie, value: 'a'.repeat(4097) },
    { ...cookie, expires: '3000' },
    { ...cookie, expires: Infinity },
    { ...cookie, expires: -2 },
    { ...cookie, expires: 9999999999999 },
  ])('缺失、格式错误和溢出 Cookie 不能继续 %#', value => {
    expect(inspectShieldCookie(value, now)).toMatchObject({
      valid: false,
      expiresAt: null,
      serverAccepted: null,
    });
  });

  test.each([null, -1, Infinity, NaN, 1.1, 8640000000000001])('拒绝非法本地时间：%p', time => {
    expect(() => inspectShieldCookie(cookie, time)).toThrow('SHIELD_TIME_INVALID');
  });
});
