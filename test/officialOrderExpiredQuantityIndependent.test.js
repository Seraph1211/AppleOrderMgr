/* eslint-disable no-magic-numbers -- 独立合成数量边界及已有业务保护。 */
const {
  parseOfficialOrderDetail,
  parseOfficialOrderList,
} = require('../src/services/officialOrderParser');
const { deriveOfficialPickupDate } = require('../src/services/officialPickupDate');
const {
  explicitSerials,
  returnDecision,
  RETURN_STATUS,
} = require('../src/services/stockLifecycleRules');
const ORDER = 'W1234567890';
const KEY = 'orderItem-0000101';
const OTHER_KEY = 'orderItem-0000201';
const SN = 'Z123456789';
function model(quantity = -1, status = 'RETURN_EXPIRED') {
  return {
    orderDetail: {
      orderHeader: { d: { orderNumber: ORDER, orderPlacedDate: '2026年9月20日' } },
      orderItems: {
        c: [KEY],
        [KEY]: {
          orderItemDetails: {
            d: { productName: '合成手机 512GB 蓝色', quantity, deliveryDate: '已取货 9月 25' },
          },
          orderItemStatusTracker: { d: { currentStatus: status } },
        },
      },
    },
  };
}
const parse = value => parseOfficialOrderDetail(JSON.stringify(value), ORDER);
const data = value => value.orderDetail.orderItems[KEY].orderItemDetails.d;

describe('独立验收：官网 RETURN_EXPIRED 的已观察数量 -1', () => {
  test('仅已观察的数值 -1 转为单台并留存原值，无 SN 不补造', () => {
    const value = model();
    const original = JSON.stringify(value);
    const result = parse(value);
    expect(result).toMatchObject({ identityMatched: true, completeItemCount: 1 });
    expect(result.products[0]).toMatchObject({
      quantity: 1,
      rawQuantity: -1,
      quantityInterpretation: 'return_expired_negative_one',
      rawStatus: 'RETURN_EXPIRED',
    });
    expect(result.products[0].serialNumbers).toBeUndefined();
    expect(JSON.stringify(value)).toBe(original);
    expect(deriveOfficialPickupDate(result, '2026-10-10')).toEqual({
      date: null,
      reason: 'NOT_ALL_ITEMS_PICKED_UP',
    });
  });

  test.each([
    -2,
    -3,
    -100,
    '-1',
    '-2',
    ' -1 ',
    '-01',
    '-1.0',
    '+1',
    '1e0',
    1.5,
    -1.5,
    null,
    '',
    true,
    false,
    {},
    [],
    Number.MAX_SAFE_INTEGER + 1,
    -(Number.MAX_SAFE_INTEGER + 1),
  ])('未观察/非法数量不得按绝对值或类型转换放宽：%j', value => {
    expect(() => parse(model(value))).toThrow('INVALID_QUANTITY');
  });
  test.each([
    'PICKED_UP',
    'PROCESSING',
    'READY_FOR_PICKUP',
    'PAYMENT_RECEIVED',
    'CANCELLED',
    'RETURNED',
    'RETURN_COMPLETE',
    'RETURN_EXPIRED_UNKNOWN',
    'return_expired',
    'RETURN_EXPIRED ',
    'UNKNOWN',
  ])('其他状态 %s 不允许 -1', status => {
    expect(() => parse(model(-1, status))).toThrow('INVALID_QUANTITY');
  });
  test.each([0, '0', 1, '1', 2, '2', Number.MAX_SAFE_INTEGER])(
    '既有非负安全整数语义保持：%j',
    value => {
      expect(parse(model(value)).products[0].quantity).toBe(Number(value));
      expect(parse(model(value, 'PICKED_UP')).products[0].quantity).toBe(Number(value));
    }
  );
  test('缺数量与缺状态仍失败', () => {
    const value = model();
    delete data(value).quantity;
    expect(() => parse(value)).toThrow('INVALID_QUANTITY');
    data(value).quantity = -1;
    delete value.orderDetail.orderItems[KEY].orderItemStatusTracker.d.currentStatus;
    expect(() => parse(value)).toThrow('INCOMPLETE_CORE_FIELDS');
  });
  test('混合退货/已取货逐项保留，不推断整单取货日期', () => {
    const value = model();
    const items = value.orderDetail.orderItems;
    items.c.push(OTHER_KEY);
    items[OTHER_KEY] = model(1, 'PICKED_UP').orderDetail.orderItems[KEY];
    const result = parse(value);
    expect(result.completeItemCount).toBe(2);
    expect(result.products.map(item => [item.key, item.quantity, item.rawStatus])).toEqual([
      [KEY, 1, 'RETURN_EXPIRED'],
      [OTHER_KEY, 1, 'PICKED_UP'],
    ]);
    expect(deriveOfficialPickupDate(result, '2026-10-10').date).toBeNull();
    items[OTHER_KEY].orderItemDetails.d.quantity = -1;
    expect(() => parse(value)).toThrow('INVALID_QUANTITY');
  });
  test('订单身份和商品完整性不因退货特殊值放宽', () => {
    const value = model();
    expect(() => parseOfficialOrderDetail(JSON.stringify(value), 'W9999999999')).toThrow(
      'IDENTITY_MISMATCH'
    );
    value.orderDetail.orderItems.c.push(OTHER_KEY);
    expect(() => parse(value)).toThrow('INCOMPLETE_ITEMS');
    value.orderDetail.orderItems.c = [KEY, KEY];
    expect(() => parse(value)).toThrow('INCOMPLETE_ITEMS');
  });
  test.each([undefined, [], [SN, SN], [SN, 'B123456789'], ['bad'], ['z123456789']])(
    '缺失或歧义 SN 不按数量猜测：%j',
    serialNumbers => {
      const value = model();
      data(value).serialNumbers = serialNumbers;
      expect(parse(value).products[0].serialNumbers).toBeUndefined();
    }
  );
  test('负数兼容即使附带完整 SN 也不作为设备确认，而正数保持原规则', () => {
    const value = model();
    data(value).serialNumber = SN;
    data(value).serialNumbers = [SN];
    expect(parse(value).products[0].serialNumbers).toBeUndefined();
    data(value).quantity = 1;
    expect(parse(value).products[0].serialNumbers).toEqual([SN]);
    expect(parse(value).products[0].rawQuantity).toBeUndefined();
    expect(parse(value).products[0].quantityInterpretation).toBeUndefined();
  });
  test('过期退货不是活动退货，不据兼容数量退库或撤销售', () => {
    const item = parse(model()).products[0];
    expect(explicitSerials(item, item.quantity)).toEqual([]);
    expect(item.rawStatus === RETURN_STATUS).toBe(false);
    for (const state of ['in_stock', 'sold']) {
      expect(
        returnDecision({ state }, { hasReturn: false, matched: false, ambiguous: false })
      ).toEqual({ lifecycleIssue: null });
    }
    expect(
      returnDecision({ state: 'returned' }, { hasReturn: false, matched: false, ambiguous: false })
    ).toEqual({ lifecycleIssue: 'return_withdrawn' });
  });
  test('原活动退货兼容行为不变，解释标记与过期退货分开', () => {
    const item = parse(model(-1, 'RETURN_STARTED')).products[0];
    expect(item).toMatchObject({
      quantity: 1,
      rawQuantity: -1,
      quantityInterpretation: 'return_started_negative_one',
    });
    expect(item.rawStatus === RETURN_STATUS).toBe(true);
  });
  test.each([-1, '-1', -2])('列表缺可靠状态枚举，负数量 %j 仍拒绝', quantity => {
    const value = {
      orderList: {
        [`order-${ORDER}`]: {
          d: { webOrderNumber: ORDER },
          c: ['1001'],
          1001: {
            d: {
              productShortName: '合成手机',
              quantity,
              deliveryDate: '已发起退货',
              orderDetailUrl: '/shop/order/detail/synthetic',
            },
          },
        },
      },
    };
    expect(() => parseOfficialOrderList(JSON.stringify(value), ORDER)).toThrow('INVALID_QUANTITY');
  });
});

const { validateOfficialStatusResult } = require('../src/services/officialOrderStatusSync');
const NOW = Date.parse('2026-10-10T12:00:00Z');
const JOB = { orderId: 906, orderNumber: ORDER, startedAt: new Date(NOW - 1000) };
function result() {
  return {
    ...parse(model()),
    systemOrderId: 906,
    source: {
      provider: 'Apple official website',
      status: 200,
      cached: false,
      host: 'secure6.www.apple.com.cn',
      sha256: 'c'.repeat(64),
      runId: 1,
      observedAt: new Date(NOW).toISOString(),
    },
  };
}
describe('独立验收：API回写结果校验', () => {
  test('完整保留兼容证据且抹除外部传入 SN，不产生取货日期', () => {
    const value = result();
    value.products[0].serialNumbers = [SN];
    const validated = validateOfficialStatusResult(value, JOB, NOW);
    expect(validated.status).toBe('RETURN_EXPIRED');
    expect(validated.actualPickupDate).toBeNull();
    expect(validated.items[0]).toMatchObject({
      quantity: 1,
      rawQuantity: -1,
      quantityInterpretation: 'return_expired_negative_one',
      serialNumbers: [],
    });
  });
  test.each([
    item => {
      delete item.rawQuantity;
    },
    item => {
      delete item.quantityInterpretation;
    },
    item => {
      item.rawQuantity = '-1';
    },
    item => {
      item.rawQuantity = -2;
    },
    item => {
      item.rawQuantity = 1;
    },
    item => {
      item.quantity = 2;
    },
    item => {
      item.quantity = 0;
    },
    item => {
      item.rawStatus = 'PICKED_UP';
    },
    item => {
      item.quantityInterpretation = 'return_started_negative_one';
    },
  ])('证据、状态或计数不匹配即拒绝 %#', mutate => {
    const value = result();
    mutate(value.products[0]);
    expect(() => validateOfficialStatusResult(value, JOB, NOW)).toThrow('官网结果不完整');
  });
  test('身份/来源/时效校验对兼容项仍有效', () => {
    const value = result();
    expect(() => validateOfficialStatusResult(value, { ...JOB, orderId: 907 }, NOW)).toThrow(
      '官网结果不完整'
    );
    expect(() => validateOfficialStatusResult(value, JOB, NOW + 600000)).toThrow('官网结果不完整');
    value.source.cached = true;
    expect(() => validateOfficialStatusResult(value, JOB, NOW)).toThrow('官网结果不完整');
  });
});

test('API禁止started状态搭配expired解释标记，原started合法标记保持通过', () => {
  const value = result();
  value.products[0].rawStatus = 'RETURN_STARTED';
  expect(() => validateOfficialStatusResult(value, JOB, NOW)).toThrow('官网结果不完整');
  value.products[0].quantityInterpretation = 'return_started_negative_one';
  expect(validateOfficialStatusResult(value, JOB, NOW).status).toBe('RETURN_STARTED');
});
