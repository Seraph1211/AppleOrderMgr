const { localObservation, start, stop } = require('../src/services/stockReturnScheduler');
const db = require('../src/models');

describe('库存只读取系统已有状态', () => {
  afterEach(() => {
    stop();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  test.each([null, '', 'UNKNOWN', 'RETURN_STARTED | UNKNOWN'])(
    '状态缺失保留成功记录：%s',
    status => {
      expect(localObservation({ status })).toBeNull();
    }
  );
  test('订单级退货没有SN或数量时不推断整单退货', () => {
    expect(localObservation({ status: 'RETURN_STARTED' }).items).toEqual([
      expect.objectContaining({ rawStatus: 'RETURN_STARTED', quantity: 0, serialNumbers: [] }),
    ]);
  });
  test('仅同一来源时间和状态复用已保存逐项证据，新状态不复用旧SN', () => {
    const items = [{ rawStatus: 'RETURN_STARTED', quantity: 1, serialNumbers: ['Z123456789'] }];
    const row = {
      status: 'RETURN_STARTED',
      observed: '2026-10-10T01:00:00Z',
      savedObserved: new Date('2026-10-10T01:00:00Z'),
      items,
    };
    expect(localObservation(row).items).toBe(items);
    expect(localObservation({ ...row, observed: '2026-10-10T02:00:00Z' }).items[0].quantity).toBe(
      0
    );
    expect(localObservation({ ...row, status: 'PICKED_UP' }).items[0].serialNumbers).toEqual([]);
  });
  test('API启动核对、重复启动不叠加定时器、关闭停止领取', async () => {
    try {
      jest.useFakeTimers();
      const transaction = jest.spyOn(db.sequelize, 'transaction').mockResolvedValue(0);
      start();
      start();
      await Promise.resolve();
      await Promise.resolve();
      expect(transaction).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(60_000);
      expect(transaction).toHaveBeenCalledTimes(2);
      await stop();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(transaction).toHaveBeenCalledTimes(2);
    } catch (error) {
      error.component = 'stockSchedulerTest';
      throw error;
    }
  });
});
