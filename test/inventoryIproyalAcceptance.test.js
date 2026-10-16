const { reserveProduction, settleProduction } = require('../src/services/inventoryGuardPolicy');
const { DEFAULT_CONFIG } = require('../src/services/inventoryPolicy');
const {
  validateTunnel,
  rotateTunnel,
  settleProviderFailure,
} = require('../src/services/inventoryTunnelPolicy');
const InventoryTunnel = require('../src/services/inventoryTunnel');
const InventoryDriver = require('../src/services/inventoryDriver');
const { targetFor, readProxy, requestOnce } = require('../src/services/inventoryValidationClient');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const NOW = Date.parse('2026-10-16T01:00:00.000Z');
const EGRESS = 'iproyal-main';
const EXIT_HASH = 'a'.repeat(64);

function verifiedState(extra = {}) {
  return {
    tunnel: {
      label: EGRESS,
      verified: true,
      expiresAt: NOW + 600000,
      exitHash: EXIT_HASH,
      rejectedHashes: [],
    },
    ...extra,
  };
}

function reserve(state, id, now = NOW, purpose = 'inventory') {
  return reserveProduction(state, now, id, 0, EGRESS, purpose, {
    ...DEFAULT_CONFIG,
    enabled: true,
  });
}

describe('IPRoyal 独立验收：原有保护边界', () => {
  test('旧供应商出口停用不拦新出口，预算累计仍保留', () => {
    const state = verifiedState({
      pausedEgress: { 'fanproxy-main': 'PROXY_CONNECT_REJECTED' },
      hour: Math.floor(NOW / 3600000),
      day: Math.floor(NOW / 86400000),
      hourCount: 17,
      dayCount: 91,
      byteCount: 12345,
      proxyCount: 9,
    });
    const claim = reserve(state, 'new-source');
    expect(claim.blocked).toBeUndefined();
    expect(claim.state).toMatchObject({
      hourCount: 18,
      dayCount: 92,
      proxyCount: 9,
      pausedEgress: state.pausedEgress,
    });
    expect(claim.state.byteCount).toBeGreaterThan(state.byteCount);
  });

  test.each([
    [{ pausedReason: 'TARGET_CHALLENGE' }, 'TARGET_CHALLENGE'],
    [{ cooldownUntil: NOW + 45000 }, 'TARGET_COOLDOWN'],
    [{ pausedEgress: { [EGRESS]: 'PROXY_AUTH_FAILED' } }, 'PROXY_AUTH_FAILED'],
  ])('新供应商不绕过全局和本来源保护 %j', (extra, outcome) => {
    expect(reserve(verifiedState(extra), 'blocked').blocked).toBe(outcome);
  });

  test('541 持久化冷却和出口拒用，副本重启后仍不能请求', () => {
    const claimed = reserve(verifiedState(), 'risk').state;
    const paused = settleProduction(
      claimed,
      {
        id: 'risk',
        purpose: 'inventory',
        egress: EGRESS,
        outcome: 'TARGET_REJECTED',
        bytes: 12,
      },
      NOW + 1000
    );
    const restarted = JSON.parse(JSON.stringify(paused));
    expect(restarted.cooldownUntil).toBeGreaterThanOrEqual(NOW + 61000);
    expect(restarted.requiredAlternateEgress).toBe(EGRESS);
    expect(restarted.tunnel.rejectedHashes).toContain(EXIT_HASH);
    expect(reserve(restarted, 'retry', NOW + 2000).blocked).toBeTruthy();
    expect(restarted.hourCount).toBe(1);
    expect(restarted.dayCount).toBe(1);
  });

  test('出口核验成功不能清空 Apple 风险或当作库存恢复', () => {
    const state = verifiedState({
      recovering: true,
      recoveryEpoch: NOW - 1000,
      recoverySuccesses: 2,
      recent: [{ at: NOW - 500, risk: true, egress: EGRESS }],
    });
    const result = settleProduction(
      state,
      {
        id: 'egress',
        purpose: 'egress',
        egress: EGRESS,
        outcome: 'PROXY_CONNECTED',
      },
      NOW
    );
    expect(result.recovering).toBe(true);
    expect(result.recoverySuccesses).toBe(2);
    expect(result.recent).toEqual(state.recent);
  });

  test('恢复仍恰好需要三次有效库存请求，不要求三轮或长窗口', () => {
    let state = verifiedState({ recovering: true, recoveryEpoch: NOW - 1000 });
    for (let i = 0; i < 3; i += 1) {
      const at = NOW + i * 6000;
      const id = `valid-${i}`;
      const claim = reserve(state, id, at);
      expect(claim.blocked).toBeUndefined();
      expect(claim.waitMs).toBeUndefined();
      state = settleProduction(
        claim.state,
        {
          id,
          purpose: 'inventory',
          egress: EGRESS,
          outcome: 'INVENTORY_VALID',
          bytes: 100,
        },
        at + 100
      );
      expect(state.recovering).toBe(i < 2);
    }
  });

  test('541 前发出的迟到有效结果不计入之后恢复成功', () => {
    let state = reserve(verifiedState(), 'late', NOW).state;
    state = reserve(state, 'risk', NOW + 1200).state;
    state = settleProduction(
      state,
      {
        id: 'risk',
        purpose: 'inventory',
        egress: EGRESS,
        outcome: 'TARGET_REJECTED',
      },
      NOW + 1400
    );
    const late = settleProduction(
      state,
      {
        id: 'late',
        purpose: 'inventory',
        egress: EGRESS,
        outcome: 'INVENTORY_VALID',
      },
      NOW + 1500
    );
    expect(late.recovering).toBe(true);
    expect(late.recoverySuccesses).toBe(0);
    expect(late.cooldownUntil).toBe(state.cooldownUntil);
    expect(late.tunnel.rejectedHashes).toContain(EXIT_HASH);
  });

  test('五分钟以前的目标风险退出原窗口，不新增长窗口升级规则', () => {
    const state = verifiedState({
      recent: [{ at: NOW - 300001, risk: true, egress: 'old', exitHash: 'b'.repeat(64) }],
    });
    const result = settleProduction(
      state,
      {
        id: 'current',
        purpose: 'inventory',
        egress: EGRESS,
        outcome: 'TARGET_REJECTED',
        egressHash: EXIT_HASH,
      },
      NOW
    );
    expect(result.recent).toHaveLength(1);
    expect(result.cooldownUntil).toBe(NOW + 60000);
    expect(result.pausedReason).toBeUndefined();
  });

  test('正常三并发、恢复单并发仍受原请求间隔约束', () => {
    let normal = verifiedState();
    for (let i = 0; i < 3; i += 1) normal = reserve(normal, `normal-${i}`, NOW + i * 1100).state;
    expect(reserve(normal, 'fourth', NOW + 3300).state).toBeUndefined();
    const first = reserve(verifiedState({ recovering: true }), 'probe', NOW).state;
    expect(reserve(first, 'second-probe', NOW + 1100).state).toBeUndefined();
  });
});

describe('IPRoyal 独立验收：配置与实际出口', () => {
  const base = {
    label: EGRESS,
    url: 'http://synthetic-user:synthetic-password@geo.iproyal.com:12321',
    tunnel: { provider: 'iproyal', stickySeconds: 600 },
  };
  let directory;
  let originalProxyFile;

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-acceptance-'));
    process.env.FIELD_ENCRYPTION_KEY = 'a'.repeat(64);
    originalProxyFile = process.env.INVENTORY_PROXY_FILE;
  });
  afterAll(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    if (originalProxyFile === undefined) delete process.env.INVENTORY_PROXY_FILE;
    else process.env.INVENTORY_PROXY_FILE = originalProxyFile;
  });

  function fixture(body = {}) {
    let current = structuredClone(body);
    let now = NOW;
    const gate = {
      locked: work => Promise.resolve(work(current, now, {})),
      save: value => {
        current = value;
        return Promise.resolve();
      },
    };
    return {
      tunnel: new InventoryTunnel(gate),
      gate,
      state: () => current,
      advance: amount => {
        now += amount;
      },
      proxy: { ...base, tunnel: validateTunnel(base, base.tunnel) },
    };
  }

  test('合法配置不需要虚构套餐期限，会话只在密码增加固定参数且每次更换', () => {
    const file = path.join(directory, 'valid.json');
    fs.writeFileSync(file, JSON.stringify(base));
    expect(readProxy(file).tunnel.expiresAt).toBeNull();
    const first = new URL(rotateTunnel(base.url));
    const second = new URL(rotateTunnel(base.url));
    expect(first.username).toBe('synthetic-user');
    expect(decodeURIComponent(first.password)).toMatch(
      /^synthetic-password_country-cn_session-[a-f0-9]{8}_lifetime-10m_streaming-1_killswitch-1$/
    );
    expect(first.password).not.toBe(second.password);
    expect(first.hostname).toBe('geo.iproyal.com');
    expect(first.port).toBe('12321');
  });

  test.each([
    'http://synthetic-user:synthetic-password@127.0.0.1:12321',
    'http://synthetic-user:synthetic-password@geo.iproyal.com.evil.test:12321',
    'http://synthetic-user:synthetic-password@geo.iproyal.com:80',
    'https://synthetic-user:synthetic-password@geo.iproyal.com:12321',
    'http://synthetic-user:synthetic-password_country-us@geo.iproyal.com:12321',
    'http://synthetic-user:synthetic-password_session-old@geo.iproyal.com:12321',
    'http://synthetic-user:synthetic-password@geo.iproyal.com:12321/private',
    'http://synthetic-user:synthetic-password@geo.iproyal.com:12321/?url=localhost',
  ])('拒绝非授权入口及预拼供应商参数 %#', url => {
    const file = path.join(directory, 'invalid.json');
    fs.writeFileSync(file, JSON.stringify({ ...base, url }));
    expect(() => readProxy(file)).toThrow();
  });

  test('配置缺失时即使给出旧备用和动态来源也不发送请求', async () => {
    try {
      delete process.env.INVENTORY_PROXY_FILE;
      const gate = { reserve: jest.fn(), finish: jest.fn() };
      const driver = new InventoryDriver(gate, {
        backupFile: path.join(directory, 'old-backup.json'),
        apiFile: path.join(directory, 'old-api.json'),
      });
      expect(await driver.request('inventory', {})).toEqual({ outcome: 'NO_HEALTHY_PROXY' });
      expect(gate.reserve).not.toHaveBeenCalled();
      expect(gate.finish).not.toHaveBeenCalled();
    } catch (error) {
      throw new Error('缺失配置验收失败', { cause: error });
    }
  });

  test('实际出口 hash 重用被拒绝，不能凭新会话字符串解除541保护', async () => {
    try {
      const h = fixture({ requiredAlternateEgress: EGRESS, recovering: true });
      const claim = await h.tunnel.claim(h.proxy);
      h.state().tunnel.rejectedHashes = [EXIT_HASH];
      const result = await h.tunnel.settle(claim, {
        id: 'egress',
        outcome: 'PROXY_CONNECTED',
        summary: { egressHash: EXIT_HASH },
      });
      expect(result.proxy).toBeUndefined();
      expect(h.state().tunnel.verified).toBe(false);
      expect(h.state().recovering).toBe(true);
    } catch (error) {
      throw new Error('出口重用验收失败', { cause: error });
    }
  });

  test.each(['token', 'epoch', 'expiry'])('迟到出口核验不能覆盖 %s 变化', async kind => {
    try {
      const h = fixture();
      const claim = await h.tunnel.claim(h.proxy);
      if (kind === 'token') h.state().tunnel.token = 'new-token';
      if (kind === 'epoch') h.state().recoveryEpoch = NOW + 1;
      if (kind === 'expiry') h.advance(600001);
      const result = await h.tunnel.settle(claim, {
        id: 'late',
        outcome: 'PROXY_CONNECTED',
        summary: { egressHash: EXIT_HASH },
      });
      expect(result.proxy).toBeUndefined();
      expect(h.state().tunnel.verified).toBe(false);
    } catch (error) {
      throw new Error('迟到核验验收失败', { cause: error });
    }
  });

  test('410轮换有限且不改变 Apple 风险与三次有效请求恢复计数', () => {
    const recent = [{ at: NOW, risk: true, egress: EGRESS }];
    let state = verifiedState({ recent, recovering: true, recoverySuccesses: 2 });
    for (let i = 0; i < 3; i += 1) state = settleProviderFailure(state, NOW + i * 120000, EGRESS);
    const restarted = JSON.parse(JSON.stringify(state));
    expect(restarted.pausedEgress[EGRESS]).toBe('PROXY_RECOVERY_EXHAUSTED');
    expect(restarted.providerFailures).toBe(3);
    expect(restarted.recoverySuccesses).toBe(2);
    expect(restarted.recent).toEqual(recent);
    expect(restarted.tunnel.verified).toBe(false);
  });

  test.each([
    ['catalog', { path: '//evil.test/private' }],
    ['catalog', { path: '/retail/storelist/?target=localhost' }],
    ['inventory', { skus: ['TEST1CH/A&url=http://127.0.0.1'], location: '100000' }],
    ['inventory', { skus: ['TEST1CH/A'], location: '100000&x=1' }],
    ['http://127.0.0.1', {}],
  ])('不允许外部输入控制请求地址 %#', (purpose, context) => {
    expect(() => targetFor(purpose, context)).toThrow();
  });

  test.each([
    [410, 'PROXY_SESSION_EXPIRED', 'proxy_connect'],
    [407, 'PROXY_AUTH_FAILED', 'proxy_connect'],
    [402, 'PROXY_CONNECT_REJECTED', 'proxy_connect'],
    [500, 'PROXY_TUNNEL_UNAVAILABLE', 'proxy_connect'],
    [541, 'PROXY_CONNECT_REJECTED', 'proxy_connect'],
    [200, 'TARGET_REJECTED', 'target'],
  ])('CONNECT %d 与目标541错误来源分离且返回脱敏', async (status, outcome, source) => {
    try {
      const agent = new EventEmitter();
      agent.destroy = jest.fn();
      const gate = {
        reserve: jest.fn().mockResolvedValue({ id: 'synthetic-request' }),
        finish: jest.fn().mockResolvedValue(),
      };
      const result = await requestOnce({
        purpose: 'inventory',
        context: { skus: ['TEST1CH/A'], location: '100000' },
        proxy: base,
        gate,
        createAgent: () => Promise.resolve(agent),
        request: () => {
          agent.emit('proxyConnect', { statusCode: status });
          return Promise.resolve({ status: 541, headers: {}, data: 'synthetic-password' });
        },
      });
      expect(result).toMatchObject({ outcome, summary: { responseSource: source } });
      expect(JSON.stringify(result)).not.toMatch(/synthetic-user|synthetic-password|geo\.iproyal/);
      expect(gate.finish).toHaveBeenCalledTimes(1);
      expect(agent.destroy).toHaveBeenCalledTimes(1);
    } catch (error) {
      throw new Error('错误来源验收失败', { cause: error });
    }
  });
});
