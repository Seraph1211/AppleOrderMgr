/* eslint-disable no-magic-numbers -- CLI 参数与冻结策略只使用离线替身。 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const SOURCE = fs.readFileSync(path.join(__dirname, '../scripts/collectOfficialOrder.js'), 'utf8');
const ROOT = '/synthetic-research';
const SAMPLE = { id: 11, orderNumber: 'W1234567890' };
const POLICY = { loginCooldown: true, apiHealthCheck: true, proxy541Limit: 3 };

async function invoke(settings, mode) {
  try {
    const collector = { run: jest.fn().mockResolvedValue({ outcome: 'SUCCEEDED' }) };
    const Collector = jest.fn(() => collector);
    const processStub = {
      argv: ['node', 'collectOfficialOrder.js', ROOT, '11', ...(mode ? [mode] : [])],
      stdout: { write: jest.fn() },
      stderr: { write: jest.fn() },
    };
    const values = {
      [`${ROOT}/private/collectorConfig.json`]: settings,
      [`${ROOT}/private/request-11.json`]: { samples: [SAMPLE] },
      [`${ROOT}/private/plan.json`]: {
        schemaVersion: 3,
        scope: 'missing-fields',
        cutoff: null,
        policy: POLICY,
        startedAt: new Date().toISOString(),
        entries: [SAMPLE],
      },
      [`${ROOT}/private/browserProxy.json`]: { maxConnections: 16 },
    };
    const dependencies = {
      path,
      fs: { existsSync: () => true },
      '../src/services/officialOrderCollector': Collector,
      '../src/services/officialOrderSupport': { readPrivate: filename => values[filename] },
    };
    await vm.runInNewContext(SOURCE, {
      require: name => {
        if (!(name in dependencies)) throw new Error('UNEXPECTED_DEPENDENCY');
        return dependencies[name];
      },
      process: processStub,
    });
    return { Collector, collector, processStub };
  } catch (error) {
    error.component = 'officialOrderCollectorCliTest';
    throw error;
  }
}

test.each([true, false])(
  '采样CLI完整传递模式与禁会话配置：httpBootstrap=%s',
  async httpBootstrap => {
    const { Collector, collector, processStub } = await invoke(
      {
        proxyFile: 'browserProxy.json',
        captureReceipt: true,
        leaseContext: { provider: 'iproyal' },
        httpBootstrap,
        persistSessions: false,
        maxRunRequests: 300,
        maxTotalRequests: 201470,
      },
      'backfill'
    );
    expect(Collector).toHaveBeenCalledWith(
      expect.objectContaining({
        httpBootstrap,
        persistSessions: false,
        captureReceipt: true,
        accountMode: true,
        resumeRun: undefined,
        runRequestLimit: 300,
        totalRequestLimit: 201470,
        batchPolicy: POLICY,
      })
    );
    expect(collector.run).toHaveBeenCalledTimes(1);
    expect(processStub.stderr.write).not.toHaveBeenCalled();
  }
);

test('旧产品未配置会话开关时保留Collector默认值', async () => {
  const { Collector } = await invoke({}, '12');
  expect(Collector).toHaveBeenCalledWith(
    expect.objectContaining({ persistSessions: undefined, httpBootstrap: false, resumeRun: '12' })
  );
});
