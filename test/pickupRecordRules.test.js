const { normalizePickupUpdate } = require('../src/services/pickupRecordRules');

describe('取货登记规则', () => {
  const current = {
    status: 'pending',
    pickedUpAt: null,
    settlementAmount: null,
    settlementPerson: null,
    notes: null,
  };

  test('首次登记已取货时自动填充当前时间，允许同时不填凭证相关信息', () => {
    const now = new Date('2026-09-23T01:02:03.000Z');
    const result = normalizePickupUpdate(
      { status: 'picked_up', settlementAmount: '', settlementPerson: '', notes: '' },
      current,
      () => now
    );
    expect(result).toEqual({
      status: 'picked_up',
      pickedUpAt: now,
      settlementAmount: null,
      settlementPerson: null,
      notes: null,
    });
  });

  test('人工填写的取货时间、结款金额和结款人优先保存', () => {
    const result = normalizePickupUpdate(
      {
        status: 'picked_up',
        pickedUpAt: '2026-09-22T08:30:00.000Z',
        settlementAmount: '188.50',
        settlementPerson: ' 王五 ',
        notes: ' 已交接 ',
      },
      current
    );
    expect(result.pickedUpAt.toISOString()).toBe('2026-09-22T08:30:00.000Z');
    expect(result.settlementAmount).toBe(188.5);
    expect(result.settlementPerson).toBe('王五');
    expect(result.notes).toBe('已交接');
  });

  test('浏览器提交空取货时间时仍为首次已取货自动填充时间', () => {
    const now = new Date('2026-09-23T03:04:05.000Z');
    const result = normalizePickupUpdate(
      { status: 'picked_up', pickedUpAt: null },
      current,
      () => now
    );
    expect(result.pickedUpAt).toBe(now);
  });

  test.each([
    [{ status: 'partial' }, '取货状态无效'],
    [{ status: 'pending', settlementAmount: '-1' }, '结款金额无效'],
    [{ status: 'picked_up', pickedUpAt: 'bad-date' }, '实际取货时间无效'],
  ])('拒绝非法登记 %#', (payload, message) => {
    expect(() => normalizePickupUpdate(payload, current)).toThrow(message);
  });
});
