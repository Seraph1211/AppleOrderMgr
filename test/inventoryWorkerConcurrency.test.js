jest.mock('../src/models', () => ({
  sequelize: { authenticate: jest.fn().mockResolvedValue(), close: jest.fn().mockResolvedValue() },
}));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../src/utils/fieldEncryption', () => ({ validateEncryptionConfiguration: jest.fn() }));
jest.mock('../src/services/inventoryService');
jest.mock('../src/services/inventoryValidationGate');
jest.mock('../src/services/inventoryCollector');
jest.mock('../src/services/inventoryNotifier');
jest.mock('../src/services/inventoryDriver');
jest.mock('../src/services/inventoryMaintenance');

test('Worker 滚动维持三个并发槽，单个请求完成即可补位，退出等待全部在途任务', async () => {
  jest.useFakeTimers();
  const on = jest.spyOn(process, 'on').mockReturnValue(process);
  try {
    const models = require('../src/models');
    const Service = require('../src/services/inventoryService');
    const Collector = require('../src/services/inventoryCollector');
    const Notifier = require('../src/services/inventoryNotifier');
    const Driver = require('../src/services/inventoryDriver');
    const Maintenance = require('../src/services/inventoryMaintenance');
    Service.mockImplementation(() => ({ catalog: jest.fn().mockResolvedValue() }));
    let next = 0;
    const collector = {
      claim: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve({ task: { skus: ['TEST1CH/A'], location: String(++next) } })
        ),
      settle: jest.fn().mockResolvedValue({}),
    };
    Collector.mockImplementation(() => collector);
    Notifier.mockImplementation(() => ({
      health: jest.fn().mockResolvedValue(),
      tick: jest.fn().mockResolvedValue(),
    }));
    const completions = [];
    const driver = {
      request: jest
        .fn()
        .mockImplementation(() => new Promise(resolve => completions.push(resolve))),
    };
    Driver.mockImplementation(() => driver);
    Maintenance.mockImplementation(() => ({
      catalogTick: jest.fn().mockResolvedValue(),
      retain: jest.fn().mockResolvedValue(),
    }));
    require('../src/workers/inventoryWorker');
    await jest.advanceTimersByTimeAsync(1000);
    expect(driver.request).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1000);
    expect(driver.request).toHaveBeenCalledTimes(3);
    completions[1]({ id: 'second', outcome: 'INVENTORY_VALID' });
    await jest.advanceTimersByTimeAsync(1000);
    expect(driver.request).toHaveBeenCalledTimes(4);
    expect(collector.settle).toHaveBeenCalledTimes(1);
    const stop = on.mock.calls.find(call => call[0] === 'SIGTERM')[1];
    const stopped = stop();
    await jest.advanceTimersByTimeAsync(1000);
    expect(models.sequelize.close).not.toHaveBeenCalled();
    completions[0]({ id: 'first', outcome: 'INVENTORY_VALID' });
    completions[2]({ id: 'third', outcome: 'REQUEST_TIMEOUT' });
    completions[3]({ id: 'fourth', outcome: 'INVENTORY_VALID' });
    await stopped;
    expect(models.sequelize.close).toHaveBeenCalledTimes(1);
    expect(driver.request).toHaveBeenCalledTimes(4);
  } catch (error) {
    throw new Error('库存 Worker 并发回归失败', { cause: error });
  } finally {
    on.mockRestore();
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});
