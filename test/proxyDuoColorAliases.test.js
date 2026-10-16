const {
  parseProxyText,
  parseProduct,
  validateProxyInput,
  buildProxyTemplate,
} = require('../src/utils/proxyOrderInput');
const source = model =>
  `姓名：合成\n身份证后四位：000X\n手机号：13800000000\n邮箱：synthetic@example.com\n机型：${model}\n取机城市：重庆\n订单来源：闲鱼\n支付方式：微信`;
const account = { appleId: 'synthetic@example.com', password: 'Synthetic-Password' };

describe('Duo黑白颜色别名', () => {
  test.each([
    ['黑', '夜空色'],
    ['黑色', '夜空色'],
    ['白', '星光白色'],
    ['白色', '星光白色'],
  ])('Duo %s的预览、保存、模板统一为%s', (alias, canonical) => {
    const text = source(`iPhone Duo ${alias} 512GB, 1台`);
    const preview = parseProxyText(text);
    expect(preview.canSave).toBe(true);
    expect(preview.draft.color).toBe(canonical);
    expect(preview.draft.rawText).toBe(text);
    expect(preview.draft.productCandidates).toEqual([
      { productModel: 'iPhone Duo', color: canonical, storage: '512GB' },
    ]);
    expect(
      validateProxyInput({ ...preview.draft, productCandidates: undefined, color: alias }).color
    ).toBe(canonical);
    expect(
      buildProxyTemplate(
        { ...preview.draft, productCandidates: undefined, color: alias },
        account
      ).split(',')[3]
    ).toBe(`iPhone Duo ${canonical} 512G`);
  });
  test('显式数量不误判为第二个型号，多个数量仍拒绝', () => {
    expect(parseProxyText(source('Duo 黑色 512GB, 2台')).draft.quantity).toBe(2);
    expect(parseProxyText(source('Duo 黑色 512GB, 2台')).canSave).toBe(true);
    expect(parseProxyText(source('Duo 黑色 512GB, 1台 2台')).canSave).toBe(false);
    expect(parseProxyText(source('Duo 黑色 512GB, 2台与3台')).canSave).toBe(false);
    expect(parseProxyText(source('Duo 黑色 512GB, 2台 | Duo 白色 512GB, 3台')).canSave).toBe(false);
    expect(parseProxyText(source('Duo 黑色 512GB | 18PM 银色 256GB')).canSave).toBe(true);
  });
  test('多个Duo黑白候选以半角竖线统一生成完整软件名称', () => {
    const preview = parseProxyText(source('Duo 黑 256G | iPhone Duo 白色 512GB | Duo 夜空色 1T'));
    expect(preview.canSave).toBe(true);
    expect(preview.draft.productCandidates.map(candidate => candidate.color)).toEqual([
      '夜空色',
      '星光白色',
      '夜空色',
    ]);
    expect(buildProxyTemplate(preview.draft, account).split(',')[3]).toBe(
      'iPhone Duo 夜空色 256G|iPhone Duo 星光白色 512G|iPhone Duo 夜空色 1T'
    );
  });
  test.each(['18 Pro', '18 Pro Max'])('18系列%s黑色仍为黑色，白色仍不猜测银色', model => {
    expect(parseProduct(`iPhone ${model} 黑色 512GB`).color).toBe('黑色');
    expect(parseProxyText(source(`iPhone ${model} 白色 512GB`)).canSave).toBe(false);
  });
});
