const {
  parseOfficialReceipt,
  extractOfficialReceiptUrl,
} = require('../src/services/officialOrderReceipt');

const order = 'W123456789';
function fixture() {
  return {
    orderInvoices: {
      c: ['orderInvoice-1'],
      'orderInvoice-1': {
        invoiceOrderSummary: { d: { orderNumber: order } },
        invoiceLineItems: {
          c: ['invoiceLineItem-1'],
          'invoiceLineItem-1': {
            d: {
              hasLineItemSerialInfo: true,
              lineItemSerialInfo: ['A123456789', 'B123456789'],
              partNumber: 'TESTCH/A',
              productName: '测试设备',
              quantityOrdered: '2',
              quantityShipped: '2',
            },
          },
        },
      },
    },
  };
}
function line(model) {
  return model.orderInvoices['orderInvoice-1'].invoiceLineItems['invoiceLineItem-1'].d;
}
function parse(model) {
  return parseOfficialReceipt(JSON.stringify(model), order, 2);
}
test('完整收据精确提取两个 SN，不改变字符', () => {
  expect(parse(fixture()).items.map(item => item.serialNumber)).toEqual([
    'A123456789',
    'B123456789',
  ]);
});
test('读取 HTML JSON，忽略普通脚本', () => {
  expect(
    parseOfficialReceipt(
      '<script>alert(1)</script><script>' + JSON.stringify(fixture()) + '</script>',
      order,
      2
    ).items
  ).toHaveLength(2);
});
test.each([
  [
    '错误订单',
    model => {
      model.orderInvoices['orderInvoice-1'].invoiceOrderSummary.d.orderNumber = 'W999';
    },
  ],
  [
    '缺少行',
    model => {
      model.orderInvoices['orderInvoice-1'].invoiceLineItems.c.push('invoiceLineItem-2');
    },
  ],
  [
    '未列出的行',
    model => {
      model.orderInvoices['orderInvoice-2'] = {};
    },
  ],
  [
    '重复行',
    model => {
      model.orderInvoices.c.push('orderInvoice-1');
    },
  ],
  [
    '重复 SN',
    model => {
      line(model).lineItemSerialInfo[1] = 'A123456789';
    },
  ],
  [
    '缺少 SN',
    model => {
      line(model).lineItemSerialInfo.pop();
    },
  ],
  [
    'SN 字段未确认',
    model => {
      line(model).hasLineItemSerialInfo = false;
    },
  ],
  [
    '不完整发货',
    model => {
      line(model).quantityOrdered = '3';
    },
  ],
  [
    '全数字',
    model => {
      line(model).lineItemSerialInfo[1] = '1234567890';
    },
  ],
  [
    '空格',
    model => {
      line(model).lineItemSerialInfo[1] = ' B123456789';
    },
  ],
  [
    '小写',
    model => {
      line(model).lineItemSerialInfo[1] = 'b123456789';
    },
  ],
  [
    '缺少商品',
    model => {
      delete line(model).productName;
    },
  ],
])('%s 整体拒绝', (_, mutate) => {
  const model = fixture();
  mutate(model);
  expect(() => parse(model)).toThrow();
});
test('数量必须与详情完整数量相同', () => {
  expect(() => parseOfficialReceipt(JSON.stringify(fixture()), order, 1)).toThrow();
});
test('重复模型拒绝', () => {
  const script = '<script>' + JSON.stringify(fixture()) + '</script>';
  expect(() => parseOfficialReceipt(script + script, order, 2)).toThrow();
});
test.each(['<html>登录</html>', '%PDF-no-text', '', 'null'])('未知正文拒绝 %s', body => {
  expect(() => parseOfficialReceipt(body, order, 2)).toThrow();
});
const host = 'secure6.www.apple.com.cn';
function extract(url, number = order) {
  return extractOfficialReceiptUrl(
    JSON.stringify({
      orderDetail: { orderHeader: { d: { orderNumber: number, invoiceUrl: url } } },
    }),
    order,
    host
  );
}
test('仅提取同主机打印收据链接', () => {
  expect(extract('https://' + host + '/shop/order/print/invoice/123/Abc').hostname).toBe(host);
});
test.each([
  'https://' + host + '/shop/order/edit/fapiao/123/Abc',
  'https://example.com/shop/order/print/invoice/123/Abc',
  'https://secure7.www.apple.com.cn/shop/order/print/invoice/123/Abc',
  'https://' + host + '/shop/order/print/invoice/123/Abc?edit=1',
  'https://' + host + '/shop/order/print/invoice/123/Abc#fragment',
  undefined,
])('拒绝编辑或外域链接 %s', url => {
  expect(() => extract(url)).toThrow();
});
test('提取链接前核对订单', () => {
  expect(() => extract('https://' + host + '/shop/order/print/invoice/123/Abc', 'W99')).toThrow();
});

test('收据链接支持与详情相同的嵌套 JSON 包装，多个模型拒绝', () => {
  const data = {
    orderDetail: {
      orderHeader: {
        d: {
          orderNumber: order,
          invoiceUrl: 'https://' + host + '/shop/order/print/invoice/123/Abc',
        },
      },
    },
  };
  expect(
    extractOfficialReceiptUrl(JSON.stringify({ body: { content: data } }), order, host).hostname
  ).toBe(host);
  expect(() =>
    extractOfficialReceiptUrl(JSON.stringify({ first: data, second: data }), order, host)
  ).toThrow('AMBIGUOUS_MODEL');
});

test('嵌套收据模型仍逐项校验完整性', () => {
  expect(
    parseOfficialReceipt(JSON.stringify({ body: { data: fixture() } }), order, 2).items
  ).toHaveLength(2);
});

test('退货兼容不放宽收据自身的负数量', () => {
  const model = fixture();
  line(model).quantityOrdered = '-1';
  line(model).quantityShipped = '-1';
  expect(() => parse(model)).toThrow();
});
