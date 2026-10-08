/* eslint-disable no-magic-numbers -- 明确样本数量和边界。 */
jest.mock('pg', () => ({ Client: jest.fn() }));
const { readLinkInputs } = require('../scripts/readOfficialOrderLinkInput');
const { hash } = require('../src/services/officialOrderSupport');
const fs = require('fs');
const { spawnSync } = require('child_process');

test('node 标准输入入口执行参数校验，不因 require.main 缺失而静默成功', () => {
  const run = spawnSync(process.execPath, ['-'], {
    input: fs.readFileSync(require.resolve('../scripts/readOfficialOrderLinkInput'), 'utf8'),
    encoding: 'utf8',
    env: { ...process.env, OFFICIAL_ORDER_IDS: '' },
  });
  expect(run.status).toBe(1);
  expect(run.stdout).toBe('');
  expect(JSON.parse(run.stderr)).toMatchObject({ outcome: 'ORDER_IDS_INVALID', stage: 'input' });
});

test('只读输入不提取密码或返回账号明文，保持账号保护键', async () => {
  const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  client.query
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({
      rows: [
        {
          id: 10,
          orderNumber: 'W1234567890',
          url: 'https://www.apple.com.cn/example',
          account: 'account@example.test',
          rowHash: 'snapshot',
        },
      ],
    });
  const result = await readLinkInputs(client, [10]);
  expect(result.samples[0]).toMatchObject({ id: 10, accountHash: hash('account@example.test') });
  expect(JSON.stringify(result)).not.toContain('account@example.test');
  const calls = client.query.mock.calls;
  expect(calls[0][0]).toBe('BEGIN READ ONLY');
  expect(calls.at(-1)[0]).toBe('ROLLBACK');
  expect(calls[2][0]).not.toMatch(/password|UPDATE|INSERT|DELETE/);
  expect(calls[2][1]).toEqual([[10]]);
});

test.each(
  [[], [1, 1], [0], ['1'], Array.from({ length: 21 }, (_, index) => index + 1)].map(ids => [ids])
)('非法或超量样本在 SQL 前拒绝：%j', async ids => {
  const client = { query: jest.fn() };
  await expect(readLinkInputs(client, ids)).rejects.toThrow('ORDER_IDS_INVALID');
  expect(client.query).not.toHaveBeenCalled();
});

test('缺失样本保留失败并退出只读事务', async () => {
  const client = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  await expect(readLinkInputs(client, [10])).rejects.toThrow('ORDER_NOT_FOUND');
  expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
});
