const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../src/models', () => ({ AppleId: {}, Recipient: {}, sequelize: {} }));
const { buildImportPlan } = require('../src/services/profileImportService');
const { parseExcelFile } = require('../src/services/importService');
const { matchRecipient } = require('../src/services/profileOrderMatching');
const { recipientInput, validateAccountText } = require('../src/utils/profileInput');
const { blindIndex } = require('../src/utils/fieldEncryption');
const idCard = '110101199001010001';
const data = { lastName: '欧阳', firstName: '明', idCardNumber: idCard };
const empty = { accounts: [], recipients: [] };
const row = (values, number = 2) => ({
  fileName: '合成.xlsx',
  sheetName: '北京',
  rowNumber: number,
  data: values,
});

function readBook(sheets, type) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-unit-'));
  try {
    const book = XLSX.utils.book_new();
    for (const [name, rows] of Object.entries(sheets))
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
    const file = path.join(dir, 'synthetic.xlsx');
    XLSX.writeFile(book, file);
    return parseExcelFile(file, type);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('跨表去重和差异裁定', () => {
  test('复姓保留，同身份证归一，同名不同身份证独立', () => {
    const plan = buildImportPlan(
      [row(data), row(data, 3), row({ ...data, idCardNumber: '110101199001010002' })],
      'recipients',
      empty
    );
    expect(plan.summary).toMatchObject({ total: 3, records: 2, conflicts: 0 });
    expect(plan.writes[0].data.lastName).toBe('欧阳');
    expect(plan.records[0].sources).toHaveLength(2);
  });
  test('同身份证异名不静默采用，跳过整条后不写入', () => {
    const rows = [row(data), row({ ...data, firstName: '亮' }, 5)];
    const plan = buildImportPlan(rows, 'recipients', empty);
    expect(plan.summary.conflicts).toBe(1);
    const skip = buildImportPlan(rows, 'recipients', empty, { 'g0:skip': true });
    expect(skip.summary.conflicts).toBe(0);
    expect(skip.writes).toHaveLength(0);
    const resolved = buildImportPlan(rows, 'recipients', empty, { 'g0:firstName': 'source1' });
    expect(resolved.writes[0].data.firstName).toBe('亮');
    expect(resolved.summary.conflicts).toBe(0);
  });
  test('非空库值与来源差异需确认；空来源不擦除备注或状态', () => {
    const profiles = {
      accounts: [],
      recipients: [
        { id: 1, ...data, idCardHash: blindIndex(idCard), notes: '已有备注', status: '异常' },
      ],
    };
    const plan = buildImportPlan([row({ ...data, notes: '' })], 'recipients', profiles);
    expect(plan.writes[0].data).toMatchObject({ notes: '已有备注', status: '异常' });
    expect(plan.records[0].action).toBe('重复');
  });
  test('缺密码的未知绑定、跨人共用账号明确阻断', () => {
    const unknown = buildImportPlan(
      [row({ ...data, appleId: 'unknown@example.invalid' })],
      'recipients',
      empty
    );
    expect(unknown.summary.blocked).toBe(1);
    const collision = buildImportPlan(
      [
        row({ ...data, appleId: 'a@example.invalid', password: 'synthetic' }),
        row({
          ...data,
          idCardNumber: '110101199001010002',
          appleId: 'a@example.invalid',
          password: 'synthetic',
        }),
      ],
      'recipients',
      empty
    );
    expect(collision.summary.blocked).toBe(1);
    const skipped = buildImportPlan(
      [
        row({ ...data, appleId: 'a@example.invalid', password: 'synthetic' }),
        row({
          ...data,
          idCardNumber: '110101199001010002',
          appleId: 'a@example.invalid',
          password: 'synthetic',
        }),
      ],
      'recipients',
      empty,
      { 'g2:skip': true }
    );
    expect(skipped.summary.blocked).toBe(0);
  });
  test('密码密保预览不泄密，非法决策不能裁定差异', () => {
    const profiles = {
      accounts: [{ id: 1, appleId: 'a@example.invalid', password: 'old-sensitive' }],
      recipients: [],
    };
    const plan = buildImportPlan(
      [row({ appleId: 'a@example.invalid', password: 'new-sensitive' })],
      'apple_ids',
      profiles,
      { 'g0:password': 'invented' }
    );
    expect(JSON.stringify({ conflicts: plan.conflicts, records: plan.records })).not.toMatch(
      /old-sensitive|new-sensitive/
    );
    expect(plan.summary.conflicts).toBe(1);
  });
  test('原始 TAG 包括空白保持原样，不拆分重拼', () => {
    const tag = ' 北京 负责人 ';
    expect(recipientInput({ ...data, tag }, true).tag).toBe(tag);
    const rows = readBook(
      {
        北京: [
          ['姓', '名', '身份证号', 'TAG'],
          ['欧阳', '明', idCard, tag],
        ],
      },
      'recipients'
    );
    expect(rows[0].data.tag).toBe(tag);
  });
  test('账号输入边界在预览及手工写入前拒绝', () => {
    for (const payload of [
      { country: {} },
      { country: '国'.repeat(51) },
      { notes: '注'.repeat(10001) },
      { password: 123 },
    ])
      expect(() => validateAccountText(payload)).toThrow('格式或长度无效');
    const plan = buildImportPlan(
      [row({ appleId: 'a@example.invalid', password: 'synthetic', country: '国'.repeat(51) })],
      'apple_ids',
      empty
    );
    expect(plan.errors).toHaveLength(1);
    expect(plan.writes).toHaveLength(0);
  });
  test('下单邮箱只接受 vvv8.net，真实电话独立；异常状态保留', () => {
    expect(
      recipientInput(
        { ...data, email: '13800000000@vvv8.net', status: '异常', realPhone: '' },
        true
      )
    ).toMatchObject({ status: '异常', realPhone: null });
    expect(() => recipientInput({ ...data, email: '13800000000@8lvv.com' }, true)).toThrow(
      '@vvv8.net'
    );
  });
});

describe('腾讯源表位置映射', () => {
  test('只取 26 年账号，K 状态，大陆 L 备注，香港地区已改中国', () => {
    const headers = [
      'Apple ID',
      '密码',
      '国家',
      '问题',
      '答案',
      '问题',
      '答案',
      '问题',
      '答案',
      '使用状态',
      '使用状态',
      '备注',
      '状态',
    ];
    const main = [
      'a@example.invalid',
      '00001234',
      '中国',
      130,
      '甲',
      136,
      '乙',
      142,
      '丙',
      '忽略J',
      '异常',
      '真实备注',
      '忽略M',
    ];
    const hk = [
      'b@example.invalid',
      '00005678',
      '香港',
      130,
      '丁',
      136,
      '戊',
      142,
      '己',
      '忽略J',
      '已下架',
      '不可作备注',
    ];
    const rows = readBook(
      {
        '26年AppleID（中国大陆': [headers, main],
        '26年AppleID（香港': [headers, hk],
        '25年AppleID': [headers, main],
      },
      'apple_ids'
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].data).toMatchObject({
      password: '00001234',
      country: '中国',
      question1: '130',
      question2: '136',
      question3: '142',
      status: '异常',
      notes: '真实备注',
    });
    expect(rows[1].data).toMatchObject({ country: '中国', status: '已下架' });
    expect(rows[1].data.notes).toBeUndefined();
  });
  test('多渠道表、状态映射、不保留原状态，数字身份证拒绝', () => {
    const headers = ['姓', '名', '身份证号码', '使用状态', 'TAG'];
    const rows = readBook(
      {
        北京: [headers, ['欧阳', '明', idCard, '已挂服务器', '原TAG']],
        重庆: [
          headers,
          ['欧阳', '明', idCard, '已进表 未挂', '原TAG'],
          ['测', '试', Number('110101199001010001'), '未使用', ''],
          ['欧阳', '明', idCard, '已挂 需下架', '原TAG'],
        ],
      },
      'recipients'
    );
    expect(rows[0].data.status).toBe('使用中');
    expect(rows[1].data.status).toBe('未使用');
    expect(JSON.stringify(rows)).not.toContain('已挂服务器');
    expect(rows[2].issues[0].field).toBe('idCardNumber');
    expect(rows[3].data.status).toBe('使用中');
    expect(JSON.stringify(rows)).not.toContain('已挂 需下架');
  });
});

describe('订单自身证据与歧义防误配', () => {
  const person = {
    id: 1,
    ...data,
    idCardHash: blindIndex(idCard),
    idCardLast4: '0001',
    phone: '13800000000',
    email: '13800000000@vvv8.net',
  };
  test('复姓全名加尾号唯一可关联，仅姓名或当前绑定不行', () => {
    expect(matchRecipient({ recipientName: '欧阳明', recipientIdLast4: '0001' }, [person])).toBe(
      person
    );
    expect(matchRecipient({ recipientName: '欧阳明', appleIdRef: 1 }, [person])).toBeNull();
    expect(
      matchRecipient({ recipientName: '欧阳明', recipientIdLast4: '0001' }, [
        person,
        { ...person, id: 2 },
      ])
    ).toBeNull();
  });
  test('完整证件优先；AOS 联系信息冲突拒绝', () => {
    expect(matchRecipient({ recipientName: '欧阳明', recipientIdCard: idCard }, [person])).toBe(
      person
    );
    expect(
      matchRecipient(
        {
          recipientName: '欧阳明',
          ingestionSource: 'aos',
          recipientPhone: person.phone,
          recipientEmail: 'different@vvv8.net',
        },
        [person]
      )
    ).toBeNull();
    expect(
      matchRecipient(
        {
          recipientName: '欧阳明',
          ingestionSource: 'aos',
          recipientPhone: person.phone,
          recipientEmail: person.email,
        },
        [person]
      )
    ).toBe(person);
  });
});
