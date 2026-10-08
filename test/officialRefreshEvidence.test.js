/* eslint-disable no-magic-numbers -- 合成证据与篡改边界。 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { buildLifecycleJson } = require('./fixtures/officialOrderLifecycle');
const { OfficialOrderHttpCollector } = require('../src/services/officialOrderHttpCollector');
const { writePrivate, readPrivate } = require('../src/services/officialOrderSupport');
const { verifyRefreshEvidence } = require('../src/services/officialRefreshEvidence');
let root;
let result;
beforeEach(async () => {
  try {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'http-refresh-evidence-'));
    const key = crypto.randomBytes(32);
    writePrivate(`${root}/private/evidence.key`, key);
    const sample = {
      id: 1,
      orderNumber: 'W1234567890',
      url: 'https://www.apple.com.cn/xc/cn/vieworder/W1234567890/test',
    };
    const body = Buffer.from(JSON.stringify(buildLifecycleJson('PICKED_UP')));
    const transport = {
      request: jest.fn(input => Promise.resolve({
        url: input.url,
        status: 200,
        headers: { 'content-type': 'application/json' },
        rawHeaders: [['content-type', 'application/json']],
        bodyBase64: body.toString('base64'),
        cookies: [],
      })),
    };
    const summary = await new OfficialOrderHttpCollector({
      transport,
      sample,
      root,
      key,
      runId: 1,
      collectReceipt: false,
    }).collect();
    result = readPrivate(summary.resultFile);
  } catch (error) {
    throw new Error(`synthetic evidence failed: ${error.code || error.name}`);
  }
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
test('重新解析封存正文，不接受结果文件伪造商品日期', () => {
  const original = verifyRefreshEvidence(root, result);
  result.products[0].rawStatus = 'CANCELLED';
  result.products[0].pickupDateText = '已取货 1月1日';
  expect(verifyRefreshEvidence(root, result).products).toEqual(original.products);
});
test.each(['sha256', 'urlHash', 'observedAt', 'file'])('证据 %s 不匹配则拒绝', field => {
  result.source[field] = field === 'file' ? '../outside.enc' : 'tampered';
  expect(() => verifyRefreshEvidence(root, result)).toThrow();
});
test('密文被修改拒绝，不把失败当空结果', () => {
  const file = `${root}/evidence/run-1/${result.source.file}`;
  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 1] ^= 1;
  fs.writeFileSync(file, bytes);
  expect(() => verifyRefreshEvidence(root, result)).toThrow('ENCRYPTED_STATE_INVALID');
});
