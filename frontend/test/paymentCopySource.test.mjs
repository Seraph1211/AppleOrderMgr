import test from 'node:test';
import assert from 'node:assert/strict';
import { readPaymentCopyText } from '../src/utils/paymentCopySource.js';
import { decodePaymentQr } from '../src/utils/paymentQr.js';

const task = { id: 1, orderId: 101, orderNumber: 'W0000000001', paymentMethod: '微信' };
const code =
  (availability, imageDataUrl = 'synthetic-image') =>
  async () => ({
    success: true,
    data: { availability, imageDataUrl },
  });
const link = async () => ({ success: true, data: { paymentUrl: 'https://example.com/order' } });

test('识读成功复制原始微信支付地址，不读取订单链接', async () => {
  const value = 'weixin://wxpay/bizpayurl?pr=SYNTHETIC_ONLY';
  const result = await readPaymentCopyText(
    task,
    code('available'),
    () => {
      assert.fail('不应读取订单链接');
    },
    async image => {
      assert.equal(image, 'synthetic-image');
      return value;
    }
  );
  assert.equal(result, `101 || - || 微信 || - || ${value}`);
});

for (const availability of ['missing', 'unsupported', 'available']) {
  test(`${availability} 无法取得支付地址时回退订单链接`, async () => {
    const result = await readPaymentCopyText(task, code(availability), link, async () => null);
    assert.ok(result.endsWith(' || https://example.com/order'));
  });
}

test('付款码 API 权限拒绝、转派或网络失败不回退订单链接', async () => {
  for (const message of ['权限不足', '任务已转派', '网络错误']) {
    await assert.rejects(
      readPaymentCopyText(
        task,
        async () => {
          throw new Error(message);
        },
        () => {
          assert.fail('API 错误不得伪装成缺码');
        }
      ),
      new RegExp(`W0000000001：${message}`)
    );
  }
});

test('非法响应不回退，缺失原订单链接明确失败', async () => {
  for (const response of [{ success: false }, { success: true, data: {} }]) {
    await assert.rejects(
      readPaymentCopyText(task, async () => response, link),
      /付款码读取失败/
    );
  }
  await assert.rejects(
    readPaymentCopyText(task, code('missing'), async () => ({
      success: true,
      data: {},
    })),
    /订单链接不存在/
  );
});

test('不加载外部图片、非 PNG 和超大载荷', async () => {
  for (const value of [
    null,
    'https://example.com/code.png',
    'data:image/svg+xml;base64,AAAA',
    'data:image/png;base64,' + 'A'.repeat(180000),
  ]) {
    assert.equal(await decodePaymentQr(value), null);
  }
});

for (const paymentMethod of [
  '支付宝',
  '花呗12期',
  '招行12期',
  '招行24期',
  '建行12期',
  '建行24期',
  '工行12期',
  '工行24期',
  '微信分付12期',
  '微信分付24期',
  '支付宝银行12期',
  '支付宝银行24期',
  'VISA',
  'MASTERCARD',
]) {
  test(`${paymentMethod} 直接复制订单链接，不读码且保留完整名称`, async () => {
    const result = await readPaymentCopyText(
      { ...task, paymentMethod },
      () => assert.fail('非微信不得读码'),
      link,
      () => assert.fail('非微信不得识读二维码')
    );
    assert.equal(result, `101 || - || ${paymentMethod} || - || https://example.com/order`);
  });
}
test('非微信原订单链接接口拒绝或失败不能复制', async () => {
  for (const message of ['权限不足', '任务已转派', '网络错误']) {
    await assert.rejects(
      readPaymentCopyText(
        { ...task, paymentMethod: '招行24期' },
        () => assert.fail('非微信不得读码'),
        async () => {
          throw new Error(message);
        }
      ),
      new RegExp(message)
    );
  }
});
