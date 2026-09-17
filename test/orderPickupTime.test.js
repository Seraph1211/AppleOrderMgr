const { formatPickupTime, normalizePickupDate } = require('../src/utils/orderPickupTime');

describe('订单取货时间', () => {
  test('应该只提取官网提示中的日期和预约时段', () => {
    expect(
      formatPickupTime('请于 星期六 2026/09/19 的 20:30 – 20:45 之间到 Apple Store 零售店签到')
    ).toBe('2026/09/19 20:30 – 20:45');
  });

  test('应该去重并保留不同预约时段', () => {
    expect(
      formatPickupTime(
        '2026/09/19 的 20:30-20:45；2026/09/19 的 20:30 – 20:45；2026/09/20 的 08:05—08:20'
      )
    ).toBe('2026/09/19 20:30 – 20:45；2026/09/20 08:05 – 08:20');
  });

  test.each([null, '', '预计近期可取货', '2026/02/30 的 20:30 – 20:45'])(
    '无法确认预约时段时返回 null：%s',
    message => {
      expect(formatPickupTime(message)).toBeNull();
    }
  );

  test('应该校验筛选日期并转换官网格式', () => {
    expect(normalizePickupDate('2026-09-19')).toBe('2026/09/19');
    expect(normalizePickupDate('2026-02-30')).toBeNull();
    expect(normalizePickupDate('2026/09/19')).toBeNull();
  });
});
