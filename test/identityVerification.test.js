/* eslint-disable camelcase -- 供应商响应固定使用 error_code */
const XLSX = require('xlsx');
const axios = require('axios');
jest.mock('axios');
const input = require('../src/services/identityInputService');
const provider = require('../src/services/identityProviderService');

// 合成格式样本只在进程内验证；不会发送到真实供应商。
const CARD = '110101199001010015';
function workbook(rows, mutate) {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['姓名', '身份证号'], ...rows]);
  if (mutate) mutate(sheet);
  XLSX.utils.book_append_sheet(book, sheet, '身份核验');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

describe('身份核验输入和原始导出', () => {
  test('合法证件、空姓名、日期和校验位分别检查', () => {
    expect(input.validateIdentity('合成测试', CARD)).toBeNull();
    expect(input.validateIdentity('', CARD)).toMatch(/姓名/);
    expect(input.validateIdentity('合成测试', Number(CARD))).toMatch(/文本/);
    expect(input.validateIdentity('合成测试', '110101199002310010')).toMatch(/日期/);
    expect(input.validateIdentity('合成测试', CARD.slice(0, 17) + '1')).toMatch(/校验位/);
  });
  test('保留原始行与原文，规范化同一组合去重，同证件不同姓名分别处理', () => {
    const result = input.parseIdentityWorkbook(
      workbook([
        [' 合成测试 ', CARD],
        [null, null],
        ['合成测试', CARD],
        ['另一合成姓名', CARD],
      ])
    );
    expect(result.summary).toEqual({ total: 3, valid: 2, duplicates: 1, empty: 1, invalid: 0 });
    expect(result.rows[0].name).toBe(' 合成测试 ');
    expect(result.rows[1]).toMatchObject({ rowNumber: 4, duplicateOf: 2, status: 'duplicate' });
  });
  test('数字型身份证与公式拒绝，不推测号码', () => {
    const result = input.parseIdentityWorkbook(
      workbook(
        [
          ['测试', Number(CARD)],
          ['测试', CARD],
        ],
        sheet => {
          sheet.B3.f = '"110101199001010015"';
        }
      )
    );
    expect(result.summary.invalid).toBe(2);
    expect(result.rows[0].message).toMatch(/精度/);
    expect(result.rows[1].message).toMatch(/公式/);
  });
  test('空文件、伪装文件、缺失表头和超量拒绝', () => {
    expect(() => input.parseIdentityWorkbook(Buffer.from('not xlsx'))).toThrow(/无法读取/);
    expect(() => input.parseIdentityWorkbook(workbook([]))).toThrow(/没有/);
    expect(() =>
      input.parseIdentityWorkbook(
        workbook([['测试', CARD]], sheet => {
          sheet.A1.v = '姓名错误';
        })
      )
    ).toThrow(/第一行/);
    expect(() =>
      input.parseIdentityWorkbook(workbook(Array.from({ length: 1001 }, () => ['测试', CARD])))
    ).toThrow(/1000/);
  });
  test('导出号码精确为文本；等号姓名不会转为公式，保留原始字段', () => {
    const buffer = input.exportIdentityWorkbook([
      {
        rowNumber: 2,
        name: '=1+1',
        idCardNumber: CARD,
        status: 'matched',
        resultData: { area: '测试地区', sn: 'test-sn' },
      },
    ]);
    const sheet = XLSX.read(buffer, { type: 'buffer' }).Sheets['核验结果'];
    expect(sheet.B2).toMatchObject({ t: 's', v: '=1+1' });
    expect(sheet.B2.f).toBeUndefined();
    expect(sheet.C2).toMatchObject({ t: 's', v: CARD });
    expect(sheet.D2.v).toBe('一致');
  });
});

describe('供应商映射与一次请求边界', () => {
  beforeEach(() => {
    delete process.env.IDENTITY_APPCODE_FILE;
    delete process.env.IDENTITY_APPCODE;
  });
  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.IDENTITY_APPCODE;
    delete process.env.IDENTITY_VERIFICATION_ENABLED;
  });
  test.each([true, false])('业务isok=%s才决定身份是否一致', isok => {
    const result = provider.mapResponse({ status: 200, data: { error_code: 0, result: { isok } } });
    expect(result.status).toBe(isok ? 'matched' : 'mismatched');
  });
  test.each([
    {},
    { error_code: 0 },
    { error_code: 0, result: { isok: 'false' } },
    { error_code: 99, reason: CARD },
  ])('未知结构不误报不一致 %j', data => {
    const result = provider.mapResponse({ status: 200, data });
    expect(result.status).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain(CARD);
  });
  test('额度耗尽与鉴权失败暂停，原始错误不泄漏', () => {
    expect(
      provider.mapResponse({ status: 403, headers: { 'x-ca-error-message': 'Quota Exhausted' } })
    ).toMatchObject({ fatal: true, message: '套餐额度不足，已暂停队列' });
    expect(provider.mapResponse({ status: 401 })).toMatchObject({ fatal: true });
    expect(provider.mapResponse({ status: 429 })).toMatchObject({ fatal: true });
    expect(provider.mapResponse({ status: 500 })).toMatchObject({ status: 'unknown' });
  });
  test('白名单保存供应商附加字段，不保存身份证回显或任意字段', () => {
    const result = provider.mapResponse({
      status: 200,
      data: {
        error_code: 0,
        sn: 'sn-1',
        result: {
          isok: true,
          idcard: CARD,
          IdCardInfor: { sex: '男', birthday: '1990-01-01', area: '测试地区', other: CARD },
        },
      },
    });
    expect(result.resultData).toEqual({
      sn: 'sn-1',
      sex: '男',
      birthday: '1990-01-01',
      area: '测试地区',
    });
  });
  test('POST表单编码、固定HTTPS地址、不走代理或重定向，超时只请求一次', async () => {
    process.env.IDENTITY_APPCODE = 'syntheticAppCodeForLocalTestOnly';
    axios.post.mockRejectedValueOnce(new Error(`timeout ${CARD}`));
    const result = await provider.verifyIdentity('测试姓名', CARD);
    expect(result.status).toBe('unknown');
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, body, options] = axios.post.mock.calls[0];
    expect(url).toBe('https://zidv2.market.alicloudapi.com/idcheck/Post');
    expect(new URLSearchParams(body).get('realName')).toBe('测试姓名');
    expect(options).toMatchObject({ maxRedirects: 0, proxy: false, timeout: 8000 });
    expect(JSON.stringify(result)).not.toContain(CARD);
  });
  test('缺配置不外呼，就绪接口不暴露AppCode', async () => {
    const result = await provider.verifyIdentity('测试', CARD);
    expect(result.fatal).toBe(true);
    expect(axios.post).not.toHaveBeenCalled();
    expect(provider.getStatus().configured).toBe(false);
    process.env.IDENTITY_APPCODE = 'syntheticAppCodeForLocalTestOnly';
    expect(JSON.stringify(provider.getStatus())).not.toContain('synthetic');
  });
});
