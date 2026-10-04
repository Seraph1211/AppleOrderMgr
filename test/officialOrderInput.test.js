/* eslint-disable no-magic-numbers, camelcase -- 合成 SQL 字段和边界输入。 */
const fs = require('fs');
const vm = require('vm');
const { encrypt } = require('../src/utils/fieldEncryption');
const input = require('../src/services/officialOrderInput');

function row(overrides = {}) {
  return {
    id: 249,
    order_number: 'W1234567890',
    order_url: 'https://www.apple.com.cn/shop/order/list/W1234567890/contact%40example.test',
    apple_id: 'order@example.test',
    apple_password: 'synthetic-password',
    apple_id_ref: null,
    account_candidates: [],
    row_hash: 'test-row-hash',
    ...overrides,
  };
}

function candidate(overrides = {}) {
  return {
    id: 100,
    apple_id: 'order@example.test',
    password: 'synthetic-password',
    status: '使用中',
    ...overrides,
  };
}

describe('官网输入读取：订单快照、账号关联及隐私边界', () => {
  test('未录入账号主表时使用订单的加密密码快照', () => {
    expect(
      input.buildOfficialOrderInput(row({ apple_password: encrypt('snapshot-secret') }))
    ).toMatchObject({
      id: 249,
      password: 'snapshot-secret',
      credentialSource: 'orderSnapshot',
      beforeRowHash: 'test-row-hash',
    });
  });
  test('已关联账号保留主表来源及快照一致性校验', () => {
    expect(
      input.buildOfficialOrderInput(row({ apple_id_ref: 100, account_candidates: [candidate()] }))
    ).toMatchObject({ credentialSource: 'accountRegistry', snapshotPasswordMatches: true });
  });
  test('未设置引用但唯一账号匹配时仍校验主表，不能绕过异常标记', () => {
    expect(() =>
      input.buildOfficialOrderInput(row({ account_candidates: [candidate({ status: '异常' })] }))
    ).toThrow('ACCOUNT_MARKED_INVALID');
  });
  test('账号大小写及首尾空格规范化，不改变密码内容', () => {
    const result = input.buildOfficialOrderInput(
      row({
        apple_id: ' Order@Example.Test ',
        apple_password: ' pwd ',
        account_candidates: [candidate({ apple_id: 'order@example.test ', password: ' pwd ' })],
      })
    );
    expect(result.email).toBe('Order@Example.Test');
    expect(result.password).toBe(' pwd ');
  });
  test('订单无密码快照时仍允许唯一主表密码', () => {
    expect(
      input.buildOfficialOrderInput(
        row({ apple_password: null, account_candidates: [candidate()] })
      )
    ).toMatchObject({ credentialSource: 'accountRegistry', snapshotPasswordMatches: null });
  });
  test.each([
    [null, 'ORDER_NOT_FOUND'],
    [row({ apple_id: null }), 'ACCOUNT_ID_MISSING'],
    [row({ apple_id: 'invalid' }), 'INPUT_INVALID'],
    [row({ apple_password: null }), 'ORDER_CREDENTIALS_MISSING'],
    [row({ apple_password: '' }), 'ORDER_CREDENTIALS_MISSING'],
    [row({ apple_id_ref: 100 }), 'ACCOUNT_REFERENCE_CONFLICT'],
    [
      row({
        apple_id_ref: 100,
        account_candidates: [candidate({ apple_id: 'different@example.test' })],
      }),
      'ACCOUNT_REFERENCE_CONFLICT',
    ],
    [row({ account_candidates: [candidate(), candidate({ id: 101 })] }), 'ORDER_ACCOUNT_AMBIGUOUS'],
    [
      row({ account_candidates: [candidate({ password: 'changed-password' })] }),
      'CREDENTIAL_SNAPSHOT_MISMATCH',
    ],
    [row({ account_candidates: [candidate({ password: null })] }), 'ORDER_CREDENTIALS_MISSING'],
    [row({ order_url: 'https://example.test/' }), 'DESTINATION_DENIED'],
    [row({ order_number: 'W9999999999' }), 'LINK_IDENTITY_MISMATCH'],
  ])('拒绝无证据或冲突输入 %#', (value, code) => {
    expect(() => input.buildOfficialOrderInput(value)).toThrow(code);
  });
  test('解密异常只保留固定错误码，不带原异常内容', () => {
    const decryptValue = () => {
      throw new Error('sensitive-database-detail');
    };
    expect(() => input.buildOfficialOrderInput(row(), decryptValue)).toThrow(
      'CREDENTIAL_DECRYPT_FAILED'
    );
    expect(() => input.buildOfficialOrderInput(row(), () => null)).toThrow(
      'ORDER_CREDENTIALS_MISSING'
    );
    expect(input.officialInputErrorCode(new Error('sensitive-database-detail'))).toBe(
      'ORDER_INPUT_READ_FAILED'
    );
    expect(input.officialInputErrorCode({ code: 'CREDENTIAL_DECRYPT_FAILED' })).toBe(
      'CREDENTIAL_DECRYPT_FAILED'
    );
  });
  test('参数化只读查询保留无账号订单，完成后回滚只读事务', async () => {
    const client = {
      query: jest.fn(sql => Promise.resolve({ rows: sql.startsWith('SELECT') ? [row()] : [] })),
    };
    await expect(input.readOfficialOrderInput(client, '249')).resolves.toMatchObject({
      credentialSource: 'orderSnapshot',
    });
    expect(client.query.mock.calls[0]).toEqual(['BEGIN READ ONLY']);
    expect(client.query.mock.calls[2][1]).toEqual([249]);
    expect(client.query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
  });
  test.each(['0', '-1', '1 OR true', '2147483648', undefined])(
    '非法标识不访问数据库 %s',
    async value => {
      const client = { query: jest.fn() };
      await expect(input.readOfficialOrderInput(client, value)).rejects.toThrow('ORDER_ID_INVALID');
      expect(client.query).not.toHaveBeenCalled();
    }
  );
  test('数据或凭据失败仍结束只读事务', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await expect(input.readOfficialOrderInput(client, '249')).rejects.toThrow('ORDER_NOT_FOUND');
    expect(client.query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
  });
  test('真实入口只在 stderr 传递脱敏结构化错误，并关闭连接', async () => {
    const client = {
      connect: jest.fn().mockResolvedValue(undefined),
      end: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue({ rows: [] }),
    };
    const fakeProcess = {
      env: { OFFICIAL_ORDER_ID: '249' },
      stdout: { write: jest.fn() },
      stderr: { write: jest.fn() },
    };
    await vm.runInNewContext(fs.readFileSync('scripts/readOfficialOrderInput.js', 'utf8'), {
      require: name => (name === 'pg' ? { Client: jest.fn(() => client) } : input),
      process: fakeProcess,
    });
    expect(fakeProcess.stdout.write).not.toHaveBeenCalled();
    expect(JSON.parse(fakeProcess.stderr.write.mock.calls[0][0])).toEqual({
      outcome: 'ORDER_NOT_FOUND',
      stage: 'input',
    });
    expect(fakeProcess.exitCode).toBe(1);
    expect(client.end).toHaveBeenCalledTimes(1);
  });
});
