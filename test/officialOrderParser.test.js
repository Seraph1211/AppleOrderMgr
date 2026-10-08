/* eslint-disable no-magic-numbers -- 测试显式列出数量、长度及深度边界。 */
const {
  parseOfficialOrderDetail,
  parseOfficialOrderList,
  isOfficialOrderResponse,
} = require('../src/services/officialOrderParser');

const ORDER = 'W1234567890';
const OTHER_ORDER = 'W9876543210';
const KEYS = ['orderItem-0000101', 'orderItem-0000201'];

function detailModel() {
  return {
    orderDetail: {
      orderHeader: { d: { orderNumber: ORDER } },
      orderItems: {
        c: KEYS,
        ...Object.fromEntries(
          KEYS.map((key, index) => [
            key,
            {
              orderItemDetails: {
                d: { productName: '测试设备 512GB 蓝色', quantity: index + 1 },
              },
              orderItemStatusTracker: {
                d: { currentStatus: index ? 'PICKED_UP' : 'READY_FOR_PICKUP' },
              },
            },
          ])
        ),
      },
    },
  };
}

function listModel() {
  return {
    orderList: {
      [`order-${ORDER}`]: {
        d: { webOrderNumber: ORDER },
        c: ['10000001', '10000002'],
        ...Object.fromEntries(
          ['10000001', '10000002'].map((key, index) => [
            key,
            {
              d: {
                quantity: 1,
                productShortName: '测试设备',
                deliveryDate: '已取货 9月 30',
                orderDetailUrl: `/shop/order/detail/506738/${ORDER}?item=${index}`,
              },
            },
          ])
        ),
      },
    },
  };
}

const html = model =>
  `<script id="init_data" type="application/json">${JSON.stringify(model)}</script>`;

describe('官网订单解析与来源边界', () => {
  test('访客 orderx/guestx 的 fetchOrder 响应进入解析，鉴权页和缓存不进入', () => {
    const response = {
      status: 200,
      host: 'secure6.www.apple.com.cn',
      path: '/shop/orderx/guestx/[ORDER]/[TOKEN]',
      cached: false,
    };
    expect(isOfficialOrderResponse(response)).toBe(true);
    expect(
      isOfficialOrderResponse({ ...response, path: '/shop/order/detail/506738/[ORDER]' })
    ).toBe(true);
    expect(isOfficialOrderResponse({ ...response, path: '/shop/order/list' })).toBe(true);
    expect(isOfficialOrderResponse({ ...response, status: 541 })).toBe(false);
    expect(isOfficialOrderResponse({ ...response, cached: true })).toBe(false);
    expect(
      isOfficialOrderResponse({ ...response, host: 'secure6.www.apple.com.cn.example.com' })
    ).toBe(false);
    expect(isOfficialOrderResponse({ ...response, path: '/shop/signIn/idms/authx' })).toBe(false);
    expect(isOfficialOrderResponse(null)).toBe(false);
  });
  test('从详情保留订单身份、完整商品集合和逐项不同状态', () => {
    const result = parseOfficialOrderDetail(html(detailModel()), ORDER);
    expect(result.orderNumber).toBe(ORDER);
    expect(result.sourceModel).toBe('orderDetail');
    expect(result.completeItemCount).toBe(2);
    expect(result.products.map(item => item.rawStatus)).toEqual(['READY_FOR_PICKUP', 'PICKED_UP']);
    expect(result.products.map(item => item.quantity)).toEqual([1, 2]);
  });

  test('JSON 响应可嵌套；零数量和数字字符串保持原始数量语义', () => {
    const model = detailModel();
    model.orderDetail.orderItems[KEYS[0]].orderItemDetails.d.quantity = '0';
    expect(
      parseOfficialOrderDetail(JSON.stringify({ body: model }), ORDER).products[0].quantity
    ).toBe(0);
  });

  test.each([
    '<p>Page Not Found</p>',
    html({ guestOrderSpinner: {} }),
    '<script>window.orderDetail = {};</script>',
  ])('错误页、加载页或可执行脚本不是详情：%s', body => {
    expect(parseOfficialOrderDetail(body, ORDER)).toBeNull();
  });

  test('其他订单绝不作为目标订单详情', () => {
    expect(() => parseOfficialOrderDetail(html(detailModel()), OTHER_ORDER)).toThrow(
      'IDENTITY_MISMATCH'
    );
  });

  test.each([null, undefined, '', -1, 1.5, '1台', Number.MAX_SAFE_INTEGER + 1])(
    '拒绝无效或缺失数量：%s',
    quantity => {
      const model = detailModel();
      model.orderDetail.orderItems[KEYS[0]].orderItemDetails.d.quantity = quantity;
      expect(() => parseOfficialOrderDetail(html(model), ORDER)).toThrow('INVALID_QUANTITY');
    }
  );

  test.each(['', undefined, '已取货', 'https://example.com', 'owner@example.com'])(
    '缺失或非枚举详情状态不能变成成功：%s',
    status => {
      const model = detailModel();
      model.orderDetail.orderItems[KEYS[0]].orderItemStatusTracker.d.currentStatus = status;
      expect(() => parseOfficialOrderDetail(html(model), ORDER)).toThrow('INCOMPLETE_CORE_FIELDS');
    }
  );

  test('未知合法状态枚举原样保留，不推断业务状态', () => {
    const model = detailModel();
    model.orderDetail.orderItems[KEYS[0]].orderItemStatusTracker.d.currentStatus =
      'NEW_OFFICIAL_STATE';
    expect(parseOfficialOrderDetail(html(model), ORDER).products[0].rawStatus).toBe(
      'NEW_OFFICIAL_STATE'
    );
  });

  test.each(['missing', 'duplicate', 'unlisted'])('商品集合缺项、重复或未列出都失败：%s', kind => {
    const model = detailModel();
    const items = model.orderDetail.orderItems;
    if (kind === 'missing') delete items[KEYS[1]];
    if (kind === 'duplicate') items.c = [KEYS[0], KEYS[0]];
    if (kind === 'unlisted') items.c = [KEYS[0]];
    expect(() => parseOfficialOrderDetail(html(model), ORDER)).toThrow('INCOMPLETE_ITEMS');
  });

  test('多份模型、过深对象和过大响应拒绝解析', () => {
    expect(() =>
      parseOfficialOrderDetail(html(detailModel()) + html(detailModel()), ORDER)
    ).toThrow('AMBIGUOUS_MODEL');
    let nested = detailModel();
    for (let index = 0; index < 15; index += 1) nested = { child: nested };
    expect(() => parseOfficialOrderDetail(JSON.stringify(nested), ORDER)).toThrow('MODEL_LIMIT');
    expect(() => parseOfficialOrderDetail('x'.repeat(8 * 1024 * 1024 + 1), ORDER)).toThrow(
      'INVALID_BODY'
    );
  });

  test('列表只保留短名与状态原文，不宣称完整规格或详情枚举', () => {
    const result = parseOfficialOrderList(html(listModel()), ORDER);
    expect(result.sourceModel).toBe('orderList');
    expect(result.completeItemCount).toBe(2);
    expect(result.products[0]).toMatchObject({
      name: '测试设备',
      quantity: 1,
      rawStatusText: '已取货 9月 30',
      statusSourceField: 'deliveryDate',
    });
    expect(result.products[0].rawStatus).toBeUndefined();
    expect(result.products[0].detailUrl).not.toBe(result.products[1].detailUrl);
  });

  test('列表中没有目标订单返回 null，不取其他订单代替', () => {
    expect(parseOfficialOrderList(html(listModel()), OTHER_ORDER)).toBeNull();
  });

  test('列表身份异常、缺商品和空状态原文均拒绝', () => {
    const model = listModel();
    const order = model.orderList[`order-${ORDER}`];
    order.d.webOrderNumber = OTHER_ORDER;
    expect(() => parseOfficialOrderList(html(model), ORDER)).toThrow('IDENTITY_MISMATCH');
    order.d.webOrderNumber = ORDER;
    order['10000001'].d.deliveryDate = '';
    expect(() => parseOfficialOrderList(html(model), ORDER)).toThrow('INCOMPLETE_CORE_FIELDS');
    delete order['10000002'];
    expect(() => parseOfficialOrderList(html(model), ORDER)).toThrow('INCOMPLETE_ITEMS');
  });

  test('拒绝无效输入，缺模型商品结构和非法名称', () => {
    expect(() => parseOfficialOrderDetail('{}', 'bad')).toThrow('INVALID_EXPECTED_ORDER');
    expect(() => parseOfficialOrderDetail(null, ORDER)).toThrow('INVALID_BODY');
    const model = detailModel();
    model.orderDetail.orderItems = [];
    expect(() => parseOfficialOrderDetail(html(model), ORDER)).toThrow('INVALID_ITEMS');
    const other = detailModel();
    other.orderDetail.orderItems[KEYS[0]].orderItemDetails.d.productName = 'owner@example.com';
    expect(() => parseOfficialOrderDetail(html(other), ORDER)).toThrow('INCOMPLETE_CORE_FIELDS');
  });
});
