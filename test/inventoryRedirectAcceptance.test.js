const { EventEmitter } = require('events');
const { requestOnce } = require('../src/services/inventoryValidationClient');
const { classifyInventoryRedirect } = require('../src/services/inventoryRedirectPolicy');
const { reserveProduction, settleProduction } = require('../src/services/inventoryGuardPolicy');
const { DEFAULT_CONFIG } = require('../src/services/inventoryPolicy');
const { reserveBudget, settleBudget } = require('../src/services/inventoryValidationPolicy');

const NOW = Date.parse('2026-10-16T04:00:00Z');
const LABEL = 'iproyal-main';
const HASH = 'a'.repeat(64);
const CONTEXT = { skus: ['TEST1CH/A'], location: '100000' };
const safeLocations = [
  undefined,
  null,
  '',
  '/shop/retail/pickup-message',
  'https://www.apple.com.cn/shop/retail/pickup-message?parts.0=OTHERCH%2FA&location=999999',
  'https://www.apple.com.cn:443/unknown/path?different=1',
];
const dangerousLocations = [
  'http://www.apple.com.cn/shop/retail/pickup-message',
  'https://127.0.0.1/private',
  'https://10.0.0.1/private',
  'https://www.apple.com.cn.evil.test/',
  'https://evil.test/?next=www.apple.com.cn',
  'https://www.apple.com.cn:8443/shop/retail/pickup-message',
  'https://synthetic-user:synthetic-secret@www.apple.com.cn/shop/retail/pickup-message',
  'https://www.apple.com.cn/shop/retail/pickup-message#fragment',
  'file:///etc/passwd',
  'javascript:alert(1)',
  'https://[invalid',
  ' ',
  '\nhttps://www.apple.com.cn/shop/retail/pickup-message',
  'https://www.apple.com.cn/shop/captcha',
  'https://www.apple.com.cn/shop/%63aptcha',
  'https://www.apple.com.cn/shop/login',
  'https://www.apple.com.cn/shop/retail/pickup-message?challenge=1',
  'https://www.apple.com.cn/shop/retail/pickup-message?next=%6cogin',
];
function classify(location, extra = {}) {
  return classifyInventoryRedirect({
    purpose: 'inventory',
    status: 307,
    tunnelStatus: 200,
    location,
    ...extra,
  });
}
function harness({ location, status = 307, tunnelStatus = 200, purpose = 'inventory' } = {}) {
  const agent = new EventEmitter();
  agent.destroy = jest.fn();
  const gate = {
    reserve: jest.fn().mockResolvedValue({ id: 'actual-attempt', egressHash: HASH }),
    finish: jest.fn().mockResolvedValue(),
  };
  const request = jest.fn(() => {
    if (tunnelStatus !== undefined) agent.emit('proxyConnect', { statusCode: tunnelStatus });
    return Promise.resolve({ status, headers: { location }, data: 'synthetic-body-secret' });
  });
  return {
    gate,
    agent,
    request,
    options: {
      purpose,
      context:
        purpose === 'inventory'
          ? CONTEXT
          : purpose === 'catalog'
            ? { path: '/shop/buy-iphone' }
            : {},
      proxy: { label: LABEL, url: 'http://synthetic-user:synthetic-secret@geo.iproyal.com:12321' },
      gate,
      request,
      createAgent: () => Promise.resolve(agent),
    },
  };
}
function state(extra = {}) {
  return {
    tunnel: {
      label: LABEL,
      verified: true,
      token: 'candidate',
      expiresAt: NOW + 600000,
      exitHash: HASH,
      rejectedHashes: [],
    },
    ...extra,
  };
}
function config() {
  return { ...DEFAULT_CONFIG, enabled: true };
}

describe('库存307独立验收：只分类、从不跟随', () => {
  test.each(safeLocations)('无危险信号Location仅进入有限恢复 %#', location => {
    const result = classify(location);
    expect(result.outcome).toBe('TARGET_REJECTED');
    expect(result.summary).toMatchObject({
      redirectDecision: 'RETRY_ORIGINAL',
      targetRejectReason: 'UNFOLLOWED_REDIRECT',
    });
    expect(result.nextUrl).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('https://');
  });
  test.each(dangerousLocations)('明确危险Location保持人工保护 %#', location => {
    const result = classify(location);
    expect(result.outcome).toBe('REDIRECT_BLOCKED');
    expect(result.summary.redirectDecision).toBe('MANUAL_REVIEW');
    expect(result.nextUrl).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(
      /synthetic-user|synthetic-secret|https:\/\/|alert\(1\)/
    );
  });
  test.each([301, 302, 303, 308])('其他状态%d不能降为有限恢复', status => {
    expect(classify(undefined, { status }).outcome).toBe('REDIRECT_BLOCKED');
  });
  test.each(['catalog', 'egress', 'connect'])('其他用途%s不能降为有限恢复', purpose => {
    expect(classify(undefined, { purpose }).outcome).toBe('REDIRECT_BLOCKED');
  });
  test.each([undefined, 407, 410, 500])('CONNECT非明确200不适用有限恢复 %#', tunnelStatus => {
    expect(classify(undefined, { tunnelStatus }).outcome).toBe('REDIRECT_BLOCKED');
  });
  test.each([{}, [], 307])('非法Location类型保持人工保护 %#', location => {
    expect(classify(location).outcome).toBe('REDIRECT_BLOCKED');
  });

  test.each(safeLocations)('实际307只请求原地址一次并保留真实审计 %#', async location => {
    try {
      const h = harness({ location });
      const result = await requestOnce(h.options);
      expect(result).toMatchObject({
        id: 'actual-attempt',
        status: 307,
        outcome: 'TARGET_REJECTED',
        summary: { responseSource: 'target', targetRejectReason: 'UNFOLLOWED_REDIRECT' },
      });
      expect(result.evidence).toBeUndefined();
      expect(h.request).toHaveBeenCalledTimes(1);
      expect(h.request.mock.calls[0][0]).toBe(
        'https://www.apple.com.cn/shop/retail/pickup-message?parts.0=TEST1CH/A&location=100000'
      );
      expect(h.request.mock.calls[0][1]).toMatchObject({ maxRedirects: 0, proxy: false });
      expect(h.gate.reserve).toHaveBeenCalledTimes(1);
      expect(h.gate.reserve).toHaveBeenCalledWith('inventory', LABEL, CONTEXT);
      expect(h.gate.finish).toHaveBeenCalledTimes(1);
      expect(h.gate.finish.mock.calls[0][0].bytes).toBe(Buffer.byteLength('synthetic-body-secret'));
      expect(h.agent.destroy).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toMatch(
        /synthetic-user|synthetic-secret|synthetic-body-secret/
      );
    } catch (error) {
      throw new Error('307审计验收失败', { cause: error });
    }
  });
  test.each([
    [407, 'PROXY_AUTH_FAILED'],
    [410, 'PROXY_SESSION_EXPIRED'],
    [500, 'PROXY_TUNNEL_UNAVAILABLE'],
    [307, 'PROXY_CONNECT_REJECTED'],
  ])('CONNECT%d优先于目标307分类', async (tunnelStatus, outcome) => {
    try {
      const h = harness({ tunnelStatus, location: '/shop/retail/pickup-message' });
      const result = await requestOnce(h.options);
      expect(result).toMatchObject({
        outcome,
        status: tunnelStatus,
        summary: { responseSource: 'proxy_connect' },
      });
      expect(h.request).toHaveBeenCalledTimes(1);
      expect(h.gate.finish).toHaveBeenCalledTimes(1);
    } catch (error) {
      throw new Error('CONNECT来源验收失败', { cause: error });
    }
  });
  test('缺少许可时不发送，不产生虚构307或额外预算', async () => {
    try {
      const h = harness();
      h.gate.reserve.mockResolvedValue({ blocked: 'TARGET_COOLDOWN', until: NOW + 60000 });
      expect(await requestOnce(h.options)).toEqual({
        outcome: 'TARGET_COOLDOWN',
        until: NOW + 60000,
      });
      expect(h.request).not.toHaveBeenCalled();
      expect(h.gate.finish).not.toHaveBeenCalled();
    } catch (error) {
      throw new Error('门控验收失败', { cause: error });
    }
  });
  test('307落库失败不得返回已成功分类或输出敏感错误', async () => {
    try {
      const h = harness();
      h.gate.finish.mockRejectedValue(new Error('synthetic-secret-db'));
      await expect(requestOnce(h.options)).rejects.toThrow('VALIDATION_PERSISTENCE_FAILED');
      expect(h.request).toHaveBeenCalledTimes(1);
      expect(h.agent.destroy).toHaveBeenCalled();
    } catch (error) {
      throw new Error('持久化验收失败', { cause: error });
    }
  });
});

describe('库存307独立验收：沿用已有保护', () => {
  test('真实307预算计入且租约释放，不记有效恢复或永久人工暂停', () => {
    const original = state({
      recovering: true,
      recoveryEpoch: NOW - 1,
      recoverySuccesses: 2,
      recent: [{ at: NOW - 1000, risk: true, egress: LABEL }],
    });
    const reserved = reserveProduction(original, NOW, '307', 0, LABEL, 'inventory', config()).state;
    const settled = settleProduction(
      reserved,
      {
        id: '307',
        purpose: 'inventory',
        egress: LABEL,
        outcome: 'TARGET_REJECTED',
        status: 307,
        bytes: 22,
      },
      NOW + 100
    );
    expect(settled.hourCount).toBe(1);
    expect(settled.dayCount).toBe(1);
    expect(settled.byteCount).toBe(22);
    expect(settled.requestLeases['307']).toBeUndefined();
    expect(settled.recovering).toBe(true);
    expect(settled.recoverySuccesses).toBe(0);
    expect(settled.pausedReason).toBeUndefined();
    expect(settled.cooldownUntil).toBeGreaterThanOrEqual(NOW + 60100);
    expect(settled.requiredAlternateEgress).toBe(LABEL);
    expect(settled.tunnel.rejectedHashes).toContain(HASH);
    expect(settled.recent.some(item => item.at === NOW - 1000)).toBe(true);
  });
  test('普通首次307从60秒开始，仍保留出口拒用不能原出口直重试', () => {
    const reserved = reserveProduction(
      state(),
      NOW,
      'initial',
      0,
      LABEL,
      'inventory',
      config()
    ).state;
    const settled = settleProduction(
      reserved,
      {
        id: 'initial',
        purpose: 'inventory',
        egress: LABEL,
        outcome: 'TARGET_REJECTED',
        status: 307,
      },
      NOW + 100
    );
    expect(settled.cooldownUntil).toBe(NOW + 60100);
    expect(settled.pausedReason).toBeUndefined();
    expect(
      reserveProduction(settled, NOW + 60200, 'same', 0, LABEL, 'inventory', config()).blocked
    ).toBe('ALTERNATE_EGRESS_REQUIRED');
  });
  test('恢复阶段三次307失败仍升级人工处理，不进入无限重试', () => {
    let current = state({ recovering: true, recoveryEpoch: NOW - 1 });
    for (let i = 0; i < 3; i += 1) {
      const at = NOW + i * 3000000;
      current = {
        ...current,
        cooldownUntil: 0,
        requiredAlternateEgress: null,
        tunnel: {
          ...current.tunnel,
          token: `new-${i}`,
          verified: true,
          rejectedHashes: [],
          expiresAt: at + 600000,
          exitHash: `${i}`.repeat(64),
        },
      };
      const id = `failed-${i}`;
      const claim = reserveProduction(current, at, id, 0, LABEL, 'inventory', config());
      expect(claim.state).toBeDefined();
      current = settleProduction(
        claim.state,
        { id, purpose: 'inventory', egress: LABEL, outcome: 'TARGET_REJECTED', status: 307 },
        at + 100
      );
    }
    expect(current.pausedReason).toBe('RECOVERY_EXHAUSTED');
    expect(current.recoveryFailures).toBe(3);
    expect(current.recoverySuccesses).toBe(0);
  });
  test('危险Location产生既有人工暂停，验证预算亦无降级', () => {
    const result = { id: 'unsafe', ...classify('https://evil.test/'), egress: LABEL };
    const prod = settleProduction(state(), { ...result, purpose: 'inventory' }, NOW);
    expect(prod.pausedReason).toBe('REDIRECT_BLOCKED');
    const reserved = reserveBudget({}, NOW, 'unsafe', 0, LABEL).state;
    const validation = settleBudget(reserved, result, NOW + 100);
    expect(validation.pausedReason).toBe('REDIRECT_BLOCKED');
    expect(validation.leaseId).toBeNull();
    expect(validation.hourCount).toBe(1);
  });
});
