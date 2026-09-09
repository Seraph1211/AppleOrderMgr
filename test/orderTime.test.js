const {
  formatOrderTime,
  parseOrderTimeBoundary,
  getRestorableOrderTime,
} = require('../src/utils/orderTime');

describe('下单时间精度、恢复与北京时间边界', () => {
  test('完整时间转换北京时间，日期和缺失值不伪造时间', () => {
    expect(formatOrderTime('2026-09-09T05:24:25Z')).toBe('2026/09/09 13:24:25');
    expect(formatOrderTime('2026-09-09')).toBe('2026/09/09');
    expect(formatOrderTime(null)).toBe('');
    expect(formatOrderTime('bad')).toBe('');
  });
  test('日期范围覆盖北京时间整日，包括凌晨和深夜', () => {
    expect(parseOrderTimeBoundary('2026-09-09').toISOString()).toBe('2026-09-08T16:00:00.000Z');
    expect(parseOrderTimeBoundary('2026-09-09', true).toISOString()).toBe(
      '2026-09-09T15:59:59.999Z'
    );
    expect(parseOrderTimeBoundary('2026-09-09T13:24:25').toISOString()).toBe(
      '2026-09-09T05:24:25.000Z'
    );
    expect(Number.isNaN(parseOrderTimeBoundary('2026-02-30').getTime())).toBe(true);
  });
  test('只恢复同日 UTC 午夜覆盖，有精确来源快照才可恢复', () => {
    const order = {
      orderDate: '2026-09-09T00:00:00Z',
      sourceSnapshot: { orderDate: '2026-09-09T05:24:25Z' },
    };
    expect(getRestorableOrderTime(order).toISOString()).toBe('2026-09-09T05:24:25.000Z');
    for (const original of [null, 'bad', '2026-09-09', '2026-09-08T05:24:25Z', order.orderDate]) {
      expect(
        getRestorableOrderTime({ ...order, sourceSnapshot: { orderDate: original } })
      ).toBeNull();
    }
    expect(getRestorableOrderTime({ ...order, orderDate: '2026-09-09T05:23:00Z' })).toBeNull();
  });
});
