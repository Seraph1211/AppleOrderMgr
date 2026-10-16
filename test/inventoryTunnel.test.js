jest.mock('../src/services/inventoryValidationClient', () => ({ requestOnce: jest.fn() }));
const { createHash } = require('crypto');
const InventoryTunnel = require('../src/services/inventoryTunnel');
const { requestOnce } = require('../src/services/inventoryValidationClient');
const { validateTunnel, rotateTunnel } = require('../src/services/inventoryTunnelPolicy');
const { reserveProduction, settleProduction } = require('../src/services/inventoryGuardPolicy');
const { DEFAULT_CONFIG } = require('../src/services/inventoryPolicy');
const { decrypt } = require('../src/utils/fieldEncryption');

const NOW = Date.parse('2026-10-16T00:00:00Z');
const HASH = createHash('sha256').update('192.0.2.1').digest('hex');
const proxy = {
  label: 'iproyal-main',
  url: 'http://synthetic:private@geo.iproyal.com:12321',
  tunnel: { provider: 'iproyal', stickySeconds: 600, expiresAt: null },
};
function harness(initial = {}) {
  let state = structuredClone(initial);
  let now = NOW;
  const gate = {
    locked: jest.fn(work => Promise.resolve(work(state, now, {}))),
    save: jest.fn(next => {
      state = structuredClone(next);
      return Promise.resolve();
    }),
  };
  return {
    gate,
    tunnel: new InventoryTunnel(gate),
    state: () => state,
    at: time => {
      now = time;
    },
  };
}

describe('IPRoyal 配置与候选状态', () => {
  beforeEach(() => {
    process.env.FIELD_ENCRYPTION_KEY = 'a'.repeat(64);
    jest.clearAllMocks();
    requestOnce.mockResolvedValue({
      id: 'probe',
      outcome: 'PROXY_CONNECTED',
      summary: { egressHash: HASH },
    });
  });
  test('基础密码追加固定参数且会话为八位字母数字', () => {
    expect(validateTunnel(proxy, proxy.tunnel)).toEqual(proxy.tunnel);
    const rotated = new URL(rotateTunnel(proxy.url));
    expect(decodeURIComponent(rotated.password)).toMatch(
      /^private_country-cn_session-[a-z0-9]{8}_lifetime-10m_streaming-1_killswitch-1$/
    );
    expect(rotated.hostname).toBe('geo.iproyal.com');
    expect(rotated.username).toBe('synthetic');
    expect(rotateTunnel(proxy.url)).not.toBe(rotateTunnel(proxy.url));
  });
  test('基础密码的百分号与特殊字符不会被二次解码', () => {
    const special = new URL(
      rotateTunnel('http://synthetic:p%2540%3A%23%2F%40@geo.iproyal.com:12321')
    );
    expect(decodeURIComponent(special.password)).toMatch(/^p%40:#\/@_country-cn_session-/);
  });
  test.each([
    { url: 'http://user:pass@evil.iproyal.com:12321' },
    { url: 'https://user:pass@geo.iproyal.com:12321' },
    { url: 'http://user:pass@geo.iproyal.com:80' },
    { url: 'http://user:pass_country-us@geo.iproyal.com:12321' },
    { label: 'other' },
    { tunnel: { provider: 'fanproxy', stickySeconds: 600 } },
    { tunnel: { provider: 'iproyal', stickySeconds: 60 } },
    { tunnel: { provider: 'iproyal', stickySeconds: 600, expiresAt: '2026-10-17' } },
  ])('拒绝不受信任配置 %#', patch => {
    const candidate = { ...proxy, ...patch };
    expect(() => validateTunnel(candidate, candidate.tunnel)).toThrow('INVALID_TUNNEL_CONFIG');
  });
  test('没有套餐截止也限制十分钟，候选加密且跨进程复用', async () => {
    const h = harness({ dayCount: 12, pausedEgress: { 'yiyou-main': 'AUTH' } });
    const first = await h.tunnel.claim(proxy);
    expect(first.expiresAt).toBe(NOW + 600000);
    expect(first.packageExpiresAt).toBeNull();
    expect(first.cipher).toMatch(/^enc:/);
    expect(decrypt(first.cipher)).toMatch(/_killswitch-1/);
    expect(await h.tunnel.claim(proxy)).toEqual({
      blocked: 'REQUEST_IN_FLIGHT',
      until: NOW + 45000,
    });
    const selected = await h.tunnel.settle(first, {
      id: 'probe',
      outcome: 'PROXY_CONNECTED',
      summary: { egressHash: HASH },
    });
    expect(selected.proxy.label).toBe('iproyal-main');
    const second = new InventoryTunnel(h.gate);
    expect(await second.select(proxy)).toEqual(selected.proxy);
    expect(requestOnce).not.toHaveBeenCalled();
    expect(h.state().dayCount).toBe(12);
  });
  test('临时故障三次耗尽，不更改Apple风控或库存恢复成功', async () => {
    const h = harness({
      recovering: true,
      recoverySuccesses: 2,
      consecutiveRisks: 2,
      recent: [{ at: NOW, risk: true }],
    });
    for (let i = 0; i < 3; i += 1) {
      h.at(NOW + i * 180000);
      const claim = await h.tunnel.claim(proxy);
      const result = await h.tunnel.settle(claim, {
        id: `probe-${i}`,
        outcome: 'PROXY_TUNNEL_UNAVAILABLE',
      });
      expect(result.blocked).toBe(i === 2 ? 'PROXY_RECOVERY_EXHAUSTED' : 'PROXY_PROVIDER_COOLDOWN');
    }
    expect(h.state()).toMatchObject({
      providerFailures: 3,
      recoverySuccesses: 2,
      consecutiveRisks: 2,
    });
    expect(h.state().recent).toHaveLength(1);
    expect(h.state().recoveryFailures).toBeUndefined();
  });
  test('套餐到期和认证失败关闭请求，不触发换供应商', async () => {
    const h = harness();
    const claim = await h.tunnel.claim(proxy);
    expect(await h.tunnel.settle(claim, { id: 'probe', outcome: 'PROXY_AUTH_FAILED' })).toEqual({
      blocked: 'PROXY_AUTH_FAILED',
    });
    expect((await h.tunnel.claim(proxy)).blocked).toBe('PROXY_AUTH_FAILED');
    const expired = harness();
    expect(
      (await expired.tunnel.claim({ ...proxy, tunnel: { ...proxy.tunnel, expiresAt: NOW } }))
        .blocked
    ).toBe('PROXY_PACKAGE_EXPIRED');
  });
  test('541后同实际出口不能放行；迟到探测不能清理新恢复状态', async () => {
    const h = harness({
      requiredAlternateEgress: 'iproyal-main',
      tunnel: { label: 'iproyal-main', rejectedHashes: [HASH] },
    });
    const claim = await h.tunnel.claim(proxy);
    expect(
      (
        await h.tunnel.settle(claim, {
          id: 'probe',
          outcome: 'PROXY_CONNECTED',
          summary: { egressHash: HASH },
        })
      ).proxy
    ).toBeUndefined();
    expect(h.state().tunnel.verified).toBe(false);
    const pending = harness();
    const old = await pending.tunnel.claim(proxy);
    await pending.gate.locked((state, _now, tx) =>
      pending.gate.save({ ...state, recoveryEpoch: NOW + 1 }, tx)
    );
    expect(
      (
        await pending.tunnel.settle(old, {
          id: 'probe',
          outcome: 'PROXY_CONNECTED',
          summary: { egressHash: HASH },
        })
      ).blocked
    ).toBe('REQUEST_IN_FLIGHT');
  });
});

describe('供应商失败与正式请求预算', () => {
  test('CONNECT410清理候选但保留既有Apple风险和预算', () => {
    const initial = {
      recovering: true,
      recoveryEpoch: NOW - 100,
      recoverySuccesses: 2,
      consecutiveRisks: 2,
      recent: [{ at: NOW, risk: true }],
      hourCount: 8,
      dayCount: 12,
      tunnel: { label: 'iproyal-main', verified: true, expiresAt: NOW + 600000, exitHash: HASH },
    };
    const state = settleProduction(
      initial,
      {
        purpose: 'inventory',
        egress: 'iproyal-main',
        outcome: 'PROXY_SESSION_EXPIRED',
        summary: { responseSource: 'proxy_connect' },
      },
      NOW
    );
    expect(state).toMatchObject({
      hourCount: 8,
      dayCount: 12,
      providerFailures: 1,
      recovering: true,
      recoverySuccesses: 2,
      consecutiveRisks: 2,
      tunnel: { verified: false, expiresAt: 0 },
    });
    expect(state.recent).toEqual(initial.recent);
    expect(
      reserveProduction(state, NOW + 1, 'id', 0, 'iproyal-main', 'egress', {
        ...DEFAULT_CONFIG,
        enabled: true,
      })
    ).toMatchObject({ blocked: 'PROXY_PROVIDER_COOLDOWN', until: NOW + 60000 });
  });
  test('实际库存有效才清供应商失败；egress成功不能清空', () => {
    const initial = { providerFailures: 2, providerCooldownUntil: NOW };
    expect(
      settleProduction(initial, { purpose: 'egress', outcome: 'PROXY_CONNECTED' }, NOW)
        .providerFailures
    ).toBe(2);
    expect(
      settleProduction(initial, { purpose: 'inventory', outcome: 'INVENTORY_VALID' }, NOW)
        .providerFailures
    ).toBe(0);
  });
});

describe('候选发送与失败边界', () => {
  beforeEach(() => {
    process.env.FIELD_ENCRYPTION_KEY = 'a'.repeat(64);
    jest.clearAllMocks();
  });
  test('select发送一次固定出口验证并随后复用', async () => {
    const h = harness();
    requestOnce.mockResolvedValue({
      id: 'probe',
      outcome: 'PROXY_CONNECTED',
      summary: { egressHash: HASH },
    });
    expect((await h.tunnel.select(proxy)).label).toBe('iproyal-main');
    expect(requestOnce).toHaveBeenCalledTimes(1);
    expect(requestOnce.mock.calls[0][0]).toMatchObject({ purpose: 'egress', gate: h.gate });
    expect((await h.tunnel.select(proxy)).label).toBe('iproyal-main');
    expect(requestOnce).toHaveBeenCalledTimes(1);
  });
  test('未领取预算不耗供应商候选，未知网络结果仍有限失败', async () => {
    const h = harness();
    requestOnce.mockResolvedValueOnce({ outcome: 'REQUEST_BUDGET_EXHAUSTED' });
    await expect(h.tunnel.select(proxy)).rejects.toMatchObject({
      inventoryOutcome: 'REQUEST_BUDGET_EXHAUSTED',
    });
    expect(h.state().providerFailures).toBeUndefined();
    requestOnce.mockRejectedValueOnce(new Error('private'));
    await expect(h.tunnel.select(proxy)).rejects.toMatchObject({
      inventoryOutcome: 'PROXY_PROVIDER_COOLDOWN',
    });
    expect(h.state().providerFailures).toBe(1);
    await expect(h.tunnel.select(proxy)).rejects.toMatchObject({
      inventoryOutcome: 'PROXY_PROVIDER_COOLDOWN',
    });
    expect(requestOnce).toHaveBeenCalledTimes(2);
  });
  test('供应商被停用、旧探测、过期与状态失败不产生出口', async () => {
    const paused = harness({ pausedReason: 'MANUAL' });
    await expect(paused.tunnel.select(proxy)).rejects.toMatchObject({ inventoryOutcome: 'MANUAL' });
    const h = harness();
    const claim = await h.tunnel.claim(proxy);
    h.at(NOW + 600001);
    expect((await h.tunnel.settle(claim, { id: 'p', outcome: 'PROXY_CONNECTED' })).blocked).toBe(
      'REQUEST_IN_FLIGHT'
    );
    expect((await h.tunnel.settle({ token: 'old' }, {})).blocked).toBe('REQUEST_IN_FLIGHT');
    const storage = new InventoryTunnel({
      locked: jest.fn().mockRejectedValue(new Error('secret')),
    });
    await expect(storage.select(proxy)).rejects.toThrow('TUNNEL_STATE_FAILED');
    expect(requestOnce).not.toHaveBeenCalled();
  });
  test('恢复后的旧候选重新验证，并保留被拒实际出口', async () => {
    const h = harness();
    const old = await h.tunnel.claim(proxy);
    await h.tunnel.settle(old, {
      id: 'p',
      outcome: 'PROXY_CONNECTED',
      summary: { egressHash: HASH },
    });
    await h.gate.locked((state, _now, tx) => h.gate.save({ ...state, resumedAt: NOW + 1 }, tx));
    const next = await h.tunnel.claim(proxy);
    expect(next.token).not.toBe(old.token);
    expect(next.verified).toBe(false);
    expect(next.resumeEpoch).toBe(NOW + 1);
  });
  test('迟到旧会话供应商响应只能结算预算，不能废弃新会话', () => {
    const initial = {
      providerFailures: 1,
      tunnel: { token: 'new', label: 'iproyal-main', verified: true, expiresAt: NOW + 600000 },
      requestLeases: { old: { tunnelToken: 'old', day: 0, bytes: 0 } },
    };
    const state = settleProduction(
      initial,
      { id: 'old', purpose: 'inventory', egress: 'iproyal-main', outcome: 'PROXY_SESSION_EXPIRED' },
      NOW
    );
    expect(state.tunnel).toEqual(initial.tunnel);
    expect(state.providerFailures).toBe(1);
    expect(state.requestLeases).toEqual({});
  });
});

describe('并发供应商故障去重', () => {
  test('同一候选三个在途请求故障只耗一次候选', () => {
    let state = {
      tunnel: { label: 'iproyal-main', token: 'same', verified: true, expiresAt: NOW + 600000 },
      requestLeases: Object.fromEntries(
        ['a', 'b', 'c'].map(id => [id, { tunnelToken: 'same', bytes: 0 }])
      ),
    };
    for (const id of ['a', 'b', 'c'])
      state = settleProduction(
        state,
        { id, purpose: 'inventory', egress: 'iproyal-main', outcome: 'PROXY_SESSION_EXPIRED' },
        NOW
      );
    expect(state.providerFailures).toBe(1);
    expect(state.pausedEgress).toBeUndefined();
    expect(state.requestLeases).toEqual({});
  });
});
