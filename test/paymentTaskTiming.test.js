const { serializeTask } = require('../src/services/paymentTaskService');

describe('付款窗口时间契约', () => {
  test('付款截止固定取官网订单创建时间加 30 分钟', () => {
    const task = {
      toJSON: () => ({
        id: 1,
        orderId: 2,
        assigneeUserId: null,
        processingStatus: 'pending',
        processingNotes: null,
        deadlineAt: new Date('2026-09-08T09:00:00.000Z'),
        deadlineSource: 'manual_verified',
        version: 0,
        createdAt: new Date('2026-09-08T10:00:00.000Z'),
        updatedAt: new Date('2026-09-08T10:00:00.000Z'),
        order: {
          orderNumber: 'W1234567890',
          products: [],
          status: 'pending',
          paymentStatus: 'unpaid',
          officialOrderCreatedAt: new Date('2026-09-08T10:00:00.000Z'),
          lastCrawledAt: new Date('2026-09-08T10:04:30.000Z'),
          updatedAt: new Date('2026-09-08T10:01:00.000Z'),
        },
      }),
    };

    const result = serializeTask(task, new Date('2026-09-08T10:05:00.000Z'));

    expect(result.deadlineAt.toISOString()).toBe('2026-09-08T10:30:00.000Z');
    expect(result.deadlineSource).toBe('official');
    expect(result.remainingSeconds).toBe(25 * 60);
    expect(result.lastCrawledAt.toISOString()).toBe('2026-09-08T10:04:30.000Z');
  });

  test('官网只有日期或没有精确时间时不生成倒计时', () => {
    const task = {
      toJSON: () => ({
        id: 1,
        orderId: 2,
        processingStatus: 'pending',
        deadlineAt: new Date('2026-09-08T10:30:00.000Z'),
        version: 0,
        createdAt: new Date('2026-09-08T10:00:00.000Z'),
        updatedAt: new Date('2026-09-08T10:00:00.000Z'),
        order: { orderNumber: 'W1234567890', products: [], officialOrderCreatedAt: null },
      }),
    };

    const result = serializeTask(task, new Date('2026-09-08T10:05:00.000Z'));

    expect(result.deadlineAt).toBeNull();
    expect(result.deadlineSource).toBeNull();
    expect(result.remainingSeconds).toBeNull();
  });
});
