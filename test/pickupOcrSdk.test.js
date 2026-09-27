const http = require('http');
const { Readable } = require('stream');
const Ocr = require('@alicloud/ocr-api20210707');
const { Config } = require('@alicloud/openapi-client');
const { RuntimeOptions } = require('@alicloud/tea-util');

test('真实阿里云 SDK 使用二进制流、RPC 动作与响应契约（本地 HTTP，不耗云额度）', async () => {
  let server;
  let observed;
  try {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        observed = {
          method: req.method,
          action: req.headers['x-acs-action'],
          buffer: Buffer.concat(chunks),
        };
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            RequestId: 'sdk-synthetic',
            Data: '{"content":"Serial No. TEST000001"}',
          })
        );
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = new Ocr.default(
      new Config({
        accessKeyId: 'synthetic',
        accessKeySecret: 'synthetic',
        endpoint: `127.0.0.1:${server.address().port}`,
        protocol: 'HTTP',
      })
    );
    const input = Buffer.from([255, 216, 255, 0]);
    const response = await client.recognizeAdvancedWithOptions(
      new Ocr.RecognizeAdvancedRequest({ body: Readable.from(input), needRotate: true, row: true }),
      new RuntimeOptions({
        autoretry: false,
        maxAttempts: 1,
        connectTimeout: 1000,
        readTimeout: 2000,
      })
    );
    expect(observed).toMatchObject({ method: 'POST', action: 'RecognizeAdvanced', buffer: input });
    expect(response.body).toMatchObject({
      requestId: 'sdk-synthetic',
      data: '{"content":"Serial No. TEST000001"}',
    });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
  }
});
