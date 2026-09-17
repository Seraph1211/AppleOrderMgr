const {
  formatPickupDate,
  formatPickupTime,
  formatPickupTimeSlot,
  normalizePickupDate,
} = require('../src/utils/orderPickupTime');

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

  test.each([
    ['今天', '2026-09-18T00:30:00.000Z', '2026/09/18'],
    ['明天', '2026-09-18T00:30:00.000Z', '2026/09/19'],
    ['今天', '2026-09-17T16:30:00.000Z', '2026/09/18'],
  ])('应该以官网观测时的北京时间换算%s', (relativeDate, observedAt, expectedDate) => {
    const message = `请于 ${relativeDate} 的 19:15 – 19:30 之间到 Apple Store 零售店签到`;
    expect(formatPickupTime(message, observedAt)).toBe(`${expectedDate} 19:15 – 19:30`);
    expect(formatPickupDate(message, observedAt)).toBe(expectedDate);
    expect(formatPickupTimeSlot(message, observedAt)).toBe('19:15 – 19:30');
  });

  test('缺少官网观测时间时不按页面打开日期猜测相对日期', () => {
    expect(formatPickupTime('请于 明天 的 19:15 – 19:30 之间到店')).toBeNull();
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
