const input = require('../src/utils/proxyOrderInput');
const account = { appleId: 'synthetic-payment@example.com', password: 'Synthetic-Payment' };
const source = payment =>
  `姓名：张三\n身份证后四位：000X\n手机号：13800000001\n邮箱：synthetic-payment@example.com\n机型：Duo 白 256G\n取机城市：重庆\n订单来源：付款别名独立验收\n支付方式：${payment}`;
// 软件值独立固定，避免测试从待测映射表生成预期。
const banks = [
  ['招行', '招商银行', ['installments0001321713-2', 'installments0001321713']],
  ['建行', '建设银行', ['installments0000882476-2', 'installments0000882476']],
  ['工行', '工商银行', ['installments0000833448-2', 'installments0000833448']],
];
const accepted = [];
for (const [shortName, fullName, codes] of banks) {
  for (const name of [shortName, fullName]) {
    for (const [index, periods] of [12, 24].entries()) {
      for (const installment of ['', '分期']) {
        const text = `${name}${installment}${periods}期`;
        accepted.push([text, `${shortName}${periods}期`, codes[index]]);
        accepted.push([
          ` ${name} ${installment} ${periods} 期 `,
          `${shortName}${periods}期`,
          codes[index],
        ]);
        accepted.push([
          `\u3000${name}\u3000${installment}\u3000${String(periods).replace(/\d/g, value => String.fromCharCode(value.charCodeAt(0) + 65248))}\u3000期\u3000`,
          `${shortName}${periods}期`,
          codes[index],
        ]);
      }
    }
  }
}
const rejected = [
  '招商银行',
  '招商银行分期',
  '招行期',
  '建设银行分期',
  '工商银行',
  '招商银行6期',
  '建设银行36期',
  '工商银行0期',
  '招商银行１２期/２４期',
  '招商银行12/24期',
  '招商银行12期或24期',
  '招商银行12期 建设银行12期',
  '招行24期|工行24期',
  '微信或招行24期',
  '招商银行分期24期 支付宝',
  '招商银行分期24期（或12期）',
  '中国银行24期',
  '交通银行分期12期',
  '银行分期24期',
  '招商银行分期24期免息待确认',
  '花呗24期免息',
  '花呗12期免息或24期',
];

describe('代抢付款银行别名独立验收', () => {
  test.each(accepted)('%s → %s，解析/结构化草稿/软件码一致', (text, canonical, code) => {
    const preview = input.parseProxyText(source(text));
    expect(preview.errors).toEqual([]);
    expect(preview.canSave).toBe(true);
    expect(preview.draft.paymentMethod).toBe(canonical);
    const normalized = input.validateProxyInput({ ...preview.draft, paymentMethod: text });
    expect(normalized.paymentMethod).toBe(canonical);
    for (const draft of [preview.draft, normalized, { ...normalized, paymentMethod: text }]) {
      const columns = input.buildProxyTemplate(draft, account).split(',');
      expect(columns[22]).toBe(code);
      expect(columns.filter(value => value.startsWith('installments'))).toEqual([code]);
      expect(columns[columns.length - 4]).toBe('代抢 付款别名独立验收');
    }
  });

  test.each(rejected)('不完整/未知/歧义付款不猜测：%s', text => {
    const preview = input.parseProxyText(source(text));
    expect(preview.canSave).toBe(false);
    expect(preview.errors.length).toBeGreaterThan(0);
    expect(() =>
      input.validateProxyInput({
        ...input.parseProxyText(source('微信')).draft,
        paymentMethod: text,
      })
    ).toThrow();
    expect(() =>
      input.buildProxyTemplate(
        { ...input.parseProxyText(source('微信')).draft, paymentMethod: text },
        account
      )
    ).toThrow();
  });

  test('花呗12期免息统一为既有花呗12期软件码', () => {
    const preview = input.parseProxyText(source('花呗12期免息'));
    expect(preview.canSave).toBe(true);
    expect(preview.draft.paymentMethod).toBe('花呗12期');
    const normalized = input.validateProxyInput({
      ...preview.draft,
      paymentMethod: '花呗12期免息',
    });
    expect(normalized.paymentMethod).toBe('花呗12期');
    expect(input.buildProxyTemplate(normalized, account).split(',')[22]).toBe(
      'installments0001243254'
    );
  });
  test('多个支付标签冲突时拒绝而非取最后一个', () => {
    expect(() => input.parseProxyText(source('招行24期') + '\n支付方式：建行12期')).toThrow();
  });

  test.each([
    ['微信', 'WECHAT'],
    ['支付宝', 'ALIPAY'],
    ['花呗12期', 'installments0001243254'],
  ])('既有非银行支付%s保持正确码', (payment, code) => {
    const preview = input.parseProxyText(source(payment));
    expect(preview.canSave).toBe(true);
    expect(input.buildProxyTemplate(preview.draft, account).split(',')[22]).toBe(code);
  });
});

describe('Duo黑白俗称独立验收（不改变Pro/Pro Max）', () => {
  test.each([
    ['iPhone Duo 黑色 512GB, 1台', '夜空色', '512GB', 'iPhone Duo 夜空色 512G'],
    ['Duo 黑 256G', '夜空色', '256GB', 'iPhone Duo 夜空色 256G'],
    ['iPhone Duo 白色 1TB', '星光白色', '1TB', 'iPhone Duo 星光白色 1T'],
    ['Duo 白 512G', '星光白色', '512GB', 'iPhone Duo 星光白色 512G'],
    ['18 Pro Max 黑色 256GB', '黑色', '256GB', 'iPhone 18 Pro Max 黑色 256G'],
  ])('%s解析/保存规范化/模板颜色一致', (product, color, storage, name) => {
    const preview = input.parseProxyText(
      source('招商银行分期24期').replace('Duo 白 256G', product)
    );
    expect(preview.canSave).toBe(true);
    expect(preview.errors).toEqual([]);
    expect(preview.draft.productCandidates).toHaveLength(1);
    expect(preview.draft.productCandidates[0]).toMatchObject({ color, storage });
    const rawColor = product.includes('黑') ? '黑色' : '白色';
    const normalized = input.validateProxyInput({
      ...preview.draft,
      productCandidates: [{ ...preview.draft.productCandidates[0], color: rawColor }],
    });
    expect(normalized.productCandidates[0].color).toBe(color);
    expect(input.buildProxyTemplate(normalized, account).split(',')[3]).toBe(name);
  });
  test('Duo黑色数量2台不被误判第二型号，两个数量仍拒绝', () => {
    const two = input.parseProxyText(
      source('微信').replace('Duo 白 256G', 'iPhone Duo 黑色 512GB, 2台')
    );
    expect(two.canSave).toBe(true);
    expect(two.draft.quantity).toBe(2);
    expect(input.buildProxyTemplate(two.draft, account).split(',')[4]).toBe('2');
    const ambiguous = input.parseProxyText(
      source('微信').replace('Duo 白 256G', 'iPhone Duo 黑色 512GB, 1台 2台')
    );
    expect(ambiguous.canSave).toBe(false);
  });
  test('18 Pro黑保留黑，未核实组合不借别名扩大目录', () => {
    expect(input.parseProduct('18 Pro 黑色 512GB').color).toBe('黑色');
    expect(input.normalizeProxyProduct('iPhone 18 Pro', '黑色').color).toBe('黑色');
    expect(
      input.parseProxyText(source('微信').replace('Duo 白 256G', '18 Pro 黑色 512GB')).canSave
    ).toBe(false);
  });
  test('黑白两个完整候选分别规范，软件名保留两个候选', () => {
    const preview = input.parseProxyText(
      source('微信').replace('Duo 白 256G', 'Duo 黑 512G | Duo 白色 1TB')
    );
    expect(preview.canSave).toBe(true);
    expect(preview.draft.productCandidates.map(candidate => candidate.color)).toEqual([
      '夜空色',
      '星光白色',
    ]);
    expect(input.buildProxyTemplate(preview.draft, account).split(',')[3]).toBe(
      'iPhone Duo 夜空色 512G|iPhone Duo 星光白色 1T'
    );
  });
  test.each([
    'Duo 黑蓝 512G',
    'Duo 黑色 蓝色 512G',
    'Duo 黑色 512G | Duo 未知色 1TB',
    'Duo 黑色 512G 1台 | Duo 白色 1TB 2台',
    'Duo 黑色 512G iPhone 18 Pro Max',
  ])('未知或混合颜色拒绝：%s', product => {
    const preview = input.parseProxyText(source('微信').replace('Duo 白 256G', product));
    expect(preview.canSave).toBe(false);
    expect(preview.errors.length).toBeGreaterThan(0);
  });
});

describe('代抢付款真实HTTP实际路由/服务验收（合成身份与重复查询）', () => {
  let models, server, origin;
  beforeAll(async () => {
    models = require('../src/models');
    jest.spyOn(models.ProxyOrder, 'findAll').mockResolvedValue([]);
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 1, role: 'operator', permissions: ['proxy_orders.read'] };
      next();
    });
    app.use('/api/proxy-orders', require('../src/routes/proxyOrders'));
    app.use(require('../src/middleware/errorHandler'));
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (models) {
      models.ProxyOrder.findAll.mockRestore();
      await models.sequelize.close();
    }
  });
  test.each([
    ['招商银行分期24期', '招行24期', true],
    ['\u3000建设银行\u3000分期\u3000１２\u3000期\u3000', '建行12期', true],
    ['工商银行24期', '工行24期', true],
    ['招商银行分期', null, false],
    ['招行12期或24期', null, false],
    ['招商银行分期24期', '招行24期', true, 'iPhone Duo 黑色 512GB, 1台'],
    ['微信', '微信', true, 'Duo 黑色 512GB | Duo 白色 1TB'],
    ['花呗12期免息', '花呗12期', true],
  ])('POST /parse %s', async (payment, canonical, canSave, product = null) => {
    try {
      const response = await fetch(origin + '/api/proxy-orders/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: product ? source(payment).replace('Duo 白 256G', product) : source(payment),
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.data.canSave).toBe(canSave);
      if (canonical) {
        expect(body.data.draft.paymentMethod).toBe(canonical);
        expect(Array.isArray(body.data.duplicates)).toBe(true);
      } else expect(body.data.errors.length).toBeGreaterThan(0);
    } catch (error) {
      throw new Error(`付款HTTP验收失败：${error.message}`);
    }
  });
});
