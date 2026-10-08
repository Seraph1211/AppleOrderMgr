/* eslint-disable no-magic-numbers -- 独立采样配置与CLI输入的离线回归。 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SOURCE = fs.readFileSync(
  path.join(__dirname, '../scripts/collectOfficialOrderHttp.js'),
  'utf8'
);

/** 使用离线依赖检查独立配置，禁止加载真实网络或数据库模块。 */
async function invoke(token, override = {}) {
  try {
    const root = '/synthetic';
    const sample = {
      id: 11,
      orderNumber: 'W1234567890',
      accountHash: 'b'.repeat(64),
      url: 'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/example',
    };
    const gate = {
      open: jest.fn().mockResolvedValue(12),
      recordFailure: jest.fn(),
      close: jest.fn().mockResolvedValue(),
    };
    const Gate = jest.fn(() => gate);
    const Transport = jest.fn(() => ({ start: jest.fn(), close: jest.fn() }));
    const Collector = jest.fn(() => ({
      collect: jest.fn().mockResolvedValue({ outcome: 'SUCCEEDED' }),
    }));
    const values = {
      [`${root}/private/plan.json`]: {
        schemaVersion: 3,
        scope: 'missing-fields',
        startedAt: new Date().toISOString(),
        policy: { loginCooldown: true, apiHealthCheck: true },
        entries: [sample],
      },
      [`${root}/private/request-11.json`]: { samples: [sample] },
      [`${root}/private/httpConfig.json`]: { maxTotalRequests: 100, maxRunRequests: 40 },
      [`${root}/private/httpProxy.json`]: { marker: 'legacy' },
      [`${root}/private/http-config-${token}.json`]: {
        attemptId: token,
        orderId: 11,
        settings: { maxTotalRequests: 200, pythonPath: '/isolated/python' },
        proxy: { marker: token },
        ...override,
      },
    };
    const readPrivate = jest.fn(filename => values[filename]);
    const writePrivate = jest.fn();
    const dependencies = {
      path,
      fs: { existsSync: () => false },
      '../src/services/officialOrderHttpCollector': {
        OfficialOrderHttpCollector: Collector,
        validateReadUrl: value => new URL(value),
      },
      '../src/services/officialOrderHttpTransport': { OfficialOrderHttpTransport: Transport },
      '../src/services/officialOrderGate': Gate,
      '../src/services/officialOrderSupport': {
        readPrivate,
        writePrivate,
        hash: () => 'hash',
        proxyFingerprint: value => value.marker,
        fault: code => Object.assign(new Error(code), { code }),
      },
    };
    const processStub = {
      argv: ['node', 'script', root, '11', ...(token === undefined ? [] : [token])],
      stdout: { write: jest.fn() },
      stderr: { write: jest.fn() },
    };
    await vm.runInNewContext(SOURCE, {
      require: name => {
        if (!(name in dependencies)) throw new Error('UNEXPECTED_DEPENDENCY');
        return dependencies[name];
      },
      process: processStub,
    });
    return { Gate, gate, Transport, Collector, readPrivate, writePrivate, processStub };
  } catch (error) {
    error.component = 'httpCollectorCliTest';
    throw error;
  }
}

test('并发采样按token读取代理配置，保留禁收据设置', async () => {
  const token = 'a'.repeat(32);
  const result = await invoke(token);
  expect(result.gate.open).toHaveBeenCalledWith(expect.any(Object), token);
  expect(result.Transport).toHaveBeenCalledWith(
    expect.objectContaining({ proxy: { marker: token }, pythonPath: '/isolated/python' })
  );
  expect(result.Collector).toHaveBeenCalledWith(expect.objectContaining({ collectReceipt: false }));
  expect(result.readPrivate).not.toHaveBeenCalledWith('/synthetic/private/httpProxy.json');
  expect(result.writePrivate).toHaveBeenCalledWith(
    `/synthetic/private/http-last-summary-${token}.json`,
    expect.any(String)
  );
});

test.each([{ orderId: 12 }, { attemptId: 'c'.repeat(32) }])(
  '错绑配置拒绝打开Gate：%j',
  async override => {
    const result = await invoke('a'.repeat(32), override);
    expect(result.Gate).not.toHaveBeenCalled();
    expect(result.processStub.exitCode).toBe(2);
  }
);

test('非法token不能影响摘要保存路径', async () => {
  const result = await invoke('../../escape');
  expect(result.Gate).not.toHaveBeenCalled();
  expect(result.writePrivate).toHaveBeenCalledWith(
    '/synthetic/private/http-last-summary-11.json',
    expect.any(String)
  );
});

test('旧顺序入口仍可读取旧配置', async () => {
  const result = await invoke(undefined);
  expect(result.gate.open).toHaveBeenCalledWith(expect.any(Object), 'legacy');
});
