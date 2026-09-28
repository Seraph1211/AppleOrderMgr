const { randomUUID } = require('crypto');
const p = require('../src/services/monitorLogPolicy');
const now = new Date('2026-09-29T02:00:00.000Z');
const sample = () => ({
  id: randomUUID(),
  localId: randomUUID(),
  fileId: randomUUID(),
  fileName: 'Log20260929_123.txt',
  businessDate: '2026-09-29',
  loggedAt: '2026-09-28T17:40:10.229Z',
  accountNumber: '128',
  lineNumber: 1,
  partIndex: 0,
  byteOffset: 0,
  message: '2026-09-29 01:40:10.229 [2][128]A47-继续监控中..\n',
  rawBase64: null,
  parseState: 'parsed',
  contextAt: null,
});
describe('完整日志协议边界', () => {
  test('30个北京时间自然日及午夜切换', () => {
    expect(p.retention(now)).toEqual({ today: '2026-09-29', first: '2026-08-31' });
    expect(p.retention(new Date('2026-09-28T15:59:59Z')).today).toBe('2026-09-28');
    expect(p.retention(new Date('2026-09-28T16:00:00Z')).today).toBe('2026-09-29');
  });
  test('严格日期、时间、账号和完整原文', () => {
    const item = sample();
    expect(p.entry(item)).toEqual(item);
    for (const change of [
      { businessDate: '2026-02-30' },
      { loggedAt: '2026-09-28T24:00:00.000Z' },
      { contextAt: '2026-09-29T17:40:10.229Z' },
      { contextAt: '2026-09-28T17:40:11.229Z' },
      { loggedAt: '2026-09-29T17:40:10.229Z' },
      { accountNumber: 'x128' },
      { lineNumber: 0 },
      { byteOffset: -1 },
      { partIndex: 0.5 },
      { fileName: '../secret' },
      { message: 'a\0b' },
      { message: 'x'.repeat(16001) },
      { deviceId: randomUUID() },
      { parseState: 'unparsed' },
      { rawBase64: 'bad' },
    ])
      expect(() => p.entry({ ...item, ...change })).toThrow();
    expect(p.entry({ ...item, message: 'x'.repeat(16000) }).message).toHaveLength(16000);
    expect(
      p.entry({
        ...item,
        loggedAt: null,
        accountNumber: null,
        parseState: 'encoding_error',
        rawBase64: '/w==',
      }).rawBase64
    ).toBe('/w==');
  });
  test('查询限制和字面通配符', () => {
    const query = { deviceId: randomUUID(), localId: randomUUID(), date: '2026-09-29' };
    expect(p.query(query, now).limit).toBe(50);
    expect(p.query({ ...query, account: '__unassigned__' }, now).account).toBe('__unassigned__');
    for (const change of [
      { date: '2026-08-30' },
      { date: '2026-09-30' },
      { date: '2026-02-30' },
      { fromTime: '24:00:00' },
      { fromTime: '10:00:00', toTime: '09:00:00' },
      { account: '1 OR 1=1' },
      { account: ['128'] },
      { limit: [] },
      { limit: '101' },
      { limit: '-1' },
      { keyword: ['x'] },
      { cursor: {} },
    ])
      expect(() => p.query({ ...query, ...change }, now)).toThrow();
    expect(p.literalSearch('a%_\\')).toBe('%a\\%\\_\\\\%');
  });
});
